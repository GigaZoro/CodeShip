import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One file size a day for the last week, so Settings can show how fast the database grows.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS database_size_samples (
      sampled_at INTEGER PRIMARY KEY,
      database_bytes INTEGER NOT NULL
    )
  `;
});
