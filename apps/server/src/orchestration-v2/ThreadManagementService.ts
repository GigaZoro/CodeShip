import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import type {
  ActiveThreadListEntry,
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  CommandId,
  isDelegatedAppThread,
  isListedThreadLineage,
  isProviderInstanceBackgroundAllowed,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2LinkedSender,
  type OrchestrationV2Run,
  isOrchestrationV2WorkActive,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  type ProviderSessionId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
  isOrchestrationV2TerminalRunStatus,
  type OrchestrationV2TerminalRunStatus,
} from "@t3tools/contracts";
import {
  delegatedTaskProgress,
  delegatedWorkPending,
} from "@t3tools/provider-core/server/subagentProjection";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import { quietPastLimit } from "@t3tools/shared/orchestrationTiming";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { boundedCandidates, type DispatchRecorder, evidenceKey } from "./StopDecisionEvidence.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import { threadPullRequestsOf } from "../sourceControl/threadPullRequests.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { turnItemDetailResult } from "./WireProjection.ts";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import { contextBoundaryOrdinal } from "./contextBoundary.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ThreadWorktreeRestore } from "../workspace/restoreMissingWorktree.ts";
import { checkOutput, outputRequestProblem } from "./runOutput.ts";
import { routineSpan } from "@t3tools/shared/observability";

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create": {
      // Only the server stamps a link's origin or folds in a first message, so a client cannot.
      const {
        linkOrigin: _linkOrigin,
        delegatedFrom: _delegatedFrom,
        initialMessage: _initialMessage,
        workflowRun: _workflowRun,
        ...rest
      } = command;
      return { ...rest, ...provenance };
    }
    case "message.dispatch":
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark and open stats; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "delegated_task.remote.request":
    case "delegated_task.remote.complete":
    case "delegated_task.remote.stop":
    case "delegated_task.remote.attach-run":
    case "delegated_task.command.request":
    case "delegated_task.command.start":
    case "delegated_task.command.complete":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export interface ThreadManagementSendInput {
  readonly demandId?: string | null;
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly linkedSender?: OrchestrationV2LinkedSender;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  /** Starts only while this stopped run is still the thread's latest (see the Orchestrator). */
  readonly manualContinuationOfRunId?: RunId;
  /** Start a new provider session; the orchestrator queues it instead of steering. */
  readonly freshContext?: boolean;
  /** Ask the run for a result as data matching this JSON Schema; it is queued, never steered. */
  readonly outputSchema?: Readonly<Record<string, Schema.Json>>;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
  /**
   * Also wait until the thread's own delegated work settles: an ended run
   * still owes the thread's answer while a child, a background task or a
   * completion delivery will wake it again, as a delegated task's result does.
   */
  readonly untilDelegatedWorkSettled?: boolean;
  /**
   * Also wait until the run has the result it was asked for. A turn may end without one while
   * its agent waits to be woken, and submit it from a later turn.
   */
  readonly untilOutput?: boolean;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
  /** With `untilDelegatedWorkSettled`, once settled: the run with the thread's final answer. */
  readonly resultRun?: OrchestrationV2Run;
}

