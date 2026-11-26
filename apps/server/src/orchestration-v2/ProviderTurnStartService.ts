import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { AccountRouting, creditRefusalMessage, runLiftsScope } from "./AccountRouting.ts";
import { autoCoordinatorBriefInput } from "./autoCoordinatorAccount.ts";

import { classifyCodexManagedError } from "../provider/CodexManagedErrors.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  AwakeSinceWake,
  type AwakeWait,
  timeoutAwakeOrElse,
  watchWait,
} from "@t3tools/shared/AwakeTime";
import {
  CommandId,
  isCompactionCommandMessage,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  latestProviderTurnForAttempt,
  withMessageSenderNote,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  isDeliveredProviderTurn,
  isListedThreadLineage,
  parseGoalCommand,
  RunId,
  RunAttemptId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { STALL_LOG_NOTE } from "../observability/EventLoopMonitor.ts";
import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSkills from "../provider/ProviderSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  makeRestoreMissingWorktree,
  ThreadWorktreeRestore,
} from "../workspace/restoreMissingWorktree.ts";
import type * as TaskFolders from "../workspace/TaskFolders.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { canForkBusySourceNatively, isActiveRun } from "./CommandPolicy.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  estimateTextTokens,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import {
  deliverContextHandoffs,
  isSlashCommandMessage,
  withInlineContext,
} from "./ContextHandoffDelivery.ts";
import { isProviderCommand, outputInstructions } from "./runOutput.ts";
import { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "@t3tools/shared/orchestrationV2ManualContinuation";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
  promptNotSentFailure,
  providerErrorClass,
  providerFailureDiagnostic,
  providerFailureExplained,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  conversationProviderThreadIds,
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  promptBackgroundWorkNote,
  RESTART_RESEND_NOTE,
  restartRetryNotices,
  cohortWasStopped,
  pendingStoppedDelegatedTasks,
  stoppedDelegatedTasksNote,
} from "./RestartBackgroundNote.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
    attemptId: Schema.optional(RunAttemptId),
    rootNodeId: Schema.optional(NodeId),
  },
) {}

class WorktreeSetupScriptFailedError extends Schema.TaggedError<WorktreeSetupScriptFailedError>()(
  "WorktreeSetupScriptFailedError",
  { worktreePath: Schema.String, exitCode: Schema.NullOr(Schema.Number) },
) {
  override get message(): string {
    return `Setup script exited with ${this.exitCode ?? "no exit code"} in '${this.worktreePath}'.`;
  }
}

/** Runs that ended without completing: their provider turn may still project as running. */
const NON_COMPLETING_TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

// A provider that never answers would keep its run starting and hold an effect worker forever.
const PROVIDER_START_STEP_TIMEOUT_MINUTES = 5;
// A resume replays the whole transcript, so a large chat on a loaded host needs longer than a
// small one: 5 minutes plus 1 per MB of history, scaled by the host's load per CPU (a starved
// host replays slower) and doubled after each earlier resume timeout.
const RESUME_TIMEOUT_MINUTES_PER_MB = 1;
const RESUME_TIMEOUT_MAX_MINUTES = 60;
const RESUME_STEP = "resume the conversation";
const RESUME_TIMEOUT_MESSAGE_PREFIX = `The provider did not ${RESUME_STEP} within `;

export const resumeTimeoutMinutes = (input: {
  readonly transcriptBytes: number;
  readonly priorTimeouts: number;
  readonly loadPerCpu: number;
}) =>
  Math.min(
    RESUME_TIMEOUT_MAX_MINUTES,
    Math.floor(
      (PROVIDER_START_STEP_TIMEOUT_MINUTES +
        (input.transcriptBytes / 1_000_000) * RESUME_TIMEOUT_MINUTES_PER_MB) *
        Math.max(1, input.loadPerCpu) *
        2 ** input.priorTimeouts,
    ),
  );

/** One-minute load average per CPU. Tests replace it; Windows reports 0. */
export class HostLoadPerCpu extends Context.Reference<Effect.Effect<number>>(
  "t3/orchestration-v2/HostLoadPerCpu",
  { defaultValue: () => Effect.sync(() => NodeOS.loadavg()[0]! / NodeOS.availableParallelism()) },
) {}

class ProviderStartStepTimeoutError extends Schema.TaggedError<ProviderStartStepTimeoutError>()(
  "ProviderStartStepTimeoutError",
  { step: Schema.String, slept: Schema.Boolean, stalled: Schema.Boolean, minutes: Schema.Number },
) {
  override get message(): string {
    const missed = `The provider did not ${this.step} within ${this.minutes} minutes`;
    if (this.stalled) return `${missed} while the server stalled. ${STALL_LOG_NOTE}`;
    return this.slept ? `${missed} after the computer slept.` : `${missed}.`;
  }
}

const withStartStepTimeout =
  (step: string, minutes: number = PROVIDER_START_STEP_TIMEOUT_MINUTES) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      timeoutAwakeOrElse({
        duration: Duration.minutes(minutes),
        orElse: (wait) =>
          Effect.fail(new ProviderStartStepTimeoutError({ step, ...wait, minutes })),
      }),
    );

export function abandonedProviderTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) {
  const attemptsByRun = Map.groupBy(projection.attempts, (attempt) => attempt.runId);
  const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
  for (const previous of projection.runs) {
    if (
      previous.ordinal >= run.ordinal ||
      previous.providerThreadId !== providerThreadId ||
      !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
    ) {
      continue;
    }
    if (previous.activeAttemptId !== null) {
      abandonedRuns.set(previous.activeAttemptId, previous);
    }
    for (const attempt of attemptsByRun.get(previous.id) ?? []) {
      abandonedRuns.set(attempt.id, previous);
    }
  }
  return projection.providerTurns.flatMap((turn) => {
    const previous = abandonedRuns.get(turn.runAttemptId);
    return turn.providerThreadId === providerThreadId &&
      turn.status === "running" &&
      previous !== undefined
      ? [{ turn, run: previous }]
      : [];
  });
}

const CUT_TURN_SETTLED = "cut-turn-settled";

/**
 * The previous run's cancelled or interrupted turn when no adapter said whether it kept the
 * request. A Stop settles a cancelled turn as it ends; a restart cancels the turn with no adapter
 * left to tell, and an interrupted turn the adapter only remembered in memory is lost with its session.
 */
function unsettledStoppedProviderTurn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThread: Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">,
) {
  const previous = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.ordinal < run.ordinal &&
      candidate.providerThreadId === providerThread.id &&
      candidate.startedAt !== null &&
      (latest === undefined || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    undefined,
  );
  if (
    (previous?.status !== "cancelled" && previous?.status !== "interrupted") ||
    previous.activeAttemptId === null
  )
    return undefined;
  const turn = projection.providerTurns.findLast(
    (candidate) =>
      candidate.runAttemptId === previous.activeAttemptId &&
      candidate.providerThreadId === providerThread.id,
  );
  const nativeTurnId = turn?.nativeTurnRef?.nativeId;
  if (
    turn === undefined ||
    nativeTurnId == null ||
    (turn.status !== "cancelled" && turn.status !== "interrupted") ||
    turn.promptDropped === true ||
    (turn.nativeThreadRef !== undefined &&
      turn.nativeThreadRef.nativeId !== providerThread.nativeThreadRef?.nativeId)
  )
    return undefined;
  return { run: previous, turn, nativeTurnId };
}

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderStartStepTimeoutError = Schema.is(ProviderStartStepTimeoutError);
const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);
const isProviderAdapterTurnStartError = Schema.is(ProviderAdapter.ProviderAdapterTurnStartError);

// Claude refuses these before it reads the prompt, and no wait changes them: replacing a process
// running background work, unreadable launch arguments or settings, managed settings that would
// override the chat's Ultracode, or unreviewed Consumer Terms.
const CLAUDE_SETUP_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeUltracodeOverriddenError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeProjectConfigRootError",
  "ClaudeSettingsResolveError",
  "ClaudeTermsReviewRequiredError",
] as const;

/** Claude refuses these before it reads the prompt; MCP registration that never answers is one too. */
const PROMPT_REFUSAL_TAGS = [
  ...CLAUDE_SETUP_REFUSAL_TAGS,
  "ClaudeMcpRegistrationTimeoutError",
] as const;

