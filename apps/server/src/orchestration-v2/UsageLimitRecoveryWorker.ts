import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  orderProviderInstancesForFailover,
  supportsAccountFailover,
} from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

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

const usageExhausted = (provider: ServerProvider, nowMs: number) =>
  provider.usageLimits?.windows.some(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  ) === true;

/** Moves a thread stopped by a usage limit to the first account of its driver with room left. */
export function limitFailoverCommand(input: {
  readonly thread: ProjectionStore.ProjectionLimitRecoveryCandidate;
  readonly settings: Pick<
    ServerSettingsValue,
    "providerInstanceFailoverOrder" | "providerInstances" | "projectSettingsOverrides"
  >;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly limitedInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly nowMs: number;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  const { thread, nowMs } = input;
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    // Limited accounts are skipped only until their reported reset, so a stop without one
    // could bounce between two limited accounts. A passed reset is auto-resume's job.
    !(resetMs > nowMs) ||
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
  if (current === undefined || !supportsAccountFailover(current.driver)) return null;
  const eligible = input.providers.flatMap((provider) => {
    if (
      provider.driver !== current.driver ||
      provider.instanceId === current.instanceId ||
      !provider.enabled ||
      !provider.installed ||
      provider.status === "error" ||
      provider.auth.status === "unauthenticated" ||
      !isProviderAvailable(provider) ||
      input.limitedInstanceIds.has(provider.instanceId) ||
      usageExhausted(provider, nowMs) ||
      !resolveProjectProviderInstanceEnabled(input.settings, thread.projectId, provider.instanceId)
    )
      return [];
    const model = resolveSelectableModel(
      provider.driver,
      thread.modelSelection.model,
      provider.models,
    );
    return model === null ? [] : [{ instanceId: provider.instanceId, model }];
  });
  const target = orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    eligible,
  )[0];
  if (target === undefined) return null;
  const identity = `${thread.id}:${thread.latestRunId}`;
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

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      failover: preferences.failoverLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    const failover =
      preferences.failoverLimitedThreads && candidates.length > 0
        ? {
            settings: preferences,
            providers: yield* providerRegistry.getProviders,
            limitedInstanceIds: yield* projections.getUsageLimitedProviderInstanceIds(now),
            nowMs,
          }
        : null;
    for (const thread of candidates) {
      const failoverCommand =
        failover === null ? null : limitFailoverCommand({ ...failover, thread });
      // A refused switch falls through, so the stop still arms its reset-time resume.
      if (
        failoverCommand !== null &&
        (yield* threads.dispatch(failoverCommand).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        ))
      )
        continue;
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
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
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
