import {
  CommandId,
  EnvironmentId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProjectId,
  ScheduledTask,
  ScheduledTaskChangedBy,
  ScheduledTaskSharing,
  ScheduledTaskOneMachineDecision,
  ScheduledTaskProjectMachineOrder,
  compareScheduledTaskSharedRevisions,
  defaultScheduledTaskMachineOrder,
  scheduledTaskSharedProjectKey,
  type OrchestratorMcpSharedScheduledTasksResult,
  type ScheduledTaskApplySharedInput,
  type ScheduledTaskApplySharedResult,
  type ScheduledTaskSharedRevision,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  ScheduledTaskWebhookDeliveryId,
  DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS,
  MAX_SCHEDULED_TASK_MAX_LIVE_RUNS,
  defaultCatchUpMissedRun,
  type ModelSelection,
  type ScheduledTaskListRunsInput,
  type ScheduledTaskListRunsResult,
  ScheduledTaskDelegateProviders,
  ScheduledTaskNoWorkSkip,
  ScheduledTaskRunCheck,
  ScheduledTaskRunCondition,
  ScheduledTaskRunRecord,
  type ScheduledTaskRunSkipReason,
  ScheduledTaskRunFailover,
  ScheduledTaskRunUsageLimit,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskWebhookFilter,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskSetFollowsDefaultModelInput,
  type ScheduledTaskSetFollowsDefaultModelResult,
  type ScheduledTaskPlacement,
  type ScheduledTaskReorderPinnedInput,
  type ScheduledTaskReorderPinnedResult,
  type ScheduledTaskSetPlacementInput,
  type ScheduledTaskSetPlacementResult,
  type ScheduledTaskSetGroupPausedInput,
  type ScheduledTaskSetGroupPausedResult,
  type ServerSettings as ServerSettingsValue,
  type ScheduledTaskUpsertInput,
  type ProviderDriverKind,
  managedPolicyDeniedMessage,
  resolveProjectProviderInstanceEnabled,
  managedRuntimeModeDenial,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as NetworkRecoveryWorker from "../orchestration-v2/NetworkRecoveryWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
import * as SharedTaskPeerCheck from "./SharedTaskPeerCheck.ts";
import * as PromptFileReader from "./PromptFileReader.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveScheduledTaskDefaultModelSelection } from "@t3tools/shared/projectSettings";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  isMissedFixedTimeRun,
  isSameSchedule,
  latestAlignedIntervalRunAt,
  latestMissedFixedTimeRun,
  nextAlignedIntervalRunAt,
  nextScheduledRunAt,
  occurrenceSlot,
} from "./Schedule.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import {
  acceptWebhookDedupe,
  acceptImmediateWebhookDedupe,
  releaseWebhookReplay,
  decodePendingTask,
  decodePendingRequest,
  dedupeError,
} from "./webhookDedupe.ts";
import { describeFailedWebhookFilter, findFailedWebhookFilter } from "./webhookFilter.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
const isScheduledTaskError = Schema.is(ScheduledTaskError);
const isLostPromptFileRead = (
  error: PromptFileReader.PromptFileReadError | ScheduledTaskError,
): error is PromptFileReader.PromptFileReadError =>
  error._tag === "PromptFileReadError" && error.lostConnection;
const PROMPT_TOO_LONG = "The filled-in prompt is too long.";
const MINUTE_MS = 60_000;
// An occurrence of a one-machine task counts as run if a machine started it within this
// long before the occurrence was due.
const ONE_MACHINE_WINDOW_CAP_MS = 12 * 60 * MINUTE_MS;
const ONE_MACHINE_GRACE_CAP_MS = 5 * MINUTE_MS;
// Occurrence claims outlive every watch of their occurrence: a slow machine may still ask about one.
const ONE_MACHINE_CLAIM_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
const WEBHOOK_DELIVERY_RETENTION = 50;
// A machine that has not pulled shared tasks for this long no longer counts as one they reach.
const SHARED_PULLER_RETENTION_MS = 30 * 24 * 60 * MINUTE_MS;
const sharedPullerCutoff = (now: DateTime.Utc) =>
  DateTime.formatIso(DateTime.subtract(now, { milliseconds: SHARED_PULLER_RETENTION_MS }));
interface RunConditionRow {
  readonly command: string;
  readonly timeout_seconds: number;
}

const RUN_HISTORY_RETENTION = 50;
// Each kept apart, so a frequent check that finds no work, or a long usage limit, cannot push
// real runs out of history.
const QUIET_SKIP_REASONS = [
  "no_work",
  "usage_limited",
  "live_run_limit",
] as const satisfies ReadonlyArray<ScheduledTaskRunSkipReason>;
const QUIET_SKIP_RETENTION = 10;
// The newest run chats a live-run count reads: room for a full limit plus as many Run now runs.
// An older chat that works again does not hold runs back.
const LIVE_RUN_CHECK_LIMIT = 2 * MAX_SCHEDULED_TASK_MAX_LIVE_RUNS;
// Runs (not skips) this recent stay beyond the newest 50, so usage can count a group's runs over 90 days.
const RUN_HISTORY_WINDOW_MS = 90 * 24 * 60 * MINUTE_MS;
const runHistoryCutoff = (startedAt: string) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(startedAt) - RUN_HISTORY_WINDOW_MS));
const WEBHOOK_DEDUPE_DELIVERY_RETENTION = 20;
const WEBHOOK_FILTERED_DELIVERY_RETENTION = 20;
const WEBHOOK_DEDUPE_LOG_PER_MINUTE = 10;
const WEBHOOK_FILTERED_LOG_PER_MINUTE = 10;
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
// Enforce the relay's per-task/minute limit here too; tunnel hostnames are public.
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
const LEGACY_DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);

interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "t3/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

interface RateWindow {
  readonly accepted: ReadonlyArray<{ readonly at: number }>;
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  readonly relayDeliveryId?: string;
  readonly receivedAt?: string;
}

export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "coalesced"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "filtered"
  | "not_found"
  | "blocked_by_policy"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      readonly outcome: "accepted" | "duplicate" | "coalesced" | "prompt_too_long" | "filtered";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | { readonly _tag: "blocked_by_policy" }
  | {
      readonly _tag: "rate_limited";
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

const webhookFilters = (filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined) =>
  filters?.length ? { filters } : {};

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeRunRecord = Schema.decodeUnknownOption(ScheduledTaskRunRecord);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const decodeSharedProjectJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskSharing.fields.project),
);
const decodeExcludedEnvironmentsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskSharing.fields.excludedEnvironmentIds),
);
const decodeUncheckedJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskOneMachineDecision.fields.unchecked),
);
const decodeMachineOrderRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    project: Schema.fromJsonString(ScheduledTaskProjectMachineOrder.fields.project),
    order: Schema.fromJsonString(ScheduledTaskProjectMachineOrder.fields.order),
    revision: ScheduledTaskProjectMachineOrder.fields.revision,
  }),
);
const decodeRunConditionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskRunCondition),
);
const decodeNoWorkSkipJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTaskNoWorkSkip),
);
const ChangedByJson = Schema.fromJsonString(ScheduledTaskChangedBy);
const decodeChangedByJson = Schema.decodeUnknownEffect(ChangedByJson);
const encodeChangedByJson = Schema.encodeSync(ChangedByJson);
const decodeRunCheckJson = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskRunCheck));
const RunUsageLimitJson = Schema.fromJsonString(ScheduledTaskRunUsageLimit);
const decodeRunUsageLimitJson = Schema.decodeUnknownOption(RunUsageLimitJson);
const McpServersJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeMcpServersJson = Schema.decodeUnknownOption(McpServersJson);
const encodeMcpServersJson = Schema.encodeSync(McpServersJson);
const encodeRunUsageLimitJson = Schema.encodeSync(RunUsageLimitJson);
const DelegateProvidersJson = Schema.fromJsonString(ScheduledTaskDelegateProviders);
const decodeDelegateProvidersJson = Schema.decodeUnknownEffect(DelegateProvidersJson);
const encodeDelegateProvidersSchema = Schema.encodeSync(DelegateProvidersJson);
const encodeDelegateProvidersJson = (drivers: ReadonlyArray<ProviderDriverKind>) =>
  encodeDelegateProvidersSchema([...new Set(drivers)]);
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  /** Null when the last run predates the app recording it, so its occurrence is unknown. */
  readonly last_run_trigger: string | null;
  readonly last_run_scheduled_for: string | null;
  readonly run_count: number;
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
  /** From scheduled_task_sidebar; absent where a query does not join it. */
  readonly pinned_at?: string | null;
  readonly pin_order_key?: string | null;
  readonly placement?: ScheduledTaskPlacement;
  readonly last_run_thread_id?: string | null;
  readonly follows_default_model?: number;
  readonly shared_revision_at?: string | null;
  readonly shared_revision_environment_id?: string | null;
  readonly shared_project_json?: string | null;
  readonly shared_excluded_environment_ids_json?: string | null;
  readonly shared_run_on?: string | null;
  readonly decision_at?: string | null;
  readonly decision_ran_on?: string | null;
  readonly decision_unchecked_json?: string | null;
  readonly decision_unconfirmed?: number | null;
  /** From scheduled_task_catch_up: null when the task keeps the default. */
  readonly catch_up_missed_run?: number | null;
  /** From scheduled_task_run_conditions: null when the task has none. */
  readonly run_condition_json?: string | null;
  /** The newest no-work skip from scheduled_task_runs; it outlives the condition that made it. */
  readonly no_work_skip_json?: string | null;
  /** From scheduled_task_prompt_files: null when the task runs its own prompt. */
  readonly prompt_file_path?: string | null;
  readonly prompt_file_read_at?: string | null;
  readonly prompt_file_ref?: string | null;
  readonly prompt_file_commit?: string | null;
  /** From scheduled_task_group: null when the task has no group. */
  readonly group_label?: string | null;
  readonly paused_with_group?: number | null;
  /** From scheduled_task_delegate_providers: null when the task needs none. */
  readonly delegate_providers_json?: string | null;
  /** From scheduled_task_live_run_limit: null for the default. */
  readonly max_live_runs?: number | null;
  /** From scheduled_task_changed_by: null when who made the latest change is unknown. */
  readonly changed_by_json?: string | null;
}

interface RunRecordRow {
  readonly run_id: string;
  readonly trigger: string;
  readonly scheduled_for: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly outcome: string;
  readonly thread_id: string | null;
  readonly error: string | null;
  readonly skip_reason: string | null;
  readonly ran_on: string | null;
  readonly failover_from: string | null;
  readonly failover_to: string | null;
  readonly failover_reason: string | null;
  readonly failover_mcp_servers_json: string | null;
  readonly check_json: string | null;
  readonly usage_limit_json: string | null;
}

/** What a scheduled run is for: the time it serves, and whether it catches up a missed one. */
interface ScheduledFire {
  readonly scheduledFor: string | null;
  readonly catchUp: boolean;
  /** What the task's run condition answered for this occurrence. */
  readonly check?: ScheduledTaskRunCheck;
}

interface RunCheckInProgress {
  readonly startedAt: string;
  readonly scheduledFor: string | null;
}

interface MachineOrderRow extends SharedRevisionRow {
  readonly project_json: string;
  readonly order_json: string;
}

interface SharedRevisionRow {
  readonly revision_at: string;
  readonly revision_environment_id: string;
}

interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly pending_window: number;
  readonly error: string | null;
}

/** Who asks for a change; the service adds when. */
export type ScheduledTaskChanger = Omit<ScheduledTaskChangedBy, "at">;

/** A person in the app: the web, desktop and mobile clients reach the service only over WebSocket. */
export const CHANGED_IN_APP: ScheduledTaskChanger = { kind: "ui", threadId: null };

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: (options?: {
      readonly resolveModels?: boolean;
    }) => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
      by: ScheduledTaskChanger,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
      by: ScheduledTaskChanger,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly setPlacement: (
      input: ScheduledTaskSetPlacementInput,
    ) => Effect.Effect<ScheduledTaskSetPlacementResult, ScheduledTaskError>;
    /**
     * Pausing turns off the listed tasks that are on and in a group, and marks them; resuming
     * turns back on only marked ones, leaving any that can no longer run off and saying why.
     */
    readonly setGroupPaused: (
      input: ScheduledTaskSetGroupPausedInput,
      by: ScheduledTaskChanger,
    ) => Effect.Effect<ScheduledTaskSetGroupPausedResult, ScheduledTaskError>;
    readonly reorderPinned: (
      input: ScheduledTaskReorderPinnedInput,
    ) => Effect.Effect<ScheduledTaskReorderPinnedResult, ScheduledTaskError>;
    readonly setFollowsDefaultModel: (
      input: ScheduledTaskSetFollowsDefaultModelInput,
      by: ScheduledTaskChanger,
    ) => Effect.Effect<ScheduledTaskSetFollowsDefaultModelResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    /**
     * This machine's shared tasks as copies for `forEnvironmentId`, which gets none that exclude
     * it. With `recordPuller`, for a caller proven to be that machine, it is recorded as one that
     * receives them, which a task may then leave out.
     */
    readonly sharedCopies: (
      forEnvironmentId: EnvironmentId,
      options: { readonly recordPuller: boolean },
    ) => Effect.Effect<OrchestratorMcpSharedScheduledTasksResult, ScheduledTaskError>;
    /**
     * Machines a shared task in this project reaches without a link from here: those in the
     * project's machine order, and those that pulled shared tasks from here in the last 30 days.
     */
    readonly knownMachineIds: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<EnvironmentId>, ScheduledTaskError>;
    /**
     * This machine's record of which machine holds one occurrence of a one-machine task. `by`
     * claims it for itself when free, or from `replaces` when that is another machine whose own
     * copy agreed first, or this machine that gave the occurrence up or whose run of it failed in
     * a chat. `by` hands on only a claim it holds here. Returns the holder after the call.
     */
    readonly claimOccurrence: (input: {
      readonly taskId: ScheduledTaskId;
      /** An ISO time; a fixed time's has no offset and is read in this machine's zone. */
      readonly occurrence: string;
      readonly holder: EnvironmentId;
      readonly replaces: EnvironmentId | null;
      /** The machine asking. */
      readonly by: EnvironmentId;
      /** This machine's last run failed and nobody stopped it. */
      readonly lastRunFailed?: boolean;
    }) => Effect.Effect<EnvironmentId, ScheduledTaskError>;
    /** Brings this machine's copy of a shared task up to a newer revision; an older one changes nothing. */
    readonly applyShared: (
      input: ScheduledTaskApplySharedInput,
    ) => Effect.Effect<ScheduledTaskApplySharedResult, ScheduledTaskError>;
    /** Deletes only tasks that still target this thread, including their webhook deliveries. */
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, ScheduledTaskError>;
    /** Points tasks bound to these threads at the project the threads moved to. */
    readonly moveThreadTasks: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, ScheduledTaskError>;
    /** The dispatched thread, or null if dispatch failed; leaves the task's binding unchanged. */
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<
      ScheduledTaskRunNowResult & { readonly threadId: ThreadId | null },
      ScheduledTaskError
    >;
    /**
     * How many of the task's runs here still work, delegated tasks included. Null for a task its
     * live-run limit does not apply to: one bound to a thread, run once or by a webhook.
     */
    readonly liveRuns: (task: ScheduledTask) => Effect.Effect<number | null, ScheduledTaskError>;
    /** The task's recent runs, newest first, including fires that failed or were skipped. */
    readonly listRuns: (
      input: ScheduledTaskListRunsInput,
    ) => Effect.Effect<ScheduledTaskListRunsResult, ScheduledTaskError>;
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /** Verifies, logs and dispatches; returns after logging while the run continues in the background. */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(
  message: string,
  input?: { taskId?: ScheduledTaskId | undefined; cause?: unknown },
) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

interface OneMachineWatch {
  /** The machine that holds the occurrence. */
  readonly environmentId: EnvironmentId;
  /** Its run ended unfinished, and this machine waits for nearer machines to take over. */
  readonly ended: boolean;
}

interface OneMachinePlan {
  /** Every machine with a copy this one knows of: the stored order, then the rest. */
  readonly order: ReadonlyArray<EnvironmentId>;
  /** The stored order's machines that keep a copy, alike on every machine; they hold the claims. */
  readonly members: ReadonlyArray<EnvironmentId>;
  readonly rank: number;
}

/**
 * Whether the claim copies `held` are a quorum of the members. Any two quorums share a member,
 * and each copy names one holder, so no two machines both hold an occurrence.
 */
const holdsQuorum = (members: ReadonlyArray<EnvironmentId>, held: ReadonlySet<EnvironmentId>) => {
  const count = members.filter((id) => held.has(id)).length;
  return count * 2 > members.length || (count * 2 === members.length && held.has(members[0]!));
};

type NextRunTask = Pick<ScheduledTask, "enabled" | "schedule"> &
  Partial<Pick<ScheduledTask, "createdAt" | "shared">>;

/** Every copy of a one-machine interval task runs the same slots, counted from its creation. */
function hasAlignedSlots(task: Pick<NextRunTask, "schedule" | "shared">): boolean {
  return task.schedule.type === "interval" && task.shared?.runOn === "one";
}

