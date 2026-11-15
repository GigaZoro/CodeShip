import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Recovery reads occurrence history before the scheduler starts. Preserve existing rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    scheduled_for TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    outcome TEXT NOT NULL,
    thread_id TEXT,
    error TEXT,
    skip_reason TEXT,
    ran_on TEXT,
    failover_from TEXT,
    failover_to TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
    ON scheduled_task_runs(task_id, started_at)
  `;
});
