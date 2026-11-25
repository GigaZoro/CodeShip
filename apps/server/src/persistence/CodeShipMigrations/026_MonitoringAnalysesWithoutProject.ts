import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Monitoring reads a chat's project from the chat itself, so a move shows at once; a copy kept
  // with the analysis would go stale.
  yield* sql`ALTER TABLE monitoring_thread_analyses DROP COLUMN project_id`;
});
