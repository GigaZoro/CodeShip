import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Ref from "effect/Ref";
import * as Logger from "effect/Logger";
import * as Console from "effect/Console";
import * as NodeUtil from "node:util";
import type { DatabaseMigrationProgress as Progress } from "@t3tools/contracts";
import {
  databaseMigrationProgress,
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import * as DatabaseMigrationProgress from "./DatabaseMigrationProgress.ts";

import {
  codeShipMigrationManifest,
  hasPendingMigrations,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";
import { seedLegacyCodeShipDatabase } from "./codeShipMigration.testkit.ts";
import CompactOrchestrationIds from "./CodeShipMigrations/014_CompactOrchestrationIds.ts";
import { reconcileCodeShipMigrationLedger } from "./reconcileCodeShipMigrationLedger.ts";
import ScheduledTaskRunHistory from "./CodeShipMigrations/004_ScheduledTaskRunHistory.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("keeps scheduler-owned occurrence history when migrating it into startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count
        ) VALUES (
          'inbox', 'Inbox', 'Process inbox', 1, '{"type":"interval","everyMs":60000}',
          'project', '{"type":"root"}', '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access', 'default', 'user', 'web', '2026-11-08T00:00:00.000Z',
          '2026-11-08T00:00:00.000Z', 'succeeded', 1
        )
      `;
      yield* ScheduledTaskRunHistory;
      yield* sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at, outcome)
        VALUES ('old-run', 'inbox', 'scheduled', '2026-11-08T01:00:00.000Z', '2026-11-08T01:05:00.000Z', 'succeeded')`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT run_id, scheduled_for, check_json FROM scheduled_task_runs`,
        [{ run_id: "old-run", scheduled_for: "2026-11-08T01:00:00.000Z", check_json: null }],
      );
      assert.deepEqual(yield* sql`SELECT title, prompt, description_json FROM scheduled_tasks`, [
        { title: "Inbox", prompt: "Process inbox", description_json: null },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM scheduled_task_run_conditions`, []);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54, then rechecks it without a write lock", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      const expectedMigrations = [...v2Migrations, ...codeShipMigrationManifest];
      const current = yield* Ref.make<Progress | null>(null);
      const steps: Array<Progress | null> = [];
      const loggedSteps: Array<Progress | null> = [];
      let output = "";
      const pretty = Logger.consolePretty({ mode: "tty", colors: false });
      const logger = Logger.make((options) => {
        pretty.log(options);
        if (String(options.message).startsWith(DATABASE_MIGRATION_PROGRESS_MESSAGE)) {
          steps.push(Ref.getUnsafe(current));
          loggedSteps.push(databaseMigrationProgress(output.slice(-4_000)));
        }
      });
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              output += `${NodeUtil.format(...args)}\n`;
            },
          }),
        ),
        expectedMigrations,
      );
      assert.deepStrictEqual(
        steps,
        expectedMigrations.map((_, index) => ({
          current: index + 1,
          total: expectedMigrations.length,
        })),
      );
      assert.deepStrictEqual(loggedSteps, steps);
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
        [],
      );
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);

      // query_only rejects BEGIN IMMEDIATE, which CLI startup would otherwise take on the live database.
      yield* sql`PRAGMA query_only = ON`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), [
        ...v2Migrations,
        ...codeShipMigrationManifest,
      ]);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps the migrations that finished before a later one failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 81 });
      yield* sql`CREATE TABLE orchestration_v2_projection_turn_item_counts (thread_id TEXT)`;

      const current = yield* Ref.make<Progress | null>(null);
      const exit = yield* Effect.exit(
        runMigrations().pipe(
          Effect.provideService(DatabaseMigrationProgress.DatabaseMigrationProgress, { current }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.isNull(yield* Ref.get(current));
      assert.deepStrictEqual(
        yield* history,
        migrationManifest.filter(([id]) => id <= 84),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 70 AND 72`;

      assert.deepStrictEqual(yield* runMigrations(), [
        ...migrationManifest.filter(([id]) => id >= 70),
        ...codeShipMigrationManifest,
      ]);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [directory, manifest] of [
      ["Migrations", migrationManifest],
      ["CodeShipMigrations", codeShipMigrationManifest],
    ] as const) {
      const dir = path.join(import.meta.dirname, directory);
      const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
        const match = /^(\d+)_(\w+)\.ts$/.exec(name);
        return match ? [[Number(match[1]), match[2]] as const] : [];
      });
      assert.deepStrictEqual(
        files.toSorted(([a], [b]) => a - b),
        manifest,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([85, 92, 94, 95, 96, 97, 99, 101, 103, 105, 112, 113])(
  "upgrades released fork history through %s without replaying fork migrations",
  (throughId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(throughId);
      yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-11-10 01:02:03' WHERE migration_id >= 78`;
      yield* sql`INSERT INTO peer_scheduled_task_snapshots (environment_id, tasks_json, checked_at)
      VALUES ('peer', '[{"title":"keep"}]', '2026-11-10')`;
      yield* sql`INSERT INTO shared_setting_versions (setting_key, kind, value_json, updated_at, origin)
      VALUES ('chatWidth', 'shared', '"wide"', '2026-11-10', 'mac')`;
      const snapshots = yield* sql`SELECT * FROM peer_scheduled_task_snapshots`;
      const settings = yield* sql`SELECT * FROM shared_setting_versions`;
      assert.isTrue(yield* hasPendingMigrations());
      assert.deepEqual(yield* runMigrations(), [
        ...migrationManifest.filter(([id]) => id >= 78),
        ...codeShipMigrationManifest.filter(([id]) => id > throughId - 77),
      ]);
      assert.deepEqual(yield* history, migrationManifest);
      assert.deepEqual(
        yield* sql`SELECT migration_id, name, created_at FROM codeship_migrations WHERE migration_id <= ${throughId - 77} ORDER BY migration_id`,
        codeShipMigrationManifest
          .filter(([id]) => id <= throughId - 77)
          .map(([migration_id, name]) => ({
            migration_id,
            name,
            created_at: "2026-11-10 01:02:03",
          })),
      );
      assert.deepEqual(yield* sql`SELECT * FROM peer_scheduled_task_snapshots`, snapshots);
      assert.deepEqual(yield* sql`SELECT * FROM shared_setting_versions`, settings);
      assert.include(
        (yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`).map(
          ({ name }) => name,
        ),
        "thread_mode",
      );
      assert.include(
        (yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(orchestration_v2_projection_messages)`).map(({ name }) => name),
        "search_text",
      );
      assert.deepEqual(yield* sql`SELECT * FROM auth_connect_devices`, []);
      assert.isFalse(yield* hasPendingMigrations());
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "runs upstream then fork migrations on a new database, with no fork work in a limited run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* runMigrations({ toMigrationInclusive: 1 }),
        migrationManifest.slice(0, 1),
      );
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'codeship_migrations'`,
        [],
      );
      assert.deepEqual(yield* runMigrations(), [
        ...migrationManifest.slice(1),
        ...codeShipMigrationManifest,
      ]);
      assert.deepEqual(yield* history, migrationManifest);
      assert.deepEqual(
        yield* sql`SELECT migration_id AS id, name FROM codeship_migrations ORDER BY migration_id`,
        codeShipMigrationManifest.map(([id, name]) => ({ id, name })),
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "moves an interrupted legacy compaction cursor and resumes after its committed rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(90);
      const insert = (eventId: string, version: number) => sql`INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${eventId}, 'thread', 'thread', ${version}, 'node.updated', '2026-11-14', 'system',
        '{"id":"run:thread:mcp%3Alaunch%3Aabc:ordinal:1"}', '{}')`;
      yield* insert("first", 1);
      const step = yield* sql.withTransaction(
        CompactOrchestrationIds.step(JSON.stringify({ table: "orchestration_events", rowid: 0 })),
      );
      assert.isDefined(step.next);
      yield* sql`CREATE TABLE migration_progress (migration_id INTEGER PRIMARY KEY NOT NULL, cursor_json TEXT NOT NULL)`;
      yield* sql`INSERT INTO migration_progress VALUES (91, ${step.next!})`;
      yield* insert("after-kill", 2);
      yield* reconcileCodeShipMigrationLedger();
      assert.deepEqual(yield* sql`SELECT * FROM codeship_migration_progress`, [
        { migration_id: 14, cursor_json: step.next },
      ]);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'migration_progress'`,
        [],
      );
      assert.deepEqual(yield* reconcileCodeShipMigrationLedger(), []);
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT event_id, json_extract(payload_json, '$.id') AS id FROM orchestration_events ORDER BY sequence`,
        [
          { event_id: "first", id: "run:thread:mcp:launch:abc:ordinal:1" },
          { event_id: "after-kill", id: "run:thread:mcp%3Alaunch%3Aabc:ordinal:1" },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'codeship_migration_progress'`,
        [],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  [97, 20],
  [100, 23],
] as const)(
  "moves an interrupted cursor of legacy fork migration %s to fork migration %s",
  ([legacyId, forkId]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(legacyId - 1);
      const cursor = JSON.stringify({ last: 7 });
      yield* sql`CREATE TABLE migration_progress (migration_id INTEGER PRIMARY KEY NOT NULL, cursor_json TEXT NOT NULL)`;
      yield* sql`INSERT INTO migration_progress VALUES (${legacyId}, ${cursor})`;
      yield* reconcileCodeShipMigrationLedger();
      assert.deepEqual(yield* sql`SELECT * FROM codeship_migration_progress`, [
        { migration_id: forkId, cursor_json: cursor },
      ]);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'migration_progress'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rolls back ledger reconciliation if a destination row conflicts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyCodeShipDatabase(85);
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* sql`CREATE TABLE codeship_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT current_timestamp)`;
    yield* sql`INSERT INTO codeship_migrations (migration_id, name) VALUES (8, 'UnknownFork')`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileCodeShipMigrationLedger())));
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
    assert.deepEqual(yield* sql`SELECT migration_id, name FROM codeship_migrations`, [
      { migration_id: 8, name: "UnknownFork" },
    ]);
    yield* sql`DROP TABLE codeship_migrations`;
    yield* sql`CREATE TRIGGER fail_ledger_move BEFORE DELETE ON effect_sql_migrations
      WHEN old.migration_id = 80 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileCodeShipMigrationLedger())));
    assert.deepEqual(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before);
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'codeship_migrations'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
