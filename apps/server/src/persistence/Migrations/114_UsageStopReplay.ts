import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Usage reports read this database read-only, so the replay lives here. A stop without evidence has
// no row and stays unknown. A decision names an attempt only when it ran the decision's own request
// for the stopped run, so lineage needs no check here. No record attributes lost tokens.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE VIEW usage_stop_replay AS
    WITH decisions AS (
      SELECT d.source_key, d.observed_ms,
        CASE
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
    )
    SELECT source_key,
      CASE MIN(rank) WHEN 0 THEN 'recovered' WHEN 1 THEN 'failed_attempt' WHEN 2 THEN 'pinned'
        WHEN 3 THEN 'exhausted' ELSE 'unknown' END AS classification,
      COUNT(*) AS decisions, MIN(observed_ms) AS first_observed_ms,
      NULL AS attributable_lost_tokens
    FROM decisions GROUP BY source_key`;
});
