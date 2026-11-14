import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { AuthMcpClientAccess } from "./auth.ts";
import { DelegatedTaskRole } from "./delegatedTaskRole.ts";
import {
  ContextTransferId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskChangedBy,
  ScheduledTaskGroupLabel,
  ScheduledTaskNoWorkSkip,
  ScheduledTaskPlacement,
  ScheduledTaskPromptFile,
  ScheduledTaskPromptFilePath,
  ScheduledTaskDelegateProviders,
  ScheduledTaskMaxLiveRuns,
  ScheduledTaskRunCondition,
  ScheduledTaskRunConditionInput,
  ScheduledTaskRunStatus,
  ScheduledTaskProjectMachineOrder,
  ScheduledTaskSchedule,
  ScheduledTaskSharedCopy,
  ScheduledTaskSharedDeletion,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { ProviderInteractionMode, ProviderRequestKind, RuntimeMode } from "./providerPolicy.ts";
import { PullRequestState } from "./pullRequest.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
} from "./threadPullRequest.ts";
import { hasOnlyPairedSurrogates } from "./threadMetadataMcp.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TaskCommand,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import { CanonicalModelSelection, ModelSelection } from "./modelSelection.ts";
import { SharedSettingVersion } from "./sharedSettings.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Reuse it to retry the same call. A new call gets a new key." });

// OpenCode 1.15 serializes nested MCP union objects as JSON strings; decode that form at the boundary.
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description: "JSON-text schedule. Prefer the object form.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger: {type:'interval',everyMs}, {type:'fixed_time',timeOfDay,weekdays?}, {type:'once',runAt}, or {type:'webhook'}.",
});

const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Provider instance id from `orchestrator_capabilities`.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Prefer `providerInstanceId`.",
    }),
  ),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description:
        "Options from `orchestrator_capabilities`, such as {effort:'max'}. Given values override inherited. [] or {} clears.",
    }),
  ),
  environmentId: Schema.optional(
    EnvironmentId.annotate({
      description:
        "Linked environment to run in. Provider and model default to yours; others come from `orchestrator_capabilities` with this `environmentId`.",
    }),
  ),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "With `environmentId`: its project to run in. Default: the one with this project's repository. Without it, another project of this environment, only with `isolation: 'worktree'`: the child gets a new worktree of that project's repository.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

export const OrchestratorMcpTaskRole = DelegatedTaskRole;
export type OrchestratorMcpTaskRole = DelegatedTaskRole;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt,
  target: Schema.optional(OrchestratorMcpTarget),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "'shared' (default): parent checkout. 'worktree': new prepared checkout from the parent commit, for a separate checkout or PR per child. Uncommitted edits stay out. With `target.projectId` of another local project: a worktree of that repository from its default branch.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Default 'async'. 'wait' only if this turn needs the result. A question or approval ends the wait.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description: "Mode 'wait' only. Default 10 min. A timeout does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Omit unless the user asks for a supervised child. Narrow modes pause for human approval, not read-only. Above yours is rejected.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

// Set only on results for still-running tasks whose completion will wake the parent.
export const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT =
  "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
const OrchestratorMcpRunningTaskNext = Schema.Literal(ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  taskId: NodeId,
  /** Null for a task that runs in a linked environment; see `remoteChild`. */
  childThreadId: Schema.NullOr(ThreadId),
  /** The linked environment and thread a remote task runs as. */
  remoteChild: Schema.optional(
    Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId, label: Schema.String }),
  ),
  link: Schema.optional(Schema.String),
  /** What a `t3_command_run` task runs, and where its output goes. */
  command: Schema.optional(OrchestrationV2TaskCommand),
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  hasPendingQuestion: Schema.Boolean.annotate({
    description:
      "A question blocks the child and ends a wait. Answer via `t3_pending_request` on `childThreadId`, or the user does.",
  }),
  pendingApproval: Schema.NullOr(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind, runId: RunId }),
  ).annotate({
    description: "Oldest pending approval, or null. Ends a wait. Grants no approval rights.",
  }),
  waitTimedOut: Schema.Boolean.annotate({
    description: "True only on the timed-out wait call. The child keeps running.",
  }),
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES = 60;
const ORCHESTRATOR_MCP_COMMAND_MAX_TIMEOUT_MINUTES = 720;

