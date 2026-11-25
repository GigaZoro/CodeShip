import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { runLiftsScope } from "./AccountRouting.ts";
import { autoCoordinatorBriefInput } from "./autoCoordinatorAccount.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  AwakeSinceWake,
  type AwakeWait,
  timeoutAwakeOrElse,
  watchWait,
} from "@t3tools/shared/AwakeTime";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  isCompactionCommandMessage,
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

import * as ServerConfig from "../config.ts";
import { STALL_LOG_NOTE } from "../observability/EventLoopMonitor.ts";
import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSkills from "../provider/ProviderSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRestoreMissingWorktree } from "../workspace/restoreMissingWorktree.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
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
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "./manualContinuation.ts";
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
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | TurnItemPositionStore.TurnItemPositionStoreV2
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
                (source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled" ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
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
      // Carried forward until a provider turn accepts it, also after a provider switch.
      const sideChatHandoff = projection.contextHandoffs.find(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
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
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
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
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
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
        })
        .pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") return yield* error;
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
          message: error.message,
        });
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
      const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
      for (const previous of projection.runs) {
        if (
          previous.ordinal >= run.ordinal ||
          previous.providerThreadId !== providerThread.id ||
          !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
        ) {
          continue;
        }
        if (previous.activeAttemptId !== null) {
          abandonedRuns.set(previous.activeAttemptId, previous);
        }
        for (const attempt of projection.attempts) {
          if (attempt.runId === previous.id) abandonedRuns.set(attempt.id, previous);
        }
      }
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = abandonedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
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
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event(),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: abandonedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: abandonedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      // Only a session that was already running can hold output it buffered for a wake.
      const sessionWasLive = yield* providerSessions.isLive(providerSessionId);
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
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
            ...(providerThread.nativeThreadRef?.nativeId == null
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
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(
          load.pipe(withStartStepTimeout("load the conversation")),
        );
        if (loaded._tag === "Success") return loaded.success;
        if (
          loaded.failure._tag !== "ProviderStartStepTimeoutError" &&
          retriesLater(loaded.failure)
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
      const userText = projectComposerContextForProvider({
        text: expandedText.success,
        records: providerMessage.context?.records ?? [],
      });
      // Codex and Claude parse /goal from the prompt, so it goes verbatim and history waits a turn.
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
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
            compactionMessageIds: new Set(
              projection.messages
                .filter(
                  (candidate) =>
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
      const restartNote = [
        backgroundWorkNote.text,
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
          projection.providerTurns.map((turn) => turn.runAttemptId),
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
        // The resume fallback summary already covers every earlier run in order. A
        // retry copy after it would rank older missed requests as the newest history.
        const missedRuns = projection.runs.filter(
          (source) =>
            !resumeFellBack &&
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
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
          const { missedRunIds, coveredItemIds, missedRuns } = context;
          const missedItems =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter(
                  (item) =>
                    item.runId !== null &&
                    missedRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    historicalMessage(item) !== null,
                );
          const retryHandoff =
            missedItems.length === 0
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
          return retryHandoff;
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
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
              (item) =>
                item.runId === null ||
                projection.runs.some(
                  (source) => source.id === item.runId && source.ordinal < run.ordinal,
                ),
            ),
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
      let resumedRetryHandoff: ReadonlyArray<OrchestrationV2ContextHandoff> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
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
          // Providers refuse to fork a busy thread, so a source that started a turn after
          // dispatch planned this fork gets the portable context dispatch gives a busy source.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (!sourceBusy) {
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
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
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
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
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
            handoffs: [...handoffs, ...resumedRetryHandoff],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline: isCompactionCommandMessage(providerMessage) || goalCommand,
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
          const hasPendingWork = yield* (
            session.hasPendingBackgroundWorkForThread?.(resumed.success, {
              includeSubagents: true,
            }) ??
              session.hasPendingBackgroundWork ??
              Effect.succeed(false)
          );
          if (hasPendingWork) {
            return yield* loadFromProvider(
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
          }
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
        resumedRetryHandoff = [];
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
        // Another client is still writing to the native thread. A fresh
        // session here would silently split the conversation from it.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderAdapterThreadInUseError"
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
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
            forceNewNativeThread: true,
          }),
        );
        if (replacement === undefined) return undefined;
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
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
      if (manualResume && unsentResumeMessage === undefined && session.resumeTurn === undefined) {
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
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
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
      const prepareTurn = Effect.fn("ProviderTurnStartService.prepareTurn")(
        function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput, compact: boolean) {
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact || goalCommand,
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
            sideChatHandoff === undefined || compact || goalCommand
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
          const context = [delivery.context, sideChatContext, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          const text = goalCommand ? userText : withInlineContext(context, userText);
          const startInput = {
            ...(noteContinuation ? promptedInput : turnInput),
            ...(autoBrief === null ? {} : { autoModeInstructions: autoBrief }),
          };
          // Inline context needs a prompt to carry it, so a resume with context sends one instead.
          const { resume: _resume, ...contextInput } = startInput;
          const unsent = delivery.unsent.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to restore unsent context handoffs", { runId: run.id }),
            ),
          );
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          return {
            turnInput: {
              ...(context === "" ? startInput : contextInput),
              message: { ...turnInput.message, text },
              ...(text === userText ? {} : { inlineContextLength: text.length - userText.length }),
            },
            // Failed delivery bookkeeping must not stop live ingestion.
            accepted: Effect.forEach(
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
                        delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                      }),
                    ]),
              ],
              (record) =>
                record.pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning("Failed to record accepted context handoff delivery", {
                      runId: run.id,
                      deliveryStatus: "pending",
                    }),
                  ),
                ),
              { discard: true },
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

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          let startingRun: OrchestrationV2Run | undefined;
          const captureStartingRun = (run: OrchestrationV2Run) => {
            startingRun = run;
          };
          // The watch runs until the provider took the turn or refused it.
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const sinceWake = yield* awakeSinceWake;
              const afterWake = sinceWake !== undefined && sinceWake < AFTER_WAKE_START_MS;
              const waitDuringStart = Effect.map(yield* watchWait, (wait): StartWait => ({
                ...wait,
                afterWake,
              }));
              // Storage cleanup removes worktrees under the same lease. Only startup
              // holds it; the provider turn runs after it is released.
              const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
              const cwd =
                thread.worktreePath ??
                (yield* projects
                  .getById(thread.projectId, { includeDeleted: true })
                  .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
              const providerTurn = yield* cwd === undefined
                ? start({ ...input, waitDuringStart }, captureStartingRun)
                : withTurnStartReservation(
                    fileSystem,
                    path,
                    path.resolve(cwd),
                    thread.worktreePath === null
                      ? start({ ...input, waitDuringStart }, captureStartingRun)
                      : withWorkspaceLease(
                          path.resolve(thread.worktreePath),
                          start({ ...input, waitDuringStart }, captureStartingRun),
                        ),
                  );
              if (providerTurn !== undefined) {
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
            }),
          ).pipe(
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
      ),
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
