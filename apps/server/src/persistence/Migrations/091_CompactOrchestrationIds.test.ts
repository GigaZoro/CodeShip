import { assert, it } from "@effect/vitest";
import type { EnvironmentStartup } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { MigrationProgress } from "../MigrationProgress.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const freshDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

const THREAD = "mcp:launch:abc";
const RUN = "run:thread:mcp:launch:abc:ordinal:1";
const LEGACY_RUN = "run:thread:mcp%3Alaunch%3Aabc:ordinal:1";
const LEGACY_ROOT = `node:run:${encodeURIComponent(LEGACY_RUN)}:root`;
const ROOT = `node:run:${RUN}:root`;
const UUID = "5eabac03-7aa3-4146-b99d-1188b277e339";

const insertEvent = (eventId: string, streamVersion: number, payload: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        ${eventId}, 'thread', ${THREAD}, ${streamVersion}, 'node.updated',
        '2026-11-14T00:00:00.000Z', 'system', ${JSON.stringify(payload)}, '{}'
      )
    `;
  });

const eventPayloadIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly event_id: string; readonly payload_json: string }>`
    SELECT event_id, payload_json FROM orchestration_events ORDER BY sequence
  `;
  return Object.fromEntries(
    rows.map((row) => [row.event_id, (JSON.parse(row.payload_json) as { id: string }).id]),
  );
});

const recorded91 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql`SELECT 1 FROM effect_sql_migrations WHERE migration_id = 91`).length > 0;
});

const storedCursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_progress'
  `;
  if (tables.length === 0) return undefined;
  const rows = yield* sql<{ readonly cursor_json: string }>`
    SELECT cursor_json FROM migration_progress WHERE migration_id = 91
  `;
  return rows[0] === undefined
    ? undefined
    : (JSON.parse(rows[0].cursor_json) as { readonly table: string; readonly rowid: number });
});