export const OrchestratorMcpRunCommandInput = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  cwd: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
      description: "Absolute, or relative to this thread's checkout (the default).",
    }),
  ),
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  timeoutMinutes: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: ORCHESTRATOR_MCP_COMMAND_MAX_TIMEOUT_MINUTES }),
    ).annotate({
      description: `Default ${ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES}. The command is stopped after it.`,
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpRunCommandInput = typeof OrchestratorMcpRunCommandInput.Type;

export const OrchestratorMcpRunCommandResult = Schema.Struct({
  taskId: NodeId,
  logPath: Schema.String,
  timeoutMinutes: PositiveInt,
  next: OrchestratorMcpRunningTaskNext,
});
export type OrchestratorMcpRunCommandResult = typeof OrchestratorMcpRunCommandResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  auto: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true: Auto mode, on the model and account Settings pick. Not with `target`. Omit to inherit.",
    }),
  ),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description: "Project to use. Default: your thread's project. Required outside a thread.",
  }),
);

/**
 * A linked environment to act in instead of this one. The tools that take it
 * forward the call there, where the link's access and the caller's own modes
 * both apply.
 */
export const OrchestratorMcpEnvironmentTarget = Schema.optional(
  EnvironmentId.annotate({
    description:
      "Linked environment to act in. Omit for this one. Ids are then that environment's.",
  }),
);

export const OrchestratorMcpThreadListInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: OrchestratorMcpProjectTarget,
  allProjects: Schema.optional(Schema.Boolean),
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  fields: Schema.optional(Schema.Literals(["compact", "full"])),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

/** state is null until the host is read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  link: Schema.optional(Schema.String),
  status: OrchestratorMcpThreadStatus,
  model: Schema.String,
  updatedAt: IsoDateTime,
  parentThreadId: Schema.NullOr(ThreadId),
  /** The sidebar folder, only when the thread is in one. */
  folder: Schema.optional(Schema.String),
  /** With `allProjects` or `fields: "full"`. */
  projectId: Schema.optional(ProjectId),
  // The rest comes with `fields: "full"`.
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  latestRunId: Schema.optional(Schema.NullOr(RunId)),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  settled: Schema.optional(Schema.Boolean),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozed: Schema.optional(Schema.Boolean),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  relationshipToParent: Schema.optional(Schema.NullOr(Schema.Literals(["fork", "subagent"]))),
  itemCount: Schema.optional(NonNegativeInt),
  createdAt: Schema.optional(IsoDateTime),
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  /** null with `allProjects`. */
  projectId: Schema.NullOr(ProjectId),
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
export const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(clampedPositiveInt(100)).annotate({
    description: "Max items, 1 to 100.",
  }),
  runLimit: Schema.optional(clampedPositiveInt(50)).annotate({
    description: "Max recent runs, 1 to 50.",
  }),
  maxCharsPerItem: Schema.optional(clampedPositiveInt(50_000)).annotate({
    description: "Max chars per item, 1 to 50000.",
  }),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  link: Schema.optional(Schema.String),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  senderThreadId: Schema.optional(ThreadId),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.optional(Schema.Array(OrchestratorMcpThreadRun)),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  continuationOfRunId: Schema.optional(
    RunId.annotate({
      description:
        "To resume a stopped run: the send fails unless that run is still the thread's latest and it stopped on a usage limit, a network error or an interrupt.",
    }),
  ),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  messageId: MessageId,
  runId: RunId,
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Finite),
  untilDelegatedWorkSettled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also wait for its delegated and background tasks and their completions to settle. `resultRun` then names the run with its final answer.",
    }),
  ),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
  /** With untilDelegatedWorkSettled, once settled: the run whose reply is the thread's result. */
  resultRun: Schema.optional(Schema.Struct({ runId: RunId, status: OrchestrationV2RunStatus })),
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  /**
   * Stop the thread as its Stop button does instead: interrupt its running
   * turn whichever run that is, hold its queued messages, end its pull request
   * watches and stop every task it delegated. `runId` is then not used.
   */
  stop: Schema.optional(Schema.Boolean),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  search: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Match model ids and labels. Replaces the short list.",
    }),
  ),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpModelOption = Schema.Struct({
  id: Schema.String,
  values: Schema.Array(ProviderOptionSelectionValue),
  default: Schema.optional(ProviderOptionSelectionValue),
});
export type OrchestratorMcpModelOption = typeof OrchestratorMcpModelOption.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Omitted when it only restates the id. */
      label: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
      usageLimited: Schema.optional(Schema.Literal(true)),
    }),
  ),
  /** Models left out of `models`: unlisted visible models, or matches past the cap with `search`. */
  omittedModels: Schema.optional(NonNegativeInt),
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
  limitedUntil: Schema.optional(
    Schema.String.annotate({
      description: "Provider reset or T3 hold end (ISO time). Pick another account.",
    }),
  ),
  limitedUntilEstimated: Schema.optional(
    Schema.Literal(true).annotate({
      description:
        "limitedUntil is T3's guess, not a reset the provider reported. The account may run sooner, and ChatGPT's connected-app cap is tried again hourly.",
    }),
  ),
  usageLimited: Schema.optional(
    Schema.Literal(true).annotate({
      description: "Usage-limited until limitedUntil (provider reset or T3 hold).",
    }),
  ),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpEnvironmentLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Whether it answered just now. An expired link must be linked again there. */
  status: Schema.Literals(["reachable", "unreachable", "expired"]),
  /** The most the linked environment lets this one's agents do there. */
  access: AuthMcpClientAccess,
  expiresAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
