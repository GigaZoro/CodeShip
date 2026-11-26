import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_task_runs)`;
  // Runs recorded before these columns never had an agent report: null means unreported.
  if (!columns.some((column) => column.name === "reported_outcome")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN reported_outcome TEXT`;
  }
  if (!columns.some((column) => column.name === "reported_summary")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN reported_summary TEXT`;
  }
});