/** Its own agent's settle or archive mid-turn applies when the turn ends. */
export interface ThreadManagementOrganizeInput {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly action: "settle" | "archive";
  readonly byOwnAgent: boolean;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: OrchestrationV2TerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementRunOutputRejectedError extends Schema.TaggedError<ThreadManagementRunOutputRejectedError>()(
  "ThreadManagementRunOutputRejectedError",
  {
    threadId: ThreadId,
    /** One of a few fixed sentences. What a submission got wrong is in `cause`. */
    problem: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.problem;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.projectId === undefined
      ? "Unable to list threads."
      : `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementWorktreeRestoreError extends Schema.TaggedError<ThreadManagementWorktreeRestoreError>()(
  "ThreadManagementWorktreeRestoreError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Couldn't recreate the missing workspace of thread ${this.threadId}, so the message was not sent.${detail}`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
    reason: Schema.optionalKey(Schema.Literals(["disabled", "background_disallowed"])),
  },
) {
  override get message(): string {
    return this.reason === "background_disallowed"
      ? `Provider instance "${this.instanceId}" is reserved for interactive chats only (background runs disabled).`
      : `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export class ThreadManagementBackgroundWaitError extends Schema.TaggedError<ThreadManagementBackgroundWaitError>()(
  "ThreadManagementBackgroundWaitError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["unsupported", "unavailable", "failed", "unmatched"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This provider cannot mark background work as awaited.";
      case "unavailable":
        return "This thread has no live provider session.";
      case "failed":
        return "Failed to update the awaited background work.";
      case "unmatched":
        return "None of these IDs is running background work on this thread, so this request registers no wait for them. If the task already finished, read its output now. Otherwise pass the task ID of a background command or Monitor you started. Subagent, Agent tool, and Workflow runs already keep the thread working until they finish, and delegate_task IDs don't go here either.";
    }
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementRunOutputRejectedError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
  ThreadManagementWorktreeRestoreError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
    recorder?: DispatchRecorder,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  readonly getRunCount: Orchestrator.OrchestratorV2["Service"]["getRunCount"];
  readonly getMessagesById: Orchestrator.OrchestratorV2["Service"]["getMessagesById"];
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadTranscript,
    Orchestrator.OrchestratorV2Error | ThreadTranscriptTooLargeError,
    ServerEnvironment.ServerEnvironmentIdentity
  >;
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getAgentAwarenessSnapshot: Orchestrator.OrchestratorV2["Service"]["getAgentAwarenessSnapshot"];
  readonly getShellSnapshot: (
    options?: Pick<
      ShellSnapshotOptions,
      "location" | "projectId" | "unsettledOnly" | "worktreePath" | "threadIds"
    >,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>;
  readonly listActiveSubagentThreadIds: Orchestrator.OrchestratorV2["Service"]["listActiveSubagentThreadIds"];
  readonly countThreads: Orchestrator.OrchestratorV2["Service"]["countThreads"];
  readonly listActiveShellIndex: Orchestrator.OrchestratorV2["Service"]["listActiveShellIndex"];
  readonly listOlderSettledThreads: Orchestrator.OrchestratorV2["Service"]["listOlderSettledThreads"];
  readonly readShellSnapshot: (
    options?: Pick<ShellSnapshotOptions, "location" | "familyOf" | "worktreePath" | "threadIds">,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listAppOwnedChildThreadIds: Orchestrator.OrchestratorV2["Service"]["listAppOwnedChildThreadIds"];
  readonly getThreadLinkMetadata: Orchestrator.OrchestratorV2["Service"]["getThreadLinkMetadata"];
  readonly getThreadTitles: Orchestrator.OrchestratorV2["Service"]["getThreadTitles"];
  /** Omit `projectId` to list every project's threads. Side chats are never listed. */
  readonly listProjectThreads: (input: {
    readonly projectId?: ProjectId | undefined;
    readonly includeSubagents: boolean;
    readonly location?: "active" | "archive" | undefined;
  }) => Effect.Effect<ReadonlyArray<ActiveThreadListEntry>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  /** Stores what the thread's running turn returns, once it fits the schema that turn declared. */
  readonly submitRunOutput: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly json: string;
  }) => Effect.Effect<{ readonly runId: RunId }, ThreadManagementFailure>;
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
    readonly background?: boolean | undefined;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /** Receipt replays start no work; skip enablement checks with the same command id so settings cannot reject accepted retries. */
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly acceptedCommandSequence: (
    commandId: CommandId,
  ) => Effect.Effect<number | undefined, Orchestrator.OrchestratorDispatchError>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /** Waits for the agent's run, and any notification or delegated result runs that follow it, to
   * end before settling or archiving its thread and stopping the session. Other endings or refusals
   * leave the thread active. */
  readonly organizeAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly action: "settle" | "archive";
  }) => Effect.Effect<void, ThreadManagementFailure>;
  readonly organizeThread: (
    input: ThreadManagementOrganizeInput,
  ) => Effect.Effect<
    | { readonly sequence: number }
    | { readonly settlesWhenTurnEnds: true }
    | { readonly archivesWhenTurnEnds: true },
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Kills the thread's agent for a provider that no longer responds, then ends
   * its turn as interrupted. Never kills a process other working threads share.
   */
  readonly forceStopThread: (
    input: OrchestrationV2ForceStopThreadInput,
  ) => Effect.Effect<OrchestrationV2ForceStopThreadResult, OrchestrationV2ForceStopThreadError>;
  readonly awaitBackgroundTasks: (input: {
    readonly threadId: ThreadId;
    readonly taskIds: ReadonlyArray<string>;
    readonly awaited: boolean;
  }) => Effect.Effect<
    { readonly matched: ReadonlyArray<string>; readonly unmatched: ReadonlyArray<string> },
    ThreadManagementBackgroundWaitError
  >;
  readonly stopDelegatedTasks: (input: {
    readonly remoteDispatch?: Orchestrator.OrchestratorV2["Service"]["dispatch"];
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    void,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly cancelDelegatedTask: Orchestrator.OrchestratorV2["Service"]["cancelDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly restartContinuationPending: Orchestrator.OrchestratorV2["Service"]["restartContinuationPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export const ACTIVE_RUN_STATUSES = [
  "preparing",
  "starting",
  "running",
  "waiting",
] as const satisfies ReadonlyArray<OrchestrationV2Run["status"]>;

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (ACTIVE_RUN_STATUSES as ReadonlyArray<OrchestrationV2Run["status"]>).includes(run.status);
}

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

/**
 * A chat works while any of its runs is unfinished, a task it delegated or its own background work
 * still runs, or a run a server restart cut waits for its continuation. A later run that ended,
 * such as a queued one someone cancelled, does not hide it.
 */
export function threadStillWorking(
  threadManagement: Pick<ThreadManagementServiceShape, "restartContinuationPending">,
  records: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents" | "providerThreads">,
): Effect.Effect<boolean> {
  const { runs } = records;
  if (
    runs.some((run) => !isOrchestrationV2TerminalRunStatus(run.status)) ||
    delegatedWorkPending(records)
  ) {
    return Effect.succeed(true);
  }
  const continued = new Set(runs.flatMap((run) => run.restartContinuationOfRunId ?? []));
  return Effect.forEach(
    runs.filter((run) => run.status !== "completed" && !continued.has(run.id)),
    threadManagement.restartContinuationPending,
  ).pipe(Effect.map((pending) => pending.includes(true)));
}

const HOUR_MS = 60 * 60 * 1000;
// Above the longest quiet stretch real turns of each provider had while still working: Claude's
// subagents and MCP waits went 81 minutes without an event, Codex's provider retries 244.
const STALLED_TURN_QUIET_MS: Readonly<Record<string, number>> = {
  claudeAgent: 2 * HOUR_MS,
  codex: 5 * HOUR_MS,
};
const DEFAULT_STALLED_TURN_QUIET_MS = 5 * HOUR_MS;
const stalledTurnQuietMs = (driver: string | undefined) =>
  (driver === undefined ? undefined : STALLED_TURN_QUIET_MS[driver]) ??
  DEFAULT_STALLED_TURN_QUIET_MS;

const openTasks = (projection: Pick<OrchestrationV2ThreadProjection, "subagents">) =>
  projection.subagents.filter((task) => isOrchestrationV2WorkActive(task.status));

/**
 * For a chat that still works: whether nothing has happened in it, nor in the delegated work it
 * waits on, for longer than their providers' turns ever go quiet. A pending approval or question
 * counts as nothing. Work on another machine, or a command, leaves no trace here while it runs.
 */
export const stalledWork = Effect.fnUntraced(function* (
  threadManagement: Pick<ThreadManagementServiceShape, "getThreadRecords">,
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "providerThreads" | "subagents"
  >,
  now: DateTime.DateTime,
) {
  const run = projection.runs.find((candidate) =>
    ["preparing", "starting", "running", "waiting"].includes(candidate.status),
  );
  const providerThreadId = run?.providerThreadId ?? projection.thread.activeProviderThreadId;
  let limitMs = stalledTurnQuietMs(
    projection.providerThreads.find((providerThread) => providerThread.id === providerThreadId)
      ?.driver,
  );
  let lastActivity = projection.thread.updatedAt;
  const seen = new Set<ThreadId>([projection.thread.id]);
  let open = openTasks(projection);
  // Stop has something to end: a turn, the chat's tasks or its background work.
  const stoppable =
    run !== undefined ||
    open.length > 0 ||
    projection.providerThreads.some((providerThread) =>
      backgroundWorkHoldsCompletion(providerThread.pendingBackgroundTasks ?? []),
    );
  while (open.length > 0) {
    const children: Array<ThreadId> = [];
    for (const task of open) {
      if (task.remoteChild !== undefined || task.command !== undefined) return undefined;
      limitMs = Math.max(limitMs, stalledTurnQuietMs(task.driver));
      if (task.childThreadId !== null && !seen.has(task.childThreadId)) {
        seen.add(task.childThreadId);
        children.push(task.childThreadId);
      }
    }
    open = [];
    for (const childThreadId of children) {
      const child = yield* threadManagement.getThreadRecords(childThreadId, ["subagents"]);
      lastActivity = DateTime.max(lastActivity, child.thread.updatedAt);
      open.push(...openTasks(child));
    }
  }
  const quietMs = quietPastLimit({
    lastEventAt: DateTime.toEpochMillis(lastActivity),
    now: DateTime.toEpochMillis(now),
    limitMs,
  });
  return quietMs === null ? undefined : { quietMs, since: lastActivity, stoppable };
});

function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestSteerableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
const FORCE_STOP_REASON = "Force stopped by user";
const FORCE_STOP_RELEASE_WAIT = "10 seconds";
const isForceStopThreadError = Schema.is(OrchestrationV2ForceStopThreadError);

const make = Effect.gen(function* () {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const agentScope = yield* AgentScope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  // Optional so test runtimes without provider state keep every selection as sent.
  const accountRouting = yield* Effect.serviceOption(AccountRouting.AccountRouting);
  const worktreeRestore = yield* ThreadWorktreeRestore;

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) => {
                  if (
                    !resolveProjectProviderInstanceEnabled(
                      current,
                      input.projectId,
                      input.instanceId,
                    )
                  ) {
                    return new ThreadManagementProviderInstanceDisabledError({
                      projectId: input.projectId,
                      instanceId: input.instanceId,
                    });
                  }
                  if (
                    input.background === true &&
                    !isProviderInstanceBackgroundAllowed(current, input.instanceId)
                  ) {
                    return new ThreadManagementProviderInstanceDisabledError({
                      projectId: input.projectId,
                      instanceId: input.instanceId,
                      reason: "background_disallowed",
                    });
                  }
                  return Effect.void;
                }),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const readReceipt = (commandId: CommandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId,
            commandType: "receipt.read",
            cause,
          }),
      ),
    );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    readReceipt(commandId).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );

  const acceptedCommandSequence: ThreadManagementServiceShape["acceptedCommandSequence"] = (
    commandId,
  ) =>
    readReceipt(commandId).pipe(
      Effect.map((receipt) =>
        Option.isSome(receipt) && receipt.value.status === "accepted"
          ? receipt.value.resultSequence
          : undefined,
      ),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
    { attributes: routineSpan },
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );
  // Full-thread exports can otherwise hold every SQLite reader and stall ordinary thread opens.
  const transcriptExportPermits = yield* Semaphore.make(2);
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      yield* ensureProjectionTranscript(threadId);
      const byteFloor = yield* orchestrator.getTranscriptByteFloor(
        threadId,
        PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      );
      if (byteFloor > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      const { projection } = yield* orchestrator.getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
    transcriptExportPermits.withPermits(1),
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
    );

  const isBackgroundMessageDispatch = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    thread: Pick<OrchestrationV2AppThread, "delegatedFrom" | "lineage">,
  ): boolean =>
    command.scheduledTaskId !== undefined ||
    thread.delegatedFrom !== undefined ||
    thread.lineage?.relationshipToParent === "subagent" ||
    command.demandSourceRunId !== undefined ||
    (command.createdBy === "agent" && command.creationSource !== "provider");

  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "thread.metadata.update":
        return command.continuation === undefined
          ? Effect.void
          : orchestrator.getThreadRecords(command.threadId, []).pipe(
              Effect.flatMap((projection) =>
                assertProviderInstanceEnabled({
                  projectId: projection.thread.projectId,
                  commandId: command.commandId,
                  instanceId: projection.thread.modelSelection.instanceId,
                }),
              ),
            );
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
              background: isBackgroundMessageDispatch(command, projection.thread),
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              // A task in another project's worktree runs on that project's accounts.
              projectId: command.projectId ?? parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
              background: true,
            }),
          ),
        );
      case "prepared-run.release":
      case "prepared-run.retry":
        return orchestrator
          .getThreadRecords(command.threadId, ["runs", "messages"], { runIds: [command.runId] })
          .pipe(
            Effect.flatMap((projection) => {
              const run = projection.runs.find((candidate) => candidate.id === command.runId);
              if (run === undefined) return Effect.void;
              const message = projection.messages.find(
                (candidate) => candidate.id === run.userMessageId,
              );
              const background =
                projection.thread.delegatedFrom !== undefined ||
                projection.thread.lineage?.relationshipToParent === "subagent" ||
                run.delegatedTaskId !== undefined ||
                message?.scheduledTaskId !== undefined ||
                (message?.createdBy === "agent" && message.creationSource !== "provider");
              return assertProviderInstanceEnabled({
                projectId: projection.thread.projectId,
                commandId: command.commandId,
                instanceId: run.providerInstanceId,
                background,
              });
            }),
          );
      default:
        return Effect.void;
    }
  };

  /** A thread created with its first message starts that turn as a fresh thread's own would. */
  const routeCreatedThread = Effect.fn("ThreadManagementService.routeCreatedThread")(function* (
    routing: AccountRouting.AccountRouting["Service"],
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.create" }>,
  ) {
    const message = command.initialMessage;
    if (
      message === undefined ||
      message.launchAlreadyRouted === true ||
      message.crossProviderFailoverFrom !== undefined ||
      command.delegatedFrom !== undefined ||
      command.importedNativeThread !== undefined
    )
      return command;
    // A retried command keeps the account its first attempt chose.
    const receipt = yield* receipts
      .getByCommandId(command.commandId)
      .pipe(Effect.orElseSucceed(Option.none));
    if (Option.isSome(receipt)) return command;
    const scheduled = message.scheduledTaskId !== undefined;
    const launch = yield* routing.failoverLaunch({
      selection: command.modelSelection,
      projectId: command.projectId,
      scheduled,
      discoverMcpSignIns: false,
    });
    if (launch.failover?.reason === "usageLimit") {
      const from = launch.failover.crossProviderFrom;
      return {
        ...command,
        modelSelection: launch.selection,
        ...(from === undefined
          ? {}
          : { initialMessage: { ...message, crossProviderFailoverFrom: from } }),
      };
    }
    if (command.modelSelection.autoAccount !== true) return command;
    const routed = yield* routing.route({
      selection: command.modelSelection,
      projectId: command.projectId,
      currentInstanceId: null,
      started: false,
      scheduled,
    });
    return routed === command.modelSelection ? command : { ...command, modelSelection: routed };
  });

  /** Routes the first turn or an Auto turn before anything checks its target. */
  const routeDispatchAccount = (
    command: OrchestrationV2ServerCommand,
    observe?: AccountRouting.ObserveAccount,
  ): Effect.Effect<OrchestrationV2ServerCommand, Orchestrator.OrchestratorV2Error> => {
    if (Option.isNone(accountRouting)) return Effect.succeed(command);
    const routing = accountRouting.value;
    if (command.type === "thread.create") return routeCreatedThread(routing, command);
    if (
      (command.type !== "message.dispatch" && command.type !== "delegated_task.request") ||
      command.crossProviderFailoverFrom !== undefined
    ) {
      return Effect.succeed(command);
    }
    const route = Effect.fn("ThreadManagementService.routeDispatchAccount")(function* (input: {
      readonly threadId: ThreadId;
      readonly selection: ModelSelection | undefined;
      /** A delegated task's thread does not exist yet, so it starts like a new thread. */
      readonly newThread: boolean;
      /** Where the turn runs when not in `threadId`'s project: a task in another project's worktree. */
      readonly projectId?: ProjectId | undefined;
      readonly scheduled: boolean;
      readonly background: boolean;
      readonly requestPrompt?: AccountRouting.AutoRequestPrompt | undefined;
      readonly routingConstraints?: AccountRouting.AutoRoutingConstraints | undefined;
      readonly preservePreviousSelection?: boolean | undefined;
      readonly steersActiveRun?: boolean | undefined;
    }) {
      const thread = yield* orchestrator.getThreadShell(input.threadId);
      if (thread === null) return command;
      const selection = input.selection ?? thread.modelSelection;
      if (selection.quotaAwareAuto === true) return command;
      const background =
        input.background ||
        thread.delegatedFrom !== undefined ||
        thread.lineage?.relationshipToParent === "subagent";
      const fresh =
        !input.newThread &&
        command.launchAlreadyRouted !== true &&
        thread.delegatedFrom === undefined &&
        thread.latestRunId === null &&
        thread.activeProviderThreadId === null;
      const projectId = input.projectId ?? thread.projectId;
      // A retried command keeps the account its first attempt chose.
      const receipt = yield* receipts
        .getByCommandId(command.commandId)
        .pipe(Effect.orElseSucceed(Option.none));
      if (Option.isSome(receipt)) return command;
      if (fresh) {
        const launch = yield* routing.failoverLaunch({
          selection,
          projectId,
          scheduled: input.scheduled,
          ...(background && !input.scheduled ? { background: true } : {}),
          discoverMcpSignIns: false,
          // The thread itself, or the parent a delegated task is for.
          requesterThreadId: input.threadId,
          ...(selection.autoAccount === true && input.requestPrompt !== undefined
            ? { requestPrompt: input.requestPrompt }
            : {}),
          ...(selection.autoAccount === true && input.routingConstraints !== undefined
            ? { routingConstraints: input.routingConstraints }
            : {}),
        });
        if (launch.failover?.reason === "usageLimit") {
          const from = launch.failover.crossProviderFrom;
          return {
            ...command,
            modelSelection: launch.selection,
            ...(launch.degradedReason === undefined
              ? {}
              : { degradedReason: launch.degradedReason }),
            ...(from === undefined
              ? {}
              : {
                  crossProviderFailoverFrom: from,
                  ...(input.selection === undefined
                    ? {}
                    : { requestedModelSelection: input.selection }),
                }),
          };
        }
      }
      const started = !input.newThread && thread.latestRunId !== null;
      let previousSelection = started ? thread.modelSelection : undefined;
      if (
        started &&
        input.steersActiveRun !== true &&
        (thread.activeRunId != null || thread.queueHeld === true)
      ) {
        const records = yield* orchestrator
          .getThreadRecords(input.threadId, ["runs"])
          .pipe(Effect.orElseSucceed(() => null));
        const latestQueued = records?.runs
          ?.filter((run) => run.status === "queued")
          .toSorted(
            (left, right) =>
              (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
              left.ordinal - right.ordinal,
          )
          .at(-1);
        if (latestQueued !== undefined) {
          previousSelection = latestQueued.modelSelection;
        }
      }
      const routeInput = {
        ...(observe && { observe }),
        selection,
        projectId,
        // A thread that never ran starts on the highest account in the order.
        currentInstanceId:
          input.newThread || thread.activeProviderThreadId === null
            ? null
            : thread.providerInstanceId,
        started,
        scheduled: input.scheduled,
        ...(background && !input.scheduled ? { background: true } : {}),
        requesterThreadId: input.threadId,
        ...(previousSelection !== undefined ? { previousSelection } : {}),
        ...(input.preservePreviousSelection === true ? { preservePreviousSelection: true } : {}),
        ...(input.requestPrompt !== undefined ? { requestPrompt: input.requestPrompt } : {}),
        ...(input.routingConstraints !== undefined
          ? { routingConstraints: input.routingConstraints }
          : {}),
      };
      const routeResult =
        input.routingConstraints !== undefined && routing.routeWithDetails
          ? yield* routing.routeWithDetails(routeInput)
          : { selection: yield* routing.route(routeInput) };
      const routed = routeResult.selection;
      const degradedReason = routeResult.degradedReason ?? command.degradedReason;
      // A recorded continuation pins the account it was routed to, so the evidence names where it ran.
      if (
        routed === selection &&
        !(observe && input.selection === undefined) &&
        degradedReason === command.degradedReason
      ) {
        return command;
      }
      return {
        ...command,
        modelSelection: routed,
        ...(degradedReason === undefined ? {} : { degradedReason }),
      };
    });
    switch (command.type) {
      case "message.dispatch": {
        // A buffered wake is a turn the provider already started in its live session; another
        // account would restart that session and find nothing to drain. A limit fails over instead.
        if (command.createdBy === "agent" && command.creationSource === "provider") {
          return Effect.succeed(command);
        }
        const isServerContinuationOrWake =
          command.restartContinuationOfRunId !== undefined ||
          command.usageLimitContinuationOfRunId !== undefined ||
          command.automaticContinuationOfRunId !== undefined ||
          (command.creationSource === "server" && command.scheduledTaskId === undefined);
        return route({
          threadId: command.threadId,
          selection: command.modelSelection,
          newThread: false,
          scheduled: command.scheduledTaskId !== undefined,
          background:
            command.scheduledTaskId !== undefined ||
            command.demandSourceRunId !== undefined ||
            command.createdBy === "agent",
          steersActiveRun:
            command.dispatchMode.type === "steer_active" ||
            command.dispatchMode.type === "restart_active" ||
            (command.dispatchMode.type === "start_immediately" &&
              (command.deliveryIntent === "steer" || command.deliveryIntent === "restart")),
          ...(isServerContinuationOrWake
            ? { preservePreviousSelection: true }
            : {
                requestPrompt: {
                  text: command.text,
                  attachmentCount: command.attachments.length,
                },
              }),
        });
      }
      case "delegated_task.request":
        return route({
          threadId: command.parentThreadId,
          selection: command.modelSelection,
          newThread: true,
          projectId: command.projectId,
          scheduled: false,
          background: true,
          ...(command.routingConstraints === undefined
            ? {}
            : { routingConstraints: command.routingConstraints }),
          ...(command.modelSelection.autoAccount === true
            ? {
                requestPrompt: {
                  text: command.task,
                },
              }
            : {}),
        });
    }
  };

  // An agent's message to another thread is part of the work its own active run serves. Its own
  // thread keeps the steering rules for its own messages, and an unknown owner stays unattributed.
  const withSenderDemand = (
    sent: OrchestrationV2ServerCommand,
  ): Effect.Effect<OrchestrationV2ServerCommand> =>
    sent.type !== "message.dispatch" ||
    sent.demandId !== undefined ||
    sent.createdBy !== "agent" ||
    sent.senderThreadId === undefined ||
    sent.senderThreadId === sent.threadId
      ? Effect.succeed(sent)
      : orchestrator.getThreadRecords(sent.senderThreadId, ["runs"]).pipe(
          Effect.map((sender) => {
            const demandId = latestActiveRun(sender)?.demandId;
            return demandId == null ? sent : { ...sent, demandId };
          }),
          Effect.catch((cause) =>
            Effect.logWarning(
              "Could not read the sender's demand; the message stays unattributed",
              {
                threadId: sent.senderThreadId,
                cause,
              },
            ).pipe(Effect.as(sent)),
          ),
        );

  const dispatch: ThreadManagementServiceShape["dispatch"] = Effect.fn(
    "ThreadManagementService.dispatch",
  )(function* (sent, recorder) {
    const observations: Parameters<typeof boundedCandidates>[0] = [];
    const observe: AccountRouting.ObserveAccount = (instance, reason) => {
      observations.push({ id: evidenceKey(instance), reason });
    };
    const command = yield* routeDispatchAccount(
      yield* withSenderDemand(sent),
      recorder ? observe : undefined,
    );
    if (recorder) {
      const instance =
        command.type === "message.dispatch" ? command.modelSelection?.instanceId : undefined;
      const selected = instance ? evidenceKey(instance) : null;
      yield* recorder.route(selected, boundedCandidates(observations, selected));
    }
    yield* ensureCommandTranscripts(command);
    yield* assertDispatchTargetEnabled(command);
    const result = yield* orchestrator.dispatch(command);
    if (recorder && result.replayed !== true) yield* recorder.committed(result.storedEvents);
    return result;
  });

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId).pipe(
      Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)),
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.filterOrFail(
        (projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null,
        (_projection) =>
          new ThreadManagementThreadNotFoundError({
            projectId: input.projectId,
            threadId: input.threadId,
          }),
      ),
    );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    (input.location === "archive"
      ? orchestrator
          .getShellSnapshot({
            location: "archive",
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          })
          .pipe(Effect.map((snapshot) => snapshot.archivedThreads))
      : orchestrator.listActiveThreads(input.projectId)
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectThreadsListError({
            projectId: input.projectId,
            cause,
          }),
      ),
      Effect.map((threads) =>
        threads
          .filter((thread) =>
            input.includeSubagents
              ? thread.lineage.sideChat !== true
              : isListedThreadLineage(thread.lineage) && !isDelegatedAppThread(thread),
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
              right.id.localeCompare(left.id),
          ),
      ),
    );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = Effect.fn(
    "ThreadManagementService.sendToThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    // A fresh send never joins a running turn, so it needs none to steer or restart.
    const mode =
      (input.freshContext || input.outputSchema !== undefined) &&
      (input.mode === "steer" || input.mode === "restart")
        ? "queue"
        : input.mode;
    const receipt = Option.getOrUndefined(
      yield* receipts.getByCommandId(input.commandId).pipe(
        Effect.mapError(
          (cause) =>
            new Orchestrator.OrchestratorDispatchError({
              commandId: input.commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      ),
    );
    const dispatched = yield* Effect.gen(function* () {
      if (receipt?.status === "accepted") {
        if (receipt.threadId !== input.threadId) {
          return yield* new Orchestrator.OrchestratorCommandIdConflictError({
            commandId: input.commandId,
            commandType: "message.dispatch",
            receiptThreadId: receipt.threadId,
            commandThreadId: input.threadId,
          });
        }
        if (receipt.commandType !== "message.dispatch") {
          return yield* new Orchestrator.OrchestratorDispatchError({
            commandId: input.commandId,
            commandType: "message.dispatch",
            cause: "The accepted command was not a message send.",
          });
        }
        return {
          sequence: receipt.resultSequence,
          replayed: true as const,
          storedEvents: yield* orchestrator.readCommandEvents({
            commandId: input.commandId,
            type: "message.dispatch",
          }),
        };
      }
      if (target.thread.archivedAt !== null) {
        return yield* new ThreadManagementThreadArchivedError({
          threadId: input.threadId,
        });
      }
      const schemaProblem =
        input.outputSchema === undefined ? null : outputRequestProblem(input.outputSchema, input);
      if (schemaProblem !== null) {
        return yield* new ThreadManagementRunOutputRejectedError({
          threadId: input.threadId,
          problem: schemaProblem,
        });
      }
      const steerableRun = latestSteerableRun(target);
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["dispatchMode"];
      if (mode === "steer" || mode === "restart") {
        if (steerableRun === undefined) {
          return yield* new ThreadManagementNoSteerableRunError({
            threadId: input.threadId,
            mode,
          });
        }
        dispatchMode = {
          type: mode === "steer" ? "steer_active" : "restart_active",
          targetRunId: steerableRun.id,
        };
      } else if (mode === "auto" && steerableRun !== undefined) {
        dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
      } else {
        dispatchMode = {
          type: mode === "queue" ? "queue_after_active" : "start_immediately",
        };
      }

      // Turn start would fail on its own after the send reported success; a recorded rejection
      // replays its answer. A live steer and a receipt replay without a target turn need no workspace.
      if (dispatchMode.type !== "steer_active") {
        yield* worktreeRestore
          .restore(target.thread)
          .pipe(
            Effect.catch((cause) =>
              receipt === undefined
                ? Effect.fail(
                    new ThreadManagementWorktreeRestoreError({ threadId: input.threadId, cause }),
                  )
                : Effect.void,
            ),
          );
      }

      return yield* dispatch({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        sendToProjectId: input.projectId,
        messageId: input.messageId,
        ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.demandId === undefined ? {} : { demandId: input.demandId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.linkedSender === undefined ? {} : { linkedSender: input.linkedSender }),
        text: input.text,
        attachments: input.attachments,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.manualContinuationOfRunId === undefined
          ? {}
          : { manualContinuationOfRunId: input.manualContinuationOfRunId }),
        ...(input.freshContext ? { freshContext: true } : {}),
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
        ...(mode === "queue" ? { explicitQueue: true as const } : {}),
        dispatchMode,
        ...(mode === "auto" ? { deliveryIntent: "auto" } : {}),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      }).pipe(
        Effect.mapError((error) => {
          if (error._tag !== "OrchestratorSendTargetUnavailableError") return error;
          return error.reason === "archived"
            ? new ThreadManagementThreadArchivedError({ threadId: input.threadId })
            : new ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              });
        }),
      );
    });
    const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
      messageIds: [input.messageId],
      turnItemTypes: ["user_message"],
    });
    const message = projection.messages.find((candidate) => candidate.id === input.messageId);
    const acceptedMessage = dispatched.storedEvents.find(
      ({ event }) =>
        event.type === "message.updated" &&
        event.threadId === input.threadId &&
        event.payload.id === input.messageId,
    )?.event;
    const runId =
      acceptedMessage?.type === "message.updated"
        ? (acceptedMessage.payload.runId ?? acceptedMessage.runId)
        : undefined;
    const run = projection.runs.find((candidate) => candidate.id === runId);
    const turnItem =
      projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" && candidate.messageId === input.messageId,
      ) ?? null;
    const created = dispatched.storedEvents.find(
      ({ event }) =>
        event.type === "run.created" &&
        event.threadId === input.threadId &&
        event.payload.id === runId,
    )?.event;
    if (
      message === undefined ||
      run === undefined ||
      (turnItem === null &&
        !(created?.type === "run.created" && created.payload.status === "queued"))
    ) {
      return yield* new ThreadManagementDurableRunProjectionError({
        threadId: input.threadId,
        messageId: input.messageId,
      });
    }
    // The receipt records the accepted delivery even if the message later moved or its run settled.
    // A provider without interrupt-and-restart stops the turn and runs the restart as the next turn.
    const restartedAsNextTurn =
      mode === "restart" &&
      dispatched.storedEvents.some(
        ({ event }) =>
          event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request" &&
          event.payload.runId !== run.id,
      );
    const delivery: ThreadManagementSendResult["delivery"] = restartedAsNextTurn
      ? "restarted"
      : created?.type === "run.created"
        ? created.payload.status === "queued"
          ? "queued"
          : "started"
        : dispatched.storedEvents.some(
              ({ event }) =>
                event.type === "run-attempt.created" &&
                event.threadId === input.threadId &&
                event.payload.runId === runId,
            )
          ? "restarted"
          : "steered";
    return { dispatch: dispatched, projection, message, run, turnItem, delivery };
  });

  const submitRunOutput: ThreadManagementServiceShape["submitRunOutput"] = Effect.fn(
    "ThreadManagementService.submitRunOutput",
  )(function* (input) {
    const records = yield* orchestrator.getThreadRecords(input.threadId, ["runs"]);
    // A retry of a submission already taken answers for the run it went to, which a run asked for
    // a result since may have followed. Replaying the receipt ignores the command's run and value.
    const receipt = yield* receipts
      .getByCommandId(input.commandId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const anyRun = records.runs[0];
    if (Option.isSome(receipt) && receipt.value.status === "accepted" && anyRun !== undefined) {
      const replayed = yield* orchestrator.dispatch({
        type: "run.output.submit",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: anyRun.id,
        value: null,
      });
      const runId = replayed.storedEvents.find(({ event }) => event.type === "run.output-submitted")
        ?.event.runId;
      if (runId !== undefined) return { runId };
    }
    const active = latestActiveRun(records);
    // A turn that ended without its result still owes it: the agent may have ended it to wait
    // for something, and answer from the turn that woke it. Only the newest started run asked for
    // one can owe it, and only while the agent's conversation still reaches it.
    const asked = records.runs
      .filter(
        (candidate) =>
          candidate.outputSchema !== undefined &&
          candidate.status !== "queued" &&
          !cancelledBeforeStart(candidate),
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    const owing = asked?.status === "completed" && asked.output === undefined ? asked : undefined;
    const forgotten =
      owing !== undefined &&
      records.runs.some((later) => later.freshContext === true && later.ordinal > owing.ordinal) &&
      contextBoundaryOrdinal(
        yield* orchestrator.getThreadRecords(input.threadId, ["runs", "turnItems"]),
      ) > owing.ordinal;
    const owed = forgotten ? undefined : owing;
    const run = active?.outputSchema !== undefined ? active : owed;
    if (active === undefined || run?.outputSchema === undefined) {
      return yield* new ThreadManagementRunOutputRejectedError({
        threadId: input.threadId,
        problem: "This turn was not asked for a result. Reply in your message instead.",
      });
    }
    const checked = yield* checkOutput(run.outputSchema, input.json);
    if (Result.isFailure(checked)) {
      return yield* new ThreadManagementRunOutputRejectedError({
        threadId: input.threadId,
        problem: checked.failure.problem,
        ...(checked.failure.cause === undefined ? {} : { cause: checked.failure.cause }),
      });
    }
    yield* dispatch({
      type: "run.output.submit",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: run.id,
      value: checked.success,
    });
    return { runId: run.id };
  });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = Effect.fn(
    "ThreadManagementService.waitForThread",
  )(function* (input) {
    const loadError = (cause: unknown) =>
      new ThreadManagementProjectionLoadError({
        projectId: input.projectId,
        threadId: input.threadId,
        cause,
      });
    // Taken before the first read, so a run update between that read and
    // the subscription below still replays.
    const afterSequence = yield* orchestrator
      .getThreadEventSequence(input.threadId)
      .pipe(Effect.mapError(loadError));
    const target = yield* getProjectThreadRecords(input, ["runs"]);
    const selectedRun =
      input.runId === undefined
        ? latestRun(target)
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && selectedRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (selectedRun === undefined) {
      return { threadId: input.threadId, run: null, timedOut: false };
    }
    // A restart cuts a run and continues it as a new run. Follow that chain,
    // so a cut run is not the answer while its continuation is pending.
    // Runs per matching event and is already covered by the waitForThread span.
    const outcome = Effect.fnUntraced(function* (runs: ReadonlyArray<OrchestrationV2Run>) {
      const current = runs.find((candidate) => candidate.id === selectedRun.id);
      if (current === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      }
      const run = latestRestartContinuation(runs, current);
      const pending =
        isOrchestrationV2TerminalRunStatus(run.status) &&
        (yield* orchestrator.restartContinuationPending(run));
      const owesOutput =
        input.untilOutput === true &&
        run.status === "completed" &&
        run.outputSchema !== undefined &&
        run.output === undefined;
      return {
        run,
        pending,
        settled: isOrchestrationV2TerminalRunStatus(run.status) && !pending && !owesOutput,
      };
    });
    const untilDelegatedWorkSettled = input.untilDelegatedWorkSettled === true;
    const delegatedWorkResult = Effect.gen(function* () {
      const records = yield* getProjectThreadRecords(
        input,
        ["runs", "messages", "subagents", "providerThreads"],
        { messageRoles: ["user"], monitorNotificationsOnly: true },
      );
      const progress = delegatedTaskProgress(records);
      // A thread rolled back past all its work, with nothing left running, has no answer to wait for.
      if (
        progress.resultRun === undefined &&
        records.runs.every((run) => isOrchestrationV2TerminalRunStatus(run.status))
      ) {
        return latestRun(records);
      }
      if (progress.state !== "result_available") return undefined;
      const pending = yield* orchestrator
        .delegatedTaskResultPending(input.threadId)
        .pipe(Effect.mapError(loadError));
      return pending ? undefined : progress.resultRun;
    });
    const evaluate = Effect.fn("orchestrationV2.threadManagement.evaluate")(function* (
      runs: ReadonlyArray<OrchestrationV2Run>,
    ) {
      const current = yield* outcome(runs);
      if (!current.settled || !untilDelegatedWorkSettled) {
        return { ...current, resultRun: undefined };
      }
      const resultRun = yield* delegatedWorkResult;
      return { ...current, settled: resultRun !== undefined, resultRun };
    });
    const settledResult = (current: Effect.Success<ReturnType<typeof evaluate>>) => ({
      threadId: input.threadId,
      run: current.run,
      timedOut: !current.settled,
      ...(current.resultRun === undefined ? {} : { resultRun: current.resultRun }),
    });
    const initial = yield* evaluate(target.runs);
    if (initial.settled) return settledResult(initial);

    // A declined continuation records no event, so its effect settling wakes
    // the wait too.
    const wait = Stream.merge(
      Stream.mergeAll(
        (
          [
            "run.updated",
            "thread.deleted",
            ...(input.untilOutput === true ? (["run.output-submitted"] as const) : []),
            // What delegated work reads besides runs: tasks and their
            // deliveries, and a provider thread's background tasks.
            ...(untilDelegatedWorkSettled
              ? (["subagent.updated", "provider-thread.updated"] as const)
              : []),
          ] as const
        ).map((eventType) =>
          orchestrator.streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            untilDelegatedWorkSettled ||
            stored.event.type !== "run.updated" ||
            stored.event.payload.id === selectedRun.id ||
            stored.event.payload.restartContinuationOfRunId !== undefined,
        ),
      ),
      initial.pending
        ? Stream.fromEffect(orchestrator.awaitRestartContinuation(initial.run))
        : Stream.empty,
    ).pipe(
      Stream.mapEffect(() =>
        getProjectThreadRecords(input, ["runs"]).pipe(
          Effect.flatMap((current) => evaluate(current.runs)),
        ),
      ),
      Stream.filter((current) => current.settled),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
    );
    const waited = Option.flatten(yield* wait);
    if (Option.isSome(waited)) return settledResult(waited.value);
    // The run may have reached a terminal status while the timeout was
    // winning the race; the final projection read decides what actually
    // happened, so only a still-active run counts as timed out.
    return settledResult(yield* evaluate((yield* getProjectThreadRecords(input, ["runs"])).runs));
  });

  const organizeAfterRun: ThreadManagementServiceShape["organizeAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.organizeAfterRun",
  )(function* (input) {
    const requestedAt = yield* DateTime.now;
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    // A message steered into this run and read after the request supersedes it.
    const { turnItems } = yield* getProjectThreadRecords(input, ["turnItems"], {
      turnItemRunIds: [run.id],
      turnItemTypes: ["user_message"],
    });
    if (
      turnItems.some(
        (item) =>
          item.type === "user_message" &&
          (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer") &&
          item.completedAt !== null &&
          !DateTime.isLessThan(DateTime.makeUnsafe(item.completedAt), requestedAt),
      )
    )
      return;
    const afterSequence = yield* orchestrator.getThreadEventSequence(input.threadId);
    const trySettle = Effect.gen(function* () {
      const sequence = yield* orchestrator.getThreadEventSequence(input.threadId);
      const records = yield* getProjectThreadRecords(input, ["runs"]);
      // Settling ends every watch; one the agent started after asking to settle must outlive it.
      if (
        threadPullRequestsOf(records.thread).some(
          (link) =>
            link.watch !== undefined &&
            !DateTime.isLessThan(DateTime.makeUnsafe(link.watch.startedAt), requestedAt),
        )
      )
        return true;
      const later = records.runs.filter((candidate) => candidate.ordinal > run.ordinal);
      const cancelledMessageIds = later
        .filter((candidate) => candidate.status === "cancelled")
        .map((candidate) => candidate.userMessageId);
      // Send now cancels a queued run and moves its message into the running turn.
      const steeredMessageIds =
        cancelledMessageIds.length === 0
          ? new Set()
          : new Set(
              (yield* getProjectThreadRecords(input, ["messages"], {
                messageIds: cancelledMessageIds,
              })).messages
                .filter((message) => message.runId === run.id)
                .map((message) => message.id),
            );
      const following = later.filter(
        (candidate) =>
          candidate.status !== "cancelled" || !steeredMessageIds.has(candidate.userMessageId),
      );
      if (following.length > 0) {
        const { messages } = yield* getProjectThreadRecords(input, ["messages"], {
          messageRunIds: following.map((candidate) => candidate.id),
          messageRoles: ["user"],
        });
        const automaticMessageIds = new Set(
          messages
            .filter(
              (message) =>
                message.role === "user" &&
                (message.notification !== undefined || message.delegatedCompletion !== undefined),
            )
            .map((message) => message.id),
        );
        if (
          messages.some((message) => !automaticMessageIds.has(message.id)) ||
          following.some((candidate) => !automaticMessageIds.has(candidate.userMessageId))
        ) {
          return true;
        }
        if (
          following.some(
            (candidate) =>
              candidate.status !== "queued" &&
              !isOrchestrationV2TerminalRunStatus(candidate.status),
          )
        )
          return false;
        // A wake cancelled before it started (its result was already read in-turn) did nothing.
        if (
          following.some(
            (candidate) =>
              candidate.status !== "queued" &&
              candidate.status !== "completed" &&
              !cancelledBeforeStart(candidate),
          )
        )
          return true;
      }
      const latest = latestRun(records);
      if (latest === undefined) return true;
      return yield* dispatch(
        input.action === "archive"
          ? {
              type: "thread.archive",
              commandId: CommandId.make(`server:archive-after-run:${input.runId}:${sequence}`),
              threadId: input.threadId,
              onlyIfNoQueuedMessage: true,
            }
          : {
              type: "thread.settle",
              commandId: CommandId.make(`server:settle-after-run:${input.runId}:${sequence}`),
              threadId: input.threadId,
              expectedLatestRunId: latest.id,
              ...(latest.completedAt === null ? {} : { settledAt: latest.completedAt }),
            },
      ).pipe(
        Effect.as(true),
        // A notification can start between the projection read and the guarded dispatch.
        Effect.catchTags({
          OrchestratorDispatchError: () => Effect.succeed(false),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(false),
        }),
      );
    });
    yield* Stream.fromEffect(trySettle).pipe(
      Stream.concat(
        orchestrator
          .streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType: "run.updated",
          })
          .pipe(Stream.mapEffect(() => trySettle)),
      ),
      Stream.filter((done) => done),
      Stream.runHead,
      Effect.timeoutOption(Duration.millis(SETTLE_AFTER_RUN_WAIT_MS)),
    );
  });

  const organizeThread: ThreadManagementServiceShape["organizeThread"] = Effect.fn(
    "orchestrationV2.threadManagement.organizeThread",
  )(function* (input) {
    // Applying it now would stop the session serving the agent's own turn.
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* organizeAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
        action: input.action,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return input.action === "settle"
        ? ({ settlesWhenTurnEnds: true } as const)
        : ({ archivesWhenTurnEnds: true } as const);
    }
    const result = yield* dispatch({
      type: `thread.${input.action}`,
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = Effect.fn(
    "ThreadManagementService.interruptThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    const explicitRun =
      input.runId === undefined
        ? undefined
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && explicitRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (explicitRun !== undefined && isOrchestrationV2TerminalRunStatus(explicitRun.status)) {
      return {
        type: "already_terminal",
        run: explicitRun as OrchestrationV2Run & {
          readonly status: OrchestrationV2TerminalRunStatus;
        },
      } as const;
    }
    if (explicitRun?.status === "queued") {
      const dispatch = yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: explicitRun.id,
      });
      return { type: "interrupt_requested", run: explicitRun, dispatch } as const;
    }
    const interruptibleRun = latestActiveRun(target);
    if (interruptibleRun === undefined) {
      if (input.runId === undefined) {
        return { type: "no_active_run" } as const;
      }
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    const dispatch = yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: interruptibleRun.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
  });

  const forceStopThread: ThreadManagementServiceShape["forceStopThread"] = Effect.fn(
    "ThreadManagementService.forceStopThread",
  )(
    function* (input) {
      // Under the thread lock no new run can be created between the check and the kill. The
      // settlement below dispatches, which takes that lock itself, so it runs after release.
      const { records, target, killed } = yield* threadDispatch.withLock(
        input.threadId,
        Effect.gen(function* () {
          const records = yield* orchestrator.getThreadRecords(input.threadId, [
            "runs",
            "providerThreads",
            "providerTurns",
          ]);
          // The run Force stop acts on: the active one, else the latest that started. Queued
          // follow-ups never ran, so they neither count as targets nor supersede the request.
          const target =
            latestActiveRun(records) ??
            records.runs
              .filter((run) => run.status !== "queued")
              .reduce<OrchestrationV2Run | undefined>(
                (current, run) =>
                  current === undefined || run.ordinal > current.ordinal ? run : current,
                undefined,
              );
          if (input.runId !== undefined && input.runId !== target?.id) {
            return yield* new OrchestrationV2ForceStopThreadError({
              threadId: input.threadId,
              reason: "superseded",
            });
          }
          // Shared scopes are never tracked per thread, so this only kills the thread's own agent.
          const killed = yield* agentScope.kill(input.threadId);
          return { records, target, killed };
        }),
      );
      const sessionIds = new Set(
        records.providerThreads.flatMap((providerThread) =>
          providerThread.appThreadId === input.threadId && providerThread.providerSessionId !== null
            ? [providerThread.providerSessionId]
            : [],
        ),
      );
      // A run that already ended may still hold background work; settling it is a no-op otherwise.
      const run = target;
      if (run !== undefined) {
        const active = isActiveRun(run);
        const providerTurn = records.providerTurns.findLast(
          (turn) =>
            turn.runAttemptId === run.activeAttemptId && (!active || turn.status === "running"),
        );
        const commandId = CommandId.make(
          `server:force-stop:${run.id}:${yield* Clock.currentTimeMillis}`,
        );
        yield* providerTurn === undefined && !active
          ? Effect.void
          : providerTurn === undefined
            ? orchestrator.dispatch({
                type: "run.interrupt",
                commandId,
                threadId: input.threadId,
                runId: run.id,
                reason: FORCE_STOP_REASON,
              })
            : orchestrator.dispatch({
                type: "thread.background-work.settle",
                commandId,
                threadId: input.threadId,
                providerThreadId: providerTurn.providerThreadId,
                providerTurnId: providerTurn.id,
                reason: FORCE_STOP_REASON,
              });
      }
      const ownProviderThreadIds = records.providerThreads.flatMap((providerThread) =>
        providerThread.appThreadId === input.threadId ? [providerThread.id] : [],
      );
      // Settling the target can promote a queued follow-up onto the same session; that run is
      // not Force stop's to end. Only a newer run bound to a provider thread on this session
      // counts. An unreadable thread counts as one, so its sessions are kept.
      const throughRunOrdinal = target?.ordinal ?? 0;
      const laterRunActive = (providerSessionId: ProviderSessionId) =>
        orchestrator.getThreadRecords(input.threadId, ["runs", "providerThreads"]).pipe(
          Effect.map(({ runs, providerThreads }) => {
            const onSession = new Set(
              providerThreads.flatMap((providerThread) =>
                providerThread.providerSessionId === providerSessionId ? [providerThread.id] : [],
              ),
            );
            return runs.some(
              (run) =>
                run.ordinal > throughRunOrdinal &&
                isActiveRun(run) &&
                run.providerThreadId !== null &&
                onSession.has(run.providerThreadId),
            );
          }),
          Effect.orElseSucceed(() => true),
        );
      const detach = (providerSessionId: ProviderSessionId) =>
        sessions
          .detach({ providerSessionId, threadId: input.threadId, detail: FORCE_STOP_REASON })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.force-stop-detach-failed", {
                threadId: input.threadId,
                cause,
              }),
            ),
            Effect.forkIn(layerScope),
          );
      let shared = false;
      const sharedWith = new Set<ThreadId>();
      const releases: Array<{
        readonly providerSessionId: ProviderSessionId;
        readonly fiber: Fiber.Fiber<boolean, ProviderSessionManager.ProviderSessionManagerV2Error>;
      }> = [];
      for (const providerSessionId of sessionIds) {
        if (!(yield* sessions.isLive(providerSessionId))) continue;
        // Decided just before teardown, so the reply matches what happens to the process.
        const others = yield* sessions.otherWorkingThreads({
          providerSessionId,
          threadId: input.threadId,
        });
        for (const threadId of others) sharedWith.add(threadId);
        if (others.length > 0) {
          shared = true;
          yield* detach(providerSessionId);
          continue;
        }
        // The session manager re-checks atomically with turn starts and keeps a session a
        // sibling began using in the meantime.
        const fiber = yield* sessions
          .releaseUnlessBusy({
            providerSessionId,
            ownProviderThreadIds,
            throughRunOrdinal,
            // A promoted follow-up may not have marked its turn busy yet.
            keepIf: laterRunActive(providerSessionId),
            reason: "manual_shutdown",
            detail: FORCE_STOP_REASON,
          })
          .pipe(Effect.forkIn(layerScope));
        releases.push({ providerSessionId, fiber });
      }
      // Teardown waits on the provider's own exit paths; past this bound it keeps going on its own.
      let releasing = false;
      for (const release of releases) {
        const released = yield* Fiber.join(release.fiber).pipe(
          Effect.timeoutOption(FORCE_STOP_RELEASE_WAIT),
        );
        if (Option.isNone(released)) {
          releasing = true;
        } else if (!released.value && !(yield* laterRunActive(release.providerSessionId))) {
          shared = true;
          yield* detach(release.providerSessionId);
        }
      }
      return {
        outcome: killed ? "killed" : shared ? "shared" : releasing ? "releasing" : "released",
        sharedWithThreadIds: [...sharedWith],
      } as const;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isForceStopThreadError(cause)
            ? cause
            : new OrchestrationV2ForceStopThreadError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = Effect.fn(
    "ThreadManagementService.stopWorkflow",
  )(
    function* (input) {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // Check mode limits under the lock so users cannot raise modes between validation and Stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    },
    (effect, input) => effect.pipe((effect) => threadDispatch.withLock(input.threadId, effect)),
  );

  const awaitBackgroundTasks: ThreadManagementServiceShape["awaitBackgroundTasks"] = Effect.fn(
    "ThreadManagementService.awaitBackgroundTasks",
  )(function* (input) {
    const unavailable = (cause?: unknown) =>
      new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unavailable",
        ...(cause === undefined ? {} : { cause }),
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(unavailable));
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.id === records.thread.activeProviderThreadId &&
        candidate.appThreadId === input.threadId,
    );
    if (records.thread.deletedAt !== null || providerThread?.providerSessionId == null) {
      return yield* unavailable();
    }
    const runtime = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(runtime)) {
      return yield* unavailable();
    }
    if (runtime.value.awaitBackgroundTasks === undefined) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unsupported",
      });
    }
    const { matched } = yield* runtime.value
      .awaitBackgroundTasks({ providerThread, taskIds: input.taskIds, awaited: input.awaited })
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new ThreadManagementBackgroundWaitError({
              threadId: input.threadId,
              reason: "failed",
              cause,
            }),
        ),
      );
    if (input.awaited && matched.length === 0) {
      return yield* new ThreadManagementBackgroundWaitError({
        threadId: input.threadId,
        reason: "unmatched",
      });
    }
    const matchedIds = new Set(matched);
    return { matched, unmatched: input.taskIds.filter((taskId) => !matchedIds.has(taskId)) };
  });

  // Mirrors what Orchestrator's thread.stop would change; a clause missing here leaves that work running.
  const childNeedsStop = (
    child: ProjectionRecords<"runs" | "providerThreads" | "turnItems" | "subagents">,
  ): boolean => {
    if (child.thread.deletedAt !== null) return false;
    const latestRun = child.runs.findLast((run) => run.status !== "queued");
    const hasStoppableRun = child.runs.some(
      (run) =>
        run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "queued" ||
        run.delegatedCompletion?.delivery != null,
    );
    const hasPendingRecovery =
      latestRun !== undefined &&
      (latestRun.status === "cancelled" ||
        (latestRun.status === "failed" &&
          (latestRun.restartContinuationOfRunId !== undefined ||
            child.thread.limitRecovery?.runId !== latestRun.id ||
            child.thread.limitRecovery.autoResume !== false)));
    const hasPendingSubagent = child.subagents.some(
      (task) =>
        (task.origin === "provider_native" &&
          task.runId !== null &&
          isOrchestrationV2WorkActive(task.status)) ||
        (task.origin === "app_owned" &&
          (isOrchestrationV2WorkActive(task.status) ||
            (task.runId !== null &&
              task.completionDelivery?.state !== "acknowledged" &&
              task.completionDelivery?.state !== "delivered" &&
              task.completionDelivery?.state !== "disposed"))),
    );
    return (
      hasStoppableRun ||
      hasPendingRecovery ||
      child.thread.limitRecovery?.autoResume === true ||
      (child.thread.pullRequests ?? []).some((link) => link.watch !== undefined) ||
      derivePendingBackgroundWork({
        latestRun,
        providerThreads: child.providerThreads,
        turnItems: child.turnItems,
        activeProviderThreadId: child.thread.activeProviderThreadId,
        runs: child.runs,
      }).length > 0 ||
      child.turnItems.some(
        (item) => item.type === "link_request" && item.linkStatus === "pending",
      ) ||
      hasPendingSubagent
    );
  };

  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
    > = [];
    const activeChildThreadIds = new Set(
      subagents.flatMap((task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        isOrchestrationV2WorkActive(task.status)
          ? [task.childThreadId]
          : [],
      ),
    );
    const stoppedChildThreadIds = new Set<ThreadId>();
    for (const task of subagents) {
      if (task.origin !== "app_owned") continue;
      // A command ends with its result here; the command runner then stops its processes. Its
      // completion is this thread's own command, so like a remote task's it takes remoteDispatch.
      if (task.command !== undefined) {
        if (task.result !== null) continue;
        yield* (input.remoteDispatch ?? dispatch)({
          type: "delegated_task.command.complete",
          commandId: CommandId.make(`${input.commandId}:stop:${task.id}`),
          parentThreadId: input.threadId,
          taskId: task.id,
          status: "interrupted",
          result:
            input.reason === undefined
              ? "Stopped with its parent."
              : `Stopped with its parent: ${input.reason}`,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a command task", {
              parentThreadId: input.threadId,
              taskId: task.id,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
        continue;
      }
      if (task.childThreadId === null) {
        // A task in a linked environment ends here; its follower then stops it there.
        // One with its result keeps it, but its thread there may run follow-up work.
        if (task.remoteChild === undefined) continue;
        const commandId = CommandId.make(`${input.commandId}:stop:${task.id}`);
        yield* (input.remoteDispatch ?? dispatch)(
          task.result === null
            ? {
                type: "delegated_task.remote.complete",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
                status: "interrupted",
                result:
                  input.reason === undefined
                    ? "Stopped with its parent."
                    : `Stopped with its parent: ${input.reason}`,
              }
            : {
                type: "delegated_task.remote.stop",
                commandId,
                parentThreadId: input.threadId,
                taskId: task.id,
              },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a delegated task", {
              parentThreadId: input.threadId,
              taskId: task.id,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
        continue;
      }
      const threadId = task.childThreadId;
      // Follow-up tasks reuse a child thread; walk its subtree only once.
      if (stoppedChildThreadIds.has(threadId)) continue;
      stoppedChildThreadIds.add(threadId);
      yield* Effect.gen(function* () {
        let shouldStop = activeChildThreadIds.has(threadId);
        let hasAppOwnedChildren = true;
        if (!shouldStop) {
          const child = yield* orchestrator.getThreadRecords(
            threadId,
            ["runs", "providerThreads", "turnItems", "subagents"],
            {
              turnItemTypes: ["command_execution", "dynamic_tool", "subagent", "link_request"],
              turnItemStatuses: ["pending", "running", "waiting"],
            },
          );
          shouldStop = childNeedsStop(child);
          hasAppOwnedChildren = child.subagents.some(
            (childTask) => childTask.origin === "app_owned",
          );
        }
        if (shouldStop) {
          yield* dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
            threadId,
            stopDelegatedTasks: false,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
        }
        if (hasAppOwnedChildren) {
          yield* stopDelegatedTasks({ threadId, commandId: input.commandId, reason: input.reason });
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Unable to stop a delegated task", {
            parentThreadId: input.threadId,
            threadId,
            error,
          }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
        ),
      );
    }
    if (failures[0] !== undefined) return yield* failures[0];
  });

  return ThreadManagementService.of({
    ensureLegacyTranscript,
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: Effect.fn("ThreadManagementService.searchThread")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      );
    }),
    dispatch,
    getThreadHistoryPage: Effect.fn("ThreadManagementService.getThreadHistoryPage")(
      function (threadId, cursor, throughEntryId, conversationOnly, workMode) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(
            orchestrator.getThreadHistoryPage(
              threadId,
              cursor,
              throughEntryId,
              conversationOnly,
              workMode,
            ),
          ),
        );
      },
    ),
    getTimelinePage: Effect.fn("ThreadManagementService.getTimelinePage")(
      function (threadId, options) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
        );
      },
    ),
    getMessageCount: Effect.fn("ThreadManagementService.getMessageCount")(function (threadId) {
      return ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      );
    }),
    getRunCount: Effect.fn("ThreadManagementService.getRunCount")(function (threadId) {
      return ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getRunCount(threadId)),
      );
    }),
    getMessagesById: Effect.fn("ThreadManagementService.getMessagesById")(
      function (threadId, messageIds) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getMessagesById(threadId, messageIds)),
        );
      },
    ),
    getTurnItem: Effect.fn("ThreadManagementService.getTurnItem")(function (input) {
      return ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map(turnItemDetailResult),
      );
    }),
    getThreadRecords: Effect.fn("ThreadManagementService.getThreadRecords")(
      function (threadId, fields, filter) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
        );
      },
    ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getAgentAwarenessSnapshot: orchestrator.getAgentAwarenessSnapshot,
    getShellSnapshot: orchestrator.getShellSnapshot,
    listActiveSubagentThreadIds: orchestrator.listActiveSubagentThreadIds,
    countThreads: orchestrator.countThreads,
    listActiveShellIndex: orchestrator.listActiveShellIndex,
    listOlderSettledThreads: orchestrator.listOlderSettledThreads,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    listAppOwnedChildThreadIds: Effect.fn("ThreadManagementService.listAppOwnedChildThreadIds")(
      function (threadId) {
        return ensureProjectionTranscript(threadId).pipe(
          Effect.andThen(orchestrator.listAppOwnedChildThreadIds(threadId)),
        );
      },
    ),
    getThreadTitles: orchestrator.getThreadTitles,
    getThreadLinkMetadata: orchestrator.getThreadLinkMetadata,
    listProjectThreads,
    sendToThread,
    submitRunOutput,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    acceptedCommandSequence,
    waitForThread,
    organizeAfterRun,
    organizeThread,
    interruptThread,
    awaitBackgroundTasks,
    stopDelegatedTasks,
    stopWorkflow,
    forceStopThread,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    cancelDelegatedTask: orchestrator.cancelDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    restartContinuationPending: orchestrator.restartContinuationPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

const layerThreadWorktreeRestoreNoop = Layer.succeed(ThreadWorktreeRestore, {
  restore: Effect.fn("ThreadWorktreeRestore.restore")(function () {
    return Effect.void;
  }),
  takeRecreated: Effect.fn("ThreadWorktreeRestore.takeRecreated")(function () {
    return Effect.undefined;
  }),
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: Effect.fn("LegacyV1ThreadImporter.ensureTranscript")(function () {
      return Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 });
    }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(layerThreadWorktreeRestoreNoop),
  Layer.provide(ThreadCommandExecutor.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | ThreadWorktreeRestore
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(Layer.provide(ThreadCommandExecutor.layer));