export type OrchestratorMcpEnvironmentLink = typeof OrchestratorMcpEnvironmentLink.Type;

export const OrchestratorMcpEnvironmentLinksResult = Schema.Struct({
  environmentId: EnvironmentId,
  links: Schema.Array(OrchestratorMcpEnvironmentLink),
  /** What to do when the machine the user means is not among `links`. */
  notListed: Schema.String,
  /** Linking is for agents only: it does not put a machine in the app's machine list. */
  appList: Schema.String,
});
export type OrchestratorMcpEnvironmentLinksResult =
  typeof OrchestratorMcpEnvironmentLinksResult.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  inheritedOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

const scheduledTaskRunConditionField = {
  runCondition: Schema.optional(Schema.NullOr(ScheduledTaskRunConditionInput)).annotate({
    description:
      "Command run before each scheduled occurrence, in the project folder, no shell: exit 0 starts the chat, 10 skips it and records the last output line or its JSON `reason`, anything else starts the chat. `~/` is the home folder. Run now ignores it. Needs full access. Null clears.",
  }),
};

const scheduledTaskPromptFileField = {
  promptFile: Schema.optional(Schema.NullOr(ScheduledTaskPromptFilePath)).annotate({
    description:
      "Instead of `prompt`: a file in the project's git repository, path from its root. Each run reads it from the remote's default branch, so a push changes the next run. Null: back to `prompt`.",
  }),
};

const scheduledTaskMachineOrderField = {
  machineOrder: Schema.optional(Schema.Array(EnvironmentId).check(Schema.isMaxLength(50))).annotate(
    {
      description:
        "With oneMachine: the order the project's machines try all its one-machine tasks in, first first. This machine's id and t3_environment_links ids. Replaces it; omit to keep it.",
    },
  ),
};

const scheduledTaskModelFields = {
  modelSelection: Schema.optional(CanonicalModelSelection).annotate({
    description:
      "Own model for new-thread runs; autoAccount:true selects Auto. Not for a bound task.",
  }),
  followsDefaultModel: Schema.optional(Schema.Boolean).annotate({
    description:
      "Follow the task default. True unless modelSelection is given; cannot combine true with it.",
  }),
};

const OrchestratorMcpCatchUpMissedRun = Schema.Boolean.annotate({
  description:
    "fixed_time only. True: a run missed while the app was off runs once when it is back, if nearer than the next run. Default true; omit to keep.",
});

const OrchestratorMcpDelegateProviders = ScheduledTaskDelegateProviders.annotate({
  description:
    'Drivers it hands work to with delegate_task, e.g. ["codex"]. A scheduled run is skipped while all accounts of one are out of usage.',
});

