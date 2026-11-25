import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A command waiting for memory may start in the next server, so its row keeps the shell it
  // asked for. SQL NULL is the platform's default shell.
  yield* sql`ALTER TABLE command_runs ADD COLUMN shell TEXT`;
});
