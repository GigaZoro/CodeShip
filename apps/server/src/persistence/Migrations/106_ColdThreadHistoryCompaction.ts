import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The cold-history pass skips a chat until it has events past this mark, and a resume from a
// cursor below it gets a snapshot because replaced events below the mark are gone.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_thread_history_compaction (
      thread_id TEXT PRIMARY KEY,
      compacted_through_sequence INTEGER NOT NULL
    )
  `;
});
