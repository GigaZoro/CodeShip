import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { limitRecoveryDeclined, snoozeHoldsStop } from "@t3tools/shared/orchestrationV2ThreadError";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
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
  modelWithRoom,
  nextAccountRoomAt,
  recoveryRoomAt,
  routeAutoAccount,
  usableModel,
} from "./AccountRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ResetCreditRedemption from "./ResetCreditRedemption.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// A cooldown this short is cheaper to wait out than to move the thread to another account for good.
const MIN_FAILOVER_WAIT_MS = 5 * 60_000;
// A reset this close is cheaper to wait out than to spend a banked reset credit on.
const MIN_RESET_CREDIT_WAIT_MS = 30 * 60_000;
// After a redemption, whatever its outcome, the account is left alone this long, so a refused
// claim is not repeated every tick and a limit a reset does not lift cannot spend credit after credit.
const RESET_CREDIT_RETRY_MS = 15 * 60_000;

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

// No event announces a lift (Try again, or a run that got an answer), so a resume waiting on one
// checks again this often.
const LIFT_RECHECK_MS = 60_000;

type ArmCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.limit-recovery.arm" }
>;
type DispatchCommand = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

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
): ArmCommand | DispatchCommand | null {
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
      type: "thread.limit-recovery.arm",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        // Settings never turn auto-resume off on the person's behalf; leaving it out keeps it unset.
        ...(autoResume ? { autoResume } : {}),
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
    readonly settings: Pick<ServerSettingsValue, "autoUseResetCredits">;
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

/**
 * The run of a thread a usage limit stopped, or its provider holds until the reset, while the
 * thread still waits on the account that ran it; null when nothing may continue it automatically.
 */
function waitingRunId(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  nowMs: number,
): RunId | null {
  if (
    (thread.status !== "failed" &&
      (thread.status !== "running" || thread.heldAttemptId === undefined)) ||
    thread.lastErrorClass !== "usage_limit" ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    // A Stop or turning auto-resume off keeps the thread until the person continues it.
    thread.latestRunId === null ||
    thread.latestRunStopRequested === true ||
    limitRecoveryDeclined(thread.limitRecovery, thread.latestRunId) ||
    thread.latestRunProviderInstanceId !== thread.providerInstanceId ||
    snoozeHoldsStop(thread, thread.latestRunId, nowMs)
  )
    return null;
  return thread.latestRunId;
}

/** Continues a limited thread's run, restarting it when its provider holds it, optionally on another account. */
function continueLimitedRun(
  kind: "limit-failover" | "limit-reset-resume",
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  runId: RunId,
  target?: { readonly instanceId: ProviderInstanceId; readonly model: string },
): DispatchCommand {
  const heldAttemptId = thread.status === "running" ? thread.heldAttemptId : undefined;
  // A held run keeps its id across restarts, so its attempt tells each hold apart. The target is
  // part of the id so a refused switch does not block trying another account.
  const identity = [thread.id, runId, heldAttemptId, target?.instanceId]
    .filter((part) => part !== undefined)
    .join(":");
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`${kind}:${identity}`),
    messageId: MessageId.make(`${kind}:${identity}`),
    threadId: thread.id,
    automaticContinuationOfRunId: runId,
    // A stopped run reuses the manual resume guard: it must still be the thread's latest.
    ...(heldAttemptId === undefined ? { manualContinuationOfRunId: runId } : {}),
    ...(target === undefined
      ? {}
      : {
          modelSelection: {
            ...thread.modelSelection,
            instanceId: target.instanceId,
            model: target.model,
          },
        }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode:
      heldAttemptId === undefined
        ? { type: "start_immediately" }
        : { type: "restart_active", targetRunId: runId },
    createdBy: "user",
    creationSource: "server",
  };
}

