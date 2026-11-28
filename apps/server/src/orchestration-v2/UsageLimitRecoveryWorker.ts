import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  isProviderInstanceBackgroundAllowed,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { limitRecoveryDeclined, snoozeHoldsStop } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { canAccountRun } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AccountRouting,
  type AccountRoutingContext,
  type AccountEligibility,
  accountsWithRoom,
  type McpSignIns,
  readMcpSignIns,
  runLiftsScope,
  modelWithRoom,
  nextAccountRoomAt,
  recoveryRoomAt,
  resolveAutoRoute,
  routeAutoAccount,
} from "./AccountRouting.ts";
import {
  boundedCandidates,
  type DispatchRecorder,
  evidenceKey,
  makeDispatchRecorder,
  recordStopDecision,
  recordDispatchFailure,
} from "./StopDecisionEvidence.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { routineSpan } from "@t3tools/shared/observability";

// A cooldown this short is cheaper to wait out than to move the thread to another account for good.
const MIN_FAILOVER_WAIT_MS = 5 * 60_000;

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

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
    createdBy: "agent",
    creationSource: "server",
  };
}

type FailoverInput = AccountRoutingContext &
  McpSignIns & {
    readonly settings: Pick<ServerSettingsValue, "redeemUsageResets">;
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
    (!isProviderInstanceBackgroundAllowed(input.settings, selection.instanceId) ||
      !(Date.parse(thread.usageLimitResetAt ?? "") > input.nowMs + MIN_FAILOVER_WAIT_MS))
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

const LIMIT_RESET_RESUME = "limit-reset-resume";

/** Continues a limited thread's run, restarting it when its provider holds it, optionally on another account. */
function continueLimitedRun(
  kind: "limit-failover" | typeof LIMIT_RESET_RESUME,
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

/**
 * The model a started thread's next turn runs: an Auto thread's current Auto model, which dispatch
 * routing puts it on and may not be the one it last ran, else the one it names.
 */
function nextTurnModel(
  input: Pick<AccountRoutingContext, "settings" | "providers">,
  thread: Pick<ProjectionStore.ProjectionSignedOutCandidate, "projectId" | "modelSelection">,
): string {
  return resolveAutoRoute({
    ...input,
    selection: thread.modelSelection,
    projectId: thread.projectId,
    started: true,
  }).searchModel;
}

/** The search for another account of `current`'s driver that could run the thread's next turn. */
function otherAccountSearch<Input extends AccountRoutingContext & McpSignIns>(
  input: Input,
  thread: Pick<ProjectionStore.ProjectionSignedOutCandidate, "projectId" | "modelSelection">,
  current: Input["providers"][number],
) {
  return {
    ...input,
    background: true,
    driver: current.driver,
    projectId: thread.projectId,
    model: nextTurnModel(input, thread),
    exceptInstanceId: current.instanceId,
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
  return current === undefined ? null : { ...otherAccountSearch(input, thread, current), runId };
}

/**
 * Moves a thread stopped by a usage limit, or held by its provider until the reset, to the first
 * account of its driver with room left.
 */
export function limitFailoverCommand(input: FailoverInput): DispatchCommand | null {
  return limitFailoverDecision(input).command;
}

export function limitFailoverDecision(input: FailoverInput, switching = true) {
  const search = switching ? failoverSearch(input) : null;
  const candidates: Array<{ id: string; reason: AccountEligibility | "source_account" }> = [];
  const observe = (instanceId: ProviderInstanceId, reason: AccountEligibility) => {
    candidates.push({
      id: evidenceKey(instanceId),
      reason: instanceId === input.thread.providerInstanceId ? "source_account" : reason,
    });
  };
  const target =
    search === null
      ? undefined
      : accountsWithRoom(search, observe).find(
          (account) => account.instanceId !== search.exceptInstanceId,
        );
  const command =
    search === null || target === undefined
      ? null
      : continueLimitedRun("limit-failover", input.thread, search.runId, target);
  const reason = !switching
    ? "switching_disabled"
    : search === null
      ? "search_not_applicable"
      : target !== undefined
        ? "selected"
        : "no_eligible_account";
  return {
    command,
    evidence: {
      reason,
      ...boundedCandidates(candidates, target ? evidenceKey(target.instanceId) : null),
      selected: target === undefined ? null : evidenceKey(target.instanceId),
    },
  };
}

/** The waiting thread's own account and run, when this machine redeems banked usage resets. */
function resetCreditAccount({ thread, ...input }: FailoverInput) {
  const runId = waitingRunId(thread, input.nowMs);
  if (runId === null || !input.settings.redeemUsageResets) return null;
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === thread.providerInstanceId,
  );
  return provider === undefined ? null : { provider, runId };
}

/**
 * Continues a limited thread on its own account once that account has room again before the
 * reset, as after a redeemed banked reset, when this machine redeems them. A reset-credit resume
 * that hits a usage limit again on the same account and model without doing work stops here, so a
 * model-locked account cannot loop.
 */
export function resetCreditResumeCommand(input: FailoverInput): DispatchCommand | null {
  const { thread } = input;
  const account = resetCreditAccount(input);
  if (account === null) return null;
  const model = modelWithRoom(account.provider, {
    ...input,
    projectId: thread.projectId,
    model: nextTurnModel(input, thread),
  });
  if (model === null) return null;
  if (
    !thread.latestRunWorkDone &&
    thread.latestRunUserMessageId?.startsWith(`${LIMIT_RESET_RESUME}:`)
  ) {
    const latestRunModel =
      thread.latestRunModel == null
        ? null
        : (resolveSelectableModel(
            account.provider.driver,
            thread.latestRunModel,
            account.provider.models,
          ) ?? thread.latestRunModel);
    if (latestRunModel === null || latestRunModel === model) return null;
  }
  return continueLimitedRun(LIMIT_RESET_RESUME, thread, account.runId);
}

// A stop older than this is left to the person, as a lost connection's is.
const MAX_SIGNED_OUT_FAILURE_AGE_MS = 24 * 60 * 60 * 1000;

type SignedOutInput = AccountRoutingContext &
  McpSignIns & {
    readonly thread: ProjectionStore.ProjectionSignedOutCandidate;
  };

/** Whether the thread still waits on the account whose login its latest run's failure rejected. */
function waitsOnSignedOutAccount(thread: SignedOutInput["thread"], nowMs: number): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.latestRunProviderInstanceId === thread.providerInstanceId &&
    !snoozeHoldsStop(thread, thread.latestRunId, nowMs)
  );
}

