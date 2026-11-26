import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Terminal stops use the source run's key. A provider hold belongs to its specific attempt.
// Older receipts did not preserve that distinction.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE usage_stop_decisions ADD COLUMN occurrence_key TEXT`;
  yield* sql`CREATE VIEW usage_stop_replay AS
    WITH decisions AS (
      SELECT d.source_key, d.occurrence_key, d.observed_ms,
        CASE
          WHEN d.occurrence_key IS NULL THEN 4
          WHEN attempt.attempt_id IS NOT NULL AND initiating.payload_json ->> 'userMessageId' IS NULL THEN 4
          WHEN EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items steer
            WHERE steer.node_id = attempt.root_node_id AND steer.run_id = attempt.run_id
              AND steer.type = 'user_message' AND steer.status = 'completed'
              AND steer.payload_json ->> 'messageId' IS NOT initiating.payload_json ->> 'userMessageId'
              AND steer.payload_json ->> 'inputIntent' IN ('steer', 'promoted_queued_to_steer')
          ) THEN 4
          WHEN attempt.status = 'completed' THEN 0
          -- Ended attempts, and dispatches that failed before any attempt ran, prove nothing.
          WHEN attempt.status = 'failed' THEN 1
          WHEN d.request_key IS NOT NULL THEN 4
          WHEN d.snapshot ->> 'reason' = 'switching_disabled' THEN 2
          WHEN d.snapshot ->> 'reason' IS NOT 'no_eligible_account' OR d.snapshot ->> 'omitted' IS NOT 0 THEN 4
          WHEN EXISTS (SELECT 1 FROM json_each(d.snapshot, '$.candidates') c
              WHERE c.value ->> 'reason' IN ('driver_pinned', 'unsupported_driver'))
            AND NOT EXISTS (SELECT 1 FROM json_each(d.snapshot, '$.candidates') c
              WHERE c.value ->> 'reason' NOT IN ('source_account', 'driver_pinned', 'unsupported_driver')) THEN 2
          WHEN NOT EXISTS (SELECT 1 FROM json_each(d.snapshot, '$.candidates') c
              WHERE c.value ->> 'reason' NOT IN ('source_account', 'usage_limited', 'driver_pinned')) THEN 3
          ELSE 4
        END AS rank
      FROM usage_stop_decisions d
      LEFT JOIN orchestration_events created
        ON created.sequence = d.attempt_sequence AND created.event_type = 'run-attempt.created'
      LEFT JOIN orchestration_v2_projection_run_attempts attempt
        ON attempt.attempt_id = created.payload_json ->> '$.id'
      LEFT JOIN orchestration_events initiating ON initiating.sequence = (
        SELECT r.sequence FROM orchestration_events r
        WHERE r.command_id = created.command_id AND r.stream_id = created.stream_id
          AND r.event_type IN ('run.created','run.updated')
          AND r.payload_json ->> 'id' = attempt.run_id
          AND r.payload_json ->> 'activeAttemptId' = attempt.attempt_id
        ORDER BY r.sequence LIMIT 1
      )
    )
    SELECT source_key, occurrence_key,
      CASE MIN(rank) WHEN 0 THEN 'recovered' WHEN 1 THEN 'failed_attempt' WHEN 2 THEN 'pinned'
        WHEN 3 THEN 'exhausted' ELSE 'unknown' END AS classification,
      COUNT(*) AS decisions, MIN(observed_ms) AS first_observed_ms,
      NULL AS attributable_lost_tokens
    FROM decisions GROUP BY source_key, occurrence_key`;
});
