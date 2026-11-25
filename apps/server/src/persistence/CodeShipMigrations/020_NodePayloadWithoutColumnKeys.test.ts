import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { nodePayloadSql } from "../../orchestration-v2/NodePayloadColumns.ts";
import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
import { runMigrations } from "../Migrations.ts";

const freshDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

const node = (index: number) => ({
  id: `node:${index}`,
  threadId: "thread:1",
  runId: null,
  parentNodeId: null,
  rootNodeId: "node:1",
  kind: "tool_call",
  status: "running",
  countsForRun: true,
  providerThreadId: null,
  providerTurnId: "turn:1",
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: "2026-11-14T00:00:00.000Z",
  completedAt: null,
});

it.effect("020 removes the keys the node columns hold, in steps, and reads put them back", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A released build recorded fork migrations up to 96 in the upstream ledger.
    yield* seedLegacyCodeShipDatabase(96);
    // More rows than one step, so the cursor has to carry the migration across steps.
    for (let index = 1; index <= 1_200; index++) {
      const payload = node(index);
      yield* sql`
        INSERT INTO orchestration_v2_projection_nodes (
          node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
          provider_thread_id, provider_turn_id, started_at, completed_at, payload_json
        ) VALUES (
          ${payload.id}, ${payload.threadId}, ${payload.runId}, ${payload.parentNodeId},
          ${payload.rootNodeId}, ${payload.kind}, ${payload.status}, ${payload.providerThreadId},
          ${payload.providerTurnId}, ${payload.startedAt}, ${payload.completedAt},
          ${JSON.stringify(payload)}
        )
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_projection_nodes (
        node_id, thread_id, root_node_id, kind, status, payload_json
      ) VALUES ('node:malformed', 'thread:1', 'node:1', 'tool_call', 'running', '{not json')
    `;
    yield* runMigrations();
    const stored = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = 'node:777'
    `;
    const malformed = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = 'node:malformed'
    `;
    const rebuilt = yield* sql<{ readonly payload_json: string }>`
      SELECT ${sql.literal(nodePayloadSql())} AS payload_json
      FROM orchestration_v2_projection_nodes WHERE node_id = 'node:777'
    `;
    const left = yield* sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM orchestration_v2_projection_nodes
      WHERE json_valid(payload_json) AND json_type(payload_json, '$.threadId') IS NOT NULL
    `;

    assert.deepStrictEqual(JSON.parse(stored[0]!.payload_json), {
      countsForRun: true,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
    });
    assert.deepStrictEqual(JSON.parse(rebuilt[0]!.payload_json), node(777));
    assert.strictEqual(left[0]!.n, 0);
    assert.strictEqual(malformed[0]!.payload_json, "{not json");
  }).pipe(Effect.provide(freshDatabase)),
);
