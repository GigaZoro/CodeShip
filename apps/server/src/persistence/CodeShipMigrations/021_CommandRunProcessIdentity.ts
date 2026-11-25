import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A wrapper's identity is no longer a wall-clock start: on Linux it is its start in ticks since
  // boot, which a step of the clock cannot move (see commandRunner/processIdentity.ts).
  yield* sql`ALTER TABLE command_runs ADD COLUMN process_identity TEXT`;
  yield* sql`
    UPDATE command_runs SET process_identity = 'time:' || process_started_at
    WHERE process_started_at IS NOT NULL
  `;
  yield* sql`ALTER TABLE command_runs DROP COLUMN process_started_at`;
});
