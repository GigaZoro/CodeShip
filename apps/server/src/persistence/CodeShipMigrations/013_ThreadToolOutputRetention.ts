import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Retention skips a chat it already pruned until the chat's updated_at moves past this mark,
// and judges a chat by its whole family, which it finds by root.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_thread_output_retention (
      thread_id TEXT PRIMARY KEY,
      pruned_through_updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_root_idx
    ON orchestration_v2_projection_threads (json_extract(payload_json, '$.lineage.rootThreadId'))
  `;
});