/** The search for another account of its driver that a limited thread could move to, or null when it stays. */
function failoverSearch({ thread, ...input }: FailoverInput) {
  const runId = waitingRunId(thread, input.nowMs);
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  // Limited accounts are skipped only until their reported reset, so a stop without one
  // could bounce between two limited accounts. A passed reset is auto-resume's job.
  if (runId === null || !(resetMs > input.nowMs + MIN_FAILOVER_WAIT_MS)) return null;
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
        runId,
      };
}

/**
 * Moves a thread stopped by a usage limit, or held by its provider until the reset, to the first
 * account of its driver with room left.
 */
export function limitFailoverCommand(input: FailoverInput): DispatchCommand | null {
  const search = failoverSearch(input);
  if (search === null) return null;
  const target = accountsWithRoom(search).find(
    (account) => account.instanceId !== search.exceptInstanceId,
  );
  return target === undefined
    ? null
    : continueLimitedRun("limit-failover", input.thread, search.runId, target);
}

/** The waiting thread's own account and run, when that account uses banked reset credits automatically. */
function resetCreditAccount({ thread, ...input }: FailoverInput) {
  const runId = waitingRunId(thread, input.nowMs);
  if (runId === null || !input.settings.autoUseResetCredits.includes(thread.providerInstanceId))
    return null;
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === thread.providerInstanceId,
  );
  return provider === undefined ? null : { provider, runId };
}

/**
 * Continues a limited thread on its own account once that account has room again before the
 * reset, as after a redeemed reset credit, when the account uses reset credits automatically.
 */
export function resetCreditResumeCommand(input: FailoverInput): DispatchCommand | null {
  const { thread } = input;
  const account = resetCreditAccount(input);
  if (
    account === null ||
    modelWithRoom(account.provider, {
      ...input,
      projectId: thread.projectId,
      model: thread.modelSelection.model,
    }) === null
  )
    return null;
  return continueLimitedRun("limit-reset-resume", thread, account.runId);
}

/**
 * The account to redeem a banked reset credit on so a limited thread can continue there, or null
 * when the thread waits. Only while the account's own limits read used up for the thread's model:
 * that is what a reset clears, unlike a refusal such as ChatGPT's app cap.
 */
