import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type AccountRoutingContext,
  accountsWithRoom,
  type McpSignIns,
  readMcpSignIns,
  runLiftsScope,
  nextAccountRoomAt,
  recoveryRoomAt,
  routeAutoAccount,
} from "./AccountRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// A cooldown this short is cheaper to wait out than to move the thread to another account for good.
const MIN_FAILOVER_WAIT_MS = 5 * 60_000;

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

// No event announces a lift (Try again, or a run that got an answer), so a resume waiting on one
// checks again this often.
const LIFT_RECHECK_MS = 60_000;

/** Where the thread's next turn runs, and when it has room there (see `recoveryRoomAt`). */
export interface LimitRecoveryTarget {
  readonly selection: ModelSelection;
  readonly roomAtMs: number;
}

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  target: LimitRecoveryTarget | null = null,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  // Before the reset, the next turn may still run where it has room: on a model or account the
  // limit does not hold, or where it stopped once the hold there lifted.
  const early = resetMs > nowMs ? target : null;
  if (
    !recovery.autoResume ||
    // The resume refuses a thread moved to another account since its stop.
    (thread.latestRunProviderInstanceId != null &&
      thread.latestRunProviderInstanceId !== thread.providerInstanceId) ||
    (resetMs > nowMs && (early === null || early.roomAtMs > nowMs)) ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  // The target is part of an early resume's id, so a refused one does not block the reset's.
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}${
    early === null ? "" : `:${early.selection.instanceId}:${early.selection.model}`
  }`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    ...(early === null ? {} : { modelSelection: early.selection }),
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

type FailoverInput = AccountRoutingContext &
  McpSignIns & {
    readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  };

/**
 * Where a limited thread's next turn runs, and when it has room there: an Auto thread's current
 * Auto model, or the model it names. Null when that account cannot run it.
 */
export function limitRecoveryTarget({
  thread,
  ...input
}: FailoverInput): LimitRecoveryTarget | null {
  if (thread.latestRunProviderInstanceId == null || thread.latestRunModel == null) return null;
  const selection = routeAutoAccount({
    ...input,
    selection: thread.modelSelection,
    projectId: thread.projectId,
    currentInstanceId: thread.providerInstanceId,
    started: true,
  });
  // Another account is account switching's move, so a reset minutes away is waited out here too.
  if (
    selection.instanceId !== thread.latestRunProviderInstanceId &&
    !(Date.parse(thread.usageLimitResetAt ?? "") > input.nowMs + MIN_FAILOVER_WAIT_MS)
  )
    return null;
  const roomAtMs = recoveryRoomAt({
    ...input,
    selection,
    projectId: thread.projectId,
    stopped: { instanceId: thread.latestRunProviderInstanceId, model: thread.latestRunModel },
  });
  return roomAtMs === null ? null : { selection, roomAtMs };
}

/** The search for another account of its driver that a limited thread could move to, or null when it stays. */
function failoverSearch({ thread, ...input }: FailoverInput) {
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  if (
    (thread.status !== "failed" &&
      (thread.status !== "running" || thread.heldAttemptId === undefined)) ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    // Limited accounts are skipped only until their reported reset, so a stop without one
    // could bounce between two limited accounts. A passed reset is auto-resume's job.
    !(resetMs > input.nowMs + MIN_FAILOVER_WAIT_MS) ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    // Cancelling auto-resume keeps the thread until the user continues it.
    (thread.limitRecovery?.runId === thread.latestRunId && !thread.limitRecovery.autoResume) ||
    thread.latestRunProviderInstanceId !== thread.providerInstanceId ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > input.nowMs)
  )
    return null;
  const current = input.providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  );
  return current === undefined
    ? null
    : {
        ...input,
        driver: current.driver,
        projectId: thread.projectId,
        model: thread.modelSelection.model,
        exceptInstanceId: current.instanceId,
        runId: thread.latestRunId,
      };
}

/**
 * Moves a thread stopped by a usage limit, or held by its provider until the reset, to the first
 * account of its driver with room left.
 */
export function limitFailoverCommand(
  input: FailoverInput,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread } = input;
  const search = failoverSearch(input);
  if (search === null) return null;
  const heldAttemptId = thread.status === "running" ? thread.heldAttemptId : undefined;
  const target = accountsWithRoom(search).find(
    (account) => account.instanceId !== search.exceptInstanceId,
  );
  if (target === undefined) return null;
  // The target is part of the id so a refused switch does not block trying another account.
  // A held run keeps its id across restarts, so its attempt tells each hold apart.
  const hold = heldAttemptId === undefined ? "" : `${heldAttemptId}:`;
  const identity = `${thread.id}:${search.runId}:${hold}${target.instanceId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-failover:${identity}`),
    messageId: MessageId.make(`limit-failover:${identity}`),
    threadId: thread.id,
    automaticContinuationOfRunId: search.runId,
    // A stopped run reuses the manual resume guard: it must still be the thread's latest.
    ...(heldAttemptId === undefined ? { manualContinuationOfRunId: search.runId } : {}),
    modelSelection: {
      ...thread.modelSelection,
      instanceId: target.instanceId,
      model: target.model,
    },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode:
      heldAttemptId === undefined
        ? { type: "start_immediately" }
        : { type: "restart_active", targetRunId: search.runId },
    createdBy: "user",
    creationSource: "server",
  };
}

// A stop older than this is left to the person, as a lost connection's is.
const MAX_SIGNED_OUT_FAILURE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Moves a thread whose run a rejected login stopped before the agent did any work to the first
 * other account of its driver that can run it. The agent never saw the message, so it is sent again.
 * Only while the account still reads signed out: signing in again leaves the thread where it is.
 */
export function signedOutFailoverCommand(
  input: AccountRoutingContext &
    McpSignIns & {
      readonly thread: ProjectionStore.ProjectionSignedOutCandidate;
    },
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread } = input;
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.latestRunProviderInstanceId !== thread.providerInstanceId ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > input.nowMs)
  )
    return null;
  const current = input.providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  );
  if (current === undefined || current.auth.status !== "unauthenticated") return null;
  const target = accountsWithRoom({
    ...input,
    driver: current.driver,
    projectId: thread.projectId,
    model: thread.modelSelection.model,
  }).find((account) => account.instanceId !== current.instanceId);
  if (target === undefined) return null;
  const identity = `${thread.id}:${thread.latestRunId}:${target.instanceId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`signed-out-failover:${identity}`),
    messageId: MessageId.make(`signed-out-failover:${identity}`),
    threadId: thread.id,
    automaticContinuationOfRunId: thread.latestRunId,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: {
      ...thread.modelSelection,
      instanceId: target.instanceId,
      model: target.model,
    },
    text: thread.messageText,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const mcp = yield* ProviderMcp.ProviderMcp;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  // An account signing in, regaining room, or being enabled can take a waiting thread.
  yield* forkParked(
    Stream.runForEach(providerRegistry.streamChanges, () =>
      settings.getSettings.pipe(
        Effect.flatMap((current) =>
          current.failoverLimitedThreads || current.autoResumeLimitedThreads
            ? due.invalidate
            : Effect.void,
        ),
      ),
    ),
  );
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      failover: preferences.failoverLimitedThreads,
    });
    const signedOut = preferences.failoverLimitedThreads
      ? yield* projections.getSignedOutFailoverCandidates({
          now,
          maxAgeMs: MAX_SIGNED_OUT_FAILURE_AGE_MS,
        })
      : [];
    const providers =
      candidates.length > 0 || signedOut.length > 0 ? yield* providerRegistry.getProviders : null;
    const routing =
      providers === null
        ? null
        : {
            settings: preferences,
            providers,
            recordedLimits: yield* projections.getUsageLimitedProviderInstances(
              now,
              runLiftsScope(providers),
            ),
            // A sweep must not start providers, so only the MCP state already loaded counts.
            mcpSignInsNeeded: yield* readMcpSignIns(mcp, {
              settings: preferences,
              providers,
              nowMs,
              mode: "loaded",
            }),
            nowMs,
          };
    const failover = preferences.failoverLimitedThreads ? routing : null;
    const dispatchSwitch = (
      command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
      failureMessage: string,
    ) =>
      threads.dispatch(command).pipe(
        Effect.as("switched" as const),
        // This exact switch was refused on an earlier tick; warning again every tick adds nothing.
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed("refused" as const),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(failureMessage, { threadId: command.threadId, cause }).pipe(
            Effect.as("failed" as const),
          ),
        ),
      );
    let acted = false;
    let targetRoomAt = Infinity;
    for (const thread of signedOut) {
      const command = failover === null ? null : signedOutFailoverCommand({ ...failover, thread });
      if (command === null) continue;
      const outcome = yield* dispatchSwitch(
        command,
        "orchestration-v2.signed-out-failover.dispatch-failed",
      );
      if (outcome !== "refused") acted = true;
    }
    for (const thread of candidates) {
      const failoverCommand =
        failover === null ? null : limitFailoverCommand({ ...failover, thread });
      if (failoverCommand !== null) {
        const outcome = yield* dispatchSwitch(
          failoverCommand,
          "orchestration-v2.limit-failover.dispatch-failed",
        );
        // A refused switch stays refused, so only a switch or a failed attempt re-checks next tick.
        if (outcome !== "refused") acted = true;
        if (outcome === "switched") continue;
        // A refused or failed switch falls through, so the stop still arms its reset-time resume.
      }
      const target = routing === null ? null : limitRecoveryTarget({ ...routing, thread });
      const recover = (room: LimitRecoveryTarget | null) =>
        limitRecoveryCommand(
          thread,
          preferences.autoResumeLimitedThreads,
          nowMs,
          preferences.snoozeLimitedThreads,
          room,
        );
      const command = recover(target);
      if (command === null) {
        // A resume that waits only for room on its target checks again when that room comes.
        if (
          target !== null &&
          target.roomAtMs > nowMs &&
          recover({ ...target, roomAtMs: nowMs }) !== null
        )
          targetRoomAt = Math.min(
            targetRoomAt,
            Number.isFinite(target.roomAtMs) ? target.roomAtMs : nowMs + LIFT_RECHECK_MS,
          );
        continue;
      }
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    // A waiting thread can move to another account the moment that account's limit ends.
    const accountRoomAt =
      failover === null
        ? Infinity
        : Math.min(
            ...candidates.flatMap((thread) => {
              const search = failoverSearch({ ...failover, thread });
              const at = search === null ? null : nextAccountRoomAt(search);
              return at === null ? [] : [at];
            }),
          );
    yield* due.record(
      readVersion,
      Math.min(wakeAt ?? Infinity, accountRoomAt, targetRoomAt),
      nowMs,
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
