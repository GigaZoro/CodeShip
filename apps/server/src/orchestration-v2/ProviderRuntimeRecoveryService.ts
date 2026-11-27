import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2RestartHold,
  type OrchestrationV2RestartHoldTurn,
  type OrchestrationV2RestartHoldWork,
  type OrchestrationV2ThreadProjection,
  isAppOwnedTaskWork,
  isOrchestrationV2WorkActive,
  orchestrationV2RunAwaitsMemory,
  ProviderSessionId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SessionHostService from "../sessionHost/SessionHostService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import type { SessionDetachPreparation } from "./ProviderSessionManager.ts";
import {
  answerableAfterRestart,
  continuesAfterRestart,
  RestartResumeRequest,
  restartResumeRun,
} from "./RestartContinuation.ts";
import { isBufferedProviderNotification } from "./NotificationMailbox.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
import { isExecutionTurnItemType } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { sameRestartHoldWork } from "@t3tools/shared/restartHold";
import { isDrainingRef, UpdateDrain, watchDrainingRef } from "../cloud/updateDrain.ts";
import {
  awaitingProviderThreadId,
  backgroundWorkStoppedNotice,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  cutAfterTurnFinished,
  isAwaitedWork,
  latestStartedRun,
  mergeRestartCancelledBackgroundWork,
  restartLeavesThreadAsIs,
  turnCallWork,
} from "./RestartBackgroundNote.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedError<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals(["read-projections", "reconcile", "drain-outbox"]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly reattachedSessionHosts?: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
  readonly reattachedSessionHosts?: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
    /**
     * Detaches every provider process a planned update can keep, once what is queued for its
     * threads was delivered to it; stops the rest. Runs before the effect worker stops.
     */
    readonly detachForUpdate: (
      prepareSession: (
        providerSessionId: string,
      ) => Effect.Effect<SessionDetachPreparation | undefined>,
    ) => Effect.Effect<ReadonlyArray<SessionHostService.DetachedHostSummary>>;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
    /** Work chats wait on that a restart would stop now, as its restart note would list it. */
    readonly restartHold: Effect.Effect<OrchestrationV2RestartHold, ProviderRuntimeRecoveryError>;
    /** The hold now and after every change, for updates that wait for it to clear. */
    readonly watchRestartHold: Stream.Stream<
      OrchestrationV2RestartHold,
      ProviderRuntimeRecoveryError
    >;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

/** Runs a restart cuts. One still waiting for memory has started nothing, so it keeps its place. */
function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      (status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting") &&
      !orchestrationV2RunAwaitsMemory(run)
    );
  });
}

type KeptProcessThread =
  | { readonly kind: "idle" }
  | { readonly kind: "takeover"; readonly runId: RunId }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * How a planned update treats one thread of a provider process it would keep. A process is kept
 * only when every thread on it is idle on it or has one run the next server takes over: running,
 * on this session, with a native turn. A run on another session is not on this process: restart
 * recovery continues it there.
 */
