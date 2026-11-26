import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { createUsageStopReplay } from "./114_UsageStopReplay.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A follow-up reuses the message's turn item. Both compaction paths keep its commanded events.
  const commandedSteer = sql.literal(`application_event_version = 2 AND command_id IS NOT NULL
    AND event_type = 'turn-item.updated' AND payload_json ->> 'type' = 'user_message'
    AND payload_json ->> 'status' = 'completed'
    AND payload_json ->> 'inputIntent' IN ('steer', 'promoted_queued_to_steer')`);
  yield* sql`CREATE INDEX usage_stop_commanded_steer_idx ON orchestration_events (
    (payload_json ->> 'runId'), (payload_json ->> 'nodeId')
  ) WHERE ${commandedSteer}`;
  yield* sql`DROP VIEW usage_stop_replay`;
  yield* createUsageStopReplay(
    sql,
    sql`EXISTS (
    SELECT 1 FROM orchestration_events steer
    WHERE ${commandedSteer}
      AND steer.payload_json ->> 'runId' = attempt.run_id
      AND steer.payload_json ->> 'nodeId' = attempt.root_node_id
      AND steer.payload_json ->> 'messageId' IS NOT initiating.payload_json ->> 'userMessageId'
      AND NOT EXISTS (SELECT 1 FROM usage_stop_missed_steers missed
        WHERE missed.provider_turn_id = steer.payload_json ->> 'providerTurnId'
          AND missed.message_id = steer.payload_json ->> 'messageId')
  )`,
  );
});
