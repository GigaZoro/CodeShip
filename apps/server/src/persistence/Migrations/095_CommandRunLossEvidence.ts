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
  // Commands lost together form a wave, which lasts as long as a record it holds; the losses log
  // is written from these.
  yield* sql`ALTER TABLE command_runs ADD COLUMN loss_wave_id TEXT`;
  yield* sql`
    CREATE INDEX command_runs_loss_wave ON command_runs (loss_wave_id)
    WHERE loss_wave_id IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE command_loss_waves (
      wave_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      running INTEGER NOT NULL
    )
  `;
});
