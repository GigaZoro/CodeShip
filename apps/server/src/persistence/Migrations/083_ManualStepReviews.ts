import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS manual_step_reviews (
      thread_id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      review_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
