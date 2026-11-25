import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN detail_json TEXT`;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN retry_at TEXT`;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN announced_title TEXT`;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN announced_project_id TEXT`;
  yield* sql`ALTER TABLE monitoring_thread_analyses ADD COLUMN announced_settled_at TEXT`;
});