const OrchestratorMcpMaxLiveRuns = ScheduledTaskMaxLiveRuns.annotate({
  description:
    "New-thread repeating task: its runs that may work at once, delegated tasks included; a scheduled run is skipped at the limit. Default 1; omit to keep.",
});

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  ...scheduledTaskModelFields,
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: OrchestratorMcpProjectTarget,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  ...scheduledTaskPromptFileField,
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true: runs post in this thread. False: new thread per run.",
    }),
  ),
  shared: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True: same task on each of the user's machines, each running it. New thread per run; no webhook.",
    }),
  ),
  oneMachine: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "With shared: each run happens on one machine, the first available in the project's machine order.",
    }),
  ),
  excludedMachines: Schema.optional(
    Schema.Array(EnvironmentId).check(Schema.isMaxLength(50)),
  ).annotate({
    description:
      "With shared: machines (t3_environment_links ids) that keep no copy. Replaces the list; omit to keep it.",
  }),
  ...scheduledTaskMachineOrderField,
  placement: Schema.optional(ScheduledTaskPlacement).annotate({
    description:
      "Where it shows in the user's thread list: none (hidden), chat (runs as normal chats), pinned (a task row). Omit to keep the current one, or for new tasks the user's default.",
  }),
  ...scheduledTaskRunConditionField,
  catchUpMissedRun: Schema.optional(OrchestratorMcpCatchUpMissedRun),
  group: Schema.optional(Schema.NullOr(ScheduledTaskGroupLabel)).annotate({
    description:
      'Group label, e.g. "Machine care". The user\'s task list sorts the task under it, and the chats it starts go in a sidebar folder with that name. Reuse an existing label (list_scheduled_tasks). Null clears; omit to keep.',
  }),
  delegateProviders: Schema.optional(OrchestratorMcpDelegateProviders),
  maxLiveRuns: Schema.optional(OrchestratorMcpMaxLiveRuns),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** `schedule_task` creates a task, or updates one when `scheduledTaskId` is given. */
export const OrchestratorMcpSaveScheduledTaskInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  prompt: Schema.optional(OrchestratorMcpPrompt),
  schedule: Schema.optional(OrchestratorMcpSchedule),
});
export type OrchestratorMcpSaveScheduledTaskInput =
  typeof OrchestratorMcpSaveScheduledTaskInput.Type;

/**
 * When an occurrence of a scheduled task was due. Peers match runs to occurrences by it, so a late
 * run of one is never taken for the next. A fixed-time task's has no offset: each machine reads it
 * in its own zone, where that fixed time comes due.
 */
export const OrchestratorMcpScheduledOccurrence = IsoDateTime.annotate({
  description: "When the occurrence was due. fixed_time: local time, no offset.",
});

export const OrchestratorMcpScheduledTask = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  followsDefaultModel: Schema.optional(Schema.Boolean),
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.optional(Schema.String),
  promptFile: Schema.optional(ScheduledTaskPromptFile).annotate({
    description:
      "Each run reads its prompt from this file. `prompt` is the text this machine's `lastRead` found.",
  }),
  // Absent from servers that always sent the full prompt.
  promptPreview: Schema.optional(Schema.String),
  promptHash: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: no T3 Connect tunnel. The user must enable T3 Connect remote access.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])),
  blockedByPolicy: Schema.optional(Schema.String).annotate({
    description: "Present when an administrator's policy stops this task from running.",
  }),
  placement: Schema.optional(ScheduledTaskPlacement),
  group: Schema.optional(Schema.String),
  shared: Schema.optional(Schema.Boolean),
  oneMachine: Schema.optional(Schema.Boolean),
  excludedMachines: Schema.optional(Schema.Array(EnvironmentId)),
  machineOrder: Schema.optional(Schema.Array(EnvironmentId)).annotate({
    description: "One-machine task: the project's machines, first to try first. Empty: none set.",
  }),
  definedOn: Schema.optional(EnvironmentId).annotate({
    description: "Shared task: the machine whose save is its current definition.",
  }),
  definedAt: Schema.optional(IsoDateTime).annotate({
    description: "Shared task: when that save happened.",
  }),
  changedBy: Schema.optional(ScheduledTaskChangedBy).annotate({
    description:
      "Who made the latest change: ui is a person in the app; mcp is an agent, with threadId the chat or run (on definedOn) or client. Absent: unknown.",
  }),
  runCondition: Schema.optional(ScheduledTaskRunCondition),
  checkingSince: Schema.optional(IsoDateTime).annotate({
    description: "Its run condition is running now, for occurrence `checkingFor`, since this time.",
  }),
  checkingFor: Schema.optional(OrchestratorMcpScheduledOccurrence),
  lastSkipped: Schema.optional(
    Schema.Struct({
      ...ScheduledTaskNoWorkSkip.fields,
      occurrence: Schema.optional(Schema.NullOr(OrchestratorMcpScheduledOccurrence)),
    }),
  ).annotate({
    description: "The last occurrence its run condition skipped for no work, and why.",
  }),
  catchUpMissedRun: Schema.optional(Schema.Boolean).annotate({
    description: "fixed_time only: a run missed while the app was off runs once when it is back.",
  }),
  delegateProviders: Schema.optional(ScheduledTaskDelegateProviders),
  maxLiveRuns: Schema.optional(ScheduledTaskMaxLiveRuns),
  liveRuns: Schema.optional(NonNegativeInt).annotate({
    description:
      "New-thread repeating task: its runs here that still work, delegated tasks included.",
  }),
  lastRun: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        at: IsoDateTime,
        outcome: Schema.Literals(["working", "completed", "failed"]),
        stopped: Schema.optional(Schema.Literal(true)),
        occurrence: Schema.optional(Schema.NullOr(OrchestratorMcpScheduledOccurrence)),
      }),
    ),
  ).annotate({
    description:
      "The last run here. working: its thread is still going. stopped: a user or agent stopped it on purpose. occurrence: null when run now or by a webhook.",
  }),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Default: your thread's project, or all outside a thread.",
    }),
  ),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  includePrompt: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

