import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const THREAD = "mcp:launch:abc";
const RUN = "run:thread:mcp:launch:abc:ordinal:1";
const LEGACY_RUN = "run:thread:mcp%3Alaunch%3Aabc:ordinal:1";
const LEGACY_ROOT = `node:run:${encodeURIComponent(LEGACY_RUN)}:root`;
const ROOT = `node:run:${RUN}:root`;
const UUID = "5eabac03-7aa3-4146-b99d-1188b277e339";

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

      yield* runMigrations();

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
