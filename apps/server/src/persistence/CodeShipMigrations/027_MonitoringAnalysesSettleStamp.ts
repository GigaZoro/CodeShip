import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Analyses stored before a summary repeated its row's settle time do not read. Removing them
  // analyzes the chat again at once instead of counting it as failed until the next retry. CASE,
  // since SQLite may evaluate json_extract on a malformed summary before an AND guard.
  yield* sql`
    DELETE FROM monitoring_thread_analyses
    WHERE CASE
      WHEN json_valid(summary_json) THEN json_extract(summary_json, '$.settledAt') IS NOT settled_at
      ELSE 0
    END
  `;
});
