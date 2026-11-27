import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { AccountRouting, creditRefusalMessage, runLiftsScope } from "./AccountRouting.ts";
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
  OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderSessionId,
  isCompactionCommandMessage,
  isListedThreadLineage,
  parseGoalCommand,
  RunId,
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
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { releasedWorktree } from "../workspace/worktreeRelease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSkills from "../provider/ProviderSkills.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import { autoCoordinatorInstructions } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
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
  },
) {}

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

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

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderStartStepTimeoutError = Schema.is(ProviderStartStepTimeoutError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);
const isProviderAdapterTurnStartError = Schema.is(ProviderAdapter.ProviderAdapterTurnStartError);
const isProviderFailure = Schema.is(OrchestrationV2ProviderFailure);

/** Cap transparent in-run usage-limit retries so a broken fleet never loops. */
const MAX_IN_RUN_USAGE_LIMIT_FAILOVERS = 2;

function usageLimitFailureFromError(error: unknown): OrchestrationV2ProviderFailure | undefined {
  const classified = makeProviderFailure({ cause: error, class: "provider_error" });
  if (classified.class === "usage_limit") {
    return classified;
  }
  const seen = new Set<unknown>();
  for (
    let cause: unknown = error;
    Predicate.isObject(cause) && !seen.has(cause);
    cause = Predicate.hasProperty(cause, "cause") ? cause.cause : undefined
  ) {
    seen.add(cause);
    if (isProviderFailure(cause) && cause.class === "usage_limit") {
      return cause;
    }
    if (
      Predicate.hasProperty(cause, "failure") &&
      isProviderFailure(cause.failure) &&
      cause.failure.class === "usage_limit"
    ) {
      return cause.failure;
    }
  }
  return undefined;
}

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

/** The provider refused the start before the prompt reached it, by its own report. */
const refusedBeforePrompt = (error: unknown): boolean =>
  causedBy(
    error,
    (cause) =>
      PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(cause, tag)) ||
      (isProviderAdapterTurnStartError(cause) && cause.beforePrompt === true),
  );

// A busy machine can hold the worker that reads another account's settings past its deadline even
// after its own retry. That says nothing about the settings, so waiting fixes it.
const isClaudeSettingsTimeout = (cause: object) =>
  Predicate.isTagged(cause, "ClaudeSettingsResolveError") &&
  Predicate.hasProperty(cause, "kind") &&
  cause.kind === "timeout";

