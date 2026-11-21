import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The monitoring overview reads its window in (settled_at, thread_id) order and seeks past each
  // batch; with settled_at alone every batch rescans the window and sorts its ties.
  yield* sql`DROP INDEX monitoring_thread_analyses_settled_at`;
  yield* sql`
    CREATE INDEX monitoring_thread_analyses_settled_thread
    ON monitoring_thread_analyses (settled_at, thread_id)
  `;
});