/** For a linked machine: the shared tasks it may hold, so it can pull newer copies with no client open. */
export const OrchestratorMcpSharedScheduledTasksInput = Schema.Struct({
  forEnvironmentId: EnvironmentId,
});
export type OrchestratorMcpSharedScheduledTasksInput =
  typeof OrchestratorMcpSharedScheduledTasksInput.Type;

export const OrchestratorMcpSharedScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(ScheduledTaskSharedCopy),
  deletions: Schema.Array(ScheduledTaskSharedDeletion),
  projectMachineOrders: Schema.Array(ScheduledTaskProjectMachineOrder),
});
export type OrchestratorMcpSharedScheduledTasksResult =
  typeof OrchestratorMcpSharedScheduledTasksResult.Type;

/**
 * For a linked machine: records which machine holds one occurrence of a one-machine task, so a
 * machine that cannot reach the holder still learns of it from the others. `holder` takes the
 * occurrence when it is free or held by `replaces`; the caller may only take it for itself or hand
 * on what it holds.
 */
export const OrchestratorMcpClaimScheduledTaskOccurrenceInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  occurrence: OrchestratorMcpScheduledOccurrence,
  holder: EnvironmentId,
  replaces: Schema.NullOr(EnvironmentId),
});
export type OrchestratorMcpClaimScheduledTaskOccurrenceInput =
  typeof OrchestratorMcpClaimScheduledTaskOccurrenceInput.Type;

/** The machine that holds the occurrence after the call. */
export const OrchestratorMcpClaimScheduledTaskOccurrenceResult = Schema.Struct({
  holder: EnvironmentId,
});
export type OrchestratorMcpClaimScheduledTaskOccurrenceResult =
  typeof OrchestratorMcpClaimScheduledTaskOccurrenceResult.Type;

/** For a linked machine: the shared settings this machine knows, so it can catch up with no client open. */
export const OrchestratorMcpSharedSettingsResult = Schema.Struct({
  versions: Schema.Array(SharedSettingVersion),
});
export type OrchestratorMcpSharedSettingsResult = typeof OrchestratorMcpSharedSettingsResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  ...scheduledTaskModelFields,
  environmentId: OrchestratorMcpEnvironmentTarget,
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  ...scheduledTaskPromptFileField,
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
  shared: Schema.optional(Schema.Boolean),
  oneMachine: Schema.optional(Schema.Boolean),
  excludedMachines: Schema.optional(
    Schema.Array(EnvironmentId).check(Schema.isMaxLength(50)),
  ).annotate({
    description:
      "With shared: machines (t3_environment_links ids) that keep no copy. Replaces the list; omit to keep it.",
  }),
  ...scheduledTaskMachineOrderField,
  placement: Schema.optional(ScheduledTaskPlacement),
  ...scheduledTaskRunConditionField,
  catchUpMissedRun: Schema.optional(Schema.Boolean),
  group: OrchestratorMcpScheduleTaskInput.fields.group,
  delegateProviders: Schema.optional(ScheduledTaskDelegateProviders),
  maxLiveRuns: Schema.optional(ScheduledTaskMaxLiveRuns),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "Card title, such as 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "What it is for and where to get it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString),
  delivery: Schema.optional(Schema.Literals(["secretRef", "file"])).annotate({
    description:
      'secretRef (default) for a T3 tool. file for a shell CLI: read the path in your command, e.g. TOKEN="$(cat <file>)" wrangler whoami.',
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "Default 10 min." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Retry key for this ask. New key after a timeout or cancel.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    secretRef: SecretRef.annotate({
      description: "One-use. Pass to a tool that accepts a secretRef. You never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "file holds the value." }),
    file: Schema.String.annotate({
      description:
        "Owner-only file with the value. Read it inside commands and never print it. Deleted after 24 hours.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: user chose not to. cancelled: ended with the run. timed_out: no answer in time. Ask again with a new `clientRequestId` if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

export const OrchestratorMcpAskUserInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: TrimmedNonEmptyString.annotate({
        description: "The money decision, with its cost or risk.",
      }),
      header: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(24))).annotate({
        description: "Short label, e.g. 'Approve'.",
      }),
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
            description: Schema.optional(TrimmedNonEmptyString),
          }),
        ).check(Schema.isMaxLength(4)),
      ).annotate({ description: "One-tap answers. The user can always type their own." }),
      multiSelect: Schema.optional(Schema.Boolean),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Retry key for this ask.",
  }),
});
export type OrchestratorMcpAskUserInput = typeof OrchestratorMcpAskUserInput.Type;

