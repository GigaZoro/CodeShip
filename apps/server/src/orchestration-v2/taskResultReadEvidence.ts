// @effect-diagnostics nodeBuiltinImport:off -- the synchronous fingerprint is also used by the standalone wake report.
import * as NodeCrypto from "node:crypto";

export function resultFingerprint(result: string): string {
  return NodeCrypto.createHash("sha256").update(result, "utf16le").digest("hex");
}

// Migration 091 compacts node and run IDs in the structured response. Its duplicate is
// JSON encoded within a string and retains the old spelling. Only these identity fields
// can differ by compactLegacyId's nested percent/colon escapes. Result text stays exact.
export const nativeResultCopiesAgreeSql = `
  NOT call.has_copy OR (call.content_copy IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT field.value AS name, json_extract(call.content_copy,'$.' || field.value) AS echoed,
        json_extract(call.response,'$.' || field.value) AS actual
      FROM json_each('["taskId","childNodeId","childThreadId","childRunId","status","workState","resultContextTransferId","summary",
        "latestTerminalRunId","latestTerminalStatus","latestTerminalResultContextTransferId","latestTerminalSummary"]') field
    ) pair
    WHERE echoed IS NOT actual AND CASE
      WHEN ((name IN ('taskId','childNodeId') AND echoed GLOB 'node:*')
          OR (name IN ('childRunId','latestTerminalRunId') AND echoed GLOB 'run:*'))
        AND instr(echoed,char(0)) = 0
        AND echoed NOT GLOB '*[^a-zA-Z0-9:._~%!''()*-]*' THEN (
          WITH RECURSIVE spellings(id) AS (
            SELECT echoed UNION ALL
            SELECT replace(replace(replace(id,'%3A',':'),'%3a',':'),'%25','%')
            FROM spellings WHERE id GLOB '*%3[aA]*' OR id GLOB '*%25*'
          )
          SELECT id FROM spellings WHERE id NOT GLOB '*%3[aA]*' AND id NOT GLOB '*%25*'
        )
      ELSE echoed END IS NOT actual
  ))
`;

// Finalization publishes the task and creates its already-consumed transfer with one clock
// reading. A continuation can publish identical bytes while delegate_task still returns its
// original childRunId. Ambiguous transfer timestamps cannot identify that publication.
export const publicationTransferIdSql = `
  SELECT min(transfer.context_transfer_id) FROM orchestration_v2_projection_context_transfers transfer
  WHERE transfer.target_run_id = t.run_id AND transfer.source_thread_id = t.child_thread_id
    AND transfer.target_thread_id = t.thread_id AND transfer.type = 'subagent_result'
    AND json_extract(transfer.payload_json,'$.createdAt') = t.completed_at
  HAVING count(*) = 1 AND transfer.status = 'consumed'
    AND json_extract(transfer.payload_json,'$.consumedAt') = t.completed_at
    AND json_extract(transfer.payload_json,'$.sourcePoint.threadId') = t.child_thread_id
`;

// Use delegatedTaskRun's original-run precedence. Ambiguous spawn records fail closed.
const originalDelegateRunIdSql = `
  SELECT coalesce(
    (SELECT run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.child_thread_id
      AND json_extract(r.payload_json,'$.delegatedTaskId')=t.subagent_id ORDER BY r.ordinal LIMIT 1),
    (SELECT CASE WHEN count(*)=0 THEN (SELECT r.run_id FROM orchestration_v2_projection_runs r
        WHERE r.thread_id=t.child_thread_id ORDER BY r.ordinal LIMIT 1)
      WHEN count(*)=1 THEN spawn.target_run_id END
      FROM orchestration_v2_projection_context_transfers spawn WHERE spawn.target_thread_id=t.child_thread_id
        AND spawn.source_thread_id=t.thread_id AND spawn.type='subagent_spawn'))
`;

