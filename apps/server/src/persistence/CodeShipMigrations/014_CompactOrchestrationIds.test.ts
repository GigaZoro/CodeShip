import { assert, it } from "@effect/vitest";
import type { EnvironmentStartup } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { nodePayloadSql } from "../../orchestration-v2/NodePayloadColumns.ts";
import { MigrationProgress } from "../MigrationProgress.ts";
import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
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

const recorded14 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql`SELECT 1 FROM codeship_migrations WHERE migration_id = 14`).length > 0;
});

const storedCursor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codeship_migration_progress'
  `;
  if (tables.length === 0) return undefined;
  const rows = yield* sql<{ readonly cursor_json: string }>`
    SELECT cursor_json FROM codeship_migration_progress WHERE migration_id = 14
  `;
  return rows[0] === undefined
    ? undefined
    : (JSON.parse(rows[0].cursor_json) as { readonly table: string; readonly rowid: number });
});

it.effect("a restart resumes 091 after its last committed step instead of starting over", () =>
  Effect.gen(function* () {
    yield* seedLegacyCodeShipDatabase(90);
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
      runMigrations().pipe(Effect.provideService(MigrationProgress, killedAfterEvents)),
    );
    const afterKill = {
      events: yield* eventPayloadIds,
      node: (yield* sql<{ readonly node_id: string }>`
        SELECT node_id FROM orchestration_v2_projection_nodes
      `)[0]?.node_id,
      recorded: yield* recorded14,
    };
    // Written after the kill: a rerun that started over would compact it too.
    yield* insertEvent("event:after-kill", 2, { id: LEGACY_ROOT });
    const resumed = yield* runMigrations();

    assert.isTrue(Exit.isFailure(killed));
    assert.deepStrictEqual(afterKill, {
      events: { "event:first": ROOT },
      node: LEGACY_ROOT,
      recorded: false,
    });
    assert.deepStrictEqual(resumed, [
      [14, "CompactOrchestrationIds"],
      [15, "CommandRuns"],
      [16, "ManualStepReviewLanguages"],
      [17, "PullRequestReviewGuideLanguages"],
      [18, "CommandRunLossEvidence"],
      [19, "MonitoringThreadAnalyses"],
      [20, "NodePayloadWithoutColumnKeys"],
      [21, "CommandRunProcessIdentity"],
      [22, "ScheduledTaskDescriptions"],
      [23, "TurnItemPayloadWithoutColumnKeys"],
      [24, "CommandRunShell"],
      [25, "MonitoringSettledThreadIndex"],
      [26, "MonitoringAnalysesWithoutProject"],
      [27, "MonitoringAnalysesSettleStamp"],
      [28, "MonitoringStoredDetailsAndRetries"],
      [29, "ColdThreadHistoryCompaction"],
      [30, "DatabaseSizeSamples"],
      [31, "ScheduledTaskRunReportedResult"],
      [32, "ThreadPreferences"],
      [33, "ScheduledTaskLastRunId"],
      [34, "UsageStopDecisions"],
      [35, "TurnItemMessageIndex"],
      [36, "IncrementalEventStoreCompaction"],
      [37, "PayloadIndexesJsonValid"],
    ]);
    assert.deepStrictEqual(yield* eventPayloadIds, {
      "event:first": ROOT,
      "event:after-kill": LEGACY_ROOT,
    });
    const [node] = yield* sql<{ readonly node_id: string; readonly run_id: string }>`
      SELECT node_id, run_id FROM orchestration_v2_projection_nodes
    `;
    assert.deepStrictEqual(node, { node_id: ROOT, run_id: RUN });
    assert.isTrue(yield* recorded14);
    assert.isUndefined(yield* storedCursor);
  }).pipe(Effect.provide(freshDatabase)),
);

it.effect(
  "091 splits a large table into bounded steps, traces each step once and reports growing progress",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(90);
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

      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      yield* runMigrations().pipe(
        Effect.provideService(MigrationProgress, recording),
        Effect.withTracer(tracer),
      );

      // One span per row filled the trace files while a large database migrated.
      const rowSpans = spans.filter((span) =>
        String(span.attributes.get("db.query.text") ?? "").startsWith(
          'UPDATE "orchestration_events"',
        ),
      );
      assert.strictEqual(rowSpans.length, 0);
      assert.isAbove(spans.filter((span) => span.name === "ResumableMigration.step").length, 5);

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

layer("014_CompactOrchestrationIds", (it) => {
  it.effect("rewrites legacy ids in columns and JSON payloads and keeps everything else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyCodeShipDatabase(90);
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
          node_id, thread_id, run_id, root_node_id, kind, status, provider_thread_id, payload_json
        ) VALUES (
          ${LEGACY_ROOT}, ${THREAD}, ${LEGACY_RUN}, ${LEGACY_ROOT}, 'root', 'running',
          'provider-thread:a%3Ab',
          ${JSON.stringify({ id: LEGACY_ROOT, runId: LEGACY_RUN, providerThreadId: "provider-thread:a%3Ab" })}
        )
      `;

      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
        ) VALUES ('item', ${THREAD}, ${LEGACY_RUN}, 1, 'assistant_message', 'completed',
          '2026-11-14', '{}')
      `;
      yield* runMigrations();

      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, run_key, item_count FROM orchestration_v2_projection_turn_item_counts`,
        [{ thread_id: THREAD, run_key: RUN, item_count: 1 }],
      );

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
      }>`
        SELECT node_id, run_id, root_node_id, ${sql.literal(nodePayloadSql())} AS payload_json
        FROM orchestration_v2_projection_nodes
      `;
      assert.strictEqual(nodes[0]?.node_id, ROOT);
      assert.strictEqual(nodes[0]?.run_id, RUN);
      assert.strictEqual(nodes[0]?.root_node_id, ROOT);
      const { id, runId, providerThreadId } = JSON.parse(nodes[0]!.payload_json);
      assert.deepStrictEqual(
        { id, runId, providerThreadId },
        {
          id: ROOT,
          runId: RUN,
          providerThreadId: "provider-thread:a%3Ab",
        },
      );
    }),
  );
});