function classifyKeptProcessThread(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerSessionId: string,
): KeptProcessThread {
  const runs = nonterminalRuns(projection).filter((candidate) => {
    const runsOn = projection.providerThreads.find(
      (providerThread) => providerThread.id === candidate.providerThreadId,
    );
    return runsOn === undefined || runsOn.providerSessionId === providerSessionId;
  });
  const run = runs[0];
  if (run === undefined) return { kind: "idle" };
  if (runs.length > 1 || run.status !== "running") {
    return { kind: "blocked", reason: `Run ${run.id} is ${run.status}.` };
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  if (providerThread === undefined) {
    return { kind: "blocked", reason: `Run ${run.id} has no provider thread.` };
  }
  const providerTurn = projection.providerTurns.find(
    (turn) =>
      turn.runAttemptId === run.activeAttemptId &&
      turn.providerThreadId === providerThread.id &&
      turn.status === "running" &&
      turn.nativeTurnRef != null,
  );
  return providerTurn === undefined
    ? { kind: "blocked", reason: `Run ${run.id} has no running provider turn.` }
    : { kind: "takeover", runId: run.id };
}

function servesSession(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerSessionId: string,
): boolean {
  return projection.providerThreads.some(
    (providerThread) => providerThread.providerSessionId === providerSessionId,
  );
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedTaskWork(item);
}

function providerThreadHasPendingBackgroundTasks(
  providerThread: OrchestrationV2ThreadProjection["providerThreads"][number],
): boolean {
  return (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
}

function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

type RecoveryProjection = ProjectionStore.ProjectionRuntimeRecoveryState;
type RecoveryRun = RecoveryProjection["runs"][number];

function pendingRequestRecovery(projection: RecoveryProjection) {
  const pendingRequests = projection.runtimeRequests.filter(
    (request) => request.status === "pending",
  );
  // The lost provider callback cannot resume; persisted questions can be
  // answered by a new user message in threads that accept messages.
  const questions = pendingRequests.filter((request) =>
    answerableAfterRestart(request, projection.thread, projection.turnItems),
  );
  const recoveredRequestIds = new Set(questions.map((request) => request.id));
  const messageRequestNodeIds = new Set<string>(
    pendingRequests
      .filter(
        (request) =>
          request.responseCapability.type === "message" || recoveredRequestIds.has(request.id),
      )
      .map((request) => request.nodeId),
  );
  const requests = pendingRequests.filter(
    (request) =>
      request.responseCapability.type !== "message" && !recoveredRequestIds.has(request.id),
  );
  return { questions, messageRequestNodeIds, requests };
}

interface RestartCancelledEntry {
  readonly work: OrchestrationV2RestartCancelledBackgroundWork;
  /** The provider's id where it has one, which its turn item and its roster entry share. */
  readonly holdId: string;
}

/**
 * The background work a restart cancels, keyed by the provider thread that waits on it. Shutdown
 * records it for the restart note; an update waits on the part a chat waits on before restarting.
 */
function restartCancelledBackgroundWork(
  projection: RecoveryProjection,
  cutRuns: ReadonlyArray<RecoveryRun>,
  messageRequestNodeIds: ReadonlySet<string>,
): ReadonlyMap<ProviderThreadId, ReadonlyArray<RestartCancelledEntry>> {
  const cancelled = new Map<ProviderThreadId, Array<RestartCancelledEntry>>();
  const recordedNativeIds = new Set<string>();
  const record = (
    providerThreadId: ProviderThreadId | null | undefined,
    entry: RestartCancelledEntry,
  ) => {
    if (providerThreadId == null) return;
    const existing = cancelled.get(providerThreadId);
    if (existing === undefined) cancelled.set(providerThreadId, [entry]);
    else existing.push(entry);
  };
  const recordItem = (item: OrchestrationV2ThreadProjection["turnItems"][number]) => {
    if (!isBackgroundCapableTurnItemType(item.type)) return;
    const awaitingId = awaitingProviderThreadId(item, projection.runs);
    const ownProviderThread =
      item.providerThreadId === awaitingId
        ? undefined
        : (projection.providerThreads ?? []).find(
            (candidate) => candidate.id === item.providerThreadId,
          );
    const work = cancelledTurnItemWork(
      item,
      ownProviderThread?.nativeThreadRef?.nativeId ?? undefined,
    );
    if (work === undefined) return;
    const nativeId = item.nativeItemRef?.nativeId;
    record(awaitingId, { work, holdId: nativeId ?? item.id });
    if (nativeId != null) recordedNativeIds.add(nativeId);
  };
  for (const run of cutRuns) {
    for (const item of projection.turnItems) {
      if (
        item.runId !== run.id ||
        (item.nodeId != null && messageRequestNodeIds.has(item.nodeId)) ||
        isAppOwnedDelegationItem(item) ||
        // A link card waits on the user, not the run, and answers by message.
        item.type === "link_request" ||
        !isNonterminalTurnItemStatus(item.status)
      )
        continue;
      // Cut native subagents do not resume; record them for the continuation to restart.
      if (
        run.status === "waiting" ||
        (item.type === "subagent" && item.origin === "provider_native")
      )
        recordItem(item);
    }
  }
  const skippedRunIds = new Set([
    ...cutRuns.map((run) => run.id),
    // A rollback closed the process that ran these turns' work, and the rewound chat no longer
    // knows it, so a note would have the agent start it again.
    ...projection.runs.flatMap((run) => (run.status === "rolled_back" ? [run.id] : [])),
  ]);
  for (const item of projection.turnItems ?? []) {
    if (
      (item.runId !== null && skippedRunIds.has(item.runId)) ||
      !isNonterminalTurnItemStatus(item.status) ||
      isAppOwnedDelegationItem(item)
    )
      continue;
    recordItem(item);
  }
  for (const providerThread of projection.providerThreads ?? []) {
    if (providerThread.ownerNodeId !== null) continue;
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      // A subagent already recorded covers the shells it started.
      if (
        recordedNativeIds.has(task.taskId) ||
        (task.parentTaskId !== undefined && recordedNativeIds.has(task.parentTaskId))
      )
        continue;
      recordedNativeIds.add(task.taskId);
      const work = cancelledRosterTaskWork(task);
      record(providerThread.id, { work, holdId: work.id ?? task.taskId });
    }
  }
  return cancelled;
}

// Reads the projections at most about once per interval while tool events keep coming. A debounce
// would wait for a quiet moment a busy agent never takes, and the hold would stay stale.
const RESTART_HOLD_SETTLE = Duration.millis(500);
const RESTART_HOLD_MAX_EVENTS = 1024;

function changesRestartHold(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "provider-thread.updated":
    case "run.updated":
    case "subagent.updated":
    case "runtime-request.updated":
      return true;
    case "turn-item.updated":
      return isExecutionTurnItemType(event.payload.type);
    default:
      return event.type.startsWith("thread.");
  }
}

/** A turn that is answering now: a restart cuts it mid-answer. */
function isRunningTurn(run: ProjectionStore.ProjectionRuntimeRecoveryState["runs"][number]) {
  return (
    (run.status === "preparing" || run.status === "starting" || run.status === "running") &&
    !orchestrationV2RunAwaitsMemory(run)
  );
}

/**
 * The tool calls and subagents a running turn waits on, queued calls included. A delegated
 * task's own turn is listed in its thread, and a wait on another thread loses nothing.
 */
