import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_task_runs)`;
  // Runs recorded before these columns keep null: nothing says why they moved.
  if (!columns.some((column) => column.name === "failover_reason")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN failover_reason TEXT`;
  }
  if (!columns.some((column) => column.name === "failover_mcp_servers_json")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN failover_mcp_servers_json TEXT`;
  }
});
