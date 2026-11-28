import {
  NonNegativeInt,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts/baseSchemas";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  AnalysisAttempt,
  AnalysisItem,
  AnalysisMessage,
  AnalysisRequest,
  AnalysisRun,
  AnalysisSubagent,
  AnalysisThread,
  AnalysisWorkflowAgent,
  ThreadAnalysisInput,
} from "./ThreadAnalyzer.ts";

const COMMAND_INPUT_LENGTH = 400;
const MESSAGE_TEXT_LENGTH = 400;
const SUBAGENT_PROMPT_LENGTH = 200;
const TURN_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_search",
  "web_search",
  "error",
  "run_interrupt_request",
  "compaction",
  "handoff",
  "file_change",
] as const;

/** A provider turn as stored; the service prices it before the analyzer sees it. */
export interface ThreadAnalysisTurnRow {
  readonly runId: string | null;
  readonly usageJson: string | null;
  readonly runModel: string | null;
  readonly contextUsedTokens: number | null;
  readonly contextMaxTokens: number | null;
}

export type ThreadAnalysisRead = Omit<ThreadAnalysisInput, "turns"> & {
  readonly turns: ReadonlyArray<ThreadAnalysisTurnRow>;
};

const WorkflowAgentsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      label: Schema.String,
      model: Schema.NullOr(Schema.String),
      state: Schema.String,
      startedAt: Schema.NullOr(Schema.Number),
      completedAt: Schema.NullOr(Schema.Number),
      totalTokens: Schema.NullOr(NonNegativeInt),
    }),
  ),
);
const decodeWorkflowAgents = Schema.decodeUnknownEffect(WorkflowAgentsJson);
const decodeWorkflowTokens = Schema.decodeUnknownEffect(Schema.NullOr(NonNegativeInt));
const decodeTaskIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/**
 * A chat the Chats list shows and that is settled: not deleted, not a subagent's or side chat's.
 * Archived chats count. The query names the threads table `t`.
 */
export const settledListedThread = (sql: SqlClient.SqlClient) => sql`
  t.deleted_at IS NULL
  AND json_extract(t.payload_json, '$.settledOverride') = 'settled'
  AND json_extract(t.payload_json, '$.settledAt') IS NOT NULL
  AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
  AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
`;

