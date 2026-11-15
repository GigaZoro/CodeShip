import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A lost command keeps what shows how it ended for as long as its record: when the runner last
  // saw it alive, what its last failed probe said, why it counted as lost, and its output then.
  yield* sql`ALTER TABLE command_runs ADD COLUMN last_alive_at TEXT`;
  yield* sql`ALTER TABLE command_runs ADD COLUMN probe_error TEXT`;
  yield* sql`ALTER TABLE command_runs ADD COLUMN lost_reason TEXT`;
  yield* sql`ALTER TABLE command_runs ADD COLUMN lost_output TEXT`;
});