export function resetCreditRedemptionAccount(input: FailoverInput): ProviderInstanceId | null {
  const { thread } = input;
  const account = resetCreditAccount(input);
  if (account === null) return null;
  const { provider } = account;
  // Only usage may keep the thread off the account; a credit cannot help one it cannot run on.
  const model = usableModel(provider, {
    ...input,
    projectId: thread.projectId,
    model: thread.modelSelection.model,
  });
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  return model !== null &&
    (provider.usageLimits?.resetCredits?.availableCount ?? 0) > 0 &&
    resetMs > input.nowMs + MIN_RESET_CREDIT_WAIT_MS &&
    exhaustedUsageWindow(provider, input.nowMs, model) !== undefined
    ? provider.instanceId
    : null;
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
): DispatchCommand | null {
  const { thread } = input;
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.latestRunProviderInstanceId !== thread.providerInstanceId ||
    snoozeHoldsStop(thread, thread.latestRunId, input.nowMs)
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
  const resetCredits = yield* ResetCreditRedemption.ResetCreditRedemption;
  const due = DueHint.make();
  // When each account last had a reset credit redeemed for it, so retries wait RESET_CREDIT_RETRY_MS.
  const redemptionTries = new Map<ProviderInstanceId, number>();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  // An account signing in, regaining room, being enabled or banking a reset credit can take a
  // waiting thread.
  yield* forkParked(
    Stream.runForEach(providerRegistry.streamChanges, () =>
      settings.getSettings.pipe(
        Effect.flatMap((current) =>
          current.failoverLimitedThreads ||
          current.autoResumeLimitedThreads ||
          current.autoUseResetCredits.length > 0
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
    const switching = preferences.failoverLimitedThreads;
    const resetting = preferences.autoUseResetCredits.length > 0;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      waiting: switching || resetting,
    });
    const signedOut = switching
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
    const failover = switching ? routing : null;
    const dispatchContinuation = (command: DispatchCommand, failureMessage: string) =>
      threads.dispatch(command).pipe(
        Effect.as("dispatched" as const),
        // This exact command was refused on an earlier tick; warning again every tick adds nothing.
        // A snooze the person set meanwhile holds it until the thread wakes.
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed("refused" as const),
          OrchestratorContinuationSnoozedError: () => Effect.succeed("refused" as const),
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
      const outcome = yield* dispatchContinuation(
        command,
        "orchestration-v2.signed-out-failover.dispatch-failed",
      );
      if (outcome !== "refused") acted = true;
    }
    // One credit per sweep: it can give room that other threads move to, so the next sweep reads
    // the accounts again before spending another.
    let redeemOn: ProviderInstanceId | null = null;
    let retryRedemptionAt = Infinity;
    for (const thread of candidates) {
      // Another account with room comes first: it costs no banked credit.
      const continuation =
        (failover === null ? null : limitFailoverCommand({ ...failover, thread })) ??
        (routing === null ? null : resetCreditResumeCommand({ ...routing, thread }));
      if (continuation !== null) {
        const outcome = yield* dispatchContinuation(
          continuation,
          "orchestration-v2.limit-continuation.dispatch-failed",
        );
        // A refused command stays refused, so only a dispatch or a failed attempt re-checks next tick.
        if (outcome !== "refused") acted = true;
        if (outcome === "dispatched") continue;
        // A refused or failed one falls through, so the stop still arms its reset-time resume.
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
      // A resume that has room now, on another model or account, costs no banked credit either.
      const redemption =
        routing === null || command?.type === "message.dispatch"
          ? null
          : resetCreditRedemptionAccount({ ...routing, thread });
      if (redemption !== null) {
        const triedAt = redemptionTries.get(redemption);
        if (triedAt === undefined || nowMs >= triedAt + RESET_CREDIT_RETRY_MS) {
          // Arming now could hide the thread until the reset or record it as not resuming, which
          // would keep the reset from continuing it. A redemption that does not reset arms it next tick.
          redeemOn ??= redemption;
          continue;
        }
        retryRedemptionAt = Math.min(retryRedemptionAt, triedAt + RESET_CREDIT_RETRY_MS);
      }
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
        if (command.type === "thread.limit-recovery.arm")
          yield* orchestrator.autoArmLimitRecovery(command);
        else yield* threads.dispatch(command);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // The person may stop or snooze a thread, or turn off its auto-resume or the account's setting,
    // while this sweep dispatched. A credit is spent only for a thread that still waits for one right
    // before it is redeemed; such a change also invalidates the due hint, so the next tick re-reads.
    const stillWanted = Effect.fn("UsageLimitRecoveryWorker.stillWanted")(function* (
      instanceId: ProviderInstanceId,
    ) {
      if (routing === null) return false;
      const current = yield* settings.getSettings;
      const waiting = yield* projections.getLimitRecoveryCandidates({
        now,
        autoResume: current.autoResumeLimitedThreads,
        snooze: current.snoozeLimitedThreads,
        waiting: true,
      });
      return waiting.some(
        (thread) =>
          resetCreditRedemptionAccount({ ...routing, settings: current, thread }) === instanceId,
      );
    });
    if (redeemOn !== null && (yield* stillWanted(redeemOn))) {
      const instanceId = redeemOn;
      redemptionTries.set(instanceId, nowMs);
      // A reset lifts the account's holds, so the next tick continues its threads there.
      acted = true;
      yield* resetCredits.redeem(instanceId).pipe(
        Effect.tap(({ outcome, warning }) =>
          Effect.logInfo("orchestration-v2.reset-credit.outcome", {
            instanceId,
            outcome,
            warning,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.reset-credit.redeem-failed", { instanceId, cause }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now, {
      waiting: switching || resetting,
    });
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
      Math.min(wakeAt ?? Infinity, accountRoomAt, targetRoomAt, retryRedemptionAt),
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
