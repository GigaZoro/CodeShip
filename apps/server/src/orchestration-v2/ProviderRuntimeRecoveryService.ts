import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProviderThreadId,
  type OrchestrationV2RestartCancelledBackgroundWork,
  type OrchestrationV2RestartHold,
  type OrchestrationV2RestartHoldWork,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  isOrchestrationV2WorkActive,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
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
import {
  awaitingProviderThreadId,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  mergeRestartCancelledBackgroundWork,
  neverStarted,
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
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: Effect.Effect<void, ProviderRuntimeRecoveryError>;
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

function nonterminalRuns(projection: ProjectionStore.ProjectionRuntimeRecoveryState) {
  return projection.runs.filter((run) => {
    const status: string = run.status;
    return (
      status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting"
    );
  });
}

function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/**
 * A delegate_task child. Its own thread is reconciled and continued on its own
 * (here, or in the linked environment it runs in) and reports back through
 * the app, so it is not provider background work.
 */
function isAppOwnedDelegation(task: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId: ThreadId | null;
  readonly remoteChild?: OrchestrationV2Subagent["remoteChild"];
}): boolean {
  return (
    task.origin === "app_owned" && (task.childThreadId !== null || task.remoteChild !== undefined)
  );
}

function isAppOwnedDelegationItem(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
): boolean {
  return item.type === "subagent" && isAppOwnedDelegation(item);
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
 * records it for the restart note; an update waits on the awaited part of it before restarting.
 */
function restartCancelledBackgroundWork(
  projection: RecoveryProjection,
  cutRuns: ReadonlyArray<RecoveryRun>,
  messageRequestNodeIds: ReadonlySet<string>,
): ReadonlyMap<ProviderThreadId, ReadonlyArray<RestartCancelledEntry>> {
  const cancelled = new Map<ProviderThreadId, Array<RestartCancelledEntry>>();
  const recordedNativeIds = new Set<string>();
  // The roster carries the agent's t3_background_wait mark, which its turn item lacks.
  const awaitedNativeIds = new Set(
    (projection.providerThreads ?? []).flatMap((providerThread) =>
      (providerThread.pendingBackgroundTasks ?? []).flatMap((task) =>
        task.awaited === true ? [task.taskId] : [],
      ),
    ),
  );
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
    record(awaitingId, {
      work: nativeId != null && awaitedNativeIds.has(nativeId) ? { ...work, awaited: true } : work,
      holdId: nativeId ?? item.id,
    });
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
  const cutRunIds = new Set(cutRuns.map((run) => run.id));
  for (const item of projection.turnItems ?? []) {
    if (
      (item.runId !== null && cutRunIds.has(item.runId)) ||
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

// Coalesces an agent's bursts of tool events into one projection read per thread.
const RESTART_HOLD_SETTLE = Duration.millis(500);

function changesRestartHold(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "provider-thread.updated":
    case "run.updated":
    case "subagent.updated":
    case "runtime-request.updated":
      return true;
    case "turn-item.updated":
      return isBackgroundCapableTurnItemType(event.payload.type);
    default:
      return event.type.startsWith("thread.");
  }
}

function sameRestartHold(left: OrchestrationV2RestartHold, right: OrchestrationV2RestartHold) {
  return (
    left.work.length === right.work.length &&
    left.work.every((entry, index) => {
      const other = right.work[index]!;
      return (
        entry.threadId === other.threadId &&
        entry.threadTitle === other.threadTitle &&
        entry.kind === other.kind &&
        entry.label === other.label &&
        entry.id === other.id
      );
    })
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

function latestStartedRun(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  providerThreadId: ProviderThreadId,
) {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | undefined>(
    (latest, run) =>
      run.providerThreadId === providerThreadId &&
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      !neverStarted(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const restartResumeRequest = yield* RestartResumeRequest;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
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
    ) {
      const now = yield* DateTime.now;
      // Cut work stopped with the server, not when this pass noticed; scheduled recovery reads it.
      const stoppedAt = lastCommittedAt === null ? now : DateTime.min(lastCommittedAt, now);
      const runs = yield* cutRuns(projection);
      const { questions, messageRequestNodeIds, requests } = pendingRequestRecovery(projection);
      const cancelledBackgroundWork = restartCancelledBackgroundWork(
        projection,
        runs,
        messageRequestNodeIds,
      );
      // Delegated task rows, items and nodes stay open: the child settles them.
      const delegatedTaskNodeIds = new Set<string>([
        ...(projection.subagents ?? []).filter(isAppOwnedDelegation).map((subagent) => subagent.id),
        ...(projection.turnItems ?? []).flatMap((item) =>
          item.type === "subagent" && isAppOwnedDelegation(item) ? [item.subagentId] : [],
        ),
      ]);
      const detail = `Cancelled because the server ${trigger === "startup" ? "restarted" : "shut down"} before the provider work completed.`;
      const commandId = CommandId.make(
        `command:runtime-reconcile:${trigger}:${projection.thread.id}:${DateTime.formatIso(now)}`,
      );
      const allocateEventId = () =>
        ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
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
            // EventSink places the item after the run's existing items.
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === run.id)
                  .map((item) => item.ordinal),
              ) + 1,
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
      const recoveredNonterminalRunIds = new Set(runs.map((run) => run.id));
      const cancelledStaleNodeIds = new Set<string>();
      for (const item of projection.turnItems ?? []) {
        if (item.runId !== null && recoveredNonterminalRunIds.has(item.runId)) {
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
      for (const session of projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      )) {
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
        const noteRun = latestStartedRun(projection, providerThreadId);
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
      }
      const continuationRun =
        continueAfterRestart && trigger === "startup"
          ? restartResumeRun(
              { ...projection, providerSessions: sessionsLiveAtStart(projection, stoppedThisPass) },
              now,
            )
          : undefined;
      const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = continuationRun
        ? [
            {
              id: `effect:restart-continuation:${continuationRun.id}`,
              commandId,
              threadId: projection.thread.id,
              request: { type: "provider-runtime.continue", sourceRunId: continuationRun.id },
            },
          ]
        : [];
      const stoppedSessions = projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      ).length;
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
    let terminalizedRuns = 0;
    let stoppedSessions = 0;
    let closedRequests = 0;
    let retiredEffects = 0;
    const stoppedThisPass = new Map<string, RecoverySession>();
    for (const threadId of threadIds) {
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
      );
      for (const session of projection.providerSessions) {
        if (session.status !== "stopped" && session.status !== "error") {
          stoppedThisPass.set(session.id, session);
        }
      }
      terminalizedRuns += result.terminalizedRuns;
      stoppedSessions += result.stoppedSessions;
      closedRequests += result.closedRequests;
      retiredEffects += result.retiredEffects;
    }
    const outboxReconciliation = yield* outbox.reconcileAfterProcessLoss.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
      ),
    );
    return {
      terminalizedRuns,
      stoppedSessions,
      closedRequests,
      retiredEffects: retiredEffects + outboxReconciliation.cancelled,
      requeuedEffects: outboxReconciliation.requeued,
    } satisfies ProviderRuntimeReconciliationSummary;
  });

  const prepareForShutdown = Effect.gen(function* () {
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const resumeRequested = yield* restartResumeRequest;
    if (!enabled && !resumeRequested) return;
    const threadIds = yield* projections.getRecoveryThreadIds("runtime");
    for (const threadId of threadIds) {
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
            {
              id: `effect:restart-continuation:${run.id}`,
              commandId,
              threadId,
              request: { type: "provider-runtime.continue", sourceRunId: run.id },
            },
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
    const threadIds = yield* projections
      .getRecoveryThreadIds("runtime")
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    const work: Array<OrchestrationV2RestartHoldWork> = [];
    for (const threadId of threadIds) {
      const projection = yield* projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({ operation: "read-projections", threadId, cause }),
          ),
        );
      // Nobody waits in an archived or deleted thread, and its restart wakes nothing.
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) continue;
      const cancelled = restartCancelledBackgroundWork(
        projection,
        yield* cutRuns(projection),
        pendingRequestRecovery(projection).messageRequestNodeIds,
      );
      for (const entries of cancelled.values()) {
        for (const { work: entry, holdId } of entries) {
          if (!isAwaitedWork(entry)) continue;
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
    return { work } satisfies OrchestrationV2RestartHold;
  }).pipe(Effect.withSpan("ProviderRuntimeRecoveryService.restartHold"));

  const watchRestartHold = Stream.unwrap(
    eventSink.latestSequence().pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
      ),
      Effect.map((afterSequence) =>
        Stream.concat(
          Stream.fromEffect(restartHold),
          eventSink.stream({ afterSequence, bounded: true }).pipe(
            Stream.mapError(
              (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
            ),
            Stream.filter(({ event }) => changesRestartHold(event)),
            Stream.debounce(RESTART_HOLD_SETTLE),
            Stream.mapEffect(() => restartHold),
          ),
        ).pipe(Stream.changesWith(sameRestartHold)),
      ),
    ),
  );

  return ProviderRuntimeRecoveryService.of({
    reconcile,
    prepareForShutdown,
    recover,
    restartHold,
    watchRestartHold,
  });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