/** Loads one settled listed chat for analysis; null when it is not one. */
export const readThreadAnalysis = Effect.fn("ThreadAnalysisReader.readThreadAnalysis")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;

  const threadRows = yield* sql<{
    readonly thread_id: string;
    readonly project_id: string;
    readonly title: string;
    readonly created_at: string;
    readonly provider_instance_id: string;
    readonly model: string | null;
    readonly settled_at: string;
    readonly created_by: string | null;
    readonly delegated: number;
  }>`
    SELECT t.thread_id, t.project_id, t.title, t.created_at,
      COALESCE(json_extract(t.payload_json, '$.providerInstanceId'), t.default_provider)
        AS provider_instance_id,
      json_extract(t.payload_json, '$.modelSelection.model') AS model,
      json_extract(t.payload_json, '$.settledAt') AS settled_at,
      json_extract(t.payload_json, '$.createdBy') AS created_by,
      json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL AS delegated
    FROM orchestration_v2_projection_threads t
    WHERE t.thread_id = ${threadId} AND ${settledListedThread(sql)}
  `;
  const row = threadRows[0];
  if (row === undefined) return null;
  const thread: AnalysisThread = {
    threadId: row.thread_id as ThreadId,
    projectId: row.project_id as ProjectId,
    title: row.title,
    providerInstanceId: row.provider_instance_id as ProviderInstanceId,
    model: row.model,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    createdBy: row.created_by,
    delegated: row.delegated === 1,
  };

  // The settle command clears `unsettledAt`, so only the event history shows a reopening: every
  // thread event carries the whole thread, and a reopening is one that leaves the settled state.
  // Counting unsettle events instead counts a hand reopen twice (it and its first turn each emit
  // one) and misses a pin or a metadata update that reopens.
  const reopenRows = yield* sql<{ readonly reopens: number }>`
    SELECT COUNT(*) AS reopens
    FROM (
      SELECT settled, LAG(settled) OVER (ORDER BY sequence) AS was_settled
      FROM (
        SELECT sequence,
          COALESCE(
            json_extract(payload_json, '$.settledOverride') = 'settled'
              AND json_extract(payload_json, '$.settledAt') IS NOT NULL,
            0
          ) AS settled
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND application_event_version = 2 AND event_type LIKE 'thread.%'
          AND json_type(payload_json, '$.settledOverride') IS NOT NULL
      )
    )
    WHERE was_settled = 1 AND settled = 0
  `;

  const runRows = yield* sql<{
    readonly run_id: string;
    readonly ordinal: number;
    readonly status: string;
    readonly requested_at: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly user_message_id: string;
    readonly model: string | null;
    readonly automatic_of: string | null;
    readonly restart_of: string | null;
  }>`
    SELECT run_id, ordinal, status, requested_at,
      json_extract(payload_json, '$.startedAt') AS started_at,
      json_extract(payload_json, '$.completedAt') AS completed_at,
      json_extract(payload_json, '$.userMessageId') AS user_message_id,
      json_extract(payload_json, '$.modelSelection.model') AS model,
      json_extract(payload_json, '$.automaticContinuationOfRunId') AS automatic_of,
      json_extract(payload_json, '$.restartContinuationOfRunId') AS restart_of
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId}
    ORDER BY ordinal
  `;
  const runs: ReadonlyArray<AnalysisRun> = runRows.map((run) => ({
    runId: run.run_id as RunId,
    ordinal: run.ordinal,
    status: run.status,
    requestedAt: run.requested_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    userMessageId: run.user_message_id,
    model: run.model,
    automaticContinuation: run.automatic_of !== null,
    restartContinuation: run.restart_of !== null,
  }));
  const modelByRun = new Map(runRows.map((run) => [run.run_id, run.model]));

  const attemptRows = yield* sql<{
    readonly run_id: string;
    readonly reason: string | null;
    readonly started_at: string | null;
  }>`
    SELECT run_id, json_extract(payload_json, '$.reason') AS reason,
      json_extract(payload_json, '$.startedAt') AS started_at
    FROM orchestration_v2_projection_run_attempts
    WHERE thread_id = ${threadId}
    ORDER BY run_id, attempt_ordinal
  `;
  const attempts: ReadonlyArray<AnalysisAttempt> = attemptRows.map((attempt) => ({
    runId: attempt.run_id,
    reason: attempt.reason ?? "initial",
    startedAt: attempt.started_at,
  }));

  const messageRows = yield* sql<{
    readonly message_id: string;
    readonly created_by: string | null;
    readonly scheduled: number;
    readonly from_thread: number;
    readonly delegated_task_ids: string | null;
    readonly text: string | null;
  }>`
    SELECT message_id,
      json_extract(payload_json, '$.createdBy') AS created_by,
      json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL AS scheduled,
      json_extract(payload_json, '$.senderThreadId') IS NOT NULL AS from_thread,
      json_extract(payload_json, '$.delegatedCompletion.taskIds') AS delegated_task_ids,
      substr(json_extract(payload_json, '$.text'), 1, ${MESSAGE_TEXT_LENGTH}) AS text
    FROM orchestration_v2_projection_messages
    WHERE thread_id = ${threadId} AND role = 'user'
    ORDER BY created_at, message_id
  `;
  const messages = yield* Effect.forEach(
    messageRows,
    Effect.fnUntraced(function* (message): Effect.fn.Return<AnalysisMessage, Schema.SchemaError> {
      return {
        messageId: message.message_id,
        createdBy: message.created_by,
        scheduled: message.scheduled === 1,
        fromThread: message.from_thread === 1,
        delegatedTaskIds:
          message.delegated_task_ids === null
            ? null
            : yield* decodeTaskIds(message.delegated_task_ids),
        text: message.text ?? "",
      };
    }),
  );

  const turnRows = yield* sql<{
    readonly run_id: string | null;
    readonly usage_json: string | null;
    readonly used_tokens: number | null;
    readonly max_tokens: number | null;
  }>`
    SELECT a.run_id,
      json_extract(pt.payload_json, '$.turnTokenUsage') AS usage_json,
      json_extract(pt.payload_json, '$.tokenUsage.usedTokens') AS used_tokens,
      json_extract(pt.payload_json, '$.tokenUsage.maxTokens') AS max_tokens
    FROM orchestration_v2_projection_provider_turns pt
    LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
    WHERE pt.thread_id = ${threadId} AND pt.run_attempt_id IS NOT NULL
    ORDER BY pt.started_at, pt.provider_turn_id
  `;
  const turns: ReadonlyArray<ThreadAnalysisTurnRow> = turnRows.map((turn) => ({
    runId: turn.run_id,
    usageJson: turn.usage_json,
    runModel: turn.run_id === null ? null : (modelByRun.get(turn.run_id) ?? null),
    contextUsedTokens: turn.used_tokens,
    contextMaxTokens: turn.max_tokens,
  }));

  const itemRows = yield* sql<{
    readonly run_id: string | null;
    readonly type: string;
    readonly status: string;
    readonly updated_at: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly input: string | null;
    readonly exit_code: number | null;
    readonly output_indicates_failure: number | null;
    readonly monitor: number | null;
    readonly failure_class: string | null;
    readonly file_name: string | null;
    readonly to_model: string | null;
  }>`
    SELECT run_id, type, status, updated_at,
      json_extract(payload_json, '$.startedAt') AS started_at,
      json_extract(payload_json, '$.completedAt') AS completed_at,
      CASE WHEN type = 'command_execution'
        THEN substr(json_extract(payload_json, '$.input'), 1, ${COMMAND_INPUT_LENGTH}) END AS input,
      json_extract(payload_json, '$.exitCode') AS exit_code,
      json_extract(payload_json, '$.outputIndicatesFailure') AS output_indicates_failure,
      json_extract(payload_json, '$.monitor') AS monitor,
      json_extract(payload_json, '$.failure.class') AS failure_class,
      json_extract(payload_json, '$.fileName') AS file_name,
      json_extract(payload_json, '$.toModel') AS to_model
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId} AND type IN ${sql.in(TURN_ITEM_TYPES)}
    ORDER BY ordinal, turn_item_id
  `;
  const items: ReadonlyArray<AnalysisItem> = itemRows.map((item) => ({
    runId: item.run_id,
    type: item.type,
    status: item.status,
    startedAt: item.started_at,
    completedAt: item.completed_at,
    updatedAt: item.updated_at,
    command: item.input,
    exitCode: item.exit_code,
    outputIndicatesFailure: item.output_indicates_failure === 1,
    monitor: item.monitor === 1,
    failureClass: item.failure_class,
    fileName: item.file_name,
    toModel: item.to_model,
  }));

  const requestRows = yield* sql<{
    readonly kind: string;
    readonly created_at: string;
    readonly resolved_at: string | null;
  }>`
    SELECT kind, created_at, resolved_at
    FROM orchestration_v2_projection_runtime_requests
    WHERE thread_id = ${threadId}
    ORDER BY created_at
  `;
  const requests: ReadonlyArray<AnalysisRequest> = requestRows.map((request) => ({
    kind: request.kind,
    createdAt: request.created_at,
    resolvedAt: request.resolved_at,
  }));

  // The workflow's agents hold their own prompts and results, so only the timeline fields leave SQLite.
  const subagentRows = yield* sql<{
    readonly subagent_id: string;
    readonly origin: string;
    readonly child_thread_id: string | null;
    readonly status: string;
    readonly started_at: string | null;
    readonly completed_at: string | null;
    readonly updated_at: string;
    readonly remote: number;
    readonly command: string | null;
    readonly title: string | null;
    readonly prompt: string | null;
    readonly model: string | null;
    readonly has_workflow: number;
    readonly workflow_tokens: number | null;
    readonly agents_json: string | null;
  }>`
    SELECT s.subagent_id, s.origin, s.child_thread_id, s.status, s.started_at, s.completed_at,
      s.updated_at,
      json_extract(s.payload_json, '$.remoteChild') IS NOT NULL AS remote,
      json_extract(s.payload_json, '$.command.command') AS command,
      json_extract(s.payload_json, '$.title') AS title,
      substr(json_extract(s.payload_json, '$.prompt'), 1, ${SUBAGENT_PROMPT_LENGTH}) AS prompt,
      json_extract(s.payload_json, '$.model') AS model,
      json_extract(s.payload_json, '$.workflow') IS NOT NULL AS has_workflow,
      json_extract(s.payload_json, '$.workflow.totalTokens') AS workflow_tokens,
      (SELECT json_group_array(json_object(
          'label', json_extract(agent.value, '$.label'),
          'model', json_extract(agent.value, '$.model'),
          'state', json_extract(agent.value, '$.state'),
          'startedAt', json_extract(agent.value, '$.startedAt'),
          'completedAt', json_extract(agent.value, '$.completedAt'),
          'totalTokens', json_extract(agent.value, '$.totalTokens')))
        FROM json_each(s.payload_json, '$.workflow.agents') agent) AS agents_json
    FROM orchestration_v2_projection_subagents s
    WHERE s.thread_id = ${threadId}
    ORDER BY s.started_at, s.subagent_id
  `;
  const subagents = yield* Effect.forEach(
    subagentRows,
    Effect.fnUntraced(function* (subagent): Effect.fn.Return<AnalysisSubagent, Schema.SchemaError> {
      const agents: ReadonlyArray<AnalysisWorkflowAgent> =
        subagent.agents_json === null ? [] : yield* decodeWorkflowAgents(subagent.agents_json);
      return {
        id: subagent.subagent_id,
        origin: subagent.origin,
        childThreadId: subagent.child_thread_id as ThreadId | null,
        remote: subagent.remote === 1,
        command: subagent.command,
        title: subagent.title,
        prompt: subagent.prompt ?? "",
        model: subagent.model,
        status: subagent.status,
        startedAt: subagent.started_at,
        completedAt: subagent.completed_at,
        updatedAt: subagent.updated_at,
        workflow:
          subagent.has_workflow === 1
            ? { totalTokens: yield* decodeWorkflowTokens(subagent.workflow_tokens), agents }
            : null,
      };
    }),
  );

  return {
    thread,
    runs,
    attempts,
    messages,
    turns,
    items,
    requests,
    subagents,
    reopens: reopenRows[0]?.reopens ?? 0,
  } satisfies ThreadAnalysisRead;
});
