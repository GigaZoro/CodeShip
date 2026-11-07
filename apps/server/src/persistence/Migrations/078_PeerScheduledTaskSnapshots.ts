import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The last task list each linked machine reported, so its tasks still show while it is offline.
  // A row outlives its link only until the next refresh removes it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_scheduled_task_snapshots (
      environment_id TEXT PRIMARY KEY,
      tasks_json TEXT NOT NULL,
      seen_at TEXT,
      checked_at TEXT NOT NULL,
      error TEXT
    )
  `;
});