export const OrchestratorMcpAskUserResult = Schema.Struct({
  status: Schema.Literal("asked").annotate({
    description:
      "Waiting in this thread and in Needs you. The answer arrives as your next message: end your turn.",
  }),
  requestId: RuntimeRequestId,
});
export type OrchestratorMcpAskUserResult = typeof OrchestratorMcpAskUserResult.Type;

export const OrchestratorMcpEnvironmentLinkInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId).annotate({
    description:
      "The machine, when known, e.g. from a mentioned machine. Otherwise the user picks it in the card.",
  }),
  url: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Only an address the user gave: https, Tailscale, LAN or loopback. Never guess one.",
  }),
  hint: Schema.optional(TrimmedNonEmptyString).annotate({
    description: 'The user\'s words for the machine, e.g. "vps". Preselects it in the card.',
  }),
  reason: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "One sentence for the card.",
  }),
  requestedAccess: Schema.optional(AuthMcpClientAccess).annotate({
    description: "Suggested access. The user picks; default approval-required.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpEnvironmentLinkInput = typeof OrchestratorMcpEnvironmentLinkInput.Type;

export const OrchestratorMcpEnvironmentLinkResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending").annotate({
      description:
        "The card is waiting for the user. Their answer arrives as a message in this thread.",
    }),
    turnItemId: TurnItemId,
  }),
  Schema.Struct({
    status: Schema.Literal("linked"),
    environmentId: EnvironmentId.annotate({
      description: "Pass it as environmentId to act there; t3_environment_links lists it.",
    }),
    label: Schema.String,
    access: AuthMcpClientAccess.annotate({ description: "The access the user chose." }),
    note: Schema.String.annotate({
      description: "Linked for agents only: it is not added to the app's machine list.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the card closed unanswered, when the thread was stopped or archived.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    message: Schema.String.annotate({
      description: "Why the other environment refused the link, as the user saw it.",
    }),
  }),
]);
export type OrchestratorMcpEnvironmentLinkResult = typeof OrchestratorMcpEnvironmentLinkResult.Type;

export const OrchestratorMcpEnvironmentUnlinkInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "The linked environment to forget, from t3_environment_links.",
  }),
});
export type OrchestratorMcpEnvironmentUnlinkInput =
  typeof OrchestratorMcpEnvironmentUnlinkInput.Type;

export const OrchestratorMcpEnvironmentUnlinkResult = Schema.Struct({
  environmentId: EnvironmentId,
  removed: Schema.Boolean,
});
export type OrchestratorMcpEnvironmentUnlinkResult =
  typeof OrchestratorMcpEnvironmentUnlinkResult.Type;

/**
 * A linked environment asking this one to link back to it. The environment that linked this
 * one made a pairing code of its own for it; the code travels only over that link.
 */
export const OrchestratorMcpLinkBackInput = Schema.Struct({
  environmentId: EnvironmentId.annotate({
    description: "The environment that linked this one, and the one to link back to.",
  }),
  label: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "What the user calls it, to name it when it cannot be reached.",
  }),
  urls: Schema.NonEmptyArray(TrimmedNonEmptyString).annotate({
    description: "Where it answers, most preferred first. Only those that prove to be it are used.",
  }),
  pairingCode: TrimmedNonEmptyString.annotate({
    description: "A one-use pairing code from that environment.",
  }),
  access: AuthMcpClientAccess.annotate({
    description: "What agents here may do there.",
  }),
});
export type OrchestratorMcpLinkBackInput = typeof OrchestratorMcpLinkBackInput.Type;

export const OrchestratorMcpLinkBackResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  access: AuthMcpClientAccess,
});
export type OrchestratorMcpLinkBackResult = typeof OrchestratorMcpLinkBackResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
      "memory_short",
    ]),
    message: Schema.String,
  },
) {}
