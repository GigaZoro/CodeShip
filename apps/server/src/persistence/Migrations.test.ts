import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ScheduledTaskRunHistory from "./Migrations/081_ScheduledTaskRunHistory.ts";

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
  it.effect("keeps exact Windows identity separate from legacy millisecond evidence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* sql`INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status, started_at, deadline_at, process_started_at)
        VALUES ('legacy-ms', 'thread', 'run', 'true', '/tmp', '/tmp/old', 'running', '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z', 1795046400123)`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT process_identity, windows_created_at FROM command_runs WHERE task_id = 'legacy-ms'`,
        [{ process_identity: "time:1795046400123", windows_created_at: null }],
      );
      const exact = "134395200001234567";
      yield* sql`UPDATE command_runs SET windows_created_at = ${exact} WHERE task_id = 'legacy-ms'`;
      assert.deepEqual(
        yield* sql`SELECT windows_created_at, typeof(windows_created_at) AS storage FROM command_runs WHERE task_id = 'legacy-ms'`,
        [{ windows_created_at: exact, storage: "text" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([99, 117, 118])("adds launch evidence after migration %s already ran", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: id });
      assert.deepEqual(
        (yield* history).at(-1),
        migrationManifest.find(([migrationId]) => migrationId === id),
      );
      const before = yield* sql<{ name: string }>`PRAGMA table_info(command_runs)`;
      assert.equal(
        before.some((column) => column.name === "launch_error"),
        id === 118,
      );
      assert.isFalse(before.some((column) => column.name === "reported_at"));
      yield* sql`INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status, started_at, deadline_at, delivered_at)
          VALUES ('old-delivered', 'thread', 'run', 'true', '/tmp', '/tmp/old', 'exited', '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z', '2026-11-19T00:01:00Z')`;
      yield* runMigrations();
      const after = yield* sql<{
        name: string;
        notnull: number;
      }>`PRAGMA table_info(command_runs)`;
      assert.equal(after.find((column) => column.name === "launch_error")?.notnull, 0);
      assert.equal(after.find((column) => column.name === "reported_at")?.notnull, 0);
      assert.equal(after.find((column) => column.name === "exit_status_error")?.notnull, 0);
      assert.equal(after.find((column) => column.name === "stop_leftovers")?.notnull, 0);
      assert.deepEqual(
        yield* sql`SELECT reported_at, delivered_at FROM command_runs WHERE task_id = 'old-delivered'`,
        [{ reported_at: "2026-11-19T00:01:00Z", delivered_at: "2026-11-19T00:01:00Z" }],
      );
      assert.deepEqual(
        (yield* history).filter(([migrationId]) => migrationId >= 118 && migrationId <= 122),
        [
          [118, "CommandLaunchError"],
          [119, "CommandResultReported"],
          [120, "CommandWindowsIdentity"],
          [121, "CommandExitStatusError"],
          [122, "CommandStopLeftovers"],
        ],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

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

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
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

  it.effect("reapplies peer link migrations whose ledger rows are missing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A recorded later migration would make the migrator skip 70-72 instead of rerunning them.
      yield* runMigrations({ toMigrationInclusive: 72 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 70 AND 72`;

      assert.deepStrictEqual(
        yield* runMigrations({ toMigrationInclusive: 72 }),
        migrationManifest.filter(([id]) => id >= 70 && id <= 72),
      );
      yield* runMigrations();
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
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
