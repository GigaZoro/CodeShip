import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Upstream migration 94 covers the fork message index and includes the ordinal.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_message_idx`;

  // Migrations 3, 10 and 13 indexed json_extract without json_valid, so writing a malformed
  // payload failed. ProjectionStore and ProjectionMaintenance repeat each guarded expression.
  // Upstream's threads_root_thread_idx (migration 89) is the guarded copy of the root index.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_root_idx`;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_usage_limit_hold_end_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_hold_end_idx
    ON orchestration_v2_projection_turn_items(
      COALESCE(
        julianday(json_extract(payload_json, '$.failure.resetAt')),
        julianday(updated_at, '+5 hours')
      )
    )
    WHERE type = 'error' AND status = 'failed'
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
  `;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_run_attempts_account_started_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_run_attempts_account_started_idx
    ON orchestration_v2_projection_run_attempts(
      provider_instance_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.startedAt') END
    )
  `;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_provider_turns_answered_attempt_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_answered_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id)
    WHERE json_valid(payload_json) AND json_extract(payload_json, '$.tokenUsage') IS NOT NULL
  `;
});
