import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { turnItemPayloadSql } from "../../orchestration-v2/TurnItemPayloadColumns.ts";
import { seedLegacyCodeShipDatabase } from "../codeShipMigration.testkit.ts";
import { runMigrations } from "../Migrations.ts";

const freshDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

const item = (index: number) => ({
  id: `item:${index}`,
  threadId: "thread:1",
  runId: "run:1",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: "turn:1",
  nativeItemRef: null,
  parentItemId: null,
  ordinal: index,
  type: "command_execution",
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-11-14T00:00:00.000Z",
  command: "ls",
});

it.effect(
  "023 removes the keys the turn item columns hold, in steps, and reads put them back",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A released build recorded fork migrations up to 99 in the upstream ledger.
      yield* seedLegacyCodeShipDatabase(99);
      // More rows than one step, so the cursor has to carry the migration across steps.
      for (let index = 1; index <= 1_200; index++) {
        const payload = item(index);
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${payload.id}, ${payload.threadId}, ${payload.runId}, ${payload.nodeId},
          ${payload.providerThreadId}, ${payload.providerTurnId}, ${payload.parentItemId},
          ${payload.ordinal}, ${payload.type}, ${payload.status}, ${payload.updatedAt},
          ${JSON.stringify(payload)}
        )
      `;
      }
      yield* runMigrations();
      const stored = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:777'
    `;
      const rebuilt = yield* sql<{ readonly payload_json: string }>`
      SELECT ${sql.literal(turnItemPayloadSql())} AS payload_json
      FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:777'
    `;
      const left = yield* sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM orchestration_v2_projection_turn_items
      WHERE json_type(payload_json, '$.threadId') IS NOT NULL
    `;

      assert.deepStrictEqual(JSON.parse(stored[0]!.payload_json), {
        nativeItemRef: null,
        title: null,
        startedAt: null,
        completedAt: null,
        command: "ls",
      });
      assert.deepStrictEqual(JSON.parse(rebuilt[0]!.payload_json), item(777));
      assert.strictEqual(left[0]!.n, 0);
    }).pipe(Effect.provide(freshDatabase)),
);