function runningTurnCalls(projection: RecoveryProjection): ReadonlyArray<RestartCancelledEntry> {
  const running = new Set(projection.runs.filter(isRunningTurn).map((run) => run.id));
  // A turn waiting on the person would hold the update for as long as nobody answers.
  if (
    running.size === 0 ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return [];
  // Work the agent sent to the background is held as background work; the turn goes on without it.
  const background = new Set(
    projection.providerThreads.flatMap((providerThread) =>
      (providerThread.pendingBackgroundTasks ?? []).flatMap((task) =>
        task.nativeItemId === undefined ? [task.taskId] : [task.taskId, task.nativeItemId],
      ),
    ),
  );
  return projection.turnItems.flatMap((item) => {
    if (
      item.runId === null ||
      !running.has(item.runId) ||
      !isExecutionTurnItemType(item.type) ||
      !isNonterminalTurnItemStatus(item.status) ||
      isAppOwnedDelegationItem(item) ||
      (item.nativeItemRef?.nativeId != null && background.has(item.nativeItemRef.nativeId))
    )
      return [];
    const work = turnCallWork(item);
    // The same id as its background entry, so a call that moves between the lists stays waited on.
    return work === undefined ? [] : [{ work, holdId: item.nativeItemRef?.nativeId ?? item.id }];
  });
}

function sameRestartHold(left: OrchestrationV2RestartHold, right: OrchestrationV2RestartHold) {
  const leftTurns = left.runningTurns ?? [];
  const rightTurns = right.runningTurns ?? [];
  const leftCommands = left.commands ?? [];
  const rightCommands = right.commands ?? [];
  return (
    leftCommands.length === rightCommands.length &&
    leftCommands.every((command, index) => {
      const other = rightCommands[index]!;
      return (
        command.taskId === other.taskId &&
        command.threadTitle === other.threadTitle &&
        command.label === other.label
      );
    }) &&
    leftTurns.length === rightTurns.length &&
    leftTurns.every(
      (turn, index) =>
        turn.threadId === rightTurns[index]!.threadId &&
        turn.threadTitle === rightTurns[index]!.threadTitle,
    ) &&
    sameRestartHoldWork(left.work, right.work) &&
    Boolean(left.draining) === Boolean(right.draining)
  );
}

const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  stoppedAt: DateTime.Utc,
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? {
        ...item,
        status: "cancelled",
        secretStatus: "cancelled",
        completedAt: stoppedAt,
        updatedAt: now,
      }
    : { ...item, status: "cancelled", completedAt: stoppedAt, updatedAt: now };

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const restartResumeRequest = yield* RestartResumeRequest;
  const updateDrain = yield* UpdateDrain;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sessionHostOption = yield* Effect.serviceOption(SessionHostService.SessionHostService);
  const turnStartOption = yield* Effect.serviceOption(
    ProviderTurnStartService.ProviderTurnStartServiceV2,
  );
  const mcpRegistryOption = yield* Effect.serviceOption(McpSessionRegistry.McpSessionRegistry);
  /**
   * Hands a host reattached after a planned update to every run its process is still working on.
   * `preserved` are the threads whose runs were taken over. Any failure ends the process the way a
   * server shutdown ends a session, so every run on it recovers as after any restart.
   */
  const adoptReattachedHost = Effect.fn("ProviderRuntimeRecovery.adoptReattachedHost")(function* (
    sessionHost: SessionHostService.SessionHostServiceShape,
    record: SessionHostService.SessionHostRecord,
    recoveryThreadIds: ReadonlyArray<ThreadId>,
  ): Effect.fn.Return<{
    readonly preserved: ReadonlyArray<ThreadId>;
    readonly liveProviderSessionId?: string;
  }> {
    const providerSessionId = ProviderSessionId.make(record.providerSessionId);
    const threadIds = record.threadIds;
    const giveUp = (reason: string, cause?: unknown) =>
      Effect.logError("Could not take over a provider process kept running through the update", {
        sessionHostId: record.id,
        threadIds,
        providerSessionId: record.providerSessionId,
        reason,
        ...(cause === undefined ? {} : { cause }),
      }).pipe(
        Effect.andThen(
          Option.isSome(turnStartOption)
            ? turnStartOption.value.abandonAdoption(providerSessionId)
            : Effect.void,
        ),
        Effect.andThen(sessionHost.terminate(record.id)),
        Effect.as({ preserved: [] }),
      );
    if (Option.isNone(turnStartOption)) {
      return yield* giveUp("This server cannot start provider turns.");
    }
    const turnStart = turnStartOption.value;
    const runs: Array<{ readonly threadId: ThreadId; readonly runId: RunId }> = [];
    for (const threadId of new Set([...threadIds, ...recoveryThreadIds])) {
      const projection = yield* projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.result);
      if (projection._tag === "Failure") {
        return yield* giveUp(`Thread ${threadId} could not be read.`, projection.failure);
      }
      if (!servesSession(projection.success, record.providerSessionId)) continue;
      const thread = classifyKeptProcessThread(projection.success, record.providerSessionId);
      if (thread.kind === "blocked") {
        return yield* giveUp(`Thread ${threadId} cannot be taken over: ${thread.reason}`);
      }
      if (thread.kind === "takeover") runs.push({ threadId, runId: thread.runId });
    }
    if (runs.length === 0) {
      return yield* giveUp("No thread has a running run on this provider session.");
    }
    for (const run of runs) {
      const adopted = yield* threadDispatch
        .withLock(run.threadId, turnStart.adopt(run))
        .pipe(Effect.result);
      if (adopted._tag === "Failure") {
        return yield* giveUp(`Run ${run.runId} could not be taken over.`, adopted.failure);
      }
    }
    if (!(yield* turnStart.releaseAdoptedOutput(providerSessionId))) {
      return yield* giveUp("The taken-over session could not receive its output.");
    }
    yield* Effect.logInfo("Took over a provider process kept running through the update", {
      sessionHostId: record.id,
      threadIds: runs.map((run) => run.threadId),
      runIds: runs.map((run) => run.runId),
    });
    return {
      preserved: runs.map((run) => run.threadId),
      liveProviderSessionId: record.providerSessionId,
    };
  });

  /** The threads whose runs the next server takes over from the process; none when it stops it. */
  const takenOverThreads = Effect.fn("ProviderRuntimeRecovery.takenOverThreads")(function* (
    providerSessionId: string,
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const undelivered = yield* outbox.listUnsettled({
      threadIds,
      effectTypes: EffectOutbox.DELIVERED_BEFORE_DETACH_EFFECT_TYPES,
    });
    if (undelivered.length > 0) return [];
    const takenOver: Array<ThreadId> = [];
    for (const threadId of threadIds) {
      const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
      const thread = classifyKeptProcessThread(projection, providerSessionId);
      if (thread.kind === "blocked") {
        yield* Effect.logInfo("A provider process is not kept through the update", {
          providerSessionId,
          threadId,
          reason: thread.reason,
        });
        return [];
      }
      if (thread.kind === "takeover") takenOver.push(threadId);
    }
    return takenOver;
  });

  const detachForUpdate = Effect.fn("ProviderRuntimeRecoveryService.detachForUpdate")(function* (
    prepareSession: (
      providerSessionId: string,
    ) => Effect.Effect<SessionDetachPreparation | undefined>,
  ) {
    if (Option.isNone(sessionHostOption)) return [];
    // A kept process must get every answer, interrupt and steer queued for it; nothing else starts.
    yield* outbox.restrictClaimsTo(EffectOutbox.DELIVERED_BEFORE_DETACH_EFFECT_TYPES);
    return yield* sessionHostOption.value.detachAllForUpdate({
      prepare: (providerSessionId) =>
        prepareSession(providerSessionId).pipe(
          Effect.map((session) =>
            session === undefined
              ? undefined
              : {
                  deliver: outbox
                    .listUnsettled({
                      threadIds: session.threadIds,
                      effectTypes: EffectOutbox.DELIVERED_BEFORE_DETACH_EFFECT_TYPES,
                    })
                    .pipe(
                      Effect.flatMap((effectIds) =>
                        Effect.forEach(effectIds, outbox.awaitSettled, { discard: true }),
                      ),
                      Effect.orDie,
                    ),
                  drain: session.drain.pipe(Effect.orDie),
                  takenOverThreads: takenOverThreads(providerSessionId, session.threadIds).pipe(
                    Effect.orDie,
                  ),
                },
          ),
        ),
    });
  });
  type RecoverySession = ProjectionStore.ProjectionRuntimeRecoveryState["providerSessions"][number];
  /** Shared sessions stop on their first recovered thread; later threads still decide wakes from pre-recovery liveness. */
  const sessionsLiveAtStart = (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
    stoppedThisPass: ReadonlyMap<string, RecoverySession>,
  ) => {
    const sessions = new Map(projection.providerSessions.map((session) => [session.id, session]));
    for (const providerThread of projection.providerThreads) {
      const stopped =
        providerThread.providerSessionId === null
          ? undefined
          : stoppedThisPass.get(providerThread.providerSessionId);
      if (stopped !== undefined) sessions.set(stopped.id, stopped);
    }
    return [...sessions.values()];
  };

  const cutRuns = Effect.fn("ProviderRuntimeRecoveryService.cutRuns")(function* (
    projection: RecoveryProjection,
  ) {
    const runs: Array<RecoveryRun> = [];
    for (const run of nonterminalRuns(projection)) {
      if (run.status === "waiting") {
        const checkpointEffects = yield* outbox
          .listByCommandId(CommandId.make(`command:effect:checkpoint.capture:${run.id}`))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        const hasReplayableCheckpoint = checkpointEffects.some(
          (effect) =>
            effect.request.type === "checkpoint.capture" &&
            effect.request.runId === run.id &&
            (effect.status === "pending" || effect.status === "running"),
        );
        if (hasReplayableCheckpoint) continue;
      }
      runs.push(run);
    }
    return runs;
  });

  const reconcileProjection = Effect.fn("ProviderRuntimeRecoveryService.reconcileProjection")(
    function* (
      projection: ProjectionStore.ProjectionRuntimeRecoveryState,
      trigger: "startup" | "shutdown",
      continueAfterRestart: boolean,
      lastCommittedAt: DateTime.Utc | null,
      stoppedThisPass: ReadonlyMap<string, RecoverySession> = new Map(),
      keptSessionIds: ReadonlySet<string> = new Set(),
    ) {
      const now = yield* DateTime.now;
      // A process kept through the update stays live for the threads it serves.
      const stoppableSessions = projection.providerSessions.filter(
        (candidate) =>
          candidate.status !== "stopped" &&
          candidate.status !== "error" &&
          !keptSessionIds.has(candidate.id),
      );
      // Cut work stopped with the server, not when this pass noticed; scheduled recovery reads it.
      const stoppedAt = lastCommittedAt === null ? now : DateTime.min(lastCommittedAt, now);
      const runs = yield* cutRuns(projection);
      const continuationRun =
        continueAfterRestart && trigger === "startup"
          ? restartResumeRun(
              { ...projection, providerSessions: sessionsLiveAtStart(projection, stoppedThisPass) },
              now,
            )
          : undefined;
      const { questions, messageRequestNodeIds, requests } = pendingRequestRecovery(projection);
      const cancelledBackgroundWork = restartCancelledBackgroundWork(
        projection,
        runs,
        messageRequestNodeIds,
      );
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedTaskWork).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedTaskWork(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "reconcile",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      // EventSink places a notice after its run's existing items.
      const noticeOrdinal = (runId: RecoveryRun["id"]) =>
        Math.max(
          0,
          ...projection.turnItems
            .filter((item) => item.runId === runId)
            .map((item) => item.ordinal),
        ) + 1;
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* projections
              .getThreadRecords(projection.thread.id, ["messages"], {
                messageIds: queuedRuns.map((run) => run.userMessageId),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderRuntimeRecoveryError({
                      operation: "read-projections",
                      threadId: projection.thread.id,
                      cause,
                    }),
                ),
              )).messages;
      const bufferedMessageIds = new Set(
        queuedMessages.filter(isBufferedProviderNotification).map((message) => message.id),
      );
      for (const run of queuedRuns) {
        if (bufferedMessageIds.has(run.userMessageId)) {
          runs.push(run);
          continue;
        }
        // A hold from before the restart (a Stop, a failure) stays the person's to release.
        if (run.queueHeld === true) continue;
        // A run queued solely for update drain when no active run was cut starts right after restart.
        if (run.queueHeldByUpdateDrain === true && runs.every((cut) => cut.status === "queued"))
          continue;
        // A person reviews what they queued, but nobody reviews a message an agent, the server or a
        // scheduled task queued, and no continuation is scheduled to lift its hold: it just starts.
        // So does a message queued behind a run whose turn had already finished: the restart cut no
        // work, and no continuation will ever lift a hold on it.
        if (
          trigger === "startup" &&
          continueAfterRestart &&
          continuationRun === undefined &&
          (queuedMessages.some(
            (message) =>
              message.id === run.userMessageId &&
              (message.createdBy !== "user" || message.scheduledTaskId !== undefined),
          ) ||
            (!restartLeavesThreadAsIs(projection.thread, now) &&
              cutAfterTurnFinished(
                runs.filter((cut) => cut.status !== "queued"),
                projection.providerTurns,
              )))
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          // Held so nothing starts ahead of the continuation; with continuation on, the queue follows it.
          payload: {
            ...run,
            queueHeld: true,
            ...(continueAfterRestart ? { queueHeldByRestart: true } : {}),
          },
        });
      }
      for (const question of questions) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: question.nodeId,
          occurredAt: now,
          payload: { ...question, responseCapability: { type: "message" } },
        });
      }
      for (const request of requests) {
        events.push({
          id: yield* allocateEventId(),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: trigger === "startup" ? "expired" : "cancelled",
            responseCapability: {
              type: "not_resumable",
              reason: `The server ${trigger === "startup" ? "restarted" : "shut down"} before this runtime request was resolved.`,
            },
            resolvedAt: now,
          },
        });
      }
      for (const run of runs) {
        events.push({
          id: yield* allocateEventId(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: stoppedAt },
        });
        for (const attempt of projection.attempts.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: attempt.rootNodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...attempt, status: "cancelled", completedAt: stoppedAt },
          });
        }
        for (const node of projection.nodes.filter(
          (candidate) =>
            candidate.runId === run.id &&
            !messageRequestNodeIds.has(candidate.id) &&
            !delegatedTaskNodeIds.has(candidate.id) &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: node.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...node, status: "cancelled", completedAt: stoppedAt },
          });
        }
        for (const providerTurn of projection.providerTurns.filter(
          (candidate) =>
            candidate.runAttemptId !== null &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ) &&
            (candidate.status === "pending" || candidate.status === "running"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: providerTurn.nodeId,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...providerTurn, status: "cancelled", completedAt: stoppedAt },
          });
        }
        for (const message of projection.messages.filter(
          (candidate) => candidate.runId === run.id && candidate.streaming,
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "message.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...message, streaming: false, updatedAt: now },
          });
        }
        for (const item of projection.turnItems.filter(
          (candidate) =>
            candidate.runId === run.id &&
            (candidate.nodeId === null || !messageRequestNodeIds.has(candidate.nodeId)) &&
            !isAppOwnedDelegationItem(candidate) &&
            // A link card waits on the user, not the run, and answers by message.
            candidate.type !== "link_request" &&
            (candidate.status === "pending" ||
              candidate.status === "running" ||
              candidate.status === "waiting"),
        )) {
          events.push({
            id: yield* allocateEventId(),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: cancelledItem(item, stoppedAt, now),
          });
        }
        // A queued run never did provider work, so there is nothing to explain.
        if (run.status === "queued") continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: {
            id: ids.derive.runSignalTurnItem({ runId: run.id, signal: "server-recovery" }),
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: noticeOrdinal(run.id),
            status: "completed",
            title: trigger === "startup" ? "Server restarted" : "Server shut down",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            message: detail,
          },
        });
      }
      // Blocking waits die with their turn; let child results wake the parent continuation as async tasks.
      const cutRunIds = new Set(runs.map((run) => run.id));
      for (const task of projection.subagents ?? []) {
        if (
          task.origin !== "app_owned" ||
          task.runId === null ||
          !cutRunIds.has(task.runId) ||
          task.completionWake !== "settled_only" ||
          !isOrchestrationV2WorkActive(task.status)
        )
          continue;
        events.push({
          id: yield* allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          runId: task.runId,
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: { ...task, completionWake: "always", updatedAt: now },
        });
      }
      // A run still waiting for memory keeps its records, its workspace setup included, for its turn.
      const keptRunIds = new Set(
        [...runs, ...projection.runs.filter(orchestrationV2RunAwaitsMemory)].map((run) => run.id),
      );
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && keptRunIds.has(item.runId)) {
          continue;
        }
        if (!isBackgroundCapableTurnItemType(item.type)) {
          continue;
        }
        if (!isNonterminalTurnItemStatus(item.status) || isAppOwnedDelegationItem(item)) {
          continue;
        }
        const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
          providerInstanceId,
          occurredAt: now,
          payload: cancelledItem(item, stoppedAt, now),
        });
        if (item.nodeId !== null && item.nodeId !== undefined) {
          const staleItemNode = projection.nodes.find(
            (candidate) =>
              candidate.id === item.nodeId && isNonterminalTurnItemStatus(candidate.status),
          );
          if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
            cancelledStaleNodeIds.add(staleItemNode.id);
            events.push({
              id: yield* allocateEventId(),
              type: "node.updated",
              threadId: projection.thread.id,
              ...(item.runId === null ? {} : { runId: item.runId }),
              nodeId: staleItemNode.id,
              providerInstanceId,
              occurredAt: now,
              payload: { ...staleItemNode, status: "cancelled", completedAt: stoppedAt },
            });
          }
        }
      }
      // No provider process survives the server; open native subagents can never report completion.
      for (const subagent of projection.subagents ?? []) {
        events.push(
          ...(yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.id,
            status: "cancelled",
            now,
            emitted: events,
            allocateEventId,
          })),
        );
      }
      // Native subagent threads have no runs to settle their runless root turns.
      events.push(
        ...(yield* endRunlessRootTurns({
          threadId: projection.thread.id,
          providerInstanceId: projection.thread.providerInstanceId,
          projection,
          status: "cancelled",
          now,
          emitted: events,
          allocateEventId,
        })),
      );
      for (const providerThread of projection.providerThreads ?? []) {
        const needsIdle = providerThread.status === "active";
        const needsRosterClear = providerThreadHasPendingBackgroundTasks(providerThread);
        if (!needsIdle && !needsRosterClear) {
          continue;
        }
        events.push({
          id: yield* allocateEventId(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...providerThread,
            status: needsIdle ? "idle" : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: now,
          },
        });
      }
      for (const session of stoppableSessions) {
        events.push({
          id: yield* allocateEventId(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          occurredAt: now,
          payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
        });
      }
      for (const [providerThreadId, entries] of cancelledBackgroundWork) {
        const noteRun = latestStartedRun(projection.runs, providerThreadId);
        if (noteRun === undefined) continue;
        // Use a separate event; stale run snapshots can overwrite intervening lifecycle changes.
        events.push({
          id: yield* allocateEventId(),
          type: "run.background-work-cancelled",
          threadId: projection.thread.id,
          runId: noteRun.id,
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: {
            runId: noteRun.id,
            restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
              noteRun.restartCancelledBackgroundWork ?? [],
              entries.map((entry) => entry.work),
            ),
          },
        });
        // A cut run already explains itself with its server-recovery notice.
        if (cutRunIds.has(noteRun.id)) continue;
        const notice = backgroundWorkStoppedNotice({
          run: noteRun,
          cause: trigger === "startup" ? "server-restarted" : "server-shut-down",
          work: entries.map((entry) => entry.work),
          stoppedAt,
          now,
          ordinal: noticeOrdinal(noteRun.id),
        });
        if (notice === undefined) continue;
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          runId: noteRun.id,
          ...(noteRun.rootNodeId === null ? {} : { nodeId: noteRun.rootNodeId }),
          providerInstanceId: noteRun.providerInstanceId,
          occurredAt: now,
          payload: notice,
        });
      }
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            EffectOutbox.restartContinuationEffect({
              commandId,
              threadId: projection.thread.id,
              sourceRunId: continuationRun.id,
            }),
          ]
        : [];
      const stoppedSessions = stoppableSessions.length;
      let retiredEffects: number;
      if (events.length === 0) {
        const retiredEffectIds = yield* outbox
          .cancelUnsettled({
            threadId: projection.thread.id,
            effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
            reason: detail,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause: { detail, cause },
                }),
            ),
          );
        yield* outbox.signalCancellations(retiredEffectIds);
        retiredEffects = retiredEffectIds.length;
      } else {
        const result = yield* eventSink
          .commitCommand({
            commandId,
            threadId: projection.thread.id,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events,
            effects,
            cancelUnsettledEffects: {
              effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
              reason: detail,
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "reconcile",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          );
        retiredEffects = result.cancelledEffectCount;
      }
      return {
        terminalizedRuns: runs.length,
        stoppedSessions,
        closedRequests: requests.length,
        retiredEffects,
      };
    },
  );

  const reconcile = Effect.fn("ProviderRuntimeRecoveryService.reconcile")(function* (
    trigger: "startup" | "shutdown",
  ) {
    const continueAfterRestart = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const resumeRequested = yield* restartResumeRequest;
    // Shutdown runs while the server is alive. A crash leaves no shutdown time, so startup reads
    // the previous server's last commit before this pass commits its own.
    const lastCommittedAt =
      trigger === "startup"
        ? yield* eventSink.lastCommittedAt.pipe(
            Effect.mapError(
              (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
            ),
          )
        : null;
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    const reconcileOutbox = outbox.reconcileAfterProcessLoss.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
      ),
    );
    // Startup sweeps what the old process left before a taken-over process replays its output,
    // since what that output queues is this server's. Shutdown sweeps after the per-thread passes,
    // which signal the running effects they cancel.
    const startupOutboxReconciliation = trigger === "startup" ? yield* reconcileOutbox : undefined;
    const preservedThreadIds = new Set<ThreadId>();
    const keptSessionIds = new Set<string>();
    let reattachedSessionHosts = 0;
    if (Option.isSome(sessionHostOption)) {
      const sessionHost = sessionHostOption.value;
      if (trigger === "startup") {
        const reattached = yield* sessionHost.reattachAllDetachedForUpdate();
        for (const entry of reattached) {
          if (entry.status === "reattached") {
            reattachedSessionHosts += 1;
            yield* Effect.logInfo("Reattached detached provider session host after restart", {
              sessionHostId: entry.record.id,
              threadId: entry.record.threadId,
              providerSessionId: entry.record.providerSessionId,
              driver: entry.record.driver,
              replayedFromSeq: entry.record.lastAckedSeq,
              latestSeq: entry.attachedInfo.latestSeq,
              droppedFrames: entry.attachedInfo.droppedFrames,
            });
          } else {
            yield* Effect.logWarning(
              "Detached provider session host did not survive restart; falling back to recovery",
              {
                sessionHostId: entry.record.id,
                threadId: entry.record.threadId,
                providerSessionId: entry.record.providerSessionId,
                reason: entry.reason,
              },
            );
          }
        }
        for (const entry of reattached) {
          if (entry.status !== "reattached") continue;
          const outcome = yield* adoptReattachedHost(sessionHost, entry.record, threadIds);
          for (const threadId of outcome.preserved) preservedThreadIds.add(threadId);
          if (outcome.liveProviderSessionId !== undefined) {
            keptSessionIds.add(outcome.liveProviderSessionId);
          }
        }
      } else {
        for (const threadId of threadIds) {
          if (yield* sessionHost.isThreadDetachedForUpdate(threadId)) {
            preservedThreadIds.add(threadId);
          }
        }
      }
    }
    // Credentials restored from before the restart stay only for processes taken over above.
    if (trigger === "startup" && Option.isSome(mcpRegistryOption)) {
      yield* mcpRegistryOption.value.pruneRestored(preservedThreadIds);
    }
    let terminalizedRuns = 0;
    let stoppedSessions = 0;
    let closedRequests = 0;
    let retiredEffects = 0;
    const stoppedThisPass = new Map<string, RecoverySession>();
    for (const threadId of threadIds) {
      if (preservedThreadIds.has(threadId)) {
        continue;
      }
      // Shutdown does not drain admitted commands, so read and commit under the lock they plan under.
      const { projection, result } = yield* threadDispatch.withLock(
        threadId,
        Effect.gen(function* () {
          const projection = yield* projections.getRuntimeRecoveryProjection(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "read-projections",
                  threadId,
                  cause,
                }),
            ),
          );
          if (trigger === "shutdown" && Option.isSome(sessionHostOption)) {
            for (const session of projection.providerSessions) {
              if (yield* sessionHostOption.value.isProviderSessionDetachedForUpdate(session.id)) {
                keptSessionIds.add(session.id);
              }
            }
          }
          const enabled = continuesAfterRestart(
            resumeRequested,
            continueAfterRestart,
            projection.thread.projectId,
          );
          const result = yield* reconcileProjection(
            projection,
            trigger,
            enabled,
            lastCommittedAt,
            stoppedThisPass,
            keptSessionIds,
          );
          return { projection, result };
        }),
      );
      for (const session of projection.providerSessions) {
        if (
          session.status !== "stopped" &&
          session.status !== "error" &&
          !keptSessionIds.has(session.id)
        ) {
          stoppedThisPass.set(session.id, session);
        }
      }
      terminalizedRuns += result.terminalizedRuns;
      stoppedSessions += result.stoppedSessions;
      closedRequests += result.closedRequests;
      retiredEffects += result.retiredEffects;
    }
    const outboxReconciliation = startupOutboxReconciliation ?? (yield* reconcileOutbox);
    return {
      terminalizedRuns,
      stoppedSessions,
      closedRequests,
      retiredEffects: retiredEffects + outboxReconciliation.cancelled,
      requeuedEffects: outboxReconciliation.requeued,
      ...(reattachedSessionHosts > 0 ? { reattachedSessionHosts } : {}),
    } satisfies ProviderRuntimeReconciliationSummary;
  });

  const prepareForShutdown = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const resumeRequested = yield* restartResumeRequest;
    if (!enabled && !resumeRequested) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
      if (
        Option.isSome(sessionHostOption) &&
        (yield* sessionHostOption.value.isThreadDetachedForUpdate(threadId))
      ) {
        continue;
      }
      yield* Effect.gen(function* () {
        const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
        if (!continuesAfterRestart(resumeRequested, enabled, projection.thread.projectId)) return;
        const run = restartResumeRun(projection, yield* DateTime.now);
        if (!run) return;
        const commandId = CommandId.make(`command:restart-prepare:${run.id}`);
        yield* eventSink.writeWithEffects({
          commandId,
          events: [],
          effects: [
            EffectOutbox.restartContinuationEffect({ commandId, threadId, sourceRunId: run.id }),
          ],
        });
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.mapError((cause) => new ProviderRuntimeRecoveryError({ operation: "reconcile", cause })),
  );

  const recover = Effect.gen(function* () {
    return (yield* reconcile("startup")) satisfies ProviderRuntimeRecoverySummary;
  });

  const restartHold = Effect.gen(function* () {
    // Archived and deleted chats are left out: nobody waits in them, and a restart wakes nothing.
    const threadIds = yield* projections
      .getRecoveryThreadIds("restart-hold")
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    const work: Array<OrchestrationV2RestartHoldWork> = [];
    const runningTurns: Array<OrchestrationV2RestartHoldTurn> = [];
    for (const threadId of threadIds) {
      const projection = yield* projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({ operation: "read-projections", threadId, cause }),
          ),
        );
      if (projection.runs.some(isRunningTurn)) {
        runningTurns.push({ threadId, threadTitle: projection.thread.title });
      }
      const calls = runningTurnCalls(projection);
      for (const { work: call, holdId } of calls) {
        work.push({
          threadId,
          threadTitle: projection.thread.title,
          kind: call.kind,
          label: call.label,
          id: holdId,
          turnCall: true,
        });
      }
      const callIds = new Set(calls.map((call) => call.holdId));
      const cancelled = restartCancelledBackgroundWork(
        projection,
        yield* cutRuns(projection),
        pendingRequestRecovery(projection).messageRequestNodeIds,
      );
      for (const entries of cancelled.values()) {
        for (const { work: entry, holdId } of entries) {
          if (!isAwaitedWork(entry) || callIds.has(holdId)) continue;
          work.push({
            threadId,
            threadTitle: projection.thread.title,
            kind: entry.kind,
            label: entry.label,
            id: holdId,
          });
        }
      }
    }
    const commands = (yield* projections.getOpenCommandTasks.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
      ),
    )).flatMap((task) =>
      task.threadClosed === null
        ? [
            {
              threadId: task.parentThreadId,
              threadTitle: task.threadTitle,
              taskId: task.taskId,
              label: task.label,
              command: task.command,
            },
          ]
        : [],
    );
    const draining = yield* isDrainingRef(updateDrain);
    return {
      work,
      runningTurns,
      commands,
      ...(draining ? { draining: true } : {}),
    } satisfies OrchestrationV2RestartHold;
  }).pipe(Effect.withSpan("ProviderRuntimeRecoveryService.restartHold"));

  // Watchers read the hold one at a time, in numbered order, so a read with a higher number
  // reflects every change a lower one did. An event sequence read beside a hold can't order two
  // reads: a commit may land between it and the hold.
  const restartHoldReads = yield* Semaphore.make(1);
  const restartHoldReadCount = yield* Ref.make(0);
  const numberedRestartHold = restartHoldReads.withPermit(
    Effect.all({ hold: restartHold, read: Ref.updateAndGet(restartHoldReadCount, (n) => n + 1) }),
  );

  // Every client and remote environment watches the hold; one read per change serves them all.
  // A watcher needs only the latest hold, so a slow one skips older ones instead of stalling the rest.
  const sharedRestartHolds = yield* Stream.unwrap(
    eventSink.latestSequence().pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
      ),
      Effect.map((afterSequence) =>
        Stream.concat(
          Stream.fromEffect(numberedRestartHold),
          Stream.merge(
            eventSink.stream({ afterSequence, bounded: true }).pipe(
              Stream.mapError(
                (cause) =>
                  new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
              ),
              Stream.filter(({ event }) => changesRestartHold(event)),
              Stream.groupedWithin(RESTART_HOLD_MAX_EVENTS, RESTART_HOLD_SETTLE),
            ),
            watchDrainingRef(updateDrain),
          ).pipe(Stream.mapEffect(() => numberedRestartHold)),
        ),
      ),
    ),
  ).pipe(Stream.share({ capacity: 1, strategy: "sliding", replay: 1 }));

  // The last shared hold can predate a change still settling, and a restart decided on it cuts
  // work, so a new watcher reads its own first and then takes only shared holds read after it.
  const watchRestartHold = Stream.unwrap(
    numberedRestartHold.pipe(
      Effect.map((own) =>
        Stream.concat(
          Stream.succeed(own),
          sharedRestartHolds.pipe(Stream.filter((shared) => shared.read > own.read)),
        ),
      ),
    ),
  ).pipe(
    Stream.map(({ hold }) => hold),
    Stream.changesWith(sameRestartHold),
  );

  return ProviderRuntimeRecoveryService.of({
    reconcile,
    prepareForShutdown,
    detachForUpdate,
    recover,
    restartHold,
    watchRestartHold,
  });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);
