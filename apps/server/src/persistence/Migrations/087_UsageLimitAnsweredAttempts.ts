import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // An attempt on a held account that started after its refusal and got an answer (a provider turn
  // reporting token usage) ends the hold. Reads walk that account's attempts since the refusal,
  // which are few while it is held, then probe each for an answered turn.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_run_attempts_account_started_idx
    ON orchestration_v2_projection_run_attempts(
      provider_instance_id,
      json_extract(payload_json, '$.startedAt')
    )
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_answered_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id)
    WHERE json_extract(payload_json, '$.tokenUsage') IS NOT NULL
  `;
});
