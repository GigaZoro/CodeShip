import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE command_runs ADD COLUMN reported_at TEXT`;
  yield* sql`UPDATE command_runs SET reported_at = delivered_at WHERE delivered_at IS NOT NULL`;
});
