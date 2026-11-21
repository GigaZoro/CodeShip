import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What a command resolved under its lock, as JSON, so a replay reports it unchanged.
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN result_json TEXT`;
});
