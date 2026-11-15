import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit reads ask which refusals can still hold an account: a reset still ahead, or an
  // unknown reset within the longest hold (usageHoldMs, five hours). Keyed by that latest end, a
  // read is one range over live refusals instead of a walk over every failed item.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_usage_limit_hold_end_idx
    ON orchestration_v2_projection_turn_items(
      COALESCE(
        julianday(json_extract(payload_json, '$.failure.resetAt')),
        julianday(updated_at, '+5 hours')
      )
    )
    WHERE type = 'error' AND status = 'failed'
      AND json_extract(payload_json, '$.failure.class') = 'usage_limit'
  `;
});