/**
 * The search for another account a thread stopped by a rejected login could move to, or null when
 * it stays: while the account still reads signed out, and only before the agent did any work,
 * which a new account would repeat.
 */
function signedOutSearch({ thread, ...input }: SignedOutInput) {
  if (thread.workDone || !waitsOnSignedOutAccount(thread, input.nowMs)) return null;
  const current = input.providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  );
  return current === undefined || current.auth.status !== "unauthenticated"
    ? null
    : otherAccountSearch(input, thread, current);
}

/**
 * Moves a thread whose run a rejected login stopped before the agent did any work to the first
 * other account of its driver that can run it. The agent never saw the message, so it is sent again.
 */
export function signedOutFailoverCommand(input: SignedOutInput): DispatchCommand | null {
  const { thread } = input;
  const search = signedOutSearch(input);
  if (search === null) return null;
  const target = accountsWithRoom(search).find(
    (account) => account.instanceId !== search.exceptInstanceId,
  );
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
    ...thread.message,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const SIGNED_IN_RESUME = "signed-in-resume";

type SignedInResumeInput = SignedOutInput & {
  readonly settings: Pick<ServerSettingsValue, "autoResumeLimitedThreads">;
};

/**
 * Continues a thread a rejected login stopped once a later check reads its account signed in,
 * resending a message the agent did no work on, since it may never have reached the agent. A
 * resume rejected before any work stays for the person: a check cannot see every rejected login.
 */
export function signedInResumeCommand({
  thread,
  ...input
}: SignedInResumeInput): DispatchCommand | null {
  if (
    !input.settings.autoResumeLimitedThreads ||
    !waitsOnSignedOutAccount(thread, input.nowMs) ||
    (!thread.workDone && thread.latestRunUserMessageId.startsWith(`${SIGNED_IN_RESUME}:`))
  )
    return null;
  const account = input.providers.find(
    (provider) => provider.instanceId === thread.providerInstanceId,
  );
  if (
    account === undefined ||
    !canAccountRun(account, input.settings, thread.projectId) ||
    !(Date.parse(account.checkedAt) > DateTime.toEpochMillis(thread.latestRunCompletedAt))
  )
    return null;
  const id = `${SIGNED_IN_RESUME}:${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: thread.id,
    automaticContinuationOfRunId: thread.latestRunId,
    manualContinuationOfRunId: thread.latestRunId,
    ...(thread.workDone ? { text: CONTINUE_PROMPT, attachments: [] } : thread.message),
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
  const accountRouting = yield* AccountRouting;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  // An account signing in, regaining room, being enabled or having a banked reset redeemed can
  // take a waiting thread.
  yield* forkParked(
    Stream.runForEach(providerRegistry.streamChanges, () =>
      settings.getSettings.pipe(
        Effect.flatMap((current) =>
          current.failoverLimitedThreads ||
          current.autoResumeLimitedThreads ||
          current.redeemUsageResets
            ? due.invalidate
            : Effect.void,
        ),
      ),
    ),
  );
  // Decisions already written, so a stop that looks the same every tick takes no write lock.
  const recentDecisions = new Set<string>();
  return Effect.fn("UsageLimitRecoveryWorker.sweep", { attributes: routineSpan })(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    // A lift records no event, so the threads that wait on it are read again here.
    if (yield* accountRouting.releaseAllowedHolds) yield* due.invalidate;
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const switching = preferences.failoverLimitedThreads;
    const resetting = preferences.redeemUsageResets;
    const resuming = preferences.autoResumeLimitedThreads;
    const candidates = yield* projections
      .getLimitRecoveryCandidates({
        now,
        autoResume: resuming,
        snooze: preferences.snoozeLimitedThreads,
        waiting: switching || resetting,
        observeStops: true,
      })
      .pipe(NodeSqliteClient.inBackground);
    const signedOut =
      switching || resuming
        ? yield* projections
            .getSignedOutCandidates({ now, maxAgeMs: MAX_SIGNED_OUT_FAILURE_AGE_MS })
            .pipe(NodeSqliteClient.inBackground)
        : [];
    const providers =
      candidates.some((thread) => !thread.observationOnly) || signedOut.length > 0
        ? yield* providerRegistry.getProviders
        : null;
    const routing =
      providers === null
        ? null
        : {
            settings: preferences,
            providers,
            recordedLimits: yield* projections
              .getUsageLimitedProviderInstances(now, runLiftsScope(providers))
              .pipe(NodeSqliteClient.inBackground),
            // A sweep must not start providers, so only the MCP state already loaded counts.
            mcpSignInsNeeded: yield* readMcpSignIns(mcp, {
              settings: preferences,
              providers,
              nowMs,
              mode: "loaded",
            }),
            nowMs,
          };
    // Each stopped thread is the requester its prepaid credits are judged for, as at dispatch.
    const routings = new Map(
      routing === null
        ? []
        : yield* Effect.forEach(
            [...signedOut, ...candidates.filter((thread) => !thread.observationOnly)],
            (thread) =>
              accountRouting
                .creditAccess(thread.id)
                .pipe(
                  Effect.map((creditAccess) => [thread.id, { ...routing, creditAccess }] as const),
                ),
          ),
    );
    const routingFor = (thread: { readonly id: ThreadId }) => routings.get(thread.id) ?? null;
    const failoverFor = (thread: { readonly id: ThreadId }) =>
      switching ? routingFor(thread) : null;
    const dispatchContinuation = (
      command: DispatchCommand,
      failureMessage: string,
      recorder?: DispatchRecorder,
    ) =>
      (recorder ? threads.dispatch(command, recorder) : threads.dispatch(command)).pipe(
        Effect.as("dispatched" as const),
        // This exact command was refused on an earlier tick; warning again every tick adds nothing.
        // A snooze the person set meanwhile holds it until the thread wakes.
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed("refused" as const),
          ThreadManagementProviderInstanceDisabledError: () => Effect.succeed("refused" as const),
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
      // Moving needs the account still signed out, resuming it signed in, so at most one applies.
      const failover = failoverFor(thread);
      const routed = routingFor(thread);
      const command =
        (failover === null ? null : signedOutFailoverCommand({ ...failover, thread })) ??
        (routed === null ? null : signedInResumeCommand({ ...routed, thread }));
      if (command === null) continue;
      const outcome = yield* dispatchContinuation(
        command,
        "orchestration-v2.signed-out-recovery.dispatch-failed",
      );
      if (outcome !== "refused") acted = true;
    }
    for (const thread of candidates) {
      const routed = routingFor(thread);
      if (thread.latestRunId === null) continue;
      if (thread.observationOnly) {
        yield* recordStopDecision(
          {
            source: thread.latestRunId,
            heldAttempt: undefined,
            command: null,
            nowMs,
            evidence: {
              reason: switching ? "no_actionable_reset" : "switching_disabled",
              candidates: [],
              omitted: 0,
              selected: null,
            },
          },
          { recent: recentDecisions },
        );
        continue;
      }
      if (routed === null) continue;
      // Another account with room comes first: it costs no banked credit.
      const decision = limitFailoverDecision({ ...routed, thread }, switching);
      const continuation = decision.command ?? resetCreditResumeCommand({ ...routed, thread });
      const source = thread.latestRunId;
      const record = (command: DispatchCommand | null, evidence = decision.evidence) =>
        recordStopDecision(
          { source, heldAttempt: thread.heldAttemptId, command, evidence, nowMs },
          { recent: recentDecisions },
        );
      const dispatchRecorded = Effect.fnUntraced(function* (
        command: DispatchCommand,
        evidence: typeof decision.evidence,
        message: string,
      ) {
        const sql = yield* SqlClient.SqlClient;
        const recorder = makeDispatchRecorder(
          { source, heldAttempt: thread.heldAttemptId, command, evidence, nowMs },
          sql,
        );
        const outcome = yield* dispatchContinuation(command, message, recorder);
        // Thread management routes before recording; a dispatch that failed earlier still leaves one.
        const decisionKey = recorder.decisionKey() ?? (yield* record(command, evidence));
        if (outcome !== "dispatched" && decisionKey !== undefined)
          yield* recordDispatchFailure(decisionKey, outcome);
        return outcome;
      });
      const resetEvidence = (
        command: DispatchCommand,
        reason: "reset_credit_room" | "reset_elapsed" | "early_resume_room",
      ) => {
        const selected =
          reason === "reset_elapsed"
            ? null
            : evidenceKey(command.modelSelection?.instanceId ?? thread.providerInstanceId);
        return {
          reason,
          selected,
          candidates: selected === null ? [] : [{ id: selected, reason: "eligible" as const }],
          omitted: 0,
          failover: decision.evidence,
        };
      };
      if (continuation !== null) {
        const outcome = yield* dispatchRecorded(
          continuation,
          decision.command === null
            ? resetEvidence(continuation, "reset_credit_room")
            : decision.evidence,
          "orchestration-v2.limit-continuation.dispatch-failed",
        );
        // A refused command stays refused, so only a dispatch or a failed attempt re-checks next tick.
        if (outcome !== "refused") acted = true;
        if (outcome === "dispatched") continue;
        // A refused or failed one falls through, so the stop still arms its reset-time resume.
      }
      const target = limitRecoveryTarget({ ...routed, thread });
      const recover = (room: LimitRecoveryTarget | null) =>
        limitRecoveryCommand(
          thread,
          preferences.autoResumeLimitedThreads,
          nowMs,
          preferences.snoozeLimitedThreads,
          room,
        );
      const command = recover(target);
      if (continuation === null && command?.type !== "message.dispatch") yield* record(null);
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
        else {
          yield* dispatchRecorded(
            command,
            resetEvidence(
              command,
              command.modelSelection === undefined ? "reset_elapsed" : "early_resume_room",
            ),
            "orchestration-v2.limit-recovery.dispatch-failed",
          );
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
    const wakeAt = yield* projections
      .getLimitRecoveryWakeAt(now, { waiting: switching || resetting })
      .pipe(NodeSqliteClient.inBackground);
    // A waiting or signed-out thread can move to another account the moment its limit ends.
    const searches = [
      ...candidates.map((thread) => {
        const failover = failoverFor(thread);
        return failover === null ? null : failoverSearch({ ...failover, thread });
      }),
      ...signedOut.map((thread) => {
        const failover = failoverFor(thread);
        return failover === null ? null : signedOutSearch({ ...failover, thread });
      }),
    ];
    const accountRoomAt = Math.min(
      ...searches.flatMap((search) => {
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