/** A sign-in, an account the provider turns away (HTTP 401 or 403), or a setup refusal: no retry fixes it. */
const refusedUntilChanged = (error: unknown): boolean =>
  causedBy(
    error,
    (cause) =>
      (isProviderAdapterOpenSessionError(cause) && cause.requiresSignIn === true) ||
      (SETUP_REFUSAL_TAGS.some((tag) => Predicate.isTagged(cause, tag)) &&
        !isClaudeSettingsTimeout(cause)) ||
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
      causedBy(error, isClaudeSettingsTimeout) ||
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

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  /**
   * Continues a running run whose provider process a session host kept alive through a planned
   * update. Fails, writing nothing, when the run or its process cannot be taken over; the caller
   * then recovers the run as after any restart.
   */
  readonly adopt: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  /** Ends a run still `starting` as failed with the cause; a no-op once it left `starting`. */
  readonly failUnstartedRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly cause: Cause.Cause<unknown>;
  }) => Effect.Effect<void, ProviderTurnStartError>;
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
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
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
    const accountRouting = yield* Effect.serviceOption(AccountRouting);
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;
    const awakeSinceWake = yield* AwakeSinceWake;
    const MAX_TRACKED_FAILOVER_RUNS = 256;
    interface RunFailoverState {
      readonly triedInstanceIds: Set<ProviderInstanceId>;
      failoverRetries: number;
      initialUsageLimitFailure?: {
        readonly signal: string;
        readonly title: string;
        readonly error: Error;
      };
    }
    const runFailoverStates = new Map<RunId, RunFailoverState>();
    const getRunFailoverState = (
      runId: RunId,
      initialInstanceId: ProviderInstanceId,
    ): RunFailoverState => {
      let state = runFailoverStates.get(runId);
      if (state === undefined) {
        if (runFailoverStates.size >= MAX_TRACKED_FAILOVER_RUNS) {
          const oldestRunId = runFailoverStates.keys().next().value;
          if (oldestRunId !== undefined) runFailoverStates.delete(oldestRunId);
        }
        state = {
          triedInstanceIds: new Set<ProviderInstanceId>([initialInstanceId]),
          failoverRetries: 0,
        };
        runFailoverStates.set(runId, state);
      } else {
        state.triedInstanceIds.add(initialInstanceId);
      }
      return state;
    };

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
        runFailoverStates.delete(run.id);
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
    const failUnstartedRun = Effect.fn("ProviderTurnStartService.failUnstartedRun")(
      function* (input: Parameters<ProviderTurnStartServiceV2Shape["failUnstartedRun"]>[0]) {
        const projection = yield* projectionStore.getTurnStartContext(input.threadId, input.runId);
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || run.status !== "starting") return;
        const squashed = Cause.squash(input.cause);
        yield* settleUnstartedRunFailure(
          {
            projection,
            run,
            attempt: projection.attempts.find((candidate) => candidate.id === run.activeAttemptId),
            rootNode: projection.nodes.find((candidate) => candidate.id === run.rootNodeId),
          },
          {
            signal: "provider-turn-start-failure",
            title: "Provider turn failed to start",
            error:
              squashed instanceof Error
                ? squashed
                : new ProviderTurnStartError({ runId: run.id, cause: squashed }),
          },
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError((cause) => new ProviderTurnStartError({ runId: input.runId, cause })),
        ),
    );

    const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(
      function* (cwd: string) {
        // Recovery can follow an external checkout, before the status cache expires.
        yield* gitWorkflow.invalidateLocalStatus(cwd);
        const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
        if (currentBranch !== null) {
          const refName = `refs/heads/${currentBranch}`;
          return { refName, baseRefName: refName };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
          const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd,
            refName: "HEAD",
            fallbackRemoteName: "origin",
          });
          // Start from the commit so the thread branch does not track the default branch.
          return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
          return { refName: "HEAD", baseRefName: undefined };
        }
        return null;
      },
    );

    const recreateMissingWorktree = Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly cwd: string;
        readonly worktreePath: string;
        readonly branch: string;
      }) {
        const { cwd, worktreePath, branch } = input;
        yield* gitWorkflow.pruneWorktrees({ cwd });
        const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
        const released = yield* releasedWorktree(
          fileSystem,
          path.join(config.stateDir, ServerConfig.WORKTREE_RELEASE_DIRECTORY),
          worktreePath,
          input.threadId,
          branch,
        );
        if (released) {
          const base = yield* resolveRecreateBase(cwd);
          if (!base) return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
          if (localBranchNames.includes(branch)) {
            yield* gitWorkflow.createWorktree(
              { cwd, refName: branch, path: worktreePath },
              {
                releasedBranch: { previousHead: released.request.head, baseRef: base.refName },
              },
            );
          } else {
            yield* gitWorkflow.createWorktree({
              cwd,
              refName: base.refName,
              newRefName: branch,
              path: worktreePath,
              ...(base.baseRefName ? { baseRefName: base.baseRefName } : {}),
            });
          }
          yield* fileSystem.remove(released.receipt);
          return;
        }
        if (localBranchNames.includes(branch)) {
          yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
          return;
        }
        // Push keeps the tracking ref current, so recovery reads it without fetching.
        const pushedRef = `refs/remotes/origin/${branch}`;
        if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
          yield* gitWorkflow.createWorktree({
            cwd,
            refName: pushedRef,
            newRefName: branch,
            path: worktreePath,
          });
          return;
        }
        const base = yield* resolveRecreateBase(cwd);
        if (base === null) {
          return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
        }
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: base.refName,
          newRefName: branch,
          ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
          path: worktreePath,
        });
      },
    );

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
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
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
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
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
      readonly waitDuringStart: Effect.Effect<StartWait>;
    }) {
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
        runFailoverStates.delete(runId);
        return;
      }
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
      const unstarted = { projection, run, attempt, rootNode };
      const providerSessionId = providerThread.providerSessionId;
      let activeProviderSessionId: ProviderSessionId = providerSessionId;
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
                providerSessionId: activeProviderSessionId,
                silentForMs: Duration.toMillis(Duration.minutes(error.minutes)),
                detail: `The provider sent nothing for ${error.minutes} minutes while a turn waited on it, so it was stopped. The next turn starts a new one.`,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    "orchestration-v2.provider-turn-start.silent-session-release-failed",
                    {
                      providerSessionId: activeProviderSessionId,
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
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Only a person signs a provider out from chat; their RPC checks providers:manage.
        const isUnauthorizedSignOut =
          message.createdBy !== "user" && message.text.trim().toLowerCase() === "/logout";
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
                    text: message.text,
                    records: message.context?.records ?? [],
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
                    input: message.text.trim(),
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
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists && (yield* isManagedWorktreePath(worktreePath))) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            const recreateResult = yield* Effect.result(
              recreateMissingWorktree({
                threadId: projection.thread.id,
                cwd: project.workspaceRoot,
                worktreePath,
                branch,
              }).pipe(
                Effect.mapError((cause) =>
                  cause._tag === "WorktreeRecreateNoBaseError"
                    ? cause
                    : new WorktreeRecreateError({ worktreePath, branch, cause }),
                ),
              ),
            );
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
          }
        }
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
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      // A side chat shares its parent's worktree; the turn that gets its context asks before acting.
      const basePolicyThread =
        projection.thread.lineage.sideChat === true &&
        (sideChatHandoff !== undefined ||
          !projection.runs.some((previous) => previous.ordinal < run.ordinal))
          ? { ...projection.thread, runtimeMode: "approval-required" as const }
          : projection.thread;
      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread: basePolicyThread,
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
      const failedRuns = new Map(
        projection.runs
          .filter(
            (previous) =>
              previous.ordinal < run.ordinal &&
              previous.providerThreadId === providerThread.id &&
              previous.status === "failed",
          )
          .map((previous) => [previous.activeAttemptId, previous] as const),
      );
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = failedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined &&
          turn.nodeId === previous.rootNodeId
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // Older versions could fail the run without stopping its provider.
          // Recover that exact turn before reusing its native conversation.
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
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            ...(yield* Effect.forEach(abandonedTurns, ({ turn, run: failedRun }) =>
              Effect.gen(function* () {
                return {
                  id: yield* idAllocator.allocate.event(),
                  type: "provider-turn.updated" as const,
                  threadId: projection.thread.id,
                  runId: failedRun.id,
                  nodeId: turn.nodeId,
                  providerInstanceId: failedRun.providerInstanceId,
                  occurredAt: completedAt,
                  payload: { ...turn, status: "interrupted" as const, completedAt },
                };
              }),
            )),
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
      }
      const failoverState = getRunFailoverState(run.id, run.providerInstanceId);
      let activeRun: OrchestrationV2Run = run;
      let activeAttempt: OrchestrationV2RunAttempt = attempt;
      let activeProviderThread: OrchestrationV2ProviderThread = providerThread;
      let activeRuntimePolicy = resolvedRuntimePolicy;
      let activeCanResumeNatively = false;
      let openedAlternateSessionId: ProviderSessionId | null = null;

      const catchNonInterrupt =
        <E, A2, R2>(onCause: (cause: Cause.Cause<E>) => Effect.Effect<A2, never, R2>) =>
        <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | A2, never, R | R2> =>
          effect.pipe(
            Effect.catchCauseIf((cause) => !Cause.hasInterruptsOnly(cause), onCause),
            Effect.orDie,
          );

      const detachSupersededSession = (sessionId: ProviderSessionId, detail: string) =>
        Effect.suspend(() =>
          providerSessions.detach({
            providerSessionId: sessionId,
            threadId: projection.thread.id,
            detail,
            revokeMcpCredential: false,
          }),
        ).pipe(
          catchNonInterrupt((cause) =>
            Effect.logWarning(
              "orchestration-v2.provider-turn-start.detach-failover-session-failed",
              {
                threadId: projection.thread.id,
                runId: run.id,
                providerSessionId: sessionId,
                cause,
              },
            ),
          ),
        );

      const detachOpenedAlternateSession = (detail: string) =>
        Effect.suspend(() => {
          const sessionId = openedAlternateSessionId;
          if (sessionId === null) return Effect.void;
          openedAlternateSessionId = null;
          return detachSupersededSession(sessionId, detail);
        });

      const refreshFailedAccountInBackground = (instanceId: ProviderInstanceId) =>
        Option.isSome(providerRegistry)
          ? Effect.suspend(() => providerRegistry.value.refreshInstance(instanceId)).pipe(
              catchNonInterrupt((cause) =>
                Effect.logWarning(
                  "orchestration-v2.provider-turn-start.refresh-refused-account-failed",
                  {
                    threadId: projection.thread.id,
                    runId: run.id,
                    providerInstanceId: instanceId,
                    cause,
                  },
                ),
              ),
              Effect.forkDetach,
            )
          : Effect.void;

      const recordSilentUsageLimitRefusal = Effect.fn(
        "ProviderTurnStartService.recordSilentUsageLimitRefusal",
      )(
        function* (instanceId: ProviderInstanceId, usageLimit: OrchestrationV2ProviderFailure) {
          const refusedAt = yield* DateTime.now;
          yield* projectionStore.recordUsageLimitRefusal({
            providerInstanceId: instanceId,
            refusedAt,
            resetAt: usageLimit.resetAt ?? null,
            code: usageLimit.code ?? null,
            modelScope: usageLimit.modelScope ?? null,
          });
        },
        (effect, instanceId) =>
          effect.pipe(
            catchNonInterrupt((cause) =>
              Effect.logWarning(
                "orchestration-v2.provider-turn-start.record-usage-limit-refusal-failed",
                {
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: instanceId,
                  cause,
                },
              ),
            ),
          ),
      );

      const getAdapterMetadata = (instanceId: ProviderInstanceId) =>
        Option.isNone(providerAdapters)
          ? Effect.succeedNone
          : providerAdapters.value.getMetadata !== undefined
            ? providerAdapters.value.getMetadata(instanceId).pipe(
                Effect.asSome,
                catchNonInterrupt(() => Effect.succeedNone),
              )
            : providerAdapters.value.get(instanceId).pipe(
                Effect.flatMap((adapter) =>
                  adapter.getCapabilities().pipe(
                    Effect.map((capabilities) => ({
                      driver: adapter.driver,
                      continuationKey: undefined as string | undefined,
                      enabled: true,
                      capabilities,
                    })),
                  ),
                ),
                Effect.asSome,
                catchNonInterrupt(() => Effect.succeedNone),
              );

      const selectNextFailoverCandidate = Effect.fn(
        "ProviderTurnStartService.selectNextFailoverCandidate",
      )(function* (selectInput: {
        readonly failedInstanceId: ProviderInstanceId;
        readonly detachPreviousSession: boolean;
        readonly requireNativeResume: boolean;
        readonly reasonCode: string | null | undefined;
      }) {
        if (Option.isNone(accountRouting)) return false;
        if (failoverState.failoverRetries >= MAX_IN_RUN_USAGE_LIMIT_FAILOVERS) return false;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return false;

        const candidates = yield* Effect.suspend(() =>
          accountRouting.value.accountsWithRoom({
            driver: providerThread.driver,
            projectId: projection.thread.projectId,
            model: run.modelSelection.model,
            requesterThreadId: projection.thread.id,
            ...(resolvedRuntimePolicy.cwd === null ? {} : { cwd: resolvedRuntimePolicy.cwd }),
          }),
        ).pipe(
          catchNonInterrupt((cause) =>
            Effect.logWarning(
              "orchestration-v2.provider-turn-start.failover-candidates-read-failed",
              {
                threadId: projection.thread.id,
                runId: run.id,
                cause,
              },
            ).pipe(Effect.as([])),
          ),
        );

        const sourceMetadata = Option.getOrUndefined(
          yield* getAdapterMetadata(providerThread.providerInstanceId),
        );

        for (const candidate of candidates) {
          if (failoverState.triedInstanceIds.has(candidate.instanceId)) continue;

          const targetMetadata = Option.getOrUndefined(
            yield* getAdapterMetadata(candidate.instanceId),
          );
          const canResumeAcrossInstances =
            providerThread.nativeThreadRef !== null &&
            sourceMetadata !== undefined &&
            targetMetadata !== undefined &&
            sourceMetadata.continuationKey !== undefined &&
            targetMetadata.continuationKey !== undefined &&
            sourceMetadata.driver === targetMetadata.driver &&
            sourceMetadata.continuationKey === targetMetadata.continuationKey;
          if (selectInput.requireNativeResume && !canResumeAcrossInstances) {
            failoverState.triedInstanceIds.add(candidate.instanceId);
            continue;
          }

          const candidateCreditRefusal = yield* Effect.suspend(() =>
            accountRouting.value.creditRefusal({
              threadId: projection.thread.id,
              instanceId: candidate.instanceId,
              model: candidate.model,
            }),
          ).pipe(
            catchNonInterrupt((cause) =>
              Effect.logWarning(
                "orchestration-v2.provider-turn-start.usage-limit-failover-credit-check-failed",
                {
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: candidate.instanceId,
                  cause,
                },
              ).pipe(Effect.as({ credits: "unverified" as const })),
            ),
          );
          if (candidateCreditRefusal !== null) {
            failoverState.triedInstanceIds.add(candidate.instanceId);
            continue;
          }

          const existingTargetProviderThread = canResumeAcrossInstances
            ? undefined
            : projection.providerThreads.find(
                (candidateThread) =>
                  candidateThread.ownerNodeId === null &&
                  candidateThread.providerInstanceId === candidate.instanceId &&
                  candidateThread.nativeThreadRef === null,
              );
          const supportsMultipleThreads =
            targetMetadata?.capabilities.sessions.supportsMultipleProviderThreadsPerSession ===
            true;
          const nextProviderSessionId =
            (!canResumeAcrossInstances && existingTargetProviderThread?.providerSessionId != null
              ? existingTargetProviderThread.providerSessionId
              : undefined) ??
            (supportsMultipleThreads
              ? idAllocator.derive.providerSession({ providerInstanceId: candidate.instanceId })
              : yield* idAllocator.allocate.providerSession({
                  providerInstanceId: candidate.instanceId,
                  threadId: projection.thread.id,
                }));

          const nowFailover = yield* DateTime.now;
          const targetDriver = targetMetadata?.driver ?? providerThread.driver;
          const nextProviderThread: OrchestrationV2ProviderThread = canResumeAcrossInstances
            ? {
                ...providerThread,
                driver: targetDriver,
                providerInstanceId: candidate.instanceId,
                providerSessionId: nextProviderSessionId,
                status: "not_loaded",
                updatedAt: nowFailover,
              }
            : existingTargetProviderThread !== undefined
              ? {
                  ...existingTargetProviderThread,
                  driver: targetDriver,
                  providerInstanceId: candidate.instanceId,
                  providerSessionId: nextProviderSessionId,
                  status: "not_loaded",
                  updatedAt: nowFailover,
                }
              : {
                  id: idAllocator.derive.providerThread({
                    driver: targetDriver,
                    nativeThreadId: `pending:${run.id}:failover:${candidate.instanceId}`,
                  }),
                  driver: targetDriver,
                  providerInstanceId: candidate.instanceId,
                  providerSessionId: nextProviderSessionId,
                  appThreadId: projection.thread.id,
                  ownerNodeId: null,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  status: "not_loaded",
                  firstRunOrdinal: run.ordinal,
                  lastRunOrdinal: run.ordinal,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: nowFailover,
                  updatedAt: nowFailover,
                };

          const nextModelSelection: OrchestrationV2Run["modelSelection"] = {
            ...run.modelSelection,
            instanceId: candidate.instanceId,
            model: candidate.model,
          };
          const nextRun: OrchestrationV2Run = {
            ...run,
            providerInstanceId: candidate.instanceId,
            providerThreadId: nextProviderThread.id,
            modelSelection: nextModelSelection,
          };
          const nextPolicy = yield* runtimePolicy
            .resolve({
              thread: {
                ...basePolicyThread,
                providerInstanceId: candidate.instanceId,
                modelSelection: nextModelSelection,
              },
              modelSelection: nextModelSelection,
              run: nextRun,
            })
            .pipe(Effect.result);
          if (nextPolicy._tag === "Failure") {
            failoverState.triedInstanceIds.add(candidate.instanceId);
            continue;
          }

          if (selectInput.detachPreviousSession) {
            const previousSessionId = activeProviderSessionId;
            if (openedAlternateSessionId === previousSessionId) {
              openedAlternateSessionId = null;
            }
            yield* detachSupersededSession(
              previousSessionId,
              `Switched account after immediate usage-limit refusal on ${selectInput.failedInstanceId}.`,
            );
          }

          failoverState.triedInstanceIds.add(candidate.instanceId);
          failoverState.failoverRetries += 1;
          activeRun = nextRun;
          activeAttempt = {
            ...attempt,
            providerInstanceId: candidate.instanceId,
            providerThreadId: nextProviderThread.id,
          };
          activeProviderSessionId = nextProviderSessionId;
          activeProviderThread = nextProviderThread;
          activeRuntimePolicy = nextPolicy.success;
          activeCanResumeNatively = canResumeAcrossInstances;

          yield* Effect.logInfo("orchestration-v2.provider-turn-start.usage-limit-failover", {
            threadId: projection.thread.id,
            runId: run.id,
            fromProviderInstanceId: selectInput.failedInstanceId,
            toProviderInstanceId: candidate.instanceId,
            model: candidate.model,
            attempt: failoverState.failoverRetries,
            code: selectInput.reasonCode,
            canResumeNatively: canResumeAcrossInstances,
          });
          return true;
        }

        return false;
      });

      const tryFailoverOnUsageLimit = Effect.fn("ProviderTurnStartService.tryFailoverOnUsageLimit")(
        function* (failoverInput: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly detachPreviousSession: boolean;
        }) {
          const usageLimit = usageLimitFailureFromError(failoverInput.error);
          if (usageLimit === undefined) return false;

          const failedInstanceId = activeRun.providerInstanceId;
          failoverState.triedInstanceIds.add(failedInstanceId);

          if (Option.isNone(accountRouting)) return false;
          const settings = yield* serverSettings.getSettings.pipe(
            catchNonInterrupt((cause) =>
              Effect.logWarning(
                "orchestration-v2.provider-turn-start.failover-settings-read-failed",
                {
                  threadId: projection.thread.id,
                  runId: run.id,
                  cause,
                },
              ).pipe(Effect.as(null)),
            ),
          );
          if (settings?.failoverLimitedThreads !== true) return false;

          // Preserve account A's exact usage_limit error so exhausted failovers or alternate-account
          // errors settle cleanly on account A instead of blaming an alternate account.
          if (failoverState.initialUsageLimitFailure === undefined) {
            failoverState.initialUsageLimitFailure = {
              signal: failoverInput.signal,
              title: failoverInput.title,
              error: failoverInput.error,
            };
          }

          // Refresh the refusing account in the background so future routing sees its limit promptly.
          yield* refreshFailedAccountInBackground(failedInstanceId);

          // Alternate accounts that refuse with usage_limit never emit a visible error turn item
          // (settlement blames the initial account), so durably record their refusal immediately.
          if (failedInstanceId !== run.providerInstanceId) {
            yield* recordSilentUsageLimitRefusal(failedInstanceId, usageLimit);
          }

          const switched = yield* selectNextFailoverCandidate({
            failedInstanceId,
            detachPreviousSession: failoverInput.detachPreviousSession,
            requireNativeResume: false,
            reasonCode: usageLimit.code,
          });
          if (switched) {
            if (failedInstanceId === run.providerInstanceId) {
              yield* recordSilentUsageLimitRefusal(failedInstanceId, usageLimit);
            }
            return true;
          }

          return false;
        },
      );

      const settleWithInitialUsageLimitOr = (fallback: Parameters<typeof settleStartFailure>[0]) =>
        settleStartFailure(failoverState.initialUsageLimitFailure ?? fallback);

      const startAttempt = Effect.fn("ProviderTurnStartService.startAttempt")(function* () {
        const existingSessionProjection = projection.providerSessions.find(
          (candidate) => candidate.id === activeProviderSessionId,
        );
        // Only a session that was already running can hold output it buffered for a wake.
        const sessionWasLive = yield* providerSessions.isLive(activeProviderSessionId);
        const sessionResult = yield* Effect.result(
          providerSessions
            .open({
              threadId: projection.thread.id,
              providerSessionId: activeProviderSessionId,
              modelSelection: activeRun.modelSelection,
              runtimePolicy: activeRuntimePolicy,
              ...(existingSessionProjection === undefined
                ? {}
                : { resumeFromSession: existingSessionProjection }),
              ...(activeProviderThread.nativeThreadRef?.nativeId == null
                ? {}
                : { initialNativeThreadId: activeProviderThread.nativeThreadRef.nativeId }),
              ...(activeProviderThread.nativeMetadata?.itemIdentityVersion === undefined
                ? {}
                : {
                    initialProviderItemIdentityVersion:
                      activeProviderThread.nativeMetadata.itemIdentityVersion,
                  }),
            })
            .pipe(withStartStepTimeout("open its session")),
        );
        if (sessionResult._tag === "Failure") {
          const failure = sessionResult.failure;
          if (failure._tag !== "ProviderStartStepTimeoutError") {
            if (
              yield* tryFailoverOnUsageLimit({
                signal: "provider-session-open-failure",
                title: "Provider session failed to open",
                error: failure,
                detachPreviousSession: false,
              })
            ) {
              return { _tag: "retry_failover" as const };
            }
            if (failoverState.initialUsageLimitFailure === undefined && retriesLater(failure)) {
              return yield* failure;
            }
          }
          yield* settleWithInitialUsageLimitOr({
            signal: "provider-session-open-failure",
            title: "Provider session failed to open",
            error: sessionResult.failure,
          });
          return { _tag: "stop" as const };
        }
        const session = sessionResult.success;
        if (activeProviderSessionId !== providerSessionId) {
          openedAlternateSessionId = activeProviderSessionId;
        }
        if (!(yield* isCurrentAttemptInStatus("starting"))) {
          yield* detachOpenedAlternateSession("Detaching failover session for superseded run.");
          runFailoverStates.delete(runId);
          return { _tag: "stop" as const };
        }
        type ProviderThreadLoadOutcome =
          | {
              readonly _tag: "loaded";
              readonly providerThread: OrchestrationV2ProviderThread;
            }
          | { readonly _tag: "retry_failover" }
          | { readonly _tag: "stop" };
        const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
          load: Effect.Effect<
            OrchestrationV2ProviderThread,
            ProviderAdapter.ProviderAdapterV2Error
          >,
        ): Effect.fn.Return<
          ProviderThreadLoadOutcome,
          | ProviderAdapter.ProviderAdapterV2Error
          | ProviderTurnStartError
          | EventSink.EventSinkWriteError
          | EventSink.EventSinkStreamError
          | IdAllocator.IdAllocatorV2AllocationError
          | ProjectionStore.ProjectionStoreV2Error
        > {
          const loaded = yield* Effect.result(
            load.pipe(withStartStepTimeout("load the conversation")),
          );
          if (loaded._tag === "Success") {
            return { _tag: "loaded" as const, providerThread: loaded.success };
          }
          if (loaded.failure._tag !== "ProviderStartStepTimeoutError") {
            if (
              yield* tryFailoverOnUsageLimit({
                signal: "provider-thread-load-failure",
                title: "Provider turn failed to start",
                error: loaded.failure,
                detachPreviousSession: true,
              })
            ) {
              return { _tag: "retry_failover" as const };
            }
            if (
              failoverState.initialUsageLimitFailure === undefined &&
              retriesLater(loaded.failure)
            ) {
              yield* detachOpenedAlternateSession(
                "Detaching failover session before retrying start.",
              );
              return yield* loaded.failure;
            }
          }
          yield* detachOpenedAlternateSession("Detaching failover session after start failure.");
          yield* settleWithInitialUsageLimitOr({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: loaded.failure,
          });
          return { _tag: "stop" as const };
        });
        let effectiveHandoffs = handoffs;
        let resumeFellBack = false;
        const expandedText = yield* Effect.result(
          message.createdBy === "user"
            ? providerSkills.expandSkillMentions({
                text: message.text,
                instanceId: activeRun.providerInstanceId,
                cwd: activeRuntimePolicy.cwd,
                settings: resolveProjectSettings(
                  yield* serverSettings.getSettings,
                  projection.thread.projectId,
                ).settings,
              })
            : Effect.succeed(message.text),
        );
        if (expandedText._tag === "Failure") {
          yield* detachOpenedAlternateSession(
            "Detaching failover session after shared skill load failure.",
          );
          if (
            failoverState.initialUsageLimitFailure === undefined &&
            retriesLater(expandedText.failure)
          ) {
            return yield* expandedText.failure;
          }
          yield* settleWithInitialUsageLimitOr({
            signal: "shared-skill-load-failure",
            title: "Shared skill could not be loaded",
            error: expandedText.failure,
            message: expandedText.failure.message,
          });
          return { _tag: "stop" as const };
        }
        const userText = projectComposerContextForProvider({
          text: expandedText.success,
          records: message.context?.records ?? [],
        });
        // Codex and Claude parse /goal from the prompt, so it goes verbatim and history waits a turn.
        const goalDriver = session.driver === "codex" || session.driver === "claudeAgent";
        const goalCommand = goalDriver && parseGoalCommand(message) !== null;
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
          isRestartNoteContinuation(
            run,
            currentRuns,
            projection.providerTurns,
            projection.attempts,
          );
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
              conversation: conversationProviderThreadIds(
                providerThread,
                projection.providerThreads,
              ),
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
          activeRun.modelSelection.autoAccount === true &&
          !goalCommand &&
          !userText.trimStart().startsWith("/") &&
          isListedThreadLineage(projection.thread.lineage) &&
          projection.thread.delegatedFrom === undefined;
        const tokenCap = yield* handoffTokenCapConfig.pipe(
          Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
        );
        const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
          const measuredContext = latestNativeContextUsage(projection, activeProviderThread);
          const previousSelection =
            measuredContext?.modelSelection ??
            projection.runs.findLast(
              (source) =>
                source.ordinal < run.ordinal &&
                source.startedAt !== null &&
                source.providerThreadId === activeProviderThread.id,
            )?.modelSelection;
          const sameSelection =
            previousSelection === undefined ||
            modelSelectionsEqual(previousSelection, activeRun.modelSelection);
          const sameNativeThread =
            activeProviderThread.nativeThreadRef !== null &&
            loadedProviderThread.nativeThreadRef?.nativeId ===
              activeProviderThread.nativeThreadRef.nativeId;
          const threadUsage =
            loadedProviderThread.contextUsage ?? activeProviderThread.contextUsage;
          const previousUsage = measuredContext
            ? { ...threadUsage, ...measuredContext.usage }
            : threadUsage;
          const reuseTelemetry =
            sameSelection ||
            (previousSelection !== undefined &&
              session.canReuseContextUsage?.(previousSelection, activeRun.modelSelection) === true);
          const knownModelWindow = session.getModelContextWindow?.(
            activeRun.modelSelection,
            activeRuntimePolicy.cwd,
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
              handoff.toProviderThreadId === activeProviderThread.id &&
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
              source.providerThreadId === activeProviderThread.id &&
              deliveredAttemptIds.has(source.id),
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
                  source.providerThreadId === activeProviderThread.id &&
                  settledHandoffs.some(
                    (handoff) =>
                      handoff.strategy === "full_thread_summary" &&
                      handoff.fromProviderThreadIds.includes(activeProviderThread.id) &&
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
                    item.providerThreadId === activeProviderThread.id &&
                    item.runId !== null &&
                    (nativeInputRunIds.has(item.runId) ||
                      (legacyInputRunIds.has(item.runId) &&
                        !coveredItemIds.has(item.id) &&
                        !legacyRecoveredRunIds.has(item.runId)));
                  if (
                    item.runId === run.id ||
                    (!acceptedNatively && !deliveredItemIds.has(item.id))
                  )
                    return sum;
                  const historical = historicalMessage(item);
                  const nativeAttachments =
                    item.type === "user_message" && acceptedNatively
                      ? attachmentTokenAllowance(item.attachments)
                      : 0;
                  return (
                    sum +
                    (historical === null ? 0 : Buffer.byteLength(historical.text)) +
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
              source.providerThreadId === activeProviderThread.id &&
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
                attachments: message.attachments,
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
                      fromProviderThreadIds: [activeProviderThread.id],
                      toProviderThreadId: activeProviderThread.id,
                      fromProviderInstanceId: activeRun.providerInstanceId,
                      toProviderInstanceId: activeRun.providerInstanceId,
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
              toProviderThreadId: activeProviderThread.id,
              fromProviderInstanceId: providerThread.providerInstanceId,
              toProviderInstanceId: activeRun.providerInstanceId,
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
        const loadResult: ProviderThreadLoadOutcome = yield* Effect.gen(function* () {
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
            if (
              !sourceBusy &&
              sourceProviderThread.providerInstanceId === activeRun.providerInstanceId
            ) {
              return yield* loadFromProvider(
                session.forkThread({
                  sourceProviderThread,
                  sourceProviderTurns: sourceProjection.providerTurns,
                  targetThreadId: projection.thread.id,
                  modelSelection: activeRun.modelSelection,
                  runtimePolicy: activeRuntimePolicy,
                  ...(sourceProviderTurn === undefined
                    ? {}
                    : { providerTurnId: sourceProviderTurn.id }),
                }),
              );
            }
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
              toProviderThreadId: activeProviderThread.id,
              fromProviderInstanceId: sourceRun.providerInstanceId,
              toProviderInstanceId: activeRun.providerInstanceId,
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
                modelSelection: activeRun.modelSelection,
                runtimePolicy: activeRuntimePolicy,
                providerSessionId: activeProviderSessionId,
                existingProviderThread: { ...activeProviderThread, forkedFrom: null },
              }),
            );
            if (loaded._tag !== "loaded") return loaded;
            portableForkFallback = handoff;
            effectiveHandoffs = [handoff, ...effectiveHandoffs];
            yield* eventSink.write({
              events: [
                {
                  id: yield* idAllocator.allocate.event(),
                  type: "context-handoff.updated",
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: createdAt,
                  payload: handoff,
                },
                {
                  id: yield* idAllocator.allocate.event(),
                  type: "context-transfer.updated",
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: createdAt,
                  payload: {
                    ...nativeForkTransfer,
                    targetProviderInstanceId: activeRun.providerInstanceId,
                    status: "resolved_portable",
                    resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                    error: null,
                    updatedAt: createdAt,
                  },
                },
              ],
            });
            return loaded;
          }
          if (activeProviderThread.nativeThreadRef === null) {
            // Pass the stored provider row for adoption; adapter-minted duplicates make activeProviderThreadId flap.
            return yield* loadFromProvider(
              session.ensureThread({
                threadId: projection.thread.id,
                title: projection.thread.title,
                modelSelection: activeRun.modelSelection,
                runtimePolicy: activeRuntimePolicy,
                providerSessionId: activeProviderSessionId,
                existingProviderThread: activeProviderThread,
              }),
            );
          }
          const uncertainDelivery = projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === activeProviderThread.id &&
              handoff.delivery?.nativeThreadId === activeProviderThread.nativeThreadRef?.nativeId &&
              handoff.delivery?.status === "pending",
          );
          const resumed = yield* Effect.result(
            uncertainDelivery
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    providerThreadId: activeProviderThread.id,
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
                      providerThread: activeProviderThread,
                      threadId: projection.thread.id,
                      modelSelection: activeRun.modelSelection,
                      runtimePolicy: activeRuntimePolicy,
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
              providerThread: { ...resumed.success, id: activeProviderThread.id },
              budget: context.budget,
              deferInline: isCompactionCommandMessage(message) || goalCommand,
              alreadyDeliveredItemIds: context.deliveredItemIds,
              persist: () => Effect.void,
            }).pipe(
              Effect.as(true),
              Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
            );
            if (fits) return { _tag: "loaded" as const, providerThread: resumed.success };
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
            if (!fitsFresh) return { _tag: "loaded" as const, providerThread: resumed.success };
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
                    providerThreadId: activeProviderThread.id,
                    runId,
                    cause: new ContextHandoffBackgroundWorkError(),
                  }),
                ),
              );
            }
          }
          // An immediate usage-limit refusal on resume switches accounts instead of retrying the same one.
          if (
            resumed._tag === "Failure" &&
            resumed.failure._tag !== "ProviderStartStepTimeoutError" &&
            (yield* tryFailoverOnUsageLimit({
              signal: "provider-thread-load-failure",
              title: "Provider turn failed to start",
              error: resumed.failure,
              detachPreviousSession: true,
            }))
          ) {
            return { _tag: "retry_failover" as const };
          }
          // If an alternate account fails to resume after failover, do not blame it or run blank.
          if (resumed._tag === "Failure" && failoverState.initialUsageLimitFailure !== undefined) {
            yield* detachOpenedAlternateSession("Detaching failover session after resume failure.");
            yield* settleWithInitialUsageLimitOr({
              signal: "provider-thread-load-failure",
              title: "Provider turn failed to start",
              error: resumed.failure,
            });
            return { _tag: "stop" as const };
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
            return { _tag: "stop" as const };
          }
          resumedHandoffContext = undefined;
          resumedRetryHandoff = [];
          if (!(yield* isCurrentAttemptInStatus("starting"))) {
            yield* detachOpenedAlternateSession("Detaching failover session for superseded run.");
            runFailoverStates.delete(runId);
            return { _tag: "stop" as const };
          }

          yield* Effect.logWarning("Recovering provider context in a fresh native session", {
            driver: session.driver,
            providerThreadId: activeProviderThread.id,
            runId,
            reason: uncertainDelivery
              ? "uncertain_history_delivery"
              : resumed._tag === "Success"
                ? "handoff_budget_exhausted"
                : "resume_failed",
            errorTag:
              resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
          });
          const replacement = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: activeRun.modelSelection,
              runtimePolicy: activeRuntimePolicy,
              providerSessionId: activeProviderSessionId,
              // Clear the native ref to force a fresh session while preserving row identity.
              existingProviderThread: { ...activeProviderThread, nativeThreadRef: null },
              forceNewNativeThread: true,
            }),
          );
          if (replacement._tag !== "loaded") return replacement;
          const { handoff, transferId, createdAt } = yield* recoveryHandoff;
          effectiveHandoffs = withRecoveryHandoff(handoff);
          resumeFellBack = true;
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event(),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: activeRun.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event(),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: activeRun.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  id: transferId,
                  type: "provider_handoff",
                  sourceThreadId: projection.thread.id,
                  targetThreadId: projection.thread.id,
                  sourcePoint: { threadId: projection.thread.id },
                  basePoint: null,
                  sourceProviderInstanceId: providerThread.providerInstanceId,
                  targetProviderInstanceId: activeRun.providerInstanceId,
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
          return replacement;
        });
        if (loadResult._tag !== "loaded") return loadResult;
        const loadedProviderThread = loadResult.providerThread;
        if (!(yield* isCurrentAttemptInStatus("starting"))) {
          yield* detachOpenedAlternateSession("Detaching failover session for superseded run.");
          runFailoverStates.delete(runId);
          return { _tag: "stop" as const };
        }
        let failoverHandoff: Effect.Success<typeof recoveryHandoff> | undefined;
        let handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
        if (
          activeRun.providerInstanceId !== run.providerInstanceId &&
          !activeCanResumeNatively &&
          !resumeFellBack &&
          portableForkFallback === undefined &&
          providerThread.nativeThreadRef !== null &&
          projection.runs.some(
            (source) =>
              source.ordinal < run.ordinal && source.providerThreadId === providerThread.id,
          )
        ) {
          const preparedFailoverHandoff = yield* Effect.result(recoveryHandoff);
          let handoffFits = false;
          let handoffFailureReason: "handoff_preparation_failed" | "handoff_budget_exceeded" =
            "handoff_preparation_failed";
          let handoffFailureCause: unknown =
            preparedFailoverHandoff._tag === "Failure"
              ? preparedFailoverHandoff.failure
              : undefined;
          if (preparedFailoverHandoff._tag === "Success") {
            handoffContext.budget = yield* Effect.cached(handoffContext.budget);
            const budgetCheck = yield* Effect.result(
              deliverContextHandoffs({
                handoffs: withRecoveryHandoff(preparedFailoverHandoff.success.handoff),
                providerThread: { ...loadedProviderThread, id: activeProviderThread.id },
                budget: handoffContext.budget,
                alreadyDeliveredItemIds: handoffContext.deliveredItemIds,
                persist: () => Effect.void,
              }).pipe(
                Effect.as(true),
                Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
              ),
            );
            if (budgetCheck._tag === "Success" && budgetCheck.success) {
              handoffFits = true;
            } else {
              handoffFailureReason =
                budgetCheck._tag === "Success"
                  ? "handoff_budget_exceeded"
                  : "handoff_preparation_failed";
              handoffFailureCause =
                budgetCheck._tag === "Failure" ? budgetCheck.failure : "ContextHandoffBudgetError";
            }
          }
          if (preparedFailoverHandoff._tag === "Success" && handoffFits) {
            failoverHandoff = preparedFailoverHandoff.success;
            effectiveHandoffs = withRecoveryHandoff(failoverHandoff.handoff);
            resumeFellBack = true;
          } else {
            yield* Effect.logWarning(
              "orchestration-v2.provider-turn-start.usage-limit-failover-handoff-failed",
              {
                threadId: projection.thread.id,
                runId: run.id,
                fromProviderInstanceId: providerThread.providerInstanceId,
                toProviderInstanceId: activeRun.providerInstanceId,
                reason: handoffFailureReason,
                cause: handoffFailureCause,
              },
            );
            const failedHandoffInstanceId = activeRun.providerInstanceId;
            yield* detachOpenedAlternateSession(
              `Detaching failover session on ${failedHandoffInstanceId} after recovery handoff could not carry conversation history.`,
            );
            if (
              yield* selectNextFailoverCandidate({
                failedInstanceId: failedHandoffInstanceId,
                detachPreviousSession: false,
                requireNativeResume: true,
                reasonCode: handoffFailureReason,
              })
            ) {
              return { _tag: "retry_failover" as const };
            }
            yield* settleWithInitialUsageLimitOr({
              signal: "provider-thread-load-failure",
              title: "Provider turn failed to start",
              error: new ProviderTurnStartError({
                runId: run.id,
                cause: handoffFailureCause,
              }),
            });
            return { _tag: "stop" as const };
          }
        }
        const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
        return {
          _tag: "ready" as const,
          session,
          loadedProviderThread,
          userText,
          goalCommand,
          noteContinuation,
          backgroundWorkNote,
          restartNote,
          autoBriefed,
          effectiveHandoffs,
          portableForkFallback,
          failoverHandoff,
          handoffContext,
          retryHandoff,
        };
      });

      const committed = yield* Effect.gen(function* () {
        let ready:
          | Extract<Effect.Success<ReturnType<typeof startAttempt>>, { readonly _tag: "ready" }>
          | undefined;
        while (ready === undefined) {
          const outcome = yield* startAttempt();
          if (outcome._tag === "stop") return undefined;
          if (outcome._tag === "ready") {
            ready = outcome;
          }
        }

        const {
          session,
          loadedProviderThread,
          userText,
          goalCommand,
          noteContinuation,
          backgroundWorkNote,
          restartNote,
          autoBriefed,
          effectiveHandoffs,
          portableForkFallback,
          failoverHandoff,
          handoffContext,
          retryHandoff,
        } = ready;
        const now = yield* DateTime.now;
        const { handoffUsage } = handoffContext;
        const failedOver = activeRun.providerInstanceId !== run.providerInstanceId;
        let latestThread = projection.thread;
        if (failedOver) {
          latestThread = yield* projectionStore.getThreadRecords(projection.thread.id, []).pipe(
            Effect.map((records) => records.thread),
            catchNonInterrupt((cause) =>
              Effect.logWarning("orchestration-v2.provider-turn-start.latest-thread-read-failed", {
                threadId: projection.thread.id,
                runId: run.id,
                cause,
              }).pipe(Effect.as(projection.thread)),
            ),
          );
        }
        const selectionUnchanged =
          failedOver &&
          latestThread.modelSelection !== undefined &&
          projection.thread.modelSelection !== undefined &&
          modelSelectionsEqual(latestThread.modelSelection, projection.thread.modelSelection);
        const runningThread = failedOver
          ? {
              ...latestThread,
              activeProviderThreadId: activeProviderThread.id,
              ...(selectionUnchanged
                ? {
                    providerInstanceId: activeRun.providerInstanceId,
                    modelSelection: activeRun.modelSelection,
                  }
                : latestThread.providerInstanceId === projection.thread.providerInstanceId
                  ? { providerInstanceId: activeRun.providerInstanceId }
                  : {}),
              updatedAt: now,
            }
          : projection.thread;
        const { starredMessageIds: _starredMessageIds, ...runningThreadEventPayload } =
          runningThread;
        const addedHandoffIds = [
          ...(portableForkFallback === undefined ? [] : [portableForkFallback.id]),
          ...(failoverHandoff === undefined ? [] : [failoverHandoff.handoff.id]),
        ];
        const runningProviderThread: OrchestrationV2ProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
          id: activeProviderThread.id,
          driver: session.driver,
          providerInstanceId: activeRun.providerInstanceId,
          providerSessionId: activeProviderSessionId,
          appThreadId: projection.thread.id,
          ownerNodeId: activeProviderThread.ownerNodeId,
          firstRunOrdinal: activeProviderThread.firstRunOrdinal ?? activeRun.ordinal,
          lastRunOrdinal: activeRun.ordinal,
          handoffIds:
            addedHandoffIds.length === 0
              ? activeProviderThread.handoffIds
              : [...activeProviderThread.handoffIds, ...addedHandoffIds],
          forkedFrom:
            portableForkFallback === undefined && !failedOver
              ? activeProviderThread.forkedFrom
              : null,
          status: "active",
          createdAt: activeProviderThread.createdAt,
          updatedAt: now,
        };
        const runningRun: OrchestrationV2Run = {
          ...activeRun,
          providerThreadId: runningProviderThread.id,
          status: "running",
          startedAt: now,
        };
        const runningAttempt: OrchestrationV2RunAttempt = {
          ...activeAttempt,
          providerThreadId: runningProviderThread.id,
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
          providerThreadId: runningProviderThread.id,
          status: "running",
          startedAt: now,
        };
        const events: Array<OrchestrationV2DomainEvent> = [
          ...(failedOver
            ? [
                {
                  id: yield* idAllocator.allocate.event(),
                  type: "thread.provider-switched" as const,
                  threadId: projection.thread.id,
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: now,
                  payload: runningThreadEventPayload,
                },
              ]
            : []),
          ...(failoverHandoff === undefined
            ? []
            : [
                {
                  id: yield* idAllocator.allocate.event(),
                  type: "context-handoff.updated" as const,
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: failoverHandoff.createdAt,
                  payload: failoverHandoff.handoff,
                },
                {
                  id: yield* idAllocator.allocate.event(),
                  type: "context-transfer.updated" as const,
                  threadId: projection.thread.id,
                  runId: run.id,
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: failoverHandoff.createdAt,
                  payload: {
                    id: failoverHandoff.transferId,
                    type: "provider_handoff" as const,
                    sourceThreadId: projection.thread.id,
                    targetThreadId: projection.thread.id,
                    sourcePoint: { threadId: projection.thread.id },
                    basePoint: null,
                    sourceProviderInstanceId: providerThread.providerInstanceId,
                    targetProviderInstanceId: activeRun.providerInstanceId,
                    targetRunId: run.id,
                    status: "resolved_portable" as const,
                    resolution: {
                      strategy: "portable_context" as const,
                      contextHandoffId: failoverHandoff.handoff.id,
                    },
                    createdBy: "system" as const,
                    error: null,
                    createdAt: failoverHandoff.createdAt,
                    updatedAt: failoverHandoff.createdAt,
                    consumedAt: null,
                  },
                },
              ]),
          {
            id: yield* idAllocator.allocate.event(),
            type: "provider-session.updated",
            threadId: projection.thread.id,
            driver: session.driver,
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: now,
            payload: session.providerSession,
          },
          {
            id: yield* idAllocator.allocate.event(),
            type: "provider-thread.updated",
            threadId: projection.thread.id,
            driver: session.driver,
            providerInstanceId: activeRun.providerInstanceId,
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
                  providerInstanceId: activeRun.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...nativeForkTransfer,
                    targetProviderInstanceId: activeRun.providerInstanceId,
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
          {
            id: yield* idAllocator.allocate.event(),
            type: "run.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: now,
            payload: runningRun,
          },
          {
            id: yield* idAllocator.allocate.event(),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: now,
            payload: runningAttempt,
          },
          {
            id: yield* idAllocator.allocate.event(),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: activeRun.providerInstanceId,
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
          runFailoverStates.delete(runId);
          return undefined;
        }
        openedAlternateSessionId = null;
        runFailoverStates.delete(runId);
        const activeRunControls =
          runningProviderThread.id === providerThread.id
            ? runControls
            : makeRunControls({
                threadId: projection.thread.id,
                runId: run.id,
                attemptId: attempt.id,
                providerThreadId: runningProviderThread.id,
                runOrdinal: run.ordinal,
                inheritedBackgroundTurnItems,
              });
        return {
          session,
          userText,
          goalCommand,
          noteContinuation,
          restartNote,
          autoBriefed,
          effectiveHandoffs,
          handoffContext,
          retryHandoff,
          runningThread,
          runningProviderThread,
          runningRun,
          runningAttempt,
          runningRootNode,
          activeRunControls,
        };
      }).pipe(
        Effect.onExit(() =>
          detachOpenedAlternateSession("Detaching uncommitted failover session."),
        ),
      );
      if (committed === undefined) {
        return;
      }

      const {
        session,
        userText,
        goalCommand,
        noteContinuation,
        restartNote,
        autoBriefed,
        effectiveHandoffs,
        handoffContext,
        retryHandoff,
        runningThread,
        runningProviderThread,
        runningRun,
        runningAttempt,
        runningRootNode,
        activeRunControls,
      } = committed;
      const {
        sameNativeThread,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        budget,
      } = handoffContext;
      const routableSubagents = projection.subagents.filter((subagent) =>
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
              providerInstanceId: activeRun.providerInstanceId,
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
          const unsent = delivery.unsent.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to restore unsent context handoffs", { runId: run.id }),
            ),
          );
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          return {
            turnInput: {
              ...(noteContinuation ? promptedInput : turnInput),
              ...(autoBrief === null ? {} : { autoModeInstructions: autoBrief }),
              message: {
                ...turnInput.message,
                text: goalCommand ? userText : withInlineContext(context, userText),
              },
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
                providerThreadId: runningProviderThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: runningThread,
        providerSessionId: activeProviderSessionId,
        session,
        prepareTurn,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        loadInheritedBackgroundTurnItems: activeRunControls.loadInheritedBackgroundTurnItems,
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
              .filter((turn) => turn.providerThreadId === runningProviderThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: activeRunControls.shouldStartProviderTurn,
        shouldFinalizeRun: activeRunControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: activeRunControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: activeRunControls.loadRunInterruptReason,
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: activeRun.modelSelection,
        runtimePolicy: activeRuntimePolicy,
        // Only a start the adapter knows stopped before the prompt can be resent without running it twice.
        startFailure: (error) =>
          refusedBeforePrompt(error)
            ? Effect.map(input.waitDuringStart, (wait) => unstartedTurnFailure(error, wait))
            : Effect.succeed(makeProviderFailure({ cause: error, class: "provider_error" })),
      });
    });

    const adopt = Effect.fn("ProviderTurnStartService.adopt")(
      function* (input: { readonly threadId: ThreadId; readonly runId: RunId }) {
        const notAdoptable = (cause: string) =>
          new ProviderTurnStartError({ runId: input.runId, cause });
        const projection = yield* projectionStore.getTurnStartContext(input.threadId, input.runId);
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (run === undefined || run.status !== "running") {
          return yield* notAdoptable(`Run ${input.runId} is not running.`);
        }
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === run.providerThreadId,
        );
        const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
        const checkpointScope = projection.checkpointScopes.find(
          (candidate) => candidate.id === rootNode?.checkpointScopeId,
        );
        if (
          rootNode === undefined ||
          attempt === undefined ||
          providerThread === undefined ||
          providerThread.providerSessionId === null ||
          message === undefined ||
          checkpointScope === undefined
        ) {
          return yield* notAdoptable(`Run ${run.id} is missing its execution projection state.`);
        }
        const providerTurn = projection.providerTurns
          .filter(
            (turn) =>
              turn.runAttemptId === attempt.id &&
              turn.providerThreadId === providerThread.id &&
              turn.status === "running",
          )
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .at(-1);
        if (providerTurn?.nativeTurnRef == null) {
          return yield* notAdoptable(`Run ${run.id} has no running provider turn to take over.`);
        }
        const providerSessionId = providerThread.providerSessionId;
        const runtimePolicyResolved = yield* runtimePolicy
          .resolve({ thread: projection.thread, modelSelection: run.modelSelection, run })
          .pipe(Effect.mapError((cause) => new ProviderTurnStartError({ runId: run.id, cause })));
        const inheritedBackgroundTurnItems = yield* projectionStore
          .getRuntimeRecoveryProjection(projection.thread.id)
          .pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: current.thread.id,
                currentProviderThreadId: providerThread.id,
                currentRunOrdinal: run.ordinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
          );
        const runControls = makeRunControls({
          threadId: projection.thread.id,
          runId: run.id,
          attemptId: attempt.id,
          providerThreadId: providerThread.id,
          runOrdinal: run.ordinal,
          inheritedBackgroundTurnItems,
        });
        const existingSessionProjection = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const session = yield* providerSessions
          .open({
            threadId: projection.thread.id,
            providerSessionId,
            modelSelection: run.modelSelection,
            runtimePolicy: runtimePolicyResolved,
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
            adoptRunningProcess: true,
          })
          .pipe(Effect.mapError((cause) => new ProviderTurnStartError({ runId: run.id, cause })));
        if (session.adoptTurn === undefined) {
          yield* providerSessions.close(providerSessionId).pipe(
            Effect.ignore({
              log: "Error",
              message: "Could not close a provider session that cannot take over its turn.",
            }),
          );
          return yield* notAdoptable(`Provider ${session.driver} cannot take over a running turn.`);
        }
        const routableSubagents = projection.subagents.filter((subagent) =>
          RunExecutionService.canRouteRelatedSubagent(subagent.status),
        );
        yield* runExecution
          .startRootRun({
            commandId: CommandId.make(`command:effect:provider-turn.adopt:${run.id}`),
            appThread: projection.thread,
            providerSessionId,
            session,
            run,
            rootNode,
            checkpointScope,
            providerThread,
            attempt,
            attemptId: attempt.id,
            loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
            relatedThreadIds: routableSubagents.flatMap((subagent) =>
              subagent.childThreadId === null ? [] : [subagent.childThreadId],
            ),
            relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
              subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
            ),
            providerTurnOrdinal: providerTurn.ordinal,
            shouldStartProviderTurn: runControls.shouldStartProviderTurn,
            shouldFinalizeRun: runControls.shouldFinalizeRun,
            hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
            loadRunInterruptReason: runControls.loadRunInterruptReason,
            message: {
              messageId: message.id,
              text: message.text,
              attachments: message.attachments,
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
            runtimePolicy: runtimePolicyResolved,
            startFailure: (error) =>
              Effect.succeed(makeProviderFailure({ cause: error, class: "provider_error" })),
            adoptRunningTurn: {
              providerTurn,
              turnItems: projection.turnItems.filter(
                (item) => item.providerTurnId === providerTurn.id,
              ),
            },
          })
          .pipe(Effect.mapError((cause) => new ProviderTurnStartError({ runId: run.id, cause })));
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
      adopt,
      failUnstartedRun,
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          // The watch runs until the provider took the turn or refused it.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sinceWake = yield* awakeSinceWake;
              const afterWake = sinceWake !== undefined && sinceWake < AFTER_WAKE_START_MS;
              const waitDuringStart = Effect.map(yield* watchWait, (wait): StartWait => ({
                ...wait,
                afterWake,
              }));
              const starting = start({ ...input, waitDuringStart });
              const providerTurn = yield* thread.worktreePath === null
                ? starting
                : withWorkspaceLease(path.resolve(thread.worktreePath), starting);
              if (providerTurn !== undefined) yield* providerTurn;
            }),
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
    });
  }),
);
