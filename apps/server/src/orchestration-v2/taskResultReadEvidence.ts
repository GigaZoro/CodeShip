// @effect-diagnostics nodeBuiltinImport:off -- the synchronous fingerprint is also used by the standalone wake report.
import * as NodeCrypto from "node:crypto";

export function resultFingerprint(result: string): string {
  return NodeCrypto.createHash("sha256").update(result, "utf16le").digest("hex");
}

// t is the projected task. Older public acknowledgements recorded only a run ID. Their
// event payload describes the server's task, not the bytes that its caller received.
export const provenTaskResultReadsSql = `
  SELECT observer.run_id AS reader, evidence.at AS at, observer.status AS reader_status, evidence.read_sequence
  FROM (
    SELECT json_extract(e.payload_json,'$.completionDelivery.observedByRunId') AS reader, e.occurred_at AS at, e.sequence AS read_sequence
    FROM orchestration_command_receipts receipt
    CROSS JOIN orchestration_events e ON e.command_id = receipt.command_id
    WHERE receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = t.thread_id AND receipt.status = 'accepted'
      AND receipt.command_type IN ('delegated_task.completion-delivery.observe-disposed',
        'delegated_task.completion-delivery.observe','delegated_task.completion-delivery.acknowledge')
      AND e.application_event_version = 2 AND e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
      AND e.event_type = 'subagent.updated' AND json_extract(e.payload_json,'$.id') = t.subagent_id
      AND json_extract(e.payload_json,'$.status') IN ('completed','failed','cancelled','interrupted')
      AND json_extract(e.payload_json,'$.result') = json_extract(t.payload_json,'$.result')
      AND json_extract(e.payload_json,'$.updatedAt') = e.occurred_at
      AND ((receipt.command_type = 'delegated_task.completion-delivery.observe-disposed'
          AND json_extract(e.payload_json,'$.completionDelivery.state') = 'disposed')
        OR (json_extract(e.payload_json,'$.completionDelivery.observedAt') = e.occurred_at AND
          ((receipt.command_type = 'delegated_task.completion-delivery.acknowledge'
              AND json_extract(e.payload_json,'$.completionDelivery.state') = 'acknowledged')
            OR (receipt.command_type = 'delegated_task.completion-delivery.observe'
              AND json_extract(e.payload_json,'$.completionDelivery.state') IN ('acknowledged','disposed')))))
  ) evidence
  JOIN orchestration_v2_projection_runs observer ON observer.run_id = evidence.reader AND observer.thread_id = t.thread_id
  WHERE t.status IN ('completed','failed','cancelled','interrupted') AND json_type(t.payload_json,'$.result') = 'text'
    AND t.completed_at <= evidence.at
    AND coalesce(json_extract(observer.payload_json,'$.startedAt'), observer.requested_at) <= evidence.at
    AND (observer.completed_at >= evidence.at OR observer.status IN ('preparing','starting','running','waiting'))
`;

// Both projected reads carry a digest. The caller compares it to the current result before
// using the row. An older projection's verified flag did not bind the observation to bytes.
export const recordedTaskReadsSql = `
  SELECT observer.run_id AS reader, observer.status AS reader_status, evidence.key AS priority,
    coalesce(json_extract(evidence.value,'$.at'),json_extract(evidence.value,'$.observedAt')) AS at,
    json_extract(evidence.value,'$.resultFingerprint') AS fingerprint,
    t.payload_json -> '$.result' AS result_json
  FROM orchestration_v2_projection_subagents t
  CROSS JOIN json_each(json_array(json_extract(t.payload_json,'$.terminalResultObservation'),
    json_extract(t.payload_json,'$.completionDelivery'))) evidence
  JOIN orchestration_v2_projection_runs observer ON observer.thread_id=t.thread_id
    AND observer.run_id=coalesce(json_extract(evidence.value,'$.runId'),json_extract(evidence.value,'$.observedByRunId'))
  WHERE json_type(evidence.value,'$.resultFingerprint')='text'
    AND (evidence.key=0 OR (t.completion_delivery_state IN ('acknowledged','disposed')
      AND json_extract(evidence.value,'$.state') = t.completion_delivery_state))
    AND t.status IN ('completed','failed','cancelled','interrupted') AND json_type(t.payload_json,'$.result')='text'
    AND t.completed_at <= at AND coalesce(json_extract(observer.payload_json,'$.startedAt'),observer.requested_at) <= at
    AND (observer.completed_at >= at OR observer.status IN ('preparing','starting','running','waiting'))
`;