/** Refusals the user has to act on first: a setup, workspace, model or request a retry gets again. */
const SETUP_REFUSAL_TAGS = [
  ...CLAUDE_SETUP_REFUSAL_TAGS,
  "ProviderSetupError",
  "ProviderWorkspaceMissingError",
  "RuntimePolicyAboveCeilingError",
  "RuntimePolicyReadOnlyUnsupportedError",
  "WorktreeRecreateNoBaseError",
  "AcpModelSelectionError",
  "CursorModelUnavailableError",
  "ContextHandoffBudgetError",
  "ContextHandoffBackgroundWorkError",
] as const;

function causedBy(error: unknown, matches: (cause: object) => boolean): boolean {
  const seen = new Set<unknown>();
  for (let cause = error; Predicate.isObject(cause) && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (matches(cause)) return true;
  }
  return false;
}

/**
 * The provider refused the start before the prompt reached it, by its own report. A Claude query
 * that ends before the turn attaches (such as a rejected resume point) never received it either.
 */
const refusedBeforePrompt = (error: unknown): boolean =>
  causedBy(
    error,
    (cause) =>
      PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(cause, tag)) ||
      (isProviderAdapterTurnStartError(cause) && cause.refusedBeforePrompt === true) ||
      (isProviderAdapterTurnStartError(cause) && cause.beforePrompt === true) ||
      (isProviderAdapterProtocolError(cause) &&
        cause.driver === CLAUDE_PROVIDER &&
        cause.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL),
  );

/** A sign-in, an account the provider turns away (HTTP 401 or 403), or a setup refusal: no retry fixes it. */
const refusedUntilChanged = (error: unknown): boolean =>
  causedBy(
    error,
    (cause) =>
      (isProviderAdapterOpenSessionError(cause) && cause.requiresSignIn === true) ||
      SETUP_REFUSAL_TAGS.some((tag) => Predicate.isTagged(cause, tag)) ||
      (Predicate.hasProperty(cause, "status") && (cause.status === 401 || cause.status === 403)),
  );

// Starts fail for a while after a wake, as the network, DNS and sign-ins come back.
const AFTER_WAKE_START_MS = 2 * 60_000;

interface StartWait extends AwakeWait {
  /** The start began within AFTER_WAKE_START_MS of awake time after the machine woke. */
  readonly afterWake: boolean;
}

// Explained, yet what a wake breaks: MCP servers still reconnecting do not register in time.
const isAfterWakeTimeout = (cause: object) =>
  Predicate.isTagged(cause, "ClaudeMcpRegistrationTimeoutError");

/**
 * The agent never got the message, so a sleep, stall, lost connection or timeout (provider
 * deadlines expire meanwhile) retries it, and so does an unexplained failure right after a wake,
 * unless the provider refused it for a reason only the user can change.
 */
function unstartedTurnFailure(
  error: unknown,
  wait: StartWait | undefined,
  shown?: { readonly message: string; readonly explained: boolean },
): OrchestrationV2ProviderFailure {
  const explained = shown?.explained === true || providerFailureExplained(error);
  const waitingFixes =
    !refusedUntilChanged(error) &&
    (wait?.slept === true ||
      wait?.stalled === true ||
      (wait?.afterWake === true && (!explained || causedBy(error, isAfterWakeTimeout))) ||
      isProviderStartStepTimeoutError(error) ||
      [shown?.message, providerFailureDiagnostic(error)].some(
        (text) => providerErrorClass(text) === "transport_error",
      ));
  return waitingFixes
    ? promptNotSentFailure(shown?.message, error)
    : makeProviderFailure({ cause: error, message: shown?.message, class: "provider_error" });
}

interface UnstartedRunContext {
  readonly projection: Effect.Success<
    ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getTurnStartContext"]>
  >;
  readonly run: OrchestrationV2Run;
  readonly attempt: OrchestrationV2RunAttempt | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
}

// The provider may have acted on a request it never answered, so a retry could duplicate it.
const OUTCOME_UNKNOWN_TAGS = ["CodexAppServerUnresponsiveError"] as const;

const outcomeUnknown = (error: unknown): boolean =>
  OUTCOME_UNKNOWN_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && outcomeUnknown(error.cause));

/**
 * Whether a non-truncating provider's native session lost the conversation kept before `run`.
 * Rollback resets it: the newest accepted turn was rolled back (works without legacy-missing
 * native ids) or ran under another native id (rollback of runs the provider never accepted).
 */
const nativeSessionMissesKeptTurns = (
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs"
  >,
  providerThread: OrchestrationV2ProviderThread,
  run: OrchestrationV2Run,
): boolean => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return false;
  const acceptedAttemptIds = new Set(
    projection.providerTurns.filter(isDeliveredProviderTurn).map((turn) => turn.runAttemptId),
  );
  const accepted = projection.attempts.filter((attempt) => acceptedAttemptIds.has(attempt.id));
  const runsById = new Map(projection.runs.map((source) => [source.id, source]));
  const ordinalOf = (attempt: OrchestrationV2RunAttempt) =>
    runsById.get(attempt.runId)?.ordinal ?? 0;
  const newest = accepted
    .filter((attempt) => attempt.providerThreadId === providerThread.id)
    .toSorted((a, b) => ordinalOf(a) - ordinalOf(b) || a.attemptOrdinal - b.attemptOrdinal)
    .at(-1);
  if (newest === undefined) return false;
  // Inherited fork history is kept even when every local run was rolled back.
  const keepsHistory =
    (projection.thread.forkedFrom?.type === "run" && projection.thread.lineage.sideChat !== true) ||
    accepted.some((attempt) => {
      const source = runsById.get(attempt.runId);
      return (
        source !== undefined && source.ordinal < run.ordinal && source.status !== "rolled_back"
      );
    });
  return (
    keepsHistory &&
    (runsById.get(newest.runId)?.status === "rolled_back" ||
      (newest.nativeThreadId !== undefined && newest.nativeThreadId !== nativeId)) &&
    !projection.contextHandoffs.some(
      (handoff) =>
        handoff.toProviderThreadId === providerThread.id &&
        handoff.delivery?.nativeThreadId === nativeId &&
        handoff.delivery.status !== "pending",
    )
  );
};

/** Missing execution records cannot be repaired by retrying a start. */
export class ProviderTurnStartRunStateMissingError extends Schema.TaggedError<ProviderTurnStartRunStateMissingError>()(
  "ProviderTurnStartRunStateMissingError",
  {
    runId: RunId,
  },
) {}

export const isProviderTurnStartRunStateMissingError = Schema.is(
  ProviderTurnStartRunStateMissingError,
);

const RESUME_PROMPT = "Continue where you left off.";

const START_GAVE_UP_MESSAGE =
  "T3.CodeShip could not start this turn. Send the message again; if it keeps failing, check the server logs.";

const startFailureMessage = (error: Error): string => {
  const nestedCause = "cause" in error ? error.cause : undefined;
  return (
    knownProviderFailureMessage(error) ??
    (nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedCause === "string"
        ? nestedCause
        : error.message)
  );
};

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  readonly failStartingRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
    /** The last start attempt's failure; a provider's error names the reason in the run's error. */
    readonly cause?: unknown;
  }) => Effect.Effect<void, ProviderTurnStartError | ProviderTurnStartRunStateMissingError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