it.effect("a restart resumes 091 after its last committed step instead of starting over", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 90 });
    yield* insertEvent("event:first", 1, { id: LEGACY_ROOT });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_nodes (
        node_id, thread_id, run_id, root_node_id, kind, status, payload_json
      ) VALUES (${LEGACY_ROOT}, ${THREAD}, ${LEGACY_RUN}, ${LEGACY_ROOT}, 'root', 'running', '{}')
    `;
    // The process dies right after the step that finished orchestration_events commits.
    const killedAfterEvents = MigrationProgress.of({
      current: () => undefined,
      report: (status) =>
        Effect.gen(function* () {
          if (status?.progress === undefined) return;
          const cursor = yield* storedCursor;
          if (cursor !== undefined && cursor.table > "orchestration_events") {
            return yield* Effect.die("killed");
          }
        }).pipe(Effect.orDie, Effect.provideService(SqlClient.SqlClient, sql)),
    });

    const killed = yield* Effect.exit(
      runMigrations({ toMigrationInclusive: 91 }).pipe(
        Effect.provideService(MigrationProgress, killedAfterEvents),
      ),
    );
    const afterKill = {
      events: yield* eventPayloadIds,
      node: (yield* sql<{ readonly node_id: string }>`
        SELECT node_id FROM orchestration_v2_projection_nodes
      `)[0]?.node_id,
      recorded: yield* recorded91,
    };
    // Written after the kill: a rerun that started over would compact it too.
    yield* insertEvent("event:after-kill", 2, { id: LEGACY_ROOT });
    const resumed = yield* runMigrations({ toMigrationInclusive: 91 });

    assert.isTrue(Exit.isFailure(killed));
    assert.deepStrictEqual(afterKill, {
      events: { "event:first": ROOT },
      node: LEGACY_ROOT,
      recorded: false,
    });
    assert.deepStrictEqual(resumed, [[91, "CompactOrchestrationIds"]]);
    assert.deepStrictEqual(yield* eventPayloadIds, {
      "event:first": ROOT,
      "event:after-kill": LEGACY_ROOT,
    });
    const [node] = yield* sql<{ readonly node_id: string; readonly run_id: string }>`
      SELECT node_id, run_id FROM orchestration_v2_projection_nodes
    `;
    assert.deepStrictEqual(node, { node_id: ROOT, run_id: RUN });
    assert.isTrue(yield* recorded91);
    assert.isUndefined(yield* storedCursor);
  }).pipe(Effect.provide(freshDatabase)),
);

it.effect("091 splits a large table into bounded steps and reports growing progress", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 90 });
    // Small rows span more than one query; each pair of large rows fills a step's text budget.
    for (let index = 1; index <= 160; index++) {
      const filler = "x".repeat(index <= 150 ? 1_000 : 600_000);
      yield* insertEvent(`event:${index}`, index, { id: LEGACY_ROOT, filler });
    }
    const reports: Array<{ readonly progress: number; readonly cursor: unknown }> = [];
    const recording = MigrationProgress.of({
      current: () => undefined,
      report: (status: EnvironmentStartup | undefined) =>
        Effect.gen(function* () {
          if (status?.progress === undefined) return;
          reports.push({ progress: status.progress, cursor: yield* storedCursor });
        }).pipe(Effect.orDie, Effect.provideService(SqlClient.SqlClient, sql)),
    });

    yield* runMigrations({ toMigrationInclusive: 91 }).pipe(
      Effect.provideService(MigrationProgress, recording),
    );

    const eventCursors = reports.flatMap(({ cursor }) =>
      cursor !== undefined && (cursor as { table: string }).table === "orchestration_events"
        ? [cursor]
        : [],
    );
    assert.deepStrictEqual(
      eventCursors,
      [0, 152, 154, 156, 158, 160].map((rowid) => ({ table: "orchestration_events", rowid })),
    );
    const progress = reports.map((report) => report.progress);
    assert.deepStrictEqual(
      progress,
      progress.toSorted((left, right) => left - right),
    );
    assert.isTrue(progress.every((value) => value >= 0 && value <= 1));
    assert.isTrue(Object.values(yield* eventPayloadIds).every((id) => id === ROOT));
  }).pipe(Effect.provide(freshDatabase)),
);

layer("091_CompactOrchestrationIds", (it) => {
  it.effect("rewrites legacy ids in columns and JSON payloads and keeps everything else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      const legacyEvent = `event:thread:${THREAD}:provider-session:ps%3A${THREAD}:${UUID}`;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (${legacyEvent}, 'thread', ${THREAD}, 1, 'node.updated', '2026-11-14T00:00:00.000Z',
           'system', ${JSON.stringify({ id: LEGACY_ROOT, threadId: THREAD, text: LEGACY_ROOT })},
           '{}'),
          ('event:session-stopped', 'thread', ${THREAD}, 2, 'x', '2026-11-14T00:00:00.000Z',
           'system', ${`{"note":"say \\"${LEGACY_ROOT}\\" now"}`}, '{}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_nodes (
          node_id, thread_id, run_id, root_node_id, kind, status, payload_json
        ) VALUES (
          ${LEGACY_ROOT}, ${THREAD}, ${LEGACY_RUN}, ${LEGACY_ROOT}, 'root', 'running',
          ${JSON.stringify({ id: LEGACY_ROOT, runId: LEGACY_RUN, providerThreadId: "provider-thread:a%3Ab" })}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 91 });

      const events = yield* sql<{ readonly event_id: string; readonly payload_json: string }>`
        SELECT event_id, payload_json FROM orchestration_events ORDER BY sequence
      `;
      assert.strictEqual(events[0]?.event_id, `event:${UUID}`);
      assert.deepStrictEqual(JSON.parse(events[0]!.payload_json), {
        id: ROOT,
        threadId: THREAD,
        text: ROOT,
      });
      assert.strictEqual(events[1]?.event_id, "event:session-stopped");
      assert.include(events[1]!.payload_json, LEGACY_ROOT);

      const nodes = yield* sql<{
        readonly node_id: string;
        readonly run_id: string;
        readonly root_node_id: string;
        readonly payload_json: string;
      }>`SELECT node_id, run_id, root_node_id, payload_json FROM orchestration_v2_projection_nodes`;
      assert.strictEqual(nodes[0]?.node_id, ROOT);
      assert.strictEqual(nodes[0]?.run_id, RUN);
      assert.strictEqual(nodes[0]?.root_node_id, ROOT);
      assert.deepStrictEqual(JSON.parse(nodes[0]!.payload_json), {
        id: ROOT,
        runId: RUN,
        providerThreadId: "provider-thread:a%3Ab",
      });
    }),
  );
});
