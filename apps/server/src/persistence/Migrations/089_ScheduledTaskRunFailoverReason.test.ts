import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("089_ScheduledTaskRunFailoverReason", (it) => {
  it.effect("adds the failover columns and keeps the runs recorded before them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 88 });
      yield* sql`
        INSERT INTO scheduled_task_runs (
          run_id, task_id, trigger, started_at, outcome, failover_from, failover_to
        )
        VALUES ('run-1', 'task-1', 'schedule', '2026-11-12T10:00:00.000Z', 'succeeded', 'a', 'b')
      `;
      yield* runMigrations();
      const rows = yield* sql<{
        readonly failover_from: string;
        readonly failover_to: string;
        readonly failover_reason: string | null;
        readonly failover_mcp_servers_json: string | null;
      }>`
        SELECT failover_from, failover_to, failover_reason, failover_mcp_servers_json
        FROM scheduled_task_runs WHERE run_id = 'run-1'
      `;
      assert.deepStrictEqual(rows, [
        {
          failover_from: "a",
          failover_to: "b",
          failover_reason: null,
          failover_mcp_servers_json: null,
        },
      ]);
    }),
  );
});
