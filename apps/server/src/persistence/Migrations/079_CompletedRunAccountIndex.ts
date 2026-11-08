import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit reads ask which runs on an account completed after a refusal; without this,
  // each read walked every run ever recorded.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_completed_account_idx
    ON orchestration_v2_projection_runs(provider_instance_id, completed_at)
    WHERE status = 'completed'
  `;
});
