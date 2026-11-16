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
  // Set in the write that records a loss, until a wave takes it or it is too old to start one, so
  // a server that stops in between leaves it for the next one.
  yield* sql`ALTER TABLE command_runs ADD COLUMN loss_unplaced INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX command_runs_loss_unplaced ON command_runs (ended_at) WHERE loss_unplaced = 1
  `;
  yield* sql`
    CREATE TABLE command_loss_waves (
      wave_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      running INTEGER NOT NULL
    )
  `;
});