const possiblePublishingRunsSql = `
  SELECT child.run_id FROM orchestration_v2_projection_runs child
  WHERE child.thread_id=t.child_thread_id AND child.status=t.status AND child.completed_at <= t.completed_at
    AND coalesce(json_extract(child.payload_json,'$.delegatedTaskId'), (
      SELECT json_extract(shell.payload_json,'$.forkedFrom.nodeId') FROM orchestration_v2_projection_threads shell
      WHERE shell.thread_id=t.child_thread_id AND json_extract(shell.payload_json,'$.forkedFrom.type')='node'
    ))=t.subagent_id
`;

const publicationSourceSql = `
  SELECT publisher.run_id FROM orchestration_v2_projection_context_transfers publication
  JOIN (${possiblePublishingRunsSql}) publisher ON publisher.run_id=json_extract(publication.payload_json,'$.sourcePoint.runId')
  WHERE publication.context_transfer_id=(${publicationTransferIdSql})
`;

// t is the projected task. Older public acknowledgements recorded only a run ID. Their
// event payload describes the server's task, not the bytes that its caller received.
// A provider restart overwrites startedAt for the same run. Use its original request time
// for historical reads whose content and active reader were checked when they were recorded.
export const provenTaskResultReadsSql = `
  WITH read_events AS MATERIALIZED (
    SELECT receipt.command_type, e.occurred_at AS at, e.sequence,
      json_extract(e.payload_json,'$.completionDelivery.observedByRunId') AS reader,
      json_extract(e.payload_json,'$.completionDelivery.observedAt') AS observed_at,
      json_extract(e.payload_json,'$.completionDelivery.state') AS state,
      (json_extract(e.payload_json,'$.origin') = 'app_owned' AND json_extract(e.payload_json,'$.runId') = t.run_id
        AND json_extract(e.payload_json,'$.childThreadId') = t.child_thread_id
        AND json_extract(e.payload_json,'$.status') = t.status
        AND json_extract(e.payload_json,'$.completedAt') = t.completed_at) AS same_delegate
    FROM orchestration_command_receipts receipt
    -- The stream index can rescan the whole thread for each receipt.
    CROSS JOIN orchestration_events e INDEXED BY idx_orch_events_command_id ON e.command_id = receipt.command_id
    WHERE receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = t.thread_id AND receipt.status = 'accepted'
      AND receipt.command_type IN ('delegated_task.completion-delivery.observe-disposed',
        'delegated_task.completion-delivery.observe','delegated_task.completion-delivery.acknowledge')
      AND e.application_event_version = 2 AND e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
      AND e.event_type = 'subagent.updated' AND json_extract(e.payload_json,'$.id') = t.subagent_id
      AND json_extract(e.payload_json,'$.status') IN ('completed','failed','cancelled','interrupted')
      AND json_extract(e.payload_json,'$.result') = json_extract(t.payload_json,'$.result')
      AND json_extract(e.payload_json,'$.updatedAt') = e.occurred_at
  ), native_calls AS MATERIALIZED (
    -- The legacy acknowledgement was emitted inside delegate_task. The completed native call
    -- independently records the response the original parent received, even if it began before publication.
    SELECT e.reader, e.sequence, json_extract(i.payload_json,'$.completedAt') AS at,
      i.payload_json -> '$.output.structuredContent' AS response,
      json_type(i.payload_json,'$.output.content') IS NOT NULL AS has_copy,
      CASE WHEN json_type(i.payload_json,'$.output.content') = 'text'
        AND json_valid(json_extract(i.payload_json,'$.output.content'))
        THEN json_extract(i.payload_json,'$.output.content') END AS content_copy
    FROM read_events e
    CROSS JOIN orchestration_v2_projection_turn_items i INDEXED BY orchestration_v2_projection_turn_items_run_ordinal_idx
      ON i.run_id = e.reader AND i.thread_id = t.thread_id
    CROSS JOIN orchestration_v2_projection_provider_turns p ON p.provider_turn_id = i.provider_turn_id
      AND p.thread_id = i.thread_id AND p.provider_thread_id = i.provider_thread_id
    CROSS JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = p.run_attempt_id
      AND a.thread_id = i.thread_id AND a.run_id = i.run_id AND a.provider_thread_id = i.provider_thread_id
    WHERE t.origin = 'app_owned' AND t.child_thread_id IS NOT NULL AND e.reader = t.run_id AND e.same_delegate
      AND e.command_type = 'delegated_task.completion-delivery.acknowledge' AND e.state = 'acknowledged'
      AND e.observed_at IS NULL AND e.at >= t.completed_at AND i.type = 'dynamic_tool' AND i.status = 'completed'
      AND json_extract(i.payload_json,'$.toolName') = 'mcp__t3-code__delegate_task'
      AND coalesce(json_extract(i.payload_json,'$.outputOmitted'),0) = 0
      AND json_extract(i.payload_json,'$.nativeItemRef.strength') = 'strong'
      AND json_type(i.payload_json,'$.nativeItemRef.nativeId') = 'text' AND json_extract(i.payload_json,'$.nativeItemRef.nativeId') != ''
      AND json_type(i.payload_json,'$.output.structuredContent') = 'object'
      AND json_extract(i.payload_json,'$.output.error') IS NULL AND coalesce(json_extract(i.payload_json,'$.output.isError'),0) = 0
      AND e.at BETWEEN json_extract(i.payload_json,'$.startedAt') AND json_extract(i.payload_json,'$.completedAt')
      AND json_extract(i.payload_json,'$.startedAt') >= p.started_at
      AND json_extract(i.payload_json,'$.startedAt') >= json_extract(a.payload_json,'$.startedAt')
      AND json_extract(i.payload_json,'$.completedAt') <= p.completed_at
      AND json_extract(i.payload_json,'$.completedAt') <= json_extract(a.payload_json,'$.completedAt')
  )
  SELECT observer.run_id AS reader, evidence.at, observer.status AS reader_status,
    evidence.read_sequence, evidence.source_child_run_id
  FROM (
    SELECT reader, at, sequence AS read_sequence, NULL AS source_child_run_id FROM read_events
    WHERE (command_type = 'delegated_task.completion-delivery.observe-disposed' AND state = 'disposed')
      OR (observed_at = at AND ((command_type = 'delegated_task.completion-delivery.acknowledge' AND state = 'acknowledged')
        OR (command_type = 'delegated_task.completion-delivery.observe' AND state IN ('acknowledged','disposed'))))
    UNION ALL
    SELECT call.reader, call.at, call.sequence, publisher.run_id FROM native_calls call
    CROSS JOIN orchestration_v2_projection_runs publisher ON publisher.run_id=(${publicationSourceSql})
    CROSS JOIN orchestration_v2_projection_runs original ON original.run_id=json_extract(call.response,'$.childRunId')
      AND original.thread_id=t.child_thread_id AND original.run_id=(${originalDelegateRunIdSql})
    WHERE json_type(call.response,'$.taskId') = 'text' AND json_extract(call.response,'$.taskId') = t.subagent_id
      AND json_type(call.response,'$.childNodeId') = 'text' AND json_extract(call.response,'$.childNodeId') = t.subagent_id
      AND json_type(call.response,'$.childThreadId') = 'text' AND json_extract(call.response,'$.childThreadId') = t.child_thread_id
      AND json_type(call.response,'$.childRunId') = 'text'
      AND json_extract(call.response,'$.status') = t.status AND json_extract(call.response,'$.workState') = 'result_available'
      AND json_type(call.response,'$.summary') = 'text'
      AND CAST(json_extract(call.response,'$.summary') AS BLOB) = CAST(json_extract(t.payload_json,'$.result') AS BLOB)
      AND (${nativeResultCopiesAgreeSql})
      AND (json_extract(call.response,'$.resultContextTransferId') = (${publicationTransferIdSql})
        OR (
          json_type(call.response,'$.latestTerminalRunId') = 'text'
          AND json_extract(call.response,'$.latestTerminalRunId') = publisher.run_id
          AND json_extract(call.response,'$.latestTerminalStatus') = t.status
          AND (json_type(call.response,'$.latestTerminalSummary') = 'null'
            OR (json_type(call.response,'$.latestTerminalSummary') = 'text'
              AND CAST(json_extract(call.response,'$.latestTerminalSummary') AS BLOB) = CAST(json_extract(call.response,'$.summary') AS BLOB)))
          AND (json_extract(call.response,'$.latestTerminalResultContextTransferId') = (${publicationTransferIdSql})
            OR (json_extract(call.response,'$.resultContextTransferId') IS NULL
              AND json_extract(call.response,'$.latestTerminalResultContextTransferId') IS NULL))
          AND (json_extract(call.response,'$.resultContextTransferId') IS NULL OR EXISTS (
            -- delegate_task's primary transfer can still refer to the original child.
            SELECT 1 FROM orchestration_v2_projection_context_transfers initial
            WHERE initial.context_transfer_id = json_extract(call.response,'$.resultContextTransferId')
              AND initial.target_run_id = t.run_id AND initial.source_thread_id = t.child_thread_id
              AND initial.target_thread_id = t.thread_id AND initial.type = 'subagent_result' AND initial.status = 'consumed'
              AND json_extract(initial.payload_json,'$.sourcePoint.threadId') = t.child_thread_id
              AND json_extract(initial.payload_json,'$.sourcePoint.runId') = original.run_id
              AND json_extract(initial.payload_json,'$.createdAt') < t.completed_at
              AND json_extract(initial.payload_json,'$.consumedAt') = json_extract(initial.payload_json,'$.createdAt')
          ))
        )
        OR (
          -- Equal summaries cannot identify a publisher when this response predates terminal run evidence.
          json_extract(call.response,'$.resultContextTransferId') IS NULL
          AND json_extract(call.response,'$.latestTerminalRunId') IS NULL
          AND json_extract(call.response,'$.latestTerminalStatus') IS NULL
          AND json_extract(call.response,'$.latestTerminalSummary') IS NULL
          AND json_extract(call.response,'$.latestTerminalResultContextTransferId') IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM (${possiblePublishingRunsSql}) sibling WHERE sibling.run_id != publisher.run_id
          )
        ))
  ) evidence
  JOIN orchestration_v2_projection_runs observer ON observer.run_id = evidence.reader AND observer.thread_id = t.thread_id
  WHERE t.status IN ('completed','failed','cancelled','interrupted') AND json_type(t.payload_json,'$.result') = 'text'
    AND t.completed_at <= evidence.at
    AND observer.requested_at <= evidence.at
    AND (observer.completed_at >= evidence.at OR observer.status IN ('preparing','starting','running','waiting'))
`;

// Both projected reads carry a digest. The caller compares it to the current result before
// using the row. An older projection's verified flag did not bind the observation to bytes.
export const recordedTaskReadsSql = `
  SELECT observer.run_id AS reader, observer.status AS reader_status, evidence.key AS priority,
    coalesce(json_extract(evidence.value,'$.at'),json_extract(evidence.value,'$.observedAt')) AS at,
    json_extract(evidence.value,'$.resultFingerprint') AS fingerprint,
    json_extract(evidence.value,'$.sourceChildRunId') AS source_child_run_id,
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
    AND (json_type(evidence.value,'$.sourceChildRunId') IS NULL OR (observer.run_id=t.run_id
      AND json_extract(evidence.value,'$.sourceChildRunId')=(${publicationSourceSql})))
    AND t.completed_at <= at AND observer.requested_at <= at
    AND (observer.completed_at >= at OR observer.status IN ('preparing','starting','running','waiting'))
`;
