import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_run_conditions (
      task_id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL
    )
  `;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_task_runs)`;
  if (!columns.some((column) => column.name === "check_json")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN check_json TEXT`;
  }
});