function nextRunAt(task: NextRunTask, from: DateTime.DateTime): string | null {
  if (!task.enabled) return null;
  // Decoded intervals can overflow DateTime; unrepresentable occurrences have no next run.
  try {
    const anchorMs = Date.parse(task.createdAt ?? "");
    const next =
      task.schedule.type === "interval" && hasAlignedSlots(task) && Number.isFinite(anchorMs)
        ? nextAlignedIntervalRunAt(task.schedule.everyMs, anchorMs, from)
        : nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

/**
 * The occurrence a one-machine due time stands for. After a restart forgets a deferral,
 * `next_run_at` holds the time this machine meant to ask again, which is later than it.
 */
function oneMachineOccurrenceMs(task: NextRunTask, due: DateTime.DateTime): number {
  const dueMs = DateTime.toEpochMillis(due);
  const anchorMs = Date.parse(task.createdAt ?? "");
  const latest =
    task.schedule.type === "interval" && hasAlignedSlots(task) && Number.isFinite(anchorMs)
      ? latestAlignedIntervalRunAt(task.schedule.everyMs, anchorMs, due)
      : task.schedule.type === "once"
        ? DateTime.make(task.schedule.runAt).pipe(Option.getOrNull)
        : (latestMissedFixedTimeRun(task.schedule, due)?.at ?? null);
  return latest === null ? dueMs : Math.min(dueMs, DateTime.toEpochMillis(latest));
}

/**
 * Next run after an interrupted run. A one-time task counts from the run's start
 * (`lastRunAt`), so a manual run that began before its time does not use it up.
 */
function nextRunAfterRun(
  task: NextRunTask & Pick<ScheduledTask, "lastRunAt">,
  now: DateTime.DateTime,
): string | null {
  const startedAt =
    task.schedule.type === "once" && task.lastRunAt !== null
      ? DateTime.make(task.lastRunAt)
      : Option.none();
  return nextRunAt(
    task,
    Option.getOrElse(startedAt, () => now),
  );
}

/** An enabled one-time task with a past time would never run, so saving it is an error. */
function passedOnceMessage(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  now: DateTime.DateTime,
): string | undefined {
  return task.enabled && task.schedule.type === "once" && nextRunAt(task, now) === null
    ? "The run time has passed. Pick a time in the future."
    : undefined;
}

function requireFutureOnce(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  now: DateTime.DateTime,
  taskId: ScheduledTaskId,
) {
  const message = passedOnceMessage(task, now);
  return message === undefined ? Effect.void : taskError(message, { taskId });
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

// Runs per task row; list and lookup operations already own the span.
const decodeRow = Effect.fnUntraced(
  function* (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    const shared =
      row.shared_revision_at === undefined
        ? undefined
        : row.shared_revision_at === null
          ? null
          : {
              revision: {
                at: row.shared_revision_at,
                environmentId: row.shared_revision_environment_id,
              },
              project: yield* decodeSharedProjectJson(row.shared_project_json),
              excludedEnvironmentIds: yield* decodeExcludedEnvironmentsJson(
                row.shared_excluded_environment_ids_json,
              ),
              ...(row.shared_run_on === "one" ? { runOn: "one" } : {}),
            };
    const decision =
      row.decision_at === undefined
        ? undefined
        : row.decision_at === null
          ? null
          : {
              at: row.decision_at,
              ranOn: row.decision_ran_on,
              unchecked: yield* decodeUncheckedJson(row.decision_unchecked_json),
              ...(row.decision_unconfirmed === 1 ? { unconfirmed: true } : {}),
            };
    return yield* decodeTask({
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
      ...(row.placement === undefined ? {} : { placement: row.placement }),
      ...(row.pinned_at === undefined ? {} : { pinnedAt: row.pinned_at }),
      ...(row.pin_order_key === undefined ? {} : { pinOrderKey: row.pin_order_key }),
      ...(row.last_run_thread_id === undefined ? {} : { lastRunThreadId: row.last_run_thread_id }),
      ...(row.follows_default_model === undefined
        ? {}
        : { followsDefaultModel: row.follows_default_model === 1 }),
      ...(shared === undefined ? {} : { shared }),
      ...(decision === undefined ? {} : { lastOneMachineDecision: decision }),
      ...(row.catch_up_missed_run === undefined
        ? {}
        : {
            catchUpMissedRun:
              row.catch_up_missed_run === null
                ? defaultCatchUpMissedRun(schedule)
                : row.catch_up_missed_run === 1,
          }),
      ...(row.run_condition_json === undefined
        ? {}
        : {
            runCondition:
              row.run_condition_json === null
                ? null
                : yield* decodeRunConditionJson(row.run_condition_json),
          }),
      ...(row.no_work_skip_json === undefined
        ? {}
        : {
            lastNoWorkSkip:
              row.no_work_skip_json === null
                ? null
                : yield* decodeNoWorkSkipJson(row.no_work_skip_json),
          }),
      ...(row.last_run_trigger === null ? {} : { lastRunScheduledFor: row.last_run_scheduled_for }),
      ...(row.prompt_file_path === undefined
        ? {}
        : {
            promptFile:
              row.prompt_file_path === null
                ? null
                : {
                    path: row.prompt_file_path,
                    lastRead:
                      row.prompt_file_read_at == null
                        ? null
                        : {
                            at: row.prompt_file_read_at,
                            ref: row.prompt_file_ref,
                            commit: row.prompt_file_commit,
                          },
                  },
          }),
      ...(row.group_label === undefined ? {} : { group: row.group_label }),
      ...(row.paused_with_group === 1 && row.enabled !== 1 ? { pausedWithGroup: true } : {}),
      ...(row.delegate_providers_json === undefined
        ? {}
        : {
            delegateProviders:
              row.delegate_providers_json === null
                ? []
                : yield* decodeDelegateProvidersJson(row.delegate_providers_json),
          }),
      ...(row.max_live_runs === undefined
        ? {}
        : { maxLiveRuns: row.max_live_runs ?? DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS }),
      ...(row.changed_by_json === undefined
        ? {}
        : {
            changedBy:
              row.changed_by_json === null ? null : yield* decodeChangedByJson(row.changed_by_json),
          }),
    });
  },
  (effect, row, _origin?) =>
    effect.pipe(
      Effect.mapError((cause) => {
        const taskId = decodeTaskId(row.task_id);
        return taskError("Could not decode schedule task row.", {
          ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
          cause,
        });
      }),
    ),
);

export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `.pipe(NodeSqliteClient.readOnly);
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is freeform; skip unparseable values before they defect the poll.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const hereEnvironmentId = yield* ServerEnvironment.ServerEnvironmentIdentity.pipe(
      Effect.flatMap((identity) => identity.getEnvironmentId),
    );
    const peerCheck = yield* SharedTaskPeerCheck.SharedTaskPeerCheck;
    const runConditionCheck = yield* RunConditionCheck.RunConditionCheck;
    const promptFiles = yield* PromptFileReader.PromptFileReader;
    const projects = yield* ProjectService.ProjectService;
    const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    // Optional so tests without accounts run every launch on the task's own account.
    const accountRouting = yield* Effect.serviceOption(AccountRouting.AccountRouting);
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
    const webhookPolicyOrganization = ManagedPolicy.deniedBy(managedPolicy, "webhookTasks");
    // Existing webhook tasks stay stored but report why they do not run.
    const webhookPolicyBlock =
      webhookPolicyOrganization === undefined
        ? undefined
        : managedPolicyDeniedMessage(webhookPolicyOrganization, "webhook tasks");
    const withPolicy = (task: ScheduledTask): ScheduledTask =>
      webhookPolicyBlock !== undefined && task.schedule.type === "webhook"
        ? { ...task, blockedByPolicy: webhookPolicyBlock }
        : task;
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    // Include creation time so late deliveries cannot decrement a recreated task's count.
    const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
    const webhookRejectedRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(
      new Map(),
    );
    const webhookDedupeLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const pendingInFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
    const webhookFilteredLogWindows = yield* Ref.make<
      ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>
    >(new Map());
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Tasks whose run condition is running, when it started and the occurrence it is for.
    const runChecks = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RunCheckInProgress>>(new Map());
    // Scheduled runs that read their prompt file in the background, claimed before they start.
    const backgroundRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    const withRunCheck =
      (checks: ReadonlyMap<ScheduledTaskId, RunCheckInProgress>) =>
      (task: ScheduledTask): ScheduledTask => {
        const check = checks.get(task.id);
        return {
          ...task,
          runCheckStartedAt: check?.startedAt ?? null,
          runCheckScheduledFor: check?.scheduledFor ?? null,
        };
      };
    const serviceScope = yield* Effect.scope;
    // A restart forgets these, which only costs a one-machine task one more wait for its turn.
    const oneMachineDeferrals = yield* Ref.make<
      ReadonlyMap<
        ScheduledTaskId,
        {
          readonly occurrenceDueMs: number;
          readonly deferredTo: string;
          readonly catchUp: boolean;
          /** The machine whose run of this occurrence was still going at the last check. */
          readonly watching: OneMachineWatch | null;
        }
      >
    >(new Map());
    // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const dueTasks = DueHint.make();
    const pendingWebhooks = DueHint.make();
    // Every scheduled_tasks write that can change next_run_at, enabled or run state notifies.
    const notifyChanged = dueTasks.invalidate.pipe(
      Effect.andThen(PubSub.publish(changesPubSub, undefined)),
      Effect.asVoid,
    );

    // Not a numbered migration: this fork's ids would collide with upstream's, and an
    // upstream rebuild of scheduled_tasks would drop fork-only columns.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_sidebar (
        task_id TEXT PRIMARY KEY,
        pinned_at TEXT,
        last_run_thread_id TEXT,
        pin_order_key TEXT
      )
    `;
    const sidebarColumns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_task_sidebar)`;
    if (!sidebarColumns.some((column) => column.name === "pin_order_key")) {
      yield* sql`ALTER TABLE scheduled_task_sidebar ADD COLUMN pin_order_key TEXT`;
    }
    if (!sidebarColumns.some((column) => column.name === "placement")) {
      yield* sql`ALTER TABLE scheduled_task_sidebar ADD COLUMN placement TEXT`;
    }
    yield* sql`
      UPDATE scheduled_task_sidebar SET placement = 'pinned'
      WHERE placement IS NULL AND pinned_at IS NOT NULL
    `;
    // A row means the task runs the scheduled tasks default model instead of its own.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_default_model (task_id TEXT PRIMARY KEY)
    `;

    // A shared task keeps its sync metadata here, off scheduled_tasks, for the same reason.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_shared (
        task_id TEXT PRIMARY KEY,
        revision_at TEXT NOT NULL,
        revision_environment_id TEXT NOT NULL,
        project_json TEXT NOT NULL,
        excluded_environment_ids_json TEXT NOT NULL,
        run_on TEXT NOT NULL DEFAULT 'every'
      )
    `;
    // The machines a project's one-machine tasks try in order; synced like a shared task.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_project_machine_orders (
        project_key TEXT PRIMARY KEY,
        project_json TEXT NOT NULL,
        order_json TEXT NOT NULL,
        revision_at TEXT NOT NULL,
        revision_environment_id TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_one_machine_decision (
        task_id TEXT PRIMARY KEY,
        decided_at TEXT NOT NULL,
        ran_on TEXT,
        unchecked_json TEXT NOT NULL
      )
    `;
    if (
      !(yield* sql<{
        name: string;
      }>`PRAGMA table_info(scheduled_task_one_machine_decision)`).some(
        (column) => column.name === "unconfirmed",
      )
    ) {
      yield* sql`ALTER TABLE scheduled_task_one_machine_decision ADD COLUMN unconfirmed INTEGER NOT NULL DEFAULT 0`;
    }
    // Which machine holds an occurrence of a one-machine task. Every machine keeps a copy, so one
    // that cannot reach the holder still learns of it from the others.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_occurrence_claims (
        task_id TEXT NOT NULL,
        occurrence_at TEXT NOT NULL,
        holder_environment_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        PRIMARY KEY (task_id, occurrence_at)
      )
    `;
    // A row means the task's own catch-up choice; without one it follows its schedule's default.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_catch_up (
        task_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL
      )
    `;
    // A row names the task's group. paused_with_group marks a task its group's pause turned off,
    // so resuming the group turns back on only those.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_group (
        task_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        paused_with_group INTEGER NOT NULL DEFAULT 0
      )
    `;
    // Stats read every task's runs in a time window, and history keeps 90 days of them.
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_started
      ON scheduled_task_runs(started_at)
    `;
    // Machines that pulled shared tasks from here: copies reach them though no link from here does.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_shared_pullers (
        environment_id TEXT PRIMARY KEY,
        pulled_at TEXT NOT NULL
      )
    `;
    // A row means each run reads its prompt from this file; `prompt` keeps the text last read.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_prompt_files (
        task_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        read_at TEXT,
        ref TEXT,
        commit_sha TEXT
      )
    `;
    // A row lists the providers the task delegates to; without one it needs none.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_delegate_providers (
        task_id TEXT PRIMARY KEY,
        providers_json TEXT NOT NULL
      )
    `;
    // A row holds a live-run limit other than the default.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_live_run_limit (
        task_id TEXT PRIMARY KEY,
        max_live_runs INTEGER NOT NULL
      )
    `;
    // Who made a task's latest change. Tasks changed before this table existed have no row, so
    // their author reads as unknown rather than a guess.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_changed_by (
        task_id TEXT PRIMARY KEY,
        changed_by_json TEXT NOT NULL
      )
    `;
    const runColumns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_task_runs)`;
    if (!runColumns.some((column) => column.name === "usage_limit_json")) {
      yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN usage_limit_json TEXT`;
    }
    yield* sql`
      UPDATE scheduled_task_runs SET skip_reason = 'live_run_limit'
      WHERE skip_reason = 'last_run_working'
    `;
    // Outlives the task so a stale copy on another machine is removed, not restored.
    yield* sql`
      CREATE TABLE IF NOT EXISTS scheduled_task_shared_deletions (
        task_id TEXT PRIMARY KEY,
        revision_at TEXT NOT NULL,
        revision_environment_id TEXT NOT NULL
      )
    `;

    const readSettings = serverSettings.getSettings.pipe(
      Effect.mapError((cause) => taskError("Could not read server settings.", { cause })),
    );
    // Clients show, and runs launch, the model a following task will run, so resolve it on read.
    const withDefaultModel =
      (settings: ServerSettingsValue) =>
      (task: ScheduledTask): ScheduledTask =>
        task.followsDefaultModel === true
          ? {
              ...task,
              modelSelection:
                resolveScheduledTaskDefaultModelSelection(settings, task.projectId) ??
                task.modelSelection,
            }
          : task.shared != null &&
              !resolveProjectProviderInstanceEnabled(
                settings,
                task.projectId,
                task.modelSelection.instanceId,
              )
            ? // Another machine's account: the task keeps its own model, runs use the default here.
              { ...task, modelUnavailableHere: true }
            : task;
    const launchModelSelection = (settings: ServerSettingsValue, task: ScheduledTask) =>
      task.modelUnavailableHere === true
        ? (resolveScheduledTaskDefaultModelSelection(settings, task.projectId) ??
          task.modelSelection)
        : task.modelSelection;

    const selectAllRows = () =>
      sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        last_run_trigger,
        last_run_scheduled_for,
        run_count,
        webhook_token,
        webhook_secret,
        COALESCE((SELECT placement FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id), 'chat') AS placement,
        (SELECT pinned_at FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS pinned_at,
        (SELECT pin_order_key FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS pin_order_key,
        (SELECT last_run_thread_id FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS last_run_thread_id,
        EXISTS (SELECT 1 FROM scheduled_task_default_model d
          WHERE d.task_id = scheduled_tasks.task_id) AS follows_default_model,
        (SELECT revision_at FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_revision_at,
        (SELECT revision_environment_id FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_revision_environment_id,
        (SELECT project_json FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_project_json,
        (SELECT excluded_environment_ids_json FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_excluded_environment_ids_json,
        (SELECT run_on FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_run_on,
        (SELECT decided_at FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_at,
        (SELECT ran_on FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_ran_on,
        (SELECT unchecked_json FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_unchecked_json,
        (SELECT unconfirmed FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_unconfirmed,
        (SELECT enabled FROM scheduled_task_catch_up c
          WHERE c.task_id = scheduled_tasks.task_id) AS catch_up_missed_run,
        (SELECT json_object('command', rc.command, 'timeoutSeconds', rc.timeout_seconds)
          FROM scheduled_task_run_conditions rc
          WHERE rc.task_id = scheduled_tasks.task_id) AS run_condition_json,
        (SELECT json_object('at', r.started_at, 'scheduledFor', r.scheduled_for,
            'reason', json_extract(r.check_json, '$.detail'))
          FROM scheduled_task_runs r
          WHERE r.task_id = scheduled_tasks.task_id AND r.skip_reason = 'no_work'
          ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1) AS no_work_skip_json,
        (SELECT path FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_path,
        (SELECT read_at FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_read_at,
        (SELECT ref FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_ref,
        (SELECT commit_sha FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_commit,
        (SELECT label FROM scheduled_task_group g
          WHERE g.task_id = scheduled_tasks.task_id) AS group_label,
        (SELECT paused_with_group FROM scheduled_task_group g
          WHERE g.task_id = scheduled_tasks.task_id) AS paused_with_group,
        (SELECT providers_json FROM scheduled_task_delegate_providers dp
          WHERE dp.task_id = scheduled_tasks.task_id) AS delegate_providers_json,
        (SELECT max_live_runs FROM scheduled_task_live_run_limit lr
          WHERE lr.task_id = scheduled_tasks.task_id) AS max_live_runs,
        (SELECT changed_by_json FROM scheduled_task_changed_by cb
          WHERE cb.task_id = scheduled_tasks.task_id) AS changed_by_json
      FROM scheduled_tasks
      -- Not updated_at: toggles, runs and edits rewrite it, and clients render
      -- this order as-is, so rows would move under the pointer.
      ORDER BY created_at DESC, task_id ASC
    `.pipe(NodeSqliteClient.readOnly);

    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* (resolveModels = true) {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      const resolveModel = withDefaultModel(yield* readSettings);
      const withCheck = withRunCheck(yield* Ref.get(runChecks));
      return yield* Effect.forEach(
        rows,
        (row) =>
          decodeRow(row, origin).pipe(
            Effect.map((task) =>
              withCheck(resolveModels ? resolveModel(withPolicy(task)) : withPolicy(task)),
            ),
          ),
        { concurrency: 1 },
      );
    });

    const getRows = (id: ScheduledTaskId) =>
      sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        last_run_trigger,
        last_run_scheduled_for,
        run_count,
        webhook_token,
        webhook_secret,
        COALESCE((SELECT placement FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id), 'chat') AS placement,
        (SELECT pinned_at FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS pinned_at,
        (SELECT pin_order_key FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS pin_order_key,
        (SELECT last_run_thread_id FROM scheduled_task_sidebar s
          WHERE s.task_id = scheduled_tasks.task_id) AS last_run_thread_id,
        EXISTS (SELECT 1 FROM scheduled_task_default_model d
          WHERE d.task_id = scheduled_tasks.task_id) AS follows_default_model,
        (SELECT revision_at FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_revision_at,
        (SELECT revision_environment_id FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_revision_environment_id,
        (SELECT project_json FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_project_json,
        (SELECT excluded_environment_ids_json FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_excluded_environment_ids_json,
        (SELECT run_on FROM scheduled_task_shared sh
          WHERE sh.task_id = scheduled_tasks.task_id) AS shared_run_on,
        (SELECT decided_at FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_at,
        (SELECT ran_on FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_ran_on,
        (SELECT unchecked_json FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_unchecked_json,
        (SELECT unconfirmed FROM scheduled_task_one_machine_decision od
          WHERE od.task_id = scheduled_tasks.task_id) AS decision_unconfirmed,
        (SELECT enabled FROM scheduled_task_catch_up c
          WHERE c.task_id = scheduled_tasks.task_id) AS catch_up_missed_run,
        (SELECT json_object('command', rc.command, 'timeoutSeconds', rc.timeout_seconds)
          FROM scheduled_task_run_conditions rc
          WHERE rc.task_id = scheduled_tasks.task_id) AS run_condition_json,
        (SELECT json_object('at', r.started_at, 'scheduledFor', r.scheduled_for,
            'reason', json_extract(r.check_json, '$.detail'))
          FROM scheduled_task_runs r
          WHERE r.task_id = scheduled_tasks.task_id AND r.skip_reason = 'no_work'
          ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1) AS no_work_skip_json,
        (SELECT path FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_path,
        (SELECT read_at FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_read_at,
        (SELECT ref FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_ref,
        (SELECT commit_sha FROM scheduled_task_prompt_files pf
          WHERE pf.task_id = scheduled_tasks.task_id) AS prompt_file_commit,
        (SELECT label FROM scheduled_task_group g
          WHERE g.task_id = scheduled_tasks.task_id) AS group_label,
        (SELECT paused_with_group FROM scheduled_task_group g
          WHERE g.task_id = scheduled_tasks.task_id) AS paused_with_group,
        (SELECT providers_json FROM scheduled_task_delegate_providers dp
          WHERE dp.task_id = scheduled_tasks.task_id) AS delegate_providers_json,
        (SELECT max_live_runs FROM scheduled_task_live_run_limit lr
          WHERE lr.task_id = scheduled_tasks.task_id) AS max_live_runs,
        (SELECT changed_by_json FROM scheduled_task_changed_by cb
          WHERE cb.task_id = scheduled_tasks.task_id) AS changed_by_json
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `.pipe(NodeSqliteClient.readOnly);

    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      const task = withPolicy(yield* decodeRow(row, yield* readWebhookOrigin));
      return withRunCheck(yield* Ref.get(runChecks))(withDefaultModel(yield* readSettings)(task));
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run transitions own run-state columns; settings saves must not overwrite them.
    // Check existence in the write so edits cannot undo concurrent deletion.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      /** The schedule this save read, when it left the schedule unchanged. */
      keptSchedule: ScheduledTask["schedule"] | null,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        readonly secretChanged: boolean;
      },
    ) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count,
          webhook_token,
          webhook_secret
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount},
          ${webhook.token},
          ${webhook.secret}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          -- Keep a next_run_at that a finishing run moved during this save, unless
          -- another edit changed the schedule or enabled state meanwhile.
          next_run_at = CASE
            WHEN ${keptSchedule === null ? 0 : 1} = 1
              AND scheduled_tasks.schedule_json IN (
                excluded.schedule_json,
                ${keptSchedule === null ? null : JSON.stringify(keptSchedule)}
              )
              AND scheduled_tasks.enabled = excluded.enabled
            THEN scheduled_tasks.next_run_at
            ELSE excluded.next_run_at
          END,
          -- Only rotate changes a live token, so a save racing a rotation
          -- cannot bring the old URL back.
          webhook_token = CASE
            WHEN excluded.webhook_token IS NULL THEN NULL
            ELSE COALESCE(scheduled_tasks.webhook_token, excluded.webhook_token)
          END,
          webhook_secret = CASE
            WHEN ${webhook.secretChanged ? 1 : 0} = 1 THEN excluded.webhook_secret
            ELSE scheduled_tasks.webhook_secret
          END
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const toRevision = (row: SharedRevisionRow | undefined): ScheduledTaskSharedRevision | null =>
      row === undefined
        ? null
        : { at: row.revision_at, environmentId: EnvironmentId.make(row.revision_environment_id) };

    const storedRevisions = (id: ScheduledTaskId) =>
      Effect.all({
        shared: sql<SharedRevisionRow>`
          SELECT revision_at, revision_environment_id FROM scheduled_task_shared
          WHERE task_id = ${id}`,
        deletion: sql<SharedRevisionRow>`
          SELECT revision_at, revision_environment_id FROM scheduled_task_shared_deletions
          WHERE task_id = ${id}`,
      }).pipe(
        Effect.map(({ shared, deletion }) => ({
          shared: toRevision(shared[0]),
          deletion: toRevision(deletion[0]),
        })),
      );

    // Later than anything stored, even when this machine's clock is behind, so an edit always
    // beats the version it edited.
    const revisionAfter = Effect.fnUntraced(function* (
      storedAts: ReadonlyArray<string | undefined>,
    ) {
      const nowMs = DateTime.toEpochMillis(yield* localNow);
      const after = storedAts.map((at) => (at === undefined ? 0 : Date.parse(at) + 1));
      const revision: ScheduledTaskSharedRevision = {
        at: iso(DateTime.makeUnsafe(Math.max(nowMs, ...after))),
        environmentId: hereEnvironmentId,
      };
      return revision;
    });

    const stampRevision = Effect.fn("ScheduledTaskService.stampRevision")(function* (
      id: ScheduledTaskId,
    ) {
      const stored = yield* storedRevisions(id);
      return yield* revisionAfter([stored.shared?.at, stored.deletion?.at]);
    });

    const writeSharing = (id: ScheduledTaskId, sharing: ScheduledTaskSharing) =>
      sql`
        INSERT INTO scheduled_task_shared (
          task_id, revision_at, revision_environment_id, project_json,
          excluded_environment_ids_json, run_on
        ) VALUES (
          ${id},
          ${sharing.revision.at},
          ${sharing.revision.environmentId},
          ${JSON.stringify(sharing.project)},
          ${JSON.stringify(sharing.excludedEnvironmentIds)},
          ${sharing.runOn ?? "every"}
        )
        ON CONFLICT (task_id) DO UPDATE SET
          revision_at = excluded.revision_at,
          revision_environment_id = excluded.revision_environment_id,
          project_json = excluded.project_json,
          excluded_environment_ids_json = excluded.excluded_environment_ids_json,
          run_on = excluded.run_on
      `.pipe(
        Effect.andThen(sql`DELETE FROM scheduled_task_shared_deletions WHERE task_id = ${id}`),
      );

    const writeDeletion = (id: ScheduledTaskId, revision: ScheduledTaskSharedRevision) =>
      sql`
        INSERT INTO scheduled_task_shared_deletions (task_id, revision_at, revision_environment_id)
        VALUES (${id}, ${revision.at}, ${revision.environmentId})
        ON CONFLICT (task_id) DO UPDATE SET
          revision_at = excluded.revision_at,
          revision_environment_id = excluded.revision_environment_id
      `.pipe(Effect.andThen(sql`DELETE FROM scheduled_task_shared WHERE task_id = ${id}`));

    const writeChangedBy = (id: ScheduledTaskId, changedBy: ScheduledTaskChangedBy | null) =>
      changedBy === null
        ? sql`DELETE FROM scheduled_task_changed_by WHERE task_id = ${id}`
        : sql`
            INSERT INTO scheduled_task_changed_by (task_id, changed_by_json)
            VALUES (${id}, ${encodeChangedByJson(changedBy)})
            ON CONFLICT (task_id) DO UPDATE SET changed_by_json = excluded.changed_by_json
          `;

    // For an edit that is not a save: records who made it, and stamps a shared task with a new
    // revision so other machines take the change and its author together.
    const recordChange = Effect.fn("ScheduledTaskService.recordChange")(function* (
      id: ScheduledTaskId,
      by: ScheduledTaskChanger,
    ) {
      const changedBy: ScheduledTaskChangedBy = { ...by, at: iso(yield* localNow) };
      yield* writeChangedBy(id, changedBy);
      if ((yield* storedRevisions(id)).shared !== null) {
        const revision = yield* stampRevision(id);
        yield* sql`
          UPDATE scheduled_task_shared
          SET revision_at = ${revision.at}, revision_environment_id = ${revision.environmentId}
          WHERE task_id = ${id}
        `;
      }
      return changedBy;
    });

    const stampOrderRevision = Effect.fn("ScheduledTaskService.stampOrderRevision")(function* (
      projectKey: string,
    ) {
      const [stored] = yield* sql<SharedRevisionRow>`
        SELECT revision_at, revision_environment_id FROM scheduled_task_project_machine_orders
        WHERE project_key = ${projectKey}`;
      return yield* revisionAfter([stored?.revision_at]);
    });

    const writeMachineOrder = (order: ScheduledTaskProjectMachineOrder) =>
      sql`
        INSERT INTO scheduled_task_project_machine_orders (
          project_key, project_json, order_json, revision_at, revision_environment_id
        ) VALUES (
          ${scheduledTaskSharedProjectKey(order.project)},
          ${JSON.stringify(order.project)},
          ${JSON.stringify(order.order)},
          ${order.revision.at},
          ${order.revision.environmentId}
        )
        ON CONFLICT (project_key) DO UPDATE SET
          order_json = excluded.order_json,
          revision_at = excluded.revision_at,
          revision_environment_id = excluded.revision_environment_id
      `;

    const deleteLocalRows = (id: ScheduledTaskId) =>
      sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
        Effect.andThen(sql`DELETE FROM scheduled_task_sidebar WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_default_model WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_shared WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_one_machine_decision WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_occurrence_claims WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_catch_up WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_run_conditions WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_prompt_files WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_group WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_delegate_providers WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_live_run_limit WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_changed_by WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_task_runs WHERE task_id = ${id}`),
        Effect.andThen(sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if ((yield* storedRevisions(id)).shared !== null) {
              yield* writeDeletion(id, yield* stampRevision(id));
            }
            yield* deleteLocalRows(id);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    const markRunning = (input: {
      readonly id: ScheduledTaskId;
      readonly startedAtIso: string;
      readonly trigger: ScheduledTaskRunTrigger;
      readonly scheduledFor: string | null;
      readonly webhookDeliveryId: string | null;
    }) =>
      sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET updated_at = ${input.startedAtIso},
            last_run_at = ${input.startedAtIso},
            last_run_trigger = ${input.trigger},
            last_run_scheduled_for = ${input.scheduledFor},
            last_run_webhook_delivery_id = ${input.webhookDeliveryId},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${input.id}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: input.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: input.id }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
        RETURNING task_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Guarded like markCompleted, so a run cannot stamp a task recreated under its id.
    // Bookkeeping: failing it must not fail a run that already dispatched.
    const recordRunThread = (id: ScheduledTaskId, threadId: ThreadId, startedAtIso: string) =>
      sql`
        INSERT INTO scheduled_task_sidebar (task_id, last_run_thread_id)
        SELECT ${id}, ${threadId}
        WHERE EXISTS (
          SELECT 1 FROM scheduled_tasks
          WHERE task_id = ${id} AND last_run_status = 'running' AND last_run_at = ${startedAtIso}
        )
        ON CONFLICT (task_id) DO UPDATE SET last_run_thread_id = excluded.last_run_thread_id
      `.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not record schedule task run thread", { taskId: id, cause }),
        ),
      );

    // Run history is bookkeeping: failing to write it must not fail or block a run.
    const keepRunHistory = <E>(write: Effect.Effect<unknown, E>, taskId: ScheduledTaskId) =>
      write.pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("Could not record schedule task run history", { taskId, cause }),
        ),
      );

    // Only for a task that still exists, so a run finishing after a delete leaves no orphan.
    const writeRunRecord = (record: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly trigger: ScheduledTaskRunTrigger;
      readonly scheduledFor: string | null;
      readonly startedAt: string;
      readonly completedAt: string | null;
      readonly outcome: "running" | "skipped";
      readonly skipReason?: ScheduledTaskRunSkipReason;
      readonly ranOn?: EnvironmentId;
      readonly failover: ScheduledTaskRunFailover | null;
      readonly check?: ScheduledTaskRunCheck | undefined;
      readonly usageLimit?: ScheduledTaskRunUsageLimit | undefined;
    }) =>
      sql`
        INSERT INTO scheduled_task_runs (
          run_id, task_id, trigger, scheduled_for, started_at, completed_at, outcome,
          skip_reason, ran_on, failover_from, failover_to, failover_reason, failover_mcp_servers_json,
          check_json, usage_limit_json
        )
        SELECT ${record.id}, ${record.taskId}, ${record.trigger}, ${record.scheduledFor},
          ${record.startedAt}, ${record.completedAt}, ${record.outcome},
          ${record.skipReason ?? null}, ${record.ranOn ?? null},
          ${record.failover?.from ?? null}, ${record.failover?.to ?? null},
          ${record.failover?.reason ?? null},
          ${record.failover?.mcpServers === undefined ? null : encodeMcpServersJson(record.failover.mcpServers)},
          ${record.check === undefined ? null : JSON.stringify(record.check)},
          ${record.usageLimit === undefined ? null : encodeRunUsageLimitJson(record.usageLimit)}
        WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${record.taskId})
        ON CONFLICT (run_id) DO NOTHING
      `.pipe(
        Effect.andThen(sql`
          DELETE FROM scheduled_task_runs WHERE run_id IN (
            SELECT run_id FROM (
              SELECT run_id, outcome, started_at,
                skip_reason IN ${sql.in(QUIET_SKIP_REASONS)} AS quiet,
                ROW_NUMBER() OVER (
                  PARTITION BY CASE WHEN skip_reason IN ${sql.in(QUIET_SKIP_REASONS)}
                    THEN skip_reason ELSE '' END
                  ORDER BY started_at DESC, run_id DESC
                ) AS position
              FROM scheduled_task_runs WHERE task_id = ${record.taskId}
            )
            WHERE CASE WHEN quiet = 1
              THEN position > ${QUIET_SKIP_RETENTION}
              ELSE position > ${RUN_HISTORY_RETENTION}
                AND (outcome = 'skipped' OR started_at < ${runHistoryCutoff(record.startedAt)})
            END
          )
        `),
      );
    const insertRunRecord = (record: Parameters<typeof writeRunRecord>[0]) =>
      keepRunHistory(writeRunRecord(record), record.taskId);

    const finishRunRecord = (
      taskId: ScheduledTaskId,
      id: string,
      result: {
        readonly completedAt: string;
        readonly outcome: "succeeded" | "failed";
        readonly threadId: ThreadId | null;
        readonly error: string | null;
        readonly failover?: ScheduledTaskRunFailover | null;
      },
    ) =>
      keepRunHistory(
        sql`
          UPDATE scheduled_task_runs
          SET completed_at = ${result.completedAt},
              outcome = ${result.outcome},
              thread_id = ${result.threadId},
              error = ${result.error},
              failover_from = ${result.failover?.from ?? null},
              failover_to = ${result.failover?.to ?? null},
              failover_reason = ${result.failover?.reason ?? null},
              failover_mcp_servers_json = ${result.failover?.mcpServers === undefined ? null : encodeMcpServersJson(result.failover.mcpServers)}
          WHERE run_id = ${id} AND outcome = 'running'
        `,
        taskId,
      );

    // A failure between markRunning and markCompleted must still write a terminal record:
    // runDueTasks skips 'running' rows forever, and the dispatch may already have gone out,
    // so next_run_at must advance. Pending webhook attempts count only with their completion.
    const releaseStuckRun = Effect.fn("ScheduledTaskService.releaseStuckRun")(
      function* (
        task: ScheduledTask,
        startedAtIso: string,
        message: string,
        pendingDeliveryId?: string,
      ) {
        const now = yield* localNow;
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return;
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAfterRun({ ...source, lastRunAt: startedAtIso }, now)},
              updated_at = ${iso(now)},
              run_count = run_count + CASE WHEN EXISTS (
                SELECT 1 FROM scheduled_task_webhook_pending
                WHERE delivery_id = ${pendingDeliveryId ?? null} AND state = 'running'
              ) THEN 0 ELSE 1 END
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      },
      (effect, task, _startedAtIso, _message, _pendingDeliveryId) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not release stuck schedule task run", {
              taskId: task.id,
              cause,
            }),
          ),
        ),
    );

    // Settings decide the launch model, and a limited account can hand the launch to another.
    const launchSelectionFor = Effect.fn("ScheduledTaskService.launchSelectionFor")(function* (
      task: ScheduledTask,
    ) {
      const own: ModelSelection = launchModelSelection(yield* readSettings, task);
      const route = Option.isNone(accountRouting)
        ? { selection: own, failover: null }
        : yield* accountRouting.value.failoverLaunch({ selection: own, projectId: task.projectId });
      return {
        selection: route.selection,
        failover:
          route.failover === null
            ? null
            : {
                from: own.instanceId,
                to: route.selection.instanceId,
                ...route.failover,
              },
      };
    });

    const readPromptFile = Effect.fn("ScheduledTaskService.readPromptFile")(function* (
      projectId: ProjectId,
      path: string,
    ) {
      const unreadable = (detail: string) =>
        new PromptFileReader.PromptFileReadError({
          path,
          ref: null,
          detail,
          lostConnection: false,
        });
      const project = yield* projects
        .getById(projectId)
        .pipe(
          Effect.mapError((error) =>
            unreadable(`could not look up the task's project: ${error.message}`),
          ),
        );
      if (Option.isNone(project)) {
        return yield* unreadable("the task's project is not on this machine.");
      }
      return yield* promptFiles.read({ cwd: project.value.workspaceRoot, path });
    });

    // The stored text shows what the last run read. Only the task, project and file this read was
    // for keep it, and a read that started before the stored one never replaces it.
    const readRunPromptFile = Effect.fn("ScheduledTaskService.readRunPromptFile")(function* (
      task: ScheduledTask,
      path: string,
    ) {
      const readAt = iso(yield* localNow);
      const read = yield* readPromptFile(task.projectId, path);
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const recorded = yield* sql`
              UPDATE scheduled_task_prompt_files
              SET read_at = ${readAt}, ref = ${read.ref}, commit_sha = ${read.commit}
              WHERE task_id = ${task.id} AND path = ${path}
                AND (read_at IS NULL OR read_at <= ${readAt})
                AND EXISTS (
                  SELECT 1 FROM scheduled_tasks
                  WHERE task_id = ${task.id} AND created_at = ${task.createdAt}
                    AND project_id = ${task.projectId}
                )
              RETURNING task_id
            `;
            if (recorded.length > 0) {
              yield* sql`UPDATE scheduled_tasks SET prompt = ${read.text} WHERE task_id = ${task.id}`;
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record the prompt file's text.", { taskId: task.id, cause }),
          ),
        );
      return read;
    });

    // A scheduled run can start on a wake, before the network is back. It runs in the background
    // and holds the task's reservation, so its wait holds up no other task and cannot run it twice.
    const readScheduledPromptFile = (task: ScheduledTask, path: string) =>
      NetworkRecoveryWorker.retryAfterLostConnection(
        Effect.gen(function* () {
          const current = yield* findTask(task.id);
          if (current === null || !current.enabled || current.createdAt !== task.createdAt) {
            return yield* taskError(
              "The task was paused or deleted while its run waited for the network.",
              { taskId: task.id },
            );
          }
          return yield* readRunPromptFile(task, path).pipe(
            Effect.tapError((error) =>
              isLostPromptFileRead(error)
                ? Effect.logWarning("Scheduled task prompt file read lost its connection", {
                    taskId: task.id,
                    detail: error.detail,
                  })
                : Effect.void,
            ),
          );
        }),
        {
          isLostConnection: isLostPromptFileRead,
          giveUp: (error, why) =>
            new PromptFileReader.PromptFileReadError({
              path: error.path,
              ref: error.ref,
              detail: `${error.detail} ${why}`,
              lostConnection: true,
            }),
        },
      );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly dispatched: Ref.Ref<boolean>;
      },
      fire?: ScheduledFire,
    ) {
      // Read before reserving: nothing between the reservation and its release may fail.
      const startedAt = yield* localNow;
      const startedAtIso = iso(startedAt);
      const recordTrigger: ScheduledTaskRunTrigger =
        trigger === "scheduled" && fire?.catchUp === true ? "catch_up" : trigger;
      const runRecordId = `${task.id}:${DateTime.toEpochMillis(startedAt)}:${recordTrigger}`;
      const run = Effect.gen(function* () {
        // Re-read stale poll snapshots so deleted, paused or postponed tasks cannot fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return { task, threadId: null, dispatchFailed: false };
        }
        if (
          webhook !== undefined &&
          (yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId} AND state = 'completed'`.pipe(
            NodeSqliteClient.readOnly,
          )).length > 0
        )
          return {
            task: { ...active, lastRunStatus: "succeeded" as const },
            threadId: null,
            dispatchFailed: false,
          };
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return { task: active, threadId: null, dispatchFailed: false };
        }
        // Reject queued deliveries after pause, same-id recreation or trigger changes.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : webhookPolicyBlock !== undefined
                  ? webhookPolicyBlock
                  : !active.enabled
                    ? "The task was paused before this delivery ran."
                    : null;
          if (reason !== null) return yield* new WebhookDeliverySkipped({ reason });
        }

        const scheduledFor =
          trigger === "scheduled" ? (fire?.scheduledFor ?? active.nextRunAt) : null;
        const started = {
          id: active.id,
          startedAtIso,
          trigger: recordTrigger,
          scheduledFor,
          webhookDeliveryId: webhook?.deliveryId ?? null,
        };
        if (webhook === undefined) yield* markRunning(started);
        else
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* markRunning(started);
                // Recovery must distinguish this delivery from other windows waiting on the same task.
                yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'running' WHERE delivery_id = ${webhook.deliveryId}`;
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                taskError("Could not start webhook run.", { taskId: task.id, cause }),
              ),
            );

        yield* insertRunRecord({
          id: runRecordId,
          taskId: active.id,
          trigger: recordTrigger,
          scheduledFor,
          startedAt: startedAtIso,
          completedAt: null,
          outcome: "running",
          failover: null,
          check: fire?.check,
        });
        yield* notifyChanged;

        const fireKey =
          webhook === undefined
            ? `${active.id}:${DateTime.toEpochMillis(startedAt)}:${trigger}`
            : `${active.id}:webhook:${webhook.deliveryId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // A webhook prompt was rendered from the row when the request arrived. A prompt file is
        // read for each run, and a failed read fails the run: it never runs an earlier read's text.
        const prompt: Result.Result<
          string,
          PromptFileReader.PromptFileReadError | ScheduledTaskError
        > =
          webhook !== undefined
            ? Result.succeed(webhook.prompt)
            : active.promptFile == null
              ? Result.succeed(active.prompt)
              : yield* Effect.result(
                  (trigger === "scheduled"
                    ? readScheduledPromptFile(active, active.promptFile.path)
                    : readRunPromptFile(active, active.promptFile.path)
                  ).pipe(Effect.map((read) => read.text)),
                );

        // A bound thread can move to another project (No project to a project) while
        // this fires. Follow it; one move needs at most two retries. Same ids replay safely.
        const sendBound = (
          threadId: ThreadId,
          projectId: ProjectId,
          text: string,
          retries: number,
        ): ReturnType<typeof threadManagement.sendToThread> =>
          threadManagement
            .sendToThread({
              projectId,
              commandId,
              threadId,
              messageId,
              scheduledTaskId: active.id,
              text,
              attachments: [],
              mode: "queue",
              createdBy: active.createdBy,
              creationSource: active.creationSource,
            })
            .pipe(
              Effect.catchTags({
                ThreadManagementThreadNotFoundError: (error) =>
                  retries === 0
                    ? Effect.fail(error)
                    : threadManagement.getThreadShell(threadId).pipe(
                        Effect.orElseSucceed(() => null),
                        Effect.flatMap((shell) =>
                          shell === null || shell.projectId === projectId
                            ? Effect.fail(error)
                            : sendBound(threadId, shell.projectId, text, retries - 1),
                        ),
                      ),
              }),
            );

        const target =
          active.threadId === null
            ? { type: "launch" as const, ...(yield* launchSelectionFor(active)) }
            : { type: "bound" as const, threadId: ThreadId.make(active.threadId) };
        // Capture defects and interrupts too so dispatch failures still reach markCompleted.
        const result = Result.isFailure(prompt)
          ? Exit.fail(prompt.failure)
          : target.type === "launch"
            ? yield* Effect.exit(
                threadLaunch
                  .launch({
                    commandId,
                    projectId: active.projectId,
                    title: active.title,
                    modelSelection: target.selection,
                    runtimeMode: active.runtimeMode,
                    interactionMode: active.interactionMode,
                    workspaceStrategy: active.workspaceStrategy,
                    initialMessage: {
                      messageId,
                      scheduledTaskId: active.id,
                      text: prompt.success,
                      attachments: [],
                    },
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  })
                  .pipe(Effect.map((launched) => launched.threadId)),
              )
            : yield* Effect.exit(
                // The stored selection only seeds fresh threads. A bound run
                // follows the thread's current provider, so it passes none.
                sendBound(target.threadId, active.projectId, prompt.success, 2).pipe(
                  Effect.as(target.threadId),
                ),
              );

        const runSucceeded = result._tag === "Success";
        if (webhook !== undefined && runSucceeded) yield* Ref.set(webhook.dispatched, true);
        const completedAt = yield* localNow;
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded
          ? null
          : Result.isFailure(prompt)
            ? prompt.failure.message
            : errorMessage(result.cause);
        const threadId = runSucceeded ? result.value : null;
        // One transaction, so an edit cannot land between reading the schedule and
        // writing the next run computed from it. The origin is read first: it reads
        // files, and the transaction holds SQLite's writer lock.
        const origin = yield* readWebhookOrigin;
        const record = Effect.gen(function* () {
          const [row] = yield* getRows(task.id);
          const current = row === undefined ? null : yield* decodeRow(row, origin);
          const scheduleSource = current ?? task;
          const completed: ScheduledTask = {
            ...scheduleSource,
            updatedAt: iso(completedAt),
            lastRunAt: startedAtIso,
            // A manual run that starts before a one-time run must not use it up.
            nextRunAt: nextRunAt(
              scheduleSource,
              scheduleSource.schedule.type === "once" ? startedAt : completedAt,
            ),
            lastRunStatus,
            lastRunError,
            runCount: scheduleSource.runCount + 1,
            ...(threadId === null ? {} : { lastRunThreadId: threadId }),
          };
          if (current === null) return { recorded: completed, written: false };
          if (threadId !== null) yield* recordRunThread(task.id, threadId, startedAtIso);
          yield* finishRunRecord(task.id, runRecordId, {
            completedAt: completed.updatedAt,
            outcome: lastRunStatus,
            threadId,
            error: lastRunError,
            failover: target.type === "launch" && Result.isSuccess(prompt) ? target.failover : null,
          });
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          const completion = markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
          });
          let written = false;
          if (webhook === undefined) written = yield* completion;
          else {
            const pending =
              yield* sql`SELECT 1 FROM scheduled_task_webhook_pending WHERE delivery_id = ${webhook.deliveryId}`;
            if (pending.length === 0) written = yield* completion;
            else {
              const counted =
                yield* sql`UPDATE scheduled_task_webhook_pending SET state = ${runSucceeded ? "completed" : "failed"}
                WHERE delivery_id = ${webhook.deliveryId} AND state NOT IN ('completed', 'failed') RETURNING delivery_id`;
              if (counted.length > 0) written = yield* completion;
            }
          }
          // A row recreated mid-run is not this run's, so report what is stored.
          return { recorded: written ? completed : current, written };
        });
        const { recorded, written } = yield* sql
          .withTransaction(record)
          .pipe(
            Effect.mapError((cause) =>
              isScheduledTaskError(cause)
                ? cause
                : taskError(
                    webhook === undefined
                      ? "Could not record schedule task run."
                      : "Could not record webhook completion.",
                    { taskId: task.id, cause },
                  ),
            ),
          );
        if (written) yield* notifyChanged;
        // The stored row can belong to a replacement, so report this dispatch separately.
        return { task: recorded, threadId, dispatchFailed: !runSucceeded };
      }).pipe(
        Effect.onError((cause) =>
          releaseStuckRun(task, startedAtIso, errorMessage(cause), webhook?.deliveryId).pipe(
            Effect.andThen(
              localNow.pipe(
                Effect.flatMap((now) =>
                  finishRunRecord(task.id, runRecordId, {
                    completedAt: iso(now),
                    outcome: "failed",
                    threadId: null,
                    error: errorMessage(cause),
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      // Reserve and release as one bracket so an interrupt cannot leave the task marked busy.
      return yield* Effect.acquireUseRelease(
        Ref.modify(activeRuns, (active) => {
          if (active.has(task.id)) return [false, active] as const;
          const next = new Set(active);
          next.add(task.id);
          return [true, next] as const;
        }),
        (reserved) =>
          reserved
            ? run
            : trigger !== "scheduled"
              ? Effect.fail(taskError("Schedule task is already running.", { taskId: task.id }))
              : Effect.succeed({ task, threadId: null, dispatchFailed: false }),
        (reserved) =>
          reserved
            ? Ref.update(activeRuns, (active) => {
                const next = new Set(active);
                next.delete(task.id);
                return next;
              })
            : Effect.void,
      );
    });

    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
      missedAt: string | null,
      reason: "missed" | "next_run_sooner",
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: missedAt,
        rescheduledTo: next,
        reason,
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* insertRunRecord({
        id: `${task.id}:${missedAt ?? task.nextRunAt}:skipped`,
        taskId: task.id,
        trigger: "scheduled",
        scheduledFor: missedAt,
        startedAt: iso(now),
        completedAt: iso(now),
        outcome: "skipped",
        skipReason: reason,
        failover: null,
      });
      yield* notifyChanged;
    });

    // A check answers only for the occurrence it was started for, as it was read: a run, a pause,
    // a new time or another condition since then make the answer someone else's.
    const occurrenceUnmoved = (task: ScheduledTask) => sql`
      task_id = ${task.id} AND enabled = 1 AND last_run_status <> 'running'
        AND next_run_at = ${task.nextRunAt}
    `;
    const occurrenceAsChecked = (task: ScheduledTask, condition: RunConditionRow) => sql`
      ${occurrenceUnmoved(task)}
        AND EXISTS (
          SELECT 1 FROM scheduled_task_run_conditions
          WHERE task_id = ${task.id} AND command = ${condition.command}
            AND timeout_seconds = ${condition.timeout_seconds}
        )
    `;

    // Nothing ran, so the run columns stay. Other machines learn of the skip from its record,
    // so the schedule moves on only together with it, and only while `unmoved` still holds.
    const recordQuietSkip = Effect.fnUntraced(function* (
      task: ScheduledTask,
      fire: ScheduledFire,
      unmoved: ReturnType<typeof occurrenceUnmoved>,
      skip: {
        readonly reason: (typeof QUIET_SKIP_REASONS)[number];
        readonly next: string | null;
        readonly now: DateTime.DateTime;
        /** When judging the occurrence began, if before `now`. */
        readonly startedAt?: DateTime.DateTime;
        readonly ranOn?: EnvironmentId;
        readonly check?: ScheduledTaskRunCheck;
        readonly usageLimit?: ScheduledTaskRunUsageLimit;
      },
    ) {
      const { reason, next, now, startedAt = now, ...details } = skip;
      const scheduledFor = fire.scheduledFor ?? task.nextRunAt;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const moved = yield* sql`
            UPDATE scheduled_tasks SET next_run_at = ${next}, updated_at = ${iso(now)}
            WHERE ${unmoved}
            RETURNING task_id
          `;
          if (moved.length === 0) return false;
          yield* writeRunRecord({
            id: `${task.id}:${scheduledFor}:${reason}`,
            taskId: task.id,
            trigger: fire.catchUp ? "catch_up" : "scheduled",
            scheduledFor,
            startedAt: iso(startedAt),
            completedAt: iso(now),
            outcome: "skipped",
            skipReason: reason,
            failover: null,
            ...details,
          });
          return true;
        }),
      );
    });

    const recordNoWorkSkip = Effect.fn("ScheduledTaskService.recordNoWorkSkip")(function* (
      task: ScheduledTask,
      fire: ScheduledFire,
      condition: RunConditionRow,
      check: ScheduledTaskRunCheck,
      checkStartedAt: DateTime.DateTime,
    ) {
      const current = yield* findTask(task.id);
      if (current === null) return false;
      const now = yield* localNow;
      const skipped = yield* recordQuietSkip(task, fire, occurrenceAsChecked(task, condition), {
        reason: "no_work",
        next: nextRunAt(current, current.schedule.type === "once" ? checkStartedAt : now),
        now,
        startedAt: checkStartedAt,
        check,
      }).pipe(
        Effect.mapError((cause) =>
          taskError("Could not skip the schedule task run.", { taskId: task.id, cause }),
        ),
      );
      if (skipped) {
        yield* Effect.logInfo("Skipping a schedule task run its check found no work for", {
          taskId: task.id,
          scheduledFor: fire.scheduledFor ?? task.nextRunAt,
        });
      }
      return skipped;
    });

    /**
     * Skips an occurrence while every account it could start on, or every account of a delegate
     * provider it needs, is out of usage. Like a no-work skip, nothing ran, so the run columns
     * stay. A one-time task waits for the room instead, since its only occurrence would be lost.
     * A failed check never holds a run back.
     */
    const skippedForUsage = Effect.fn("ScheduledTaskService.skippedForUsage")(
      function* (task: ScheduledTask, fire: ScheduledFire) {
        if (Option.isNone(accountRouting)) return false;
        // Due rows come without the default model or delegate providers, so read the task afresh.
        const current = yield* findTask(task.id);
        if (current === null) return false;
        const delegates = current.delegateProviders ?? [];
        if (current.threadId !== null && delegates.length === 0) return false;
        const block = yield* accountRouting.value.scheduledRunBlock({
          selection:
            current.threadId === null ? launchModelSelection(yield* readSettings, current) : null,
          projectId: current.projectId,
          delegates,
        });
        if (block === null) return false;
        const now = yield* localNow;
        const skipped = yield* recordQuietSkip(task, fire, occurrenceUnmoved(task), {
          reason: "usage_limited",
          next: current.schedule.type === "once" ? block.until : nextRunAt(current, now),
          now,
          usageLimit: { driver: block.driver, until: block.until },
        });
        if (skipped) {
          yield* Effect.logInfo(
            "Skipping a schedule task run: every account it can use is out of usage",
            {
              taskId: task.id,
              scheduledFor: fire.scheduledFor ?? task.nextRunAt,
              driver: block.driver,
              until: block.until,
            },
          );
          yield* notifyChanged;
        }
        // A moved occurrence is someone else's now; the next poll judges it afresh.
        return true;
      },
      (effect, task) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check the accounts a schedule task run needs", {
              taskId: task.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ),
    );

    /**
     * The chats of the task's newest runs here that still work, delegated tasks included. Every
     * count reads them again, since an ended chat can resume; one that could not be read does not
     * count.
     */
    const liveRunThreads = Effect.fn("ScheduledTaskService.liveRunThreads")(function* (
      taskId: ScheduledTaskId,
    ) {
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM scheduled_task_runs
        WHERE task_id = ${taskId} AND thread_id IS NOT NULL
        GROUP BY thread_id
        ORDER BY MAX(started_at) DESC
        LIMIT ${LIVE_RUN_CHECK_LIMIT}
      `.pipe(NodeSqliteClient.readOnly);
      const working = yield* Effect.forEach(
        rows,
        ({ thread_id: threadId }) =>
          threadManagement
            .getThreadRecords(ThreadId.make(threadId), ["runs", "subagents", "providerThreads"])
            .pipe(
              Effect.flatMap((records) =>
                records.thread.deletedAt !== null
                  ? Effect.succeed(false)
                  : ThreadManagementService.threadStillWorking(threadManagement, records),
              ),
              // A rebuild drops a deleted chat's projection.
              Effect.catchIf(Orchestrator.isThreadNotFound, () => Effect.succeed(false)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not check whether a scheduled task run is working", {
                  taskId,
                  threadId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            ),
        { concurrency: 4 },
      );
      return rows.flatMap(({ thread_id: threadId }, index) => (working[index] ? [threadId] : []));
    });

    const liveRunLimitOf = Effect.fnUntraced(function* (taskId: ScheduledTaskId) {
      const [stored] = yield* sql<{ readonly max_live_runs: number }>`
        SELECT max_live_runs FROM scheduled_task_live_run_limit WHERE task_id = ${taskId}
      `.pipe(NodeSqliteClient.readOnly);
      return stored?.max_live_runs ?? DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS;
    });

    /** Thread-bound tasks queue behind their thread, and a one-time task keeps its only occurrence. */
    const limitsLiveRuns = (task: Pick<ScheduledTask, "threadId" | "schedule">) =>
      task.threadId === null && task.schedule.type !== "once" && task.schedule.type !== "webhook";

    /**
     * Skips an occurrence while as many of the task's runs as its limit allows still work: those
     * here, and for a one-machine task those `elsewhere` reports. A failed check never holds a run
     * back.
     */
    const skippedAtLiveRunLimit = Effect.fn("ScheduledTaskService.skippedAtLiveRunLimit")(
      function* (
        task: ScheduledTask,
        fire: ScheduledFire,
        elsewhere: SharedTaskPeerCheck.PeerCheckResult["liveRunsElsewhere"],
      ) {
        if (!limitsLiveRuns(task)) return false;
        // Due rows come without side tables, so the limit is read here.
        const limit = yield* liveRunLimitOf(task.id);
        const here = yield* liveRunThreads(task.id);
        const onPeers = elsewhere.reduce((sum, peer) => sum + peer.liveRuns, 0);
        if (here.length + onPeers < limit) return false;
        // Names a machine only when this one's own runs leave room.
        const ranOn = here.length >= limit ? undefined : elsewhere[0]?.environmentId;
        const now = yield* localNow;
        const skipped = yield* recordQuietSkip(task, fire, occurrenceUnmoved(task), {
          reason: "live_run_limit",
          next: nextRunAt(task, now),
          now,
          ...(ranOn === undefined ? {} : { ranOn }),
        });
        if (skipped) {
          yield* Effect.logInfo("Skipping a schedule task run: its live-run limit is reached", {
            taskId: task.id,
            scheduledFor: fire.scheduledFor ?? task.nextRunAt,
            limit,
            liveThreadIds: here,
            elsewhere,
          });
          yield* notifyChanged;
        }
        // A moved occurrence is someone else's now; the next poll judges it afresh.
        return true;
      },
      (effect, task) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check a schedule task's live-run limit", {
              taskId: task.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ),
    );

    const liveRuns: ScheduledTaskService["Service"]["liveRuns"] = (task) =>
      limitsLiveRuns(task)
        ? liveRunThreads(task.id).pipe(
            Effect.map((threads) => threads.length),
            Effect.mapError((cause) =>
              taskError("Could not count the task's live runs.", { taskId: task.id, cause }),
            ),
          )
        : Effect.succeed(null);

    /** "ran" when the answer started a chat, which tells lists itself. */
    const checkThenRun = Effect.fn("ScheduledTaskService.checkThenRun")(function* (
      task: ScheduledTask,
      fire: ScheduledFire,
      condition: RunConditionRow,
      checkStartedAt: DateTime.DateTime,
    ) {
      // The check runs where the project lives; it never gets a worktree of its own.
      const project = yield* projects.getById(task.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const check: ScheduledTaskRunCheck =
        project === undefined
          ? {
              outcome: "failed",
              failure: "not_started",
              exitCode: null,
              detail: "The task's project was not found on this machine.",
            }
          : yield* runConditionCheck.run({
              command: condition.command,
              timeoutSeconds: condition.timeout_seconds,
              cwd: project.workspaceRoot,
            });
      if (check.outcome === "skip") {
        if (yield* recordNoWorkSkip(task, fire, condition, check, checkStartedAt)) {
          return "skipped" as const;
        }
      } else {
        const unchanged = yield* sql`
          SELECT 1 FROM scheduled_tasks WHERE ${occurrenceAsChecked(task, condition)}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) =>
            taskError("Could not load schedule task.", { taskId: task.id, cause }),
          ),
        );
        if (unchanged.length > 0) {
          yield* runTask(task, "scheduled", undefined, { ...fire, check });
          return "ran" as const;
        }
      }
      // Once the check is off the list, the next poll judges the occurrence due then afresh.
      yield* Effect.logInfo("Dropping a run condition answer: its occurrence changed meanwhile", {
        taskId: task.id,
        scheduledFor: fire.scheduledFor ?? task.nextRunAt,
        outcome: check.outcome,
      });
      return "stale" as const;
    });

    /**
     * A scheduled occurrence: a task with a run condition runs it first, and a task with a prompt
     * file fetches it, both in the background, so a slow check or fetch holds up no other due
     * task. Run now and webhooks start their run directly.
     */
    const startScheduledRun = Effect.fn("ScheduledTaskService.startScheduledRun")(function* (
      task: ScheduledTask,
      fire: ScheduledFire,
    ) {
      // Due rows come without either, so look both up.
      const [condition] = yield* sql<RunConditionRow>`
        SELECT command, timeout_seconds FROM scheduled_task_run_conditions WHERE task_id = ${task.id}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          taskError("Could not read the task's run condition.", { taskId: task.id, cause }),
        ),
      );
      if (condition === undefined) {
        const run = runTask(task, "scheduled", undefined, fire).pipe(Effect.asVoid);
        const readsFile = yield* sql`
          SELECT 1 FROM scheduled_task_prompt_files WHERE task_id = ${task.id}
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.length > 0),
          Effect.mapError((cause) =>
            taskError("Could not read the task's prompt file.", { taskId: task.id, cause }),
          ),
        );
        if (!readsFile) return yield* run;
        const claimed = yield* Ref.modify(backgroundRuns, (runs) =>
          runs.has(task.id)
            ? ([false, runs] as const)
            : ([true, new Set(runs).add(task.id)] as const),
        );
        if (!claimed) return;
        yield* run.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
          ),
          Effect.ensuring(
            Ref.update(backgroundRuns, (runs) => {
              const next = new Set(runs);
              next.delete(task.id);
              return next;
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        return;
      }
      const checkStartedAt = yield* localNow;
      const claimed = yield* Ref.modify(runChecks, (checks) =>
        checks.has(task.id)
          ? ([false, checks] as const)
          : ([
              true,
              new Map(checks).set(task.id, {
                startedAt: iso(checkStartedAt),
                scheduledFor: fire.scheduledFor ?? task.nextRunAt,
              }),
            ] as const),
      );
      if (!claimed) return;
      yield* checkThenRun(task, fire, condition, checkStartedAt).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Scheduled task run condition failed", { taskId: task.id, cause }).pipe(
            Effect.as("failed" as const),
          ),
        ),
        Effect.ensuring(
          Ref.update(runChecks, (checks) => {
            const next = new Map(checks);
            next.delete(task.id);
            return next;
          }),
        ),
        // A started chat has told lists; anything else tells them once the check is off the list.
        Effect.flatMap((ended) => (ended === "ran" ? Effect.void : notifyChanged)),
        Effect.forkIn(serviceScope),
      );
    });

    const oneMachineWindowMs = (schedule: ScheduledTask["schedule"]) =>
      schedule.type === "interval"
        ? Math.min(schedule.everyMs / 2, ONE_MACHINE_WINDOW_CAP_MS)
        : ONE_MACHINE_WINDOW_CAP_MS;

    // Where this machine stands in the project's order. Every machine must count the same members,
    // so one missing from the stored order stores it with itself and its linked machines added,
    // in the order every machine derives alike; the change reaches the others like any order edit.
    const oneMachinePlan = Effect.fn("ScheduledTaskService.oneMachinePlan")(function* (
      sharing: ScheduledTaskSharing,
    ) {
      const key = scheduledTaskSharedProjectKey(sharing.project);
      const known = defaultScheduledTaskMachineOrder([
        hereEnvironmentId,
        ...(yield* peerCheck.linkedEnvironmentIds),
      ]);
      const { stored, order } = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<MachineOrderRow>`
            SELECT project_json, order_json, revision_at, revision_environment_id
            FROM scheduled_task_project_machine_orders WHERE project_key = ${key}
          `;
          const storedOrder =
            row === undefined
              ? []
              : (yield* decodeMachineOrderRow({
                  project: row.project_json,
                  order: row.order_json,
                  revision: { at: row.revision_at, environmentId: row.revision_environment_id },
                })).order;
          const order = [...storedOrder, ...known.filter((id) => !storedOrder.includes(id))];
          if (storedOrder.includes(hereEnvironmentId)) return { stored: storedOrder, order };
          yield* writeMachineOrder({
            project: sharing.project,
            order,
            revision: yield* stampOrderRevision(key),
          });
          return { stored: order, order };
        }),
      );
      const excluded = new Set<string>(sharing.excludedEnvironmentIds);
      const effective = order.filter((id) => !excluded.has(id));
      const index = effective.indexOf(hereEnvironmentId);
      return {
        order: effective,
        members: stored.filter((id) => !excluded.has(id)),
        rank: index === -1 ? effective.length : index,
      } satisfies OneMachinePlan;
    });

    // Undefined keeps the stored condition; null removes it.
    const writeRunCondition = (
      id: ScheduledTaskId,
      condition: ScheduledTaskRunCondition | null | undefined,
    ) =>
      condition === undefined
        ? Effect.void
        : condition === null
          ? sql`DELETE FROM scheduled_task_run_conditions WHERE task_id = ${id}`
          : sql`
              INSERT INTO scheduled_task_run_conditions (task_id, command, timeout_seconds)
              VALUES (${id}, ${condition.command}, ${condition.timeoutSeconds})
              ON CONFLICT (task_id) DO UPDATE SET
                command = excluded.command,
                timeout_seconds = excluded.timeout_seconds
            `;

    const writeCatchUp = (id: ScheduledTaskId, enabled: boolean | undefined) =>
      enabled === undefined
        ? Effect.void
        : sql`
            INSERT INTO scheduled_task_catch_up (task_id, enabled) VALUES (${id}, ${enabled ? 1 : 0})
            ON CONFLICT (task_id) DO UPDATE SET enabled = excluded.enabled
          `;

    const writeDelegateProviders = (
      id: ScheduledTaskId,
      drivers: ReadonlyArray<ProviderDriverKind> | undefined,
    ) =>
      drivers === undefined
        ? Effect.void
        : drivers.length === 0
          ? sql`DELETE FROM scheduled_task_delegate_providers WHERE task_id = ${id}`
          : sql`
              INSERT INTO scheduled_task_delegate_providers (task_id, providers_json)
              VALUES (${id}, ${encodeDelegateProvidersJson(drivers)})
              ON CONFLICT (task_id) DO UPDATE SET providers_json = excluded.providers_json
            `;

    const writeMaxLiveRuns = (id: ScheduledTaskId, limit: number | undefined) =>
      limit === undefined
        ? Effect.void
        : limit === DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS
          ? sql`DELETE FROM scheduled_task_live_run_limit WHERE task_id = ${id}`
          : sql`
              INSERT INTO scheduled_task_live_run_limit (task_id, max_live_runs)
              VALUES (${id}, ${limit})
              ON CONFLICT (task_id) DO UPDATE SET max_live_runs = excluded.max_live_runs
            `;

    /** "keep" keeps the last read while the path stays the same; null drops it. */
    const writePromptFile = (
      id: ScheduledTaskId,
      path: string | null,
      read: { readonly at: string; readonly ref: string; readonly commit: string } | "keep" | null,
    ) =>
      path === null
        ? sql`DELETE FROM scheduled_task_prompt_files WHERE task_id = ${id}`
        : read === "keep"
          ? sql`
              INSERT INTO scheduled_task_prompt_files (task_id, path) VALUES (${id}, ${path})
              ON CONFLICT (task_id) DO UPDATE SET
                read_at = CASE WHEN path = excluded.path THEN read_at END,
                ref = CASE WHEN path = excluded.path THEN ref END,
                commit_sha = CASE WHEN path = excluded.path THEN commit_sha END,
                path = excluded.path
            `
          : read === null
            ? sql`
                INSERT INTO scheduled_task_prompt_files (task_id, path) VALUES (${id}, ${path})
                ON CONFLICT (task_id) DO UPDATE SET
                  path = excluded.path, read_at = NULL, ref = NULL, commit_sha = NULL
              `
            : sql`
              INSERT INTO scheduled_task_prompt_files (task_id, path, read_at, ref, commit_sha)
              VALUES (${id}, ${path}, ${read.at}, ${read.ref}, ${read.commit})
              ON CONFLICT (task_id) DO UPDATE SET
                path = excluded.path,
                read_at = excluded.read_at,
                ref = excluded.ref,
                commit_sha = excluded.commit_sha
            `;

    // A run may have read the file since the task was loaded, so a write that keeps the read
    // takes the text it found in the same transaction.
    const storedPrompt = (id: ScheduledTaskId) =>
      sql<{
        readonly prompt: string;
      }>`SELECT prompt FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.prompt),
      );

    /** A label of undefined keeps the stored one, null removes the group with its mark. */
    const writeGroup = (
      id: ScheduledTaskId,
      label: string | null | undefined,
      mark: boolean | "keep",
    ) =>
      label === null
        ? sql`DELETE FROM scheduled_task_group WHERE task_id = ${id}`
        : label === undefined
          ? mark === "keep"
            ? Effect.void
            : sql`UPDATE scheduled_task_group SET paused_with_group = ${mark ? 1 : 0}
                  WHERE task_id = ${id}`
          : sql`
              INSERT INTO scheduled_task_group (task_id, label, paused_with_group)
              VALUES (${id}, ${label}, ${mark === true ? 1 : 0})
              ON CONFLICT (task_id) DO UPDATE SET
                label = excluded.label,
                paused_with_group = CASE WHEN ${mark === "keep" ? 1 : 0} = 1
                  THEN scheduled_task_group.paused_with_group
                  ELSE excluded.paused_with_group END
            `;

    const recordOneMachineDecision = (
      taskId: ScheduledTaskId,
      decision: ScheduledTaskOneMachineDecision,
    ) =>
      sql`
        INSERT INTO scheduled_task_one_machine_decision
          (task_id, decided_at, ran_on, unchecked_json, unconfirmed)
        VALUES (${taskId}, ${decision.at}, ${decision.ranOn},
          ${JSON.stringify(decision.unchecked)}, ${decision.unconfirmed === true ? 1 : 0})
        ON CONFLICT (task_id) DO UPDATE SET
          decided_at = excluded.decided_at,
          ran_on = excluded.ran_on,
          unchecked_json = excluded.unchecked_json,
          unconfirmed = excluded.unconfirmed
      `;

    // A takeover changes the holder's own copy first, so every other copy may trust it; the
    // holder's copy agrees only once this machine gave the occurrence up, or its run of it failed
    // after reaching a chat. Age never counts: a run still being claimed or started looks idle to
    // the machines watching it, and a run cut off while starting may have started its chat.
    const claimOccurrence: ScheduledTaskService["Service"]["claimOccurrence"] = Effect.fn(
      "ScheduledTaskService.claimOccurrence",
    )(function* (input) {
      const occurrenceMs = Date.parse(input.occurrence);
      if (!Number.isFinite(occurrenceMs)) {
        return yield* taskError("The occurrence is not a valid time.", { taskId: input.taskId });
      }
      const handingOn = input.holder !== input.by;
      if (handingOn && input.replaces !== input.by) {
        return yield* taskError("A machine may only claim a run for itself or hand on its own.", {
          taskId: input.taskId,
        });
      }
      const occurrence = iso(DateTime.makeUnsafe(occurrenceMs));
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const takenFromHere = input.replaces === hereEnvironmentId && input.by !== hereEnvironmentId;
      const agrees = !takenFromHere
        ? Effect.succeed(true)
        : sql<{ readonly gave_up: number; readonly failed_in_chat: number }>`
            SELECT
              EXISTS (
                SELECT 1 FROM scheduled_task_runs
                WHERE task_id = ${input.taskId} AND scheduled_for = ${occurrence}
                  AND outcome = 'skipped' AND skip_reason IN ('unconfirmed', 'ran_elsewhere')
              ) AS gave_up,
              COALESCE((
                SELECT scheduled_for = ${occurrence} AND thread_id IS NOT NULL
                FROM scheduled_task_runs
                WHERE task_id = ${input.taskId} AND outcome <> 'skipped'
                ORDER BY started_at DESC, run_id DESC LIMIT 1
              ), 0) AS failed_in_chat
          `.pipe(
            Effect.map(
              ([row]) =>
                row !== undefined &&
                (row.gave_up === 1 || (input.lastRunFailed === true && row.failed_in_chat === 1)),
            ),
          );
      const [row] = yield* sql
        .withTransaction(
          agrees.pipe(
            Effect.flatMap((agreed) =>
              handingOn
                ? sql`
                UPDATE scheduled_task_occurrence_claims
                SET holder_environment_id = ${input.holder}, claimed_at = ${iso(now)}
                WHERE task_id = ${input.taskId} AND occurrence_at = ${occurrence}
                  AND holder_environment_id = ${input.by}
              `
                : sql`
                INSERT INTO scheduled_task_occurrence_claims
                  (task_id, occurrence_at, holder_environment_id, claimed_at)
                VALUES (${input.taskId}, ${occurrence}, ${input.holder}, ${iso(now)})
                ON CONFLICT (task_id, occurrence_at) DO UPDATE SET
                  holder_environment_id = excluded.holder_environment_id,
                  claimed_at = excluded.claimed_at
                WHERE holder_environment_id <> excluded.holder_environment_id
                  AND holder_environment_id = ${input.replaces}
                  AND ${agreed ? 1 : 0} = 1
              `,
            ),
            Effect.andThen(sql`
              DELETE FROM scheduled_task_occurrence_claims
              WHERE claimed_at < ${iso(DateTime.makeUnsafe(nowMs - ONE_MACHINE_CLAIM_RETENTION_MS))}
            `),
            Effect.andThen(sql<{ readonly holder_environment_id: EnvironmentId }>`
              SELECT holder_environment_id FROM scheduled_task_occurrence_claims
              WHERE task_id = ${input.taskId} AND occurrence_at = ${occurrence}
            `),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record who holds the scheduled task run.", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
      if (row === undefined) {
        return yield* taskError(
          handingOn
            ? "This machine holds no claim on that run to hand on."
            : "That run is too old to claim.",
          { taskId: input.taskId },
        );
      }
      return row.holder_environment_id;
    });

    // Gives up this machine's own claim, so a machine that reaches a quorum may take it.
    const releaseOccurrence = (taskId: ScheduledTaskId, occurrence: string) =>
      sql`
        DELETE FROM scheduled_task_occurrence_claims
        WHERE task_id = ${taskId} AND occurrence_at = ${iso(DateTime.makeUnsafe(Date.parse(occurrence)))}
          AND holder_environment_id = ${hereEnvironmentId}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not release the scheduled task run.", { taskId, cause }),
        ),
      );

    // Claims an occurrence on this machine's copy and the members', taking it from `replaces` only
    // once that machine's own copy agreed. `holder` is this machine only with a quorum of copies;
    // otherwise the machine to watch, or null when it saw none. Without a quorum it hands what it
    // took to a holder ahead of it, never behind, so two machines never hand to each other.
    const claimOneMachineOccurrence = Effect.fn("ScheduledTaskService.claimOneMachineOccurrence")(
      function* (
        taskId: ScheduledTaskId,
        occurrence: string,
        plan: OneMachinePlan,
        replaces: EnvironmentId | null,
      ) {
        const here = hereEnvironmentId;
        const unchecked: Array<ScheduledTaskOneMachineDecision["unchecked"][number]> = [];
        const held = new Set<EnvironmentId>();
        const others: Array<EnvironmentId> = [];
        if (replaces !== null) {
          const consent = yield* peerCheck.claim({
            taskId,
            occurrence,
            holder: here,
            replaces,
            peers: [replaces],
          });
          unchecked.push(...consent.unchecked);
          const agreed = consent.answered[0]?.holder;
          if (agreed !== here) return { holder: agreed ?? replaces, unchecked };
          held.add(replaces);
        }
        const local = yield* claimOccurrence({
          taskId,
          occurrence,
          holder: here,
          replaces,
          by: here,
        });
        if (local === here) held.add(here);
        else others.push(local);
        const answer = yield* peerCheck.claim({
          taskId,
          occurrence,
          holder: here,
          replaces,
          peers: plan.members.filter((id) => id !== here && id !== replaces),
        });
        unchecked.push(...answer.unchecked);
        for (const peer of answer.answered) {
          if (peer.holder === here) held.add(peer.environmentId);
          else others.push(peer.holder);
        }
        if (holdsQuorum(plan.members, held)) return { holder: here, unchecked };
        const placeOf = (id: EnvironmentId) => {
          const index = plan.order.indexOf(id);
          return index === -1 ? plan.order.length : index;
        };
        const holder = others.toSorted((a, b) => placeOf(a) - placeOf(b))[0];
        if (holder === undefined) {
          yield* releaseOccurrence(taskId, occurrence);
          return { holder: null, unchecked };
        }
        if (placeOf(holder) < plan.rank) {
          if (held.has(here)) {
            yield* claimOccurrence({ taskId, occurrence, holder, replaces: here, by: here });
          }
          const gaveTo = [...held].filter((id) => id !== here);
          if (gaveTo.length > 0) {
            yield* peerCheck.claim({ taskId, occurrence, holder, replaces: here, peers: gaveTo });
          }
        }
        return { holder, unchecked };
      },
    );

    // One occurrence of a task that runs on one machine: wait for this machine's turn, then claim
    // it unless a machine ahead already has it. A machine runs it only with a quorum of the
    // members' claim copies, so machines that can't reach each other never both run it.
    const settleOneMachineOccurrence = Effect.fn("ScheduledTaskService.settleOneMachineOccurrence")(
      function* (
        task: ScheduledTask,
        sharing: ScheduledTaskSharing,
        now: DateTime.DateTime,
        catchUp: boolean,
      ) {
        const nowMs = DateTime.toEpochMillis(now);
        const dueMs = Date.parse(task.nextRunAt!);
        const deferral = (yield* Ref.get(oneMachineDeferrals)).get(task.id);
        const resumed = deferral !== undefined && deferral.deferredTo === task.nextRunAt;
        const catchingUp = resumed ? deferral.catchUp : catchUp;
        const windowMs = oneMachineWindowMs(task.schedule);
        const graceMs = Math.min(ONE_MACHINE_GRACE_CAP_MS, windowMs / 2);
        const plan = yield* oneMachinePlan(sharing);
        const shared = { ...task, shared: sharing };
        const occurrenceDueMs = resumed
          ? deferral.occurrenceDueMs
          : oneMachineOccurrenceMs(shared, DateTime.subtract(now, { milliseconds: nowMs - dueMs }));
        // Come back to this occurrence at `atMs` and ask again.
        const deferTo = Effect.fnUntraced(function* (
          atMs: number,
          watching: OneMachineWatch | null,
          decision: ScheduledTaskOneMachineDecision | null,
        ) {
          const deferredTo = iso(DateTime.makeUnsafe(atMs));
          yield* sql`
            UPDATE scheduled_tasks SET next_run_at = ${deferredTo}, updated_at = ${iso(now)}
            WHERE task_id = ${task.id} AND next_run_at = ${task.nextRunAt}
          `.pipe(
            Effect.andThen(
              decision === null ? Effect.void : recordOneMachineDecision(task.id, decision),
            ),
            Effect.mapError((cause) =>
              taskError("Could not defer the schedule task run.", { taskId: task.id, cause }),
            ),
          );
          yield* Ref.update(oneMachineDeferrals, (current) =>
            new Map(current).set(task.id, {
              occurrenceDueMs,
              deferredTo,
              catchUp: catchingUp,
              watching,
            }),
          );
          yield* notifyChanged;
        });
        if (!resumed && plan.rank > 0) {
          // Machines ahead may be catching up too, so a catch-up waits its turn from now.
          return yield* deferTo((catchUp ? nowMs : dueMs) + plan.rank * graceMs, null, null);
        }
        // In the local zone of `now`, so a fixed time's next run keeps its local hour.
        const occurrenceDue = DateTime.subtract(now, { milliseconds: nowMs - occurrenceDueMs });
        const occurrence = iso(occurrenceDue);
        // How claims and peers name it.
        const slot = occurrenceSlot(task.schedule, occurrenceDue);
        const following = nextRunAt(shared, occurrenceDue);
        // Watching a run ends when the next occurrence is due, which is judged on its own.
        const watchUntilMs =
          following === null ? occurrenceDueMs + ONE_MACHINE_WINDOW_CAP_MS : Date.parse(following);
        const watched = resumed ? deferral.watching : null;
        yield* Ref.update(oneMachineDeferrals, (current) => {
          const next = new Map(current);
          next.delete(task.id);
          return next;
        });
        // `ranOn` null: no other machine confirmed the occurrence was free, so it went to none.
        const skipOccurrence = Effect.fnUntraced(function* (
          ranOn: EnvironmentId | null,
          next: string | null,
          decision: ScheduledTaskOneMachineDecision | null,
          noWork: SharedTaskPeerCheck.PeerCheckResult["noWork"] = null,
        ) {
          yield* sql
            .withTransaction(
              sql`
                UPDATE scheduled_tasks SET next_run_at = ${next}, updated_at = ${iso(now)}
                WHERE task_id = ${task.id} AND next_run_at = ${task.nextRunAt}
              `.pipe(
                Effect.andThen(
                  decision === null ? Effect.void : recordOneMachineDecision(task.id, decision),
                ),
              ),
            )
            .pipe(
              Effect.mapError((cause) =>
                taskError("Could not skip the schedule task run.", { taskId: task.id, cause }),
              ),
            );
          yield* ranOn === null
            ? Effect.logWarning(
                "Skipping a one-machine task run no other machine confirmed was free",
                { taskId: task.id },
              )
            : Effect.logInfo("Skipping a one-machine task run another machine has", {
                taskId: task.id,
                ranOn,
              });
          yield* insertRunRecord({
            id: `${task.id}:${occurrence}:skipped`,
            taskId: task.id,
            trigger: catchingUp ? "catch_up" : "scheduled",
            scheduledFor: occurrence,
            startedAt: iso(now),
            completedAt: iso(now),
            outcome: "skipped",
            ...(ranOn === null
              ? { skipReason: "unconfirmed" }
              : { skipReason: "ran_elsewhere", ranOn }),
            failover: null,
            // That machine's own check found no work, so the occurrence ran nowhere.
            ...(noWork === null
              ? {}
              : {
                  check: {
                    outcome: "skip",
                    failure: null,
                    exitCode: null,
                    detail: noWork.reason,
                  },
                }),
          });
          yield* notifyChanged;
        });
        // Still going when the next one is due: leave it to that machine and judge the next one now.
        if (watched !== null && nowMs >= watchUntilMs) {
          return yield* skipOccurrence(watched.environmentId, following, null);
        }
        const next =
          following !== null && Date.parse(following) <= nowMs ? nextRunAt(shared, now) : following;
        const logUnchecked = (unchecked: ScheduledTaskOneMachineDecision["unchecked"]) =>
          Effect.forEach(
            unchecked,
            (peer) =>
              Effect.logWarning("Could not ask a machine about a one-machine task", {
                taskId: task.id,
                environmentId: peer.environmentId,
                reason: peer.reason,
              }),
            { discard: true },
          );
        const watch = (holder: OneMachineWatch, decision: ScheduledTaskOneMachineDecision) =>
          deferTo(Math.min(nowMs + graceMs, watchUntilMs), holder, decision);
        // Claims the occurrence, taking it from `replaces`, and runs it only when this machine may.
        const takeOccurrence = Effect.fnUntraced(function* (
          replaces: EnvironmentId | null,
          liveRunsElsewhere: SharedTaskPeerCheck.PeerCheckResult["liveRunsElsewhere"],
        ) {
          const fire = { scheduledFor: occurrence, catchUp: catchingUp };
          // The limit counts the task's runs that still work on every machine.
          // With its sharing, so the skip lands on the slot every copy runs.
          if (yield* skippedAtLiveRunLimit(shared, fire, liveRunsElsewhere)) return;
          // A machine that could not start it claims nothing, so the next machine may run it.
          if (yield* skippedForUsage(task, fire)) return;
          const claim = yield* claimOneMachineOccurrence(task.id, slot, plan, replaces);
          yield* logUnchecked(claim.unchecked);
          if (claim.holder !== null && claim.holder !== hereEnvironmentId) {
            // A machine already judged ended needs no second wait for the machines before this one.
            return yield* watch(
              { environmentId: claim.holder, ended: claim.holder === replaces },
              { at: iso(now), ranOn: claim.holder, unchecked: claim.unchecked },
            );
          }
          const decision: ScheduledTaskOneMachineDecision = {
            at: iso(now),
            ranOn: null,
            unchecked: claim.unchecked,
          };
          if (claim.holder === null) {
            return yield* skipOccurrence(null, next, { ...decision, unconfirmed: true });
          }
          yield* recordOneMachineDecision(task.id, decision).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not record the one-machine decision", {
                taskId: task.id,
                cause,
              }),
            ),
          );
          return yield* startScheduledRun(task, fire);
        });
        const since = iso(DateTime.makeUnsafe(occurrenceDueMs - windowMs));
        if (watched === null) {
          // Also finds a run a machine started outside the claims, such as one on an older version.
          const answer = yield* peerCheck.check({
            taskId: task.id,
            peers: plan.order.filter((id) => id !== hereEnvironmentId),
            since,
            occurrence: slot,
          });
          yield* logUnchecked(answer.unchecked);
          const decision = { at: iso(now), ranOn: answer.ranOn, unchecked: answer.unchecked };
          if (answer.ranOn === null) return yield* takeOccurrence(null, answer.liveRunsElsewhere);
          return answer.working
            ? yield* watch({ environmentId: answer.ranOn, ended: false }, decision)
            : yield* skipOccurrence(answer.ranOn, next, decision, answer.noWork);
        }
        const answer = yield* peerCheck.check({
          taskId: task.id,
          peers: [watched.environmentId],
          since,
          occurrence: slot,
        });
        yield* logUnchecked(answer.unchecked);
        const decision = {
          at: iso(now),
          ranOn: watched.environmentId,
          unchecked: answer.unchecked,
        };
        if (answer.ranOn !== null) {
          // A run still going may yet fail or stop, so keep asking until it ends.
          return answer.working
            ? yield* watch({ environmentId: answer.ranOn, ended: false }, decision)
            : yield* skipOccurrence(answer.ranOn, next, decision, answer.noWork);
        }
        // Silence is not an ended run: a busy machine misses calls, and taking over then runs
        // the occurrence twice.
        if (answer.unchecked.length > 0) return yield* watch(watched, decision);
        // The machines between the one whose run ended and this one were watching it too. The
        // nearest takes over at once; each one after it waits its place and asks again, still
        // giving the occurrence up when the next one is due.
        if (!watched.ended) {
          const watchedAt = plan.order.indexOf(watched.environmentId);
          const between = plan.rank - watchedAt - 1;
          if (watchedAt !== -1 && between > 0) {
            return yield* deferTo(
              Math.min(nowMs + between * graceMs, watchUntilMs),
              { ...watched, ended: true },
              decision,
            );
          }
        }
        return yield* takeOccurrence(watched.environmentId, answer.liveRunsElsewhere);
      },
    );

    // Due rows come without sharing, so look it up only for tasks that are shared to run on one machine.
    const runDueOccurrence = Effect.fn("ScheduledTaskService.runDueOccurrence")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
      catchUp = false,
    ) {
      const [runOn] = yield* sql<{ run_on: string }>`
        SELECT run_on FROM scheduled_task_shared WHERE task_id = ${task.id}
      `.pipe(NodeSqliteClient.readOnly);
      const sharing = runOn?.run_on === "one" ? (yield* findTask(task.id))?.shared : null;
      if (sharing != null) return yield* settleOneMachineOccurrence(task, sharing, now, catchUp);
      const fire = { scheduledFor: task.nextRunAt, catchUp };
      if (yield* skippedAtLiveRunLimit(task, fire, [])) return;
      if (yield* skippedForUsage(task, fire)) return;
      return yield* startScheduledRun(task, fire);
    });

    // A fixed-time run the server reached too late, because the app was off or the machine asleep.
    const settleMissedRun = Effect.fn("ScheduledTaskService.settleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      // Due rows come without the choice; a missed run is rare enough to look it up.
      const [stored] = yield* sql<{ readonly enabled: number }>`
        SELECT enabled FROM scheduled_task_catch_up WHERE task_id = ${task.id}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          taskError("Could not read the task's catch-up choice.", { taskId: task.id, cause }),
        ),
      );
      const catchUp =
        stored === undefined ? defaultCatchUpMissedRun(task.schedule) : stored.enabled === 1;
      const deferral = (yield* Ref.get(oneMachineDeferrals)).get(task.id);
      // A one-machine run that waited its turn and was then reached late keeps its occurrence.
      if (catchUp && deferral !== undefined && deferral.deferredTo === task.nextRunAt) {
        return yield* runDueOccurrence(task, now, deferral.catchUp);
      }
      const missed = latestMissedFixedTimeRun(task.schedule, now);
      const missedAt = missed === null ? task.nextRunAt : iso(missed.at);
      if (!catchUp || missed === null || !missed.catchUp) {
        return yield* rescheduleMissedRun(
          task,
          now,
          missedAt,
          catchUp ? "next_run_sooner" : "missed",
        );
      }
      // Several missed times run once, for the latest; the one-machine check judges that one.
      const pointed = yield* sql`
        UPDATE scheduled_tasks SET next_run_at = ${missedAt}, updated_at = ${iso(now)}
        WHERE task_id = ${task.id} AND next_run_at = ${task.nextRunAt}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not catch up the missed schedule task run.", {
            taskId: task.id,
            cause,
          }),
        ),
      );
      if (pointed.length === 0) return;
      yield* Effect.logInfo("Catching up a missed schedule task run", {
        taskId: task.id,
        missedRunAt: missedAt,
      });
      yield* runDueOccurrence({ ...task, nextRunAt: missedAt }, now, true);
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const nowMs = DateTime.toEpochMillis(now);
      if (yield* dueTasks.isIdle(nowMs)) return;
      const readVersion = yield* dueTasks.version;
      const [next] = yield* sql<{ next_run_at: string | null }>`
        SELECT MIN(next_run_at) AS next_run_at FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND last_run_status <> 'running'
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      // Compare as text like listDueTasks: expanded years (`+011533-…`) sort first but parse far ahead.
      const nextRunAt = next?.next_run_at ?? null;
      if (nextRunAt === null || nextRunAt > iso(now)) {
        const nextDueAt =
          nextRunAt === null
            ? Option.some(Infinity)
            : DateTime.make(nextRunAt).pipe(Option.map(DateTime.toEpochMillis));
        if (Option.isSome(nextDueAt) && nextDueAt.value > nowMs) {
          yield* dueTasks.record(readVersion, nextDueAt.value, nowMs);
        }
        return;
      }
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      // A task whose check or background run is going has this occurrence in hand already.
      const checking = yield* Ref.get(runChecks);
      const inBackground = yield* Ref.get(backgroundRuns);
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null || checking.has(task.id) || inBackground.has(task.id)
          ? []
          : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          Effect.suspend(() =>
            isMissedFixedTimeRun(task.schedule, dueAt, now)
              ? settleMissedRun(task, now)
              : runDueOccurrence(task, now),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Nothing runs before startup finishes, so a run record still running was cut off.
    yield* localNow.pipe(
      Effect.flatMap(
        (now) => sql`
          UPDATE scheduled_task_runs
          SET outcome = 'failed',
              error = 'Run was interrupted by a server restart.',
              completed_at = ${iso(now)}
          WHERE outcome = 'running'
        `,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not close interrupted schedule task run records", { cause }),
      ),
    );

    // Recover crash-left running rows that the due-task filter would otherwise skip forever.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAfterRun(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + CASE WHEN EXISTS (
                      SELECT 1 FROM scheduled_task_webhook_pending
                      WHERE task_id IS ${row.task_id} AND state = 'running'
                        AND delivery_id = scheduled_tasks.last_run_webhook_delivery_id
                    ) THEN 0 ELSE 1 END
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + CASE WHEN EXISTS (
                    SELECT 1 FROM scheduled_task_webhook_pending
                    WHERE task_id IS ${row.task_id} AND state = 'running'
                        AND delivery_id = scheduled_tasks.last_run_webhook_delivery_id
                  ) THEN 0 ELSE 1 END
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const readSharedDeletions = sql<SharedRevisionRow & { readonly task_id: string }>`
      SELECT task_id, revision_at, revision_environment_id
      FROM scheduled_task_shared_deletions ORDER BY task_id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) =>
        rows.map((row) => ({ id: ScheduledTaskId.make(row.task_id), revision: toRevision(row)! })),
      ),
    );

    const readMachineOrders = sql<MachineOrderRow>`
      SELECT project_json, order_json, revision_at, revision_environment_id
      FROM scheduled_task_project_machine_orders ORDER BY project_key ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeMachineOrderRow({
            project: row.project_json,
            order: row.order_json,
            revision: { at: row.revision_at, environmentId: row.revision_environment_id },
          }),
        ),
      ),
    );

    const list: ScheduledTaskService["Service"]["list"] = (options) =>
      Effect.all({
        tasks: listRows(options?.resolveModels),
        sharedDeletions: readSharedDeletions,
        peerLinks: peerCheck.linkStatus,
        projectMachineOrders: readMachineOrders,
      }).pipe(Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })));

    const sharedCopies: ScheduledTaskService["Service"]["sharedCopies"] = Effect.fn(
      "ScheduledTaskService.sharedCopies",
    )(
      function* (forEnvironmentId, { recordPuller }) {
        if (recordPuller && forEnvironmentId !== hereEnvironmentId) {
          const now = yield* DateTime.now;
          const pulledAt = DateTime.formatIso(now);
          yield* sql`
            INSERT INTO scheduled_task_shared_pullers (environment_id, pulled_at)
            VALUES (${forEnvironmentId}, ${pulledAt})
            ON CONFLICT (environment_id) DO UPDATE SET pulled_at = excluded.pulled_at
          `;
          yield* sql`
            DELETE FROM scheduled_task_shared_pullers
            WHERE pulled_at < ${sharedPullerCutoff(now)}
          `;
        }
        const rows = yield* selectAllRows();
        // Stored model, not the default shown here: the copy is this task's own definition.
        const tasks = yield* Effect.forEach(
          rows.filter((row) => row.shared_revision_at != null),
          (row) => decodeRow(row),
        );
        const copies = tasks.flatMap((task) =>
          task.shared == null ||
          task.schedule.type === "webhook" ||
          task.shared.excludedEnvironmentIds.includes(forEnvironmentId)
            ? []
            : [
                {
                  id: task.id,
                  title: task.title,
                  prompt: task.prompt,
                  enabled: task.enabled,
                  schedule: task.schedule,
                  workspaceStrategy: task.workspaceStrategy,
                  modelSelection: task.modelSelection,
                  followsDefaultModel: task.followsDefaultModel ?? false,
                  ...(task.catchUpMissedRun === undefined
                    ? {}
                    : { catchUpMissedRun: task.catchUpMissedRun }),
                  runCondition: task.runCondition ?? null,
                  promptFile: task.promptFile?.path ?? null,
                  ...(task.delegateProviders === undefined
                    ? {}
                    : { delegateProviders: task.delegateProviders }),
                  ...(task.maxLiveRuns === undefined ? {} : { maxLiveRuns: task.maxLiveRuns }),
                  runtimeMode: task.runtimeMode,
                  interactionMode: task.interactionMode,
                  createdBy: task.createdBy,
                  creationSource: task.creationSource,
                  createdAt: task.createdAt,
                  shared: task.shared,
                  group: task.group ?? null,
                  pausedWithGroup: task.pausedWithGroup === true,
                  changedBy: task.changedBy ?? null,
                },
              ],
        );
        const projectKeys = new Set(
          copies.map((copy) => scheduledTaskSharedProjectKey(copy.shared.project)),
        );
        return {
          tasks: copies,
          deletions: yield* readSharedDeletions,
          projectMachineOrders: (yield* readMachineOrders).filter((order) =>
            projectKeys.has(scheduledTaskSharedProjectKey(order.project)),
          ),
        };
      },
      Effect.mapError((cause) => taskError("Could not read the shared schedule tasks.", { cause })),
    );

    const knownMachineIds: ScheduledTaskService["Service"]["knownMachineIds"] = Effect.fn(
      "ScheduledTaskService.knownMachineIds",
    )(function* (projectId) {
      const key = scheduledTaskSharedProjectKey(yield* sharedProjectOf(projectId));
      const known = yield* Effect.gen(function* () {
        const [stored] = yield* sql<MachineOrderRow>`
          SELECT project_json, order_json, revision_at, revision_environment_id
          FROM scheduled_task_project_machine_orders
          WHERE project_key = ${key}
        `.pipe(NodeSqliteClient.readOnly);
        const ordered =
          stored === undefined
            ? []
            : (yield* decodeMachineOrderRow({
                project: stored.project_json,
                order: stored.order_json,
                revision: { at: stored.revision_at, environmentId: stored.revision_environment_id },
              })).order;
        const cutoff = sharedPullerCutoff(yield* DateTime.now);
        const pullers = yield* sql<{ readonly environment_id: string }>`
          SELECT environment_id FROM scheduled_task_shared_pullers
          WHERE pulled_at >= ${cutoff}
          ORDER BY environment_id ASC
        `.pipe(NodeSqliteClient.readOnly);
        return [...ordered, ...pullers.map((row) => EnvironmentId.make(row.environment_id))];
      }).pipe(
        Effect.mapError((cause) =>
          taskError("Could not read the machines shared tasks reach.", { cause }),
        ),
      );
      return [...new Set(known)].filter((id) => id !== hereEnvironmentId);
    });

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    // Resolved fresh: a project's own identity is a cache that reads blank when cold.
    const sharedProjectOf = Effect.fn("ScheduledTaskService.sharedProjectOf")(function* (
      projectId: ProjectId,
      taskId?: ScheduledTaskId,
    ) {
      if (yield* managedFolders.isScratchProject(projectId)) {
        return { type: "none" } as const satisfies ScheduledTaskSharing["project"];
      }
      const project = yield* projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) =>
          taskError("Could not load the task's project.", { taskId, cause }),
        ),
      );
      const identity =
        project === undefined ? null : yield* repositoryIdentities.resolve(project.workspaceRoot);
      if (project === undefined || identity === null) {
        return yield* taskError(
          "To share a task, pick No project or a project with a git remote, so each machine can find its copy.",
          { taskId },
        );
      }
      return {
        type: "repository",
        canonicalKey: identity.canonicalKey,
        title: project.title,
      } as const satisfies ScheduledTaskSharing["project"];
    });

    const localProjectFor = Effect.fn("ScheduledTaskService.localProjectFor")(function* (
      project: ScheduledTaskSharing["project"],
      taskId: ScheduledTaskId,
    ) {
      if (project.type === "none") {
        const scratch = yield* managedFolders.ensureScratchProject.pipe(
          Effect.mapError((cause) =>
            taskError("Could not prepare the No project folder.", { taskId, cause }),
          ),
        );
        return scratch.projectId;
      }
      const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: Effect.Success<ReturnType<typeof projects.listPage>> = yield* projects
          .listPage({ cursor, limit: 100 })
          .pipe(
            Effect.mapError((cause) =>
              taskError("Could not list this machine's projects.", { taskId, cause }),
            ),
          );
        for (const candidate of page.projects) {
          const identity = yield* repositoryIdentities.resolve(candidate.workspaceRoot);
          if (identity?.canonicalKey === project.canonicalKey) matches.push(candidate);
        }
        cursor = page.nextCursor;
      }
      if (matches.length === 1) return matches[0]!.id;
      return yield* taskError(
        matches.length === 0
          ? `No project on this machine has the repository ${project.title} (${project.canonicalKey}). Add it here, or leave this machine out of the task.`
          : `Several projects on this machine have the repository ${project.title} (${project.canonicalKey}): ${matches.map((match) => `${match.title} (${match.id})`).join(", ")}. Keep one, or leave this machine out of the task.`,
        { taskId },
      );
    });

    // Placement is this machine's own choice, so it never bumps a shared task's revision.
    const writePlacement = (
      ids: ReadonlyArray<ScheduledTaskId>,
      placement: ScheduledTaskPlacement,
      now: DateTime.DateTime,
    ) =>
      sql<{ task_id: ScheduledTaskId }>`
        INSERT INTO scheduled_task_sidebar (task_id, placement, pinned_at)
        SELECT t.task_id, ${placement}, ${placement === "pinned" ? iso(now) : null}
        FROM scheduled_tasks t
        LEFT JOIN scheduled_task_sidebar s ON s.task_id = t.task_id
        WHERE t.task_id IN ${sql.in(ids)} AND COALESCE(s.placement, 'chat') != ${placement}
        ON CONFLICT (task_id) DO UPDATE SET
          placement = excluded.placement,
          pinned_at = excluded.pinned_at,
          pin_order_key = NULL
        RETURNING task_id
      `;

    const hasTask = (id: ScheduledTaskId) =>
      sql`SELECT 1 AS found FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = Effect.fn(
      "ScheduledTaskService.upsert",
    )(function* (input, by) {
      // A webhook task the policy blocks can still be edited while it is off.
      if (input.enabled && input.schedule.type === "webhook" && webhookPolicyBlock !== undefined) {
        return yield* taskError(
          webhookPolicyBlock,
          input.id === undefined ? {} : { taskId: input.id },
        );
      }
      // Refused on save rather than at run time; a disabled task can still be saved, so one
      // stored above the ceiling can be turned off before its mode is lowered. A task bound to a
      // thread runs in that thread's mode, which the orchestrator checks instead.
      const modeDenial =
        input.enabled && input.threadId == null
          ? managedRuntimeModeDenial(managedPolicy.summary, input.runtimeMode)
          : undefined;
      if (modeDenial !== undefined) {
        return yield* taskError(modeDenial, input.id === undefined ? {} : { taskId: input.id });
      }
      if (input.runCondition != null) {
        const refusal =
          input.schedule.type === "webhook"
            ? "A webhook task runs on each request, so it can't have a check."
            : (RunConditionCheck.runConditionCommandProblem(input.runCondition.command) ??
              managedRuntimeModeDenial(managedPolicy.summary, "full-access"));
        if (refusal !== undefined) {
          return yield* taskError(refusal, input.id === undefined ? {} : { taskId: input.id });
        }
      }
      // A webhook task never runs a check, so saving one as webhook drops the stored one.
      const runCondition: ScheduledTaskRunCondition | null | undefined =
        input.schedule.type === "webhook"
          ? null
          : input.runCondition == null
            ? input.runCondition
            : {
                command: input.runCondition.command,
                timeoutSeconds:
                  input.runCondition.timeoutSeconds ?? DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
              };
      const now = yield* localNow;
      const uuid =
        input.commandId === undefined
          ? yield* crypto
              .randomUUIDv4()
              .pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
          : null;
      const id =
        input.id ??
        ScheduledTaskId.make(
          input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
        );
      // Look up by the *resolved* id so idempotent creates (commandId replays)
      // keep their run history, and so real load failures propagate instead
      // of silently resetting an existing row.
      const existingTask = yield* findTask(id);
      // Omitted keeps the stored choice, so a client that predates sharing can re-save a task.
      const sharedExclusions =
        input.shared === undefined
          ? existingTask?.shared?.excludedEnvironmentIds
          : input.shared?.excludedEnvironmentIds;
      if (sharedExclusions !== undefined) {
        if (input.threadId != null) {
          return yield* taskError(
            "A shared task starts a new thread on each machine, so it can't post to one thread.",
            { taskId: id },
          );
        }
        if (input.schedule.type === "webhook") {
          return yield* taskError(
            "A shared task can't use a webhook: each machine has its own webhook address.",
            { taskId: id },
          );
        }
      }
      const sharedProject =
        sharedExclusions === undefined ? null : yield* sharedProjectOf(input.projectId, id);
      // Omitted keeps the stored choice.
      const sharedRunOn = input.shared?.runOn ?? existingTask?.shared?.runOn;
      const machineOrder = input.shared?.machineOrder;
      // Omitted keeps the stored file, so a client that predates prompt files can re-save a task.
      const promptFilePath =
        input.promptFile === undefined
          ? (existingTask?.promptFile?.path ?? null)
          : input.promptFile;
      if (promptFilePath !== null && input.schedule.type === "webhook") {
        return yield* taskError(
          "A webhook task fills its prompt from each request, so it can't read it from a file.",
          { taskId: id },
        );
      }
      // A new or moved file is read now, so a wrong path is refused here rather than at a run.
      const promptFileKept =
        existingTask?.promptFile != null &&
        existingTask.promptFile.path === promptFilePath &&
        existingTask.promptFile.lastRead !== null &&
        existingTask.projectId === input.projectId;
      const promptRead =
        promptFilePath === null || promptFileKept
          ? null
          : yield* readPromptFile(input.projectId, promptFilePath).pipe(
              Effect.mapError((error) => taskError(error.message, { taskId: id })),
            );
      const prompt =
        promptFilePath === null ? input.prompt : (promptRead?.text ?? existingTask?.prompt);
      if (prompt === undefined) {
        return yield* taskError("A task needs a prompt, or a prompt file to read it from.", {
          taskId: id,
        });
      }
      // Keep the existing next_run_at when the schedule itself is untouched:
      // editing a title or prompt must not postpone (or resurrect) a due
      // run — only schedule/enabled changes restart the clock.
      const schedule: ScheduledTask["schedule"] =
        input.schedule.type === "webhook"
          ? {
              type: "webhook",
              signature:
                input.schedule.signature == null
                  ? null
                  : {
                      header: input.schedule.signature.header.toLowerCase(),
                      encoding: input.schedule.signature.encoding,
                      prefix: input.schedule.signature.prefix,
                    },
              maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              ...(input.schedule.dedupe === undefined
                ? existingTask?.schedule.type === "webhook" &&
                  existingTask.schedule.dedupe !== undefined
                  ? { dedupe: existingTask.schedule.dedupe }
                  : {}
                : { dedupe: input.schedule.dedupe }),
              ...webhookFilters(
                // Omitted keeps the stored filters, so a client that predates
                // them can re-save a task without clearing them.
                input.schedule.filters ??
                  (existingTask?.schedule.type === "webhook"
                    ? existingTask.schedule.filters
                    : undefined),
              ),
            }
          : input.schedule.type === "once"
            ? { type: "once", runAt: iso(DateTime.makeUnsafe(input.schedule.runAt)) }
            : input.schedule;
      const webhook =
        input.schedule.type === "webhook"
          ? yield* Effect.gen(function* () {
              const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
              const token = existing?.token ?? (yield* newWebhookToken);
              const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
              // A secretRef is a value the user entered for an agent; this
              // save consumes it, so it cannot be used again. A replay of a
              // save that already used it keeps the secret that save stored.
              const replay = input.commandId !== undefined && existing?.secret != null;
              const fromRef =
                signature?.secretRef === undefined
                  ? undefined
                  : yield* secretRequests
                      .consume({ ref: signature.secretRef, projectId: input.projectId })
                      .pipe(
                        Effect.catch((error) =>
                          replay
                            ? Effect.void
                            : Effect.fail(taskError(error.message, { taskId: id })),
                        ),
                      );
              // A ref, when given, is the only source: a plain secret sent
              // alongside it must not replace what a replayed save stored.
              const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
              const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
              const secretChanged =
                signature == null || provided !== undefined || existing === null;
              if (signature != null && secret === null) {
                return yield* taskError("A webhook signature check needs a signing secret.", {
                  taskId: id,
                });
              }
              return { token, secret, secretChanged };
            })
          : { token: null, secret: null, secretChanged: true };
      const workspaceStrategy: ScheduledTask["workspaceStrategy"] =
        input.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(input.projectId))
          ? { type: "root" }
          : input.workspaceStrategy;
      const aligned =
        schedule.type === "interval" && sharedExclusions !== undefined && sharedRunOn === "one";
      const scheduleUnchanged =
        existingTask !== null &&
        existingTask.enabled === input.enabled &&
        isSameSchedule(existingTask.schedule, schedule) &&
        hasAlignedSlots(existingTask) === aligned;
      if (!scheduleUnchanged)
        yield* requireFutureOnce({ enabled: input.enabled, schedule }, now, id);
      const task: ScheduledTask = {
        id,
        title: input.title,
        prompt,
        enabled: input.enabled,
        schedule,
        projectId: input.projectId,
        threadId: input.threadId ?? null,
        workspaceStrategy,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
        creationSource: input.creationSource ?? "web",
        createdAt: existingTask?.createdAt ?? iso(now),
        updatedAt: iso(now),
        nextRunAt: scheduleUnchanged
          ? existingTask.nextRunAt
          : nextRunAt(
              {
                enabled: input.enabled,
                schedule,
                createdAt: existingTask?.createdAt ?? iso(now),
                ...(aligned ? { shared: { runOn: "one" } as ScheduledTaskSharing } : {}),
              },
              now,
            ),
        lastRunAt: existingTask?.lastRunAt ?? null,
        lastRunStatus: existingTask?.lastRunStatus ?? "never",
        lastRunError: existingTask?.lastRunError ?? null,
        runCount: existingTask?.runCount ?? 0,
      };
      const placement =
        input.placement ??
        (existingTask === null
          ? (yield* serverSettings.getSettings.pipe(
              Effect.mapError((cause) =>
                taskError("Could not read schedule task settings.", { taskId: id, cause }),
              ),
            )).scheduledTaskDefaultPlacement
          : undefined);
      // Omitted keeps the stored choice, so a client that predates it can re-save a task.
      const followsDefaultModel =
        input.followsDefaultModel ?? existingTask?.followsDefaultModel ?? false;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Checked in the transaction so a replay of a creation cannot undo a later change.
            const created = existingTask === null && !(yield* hasTask(id));
            const keptText = promptFileKept ? yield* storedPrompt(id) : undefined;
            yield* saveTask(
              keptText === undefined ? task : { ...task, prompt: keptText },
              input.requireExisting === true,
              scheduleUnchanged ? existingTask.schedule : null,
              webhook,
            );
            if (placement !== undefined && (created || existingTask !== null)) {
              yield* writePlacement([id], placement, now);
            }
            yield* followsDefaultModel
              ? sql`INSERT INTO scheduled_task_default_model (task_id) VALUES (${id})
                    ON CONFLICT (task_id) DO NOTHING`
              : sql`DELETE FROM scheduled_task_default_model WHERE task_id = ${id}`;
            // Omitted keeps the stored choice, or for a new task its schedule's default.
            yield* writeCatchUp(id, input.catchUpMissedRun);
            yield* writeDelegateProviders(id, input.delegateProviders);
            yield* writeMaxLiveRuns(id, input.maxLiveRuns);
            yield* writeRunCondition(id, runCondition);
            yield* writePromptFile(
              id,
              promptFilePath,
              promptRead === null ? "keep" : { ...promptRead, at: iso(now) },
            );
            // Turning a task on by saving it ends its group's hold on it.
            yield* writeGroup(id, input.group, input.enabled ? false : "keep");
            yield* writeChangedBy(id, { ...by, at: iso(now) });
            if (sharedExclusions !== undefined && sharedProject !== null) {
              yield* writeSharing(id, {
                revision: yield* stampRevision(id),
                project: sharedProject,
                excludedEnvironmentIds: sharedExclusions,
                ...(sharedRunOn === undefined ? {} : { runOn: sharedRunOn }),
              });
              if (machineOrder !== undefined) {
                const key = scheduledTaskSharedProjectKey(sharedProject);
                yield* writeMachineOrder({
                  project: sharedProject,
                  order: machineOrder,
                  revision: yield* stampOrderRevision(key),
                });
              }
            } else if ((yield* storedRevisions(id)).shared !== null) {
              yield* writeDeletion(id, yield* stampRevision(id));
            }
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isScheduledTaskError(cause)
              ? cause
              : taskError("Could not save schedule task.", { taskId: id, cause }),
          ),
        );
      yield* notifyChanged;
      return { task: (yield* findTask(id)) ?? { ...task, followsDefaultModel } };
    });

    const applyShared: ScheduledTaskService["Service"]["applyShared"] = Effect.fn(
      "ScheduledTaskService.applyShared",
    )(function* (input) {
      if (input.type === "projectMachineOrder") {
        const order = input.order;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [stored] = yield* sql<SharedRevisionRow>`
                SELECT revision_at, revision_environment_id
                FROM scheduled_task_project_machine_orders
                WHERE project_key = ${scheduledTaskSharedProjectKey(order.project)}`;
              if (
                stored !== undefined &&
                compareScheduledTaskSharedRevisions(order.revision, toRevision(stored)!) <= 0
              ) {
                return { outcome: "stale" as const };
              }
              yield* writeMachineOrder(order);
              return { outcome: "applied" as const };
            }),
          )
          .pipe(
            Effect.mapError((cause) => taskError("Could not apply the machine order.", { cause })),
            Effect.tap((result) => (result.outcome === "applied" ? notifyChanged : Effect.void)),
          );
      }
      const id = input.type === "upsert" ? input.task.id : input.deletion.id;
      const incoming =
        input.type === "upsert" ? input.task.shared.revision : input.deletion.revision;
      const toTaskError = (cause: unknown) =>
        isScheduledTaskError(cause)
          ? cause
          : taskError("Could not apply the shared schedule task.", { taskId: id, cause });

      // Read again inside the transaction that writes, so concurrent applies settle on one winner.
      const classify = Effect.gen(function* () {
        const stored = yield* storedRevisions(id);
        const exists =
          (yield* sql`SELECT 1 AS found FROM scheduled_tasks WHERE task_id = ${id}`).length > 0;
        if (exists && stored.shared === null) return "local" as const;
        const current = [stored.shared, stored.deletion].reduce<ScheduledTaskSharedRevision | null>(
          (latest, revision) =>
            revision !== null &&
            (latest === null || compareScheduledTaskSharedRevisions(revision, latest) > 0)
              ? revision
              : latest,
          null,
        );
        if (current === null) return "open" as const;
        const order = compareScheduledTaskSharedRevisions(incoming, current);
        return order > 0
          ? ("open" as const)
          : order === 0 && current === stored.shared
            ? ("same" as const)
            : ("stale" as const);
      });
      // An app that predates a field sends copies without it, so a copy at the same revision
      // fills in what the stored one was applied without.
      const completeSameRevision = (
        taskId: ScheduledTaskId,
        task: Extract<typeof input, { readonly type: "upsert" }>["task"],
      ) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if ((yield* classify) !== "same") return { outcome: "stale" as const };
            const [condition] = yield* sql<RunConditionRow>`
              SELECT command, timeout_seconds FROM scheduled_task_run_conditions
              WHERE task_id = ${taskId}`;
            const [catchUp] = yield* sql<{ readonly enabled: number }>`
              SELECT enabled FROM scheduled_task_catch_up WHERE task_id = ${taskId}`;
            const [promptFile] = yield* sql<{ readonly path: string }>`
              SELECT path FROM scheduled_task_prompt_files WHERE task_id = ${taskId}`;
            const [delegates] = yield* sql<{ readonly providers_json: string }>`
              SELECT providers_json FROM scheduled_task_delegate_providers WHERE task_id = ${taskId}`;
            const liveRunLimitDiffers =
              task.maxLiveRuns !== undefined &&
              task.maxLiveRuns !== (yield* liveRunLimitOf(taskId));
            const [changedBy] = yield* sql<{ readonly changed_by_json: string }>`
              SELECT changed_by_json FROM scheduled_task_changed_by WHERE task_id = ${taskId}`;
            // One revision has one author, so only a copy that lacked it can be filled in.
            const changedByMissing = task.changedBy != null && changedBy === undefined;
            const delegatesDiffer =
              task.delegateProviders !== undefined &&
              (task.delegateProviders.length === 0
                ? delegates !== undefined
                : encodeDelegateProvidersJson(task.delegateProviders) !==
                  delegates?.providers_json);
            const promptFileDiffers =
              task.promptFile !== undefined && task.promptFile !== (promptFile?.path ?? null);
            const conditionDiffers =
              task.runCondition !== undefined &&
              (task.runCondition === null
                ? condition !== undefined
                : condition?.command !== task.runCondition.command ||
                  condition.timeout_seconds !== task.runCondition.timeoutSeconds);
            const catchUpDiffers =
              task.catchUpMissedRun !== undefined &&
              task.catchUpMissedRun !==
                (catchUp === undefined
                  ? defaultCatchUpMissedRun(task.schedule)
                  : catchUp.enabled === 1);
            if (
              !conditionDiffers &&
              !catchUpDiffers &&
              !promptFileDiffers &&
              !delegatesDiffer &&
              !liveRunLimitDiffers &&
              !changedByMissing
            ) {
              return { outcome: "stale" as const };
            }
            if (conditionDiffers) yield* writeRunCondition(taskId, task.runCondition);
            if (catchUpDiffers) yield* writeCatchUp(taskId, task.catchUpMissedRun);
            if (promptFileDiffers) yield* writePromptFile(taskId, task.promptFile ?? null, null);
            if (delegatesDiffer) yield* writeDelegateProviders(taskId, task.delegateProviders);
            if (liveRunLimitDiffers) yield* writeMaxLiveRuns(taskId, task.maxLiveRuns);
            if (changedByMissing) yield* writeChangedBy(taskId, task.changedBy ?? null);
            return { outcome: "applied" as const };
          }),
        );
      const commit = <E>(
        write: Effect.Effect<void, E>,
        outcome: "applied" | "removed",
      ): Effect.Effect<ScheduledTaskApplySharedResult, ScheduledTaskError> =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const state = yield* classify;
              if (state !== "open") return { outcome: state === "same" ? "stale" : state };
              yield* write;
              return { outcome };
            }),
          )
          .pipe(
            Effect.mapError(toTaskError),
            Effect.tap((result) =>
              result.outcome === "applied" || result.outcome === "removed"
                ? notifyChanged
                : Effect.void,
            ),
          );

      const early = yield* classify.pipe(Effect.mapError(toTaskError));
      if (early === "same" && input.type === "upsert") {
        return yield* completeSameRevision(id, input.task).pipe(
          Effect.mapError(toTaskError),
          Effect.tap((result) => (result.outcome === "applied" ? notifyChanged : Effect.void)),
        );
      }
      if (early !== "open") return { outcome: early === "same" ? "stale" : early };

      if (input.type === "delete") {
        return yield* commit(
          deleteLocalRows(id).pipe(Effect.andThen(writeDeletion(id, incoming))),
          "applied",
        );
      }
      const task = input.task;
      // A deletion row here would spread the removal to every other machine.
      if (task.shared.excludedEnvironmentIds.includes(hereEnvironmentId)) {
        return yield* commit(deleteLocalRows(id), "removed");
      }
      if (task.schedule.type === "webhook") {
        return yield* taskError(
          "A shared task can't use a webhook: each machine has its own webhook address.",
          { taskId: id },
        );
      }
      const modeDenial = task.enabled
        ? managedRuntimeModeDenial(managedPolicy.summary, task.runtimeMode)
        : undefined;
      if (modeDenial !== undefined) return yield* taskError(modeDenial, { taskId: id });

      const projectId = yield* localProjectFor(task.shared.project, id);
      const now = yield* localNow;
      const existingTask = yield* findTask(id);
      const schedule: ScheduledTask["schedule"] =
        task.schedule.type === "once"
          ? { type: "once", runAt: iso(DateTime.makeUnsafe(task.schedule.runAt)) }
          : task.schedule;
      const workspaceStrategy: ScheduledTask["workspaceStrategy"] =
        task.workspaceStrategy.type === "worktree" &&
        (yield* managedFolders.isScratchProject(projectId))
          ? { type: "root" }
          : task.workspaceStrategy;
      const scheduleUnchanged =
        existingTask !== null &&
        existingTask.enabled === task.enabled &&
        isSameSchedule(existingTask.schedule, schedule) &&
        hasAlignedSlots(existingTask) === hasAlignedSlots({ schedule, shared: task.shared });
      // A copy from a machine without prompt files leaves this machine's file in place.
      const promptFilePath =
        task.promptFile === undefined ? (existingTask?.promptFile?.path ?? null) : task.promptFile;
      // The stored text goes with this machine's last read of the same file, not the sender's.
      const keepsOwnRead =
        promptFilePath !== null &&
        existingTask?.promptFile != null &&
        existingTask.promptFile.path === promptFilePath &&
        existingTask.promptFile.lastRead !== null &&
        existingTask.projectId === projectId;
      const saved: ScheduledTask = {
        id,
        title: task.title,
        prompt: task.prompt,
        enabled: task.enabled,
        schedule,
        projectId,
        threadId: null,
        workspaceStrategy,
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        createdBy: existingTask?.createdBy ?? task.createdBy,
        creationSource: task.creationSource,
        createdAt: existingTask?.createdAt ?? task.createdAt,
        updatedAt: iso(now),
        // A one-time run that has passed just has no next run: the other machine already took it.
        nextRunAt: scheduleUnchanged
          ? existingTask.nextRunAt
          : nextRunAt(
              {
                enabled: task.enabled,
                schedule,
                createdAt: existingTask?.createdAt ?? task.createdAt,
                shared: task.shared,
              },
              now,
            ),
        lastRunAt: existingTask?.lastRunAt ?? null,
        lastRunStatus: existingTask?.lastRunStatus ?? "never",
        lastRunError: existingTask?.lastRunError ?? null,
        runCount: existingTask?.runCount ?? 0,
      };
      const placement =
        existingTask === null
          ? (yield* serverSettings.getSettings.pipe(
              Effect.mapError((cause) =>
                taskError("Could not read schedule task settings.", { taskId: id, cause }),
              ),
            )).scheduledTaskDefaultPlacement
          : undefined;
      return yield* commit(
        Effect.gen(function* () {
          const created = existingTask === null && !(yield* hasTask(id));
          const keptText = keepsOwnRead ? yield* storedPrompt(id) : undefined;
          const written = keptText === undefined ? saved : { ...saved, prompt: keptText };
          yield* saveTask(written, false, scheduleUnchanged ? existingTask.schedule : null, {
            token: null,
            secret: null,
            secretChanged: true,
          });
          if (placement !== undefined && created) yield* writePlacement([id], placement, now);
          yield* task.followsDefaultModel
            ? sql`INSERT INTO scheduled_task_default_model (task_id) VALUES (${id})
                  ON CONFLICT (task_id) DO NOTHING`
            : sql`DELETE FROM scheduled_task_default_model WHERE task_id = ${id}`;
          yield* writeCatchUp(id, task.catchUpMissedRun);
          yield* writeRunCondition(id, task.runCondition);
          yield* writePromptFile(id, promptFilePath, keepsOwnRead ? "keep" : null);
          // A copy from a machine without groups leaves this machine's group as it is.
          yield* task.group === undefined
            ? writeGroup(id, undefined, task.enabled ? false : "keep")
            : writeGroup(id, task.group, task.pausedWithGroup === true && !task.enabled);
          yield* writeDelegateProviders(id, task.delegateProviders);
          yield* writeMaxLiveRuns(id, task.maxLiveRuns);
          // A copy that does not say who made its revision leaves the author unknown here, not
          // the author of the revision it replaces.
          yield* writeChangedBy(id, task.changedBy ?? null);
          yield* writeSharing(id, task.shared);
        }),
        "applied",
      );
    });

    // Why a task may not be turned on, whether by hand or by resuming its group.
    const enableRefusal = (task: ScheduledTask, now: DateTime.DateTime): string | undefined => {
      if (task.schedule.type === "webhook" && webhookPolicyBlock !== undefined) {
        return webhookPolicyBlock;
      }
      const modeDenial =
        task.threadId === null
          ? managedRuntimeModeDenial(managedPolicy.summary, task.runtimeMode)
          : undefined;
      return modeDenial ?? passedOnceMessage({ enabled: true, schedule: task.schedule }, now);
    };

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = Effect.fn(
      "ScheduledTaskService.setEnabled",
    )(function* (input, by) {
      const existing = yield* loadTask(input.id);
      if (existing.enabled === input.enabled) {
        if (existing.pausedWithGroup !== true) return { task: existing };
        // Still a choice made by hand: its group's resume must leave the task alone.
        const changedBy = yield* sql
          .withTransaction(
            writeGroup(input.id, undefined, false).pipe(Effect.andThen(recordChange(input.id, by))),
          )
          .pipe(
            Effect.mapError((cause) =>
              taskError("Could not update schedule task.", { taskId: input.id, cause }),
            ),
          );
        yield* notifyChanged;
        const { pausedWithGroup: _cleared, ...task } = existing;
        return { task: { ...task, changedBy } };
      }
      const now = yield* localNow;
      const refusal = input.enabled ? enableRefusal(existing, now) : undefined;
      if (refusal !== undefined) return yield* taskError(refusal, { taskId: input.id });
      const next = nextRunAt({ ...existing, enabled: input.enabled }, now);
      // RETURNING so a task deleted between the load and this UPDATE is a
      // visible not-found error, not a false success.
      const changedBy = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const updated = yield* sql<{ task_id: string }>`
              UPDATE scheduled_tasks
              SET enabled = ${input.enabled ? 1 : 0},
                  next_run_at = ${next},
                  updated_at = ${iso(now)}
              WHERE task_id = ${input.id}
              RETURNING task_id
            `;
            if (updated.length === 0) {
              return yield* taskError("Schedule task not found.", { taskId: input.id });
            }
            // A task switched by hand is no longer its group pause's to resume.
            yield* writeGroup(input.id, undefined, false);
            return yield* recordChange(input.id, by);
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isScheduledTaskError(cause)
              ? cause
              : taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
      yield* notifyChanged;
      const { pausedWithGroup: _cleared, ...task } = existing;
      return {
        task: { ...task, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now), changedBy },
      };
    });

    const setGroupPaused: ScheduledTaskService["Service"]["setGroupPaused"] = Effect.fn(
      "ScheduledTaskService.setGroupPaused",
    )(function* (input, by) {
      const ids = [...new Set(input.ids)];
      const now = yield* localNow;
      // Read before the write, which checks the task is still off, marked and unedited.
      const marked: Array<{ readonly task: ScheduledTask; readonly updatedAt: string }> = [];
      if (!input.paused) {
        for (const id of ids) {
          const [row] = yield* getRows(id).pipe(
            Effect.mapError((cause) =>
              taskError("Could not load schedule task.", { taskId: id, cause }),
            ),
          );
          if (row === undefined || row.enabled === 1 || row.paused_with_group !== 1) continue;
          marked.push({ task: yield* decodeRow(row), updatedAt: row.updated_at });
        }
      }
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const changed: ScheduledTaskId[] = [];
            const refused: Array<{ readonly id: ScheduledTaskId; readonly message: string }> = [];
            // Only a task in a group can carry the mark that lets a resume turn it back on.
            for (const id of input.paused ? ids : []) {
              const [paused] = yield* sql<{ task_id: ScheduledTaskId }>`
                UPDATE scheduled_tasks
                SET enabled = 0, next_run_at = NULL, updated_at = ${iso(now)}
                WHERE task_id = ${id} AND enabled = 1
                  AND EXISTS (SELECT 1 FROM scheduled_task_group g WHERE g.task_id = ${id})
                RETURNING task_id
              `;
              if (paused === undefined) continue;
              yield* writeGroup(id, undefined, true);
              yield* recordChange(id, by);
              changed.push(paused.task_id);
            }
            for (const { task, updatedAt } of marked) {
              const refusal = enableRefusal(task, now);
              const [settled] =
                refusal === undefined
                  ? yield* sql<{ task_id: ScheduledTaskId }>`
                      UPDATE scheduled_tasks
                      SET enabled = 1,
                          next_run_at = ${nextRunAt({ ...task, enabled: true }, now)},
                          updated_at = ${iso(now)}
                      WHERE task_id = ${task.id} AND enabled = 0 AND updated_at = ${updatedAt}
                        AND EXISTS (SELECT 1 FROM scheduled_task_group g
                          WHERE g.task_id = ${task.id} AND g.paused_with_group = 1)
                      RETURNING task_id
                    `
                  : yield* sql<{ task_id: ScheduledTaskId }>`
                      UPDATE scheduled_task_group SET paused_with_group = 0
                      WHERE task_id = ${task.id} AND paused_with_group = 1
                        AND EXISTS (SELECT 1 FROM scheduled_tasks t WHERE t.task_id = ${task.id}
                          AND t.enabled = 0 AND t.updated_at = ${updatedAt})
                      RETURNING task_id
                    `;
              if (settled === undefined) continue;
              if (refusal === undefined) {
                yield* writeGroup(task.id, undefined, false);
                changed.push(settled.task_id);
              } else {
                refused.push({ id: settled.task_id, message: refusal });
              }
              yield* recordChange(task.id, by);
            }
            return { ids: changed, refused };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isScheduledTaskError(cause)
              ? cause
              : taskError("Could not update schedule tasks.", { cause }),
          ),
        );
      if (result.ids.length > 0 || result.refused.length > 0) yield* notifyChanged;
      return result;
    });

    const setPlacement: ScheduledTaskService["Service"]["setPlacement"] = Effect.fn(
      "ScheduledTaskService.setPlacement",
    )(function* (input) {
      const now = yield* localNow;
      const changed = yield* sql
        .withTransaction(writePlacement(input.ids, input.placement, now))
        .pipe(Effect.mapError((cause) => taskError("Could not update schedule tasks.", { cause })));
      if (changed.length > 0) yield* notifyChanged;
      return { ids: changed.map((row) => row.task_id) };
    });

    const reorderPinned: ScheduledTaskService["Service"]["reorderPinned"] = Effect.fn(
      "ScheduledTaskService.reorderPinned",
    )(function* (input) {
      const changed = yield* sql
        .withTransaction(
          Effect.forEach(
            input.assignments,
            ({ id, orderKey }) =>
              sql<{ task_id: ScheduledTaskId }>`
              UPDATE scheduled_task_sidebar SET pin_order_key = ${orderKey}
              WHERE task_id = ${id} AND pinned_at IS NOT NULL
                AND EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${id})
              RETURNING task_id
            `,
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not reorder pinned schedule tasks.", { cause }),
          ),
        );
      const ids = changed.flat().map((row) => row.task_id);
      if (ids.length > 0) yield* notifyChanged;
      return { ids };
    });

    const setFollowsDefaultModel: ScheduledTaskService["Service"]["setFollowsDefaultModel"] =
      Effect.fn("ScheduledTaskService.setFollowsDefaultModel")(function* (input, by) {
        // Only the flag changes: a task's own model stays stored, so turning it off restores it.
        const changed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* input.followsDefaultModel
                ? sql<{ task_id: ScheduledTaskId }>`
                    INSERT INTO scheduled_task_default_model (task_id)
                    SELECT task_id FROM scheduled_tasks WHERE task_id IN ${sql.in(input.ids)}
                    ON CONFLICT (task_id) DO NOTHING
                    RETURNING task_id
                  `
                : sql<{ task_id: ScheduledTaskId }>`
                    DELETE FROM scheduled_task_default_model
                    WHERE task_id IN ${sql.in(input.ids)}
                    RETURNING task_id
                  `;
              yield* Effect.forEach(rows, (row) => recordChange(row.task_id, by), {
                discard: true,
              });
              return rows;
            }),
          )
          .pipe(
            Effect.mapError((cause) => taskError("Could not update schedule tasks.", { cause })),
          );
        if (changed.length > 0) yield* notifyChanged;
        return { ids: changed.map((row) => row.task_id) };
      });

    const forgetWebhookTask = (id: ScheduledTaskId) =>
      Effect.all(
        [
          Ref.update(webhookRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookRejectedRateWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookDedupeLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookFilteredLogWindows, (windows) => {
            const next = new Map(windows);
            next.delete(id);
            return next;
          }),
          Ref.update(webhookPermits, (permits) => {
            const next = new Map(permits);
            next.delete(id);
            return next;
          }),
        ],
        { discard: true },
      );

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(forgetWebhookTask(input.id)),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const deleteForThread = Effect.fn("ScheduledTaskService.deleteForThread")(function* (
      threadId: ThreadId,
    ) {
      // Check the current binding in the transaction: an automation may have
      // been unbound or moved since thread deletion queued this cleanup.
      const removed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const bound = yield* sql<{ task_id: ScheduledTaskId }>`
              SELECT task_id FROM scheduled_tasks WHERE thread_id = ${threadId}
            `;
            yield* Effect.forEach(bound, ({ task_id }) => deleteLocalRows(task_id), {
              discard: true,
            });
            return bound;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete thread's schedule tasks.", { cause }),
          ),
        );
      yield* Effect.forEach(removed, ({ task_id }) => forgetWebhookTask(task_id), {
        discard: true,
      });
      if (removed.length > 0) yield* notifyChanged;
    });

    const moveThreadTasks: ScheduledTaskService["Service"]["moveThreadTasks"] = Effect.fn(
      "ScheduledTaskService.moveThreadTasks",
    )(function* (input) {
      if (input.threadIds.length === 0) return;
      const moved = yield* sql<{ task_id: ScheduledTaskId }>`
        UPDATE scheduled_tasks SET project_id = ${input.projectId}
        WHERE project_id != ${input.projectId} AND thread_id IN ${sql.in(input.threadIds)}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not move the thread's schedule tasks.", { cause }),
        ),
      );
      if (moved.length > 0) yield* notifyChanged;
    });

    const runNow: ScheduledTaskService["Service"]["runNow"] = Effect.fn(
      "ScheduledTaskService.runNow",
    )(function* (input: ScheduledTaskRunNowInput) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type === "webhook") {
        return yield* taskError("Webhook tasks run when their URL receives a request.", {
          taskId: input.id,
        });
      }
      return yield* runTask(task, "manual").pipe(
        Effect.mapError((cause) =>
          taskError("Could not run schedule task.", { taskId: input.id, cause }),
        ),
      );
    });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = Effect.fn(
      "ScheduledTaskService.rotateWebhookToken",
    )(function* (input) {
      const task = yield* loadTask(input.id);
      if (task.schedule.type !== "webhook") {
        return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
      }
      const token = yield* newWebhookToken;
      const now = yield* localNow;
      // Matching created_at keeps a rotation from landing on a task deleted
      // and recreated under the same id since it was loaded.
      const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
        ),
      );
      if (updated.length === 0) {
        return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
      }
      yield* notifyChanged;
      return { task: yield* loadTask(input.id) };
    });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      pendingWindow: row.outcome === "accepted" && row.pending_window === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listRuns: ScheduledTaskService["Service"]["listRuns"] = (input) =>
      sql<RunRecordRow>`
        SELECT run_id, trigger, scheduled_for, started_at, completed_at, outcome, thread_id,
          error, skip_reason, ran_on, failover_from, failover_to, failover_reason,
          failover_mcp_servers_json, check_json, usage_limit_json
        FROM scheduled_task_runs WHERE task_id = ${input.id}
        ORDER BY started_at DESC, run_id DESC
        LIMIT ${RUN_HISTORY_RETENTION + QUIET_SKIP_REASONS.length * QUIET_SKIP_RETENTION}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => ({
          runs: rows.flatMap((row) =>
            Option.toArray(
              decodeRunRecord({
                id: row.run_id,
                trigger: row.trigger,
                scheduledFor: row.scheduled_for,
                startedAt: row.started_at,
                completedAt: row.completed_at,
                outcome: row.outcome,
                threadId: row.thread_id,
                error: row.error,
                skipReason: row.skip_reason,
                ranOn: row.ran_on,
                failover:
                  row.failover_from === null || row.failover_to === null
                    ? null
                    : {
                        from: row.failover_from,
                        to: row.failover_to,
                        ...(row.failover_reason === null ? {} : { reason: row.failover_reason }),
                        ...(row.failover_mcp_servers_json === null
                          ? {}
                          : Option.match(decodeMcpServersJson(row.failover_mcp_servers_json), {
                              onNone: () => ({}),
                              onSome: (mcpServers) => ({ mcpServers }),
                            })),
                      },
                check:
                  row.check_json === null
                    ? null
                    : Option.getOrNull(decodeRunCheckJson(row.check_json)),
                usageLimit:
                  row.usage_limit_json === null
                    ? null
                    : Option.getOrNull(decodeRunUsageLimitJson(row.usage_limit_json)),
              }),
            ),
          ),
        })),
        Effect.mapError((cause) =>
          taskError("Could not list schedule task runs.", { taskId: input.id, cause }),
        ),
      );

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
          WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
        FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => ({
          deliveries: rows
            .filter(
              (row) => input.acceptAnyOutcome === true || LEGACY_DELIVERY_OUTCOMES.has(row.outcome),
            )
            .map(decodeDeliverySummary),
        })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = Effect.fn(
      "ScheduledTaskService.getWebhookDelivery",
    )(function* (input) {
      const rows = yield* sql<WebhookDeliveryRow>`
          SELECT d.*, EXISTS (SELECT 1 FROM scheduled_task_webhook_pending p
            WHERE p.delivery_id = d.delivery_id AND p.state IN ('pending', 'dispatching')) AS pending_window
          FROM scheduled_task_webhook_deliveries d WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
        ),
      );
      const row = rows[0];
      if (
        row === undefined ||
        (input.acceptAnyOutcome !== true && !LEGACY_DELIVERY_OUTCOMES.has(row.outcome))
      ) {
        return yield* taskError("Webhook delivery not found.", { taskId: input.id });
      }
      return {
        delivery: {
          ...decodeDeliverySummary(row),
          query: row.query,
          headers: deliveryHeaders(row),
          body: row.body,
          bodyTruncated: row.body_truncated === 1,
          renderedPrompt: row.rendered_prompt,
        },
      };
    });

    const deliveryRequestBody = (request: WebhookTriggerRequest) => {
      const truncated = request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      return {
        truncated,
        // Streaming decode drops a character the byte limit split, instead of ending in U+FFFD.
        body: truncated
          ? new TextDecoder().decode(request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT), {
              stream: true,
            })
          : request.bodyText,
      };
    };
    const replaceDeliveryRequest = (deliveryId: string, request: WebhookTriggerRequest) => {
      const logged = deliveryRequestBody(request);
      return sql`UPDATE scheduled_task_webhook_deliveries SET
        method = ${request.method}, query = ${redactQuery(request.query)},
        headers_json = ${encodeHeadersJson(redactHeaders(request.headers))}, body = ${logged.body},
        body_bytes = ${request.body.byteLength}, body_truncated = ${logged.truncated ? 1 : 0}
        WHERE delivery_id = ${deliveryId}`.pipe(Effect.asVoid, Effect.mapError(dedupeError));
    };

    // Each suppression bucket retains its own rows, never real run history.
    const deliveryBucket = (outcome: string, error: string | undefined) =>
      outcome === "filtered"
        ? "filtered"
        : outcome === "duplicate" ||
            outcome === "coalesced" ||
            outcome === "rate_limited" ||
            error === PROMPT_TOO_LONG
          ? "dedupe"
          : "main";
    const pruneDeliveries = (
      taskId: string,
      retentionBucket: ReturnType<typeof deliveryBucket>,
    ) => {
      const rowBucket = sql.literal(`CASE WHEN outcome = 'filtered' THEN 'filtered'
        WHEN outcome IN ('duplicate', 'coalesced', 'rate_limited') OR error = 'The filled-in prompt is too long.' THEN 'dedupe'
        ELSE 'main' END`);
      return sql`
        DELETE FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${taskId} AND ${rowBucket} = ${retentionBucket}
          AND delivery_id NOT IN (
            SELECT delivery_id FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${taskId} AND ${rowBucket} = ${retentionBucket}
            ORDER BY received_at DESC, rowid DESC
            LIMIT ${retentionBucket === "main" ? WEBHOOK_DELIVERY_RETENTION : retentionBucket === "filtered" ? WEBHOOK_FILTERED_DELIVERY_RETENTION : WEBHOOK_DEDUPE_DELIVERY_RETENTION}
          )
      `;
    };

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const { truncated, body: loggedBody } = deliveryRequestBody(input.request);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Require the task to exist so deletes cannot leave deliveries for a recreated task.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            yield* pruneDeliveries(input.taskId, deliveryBucket(input.outcome, input.error));
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [updated] = yield* sql<{ task_id: string }>`
              UPDATE scheduled_task_webhook_deliveries
              SET outcome = 'dispatch_failed', error = ${message}
              WHERE delivery_id = ${deliveryId}
              RETURNING task_id
            `;
            // An oversized prompt moves the row into the suppression bucket.
            if (updated !== undefined)
              yield* pruneDeliveries(updated.task_id, deliveryBucket("dispatch_failed", message));
          }),
        )
        .pipe(Effect.ignore);

    /** Sliding one-minute window for deliveries that can start work. */
    const takeRateSlot = (
      id: ScheduledTaskId,
      nowMs: number,
      rateWindows = webhookRateWindows,
      reservation = { at: nowMs },
    ) =>
      Ref.modify(
        rateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((entry) => nowMs - entry.at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, reservation], rejectedLogged: false }),
          ];
        },
      );

    const takeDedupeLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(webhookDedupeLogWindows, (windows) => {
        const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
        return recent.length >= WEBHOOK_DEDUPE_LOG_PER_MINUTE
          ? ([false, windows] as const)
          : ([true, new Map(windows).set(id, [...recent, nowMs])] as const);
      });
    const releaseReplay = (deliveryId: string) =>
      releaseWebhookReplay(deliveryId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(dedupeError),
      );
    /** Sliding one-minute window of filtered requests written to the delivery log. */
    const takeFilteredLogSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookFilteredLogWindows,
        (windows): readonly [boolean, ReadonlyMap<ScheduledTaskId, ReadonlyArray<number>>] => {
          const recent = (windows.get(id) ?? []).filter((at) => nowMs - at < 60_000);
          return recent.length >= WEBHOOK_FILTERED_LOG_PER_MINUTE
            ? [false, windows]
            : [true, new Map(windows).set(id, [...recent, nowMs])];
        },
      );

    const webhookPermit = Effect.fn("ScheduledTaskService.webhookPermit")(function* (
      id: ScheduledTaskId,
    ) {
      const existing = (yield* Ref.get(webhookPermits)).get(id);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(webhookPermits, (permits) => {
        const raced = permits.get(id);
        return raced === undefined
          ? [created, new Map(permits).set(id, created)]
          : [raced, permits];
      });
    });

    const releaseFailedDelivery = Effect.fn("ScheduledTaskService.releaseFailedDelivery")(
      function* (deliveryId: string) {
        yield* releaseReplay(deliveryId);
        yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id IN (
          SELECT substr(value, ${"delivery:relay:".length + 1}) FROM scheduled_task_webhook_pending, json_each(delivery_ids_json)
          WHERE delivery_id = ${deliveryId} AND value LIKE 'delivery:relay:%'
        )`.pipe(Effect.mapError(dedupeError));
        if (deliveryId.startsWith("delivery:relay:"))
          yield* sql`DELETE FROM scheduled_task_webhook_relay_deliveries WHERE relay_delivery_id = ${deliveryId.slice("delivery:relay:".length)}`.pipe(
            Effect.mapError(dedupeError),
          );
      },
      (effect) => sql.withTransaction(effect).pipe(Effect.mapError(dedupeError)),
    );

    const runWebhookDelivery = Effect.fn("ScheduledTaskService.runWebhookDelivery")(function* (
      task: ScheduledTask,
      deliveryId: string,
      prompt: string,
    ) {
      const runOutcome = (outcome: "started" | "skipped" | "failed") =>
        Effect.all([
          Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
          Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
        ]);
      const dispatched = yield* Ref.make(false);
      return yield* runTask(task, "webhook", { deliveryId, prompt, dispatched }).pipe(
        Effect.flatMap(({ dispatchFailed }) =>
          dispatchFailed
            ? runOutcome("failed").pipe(
                Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                Effect.andThen(releaseFailedDelivery(deliveryId)),
              )
            : runOutcome("started"),
        ),
        Effect.catchTags({
          WebhookDeliverySkipped: (skipped) =>
            runOutcome("skipped").pipe(
              Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
              Effect.andThen(releaseFailedDelivery(deliveryId)),
            ),
        }),
        Effect.as(true),
        // Dispatch success owns the replay key even if later bookkeeping fails.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const started = yield* Ref.get(dispatched);
            yield* Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause });
            yield* runOutcome(started ? "started" : "failed");
            yield* markDeliveryFailed(
              deliveryId,
              started
                ? "The run started, but completion could not be recorded."
                : "The run failed to start.",
            );
            if (!started) {
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const counted =
                      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'failed'
                WHERE delivery_id = ${deliveryId} AND state = 'running' RETURNING delivery_id`;
                    if (counted.length > 0)
                      yield* sql`UPDATE scheduled_tasks SET run_count = run_count + 1
                WHERE task_id = ${task.id} AND created_at = ${task.createdAt}`;
                  }),
                )
                .pipe(Effect.mapError(dedupeError));
              yield* releaseFailedDelivery(deliveryId);
            }
            // Pending windows retry the same command id to finish bookkeeping.
            return !started;
          }),
        ),
      );
    });

    // Delivery attributes belong to the enclosing triggerWebhook span.
    const observeDelivery = Effect.fnUntraced(function* (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.webhook.outcome": outcome,
        "scheduled_task.webhook.source": source,
      });
      yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
      if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
        const heldMs = Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
        );
        yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
        yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
      }
    });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        // Accepted deliveries may have queued a coalescing window.
        Effect.ensuring(pendingWebhooks.invalidate),
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    // triggerWebhook owns the operation span and its task-id annotation.
    const triggerWebhookUnobserved = Effect.fnUntraced(function* (request: WebhookTriggerRequest) {
      // Refused before any lookup or log, so a blocked hook neither runs nor records a delivery.
      if (webhookPolicyBlock !== undefined) {
        return yield* observeDelivery(request, "blocked_by_policy", undefined, undefined).pipe(
          Effect.as({ _tag: "blocked_by_policy" as const }),
        );
      }
      const taskId = decodeTaskId(request.hookId);
      const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
        Effect.as({ _tag: "not_found" as const }),
      );
      if (Option.isNone(taskId)) return yield* notFound;
      const rows = yield* getRows(taskId.value).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
        ),
      );
      const row = rows[0];
      // A wrong token is indistinguishable from an unknown hook, so the URL
      // does not reveal which hooks exist.
      if (
        row === undefined ||
        row.webhook_token === null ||
        !constantTimeEquals(request.token, row.webhook_token)
      ) {
        return yield* notFound;
      }
      const task = yield* decodeRow(row);
      yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
      const schedule = task.schedule;
      if (schedule.type !== "webhook") return yield* notFound;

      const now = yield* localNow;
      // Anyone can reach the tunnel directly and set the relay's header, so
      // a receive time is never later than now: a future one would pin the
      // delivery in the log and slip past the task's max age.
      const receivedAt =
        request.receivedAt === undefined
          ? now
          : DateTime.min(
              Option.getOrElse(DateTime.make(request.receivedAt), () => now),
              now,
            );
      const observe = (outcome: WebhookDeliveryOutcome) =>
        observeDelivery(request, outcome, receivedAt, now);
      const deliveryId = ScheduledTaskWebhookDeliveryId.make(
        request.relayDeliveryId === undefined
          ? `delivery:${yield* crypto
              .randomUUIDv4()
              .pipe(
                Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
              )}`
          : `delivery:relay:${request.relayDeliveryId}`,
      );
      // Claimed in its own table, kept longer than the relay holds a request,
      // because the delivery log is trimmed. A rate-limited delivery stays
      // held on the relay, so it must give up its claim or the next pass
      // would treat it as already delivered.
      let claimAcquired = false;
      const releaseClaim = <A>(result: A) =>
        !claimAcquired || request.relayDeliveryId === undefined
          ? Effect.succeed(result)
          : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
      // From the claim until the run is forked nothing may interrupt: a
      // request dropped in between (the relay hangs up after its timeout)
      // would leave a claimed delivery that never runs, or a queue slot that
      // is never released.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (request.relayDeliveryId !== undefined) {
            const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
              Effect.mapError((cause) =>
                taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
              ),
            );
            if (claimed.length === 0) {
              yield* observe("duplicate");
              return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
            }
            claimAcquired = true;
            yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
          }
          const log = (
            outcome: ScheduledTaskWebhookDeliveryOutcome,
            details: {
              readonly signatureVerified?: boolean;
              readonly missing?: ReadonlyArray<string>;
              readonly renderedPrompt?: string;
              readonly error?: string;
            } = {},
          ) =>
            recordDelivery({
              id: deliveryId,
              taskId: task.id,
              receivedAt: iso(receivedAt),
              request,
              outcome,
              signatureVerified: details.signatureVerified ?? false,
              missing: details.missing ?? [],
              renderedPrompt: details.renderedPrompt ?? null,
              ...(details.error === undefined ? {} : { error: details.error }),
            });

          // Reject floods before signature work or rejection-log writes; valid
          // deliveries give this reservation back once validation succeeds.
          const rejectionReservation = { at: DateTime.toEpochMillis(now) };
          const rejectionSlot = yield* takeRateSlot(
            task.id,
            DateTime.toEpochMillis(now),
            webhookRejectedRateWindows,
            rejectionReservation,
          );
          if (rejectionSlot !== "allowed") {
            if (rejectionSlot === "first_rejected") yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          if (!task.enabled) {
            yield* log("disabled");
            yield* observe("disabled");
            return { _tag: "disabled" as const };
          }
          const signature = schedule.signature;
          if (signature !== null) {
            const verified =
              row.webhook_secret !== null &&
              verifyWebhookSignature({
                signature,
                secret: row.webhook_secret,
                headers: request.headers,
                body: request.body,
              });
            if (!verified) {
              yield* log("rejected_signature");
              yield* observe("rejected_signature");
              return { _tag: "rejected_signature" as const };
            }
          }
          const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
          if (
            maxAgeMinutes !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
              maxAgeMinutes * 60_000
          ) {
            yield* log("expired", { signatureVerified: signature !== null });
            yield* observe("expired");
            return { _tag: "expired" as const };
          }

          const refundRejectionSlot = Ref.update(webhookRejectedRateWindows, (windows) => {
            const current = windows.get(task.id);
            if (current === undefined) return windows;
            return new Map(windows).set(task.id, {
              ...current,
              accepted: current.accepted.filter((entry) => entry !== rejectionReservation),
            });
          });

          const failedFilter = findFailedWebhookFilter(schedule.filters ?? [], request);
          if (failedFilter !== null) {
            if (yield* takeFilteredLogSlot(task.id, DateTime.toEpochMillis(now))) {
              yield* log("filtered", {
                signatureVerified: signature !== null,
                error: describeFailedWebhookFilter(failedFilter),
              });
            }
            yield* refundRejectionSlot;
            yield* observe("filtered");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "filtered" as const,
            });
          }

          const runWindow = (yield* Ref.get(webhookRateWindows)).get(task.id);
          if (
            schedule.dedupe === undefined &&
            (runWindow?.accepted.filter((entry) => DateTime.toEpochMillis(now) - entry.at < 60_000)
              .length ?? 0) >= WEBHOOK_RATE_LIMIT_PER_MINUTE
          ) {
            if ((yield* takeRateSlot(task.id, DateTime.toEpochMillis(now))) === "first_rejected")
              yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({ _tag: "rate_limited", outcome: "rate_limited" } as const);
          }
          const reserve = takeRateSlot(task.id, DateTime.toEpochMillis(now)).pipe(
            Effect.flatMap((slot) => (slot === "allowed" ? Effect.void : Effect.fail(slot))),
          );
          const queueKey = `${task.id}\u0000${task.createdAt}`;
          const checkCapacity = Effect.gen(function* () {
            const [row] = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM scheduled_task_webhook_pending
              WHERE task_id = ${task.id} AND state IN ('pending', 'dispatching', 'running')`;
            if (
              (row?.count ?? 0) + ((yield* Ref.get(webhookQueued)).get(queueKey) ?? 0) >=
              WEBHOOK_MAX_QUEUED_PER_TASK
            )
              return yield* Effect.fail("queue_full" as const);
          }).pipe(
            Effect.mapError((cause) => (cause === "queue_full" ? cause : dedupeError(cause))),
          );
          const admit = <A, E>(effect: Effect.Effect<A, E>) =>
            sql.withTransaction(effect).pipe(
              Effect.catch((cause) =>
                cause === "first_rejected" || cause === "rejected" || cause === "queue_full"
                  ? Effect.succeed({
                      outcome:
                        cause === "queue_full"
                          ? ("queue_full" as const)
                          : ("rate_limited" as const),
                      log: cause === "first_rejected",
                    })
                  : Effect.fail(isScheduledTaskError(cause) ? cause : dedupeError(cause)),
              ),
            );
          const deduped =
            schedule.dedupe === undefined
              ? "run"
              : yield* admit(
                  Effect.gen(function* () {
                    const outcome = yield* acceptWebhookDedupe(
                      task,
                      request,
                      deliveryId,
                      DateTime.toEpochMillis(now),
                      reserve,
                      takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)),
                      checkCapacity,
                      (ownerId) => replaceDeliveryRequest(ownerId, request),
                    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                    if (
                      outcome === "pending" ||
                      outcome === "coalesced" ||
                      (outcome === "duplicate" &&
                        (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now))))
                    )
                      yield* log(outcome === "pending" ? "accepted" : outcome, {
                        signatureVerified: signature !== null,
                      });
                    return outcome;
                  }),
                );
          if (typeof deduped !== "string") {
            yield* refundRejectionSlot;
            if (deduped.log) yield* log("rate_limited");
            yield* observe(deduped.outcome);
            return yield* releaseClaim({ _tag: "rate_limited", outcome: deduped.outcome } as const);
          }
          if (deduped !== "run") {
            if (deduped !== "coalesced" && deduped !== "coalesced_unlogged")
              yield* refundRejectionSlot;
            const outcome =
              deduped === "pending"
                ? "accepted"
                : deduped === "coalesced_unlogged"
                  ? "coalesced"
                  : deduped;
            yield* observe(outcome);
            if (deduped === "duplicate")
              return yield* releaseClaim({ _tag: "accepted", deliveryId, outcome } as const);
            claimAcquired = false;
            return { _tag: "accepted", deliveryId, outcome } as const;
          }
          const frameId = yield* crypto.randomBytes(6).pipe(
            Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
            Effect.mapError((cause) => taskError("Could not generate frame id.", { cause })),
          );
          const rendered = renderWebhookPrompt(task.prompt, request, frameId);
          // Providers trim the prompt before checking, so whitespace around
          // it is free.
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* log("dispatch_failed", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              error: PROMPT_TOO_LONG,
            });
            yield* releaseReplay(deliveryId);
            yield* observe("prompt_too_long");
            return yield* releaseClaim({
              _tag: "accepted" as const,
              deliveryId,
              outcome: "prompt_too_long" as const,
            });
          }
          // Bound the deliveries one task holds, so steady traffic to a stuck
          // task cannot pile up parked fibers.
          yield* refundRejectionSlot;
          let queueReserved = false;
          const release = Effect.suspend(() => {
            if (!queueReserved) return Effect.void;
            queueReserved = false;
            return Ref.update(webhookQueued, (counts) => {
              const next = new Map(counts);
              const count = (next.get(queueKey) ?? 1) - 1;
              if (count <= 0) next.delete(queueKey);
              else next.set(queueKey, count);
              return next;
            });
          });
          // Serialize immediate reservations with persisted window admission.
          const reserveImmediate = Effect.gen(function* () {
            yield* checkCapacity;
            yield* reserve;
            yield* Ref.update(webhookQueued, (counts) =>
              new Map(counts).set(queueKey, (counts.get(queueKey) ?? 0) + 1),
            );
            queueReserved = true;
          });
          const admitted = yield* admit(
            Effect.gen(function* () {
              const outcome = yield* acceptImmediateWebhookDedupe(
                task,
                request,
                deliveryId,
                DateTime.toEpochMillis(now),
                reserveImmediate,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
              if (outcome === "duplicate") {
                if (yield* takeDedupeLogSlot(task.id, DateTime.toEpochMillis(now)))
                  yield* log("duplicate", { signatureVerified: signature !== null });
              } else
                yield* log("accepted", {
                  signatureVerified: signature !== null,
                  missing: rendered.missing,
                  renderedPrompt: rendered.prompt,
                });
              return outcome;
            }),
          ).pipe(Effect.onError(() => release));
          if (typeof admitted !== "string") {
            yield* release;
            if (admitted.log) yield* log("rate_limited");
            yield* observe(admitted.outcome);
            return yield* releaseClaim({
              _tag: "rate_limited",
              outcome: admitted.outcome,
            } as const);
          }
          if (admitted === "duplicate") {
            yield* release;
            yield* observe("duplicate");
            return yield* releaseClaim({
              _tag: "accepted",
              deliveryId,
              outcome: "duplicate",
            } as const);
          }
          yield* observe("accepted");
          const permit = yield* webhookPermit(task.id);
          yield* runWebhookDelivery(task, deliveryId, rendered.prompt).pipe(
            permit.withPermits(1),
            Effect.ensuring(release),
            Effect.forkIn(serviceScope),
          );
          // Dispatch owns the accepted delivery now; retries must keep its claim.
          claimAcquired = false;
          return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
        }).pipe(
          Effect.onError(() =>
            Effect.all([
              releaseClaim(undefined),
              (request.relayDeliveryId === undefined || claimAcquired
                ? releaseReplay(deliveryId)
                : Effect.void
              ).pipe(Effect.ignore),
            ]),
          ),
        ),
      );
    });

    const dispatchPending = Effect.fn("ScheduledTaskService.dispatchPendingWebhooks")(function* () {
      const now = DateTime.toEpochMillis(yield* localNow);
      if (yield* pendingWebhooks.isIdle(now)) return;
      const readVersion = yield* pendingWebhooks.version;
      yield* sql`UPDATE scheduled_task_webhook_pending SET state = 'dispatching' WHERE state = 'pending' AND due_at <= ${now}`;
      const tasks = yield* sql<{ task_id: ScheduledTaskId }>`
        SELECT DISTINCT task_id FROM scheduled_task_webhook_pending WHERE state IN ('dispatching', 'running', 'completed', 'failed')
      `.pipe(NodeSqliteClient.readOnly);
      // Workers can leave rows behind to retry, so keep polling while any are claimed.
      if (tasks.length === 0) {
        const [next] = yield* sql<{ due_at: number | null }>`
          SELECT MIN(due_at) AS due_at FROM scheduled_task_webhook_pending WHERE state = 'pending'
        `.pipe(NodeSqliteClient.readOnly);
        yield* pendingWebhooks.record(readVersion, next?.due_at ?? Infinity, now);
      }
      yield* Effect.forEach(
        tasks,
        ({ task_id: taskId }) => {
          // One worker per task waits on its permit, then drains persisted rows in order.
          // Other tasks remain independent and ticks never reload an active task's payloads.
          const dispatch = Effect.gen(function* () {
            while (true) {
              const [entry] = yield* sql<{
                delivery_id: string;
                task_json: string;
                request_json: string;
                state: string;
              }>`
              SELECT delivery_id, task_json, request_json, state FROM scheduled_task_webhook_pending
              WHERE task_id = ${taskId} AND state IN ('dispatching', 'running', 'completed', 'failed') ORDER BY due_at, rowid LIMIT 1
            `.pipe(NodeSqliteClient.readOnly);
              if (entry === undefined) return;
              const remove = sql`DELETE FROM scheduled_task_webhook_pending WHERE delivery_id = ${entry.delivery_id}`;
              if (entry.state === "completed" || entry.state === "failed") {
                if (entry.state === "failed") {
                  yield* markDeliveryFailed(entry.delivery_id, "The run failed to start.");
                  yield* releaseFailedDelivery(entry.delivery_id);
                }
                yield* remove;
                continue;
              }
              const prepared = yield* Effect.gen(function* () {
                const task = yield* decodePendingTask(entry.task_json);
                const request = yield* decodePendingRequest(entry.request_json);
                const frameId = Buffer.from(yield* crypto.randomBytes(6)).toString("hex");
                return { task, rendered: renderWebhookPrompt(task.prompt, request, frameId) };
              }).pipe(Effect.exit);
              if (Exit.isFailure(prepared)) {
                if (Cause.hasInterruptsOnly(prepared.cause))
                  return yield* Effect.failCause(prepared.cause);
                yield* markDeliveryFailed(
                  entry.delivery_id,
                  "The pending webhook payload could not be prepared.",
                );
                yield* releaseFailedDelivery(entry.delivery_id);
                yield* remove;
                continue;
              }
              const { task, rendered } = prepared.value;
              if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
                yield* markDeliveryFailed(entry.delivery_id, PROMPT_TOO_LONG);
                yield* releaseFailedDelivery(entry.delivery_id);
              } else {
                yield* sql`UPDATE scheduled_task_webhook_deliveries SET outcome = 'accepted', error = NULL, rendered_prompt = ${rendered.prompt.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT)}, missing_fields_json = ${encodeMissingFieldsJson(rendered.missing)} WHERE delivery_id = ${entry.delivery_id}`;
                if (!(yield* runWebhookDelivery(task, entry.delivery_id, rendered.prompt))) return;
              }
              yield* remove;
            }
          });
          // The worker owns its reservation, so an interrupt anywhere still releases it.
          return Effect.acquireUseRelease(
            Ref.modify(pendingInFlight, (active) =>
              active.has(taskId)
                ? ([false, active] as const)
                : ([true, new Set(active).add(taskId)] as const),
            ),
            (reserved) =>
              reserved
                ? webhookPermit(taskId).pipe(
                    Effect.flatMap((permit) => dispatch.pipe(permit.withPermits(1))),
                    Effect.catch((cause) =>
                      Effect.logWarning("Pending webhook dispatch failed", { cause }),
                    ),
                    Effect.withSpan("ScheduledTaskService.dispatchPendingWebhook", {
                      root: true,
                    }),
                  )
                : Effect.void,
            (reserved) =>
              reserved
                ? Ref.update(pendingInFlight, (active) => {
                    const next = new Set(active);
                    next.delete(taskId);
                    return next;
                  })
                : Effect.void,
          ).pipe(Effect.forkIn(serviceScope));
        },
        { discard: true },
      );
    });
    yield* scheduler.register("webhook-coalescing", dispatchPending());

    // Following tasks list the model settings resolve for them, so default changes re-send it.
    yield* serverSettings.streamChanges.pipe(
      Stream.map((settings) =>
        JSON.stringify([
          settings.scheduledTaskModelSelection,
          settings.defaultModelSelection,
          Object.entries(settings.projectSettingsOverrides).map(([projectId, overrides]) => [
            projectId,
            overrides.defaultModelSelection,
          ]),
        ]),
      ),
      Stream.changes,
      Stream.runForEach(() => PubSub.publish(changesPubSub, undefined)),
      Effect.forkIn(serviceScope),
    );

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      setPlacement,
      setGroupPaused,
      reorderPinned,
      setFollowsDefaultModel,
      delete: deleteTask,
      applyShared,
      sharedCopies,
      knownMachineIds,
      claimOccurrence,
      deleteForThread,
      moveThreadTasks,
      runNow,
      liveRuns,
      listRuns,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    });
  }),
);
