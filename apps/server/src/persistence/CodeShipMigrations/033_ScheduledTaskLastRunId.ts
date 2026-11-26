import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "last_run_id")) return;
  // A task names the run it is on. Its start time cannot: a replayed occurrence starts again under
  // the run it delivered, which keeps the first start.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_id TEXT`;
  // Until now each attempt opened or reopened its run at the task's start time, so the run that
  // started then is the task's, the one an update restart may have cut included.
  yield* sql`
    UPDATE scheduled_tasks
    SET last_run_id = (
      SELECT run.run_id FROM scheduled_task_runs run
      WHERE run.task_id = scheduled_tasks.task_id AND run.started_at = scheduled_tasks.last_run_at
      ORDER BY run.run_id
      LIMIT 1
    )
    WHERE last_run_at IS NOT NULL
  `;
});
