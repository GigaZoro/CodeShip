import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Written with last_run_at, so a peer never sees a run start without the occurrence it served.
  // A null trigger means the run predates these columns and its occurrence is unknown.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_trigger TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_scheduled_for TEXT`;
  yield* sql`
    UPDATE scheduled_tasks
    SET (last_run_trigger, last_run_scheduled_for) = (
      SELECT r.trigger, r.scheduled_for
      FROM scheduled_task_runs r
      WHERE r.task_id = scheduled_tasks.task_id
        AND r.started_at = scheduled_tasks.last_run_at
        AND r.outcome <> 'skipped'
      ORDER BY r.run_id DESC LIMIT 1
    )
    WHERE last_run_at IS NOT NULL
  `;
});