const PREPAID_CREDITS_REFUSED_CODE = "prepaid_credits_not_allowed";

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | ProviderSkills.ProviderSkills
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | TurnItemPositionStore.TurnItemPositionStoreV2
  | TaskFolders.TaskFolders
  | ThreadWorktreeRestore
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const providerSkills = yield* ProviderSkills.ProviderSkills;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const providerAdapters = yield* Effect.serviceOption(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    );
    const accountRouting = yield* Effect.serviceOption(AccountRouting);
    const awakeSinceWake = yield* AwakeSinceWake;

    const settleUnstartedRun = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (
        context: UnstartedRunContext,
        input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2Run["providerThreadId"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        },
      ) {
        const { projection, run, attempt, rootNode } = context;
        const { now, status } = input;
        const nodeId = rootNode?.id ?? run.rootNodeId;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId: run.id, signal: input.signal }),
          threadId: projection.thread.id,
          runId: run.id,
          nodeId,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...projection.turnItems
                .filter((candidate) => candidate.runId === run.id)
                .map((candidate) => candidate.ordinal),
            ) + 1,
          status,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...input.item,
        };
        const eventPayloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
          ...(attempt === undefined
            ? []
            : [
                {
                  type: "run-attempt.updated" as const,
                  payload: { ...attempt, status, ...started, completedAt: now },
                },
              ]),
          ...(rootNode === undefined
            ? []
            : [
                {
                  type: "node.updated" as const,
                  payload: { ...rootNode, status, ...started, completedAt: now },
                },
              ]),
          ...(input.providerThreadUpdate === undefined
            ? []
            : [{ type: "provider-thread.updated" as const, payload: input.providerThreadUpdate }]),
        ] as const;
        const events = yield* Effect.forEach(eventPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event(),
              threadId: projection.thread.id,
              runId: run.id,
              ...(nodeId === null ? {} : { nodeId }),
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: run.activeAttemptId,
          expectedStatus: "starting",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId: run.id,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );
    const settleUnstartedRunFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
      function* (
        context: UnstartedRunContext,
        failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
          readonly wait?: StartWait;
        },
      ) {
        const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
        const providerMessage =
          failed.message ??
          knownProviderFailureMessage(failed.error) ??
          (nestedCause instanceof Error
            ? nestedCause.message
            : typeof nestedCause === "string"
              ? nestedCause
              : failed.error.message);
        // A provider's own deadline that the stall expired names only the timeout.
        const message =
          failed.wait?.stalled === true && !providerMessage.includes(STALL_LOG_NOTE)
            ? `${providerMessage}${/[.!?]$/.test(providerMessage) ? "" : "."} The server stalled while this turn started. ${STALL_LOG_NOTE}`
            : providerMessage;
        const failure = unstartedTurnFailure(failed.error, failed.wait, {
          message,
          explained: failed.message !== undefined,
        });
        yield* Effect.logError("orchestration-v2.provider-turn-start.failed", {
          runId: context.run.id,
          providerInstanceId: context.run.providerInstanceId,
          class: failure.class,
          code: failure.code,
          cause: providerFailureDiagnostic(failed.error),
        });
        yield* settleUnstartedRun(context, {
          signal: failed.signal,
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: context.run.providerInstanceId,
          itemProviderThreadId: context.run.providerThreadId,
          item: { type: "error", title: failed.title, failure },
        });
      },
    );
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    const worktreeRestore = yield* ThreadWorktreeRestore;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly worktreePath: string | null;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        projectionStore
          .getRun(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
            ),
          );
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        isCurrentAttemptIn([expectedStatus]);
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        hasWorkspaceMoved: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => current.thread.worktreePath !== input.worktreePath),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
        loadUnsettledWork: (threadId: ThreadId, nodeIds: ReadonlyArray<NodeId>) =>
          projectionStore
            .getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
              nodeIds,
              subagentIds: nodeIds,
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed({ subagents: [], nodes: [], turnItems: [] }),
              }),
            ),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.undefined),
            ),
      };
    };

    const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly signal: string;
        readonly status: "completed" | "failed";
        readonly now: DateTime.Utc;
        readonly startedAt?: DateTime.Utc;
        readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
        readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
        readonly item:
          | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
          | Pick<
              Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
              "type" | "title" | "input" | "output" | "exitCode"
            >;
        readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
      }) {
        const { run, rootNode, attempt, turnItems, now, status } = input;
        const runId = run.id;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
          threadId: run.threadId,
          runId,
          nodeId: rootNode.id,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...turnItems.filter((item) => item.runId === runId).map((item) => item.ordinal),
            ) + 1,
          status,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          ...input.item,
        };
        const eventPayloads = [
          { type: "turn-item.updated", payload: item },
          { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
          {
            type: "run-attempt.updated",
            payload: { ...attempt, status, ...started, completedAt: now },
          },
          {
            type: "node.updated",
            payload: { ...rootNode, status, ...started, completedAt: now },
          },
          ...(input.providerThreadUpdate === undefined
            ? []
            : [
                {
                  type: "provider-thread.updated" as const,
                  payload: input.providerThreadUpdate,
                },
              ]),
        ] as const;
        const events = yield* Effect.forEach(eventPayloads, (event) =>
          Effect.gen(function* () {
            return {
              ...event,
              id: yield* idAllocator.allocate.event(),
              threadId: run.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (
      input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly willRetry?: boolean;
        readonly waitDuringStart: Effect.Effect<StartWait>;
      },
      captureStartingRun: (run: OrchestrationV2Run) => void,
    ) {
      const { runId } = input;
      // The effect worker retries a failed start; a refusal settles now, since a retry gets it again.
      const retriesLater = (failure: unknown) =>
        input.willRetry === true && !refusedUntilChanged(failure);
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      captureStartingRun(run);
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                // A settled delivery retires history of this thread: the session that took it
                // holds it, and a fresh session starts from a full summary of the thread. That
                // summary lacks another thread's history (a fork source, a merge-back).
                (((source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled") &&
                  !(
                    (handoff.delivery?.status === "injected" ||
                      handoff.delivery?.status === "inline") &&
                    handoff.fromProviderThreadIds.length > 0 &&
                    handoff.fromProviderThreadIds.every((id) =>
                      projection.providerThreads.some((candidate) => candidate.id === id),
                    )
                  )) ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Slash command turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId && isSlashCommandMessage(message),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts them, also after a provider switch. A fresh
      // session starts without them, and an unscheduled fresh run retires them. A schedule's fresh
      // run is a side conversation, so the thread's next turn still gets them.
      const carriedSideChatHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const sideChatHandoff = run.freshContext === true ? undefined : carriedSideChatHandoffs[0];
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      if (
        carriedSideChatHandoffs.length > 0 &&
        run.freshContext === true &&
        !isScheduledFreshRun(run, projection.turnItems)
      ) {
        const updatedAt = yield* DateTime.now;
        const retired = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(carriedSideChatHandoffs, (handoff) =>
            Effect.map(idAllocator.allocate.event({ threadId: projection.thread.id }), (id) => ({
              id,
              type: "context-handoff.updated" as const,
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, status: "superseded" as const, updatedAt },
            })),
          ),
        });
        if (!retired.committed) return;
      }
      const manualResume =
        run.manualContinuationOfRunId !== undefined && attempt.reason !== "steering_restart";
      const resumeSource = manualResume
        ? unsentManualContinuationSource(run, projection)
        : undefined;
      const unsentResumeMessage =
        resumeSource !== undefined
          ? projection.messages.find((source) => source.id === resumeSource.userMessageId)
          : undefined;
      const providerMessage = unsentResumeMessage ?? message;
      const unstarted = { projection, run, attempt, rootNode };
      const providerSessionId = providerThread.providerSessionId;
      const settleRunBeforeStart = (settled: Parameters<typeof settleUnstartedRun>[1]) =>
        settleUnstartedRun(unstarted, settled);
      if (run.modelSelection.quotaAwareAuto === true) {
        return yield* settleRunBeforeStart({
          signal: "auto-route-unresolved",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Auto could not select a provider",
            failure: makeProviderFailure({
              class: "validation_error",
              code: "auto_route_unresolved",
              message:
                "This server could not resolve the Auto selection. Choose a provider or retry on a server that supports quota-aware Auto.",
            }),
          },
        });
      }
      // A process that sent nothing for a whole start step has stopped answering, and the retry
      // would wait on it again. One still sending events for other turns stays.
      const releaseSilentSession = (error: Error) =>
        isProviderStartStepTimeoutError(error)
          ? providerSessions
              .releaseIfSilent({
                providerSessionId,
                silentForMs: Duration.toMillis(Duration.minutes(error.minutes)),
                detail: `The provider sent nothing for ${error.minutes} minutes while a turn waited on it, so it was stopped. The next turn starts a new one.`,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    "orchestration-v2.provider-turn-start.silent-session-release-failed",
                    {
                      providerSessionId,
                      cause,
                    },
                  ),
                ),
              )
          : Effect.void;
      const settleStartFailure = (failed: Parameters<typeof settleUnstartedRunFailure>[1]) =>
        Effect.flatMap(input.waitDuringStart, (wait) =>
          releaseSilentSession(failed.error).pipe(
            Effect.andThen(settleUnstartedRunFailure(unstarted, { ...failed, wait })),
          ),
        );
      if (
        expandAssistantCitationsForProvider(providerMessage.text).length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ) {
        yield* settleRunBeforeStart({
          signal: "expanded-input-too-long",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message is too long",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `Message exceeds ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters after expanding quotes. Shorten it and try again.`,
            }),
          },
        });
        return;
      }
      if (
        providerMessage.attachments.length === 0 &&
        providerMessage.text.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          providerMessage.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Only a person signs a provider out from chat; their RPC checks providers:manage.
        const isUnauthorizedSignOut =
          providerMessage.createdBy !== "user" &&
          providerMessage.text.trim().toLowerCase() === "/logout";
        // Preparation may select a new provider; account commands still target the last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult =
          isEmptyCompaction || isUnauthorizedSignOut
            ? null
            : yield* Effect.result(
                providerAuth.tryHandlePromptCommand({
                  instanceId: authInstanceId,
                  text: projectComposerContextForProvider({
                    text: providerMessage.text,
                    records: providerMessage.context?.records ?? [],
                  }),
                  hasAttachments: false,
                  sentByPerson:
                    providerMessage.createdBy === "user" &&
                    providerMessage.scheduledTaskId === undefined,
                }),
              );
        if (
          isEmptyCompaction ||
          isUnauthorizedSignOut ||
          authResult?._tag === "Failure" ||
          authResult?.success
        ) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : isUnauthorizedSignOut
              ? makeProviderFailure({
                  class: "permission_error",
                  message: "Only you can sign out of a provider. Use Settings to sign out.",
                })
              : authResult?._tag === "Failure"
                ? makeProviderFailure({
                    class: "permission_error",
                    message: authResult.failure.detail,
                  })
                : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: providerMessage.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status:
                providerThread.status === "error"
                  ? "error"
                  : providerThread.nativeThreadRef === null
                    ? "not_loaded"
                    : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      // Codex spends prepaid credits by itself once plan usage is used up, so every path that
      // starts a turn stops here unless the user allowed this thread's work to spend them.
      const creditRefusal = Option.isNone(accountRouting)
        ? null
        : yield* accountRouting.value.creditRefusal({
            threadId: projection.thread.id,
            instanceId: run.providerInstanceId,
            model: run.modelSelection.model,
          });
      if (creditRefusal !== null) {
        const now = yield* DateTime.now;
        yield* settleRunBeforeStart({
          signal: "prepaid-credits-refused",
          status: "failed",
          now,
          startedAt: now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Prepaid credits not allowed",
            // Not a usage limit: that would hold the account for the threads allowed to spend.
            failure: makeProviderFailure({
              class: "permission_error",
              code: PREPAID_CREDITS_REFUSED_CODE,
              message: creditRefusalMessage(creditRefusal),
            }),
          },
          providerThreadUpdate: {
            ...providerThread,
            status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
            updatedAt: now,
          },
        });
        return;
      }
      const recreateResult = yield* Effect.result(restoreMissingWorktree(projection.thread));
      if (recreateResult._tag === "Failure") {
        if (retriesLater(recreateResult.failure)) return yield* recreateResult.failure;
        yield* settleStartFailure({
          signal: "worktree-recreate-failure",
          title: "Couldn't recreate thread workspace",
          error: recreateResult.failure,
          message: recreateResult.failure.message,
        });
        return;
      }
      const recreatedBeforeDispatch = yield* worktreeRestore.takeRecreated(projection.thread.id);
      const recreated =
        recreateResult.success ??
        (recreatedBeforeDispatch?.worktreePath === projection.thread.worktreePath
          ? recreatedBeforeDispatch
          : undefined);
      if (recreated !== undefined) {
        const { project, worktreePath } = recreated;
        // Opening the setup terminal takes its own workspace lease.
        return {
          worktreeSetup: Effect.gen(function* () {
            const setupResult = yield* Effect.result(
              Effect.gen(function* () {
                const setup = yield* setupScripts.runForThread({
                  threadId: projection.thread.id,
                  projectId: project.id,
                  projectCwd: project.workspaceRoot,
                  worktreePath,
                  project,
                  observeCompletion: {},
                });
                if (setup.status !== "started" || !setup.completion) return;
                if (setup.async) {
                  yield* setup.completion.pipe(Effect.forkDetach);
                } else {
                  const { exitCode } = yield* setup.completion;
                  if (exitCode !== 0)
                    return yield* new WorktreeSetupScriptFailedError({ worktreePath, exitCode });
                }
              }),
            );
            if (setupResult._tag === "Failure") {
              yield* settleStartFailure({
                signal: "worktree-setup-failure",
                title: "Couldn't set up restored workspace",
                error: setupResult.failure,
                message: setupResult.failure.message,
              });
              return;
            }
            yield* startWithWorkspaceLease(input);
          }),
        };
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        worktreePath: projection.thread.worktreePath,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread: projection.thread,
          modelSelection: run.modelSelection,
          run,
        })
        .pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag === "RuntimePolicyResolveError") return yield* error;
        yield* settleStartFailure(
          error._tag === "RuntimePolicyAboveCeilingError"
            ? {
                signal: "runtime-mode-above-ceiling",
                title: "Thread mode is above the policy limit",
                error,
                message: error.message,
              }
            : {
                signal: "read-only-guest-link-unsupported",
                title: "Provider cannot run read-only",
                error,
                message: error.message,
              },
        );
        return;
      }
      const resolvedRuntimePolicy = resolvedPolicy.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      // A run that ended without completing can leave its provider turn projected as
      // running when the agent ignored Stop or an interrupt timed out. Every attempt
      // of such a run owns a possible abandoned turn, including attempts a steering
      // restart superseded, and the session cannot be reused until those turns stop.
      const abandonedTurns = abandonedProviderTurns(projection, run, providerThread.id);
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      let providerTurns = projection.providerTurns;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // The run already ended without stopping its provider — a failed start, an
          // ignored Stop, or an interrupt that never confirmed. Recover that exact
          // turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (retriesLater(recovered.failure)) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const abandonedRuns = new Map(
          abandonedTurns.map(({ run: failedRun }) => [failedRun.id, failedRun] as const),
        );
        const { turnItems: openTurnItems } = yield* projectionStore.getThreadRecords(
          projection.thread.id,
          ["turnItems"],
          {
            turnItemRunIds: [...abandonedRuns.keys()],
            turnItemTypes: RunExecutionService.toolTurnItemTypes,
            turnItemStatuses: ["pending", "running", "waiting"],
          },
        );
        const completedAt = yield* DateTime.now;
        const repairEvents = yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
          Effect.gen(function* () {
            return {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "provider-turn.updated" as const,
              threadId: projection.thread.id,
              runId: abandonedRun.id,
              nodeId: turn.nodeId,
              providerInstanceId: abandonedRun.providerInstanceId,
              occurredAt: completedAt,
              payload: { ...turn, status: "interrupted" as const, completedAt },
            };
          }),
        );
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            ...repairEvents,
            // Its runtime is gone, so nothing else would record the end of its open tool calls.
            ...(yield* Effect.forEach(
              openTurnItems.flatMap((item) => {
                const failedRun = item.runId === null ? undefined : abandonedRuns.get(item.runId);
                return failedRun !== undefined && RunExecutionService.isOpenToolTurnItem(item)
                  ? [{ item, failedRun }]
                  : [];
              }),
              ({ item, failedRun }) =>
                Effect.map(idAllocator.allocate.event(), (id) =>
                  RunExecutionService.abandonedTurnItemEvent({
                    id,
                    item,
                    providerInstanceId: failedRun.providerInstanceId,
                    completedAt,
                  }),
                ),
            )),
          ],
        });
        if (!repaired.committed) return;
        const repairedTurns = new Map(
          repairEvents.map((event) => [event.payload.id, event.payload]),
        );
        providerTurns = providerTurns.map((turn) => repairedTurns.get(turn.id) ?? turn);
      }
      // Only a session that was already running can hold output it buffered for a wake.
      const sessionWasLive = yield* providerSessions.isLive(providerSessionId);
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
      const brokenNativeThread = providerThread.status === "error";
      // Opened without the broken native id, a session that was not live starts fresh.
      const opensFreshSession =
        brokenNativeThread &&
        providerThread.nativeThreadRef !== null &&
        !(yield* providerSessions.isLive(providerSessionId));
      const sessionResult = yield* Effect.result(
        providerSessions
          .open({
            threadId: projection.thread.id,
            providerSessionId,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            ...(existingSessionProjection === undefined
              ? {}
              : { resumeFromSession: existingSessionProjection }),
            ...(providerThread.nativeThreadRef?.nativeId == null || brokenNativeThread
              ? {}
              : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
            ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
              ? {}
              : {
                  initialProviderItemIdentityVersion:
                    providerThread.nativeMetadata.itemIdentityVersion,
                }),
          })
          .pipe(withStartStepTimeout("open its session")),
      );
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        if (failure._tag !== "ProviderStartStepTimeoutError" && retriesLater(failure)) {
          return yield* failure;
        }
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const cutTurn = unsettledStoppedProviderTurn(
        { runs: projection.runs, providerTurns },
        run,
        providerThread,
      );
      if (
        cutTurn !== undefined &&
        session.nativeTurnKept !== undefined &&
        !(yield* (
          session
            .nativeTurnKept({ providerThread, nativeTurnId: cutTurn.nativeTurnId })
            // As when the turn ends: an unknown answer resends the request rather than losing it.
            .pipe(Effect.orElseSucceed(() => false))
        ))
      ) {
        // Settle it as a Stop would: mark the request dropped and take back its inline context, so
        // this turn resends both. Starting again reads the settled state.
        const occurredAt = yield* DateTime.now;
        const allocateEventId = () =>
          idAllocator.allocate.event({ threadId: projection.thread.id });
        // Its attempt starts before it delivers anything, so later inline deliveries are its own,
        // including handoffs carried from an earlier run that they still target.
        const cutStartedAt =
          projection.attempts.find((candidate) => candidate.id === cutTurn.run.activeAttemptId)
            ?.startedAt ?? cutTurn.run.startedAt;
        const settled = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* allocateEventId(),
              type: "provider-turn.updated" as const,
              threadId: projection.thread.id,
              runId: cutTurn.run.id,
              nodeId: cutTurn.turn.nodeId,
              providerInstanceId: cutTurn.run.providerInstanceId,
              occurredAt,
              payload: { ...cutTurn.turn, promptDropped: true as const },
            },
            ...(yield* Effect.forEach(
              projection.contextHandoffs.filter(
                (handoff) =>
                  handoff.delivery?.status === "inline" &&
                  handoff.delivery.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
                  (handoff.targetRunId === cutTurn.run.id ||
                    (cutStartedAt !== null &&
                      DateTime.isGreaterThanOrEqualTo(handoff.updatedAt, cutStartedAt))),
              ),
              ({ delivery: _delivery, ...handoff }) =>
                Effect.map(allocateEventId(), (id) => ({
                  id,
                  type: "context-handoff.updated" as const,
                  threadId: projection.thread.id,
                  runId: cutTurn.run.id,
                  providerInstanceId: cutTurn.run.providerInstanceId,
                  occurredAt,
                  payload: { ...handoff, updatedAt: occurredAt },
                })),
            )),
          ],
        });
        if (!settled.committed) return;
        // The restarted start captures the same baseline; never let the two write at once.
        yield* baseline;
        return CUT_TURN_SETTLED;
      }
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<
          OrchestrationV2ProviderThread,
          ProviderAdapter.ProviderAdapterV2Error | ProviderStartStepTimeoutError
        >,
      ) {
        const loaded = yield* Effect.result(
          load.pipe(withStartStepTimeout("load the conversation")),
        );
        if (loaded._tag === "Success") return loaded.success;
        if (
          loaded.failure._tag !== "ProviderStartStepTimeoutError" &&
          retriesLater(loaded.failure) &&
          !outcomeUnknown(loaded.failure)
        ) {
          return yield* loaded.failure;
        }
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = handoffs;
      let resumeFellBack = false;
      const expandedText = yield* Effect.result(
        providerMessage.createdBy === "user"
          ? providerSkills.expandSkillMentions({
              text: providerMessage.text,
              instanceId: run.providerInstanceId,
              cwd: resolvedRuntimePolicy.cwd,
              settings: resolveProjectSettings(
                yield* serverSettings.getSettings,
                projection.thread.projectId,
              ).settings,
            })
          : Effect.succeed(providerMessage.text),
      );
      if (expandedText._tag === "Failure") {
        if (retriesLater(expandedText.failure)) return yield* expandedText.failure;
        yield* settleStartFailure({
          signal: "shared-skill-load-failure",
          title: "Shared skill could not be loaded",
          error: expandedText.failure,
          message: expandedText.failure.message,
        });
        return;
      }
      const messageText = withMessageSenderNote(
        providerMessage,
        projectComposerContextForProvider({
          text: expandedText.success,
          records: providerMessage.context?.records ?? [],
        }),
      );
      const slashCommand = isSlashCommandMessage(providerMessage);
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
      // Part of the user text, so every way a turn starts carries it, after the user's own words.
      const userText =
        run.outputSchema === undefined || goalCommand || isProviderCommand(providerMessage)
          ? messageText
          : `${messageText}\n\n${outputInstructions(run.outputSchema)}`;
      // A session that was closing while this one opened may have recorded what it stopped since
      // this turn's first read.
      const { runs: currentRuns } = yield* projectionStore.getThreadRecords(input.threadId, [
        "runs",
      ]);
      // Text a continuation carries beyond the bare resume prompt, such as the ids of delegated
      // tasks its cut turn started, reaches the agent only when the turn is sent as a prompt.
      const noteContinuation =
        (run.restartContinuationOfRunId !== undefined &&
          message.text !== CONTINUE_PROMPT &&
          !isCompactionCommandMessage(message)) ||
        isRestartNoteContinuation(run, currentRuns, projection.providerTurns, projection.attempts);
      // A wake may drain output its session buffered instead of sending this text, and a
      // continuation without a note may resume natively: neither is sure to tell the agent.
      const sendsNoPrompt =
        (sessionWasLive &&
          message.createdBy === "agent" &&
          message.creationSource === "provider") ||
        (run.restartContinuationOfRunId !== undefined && !noteContinuation);
      const owedBackgroundWork = sendsNoPrompt
        ? []
        : pendingRestartCancelledBackgroundWork({
            runs: currentRuns,
            providerTurns: projection.providerTurns,
            compactionMessageIds: () =>
              new Set(
                projection.messages
                  .filter(
                    (candidate) =>
                      isSlashCommandMessage(candidate) ||
                      isCompactionCommandMessage(candidate) ||
                      (goalDriver && parseGoalCommand(candidate) !== null),
                  )
                  .map((candidate) => candidate.id),
              ),
            run,
            attempts: projection.attempts,
            conversation: conversationProviderThreadIds(providerThread, projection.providerThreads),
          });
      const backgroundWorkNote = promptBackgroundWorkNote(
        owedBackgroundWork,
        noteContinuation ? message.text : "",
      );
      let compactionMessageIdSet: ReadonlySet<string> | undefined;
      const compactionMessageIds = () =>
        (compactionMessageIdSet ??= new Set(
          projection.messages.filter(isSlashCommandMessage).map((candidate) => candidate.id),
        ));
      // The turn start context omits settled tasks, so read them only after a Stop disposed some.
      // A failed read fails the start: a turn that ran without the note would count as telling it.
      const stoppedRunIds = projection.runs
        .filter(
          (source) => source.providerThreadId === run.providerThreadId && cohortWasStopped(source),
        )
        .map((source) => source.id);
      const stoppedTasks =
        stoppedRunIds.length === 0 || compactionMessageIds().has(run.userMessageId)
          ? []
          : pendingStoppedDelegatedTasks({
              providerThreadId: run.providerThreadId,
              runs: projection.runs,
              providerTurns: projection.providerTurns,
              attempts: projection.attempts,
              compactionMessageIds: compactionMessageIds(),
              subagents: (yield* projectionStore.getThreadRecords(
                projection.thread.id,
                ["subagents"],
                { subagentRunIds: stoppedRunIds },
              )).subagents,
            });
      const restartNote = [
        backgroundWorkNote.text,
        stoppedTasks.length === 0 ? "" : stoppedDelegatedTasksNote(stoppedTasks),
        restartRetryNotices(run.id, projection.turnItems).at(-1)?.delivery === "unconfirmed"
          ? RESTART_RESEND_NOTE
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      // Every top-level Auto turn carries the brief; adapters also restore it after native compaction.
      const autoBriefed =
        run.modelSelection.autoAccount === true &&
        !goalCommand &&
        !userText.trimStart().startsWith("/") &&
        isListedThreadLineage(projection.thread.lineage) &&
        projection.thread.delegatedFrom === undefined;
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending",
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        const deliveredAttemptIds = new Set(
          projection.providerTurns.filter(isDeliveredProviderTurn).map((turn) => turn.runAttemptId),
        );
        const droppedAttemptIds = new Set(
          projection.providerTurns
            .filter((turn) => !isDeliveredProviderTurn(turn))
            .map((turn) => turn.runAttemptId),
        );
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null ? 0 : estimateTextTokens(historical.text)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        const missedRuns = projection.runs.filter(
          (source) =>
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" ||
              source.status === "interrupted" ||
              (source.status === "cancelled" && droppedAttemptIds.has(source.activeAttemptId))) &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: providerMessage.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns, acceptedAttempts } = context;
          const missedHistory =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter((item) => item.runId !== null && missedRunIds.has(item.runId));
          const missedItems = missedHistory.filter(
            (item) => !coveredItemIds.has(item.id) && historicalMessage(item) !== null,
          );
          // The resume fallback summary already covers every earlier run in order. A
          // retry copy after it would rank older missed requests as the newest history.
          const handoffs =
            missedItems.length === 0 || resumeFellBack
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          // History delivery (inline or injected) is text only, so missed images ride on prompts
          // until a later run's is accepted. Slash command starts carry none. A missed run's
          // own accepted attempt predates its unsent steering input, so it does not count.
          const runsById = new Map(projection.runs.map((source) => [source.id, source]));
          const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
          let lastPromptOrdinal = 0;
          for (const attempt of acceptedAttempts) {
            if (missedRunIds.has(attempt.runId)) continue;
            const source = runsById.get(attempt.runId);
            if (source === undefined) continue;
            const message = messagesById.get(source.userMessageId);
            if (message !== undefined && isSlashCommandMessage(message)) continue;
            lastPromptOrdinal = Math.max(lastPromptOrdinal, source.ordinal);
          }
          const attachments = missedHistory.flatMap((item) =>
            item.type === "user_message" &&
            item.runId !== null &&
            (runsById.get(item.runId)?.ordinal ?? 0) > lastPromptOrdinal
              ? item.attachments
              : [],
          );
          return { handoffs, attachments };
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const history = yield* projectionStore.getTurnStartHistory(input.threadId);
          const boundary = contextBoundaryOrdinal({ runs: projection.runs, turnItems: history });
          const from = Math.max(1, boundary);
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from, to: Math.max(from, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: [
              ...(boundary === 0
                ? yield* ContextHandoffService.readInheritedHandoffItems(
                    projectionStore,
                    projection.thread,
                  )
                : []),
              ...history.filter((item) =>
                item.runId === null
                  ? boundary === 0
                  : projection.runs.some(
                      (source) =>
                        source.id === item.runId &&
                        source.ordinal >= boundary &&
                        source.ordinal < run.ordinal &&
                        source.status !== "rolled_back",
                    ),
              ),
            ],
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: Effect.Success<ReturnType<typeof prepareRetryHandoff>> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          let sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          // The source may have started a turn after dispatch planned this fork.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (
            (sourceRun.status === "completed" || sourceRun.status === "waiting") &&
            (!sourceBusy ||
              canForkBusySourceNatively(
                session.providerSession.capabilities,
                sourceProviderTurn?.nativeTurnRef != null,
              ))
          ) {
            // Rolled-back turns are no longer in the source conversation, so they cannot bound a fork.
            const rolledBackAttemptIds = new Set(
              sourceProjection.attempts
                .filter((attempt) =>
                  sourceProjection.runs.some(
                    (candidate) =>
                      candidate.id === attempt.runId && candidate.status === "rolled_back",
                  ),
                )
                .map((attempt) => attempt.id),
            );
            const forked = yield* Effect.result(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns.filter(
                  (turn) =>
                    turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId),
                ),
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
            if (forked._tag === "Success") return forked.success;
            if (input.willRetry === true) return yield* forked.failure;
            if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
            // Retries are spent (e.g. the source's native session is gone): start fresh with portable history.
            yield* Effect.logWarning("Starting a native fork in a fresh native session", {
              driver: session.driver,
              providerThreadId: providerThread.id,
              sourceProviderThreadId: sourceProviderThread.id,
              runId,
              errorTag: forked.failure._tag,
            });
            nativeForkFailure = makeProviderFailure({
              cause: forked.failure,
              message: startFailureMessage(forked.failure),
              class: "provider_error",
            }).message;
            sourceProjection = {
              ...sourceProjection,
              ...(yield* projectionStore.getThreadRecords(nativeForkTransfer.sourceThreadId, [
                "runs",
                "attempts",
              ])),
            };
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
            projection.thread,
          );
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: nativeForkFailed
                ? { ...providerThread, nativeThreadRef: null, forkedFrom: null }
                : { ...providerThread, forkedFrom: null },
              // The failed fork may have left the adapter's session half-switched.
              ...(nativeForkFailed ? { forceNewNativeThread: true } : {}),
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event(),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event(),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
              ...(nativeForkFailure === undefined
                ? []
                : [
                    {
                      id: yield* idAllocator.allocate.event(),
                      type: "turn-item.updated" as const,
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: createdAt,
                      payload: {
                        id: idAllocator.derive.runSignalTurnItem({
                          runId,
                          signal: "native-fork-fallback",
                        }),
                        threadId: projection.thread.id,
                        runId,
                        nodeId: rootNode.id,
                        providerThreadId: providerThread.id,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal:
                          Math.max(
                            0,
                            ...projection.turnItems
                              .filter((item) => item.runId === runId)
                              .map((item) => item.ordinal),
                          ) + 1,
                        status: "completed" as const,
                        title: "Native fork failed",
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `Could not fork the source conversation natively (${nativeForkFailure}). Started a fresh session with its history.`,
                      },
                    },
                  ]),
            ],
          });
          return loaded;
        }
        if (providerThread.nativeThreadRef === null) {
          // Pass the stored provider row for adoption; adapter-minted duplicates make activeProviderThreadId flap.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const rejectedHistory = yield* Effect.gen(function* () {
          if (session.driver !== "codex") return false;
          const acceptedAttemptIds = new Set(
            projection.providerTurns
              .filter(isDeliveredProviderTurn)
              .map((turn) => turn.runAttemptId),
          );
          const previous = projection.runs.findLast(
            (source) =>
              source.providerThreadId === providerThread.id &&
              source.ordinal < run.ordinal &&
              source.activeAttemptId !== null &&
              acceptedAttemptIds.has(source.activeAttemptId),
          );
          if (
            previous === undefined ||
            (previous.status !== "failed" &&
              previous.status !== "interrupted" &&
              previous.status !== "cancelled")
          )
            return false;
          const previousAttempt = projection.attempts.find(
            (source) => source.id === previous.activeAttemptId,
          );
          if (previousAttempt === undefined) return false;
          if (previousAttempt.nativeThreadId !== undefined) {
            if (previousAttempt.nativeThreadId !== providerThread.nativeThreadRef?.nativeId)
              return false;
          } else if (
            projection.contextHandoffs.some(
              (handoff) =>
                handoff.toProviderThreadId === providerThread.id &&
                handoff.strategy === "full_thread_summary" &&
                handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
                handoff.coveredRunOrdinals.to >= previous.ordinal,
            )
          )
            return false;
          // The native resume RPC can succeed while persisted input still rejects every turn.
          return (yield* projectionStore.getTurnStartHistory(input.threadId, [previous.id])).some(
            (item) =>
              item.type === "error" &&
              item.nodeId === previous.rootNodeId &&
              (item.failure.code === "invalid_encrypted_content" ||
                classifyCodexManagedError(item.failure.message)?.code ===
                  "invalid_encrypted_content"),
          );
        });
        // A fresh session would orphan background work still running on the native thread.
        const hasPendingWork = (thread: OrchestrationV2ProviderThread) =>
          session.hasPendingBackgroundWorkForThread?.(thread, { includeSubagents: true }) ??
          session.hasPendingBackgroundWork ??
          Effect.succeed(false);
        const failForPendingWork = loadFromProvider(
          Effect.fail(
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: projection.thread.id,
              providerThreadId: providerThread.id,
              runId,
              cause: new ContextHandoffBackgroundWorkError(),
            }),
          ),
        );
        if (rejectedHistory && (yield* hasPendingWork(providerThread))) {
          return yield* failForPendingWork;
        }
        // A provider that cannot truncate rolls back into a fresh native session holding none of the kept turns.
        const nativeSessionLacksKeptTurns =
          !session.providerSession.capabilities.checkpointing.providerCanRollbackConversation &&
          nativeSessionMissesKeptTurns(projection, providerThread, run);
        // Dispatch prepares no import handoff for a session import: its history is in the native session.
        const importedNativeSession =
          projection.thread.historyOrigin === "v1_import" &&
          !projection.providerTurns.some(
            (turn) => turn.providerThreadId === providerThread.id && isDeliveredProviderTurn(turn),
          ) &&
          !projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === providerThread.id &&
              handoff.strategy === "manual_context",
          );
        const resumed = yield* Effect.result(
          uncertainDelivery || nativeSessionLacksKeptTurns || rejectedHistory
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: uncertainDelivery
                    ? "Uncertain native history injection"
                    : nativeSessionLacksKeptTurns
                      ? "Native session holds none of the kept conversation"
                      : "Rejected native history",
                }),
              )
            : Effect.gen(function* () {
                const transcriptBytes = projection.messages.reduce(
                  (sum, candidate) => sum + Buffer.byteLength(candidate.text),
                  0,
                );
                const priorTimeouts = projection.turnItems.filter(
                  (item) =>
                    item.type === "error" &&
                    item.failure.message.startsWith(RESUME_TIMEOUT_MESSAGE_PREFIX),
                ).length;
                const loadPerCpu = yield* yield* HostLoadPerCpu;
                return yield* session
                  .resumeThread({
                    providerThread,
                    threadId: projection.thread.id,
                    modelSelection: run.modelSelection,
                    runtimePolicy: resolvedRuntimePolicy,
                    importedNativeSession,
                  })
                  .pipe(
                    withStartStepTimeout(
                      RESUME_STEP,
                      resumeTimeoutMinutes({
                        transcriptBytes,
                        priorTimeouts,
                        loadPerCpu,
                      }),
                    ),
                  );
              }),
        );
        if (resumed._tag === "Success") {
          const context = handoffContextForThread(resumed.success);
          context.budget = yield* Effect.cached(context.budget);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          const fits = yield* deliverContextHandoffs({
            handoffs: [...handoffs, ...resumedRetryHandoff.handoffs],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline: slashCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            budget: freshContext.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          if (yield* hasPendingWork(resumed.success)) return yield* failForPendingWork;
        }
        // A provider that stalls on a resume would stall a fresh thread too.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderStartStepTimeoutError"
        ) {
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: resumed.failure,
          });
          return undefined;
        }
        resumedHandoffContext = undefined;
        resumedRetryHandoff = undefined;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
        // Another client is still writing to the native thread, or the provider may have
        // resumed it without answering. A fresh session would split the conversation.
        if (
          resumed._tag === "Failure" &&
          (resumed.failure._tag === "ProviderAdapterThreadInUseError" ||
            outcomeUnknown(resumed.failure))
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : nativeSessionLacksKeptTurns
              ? "native_session_lacks_kept_turns"
              : rejectedHistory
                ? "rejected_native_history"
                : resumed._tag === "Success"
                  ? "handoff_budget_exhausted"
                  : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            // A fresh session that never loaded the broken history needs no replacement.
            ...(opensFreshSession && resumed._tag === "Failure"
              ? {}
              : { forceNewNativeThread: true }),
          }),
        );
        if (replacement === undefined) return undefined;
        if (
          replacement.nativeThreadRef?.nativeId != null &&
          replacement.nativeThreadRef.driver === providerThread.nativeThreadRef?.driver &&
          replacement.nativeThreadRef.nativeId === providerThread.nativeThreadRef.nativeId
        ) {
          // Never retried. Forget the load first, or the next turn would skip resume and start on
          // the reused session without this error or the recovery handoff.
          yield* providerSessions.forgetLoadedProviderThread({
            providerSessionId: session.providerSessionId,
            threadId: projection.thread.id,
            providerThread: replacement,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          });
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: session.driver,
              detail:
                "the provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session",
            }),
          });
          return undefined;
        }
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        // Stable per run so a retried start reuses the reserved run-start position.
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        const handoffTurnItem: OrchestrationV2TurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          // The summary is delivered ahead of this run's own handoffs and message.
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
        const replacementWrite = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* idAllocator.allocate.event(),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event(),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        if (!replacementWrite.committed) return undefined;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        recoveryTurnItem = handoffTurnItem;
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        budget,
      } = handoffContext;
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      const carriesPendingContext =
        effectiveHandoffs.length > 0 ||
        retryHandoff.handoffs.length > 0 ||
        retryHandoff.attachments.length > 0 ||
        sideChatHandoff !== undefined ||
        restartNote !== "" ||
        noteContinuation;
      // Pending context turns the resume into a prompted turn, which needs no native resume.
      if (
        manualResume &&
        unsentResumeMessage === undefined &&
        session.resumeTurn === undefined &&
        !carriesPendingContext
      ) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom: portableForkFallback === undefined ? providerThread.forkedFrom : null,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        // Recorded with the start: only a completed turn of this attempt proves the agent read it.
        backgroundWorkNote: backgroundWorkNote.told,
        status: "running",
        startedAt: now,
        startedModes: {
          runtimeMode: projection.thread.runtimeMode,
          interactionMode: projection.thread.interactionMode,
        },
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event(),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event(),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined ||
        portableForkFallback !== undefined ||
        runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event(),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        // Shown only once the replacement session commits with the running transition.
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event(),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
              },
            ]),
        {
          id: yield* idAllocator.allocate.event(),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event(),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event(),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      // Delegated (app_owned) children run their own runs; routing them here ingests their items twice.
      const routableSubagents = projection.subagents.filter(
        (subagent) =>
          subagent.origin === "provider_native" &&
          RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event(),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      let inlineDeliveredHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff> = [];
      let promptDroppedOnTerminal = false;
      const inlineDeliveryLock = yield* Semaphore.make(1);
      const retryHandoffIds = new Set(retryHandoff.handoffs.map((handoff) => handoff.id));
      const prepareTurn = Effect.fn("ProviderTurnStartService.prepareTurn")(
        function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput, compact: boolean) {
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff.handoffs],
            deferInline: compact || slashCommand,
            providerThread: runningProviderThread,
            budget,
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: persistHandoff,
          });
          // Like history, the side chat context waits for a turn that sends a prompt.
          const sideChatContext =
            sideChatHandoff === undefined || compact || slashCommand
              ? ""
              : sideChatHandoff.summaryText;
          const selection = turnInput.modelSelection;
          let autoBrief: string | null = null;
          if (autoBriefed && !compact) {
            const now = yield* DateTime.now;
            const providers = Option.isNone(providerRegistry)
              ? []
              : yield* providerRegistry.value.getProviders;
            autoBrief = autoCoordinatorInstructions(
              autoCoordinatorBriefInput({
                providers,
                settings: yield* serverSettings.getSettings,
                recordedLimits: yield* projectionStore
                  .getUsageLimitedProviderInstances(now, runLiftsScope(providers))
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("orchestration-v2.auto-brief.limits-unavailable", {
                        cause,
                      }).pipe(Effect.as(new Map())),
                    ),
                  ),
                projectId: projection.thread.projectId,
                orchestrationCapableInstanceIds: new Set(
                  Option.isNone(providerAdapters) ? [] : yield* providerAdapters.value.list(),
                ),
                nowMs: DateTime.toEpochMillis(now),
                driver: session.driver,
                selection,
              }),
            );
          }
          // Record inline handoffs before startTurn so an immediate dropped terminal can restore them.
          inlineDeliveredHandoffs = [
            ...delivery.inlineHandoffs.map((handoff) =>
              retryHandoffIds.has(handoff.id)
                ? { ...handoff, status: "superseded" as const }
                : handoff,
            ),
            ...(sideChatContext === "" || sideChatHandoff === undefined ? [] : [sideChatHandoff]),
          ];
          const context = [delivery.context, sideChatContext, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          const startInput = {
            ...(noteContinuation ? promptedInput : turnInput),
            ...(autoBrief === null ? {} : { autoModeInstructions: autoBrief }),
          };
          // Inline context needs a prompt to carry it, so a resume with context sends one instead.
          const { resume: _resume, ...contextInput } = startInput;
          const missedAttachments =
            compact || slashCommand
              ? []
              : retryHandoff.attachments.filter(
                  (missed) =>
                    !turnInput.message.attachments.some((current) => current.id === missed.id),
                );
          // Like pending history, pending images need a prompt; native resume carries none.
          const prompted = context !== "" || missedAttachments.length > 0;
          // A resume that must be prompted still needs a request, or the agent has nothing to do.
          const requestText =
            turnInput.resume && prompted && userText === "" ? RESUME_PROMPT : userText;
          const text = slashCommand ? userText : withInlineContext(context, requestText);
          const unsent = delivery.unsent.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to restore unsent context handoffs", { runId: run.id }),
            ),
          );
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          return {
            turnInput: {
              ...(prompted ? contextInput : startInput),
              message: {
                ...turnInput.message,
                text,
                ...(missedAttachments.length === 0
                  ? {}
                  : { attachments: [...missedAttachments, ...turnInput.message.attachments] }),
              },
              ...(text === userText ? {} : { inlineContextLength: text.length - userText.length }),
            },
            // Failed delivery bookkeeping must not stop live ingestion.
            accepted: inlineDeliveryLock.withPermits(1)(
              Effect.suspend(() =>
                promptDroppedOnTerminal
                  ? Effect.void
                  : Effect.forEach(
                      [
                        delivery.delivered,
                        ...(sideChatContext === "" ||
                        sideChatHandoff === undefined ||
                        nativeThreadId == null
                          ? []
                          : [
                              persistHandoff({
                                ...sideChatHandoff,
                                toProviderThreadId: runningProviderThread.id,
                                delivery: {
                                  nativeThreadId,
                                  status: "inline" as const,
                                  itemIds: [],
                                },
                              }),
                            ]),
                      ],
                      (record) =>
                        record.pipe(
                          Effect.catchCause(() =>
                            Effect.logWarning(
                              "Failed to record accepted context handoff delivery",
                              {
                                runId: run.id,
                                deliveryStatus: "pending",
                              },
                            ),
                          ),
                        ),
                      { discard: true },
                    ),
              ),
            ),
            // Clear pending handoff markers for a prompt never sent so the next turn retains the native session.
            notAccepted: (error) =>
              error === undefined || refusedBeforePrompt(error) ? unsent : Effect.void,
          } satisfies RunExecutionService.RunExecutionServiceV2PreparedTurn;
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session,
        prepareTurn,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        baseline,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        resume: manualResume && unsentResumeMessage === undefined,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        hasWorkspaceMoved: runControls.hasWorkspaceMoved,
        loadDroppedInlineHandoffs: () =>
          inlineDeliveryLock.withPermits(1)(
            Effect.sync(() => {
              promptDroppedOnTerminal = true;
              return inlineDeliveredHandoffs;
            }),
          ),
        loadUnsettledWork: runControls.loadUnsettledWork,
        message: {
          messageId: message.id,
          text: userText,
          attachments: providerMessage.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        // Only a start the adapter knows stopped before the prompt can be resent without running it twice.
        startFailure: (error) =>
          refusedBeforePrompt(error)
            ? Effect.map(input.waitDuringStart, (wait) => unstartedTurnFailure(error, wait))
            : Effect.succeed(makeProviderFailure({ cause: error, class: "provider_error" })),
      });
    });

    const startWithWorkspaceLease: ProviderTurnStartServiceV2Shape["start"] = Effect.fn(
      "ProviderTurnStartService.start",
    )(
      function* (input) {
        let startingRun: OrchestrationV2Run | undefined;
        const captureStartingRun = (run: OrchestrationV2Run) => {
          startingRun = run;
        };
        return yield* Effect.gen(function* () {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          const cwd =
            thread.worktreePath ??
            (yield* projects
              .getById(thread.projectId, { includeDeleted: true })
              .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
          // Settling a turn a restart cut off changes what a start reads, so it starts once more.
          const sinceWake = yield* awakeSinceWake;
          const afterWake = sinceWake !== undefined && sinceWake < AFTER_WAKE_START_MS;
          const waitDuringStart = Effect.map(yield* watchWait, (wait): StartWait => ({
            ...wait,
            afterWake,
          }));
          const startOnce = start({ ...input, waitDuringStart }, captureStartingRun);
          const startSettled = startOnce.pipe(
            Effect.filterOrElse(
              (started) => started !== CUT_TURN_SETTLED,
              () => startOnce,
            ),
            Effect.map((started) => (started === CUT_TURN_SETTLED ? undefined : started)),
          );
          const providerTurn = yield* cwd === undefined
            ? startSettled
            : withTurnStartReservation(
                fileSystem,
                path,
                path.resolve(cwd),
                thread.worktreePath === null
                  ? startSettled
                  : withWorkspaceLease(path.resolve(thread.worktreePath), startSettled),
              );
          if (providerTurn !== undefined && "worktreeSetup" in providerTurn) {
            yield* providerTurn.worktreeSetup;
          } else if (providerTurn !== undefined) {
            // Run execution owns finalization after the running write. A later
            // failure must not settle a replacement attempt committed by steering.
            yield* providerTurn.pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning(
                    "Run execution failed after starting",
                    { runId: input.runId },
                    cause,
                  ),
              ),
            );
          }
        }).pipe(
          Effect.scoped,
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.fail(
                new ProviderTurnStartError({
                  runId: input.runId,
                  cause: Cause.squash(cause),
                  ...(startingRun?.activeAttemptId == null || startingRun.rootNodeId == null
                    ? {}
                    : {
                        attemptId: startingRun.activeAttemptId,
                        rootNodeId: startingRun.rootNodeId,
                      }),
                }),
              ),
          ),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    );
    return ProviderTurnStartServiceV2.of({
      start: startWithWorkspaceLease,
      failStartingRun: Effect.fn("ProviderTurnStartService.failStartingRun")(
        function* ({ threadId, runId, attemptId, rootNodeId, cause }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            run.status !== "starting" ||
            run.activeAttemptId !== attemptId ||
            run.rootNodeId !== rootNodeId
          )
            return;
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (rootNode === undefined || attempt === undefined) {
            return yield* new ProviderTurnStartRunStateMissingError({ runId });
          }
          // A provider's error names the reason; our own start bookkeeping errors mean nothing to
          // a user, so they get the generic message below and stay in the server logs.
          if (cause instanceof Error && !isProviderTurnStartError(cause)) {
            return yield* settleUnstartedRunFailure(
              { projection, run, attempt, rootNode },
              {
                signal: "provider-turn-start-failure",
                title: "Provider turn failed to start",
                error: cause,
              },
            );
          }
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: "provider-turn-start-failure",
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: run.providerThreadId,
            item: {
              type: "error",
              title: "Turn failed to start",
              failure: makeProviderFailure({ message: START_GAVE_UP_MESSAGE }),
            },
          });
        },
        (effect, { runId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartRunStateMissingError(cause)
                ? cause
                : new ProviderTurnStartError({ runId, cause }),
            ),
          ),
      ),
    });
  }),
);
