import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type AccountRoutingContext, accountsWithRoom } from "./AccountRouting.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// A cooldown this short is cheaper to wait out than to move the thread to another account for good.
const MIN_FAILOVER_WAIT_MS = 5 * 60_000;

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
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
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
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

/** Moves a thread stopped by a usage limit to the first account of its driver with room left. */
export function limitFailoverCommand(
  input: AccountRoutingContext & {
    readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  },
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread, nowMs } = input;
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    // Limited accounts are skipped only until their reported reset, so a stop without one
    // could bounce between two limited accounts. A passed reset is auto-resume's job.
    !(resetMs > nowMs + MIN_FAILOVER_WAIT_MS) ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    // An armed stop already chose to wait for the reset.
    thread.limitRecovery?.runId === thread.latestRunId ||
    thread.latestRunProviderInstanceId !== thread.providerInstanceId ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const current = input.providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  );
  if (current === undefined) return null;
  const target = accountsWithRoom({
    ...input,
    driver: current.driver,
    projectId: thread.projectId,
    model: thread.modelSelection.model,
  }).find((account) => account.instanceId !== current.instanceId);
  if (target === undefined) return null;
  // The target is part of the id so a refused switch does not block trying another account.
  const identity = `${thread.id}:${thread.latestRunId}:${target.instanceId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-failover:${identity}`),
    messageId: MessageId.make(`limit-failover:${identity}`),
    threadId: thread.id,
    // Reuses the manual resume guard: the limited run must still be the thread's latest.
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: {
      ...thread.modelSelection,
      instanceId: target.instanceId,
      model: target.model,
    },
    text: "Continue where you left off.",
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
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  // Another account signing in, regaining room, or being enabled can take a waiting thread.
  yield* forkParked(
    Stream.runForEach(providerRegistry.streamChanges, () =>
      settings.getSettings.pipe(
        Effect.flatMap((current) =>
          current.failoverLimitedThreads ? due.invalidate : Effect.void,
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
    const failover =
      preferences.failoverLimitedThreads && candidates.length > 0
        ? {
            settings: preferences,
            providers: yield* providerRegistry.getProviders,
            limitedInstanceIds: yield* projections.getUsageLimitedProviderInstanceIds(now),
            nowMs,
          }
        : null;
    let acted = false;
    for (const thread of candidates) {
      const failoverCommand =
        failover === null ? null : limitFailoverCommand({ ...failover, thread });
      if (failoverCommand !== null) {
        const outcome = yield* threads.dispatch(failoverCommand).pipe(
          Effect.as("switched" as const),
          // This exact switch was refused on an earlier tick; warning again every tick adds nothing.
          Effect.catchTags({
            OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed("refused" as const),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as("failed" as const)),
          ),
        );
        // A refused switch stays refused, so only a switch or a failed attempt re-checks next tick.
        if (outcome !== "refused") acted = true;
        if (outcome === "switched") continue;
        // A refused or failed switch falls through, so the stop still arms its reset-time resume.
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
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
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
