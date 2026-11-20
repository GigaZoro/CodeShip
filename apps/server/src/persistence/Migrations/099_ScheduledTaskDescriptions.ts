import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQL NULL omits the field from shared copies. JSON null conveys an explicit clear.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN description_json TEXT`;
});
