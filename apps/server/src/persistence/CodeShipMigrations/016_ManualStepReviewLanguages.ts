import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A review is written in its reader's language, so each language keeps its own. The stored
  // reviews were written in their step's language, which is no reader's for certain, and carry
  // no translation; they are dropped and written again when a client next shows the step.
  yield* sql`DROP TABLE IF EXISTS manual_step_reviews`;
  yield* sql`
    CREATE TABLE manual_step_reviews (
      thread_id TEXT NOT NULL,
      language TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      review_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, language)
    ) WITHOUT ROWID
  `;
});
