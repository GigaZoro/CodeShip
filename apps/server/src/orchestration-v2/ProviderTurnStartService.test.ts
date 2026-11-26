import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSkillsTestkit from "../provider/ProviderSkills.testkit.ts";
import * as ProviderSkills from "../provider/ProviderSkills.ts";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  GitCommandError,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  ProjectId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { AwakeSinceWake } from "@t3tools/shared/AwakeTime";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { queueWorktreeRelease } from "../workspace/worktreeRelease.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { withInlineContext } from "./ContextHandoffDelivery.ts";
import {
  RESTART_RESEND_NOTE,
  type RestartRetryDelivery,
  restartCancelledBackgroundWorkNote,
  restartDelegatedTasksNote,
  restartRetryNoticeId,
} from "./RestartBackgroundNote.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAppendSystemPromptMissingValueError,
  ClaudeMcpRegistrationTimeoutError,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { ClaudeSettingsResolveError } from "../provider/Drivers/ClaudeSettingsCascade.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { sleepingTestClock } from "./testkit/DeterministicRuntime.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
const layerWorktreeLocation = (
  worktreesDir = managedWorktreesDir,
  skillFailure?: ProviderSkills.ProviderSkillInvocationError,
  pathLayer: Layer.Layer<Path.Path> = Path.layer,
) =>
  Layer.mergeAll(
    pathLayer,
    Layer.mock(ServerConfig.ServerConfig)({
      worktreesDir,
      stateDir: `${worktreesDir}/../state`,
    } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("codex-personal")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
        [ProviderInstanceId.make("codex-other")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
        [ProviderInstanceId.make("claude_work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
        },
      },
      autoModeModels: {
        [ProviderDriverKind.make("codex")]: {
          model: "gpt-review-custom",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
        [ProviderDriverKind.make("claudeAgent")]: {
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "max" }],
        },
      },
    }),
    skillFailure === undefined
      ? ProviderSkillsTestkit.layer
      : Layer.mock(ProviderSkills.ProviderSkills)({
          expandSkillMentions: () => Effect.fail(skillFailure),
        }),
  );

function startWithMissingWorktree(
  worktreePath: string,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    },
    runs: [
      {
        id: runId,
        status: "starting",
        modelSelection: { instanceId: ProviderInstanceId.make("codex-personal"), model: "gpt-5.4" },
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const listLocalBranchNames = vi.fn(() => Effect.succeed(["feature/restore"]));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees,
          createWorktree,
          listLocalBranchNames,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: () => projectionReadCount,
  };
}

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly worktreePath?: string;
  readonly worktreesDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly createdBy?: "agent" | "system";
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly skillFailure?: ProviderSkills.ProviderSkillInvocationError;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly resumeThread?: () => Effect.Effect<never>;
  readonly hostLoadPerCpu?: number;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly beforeOpenFailure?: () => void;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    /** `true` fails the interrupt; an object is the cause it fails with. */
    readonly interruptFailure?: true | { readonly status: number };
    readonly interruptCurrentRun?: boolean;
  };
  /**
   * A side chat whose context targets this run, an earlier run that failed or was cancelled before
   * the provider, or an earlier run that delivered it. `nativeForkFrom` plans a native fork of the
   * parent. `switchedProvider` puts the earlier run and its context on another provider thread.
   */
  readonly sideChat?: {
    readonly contextRun: "current" | "failed" | "cancelled" | "delivered";
    readonly nativeForkFrom?: "idle" | "busy";
    readonly switchedProvider?: boolean;
  };
  /** Opens a session and starts an ordinary provider turn, like a prompt. */
  readonly nativeTurn?: boolean;
  readonly autoAccount?: boolean;
  readonly quotaAwareAuto?: boolean;
  readonly otherAutoProvider?: boolean;
  readonly limitsReadFailure?: boolean;
  /** The thread is a delegated task's child. */
  readonly delegatedChild?: boolean;
  /** The thread is an assignment-isolated review. */
  readonly reviewAssignment?: boolean;
  /** A restart cut this run before its provider turn was recorded, and it starts again. */
  readonly restartRetry?: RestartRetryDelivery;
  /** The thread's provider session was already running when this turn started. */
  readonly sessionLive?: boolean;
  /** Account routing says this turn would spend prepaid credits the user did not allow it. */
  readonly creditRefusal?: AccountRouting.CreditRefusal;
}) {
  const settledRuns: Array<string> = [];
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: {
      instanceId: newInstanceId,
      model: "gpt-5.4",
      ...(input.autoAccount ? { autoAccount: true } : {}),
      ...(input.quotaAwareAuto ? { quotaAwareAuto: true } : {}),
    },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: input.createdBy ?? "user",
    creationSource: input.createdBy === undefined ? "web" : "mcp",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
      lineage: input.delegatedChild
        ? {
            parentThreadId: ThreadId.make("thread-parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("thread-parent"),
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      ...(input.reviewAssignment ? { reviewAssignment: { handle: "assignment-1" } } : {}),
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems:
      input.restartRetry === undefined
        ? []
        : [
            {
              id: restartRetryNoticeId(runId, 1, input.restartRetry),
              type: "system_notice",
              threadId,
              runId,
              nodeId: rootNodeId,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Message sent again",
              message: "T3.CodeShip restarted, so it sent this message again.",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          ],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const parentThreadId = ThreadId.make("side-chat-parent");
  const parentRunId = RunId.make("side-chat-parent-run");
  const parentProviderThread = {
    ...providerThread,
    id: ProviderThreadId.make("side-chat-parent-provider-thread"),
    appThreadId: parentThreadId,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-parent-native",
      strength: "strong" as const,
    },
  };
  const parentRecords = {
    ...projection,
    thread: { ...projection.thread, id: parentThreadId },
    runs: [
      {
        ...run,
        id: parentRunId,
        threadId: parentThreadId,
        ordinal: 1,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: null,
        status: "completed" as const,
        completedAt: now,
      },
      ...(input.sideChat?.nativeForkFrom === "busy"
        ? [
            {
              ...run,
              id: RunId.make("side-chat-parent-busy-run"),
              threadId: parentThreadId,
              ordinal: 2,
              providerThreadId: parentProviderThread.id,
              status: "running" as const,
            },
          ]
        : []),
    ],
    providerThreads: [parentProviderThread],
    attempts: [],
    providerTurns: [],
    turnItems: [],
  };
  if (input.sideChat !== undefined) {
    const earlierRunId = RunId.make("side-chat-earlier-run");
    projection = {
      ...projection,
      thread: {
        ...projection.thread,
        runtimeMode: "full-access",
        lineage: {
          parentThreadId,
          relationshipToParent: "fork",
          rootThreadId: parentThreadId,
          sideChat: true,
        },
      },
      runs:
        input.sideChat.contextRun === "current"
          ? projection.runs
          : [
              {
                ...run,
                id: earlierRunId,
                ordinal: 1,
                userMessageId: MessageId.make("side-chat-earlier-message"),
                activeAttemptId: RunAttemptId.make("side-chat-earlier-attempt"),
                ...(input.sideChat.switchedProvider
                  ? { providerThreadId: oldProviderThreadId }
                  : {}),
                status:
                  input.sideChat.contextRun === "delivered"
                    ? "completed"
                    : input.sideChat.contextRun,
                completedAt: now,
              },
              run,
            ],
      contextTransfers:
        input.sideChat.nativeForkFrom === undefined
          ? []
          : [
              {
                id: ContextTransferId.make("side-chat-fork"),
                type: "fork",
                sourceThreadId: parentThreadId,
                targetThreadId: threadId,
                sourcePoint: { threadId: parentThreadId, runId: parentRunId },
                basePoint: null,
                sourceProviderInstanceId: newInstanceId,
                targetProviderInstanceId: newInstanceId,
                targetRunId: runId,
                status: "pending",
                resolution: null,
                createdBy: "user",
                error: null,
                createdAt: now,
                updatedAt: now,
                consumedAt: null,
              },
            ],
      contextHandoffs: [
        {
          id: ContextHandoffId.make("side-chat-context"),
          transferId: ContextTransferId.make("side-chat-fork"),
          threadId,
          targetRunId: input.sideChat.contextRun === "current" ? runId : earlierRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.sideChat.switchedProvider
            ? oldProviderThreadId
            : providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "SIDE_CHAT_CONTEXT",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
          ...(input.sideChat.contextRun === "delivered"
            ? {
                delivery: {
                  nativeThreadId: "side-chat-native",
                  status: "inline" as const,
                  itemIds: [],
                },
              }
            : {}),
        },
      ],
    };
  }
  const resumesNativeThread =
    "historyReadFailureAfterFallback" in input || input.resumeThread !== undefined;
  if (resumesNativeThread) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const previousTurnId = ProviderTurnId.make("previous-provider-turn");
  if (input.previousTurn !== undefined) {
    const previousRunId = RunId.make("previous-failed-run");
    const previousAttemptId = RunAttemptId.make("previous-failed-attempt");
    const previousProviderThreadId = input.previousTurn.differentThread
      ? oldProviderThreadId
      : providerThreadId;
    projection = {
      ...projection,
      runs: [
        {
          ...run,
          id: previousRunId,
          ordinal: 1,
          status: input.previousTurn.runStatus,
          rootNodeId: NodeId.make("previous-root"),
          activeAttemptId: previousAttemptId,
          providerThreadId: previousProviderThreadId,
          completedAt: now,
        },
        run,
      ],
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "existing-native-conversation",
            strength: "strong",
          },
        },
      ],
      providerTurns: [
        {
          id: previousTurnId,
          providerThreadId: previousProviderThreadId,
          nodeId: NodeId.make("previous-root"),
          runAttemptId: previousAttemptId,
          ordinal: 1,
          nativeTurnRef: null,
          status: input.previousTurn.turnStatus,
          startedAt: now,
          completedAt: input.previousTurn.turnStatus === "running" ? null : now,
        },
      ],
      turnItems: [
        ...projection.turnItems,
        {
          id: TurnItemId.make("previous-tool-call"),
          type: "dynamic_tool",
          threadId,
          runId: previousRunId,
          nodeId: NodeId.make("previous-root"),
          providerThreadId: previousProviderThreadId,
          providerTurnId: previousTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Hand off to a worktree",
          toolName: "mcp__t3-code__t3_worktree_handoff",
          input: {},
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      ],
    };
  }
  let providerBusy =
    input.previousTurn?.runStatus === "failed" &&
    input.previousTurn.turnStatus === "running" &&
    !input.previousTurn.differentThread &&
    input.previousTurn.liveSession !== false;
  const interruptTurn = vi.fn((request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
    Effect.gen(function* () {
      expect(request.providerTurnId).toBe(previousTurnId);
      expect(request.providerThread.id).toBe(providerThreadId);
      if (input.previousTurn?.interruptFailure) {
        return yield* new ProviderAdapter.ProviderAdapterInterruptError({
          driver: providerThread.driver,
          providerThreadId,
          providerTurnId: request.providerTurnId,
          cause:
            input.previousTurn.interruptFailure === true
              ? "provider interrupt failed"
              : input.previousTurn.interruptFailure,
        });
      }
      providerBusy = false;
      if (input.previousTurn?.interruptCurrentRun) interruptRun();
    }),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const freshThread = vi.fn(() => Effect.succeed(providerThread));
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread:
      input.resumeThread ??
      (() =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: "native thread is gone",
          }),
        )),
    ensureThread: freshThread,
  };
  const providerSession = {
    id: providerSessionId,
    driver: providerThread.driver,
    providerInstanceId: newInstanceId,
    status: "ready",
    cwd: "/tmp/native-account-command",
    model: null,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const startTurn = vi.fn((_turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.void);
  const sideChatThread = {
    ...providerThread,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-native",
      strength: "strong" as const,
    },
  };
  const forkThread = vi.fn(() => Effect.succeed(sideChatThread));
  const sideChatSession = {
    driver: providerThread.driver,
    providerSession,
    ensureThread: () => Effect.succeed(sideChatThread),
    resumeThread: () => Effect.succeed(sideChatThread),
    forkThread,
    startTurn,
  };
  const releaseIfSilent = vi.fn<
    ProviderSessionManager.ProviderSessionManagerV2Shape["releaseIfSilent"]
  >(() => Effect.succeed(true));
  const open = vi.fn(() =>
    input.sideChat !== undefined
      ? Effect.succeed(sideChatSession as never)
      : input.nativeTurn === true
        ? Effect.succeed({
            driver: providerThread.driver,
            providerSession,
            ensureThread: () => Effect.succeed(providerThread),
            resumeThread: () => Effect.succeed(providerThread),
            startTurn,
          } as never)
        : input.interruptOpen === true
          ? Effect.interrupt
          : resumesNativeThread
            ? Effect.succeed(resumeFallbackSession as never)
            : "ensureThreadFailure" in input
              ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
              : "openFailure" in input
                ? Effect.sync(() => {
                    if (input.interruptRunBeforeOpenFailure === true) interruptRun();
                    input.beforeOpenFailure?.();
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ProviderSessionManager.ProviderSessionOpenError({
                          instanceId: newInstanceId,
                          providerSessionId,
                          cause: input.openFailure,
                        }),
                      ),
                    ),
                  )
                : input.failReadsAfterRunning === true || input.previousTurn !== undefined
                  ? Effect.succeed({
                      driver: providerThread.driver,
                      providerSession,
                      ensureThread: () => Effect.succeed(providerThread),
                      resumeThread: () => Effect.succeed(projection.providerThreads[0]),
                    } as never)
                  : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >((runInput) =>
    input.sideChat !== undefined || input.nativeTurn === true
      ? Effect.gen(function* () {
          const turn = yield* runInput.prepareTurn!(
            {
              ...runInput,
              ...(runInput.run.restartContinuationOfRunId === undefined
                ? {}
                : { restartContinuationOfRunId: runInput.run.restartContinuationOfRunId }),
            } as never,
            false,
          );
          yield* runInput.session
            .startTurn(turn.turnInput)
            .pipe(Effect.tapError(turn.notAccepted), Effect.andThen(turn.accepted));
        }).pipe(Effect.orDie)
      : input.failReadsAfterRunning === true || input.previousTurn !== undefined
        ? Effect.suspend(() =>
            providerBusy ? Effect.die("The previous provider turn is still running.") : Effect.void,
          )
        : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    "writeFailure" in input
      ? Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: input.writeFailure,
          }),
        )
      : Effect.sync(() => {
          const current = projection.runs.find((candidate) => candidate.id === runId);
          const committed =
            current !== undefined &&
            current.activeAttemptId === activeAttemptId &&
            current.status === expectedStatus;
          if (committed) {
            for (const event of incoming) {
              expect(isDomainEvent(event)).toBe(true);
              events.push(event);
              projection = ProjectionStore.applyToProjection(projection, event);
            }
          }
          return { committed, storedEvents: [] };
        }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({
        cwd: thread.worktreePath ?? "/tmp/native-account-command",
        runtimeMode: thread.runtimeMode,
      } as never),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(() =>
    Effect.succeed({} as never),
  );
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>((id) =>
    Effect.succeed(id === parentThreadId ? parentRecords : projection),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: (handoff) =>
            input.sideChat?.nativeForkFrom === undefined
              ? Effect.die("history read must fail first")
              : Effect.succeed({
                  ...handoff,
                  id: ContextHandoffId.make("side-chat-fork-context"),
                  createdByProviderInstanceId: handoff.toProviderInstanceId,
                  status: "ready",
                  summaryMessageId: null,
                  summaryText: "PARENT_HISTORY",
                  updatedAt: handoff.createdAt,
                }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        layerWorktreeLocation(input.worktreesDir, input.skillFailure, NodePath.layer),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(
            input.otherAutoProvider
              ? [
                  ...["codex-personal", "codex-other"].map((id) => ({
                    instanceId: ProviderInstanceId.make(id),
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    installed: true,
                    version: null,
                    status: "ready" as const,
                    auth: { status: "authenticated" as const },
                    checkedAt: "2026-11-08T00:00:00Z",
                    slashCommands: [],
                    skills: [],
                    models: (id === "codex-personal"
                      ? ["gpt-review-custom", "gpt-own-model"]
                      : ["gpt-unreachable-account"]
                    ).map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
                  })),
                  {
                    instanceId: ProviderInstanceId.make("claude_work"),
                    driver: ProviderDriverKind.make("claudeAgent"),
                    displayName: "Work Claude",
                    enabled: true,
                    installed: true,
                    version: null,
                    status: "ready",
                    auth: { status: "authenticated" },
                    checkedAt: "2026-11-08T00:00:00.000Z",
                    models: [
                      {
                        slug: "legacy",
                        name: "Legacy",
                        isLegacy: true,
                        isCustom: false,
                        capabilities: null,
                      },
                      {
                        slug: "claude-opus-5-5",
                        name: "Opus",
                        capabilities: {
                          optionDescriptors: [
                            {
                              id: "effort",
                              label: "Effort",
                              type: "select",
                              options: [
                                { id: "high", label: "High" },
                                { id: "max", label: "Max" },
                              ],
                            },
                          ],
                        },
                        isCustom: false,
                      },
                    ],
                    slashCommands: [],
                    skills: [],
                  },
                ]
              : [],
          ),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([ProviderInstanceId.make("claude_work")]),
        }),
        input.creditRefusal === undefined
          ? Layer.empty
          : Layer.mock(AccountRouting.AccountRouting)({
              creditRefusal: () => Effect.succeed(input.creditRefusal ?? null),
            }),
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        input.gitWorkflow === undefined
          ? Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees: () => Effect.void,
              listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
              createWorktree,
            })
          : Layer.succeed(GitWorkflow.GitWorkflowService, input.gitWorkflow),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              workspaceRoot: input.workspaceRoot ?? "/tmp/native-account-project",
            } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getUsageLimitedProviderInstances: () =>
            input.limitsReadFailure
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreSetupError({
                    cause: new Error("database unavailable"),
                  }),
                )
              : Effect.succeed(new Map()),
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            input.sideChat !== undefined
              ? Effect.succeed([])
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: input.historyReadFailureAfterFallback,
                  }),
                ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          releaseIfSilent,
          isLive: () => Effect.succeed(input.sessionLive === true),
          get: () =>
            Effect.succeed(
              input.previousTurn?.liveSession === false
                ? Option.none()
                : Option.some({
                    driver: providerThread.driver,
                    providerSessionId,
                    interruptTurn,
                  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
            ),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: (report) => Effect.sync(() => void settledRuns.push(report.status)),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
      ),
    ),
  );
  return {
    settledRuns,
    getThreadRecords,
    getTurnStartContext,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    releaseIfSilent,
    writeIfRunCurrent,
    startRootRun,
    startTurn,
    freshThread,
    forkThread,
    interruptTurn,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    providerSessionId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        ProviderTurnStart.HostLoadPerCpu,
        Effect.succeed(input.hostLoadPerCpu ?? 0),
      ),
    ),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect(
  "recovers the local or pushed thread tip, else the current branch, remote default, or detached HEAD",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-recreate-repo-" });
      const workspaceRoot = path.join(root, "project");
      const originRoot = path.join(root, "origin.git");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      yield* fileSystem.makeDirectory(workspaceRoot);
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        driver
          .execute({ operation: "test.worktreeRecovery", cwd, args })
          .pipe(Effect.map((result) => result.stdout.trim()));
      const branchConfig = (key: string) =>
        git(workspaceRoot, ["config", "--get", `branch.feature/restore.${key}`]).pipe(
          Effect.orElseSucceed(() => ""),
        );
      yield* git(root, ["init", "--bare", "-b", "main", originRoot]);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "base"]);
      const baseTip = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      yield* git(workspaceRoot, ["remote", "add", "origin", originRoot]);
      yield* git(workspaceRoot, ["push", "origin", "main"]);
      yield* git(workspaceRoot, ["remote", "set-head", "origin", "main"]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", "feature/restore", worktreePath]);
      yield* fileSystem.writeFileString(path.join(worktreePath, "thread.txt"), "thread work");
      yield* git(worktreePath, ["add", "."]);
      yield* git(worktreePath, ["commit", "-m", "thread tip"]);
      const threadTip = yield* git(worktreePath, ["rev-parse", "HEAD"]);
      yield* git(workspaceRoot, ["switch", "-c", "project-current"]);
      yield* fileSystem.writeFileString(
        path.join(workspaceRoot, "project.txt"),
        "new project code",
      );
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "project tip"]);
      const projectTip = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      expect(projectTip).not.toBe(threadTip);
      // Tags must neither hide the thread branch nor select a different recovery tip.
      yield* git(workspaceRoot, ["tag", "feature/restore", projectTip]);
      yield* git(workspaceRoot, ["tag", "project-current", threadTip]);
      yield* git(workspaceRoot, ["tag", "origin/feature/restore", threadTip]);

      const expectedTips = {
        retained: { tip: threadTip, file: "thread.txt", upstream: null, base: "" },
        released: { tip: projectTip, file: "project.txt", upstream: null, base: "" },
        deleted: { tip: projectTip, file: "project.txt", upstream: null, base: "project-current" },
        pushed: {
          tip: threadTip,
          file: "thread.txt",
          upstream: "refs/remotes/origin/feature/restore",
          base: "",
        },
        "pushed-detached": {
          tip: threadTip,
          file: "thread.txt",
          upstream: "refs/remotes/origin/feature/restore",
          base: "",
        },
        detached: { tip: baseTip, file: null, upstream: null, base: "main" },
        "detached-no-remote": { tip: projectTip, file: "project.txt", upstream: null, base: "" },
      } as const;
      // Reuse the workflow across turns so recovery cannot select a cached project branch.
      for (const scenario of Object.keys(expectedTips) as Array<keyof typeof expectedTips>) {
        const expected = expectedTips[scenario];
        if (scenario === "pushed") {
          yield* git(workspaceRoot, ["push", "origin", `${threadTip}:refs/heads/feature/restore`]);
          yield* git(workspaceRoot, ["fetch", "origin"]);
        }
        if (scenario === "pushed-detached") {
          yield* git(workspaceRoot, ["switch", "--detach"]);
          expect(yield* git(workspaceRoot, ["branch", "--show-current"])).toBe("");
        }
        if (scenario === "detached") {
          yield* git(workspaceRoot, ["push", "origin", "--delete", "feature/restore"]);
        }
        if (scenario === "detached-no-remote") {
          yield* git(workspaceRoot, ["remote", "remove", "origin"]);
        }
        if (scenario === "released") {
          yield* git(worktreePath, ["reset", "--hard", baseTip]);
          const { file: request } = yield* queueWorktreeRelease({
            threadId: "thread-native-account-command",
            runId: "finished",
            worktreePath,
            durableRef: "refs/heads/project-current",
            stateDir: path.join(root, "state"),
          });
          yield* fileSystem.rename(request, request + ".released");
        }
        yield* fileSystem.remove(worktreePath, { recursive: true });
        if (scenario !== "retained" && scenario !== "released") {
          yield* git(workspaceRoot, ["worktree", "prune"]);
          yield* git(workspaceRoot, ["branch", "-D", "feature/restore"]);
        }
        const harness = makeLocalCommandHarness({
          text: "Continue",
          workspaceRoot,
          worktreePath,
          worktreesDir,
          fileSystem,
          gitWorkflow,
          failReadsAfterRunning: true,
        });
        const open = harness.open.getMockImplementation()!;
        harness.open.mockImplementation(() =>
          Effect.gen(function* () {
            expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature/restore");
            expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(expected.tip);
            for (const file of ["thread.txt", "project.txt"]) {
              expect(yield* fileSystem.exists(path.join(worktreePath, file))).toBe(
                file === expected.file,
              );
            }
            expect(yield* branchConfig("merge")).toBe(
              expected.upstream === null ? "" : "refs/heads/feature/restore",
            );
            if (expected.upstream !== null) {
              expect(
                yield* git(worktreePath, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
              ).toBe(expected.upstream);
            }
            expect(yield* branchConfig("t3-merge-base")).toBe(expected.base);
            return yield* open();
          }).pipe(Effect.orDie),
        );

        yield* harness.start;

        expect(harness.open).toHaveBeenCalledOnce();
        expect(harness.startRootRun).toHaveBeenCalledWith(
          expect.objectContaining({
            runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
          }),
        );
        expect(harness.projection().runs.at(-1)?.status).toBe("running");
      }
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

effectIt.effect(
  "preserves recreation interrupts and retries, then fails the final attempt before provider start",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-recreate-failure-",
      });
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreesDir,
        worktreePath,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementationOnce(() => Effect.interrupt);
      harness.createWorktree.mockImplementation(() =>
        Effect.fail(
          new GitCommandError({
            operation: "worktree-add",
            command: "git worktree add",
            cwd: "/tmp/native-account-project",
            detail: "fatal: private git diagnostic",
          }),
        ),
      );

      const interrupted = yield* Effect.exit(harness.start);
      expect(interrupted._tag).toBe("Failure");
      if (interrupted._tag === "Failure")
        expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      expect(harness.events).toEqual([]);
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");

      const retry = yield* Effect.result(harness.startWithRetry);
      expect(retry).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderTurnStartError" } });
      expect(harness.events).toEqual([]);
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");

      yield* harness.start;
      expect(harness.createWorktree).toHaveBeenCalledTimes(3);
      expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          failure: {
            message: `Could not recreate the worktree for branch 'feature/restore' at ${worktreePath}.`,
          },
        },
      ]);
      expect(JSON.stringify(harness.events)).not.toContain("private git diagnostic");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    // The restarted runtime can never report the end of the tool call the failed run left open.
    expect(
      harness.projection().turnItems.find((item) => item.id === "previous-tool-call"),
    ).toMatchObject({ status: "interrupted", completedAt: expect.anything() });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect.each([
  { contextRun: "current", runtimeMode: "approval-required", context: "SIDE_CHAT_CONTEXT" },
  { contextRun: "failed", runtimeMode: "approval-required", context: "SIDE_CHAT_CONTEXT" },
  { contextRun: "cancelled", runtimeMode: "approval-required", context: "SIDE_CHAT_CONTEXT" },
  {
    contextRun: "failed",
    switchedProvider: true,
    runtimeMode: "approval-required",
    context: "SIDE_CHAT_CONTEXT",
  },
  { contextRun: "delivered", runtimeMode: "full-access", context: "" },
] as const)(
  "sends side chat context inline once, for the first turn that reaches the provider: %j",
  ({ runtimeMode, context, ...sideChat }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "What is the main thread doing?",
        sideChat,
      });

      yield* harness.start;

      // The turn that delivers the context is clamped; a later one follows the thread's mode.
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({ runtimePolicy: expect.objectContaining({ runtimeMode }) }),
      );
      expect(harness.startTurn.mock.calls.map(([turn]) => turn.message.text)).toEqual([
        withInlineContext(context, "What is the main thread doing?"),
      ]);
      expect(harness.projection().contextHandoffs).toMatchObject([
        {
          id: "side-chat-context",
          toProviderThreadId: "new-provider-thread",
          delivery: { nativeThreadId: "side-chat-native", status: "inline" },
        },
      ]);
    }),
);

effectIt.effect.each([
  { restartRetry: "unsent", note: "" },
  { restartRetry: "unconfirmed", note: RESTART_RESEND_NOTE },
] as const)(
  "warns the agent when a restart may have sent this message already: %j",
  ({ restartRetry, note }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Rebase onto main",
        nativeTurn: true,
        restartRetry,
      });

      yield* harness.start;

      expect(harness.startTurn.mock.calls.map(([turn]) => turn.message.text)).toEqual([
        withInlineContext(note, "Rebase onto main"),
      ]);
    }),
);

effectIt.effect.each([
  { told: true },
  // A session that was already running may drain what it buffered instead of sending this text.
  { wake: true, sessionLive: true, told: false },
  { wake: true, sessionLive: false, told: true },
  // A wake's text was written before this work was recorded.
  { continues: "lost-work", told: true },
  // A turn that only resumes may send no text at all.
  { continues: "cut-turn", told: false, resumesNatively: true },
  // Its agent learns the ids of the delegated tasks its cut turn started only from this text.
  { continues: "cut-turn", delegatedTasks: true, told: true },
] as const)(
  "tells its agent the background work a closing session recorded while this one opened: %j",
  ({ told, ...turn }) =>
    Effect.gen(function* () {
      const text = !("continues" in turn)
        ? "Is the build done?"
        : "delegatedTasks" in turn
          ? `${restartDelegatedTasksNote([
              {
                id: NodeId.make("node:delegated-task:cut"),
                childThreadId: ThreadId.make("thread:delegated-task:cut"),
                title: "Fix the build",
                prompt: "Fix the build",
                status: "running",
              },
            ])}\n\n${CONTINUE_PROMPT}`
          : CONTINUE_PROMPT;
      const harness = makeLocalCommandHarness({
        text,
        nativeTurn: true,
        sessionLive: "sessionLive" in turn && turn.sessionLive,
      });
      const seeded = harness.projection();
      const current = seeded.runs[0]!;
      const earlier = {
        ...current,
        id: RunId.make("run-lost-work"),
        ordinal: 1,
        userMessageId: MessageId.make("message-lost-work"),
        activeAttemptId: RunAttemptId.make("attempt-lost-work"),
        status: "completed" as const,
        completedAt: seeded.updatedAt,
      };
      const cut = { ...earlier, id: RunId.make("run-cut"), status: "cancelled" as const };
      const continues = "continues" in turn ? turn.continues : undefined;
      harness.setProjection({
        ...seeded,
        runs: [
          earlier,
          cut,
          {
            ...current,
            ...(continues === undefined
              ? {}
              : { restartContinuationOfRunId: continues === "cut-turn" ? cut.id : earlier.id }),
          },
        ],
        messages: seeded.messages.map((message) => ({
          ...message,
          ...("wake" in turn || continues !== undefined ? { createdBy: "agent" as const } : {}),
          ...("wake" in turn ? { creationSource: "provider" as const } : {}),
        })),
      });
      const work = [
        { kind: "shell" as const, label: "vp run build (id build)", id: "build" },
      ] as const;
      const openSession = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.suspend(() => {
          const opening = harness.projection();
          harness.setProjection({
            ...opening,
            runs: opening.runs.map((run) =>
              run.id === earlier.id ? { ...run, restartCancelledBackgroundWork: work } : run,
            ),
          });
          return openSession();
        }),
      );

      yield* harness.start;

      expect(
        harness.startTurn.mock.calls.map(([sent]) => [
          sent.message.text,
          sent.restartContinuationOfRunId,
        ]),
      ).toEqual([
        [
          withInlineContext(told ? restartCancelledBackgroundWorkNote(work) : "", text),
          "resumesNatively" in turn ? cut.id : undefined,
        ],
      ]);
      expect(
        harness.projection().attempts.find((attempt) => attempt.id === harness.attemptId)
          ?.backgroundWorkNote,
      ).toEqual(told ? [{ runId: earlier.id, work: ["id:build"] }] : []);
    }),
);

effectIt.effect.each([
  { autoAccount: true, text: "Add a retry to the upload client", briefed: true },
  {
    autoAccount: true,
    text: "Continue despite advisory read failure",
    limitsReadFailure: true,
    briefed: true,
  },
  {
    autoAccount: true,
    otherAutoProvider: true,
    text: "Add a retry to the upload client",
    briefed: true,
  },
  {
    autoAccount: false,
    otherAutoProvider: true,
    text: "Add a retry to the upload client",
    briefed: false,
  },
  { autoAccount: true, delegatedChild: true, text: "Add a retry", briefed: false },
] as const)(
  "briefs Auto's coordinator only on a top-level Auto prompt: %j",
  ({ briefed, ...turn }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ ...turn, nativeTurn: true });

      yield* harness.start;

      const sent = harness.startTurn.mock.calls[0]?.[0].autoModeInstructions ?? "";
      expect(sent.includes("Auto: coordinate")).toBe(briefed);
      expect(sent).not.toContain("<t3_auto_mode>");
      if (briefed && "otherAutoProvider" in turn) {
        expect(sent).toContain("gpt-review-custom, reasoningEffort ultra");
        expect(sent).toContain('"model":"claude-opus-5-5","options":{"effort":"max"}');
        expect(sent).toContain("Claude via `delegate_task`");
        expect(sent).toContain('{"providerInstanceId":"claude_work","model":"<slug>"');
        expect(sent).toContain(
          "\n  - Opus (`claude-opus-5-5`): hardest design, subtle bugs, reviews",
        );
        expect(sent).not.toContain("Legacy");
        expect(sent).toContain("gpt-own-model");
        expect(sent).not.toContain("gpt-unreachable-account");
      } else {
        expect(sent).not.toContain("delegate_task");
      }
      expect(harness.startTurn.mock.calls[0]?.[0].message.text.endsWith(turn.text)).toBe(true);
    }),
);

effectIt.effect.each([
  { nativeForkFrom: "idle", forks: true, transferStatus: "consumed", handoffIds: [] },
  {
    nativeForkFrom: "busy",
    forks: false,
    transferStatus: "resolved_portable",
    handoffIds: ["side-chat-fork-context"],
  },
] as const)(
  "runs a planned native side chat fork when the parent is $nativeForkFrom",
  ({ nativeForkFrom, forks, transferStatus, handoffIds }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "What is the main thread doing?",
        sideChat: { contextRun: "current", nativeForkFrom },
      });

      yield* harness.start;

      expect(harness.forkThread).toHaveBeenCalledTimes(forks ? 1 : 0);
      expect(harness.projection().contextTransfers).toMatchObject([
        { id: "side-chat-fork", status: transferStatus },
      ]);
      expect(harness.startTurn.mock.calls[0]?.[0].message.text.includes("PARENT_HISTORY")).toBe(
        !forks,
      );
      expect(harness.projection().providerThreads[0]?.handoffIds).toEqual(handoffIds);
    }),
);

effectIt.effect.each([
  { runStatus: "failed", turnStatus: "completed" },
  { runStatus: "completed", turnStatus: "completed" },
  { runStatus: "failed", turnStatus: "running", differentThread: true },
  { runStatus: "failed", turnStatus: "running", liveSession: false },
  { runStatus: "failed", turnStatus: "interrupted", interruptFailure: true },
] as const)("continues without interrupting when recovery does not apply: %j", (previousTurn) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", previousTurn });

    yield* harness.start;

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
  }),
);

effectIt.effect("does not start another turn when abandoned-turn cleanup fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect.each([
  { case: "a failure", interruptFailure: true, status: "starting" },
  // A retry meets the same refusal, so the run fails now instead of after every retry.
  { case: "a refused account", interruptFailure: { status: 403 }, status: "failed" },
] as const)(
  "retries abandoned-turn cleanup after $case only when a retry can help",
  ({ interruptFailure, status }) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure },
      });

      const retry = yield* Effect.result(harness.startWithRetry);

      expect(retry._tag).toBe(status === "starting" ? "Failure" : "Success");
      expect(harness.projection().runs.at(-1)?.status).toBe(status);
      expect(harness.open).not.toHaveBeenCalled();
    }),
);

effectIt.effect("does not start the continuation if recording recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.projection().providerTurns[0]?.status).toBe("running");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not resume a continuation stopped while recovery was in flight", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptCurrentRun: true },
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect.each(["cleanup-first", "startup-first"])(
  "coordinates provider startup with %s",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const worktreePath = path.join(workspaceRoot, "project", "worktree");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        worktreesDir: workspaceRoot,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(() =>
        fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
      );
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.gen(function* () {
          expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
          yield* Deferred.succeed(openEntered, undefined);
          if (order === "startup-first") yield* Deferred.await(release);
          return yield* open();
        }),
      );
      let cleanupEntered = false;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          else {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") expect(harness.open).not.toHaveBeenCalled();
      if (order === "startup-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "startup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "startup-first") expect(cleanupEntered).toBe(false);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      yield* Fiber.join(startup);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      if (order === "cleanup-first") {
        expect(harness.createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/native-account-project",
          refName: "feature/restore",
          path: worktreePath,
        });
      }
      expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({ worktreePath }),
        }),
      );
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appThread: expect.objectContaining({ worktreePath }),
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("reads current startup state after waiting for the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    harness.getThreadRecords.mockImplementationOnce(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(harness.projection())),
    );
    // The service keys its lease by the resolved path, which gains a drive letter on Windows.
    const resolvedPath = (yield* Path.Path).resolve(worktreePath);
    const holder = yield* withWorkspaceLease(resolvedPath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(readEntered);
    expect(harness.getTurnStartContext).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(startup);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(NodePath.layer)),
);

// regression: #15784 superseded provider startups kept running
effectIt.effect.each([
  { boundary: "policy resolution", loss: "replaced" },
  { boundary: "session opening", loss: "interrupted" },
])("does not continue startup when $loss during $boundary", ({ boundary, loss }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    const providerThread = projection.providerThreads[0]!;
    const ensureThread = vi.fn(() => Effect.succeed(providerThread));
    const resumeThread = vi.fn(() => Effect.succeed(providerThread));
    const forkThread = vi.fn(() => Effect.succeed(providerThread));
    harness.open.mockReturnValue(
      (boundary === "session opening" ? gate : Effect.void).pipe(
        Effect.as({
          driver: providerThread.driver,
          ensureThread,
          resumeThread,
          forkThread,
        } as never),
      ),
    );
    if (boundary === "policy resolution") {
      harness.resolveRuntimePolicy.mockReturnValue(
        gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
      );
    }

    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const current = harness.projection();
    const replacementId = RunAttemptId.make("replacement-attempt");
    const updated = {
      ...current,
      runs: current.runs.map((candidate) =>
        loss === "replaced"
          ? { ...candidate, activeAttemptId: replacementId }
          : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
      ),
      attempts:
        loss === "replaced"
          ? [...current.attempts, { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 }]
          : current.attempts,
    };
    harness.setProjection(updated);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(startup);

    expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
    expect(ensureThread).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled();
    expect(forkThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.projection()).toEqual(updated);
  }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect.each(["unavailable", "tooLarge"] as const)(
  "settles a shared skill %s failure before starting the model",
  (reason) =>
    Effect.gen(function* () {
      const skillFailure = new ProviderSkills.ProviderSkillInvocationError({
        skillName: "review",
        reason,
      });
      const harness = makeLocalCommandHarness({ text: "$review", nativeTurn: true, skillFailure });
      yield* harness.start;
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          title: "Shared skill could not be loaded",
          failure: { message: skillFailure.message },
        },
      ]);
    }),
);

effectIt.effect("starts a restricted review without loading a shared skill", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "$review",
      nativeTurn: true,
      reviewAssignment: true,
      skillFailure: new ProviderSkills.ProviderSkillInvocationError({
        skillName: "review",
        reason: "unavailable",
      }),
    });
    yield* harness.start;
    expect(harness.startRootRun).toHaveBeenCalledTimes(1);
    expect(harness.projection().turnItems).not.toContainEqual(
      expect.objectContaining({ title: "Shared skill could not be loaded" }),
    );
  }),
);

effectIt.effect(
  "passes guest skill mentions as plain text without loading the owner's skills",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Explain $review",
        nativeTurn: true,
        skillFailure: new ProviderSkills.ProviderSkillInvocationError({
          skillName: "review",
          reason: "unavailable",
        }),
      });
      harness.resolveRuntimePolicy.mockReturnValue(
        Effect.succeed({ cwd: "/tmp/native-account-command", readOnlyGuestShare: true } as never),
      );
      yield* harness.start;
      expect(harness.startTurn.mock.calls.map(([turn]) => turn.message.text)).toEqual([
        "Explain $review",
      ]);
    }),
);

effectIt.effect.each([
  {
    message: "DESCRIPTION is not valid ACP JSON",
    pause: undefined,
    sinceWakeMs: undefined,
    class: "provider_error",
    code: null,
  },
  {
    message: "getaddrinfo ENOTFOUND api.anthropic.com",
    pause: undefined,
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  // Under a wrapper whose own text does not name the lost connection.
  {
    message: "Provider session failed",
    cause: "getaddrinfo ENOTFOUND api.anthropic.com",
    pause: undefined,
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  // A provider's own wall-clock deadline that expired while the computer slept.
  {
    message: "MCP server initialization timed out",
    pause: "sleep",
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  // Or while the server, which the provider's MCP tools call, was stalled.
  {
    message: "MCP server initialization timed out",
    pause: "stall",
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
    shown:
      "MCP server initialization timed out. The server stalled while this turn started. Its stalls are logged to event-loop-stalls.ndjson in the server's logs folder, ~/.t3/userdata/logs by default.",
  },
  // A start right after a wake, before the network and sign-ins are back.
  {
    message: "DESCRIPTION is not valid ACP JSON",
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  {
    message: "DESCRIPTION is not valid ACP JSON",
    pause: undefined,
    sinceWakeMs: 10 * 60_000,
    class: "provider_error",
    code: null,
  },
  // Only the user can fix a refusal, so a wake does not make it worth another try.
  {
    message:
      "This thread's workspace folder no longer exists or is not a directory: /gone. Restore the folder at this path before retrying.",
    missingWorkspace: "/gone",
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "provider_error",
    code: null,
  },
] as const)(
  "terminalizes a starting run when its provider session cannot open: $message after $pause, $sinceWakeMs ms after a wake",
  (row) =>
    Effect.gen(function* () {
      const mac = yield* sleepingTestClock;
      const { pause } = row;
      const harness = makeLocalCommandHarness({
        text: "Continue",
        openFailure:
          "missingWorkspace" in row
            ? new ProviderWorkspaceMissingError({ threadId: "thread", cwd: row.missingWorkspace })
            : new Error(row.message, "cause" in row ? { cause: new Error(row.cause) } : undefined),
        ...(pause === undefined ? {} : { beforeOpenFailure: () => mac[pause]("8 hours") }),
      });

      yield* harness.start.pipe(
        Effect.provideService(AwakeSinceWake, Effect.succeed(row.sinceWakeMs)),
        mac.provide,
      );

      expect(harness.open).toHaveBeenCalledOnce();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
        expect.objectContaining({
          activeAttemptId: harness.attemptId,
          expectedStatus: "starting",
        }),
      );
      const projection = harness.projection();
      expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(harness.settledRuns).toEqual(["failed"]);
      expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: row.class,
            code: row.code,
            message: "shown" in row ? row.shown : row.message,
          },
        },
      ]);
    }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect(
  "fails a run whose provider does not resume its conversation in time, without opening a fresh one",
  () =>
    Effect.gen(function* () {
      const resuming = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        resumeThread: () =>
          Deferred.succeed(resuming, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(resuming);

      yield* TestClock.adjust("5 minutes");
      yield* Fiber.join(startup);

      expect(harness.freshThread).not.toHaveBeenCalled();
      // Released before the run settles, so its retry cannot reopen the same process.
      expect(harness.releaseIfSilent).toHaveBeenCalledExactlyOnceWith({
        providerSessionId: harness.providerSessionId,
        silentForMs: 5 * 60_000,
        detail:
          "The provider sent nothing for 5 minutes while a turn waited on it, so it was stopped. The next turn starts a new one.",
      });
      expect(harness.releaseIfSilent.mock.invocationCallOrder[0]).toBeLessThan(
        harness.writeIfRunCurrent.mock.invocationCallOrder[0]!,
      );
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(
        harness
          .projection()
          .turnItems.flatMap((item) => (item.type === "error" ? [item.failure] : [])),
      ).toMatchObject([
        {
          code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
          retryable: true,
          message: "The provider did not resume the conversation within 5 minutes.",
        },
      ]);
    }),
);

effectIt.effect("gives a resume on a loaded host a deadline scaled by its load", () =>
  Effect.gen(function* () {
    const resuming = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      hostLoadPerCpu: 4,
      resumeThread: () => Deferred.succeed(resuming, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(resuming);

    yield* TestClock.adjust("19 minutes");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(startup);

    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

it.each([
  { transcriptBytes: 10_000, priorTimeouts: 0, loadPerCpu: 0.3, minutes: 5 },
  { transcriptBytes: 5_800_000, priorTimeouts: 0, loadPerCpu: 1, minutes: 10 },
  { transcriptBytes: 5_800_000, priorTimeouts: 1, loadPerCpu: 1, minutes: 21 },
  { transcriptBytes: 5_800_000, priorTimeouts: 5, loadPerCpu: 1, minutes: 60 },
  { transcriptBytes: 5_000_000, priorTimeouts: 0, loadPerCpu: 6.5, minutes: 60 },
  { transcriptBytes: 0, priorTimeouts: 0, loadPerCpu: 3, minutes: 15 },
])(
  "waits $minutes minutes to resume $transcriptBytes bytes at $loadPerCpu load per CPU after $priorTimeouts timeouts",
  ({ minutes, ...input }) => {
    expect(ProviderTurnStart.resumeTimeoutMinutes(input)).toBe(minutes);
  },
);

effectIt.effect.each([
  {
    pause: "sleep",
    message:
      "The provider did not resume the conversation within 5 minutes after the computer slept.",
  },
  {
    pause: "stall",
    message:
      "The provider did not resume the conversation within 5 minutes while the server stalled. Its stalls are logged to event-loop-stalls.ndjson in the server's logs folder, ~/.t3/userdata/logs by default.",
  },
] as const)("gives a provider start step its full awake time across a $pause", (row) =>
  Effect.gen(function* () {
    const resuming = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeThread: () => Deferred.succeed(resuming, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const mac = yield* sleepingTestClock;
    const startup = yield* harness.start.pipe(
      mac.provide,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(resuming);

    yield* TestClock.adjust("1 minute");
    mac[row.pause]("8 hours");
    yield* TestClock.adjust("4 minutes");
    // The second the pause interrupted does not count.
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(startup);

    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(
      harness
        .projection()
        .turnItems.flatMap((item) => (item.type === "error" ? [item.failure] : [])),
    ).toMatchObject([
      {
        class: "transport_error",
        code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
        message: row.message,
      },
    ]);
  }),
);

effectIt.effect(
  "fails the run without a retry when the provider needs sign-in, even across a sleep and after a wake",
  () =>
    Effect.gen(function* () {
      const mac = yield* sleepingTestClock;
      const harness = makeLocalCommandHarness({
        text: "Continue",
        openFailure: new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: ProviderDriverKind.make("antigravity"),
          providerSessionId: ProviderSessionId.make("new-provider-session"),
          requiresSignIn: true,
        }),
        beforeOpenFailure: () => mac.sleep("8 hours"),
      });

      yield* harness.startWithRetry.pipe(
        Effect.provideService(AwakeSinceWake, Effect.succeed(30_000)),
        mac.provide,
      );

      expect(harness.open).toHaveBeenCalledOnce();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: "provider_error",
            message: "Failed to open antigravity provider session new-provider-session.",
          },
        },
      ]);
    }),
);

const START_FAILURE_MESSAGE =
  "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";

effectIt.effect.each([
  {
    case: "30 seconds after a wake",
    cause: "Query closed before response received",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  // The adapter cannot say the prompt never arrived, so resending it could run it twice.
  {
    case: "30 seconds after a wake, the prompt perhaps delivered",
    cause: "Query closed before response received",
    beforePrompt: undefined,
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "provider_error",
    code: null,
  },
  {
    case: "10 minutes after a wake",
    cause: "Query closed before response received",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: 10 * 60_000,
    class: "provider_error",
    code: null,
  },
  {
    case: "30 seconds after a wake, for a reason the provider named",
    cause: "previous_turn_active",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "provider_error",
    code: null,
  },
  // Explained, but MCP servers reconnecting after a wake miss the registration deadline.
  {
    case: "30 seconds after a wake, for MCP tools that did not register in time",
    cause: "MCP registration timed out",
    beforePrompt: undefined,
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  {
    case: "10 minutes after a wake, for MCP tools that did not register in time",
    cause: "MCP registration timed out",
    beforePrompt: undefined,
    pause: undefined,
    sinceWakeMs: 10 * 60_000,
    class: "provider_error",
    code: null,
  },
  {
    case: "across a sleep",
    cause: "Query closed before response received",
    beforePrompt: true,
    pause: "sleep",
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  {
    case: "for a lost connection",
    cause: "getaddrinfo ENOTFOUND api.anthropic.com",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  // regression: a settings read a busy machine held past its deadline settled the run as a refusal
  {
    case: "for Claude settings the account worker could not read in time",
    cause: "settings read timed out",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: undefined,
    class: "transport_error",
    code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  },
  {
    case: "for Claude settings the account worker failed to read",
    cause: "settings read failed",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: undefined,
    class: "provider_error",
    code: null,
  },
  // Refusals only the user can fix win over a sleep or a wake.
  {
    case: "30 seconds after a wake, for an account the provider turned away",
    cause: "status 401",
    beforePrompt: true,
    pause: undefined,
    sinceWakeMs: 30_000,
    class: "provider_error",
    code: null,
  },
  {
    case: "across a sleep, for a launch argument the user must fix",
    cause: "missing --append-system-prompt text",
    beforePrompt: true,
    pause: "sleep",
    sinceWakeMs: undefined,
    class: "provider_error",
    code: null,
  },
] as const)("records the cause of a provider turn that failed to start $case", (row) =>
  Effect.gen(function* () {
    const mac = yield* sleepingTestClock;
    const { pause } = row;
    const harness = makeLocalCommandHarness({ text: "Continue", nativeTurn: true });
    const failures: Array<OrchestrationV2ProviderFailure> = [];
    const driver = ProviderDriverKind.make("claudeAgent");
    const registrationTimeout = new ClaudeMcpRegistrationTimeoutError({
      slept: false,
      stalled: false,
    });
    const causes = {
      previous_turn_active: new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "turn still active",
        reason: "previous_turn_active",
      }),
      "status 401": new ClaudeAgentSdkQueryRunnerError({ method: "query", cause: { status: 401 } }),
      "MCP registration timed out": new ClaudeAgentSdkQueryRunnerError({
        method: "setMcpServers",
        cause: registrationTimeout,
      }),
      "missing --append-system-prompt text": new ClaudeAppendSystemPromptMissingValueError({
        flag: "--append-system-prompt",
      }),
      "settings read timed out": new ClaudeSettingsResolveError({
        phase: "account-worker",
        kind: "timeout",
      }),
      "settings read failed": new ClaudeSettingsResolveError({
        phase: "account-worker",
        kind: "nonzero-exit",
      }),
    } as const;
    const cause = Object.hasOwn(causes, row.cause)
      ? causes[row.cause as keyof typeof causes]
      : new Error(row.cause);
    harness.startRootRun.mockImplementation((runInput) =>
      Effect.gen(function* () {
        if (pause !== undefined) mac[pause]("8 hours");
        const error = new ProviderAdapter.ProviderAdapterTurnStartError({
          driver,
          threadId: runInput.run.threadId,
          providerThreadId: ProviderThreadId.make("provider-thread:start-failure"),
          runId: runInput.run.id,
          ...(row.beforePrompt === undefined ? {} : { beforePrompt: row.beforePrompt }),
          cause,
        });
        failures.push(yield* runInput.startFailure(error));
      }),
    );

    yield* harness.start.pipe(
      Effect.provideService(AwakeSinceWake, Effect.succeed(row.sinceWakeMs)),
      mac.provide,
    );

    const shown = {
      previous_turn_active: {
        message:
          "The provider could not start this turn: the previous turn is still running. Retry the turn; if it keeps failing, check the provider setup and server logs.",
        detail: "ProviderAdapterTurnStartError > ProviderAdapterProtocolError",
      },
      "status 401": {
        message: START_FAILURE_MESSAGE,
        detail:
          "ProviderAdapterTurnStartError > ClaudeAgentSdkQueryRunnerError (method query) > (status 401)",
      },
      "MCP registration timed out": { message: registrationTimeout.message },
      "missing --append-system-prompt text": { message: cause.message },
      "settings read timed out": { message: cause.message },
      "settings read failed": { message: cause.message },
    } as const;
    expect(failures).toEqual([
      expect.objectContaining({
        class: row.class,
        code: row.code,
        ...(Object.hasOwn(shown, row.cause)
          ? shown[row.cause as keyof typeof shown]
          : { message: START_FAILURE_MESSAGE, detail: "ProviderAdapterTurnStartError > Error" }),
      }),
    ]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(harness.settledRuns).toEqual([]);
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect(
  "stops an unresolved Auto selection before it can use its placeholder account",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Review the diff",
        nativeTurn: true,
        quotaAwareAuto: true,
      });
      yield* harness.start;
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        { type: "error", failure: { class: "validation_error", code: "auto_route_unresolved" } },
      ]);
    }),
);

effectIt.effect("refuses a turn that would spend prepaid credits the user did not allow", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Review the diff",
      nativeTurn: true,
      createdBy: "agent",
      creditRefusal: { credits: "out_of_scope", limitedUntil: "2026-09-08T00:00:00.000Z" },
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Prepaid credits not allowed",
        // A usage limit would hold the account for the threads the user did allow.
        failure: { class: "permission_error", code: "prepaid_credits_not_allowed" },
      },
    ]);
  }),
);

effectIt.effect("refuses a provider sign-out that an agent or scheduled task sent", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: " /LOGOUT ",
      createdBy: "agent",
      previousNativeSession: true,
    });

    yield* harness.start;

    expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: { class: "permission_error" },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}

effectIt.effect.each([undefined, "2099-01-01T00:00:00.000Z"])(
  "records a delegated startup usage refusal with reset %s",
  (resetAt) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Implement",
        delegatedChild: true,
        openFailure: new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: ProviderDriverKind.make("codex"),
          providerSessionId: ProviderSessionId.make("new-provider-session"),
          failure: {
            class: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
            message: "Usage limit reached",
            retryable: null,
            ...(resetAt === undefined ? {} : { resetAt }),
          },
        }),
      });
      yield* harness.start;
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            code: "subscription_sharing_usage_limit_exceeded",
            ...(resetAt === undefined ? {} : { resetAt }),
          },
        },
      ]);
    }),
);

function makeUsageLimitFailoverHarness(input: {
  readonly prompt?: string;
  readonly failoverLimitedThreads?: boolean;
  readonly providerInstances?: Record<
    string,
    {
      readonly driver: ProviderDriverKind;
      readonly enabled?: boolean;
      readonly allowBackground?: boolean;
    }
  >;
  readonly messageCreatedBy?: "user" | "agent";
  readonly messageCreationSource?: OrchestrationV2ThreadProjection["messages"][number]["creationSource"];
  readonly willRetry?: boolean;
  readonly startedThread?: {
    readonly nativeThreadId?: string;
    readonly itemIdentityVersion?: 2;
  };
  readonly accountsWithRoom?: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly mcpSignInsNeeded?: ReadonlyArray<string>;
    readonly onCredits?: boolean;
  }>;
  readonly openUsageLimitInstances?: ReadonlySet<ProviderInstanceId>;
  readonly ensureUsageLimitInstances?: ReadonlySet<ProviderInstanceId>;
  readonly resumeUsageLimitInstances?: ReadonlySet<ProviderInstanceId>;
  readonly usageLimitDetailsByInstance?: ReadonlyMap<
    ProviderInstanceId,
    {
      readonly code?: string;
      readonly message?: string;
      readonly resetAt?: string;
      readonly modelScope?: string;
    }
  >;
  readonly openNonLimitErrors?: ReadonlyMap<ProviderInstanceId, Error>;
  readonly ensureNonLimitErrors?: ReadonlyMap<ProviderInstanceId, Error>;
  readonly resumeNonLimitErrors?: ReadonlyMap<ProviderInstanceId, Error>;
  readonly creditRefusal?: (input: {
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }) => Effect.Effect<AccountRouting.CreditRefusal | null>;
  readonly adapterMetadataByInstance?: ReadonlyMap<
    ProviderInstanceId,
    {
      readonly driver?: ProviderDriverKind;
      readonly continuationKey: string;
      readonly supportsMultipleProviderThreadsPerSession?: boolean;
    }
  >;
  readonly modelContextWindowByInstance?: ReadonlyMap<ProviderInstanceId, number>;
  readonly prepareProviderHandoff?: ContextHandoffService.ContextHandoffServiceV2Shape["prepareProviderHandoff"];
  readonly getTurnStartHistory?: (
    callIndex: number,
  ) => Effect.Effect<
    ReadonlyArray<OrchestrationV2ThreadProjection["turnItems"][number]>,
    ProjectionStore.ProjectionStoreV2Error
  >;
  readonly onOpen?: (
    instanceId: ProviderInstanceId,
    mutateProjection: (
      updater: (current: OrchestrationV2ThreadProjection) => OrchestrationV2ThreadProjection,
    ) => void,
  ) => void;
  readonly rejectRunningCommit?: boolean;
  readonly failFirstRunningCommit?: boolean;
}) {
  let failFirstRunningCommitPending = input.failFirstRunningCommit === true;
  const now = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");
  const threadId = ThreadId.make("thread-failover-1");
  const projectId = ProjectId.make("project-failover-1");
  const priorRunId = RunId.make("run-failover-0");
  const priorAttemptId = RunAttemptId.make("attempt-failover-0");
  const priorRootNodeId = NodeId.make("node-failover-0");
  const priorMessageId = MessageId.make("message-failover-0");
  const runId = RunId.make("run-failover-1");
  const attemptId = RunAttemptId.make("attempt-failover-1");
  const rootNodeId = NodeId.make("node-failover-1");
  const messageId = MessageId.make("message-failover-1");
  const checkpointScopeId = CheckpointScopeId.make("scope-failover-1");
  const providerThreadId = ProviderThreadId.make("provider-thread-failover-1");
  const initialSessionId = ProviderSessionId.make("provider-session-account-a");
  const driver = ProviderDriverKind.make("codex");
  const accountA = ProviderInstanceId.make("codex-account-a");
  const model = "gpt-5.4";
  const prompt = input.prompt ?? "Fix the parser bug";
  const isStarted = input.startedThread !== undefined;
  const runOrdinal = isStarted ? 2 : 1;

  const makeUsageLimitError = (instanceId: ProviderInstanceId, sessionId: ProviderSessionId) => {
    const details = input.usageLimitDetailsByInstance?.get(instanceId);
    return new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver,
      providerSessionId: sessionId,
      failure: {
        class: "usage_limit",
        code: details?.code ?? "usage_limit_reached",
        message: details?.message ?? `Usage limit reached on ${instanceId}`,
        retryable: null,
        resetAt: details?.resetAt ?? "2099-01-01T00:00:00.000Z",
        ...(details?.modelScope === undefined ? {} : { modelScope: details.modelScope }),
      },
    });
  };

  const priorRun: OrchestrationV2ThreadProjection["runs"][number] = {
    id: priorRunId,
    threadId,
    ordinal: 1,
    providerInstanceId: accountA,
    modelSelection: { instanceId: accountA, model },
    providerThreadId,
    userMessageId: priorMessageId,
    rootNodeId: priorRootNodeId,
    activeAttemptId: priorAttemptId,
    status: "completed",
    requestedAt: DateTime.subtract(now, { minutes: 5 }),
    startedAt: DateTime.subtract(now, { minutes: 5 }),
    completedAt: DateTime.subtract(now, { minutes: 4 }),
    checkpointId: null,
    contextHandoffId: null,
  };
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: runOrdinal,
    providerInstanceId: accountA,
    modelSelection: { instanceId: accountA, model },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver,
    providerInstanceId: accountA,
    providerSessionId: initialSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: isStarted
      ? {
          driver,
          nativeId: input.startedThread.nativeThreadId ?? "native-account-a",
          strength: "strong",
        }
      : null,
    nativeConversationHeadRef: null,
    ...(input.startedThread?.itemIdentityVersion === undefined
      ? {}
      : {
          nativeMetadata: {
            itemIdentityVersion: input.startedThread.itemIdentityVersion,
          },
        }),
    status: isStarted ? "active" : "not_loaded",
    firstRunOrdinal: 1,
    lastRunOrdinal: runOrdinal,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };

  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      projectId,
      title: "Failover test thread",
      providerInstanceId: accountA,
      modelSelection: { instanceId: accountA, model },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        rootThreadId: threadId,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    messages: [
      ...(isStarted
        ? [
            {
              id: priorMessageId,
              threadId,
              runId: priorRunId,
              nodeId: priorRootNodeId,
              role: "user" as const,
              text: "Earlier prompt from run 1",
              attachments: [],
              streaming: false,
              createdBy: "user" as const,
              creationSource: "web" as const,
              createdAt: DateTime.subtract(now, { minutes: 5 }),
              updatedAt: DateTime.subtract(now, { minutes: 5 }),
            },
          ]
        : []),
      {
        id: messageId,
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: prompt,
        attachments: [],
        streaming: false,
        createdBy: input.messageCreatedBy ?? "user",
        creationSource: input.messageCreationSource ?? "web",
        createdAt: now,
        updatedAt: now,
      },
    ],
    runs: isStarted ? [priorRun, run] : [run],
    attempts: [
      {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: accountA,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerSessions: [],
    providerThreads: [providerThread],
    providerTurns: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    contextHandoffs: [],
    contextTransfers: [],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/failover-workspace",
        createdAt: now,
      },
    ],
    checkpoints: [],
    updatedAt: now,
  };

  const events: Array<OrchestrationV2DomainEvent> = [];
  const openedInstances: Array<ProviderInstanceId> = [];
  const openCalls: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly providerSessionId: ProviderSessionId;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: number;
  }> = [];
  const resumedInstances: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly nativeThreadId: string | null;
  }> = [];
  const startedTurns: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly text: string;
  }> = [];
  const recordedSilentRefusals: Array<
    Parameters<ProjectionStore.ProjectionStoreV2Shape["recordUsageLimitRefusal"]>[0]
  > = [];
  const refreshedInstances: Array<ProviderInstanceId> = [];
  const refreshDeferreds = new Map<ProviderInstanceId, Deferred.Deferred<void>>();
  const getRefreshDeferred = (instanceId: ProviderInstanceId) => {
    let deferred = refreshDeferreds.get(instanceId);
    if (deferred === undefined) {
      deferred = Deferred.makeUnsafe<void>();
      refreshDeferreds.set(instanceId, deferred);
    }
    return deferred;
  };
  const detach = vi.fn<ProviderSessionManager.ProviderSessionManagerV2Shape["detach"]>(
    () => Effect.void,
  );
  const refreshInstance = vi.fn((instanceId: ProviderInstanceId) => {
    refreshedInstances.push(instanceId);
    return Deferred.succeed(getRefreshDeferred(instanceId), undefined).pipe(Effect.as([]));
  });
  const recordUsageLimitRefusal = vi.fn<
    ProjectionStore.ProjectionStoreV2Shape["recordUsageLimitRefusal"]
  >((refusal) =>
    Effect.sync(() => {
      recordedSilentRefusals.push(refusal);
    }),
  );
  const accountsWithRoom = vi.fn(() =>
    Effect.succeed(
      (input.accountsWithRoom ?? []).map((candidate) => ({
        instanceId: candidate.instanceId,
        model: candidate.model,
        mcpSignInsNeeded: candidate.mcpSignInsNeeded ?? [],
        onCredits: candidate.onCredits ?? false,
      })),
    ),
  );
  let historyCallCount = 0;

  const open = vi.fn<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>(
    ({
      providerSessionId,
      modelSelection,
      initialNativeThreadId,
      initialProviderItemIdentityVersion,
    }) => {
      const instanceId = modelSelection.instanceId;
      openedInstances.push(instanceId);
      openCalls.push({
        instanceId,
        providerSessionId,
        ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
        ...(initialProviderItemIdentityVersion === undefined
          ? {}
          : { initialProviderItemIdentityVersion }),
      });
      input.onOpen?.(instanceId, (updater) => {
        projection = updater(projection);
      });
      const openNonLimitError = input.openNonLimitErrors?.get(instanceId);
      if (openNonLimitError !== undefined) {
        return Effect.fail(
          new ProviderSessionManager.ProviderSessionOpenError({
            instanceId,
            providerSessionId,
            cause: openNonLimitError,
          }),
        );
      }
      if (input.openUsageLimitInstances?.has(instanceId)) {
        return Effect.fail(
          new ProviderSessionManager.ProviderSessionOpenError({
            instanceId,
            providerSessionId,
            cause: makeUsageLimitError(instanceId, providerSessionId),
          }),
        );
      }
      const ensureThread = vi.fn(
        (ensureInput: {
          readonly existingProviderThread?: OrchestrationV2ThreadProjection["providerThreads"][number];
        }) => {
          const ensureNonLimitError = input.ensureNonLimitErrors?.get(instanceId);
          if (ensureNonLimitError !== undefined) {
            return Effect.fail(ensureNonLimitError as never);
          }
          if (input.ensureUsageLimitInstances?.has(instanceId)) {
            return Effect.fail(makeUsageLimitError(instanceId, providerSessionId));
          }
          const baseThread = ensureInput.existingProviderThread ?? providerThread;
          return Effect.succeed({
            ...baseThread,
            providerInstanceId: instanceId,
            providerSessionId,
            nativeThreadRef: {
              driver,
              nativeId: `native-${instanceId}`,
              strength: "strong" as const,
            },
            status: "active" as const,
          });
        },
      );
      const resumeThread = vi.fn(
        (resumeInput: {
          readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number];
        }) => {
          resumedInstances.push({
            instanceId,
            nativeThreadId: resumeInput.providerThread.nativeThreadRef?.nativeId ?? null,
          });
          const resumeNonLimitError = input.resumeNonLimitErrors?.get(instanceId);
          if (resumeNonLimitError !== undefined) {
            return Effect.fail(resumeNonLimitError as never);
          }
          if (input.resumeUsageLimitInstances?.has(instanceId)) {
            return Effect.fail(makeUsageLimitError(instanceId, providerSessionId));
          }
          return Effect.succeed({
            ...resumeInput.providerThread,
            providerInstanceId: instanceId,
            providerSessionId,
            status: "active" as const,
          });
        },
      );
      const startTurn = vi.fn((turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) => {
        startedTurns.push({ instanceId, text: turnInput.message.text });
        return Effect.void;
      });
      const contextWindow = input.modelContextWindowByInstance?.get(instanceId);
      return Effect.succeed({
        driver,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready" as const,
          cwd: "/tmp/failover-workspace",
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        ...(contextWindow === undefined ? {} : { getModelContextWindow: () => contextWindow }),
        ensureThread,
        resumeThread,
        startTurn,
      } as never);
    },
  );

  const startRootRun = vi.fn<
    (runInput: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >((runInput) =>
    Effect.gen(function* () {
      const turn = yield* runInput.prepareTurn!(
        {
          ...runInput,
        } as never,
        false,
      );
      yield* runInput.session
        .startTurn(turn.turnInput)
        .pipe(Effect.tapError(turn.notAccepted), Effect.andThen(turn.accepted));
    }).pipe(Effect.orDie),
  );

  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
    Effect.suspend(() => {
      const current = projection.runs.find((candidate) => candidate.id === runId);
      const isRunningTransition = incoming.some(
        (event: OrchestrationV2DomainEvent) =>
          event.type === "run.updated" && event.payload.status === "running",
      );
      if (isRunningTransition && failFirstRunningCommitPending) {
        failFirstRunningCommitPending = false;
        return Effect.fail(
          new EventSink.EventSinkWriteError({
            eventCount: incoming.length,
            cause: "transient sqlite busy",
          }),
        );
      }
      const committed =
        !(input.rejectRunningCommit === true && isRunningTransition) &&
        current !== undefined &&
        current.activeAttemptId === activeAttemptId &&
        current.status === expectedStatus;
      if (committed) {
        for (const event of incoming) {
          expect(isDomainEvent(event)).toBe(true);
          events.push(event);
          projection = ProjectionStore.applyToProjection(projection, event);
        }
      }
      return Effect.succeed({ committed, storedEvents: [] });
    }),
  );

  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff:
            input.prepareProviderHandoff ??
            ((handoff) =>
              isStarted
                ? Effect.succeed({
                    ...handoff,
                    id: ContextHandoffId.make(`failover-handoff-${handoff.toProviderInstanceId}`),
                    createdByProviderInstanceId: handoff.toProviderInstanceId,
                    status: "ready",
                    summaryMessageId: null,
                    summaryText: "SUMMARY_FROM_RUN_1",
                    updatedAt: handoff.createdAt,
                  })
                : Effect.die("unexpected handoff on first turn")),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        NodePath.layer,
        Layer.mock(ServerConfig.ServerConfig)({
          worktreesDir: managedWorktreesDir,
          stateDir: `${managedWorktreesDir}/../state`,
        } as ServerConfig.ServerConfig["Service"]),
        ServerSettings.layerTest({
          failoverLimitedThreads: input.failoverLimitedThreads ?? true,
          ...(input.providerInstances === undefined
            ? {}
            : { providerInstances: input.providerInstances }),
        }),
        ProviderSkillsTestkit.layer,
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshInstance,
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
          getMetadata: (instanceId) => {
            const meta = input.adapterMetadataByInstance?.get(instanceId);
            return Effect.succeed({
              driver: meta?.driver ?? driver,
              continuationKey: meta?.continuationKey ?? `key:${instanceId}`,
              enabled: true,
              capabilities: {
                ...CodexProviderCapabilitiesV2,
                sessions: {
                  ...CodexProviderCapabilitiesV2.sessions,
                  supportsMultipleProviderThreadsPerSession:
                    meta?.supportsMultipleProviderThreadsPerSession ??
                    CodexProviderCapabilitiesV2.sessions.supportsMultipleProviderThreadsPerSession,
                },
              },
            });
          },
        }),
        Layer.mock(AccountRouting.AccountRouting)({
          accountsWithRoom,
          creditRefusal: input.creditRefusal ?? (() => Effect.succeed(null)),
        }),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: "/tmp/failover-workspace" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getUsageLimitedProviderInstances: () => Effect.succeed(new Map()),
          recordUsageLimitRefusal,
          getThreadRecords: () => Effect.succeed(projection),
          getTurnStartContext: () => Effect.succeed({ ...projection, hasConversation: true }),
          getRuntimeRecoveryProjection: () =>
            Effect.succeed({ ...projection, hasConversation: true }),
          getTurnStartHistory: () =>
            input.getTurnStartHistory
              ? input.getTurnStartHistory(historyCallCount++)
              : Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          detach,
          releaseIfSilent: () => Effect.succeed(false),
          isLive: () => Effect.succeed(false),
          get: () => Effect.succeedNone,
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
        }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: () => Effect.void,
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: ({ thread }) =>
            Effect.succeed({
              cwd: "/tmp/failover-workspace",
              runtimeMode: thread.runtimeMode,
            } as never),
        }),
      ),
    ),
  );

  const runWithService = <A, E>(
    fn: (service: ProviderTurnStart.ProviderTurnStartServiceV2["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.flatMap(ProviderTurnStart.ProviderTurnStartServiceV2, fn).pipe(
      Effect.provide(layer),
      Effect.provideService(ProviderTurnStart.HostLoadPerCpu, Effect.succeed(0)),
      Effect.provideService(AwakeSinceWake, Effect.void),
    );

  return {
    threadId,
    runId,
    providerThreadId,
    accountA,
    initialSessionId,
    open,
    openCalls,
    detach,
    refreshInstance,
    awaitRefresh: (instanceId: ProviderInstanceId) =>
      Deferred.await(getRefreshDeferred(instanceId)),
    recordUsageLimitRefusal,
    recordedSilentRefusals,
    refreshedInstances,
    accountsWithRoom,
    startRootRun,
    openedInstances,
    resumedInstances,
    startedTurns,
    events,
    projection: () => projection,
    runWithService,
    start: runWithService((service) =>
      service.start({
        threadId,
        runId,
        ...(input.willRetry === undefined ? {} : { willRetry: input.willRetry }),
      }),
    ),
  };
}

effectIt.effect(
  "transparently fails over to an eligible alternate account on immediate open usage_limit refusal without emitting a failure item",
  () =>
    Effect.gen(function* () {
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        prompt: "Fix the parser bug",
        willRetry: true,
        openUsageLimitInstances: new Set([ProviderInstanceId.make("codex-account-a")]),
        accountsWithRoom: [
          { instanceId: ProviderInstanceId.make("codex-account-a"), model: "gpt-5.4" },
          { instanceId: accountB, model: "gpt-5.4" },
        ],
      });

      yield* harness.start;
      yield* harness.awaitRefresh(harness.accountA);

      expect(harness.openedInstances).toEqual([harness.accountA, accountB]);
      expect(harness.startedTurns).toEqual([{ instanceId: accountB, text: "Fix the parser bug" }]);
      expect(harness.startedTurns[0]?.text).not.toContain(CONTINUE_PROMPT);
      expect(harness.projection().thread.providerInstanceId).toBe(accountB);
      expect(harness.projection().thread.modelSelection.instanceId).toBe(accountB);
      expect(harness.projection().runs[0]?.status).toBe("running");
      expect(harness.projection().runs[0]?.providerInstanceId).toBe(accountB);
      expect(harness.projection().turnItems.filter((item) => item.type === "error")).toEqual([]);
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(true);
      expect(harness.refreshInstance).toHaveBeenCalledWith(harness.accountA);
      expect(harness.recordedSilentRefusals).toMatchObject([
        {
          providerInstanceId: harness.accountA,
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usage_limit_reached",
        },
      ]);
    }),
);

effectIt.effect(
  "detaches the refusing account session and fails over transparently when ensureThread refuses with usage_limit",
  () =>
    Effect.gen(function* () {
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        prompt: "Refactor the cache",
        ensureUsageLimitInstances: new Set([ProviderInstanceId.make("codex-account-a")]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
      });

      yield* harness.start;

      expect(harness.openedInstances).toEqual([harness.accountA, accountB]);
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: harness.initialSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.startedTurns).toEqual([{ instanceId: accountB, text: "Refactor the cache" }]);
      expect(harness.projection().runs[0]?.status).toBe("running");
      expect(harness.projection().runs[0]?.providerInstanceId).toBe(accountB);
      expect(harness.projection().turnItems.filter((item) => item.type === "error")).toEqual([]);
    }),
);

effectIt.effect(
  "retries across up to two alternate accounts without retrying already-tried instances",
  () =>
    Effect.gen(function* () {
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountC = ProviderInstanceId.make("codex-account-c");
      const harness = makeUsageLimitFailoverHarness({
        prompt: "Run the migration",
        openUsageLimitInstances: new Set([ProviderInstanceId.make("codex-account-a"), accountB]),
        accountsWithRoom: [
          { instanceId: ProviderInstanceId.make("codex-account-a"), model: "gpt-5.4" },
          { instanceId: accountB, model: "gpt-5.4" },
          { instanceId: accountC, model: "gpt-5.4" },
        ],
      });

      yield* harness.start;

      expect(harness.openedInstances).toEqual([harness.accountA, accountB, accountC]);
      expect(harness.startedTurns).toEqual([{ instanceId: accountC, text: "Run the migration" }]);
      expect(harness.projection().thread.providerInstanceId).toBe(accountC);
      expect(harness.projection().runs[0]?.status).toBe("running");
      expect(harness.projection().turnItems.filter((item) => item.type === "error")).toEqual([]);
      expect(harness.recordedSilentRefusals.map((r) => r.providerInstanceId)).toEqual([
        harness.accountA,
        accountB,
      ]);
    }),
);

effectIt.effect(
  "caps transparent in-run usage_limit failovers at two retries and settles cleanly on the original account with its original error",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountC = ProviderInstanceId.make("codex-account-c");
      const accountD = ProviderInstanceId.make("codex-account-d");
      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA, accountB, accountC]),
        usageLimitDetailsByInstance: new Map([
          [
            accountA,
            {
              code: "account_a_limit",
              message: "Account A primary quota reached",
              resetAt: "2099-01-01T01:00:00.000Z",
            },
          ],
          [
            accountB,
            {
              code: "account_b_limit",
              message: "Account B quota reached",
              resetAt: "2099-01-01T02:00:00.000Z",
            },
          ],
          [
            accountC,
            {
              code: "account_c_limit",
              message: "Account C quota reached",
              resetAt: "2099-01-01T03:00:00.000Z",
            },
          ],
        ]),
        accountsWithRoom: [
          { instanceId: accountB, model: "gpt-5.4" },
          { instanceId: accountC, model: "gpt-5.4" },
          { instanceId: accountD, model: "gpt-5.4" },
        ],
      });

      yield* harness.start;
      yield* harness.awaitRefresh(accountA);
      yield* harness.awaitRefresh(accountB);
      yield* harness.awaitRefresh(accountC);

      expect(harness.openedInstances).toEqual([accountA, accountB, accountC]);
      expect(harness.startedTurns).toEqual([]);
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(false);
      expect(harness.projection().thread.providerInstanceId).toBe(accountA);
      expect(harness.projection().runs[0]?.status).toBe("failed");
      expect(harness.projection().runs[0]?.providerInstanceId).toBe(accountA);
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            code: "account_a_limit",
            message: "Account A primary quota reached",
            resetAt: "2099-01-01T01:00:00.000Z",
          },
        },
      ]);
      // Alternate accounts B and C had their refusals durably recorded even though settlement blames A.
      expect(harness.recordedSilentRefusals).toMatchObject([
        { providerInstanceId: accountA, code: "account_a_limit" },
        { providerInstanceId: accountB, code: "account_b_limit" },
        { providerInstanceId: accountC, code: "account_c_limit" },
      ]);
    }),
);

effectIt.effect(
  "preserves the original account usage_limit error and detaches the alternate session when failover hits a non-limit error",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        willRetry: true,
        openUsageLimitInstances: new Set([accountA]),
        usageLimitDetailsByInstance: new Map([
          [
            accountA,
            {
              code: "account_a_limit",
              message: "Account A reached its limit",
              resetAt: "2099-01-01T04:00:00.000Z",
            },
          ],
        ]),
        ensureNonLimitErrors: new Map([
          [
            accountB,
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: ProviderDriverKind.make("codex"),
              threadId: ThreadId.make("thread-failover-1"),
              providerThreadId: ProviderThreadId.make("provider-thread-failover-1"),
              runId: RunId.make("run-failover-1"),
              cause: new Error("ECONNRESET on account B"),
            }),
          ],
        ]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
      });

      yield* harness.start;

      const bSessionId = harness.openCalls.find(
        (call) => call.instanceId === accountB,
      )?.providerSessionId;
      expect(bSessionId).toBeDefined();
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: bSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(false);
      expect(harness.projection().thread.providerInstanceId).toBe(accountA);
      expect(harness.projection().runs[0]?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            code: "account_a_limit",
            message: "Account A reached its limit",
            resetAt: "2099-01-01T04:00:00.000Z",
          },
        },
      ]);
      // B failed with a non-limit error, so B must not be recorded as usage-limited.
      expect(harness.recordedSilentRefusals.map((r) => r.providerInstanceId)).toEqual([accountA]);
    }),
);

effectIt.effect(
  "preserves concurrent thread edits and newer next-turn modelSelection when emitting thread.provider-switched",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountZ = ProviderInstanceId.make("codex-account-z");
      const pinnedAt = DateTime.makeUnsafe("2026-11-27T00:01:00.000Z");
      const archivedAt = DateTime.makeUnsafe("2026-11-27T00:02:00.000Z");
      const snoozedUntil = DateTime.makeUnsafe("2026-11-27T05:00:00.000Z");

      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
        onOpen: (instanceId, mutateProjection) => {
          if (instanceId !== accountB) return;
          mutateProjection((current) => ({
            ...current,
            thread: {
              ...current.thread,
              title: "User renamed thread in flight",
              pinnedAt,
              archivedAt,
              snoozedUntil,
              runtimeMode: "approval-required",
              modelSelection: { instanceId: accountZ, model: "gpt-5.4-mini" },
            },
          }));
        },
      });

      yield* harness.start;

      const switchedEvent = harness.events.find(
        (event) => event.type === "thread.provider-switched",
      );
      expect(switchedEvent).toBeDefined();
      expect(harness.projection().thread.title).toBe("User renamed thread in flight");
      expect(harness.projection().thread.pinnedAt).toEqual(pinnedAt);
      expect(harness.projection().thread.archivedAt).toEqual(archivedAt);
      expect(harness.projection().thread.snoozedUntil).toEqual(snoozedUntil);
      expect(harness.projection().thread.runtimeMode).toBe("approval-required");
      expect(harness.projection().thread.modelSelection).toEqual({
        instanceId: accountZ,
        model: "gpt-5.4-mini",
      });
      expect(harness.projection().runs[0]?.providerInstanceId).toBe(accountB);
      expect(harness.startedTurns).toEqual([{ instanceId: accountB, text: "Fix the parser bug" }]);
    }),
);

effectIt.effect(
  "creates a separate providerThread row with recovery handoff on a started thread without native resume and preserves the original account row",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        prompt: "Continue working on the parser",
        startedThread: {
          nativeThreadId: "native-account-a",
          itemIdentityVersion: 2,
        },
        resumeUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
        adapterMetadataByInstance: new Map([
          [accountA, { continuationKey: "codex-home-a" }],
          [accountB, { continuationKey: "codex-home-b" }],
        ]),
      });

      yield* harness.start;

      const bOpenCall = harness.openCalls.find((call) => call.instanceId === accountB);
      expect(bOpenCall?.initialNativeThreadId).toBeUndefined();
      expect(bOpenCall?.initialProviderItemIdentityVersion).toBeUndefined();

      const finalProjection = harness.projection();
      const rowA = finalProjection.providerThreads.find(
        (row) => row.id === harness.providerThreadId,
      );
      const rowB = finalProjection.providerThreads.find(
        (row) => row.providerInstanceId === accountB,
      );
      expect(rowA?.providerInstanceId).toBe(accountA);
      expect(rowA?.nativeThreadRef?.nativeId).toBe("native-account-a");
      expect(rowB).toBeDefined();
      expect(rowB?.id).not.toBe(harness.providerThreadId);
      expect(finalProjection.thread.activeProviderThreadId).toBe(rowB?.id);
      const activeRun = finalProjection.runs.find((r) => r.id === harness.runId);
      expect(activeRun?.providerThreadId).toBe(rowB?.id);
      expect(finalProjection.attempts[0]?.providerThreadId).toBe(rowB?.id);
      expect(finalProjection.nodes[0]?.providerThreadId).toBe(rowB?.id);
      expect(harness.startedTurns).toHaveLength(1);
      expect(harness.startedTurns[0]?.instanceId).toBe(accountB);
      expect(harness.startedTurns[0]?.text).toContain("SUMMARY_FROM_RUN_1");
    }),
);

effectIt.effect(
  "never runs a started thread on a blank session when recovery handoff preparation fails",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        startedThread: { nativeThreadId: "native-account-a" },
        resumeUsageLimitInstances: new Set([accountA]),
        usageLimitDetailsByInstance: new Map([
          [
            accountA,
            {
              code: "account_a_limit",
              message: "Account A limit reached",
              resetAt: "2099-01-01T06:00:00.000Z",
            },
          ],
        ]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
        adapterMetadataByInstance: new Map([
          [accountA, { continuationKey: "codex-home-a" }],
          [accountB, { continuationKey: "codex-home-b" }],
        ]),
        prepareProviderHandoff: (handoff) =>
          Effect.fail(
            new ContextHandoffService.ContextHandoffPrepareError({
              threadId: handoff.threadId,
              targetRunId: handoff.targetRunId,
              fromProviderThreadIds: [...handoff.fromProviderThreadIds],
              toProviderThreadId: handoff.toProviderThreadId,
              cause: "handoff storage unavailable",
            }),
          ),
      });

      yield* harness.start;

      const bSessionId = harness.openCalls.find(
        (call) => call.instanceId === accountB,
      )?.providerSessionId;
      expect(bSessionId).toBeDefined();
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: bSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.startedTurns).toEqual([]);
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(false);
      expect(harness.projection().runs.find((r) => r.id === harness.runId)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            code: "account_a_limit",
            message: "Account A limit reached",
          },
        },
      ]);
    }),
);

effectIt.effect(
  "detaches a non-resumable alternate whose handoff exceeds budget and falls back to a natively-resumable alternate",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountC = ProviderInstanceId.make("codex-account-c");
      const harness = makeUsageLimitFailoverHarness({
        startedThread: { nativeThreadId: "native-account-a" },
        resumeUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [
          { instanceId: accountB, model: "gpt-5.4" },
          { instanceId: accountC, model: "gpt-5.4" },
        ],
        adapterMetadataByInstance: new Map([
          [accountA, { continuationKey: "shared-codex-home" }],
          [accountB, { continuationKey: "isolated-codex-home" }],
          [accountC, { continuationKey: "shared-codex-home" }],
        ]),
        // Make B's context window too small to fit the recovery handoff.
        modelContextWindowByInstance: new Map([[accountB, 10]]),
        prepareProviderHandoff: (handoff) =>
          Effect.succeed({
            ...handoff,
            id: ContextHandoffId.make(`oversized-handoff-${handoff.toProviderInstanceId}`),
            createdByProviderInstanceId: handoff.toProviderInstanceId,
            status: "ready",
            summaryMessageId: null,
            summaryText: "X".repeat(20_000),
            updatedAt: handoff.createdAt,
          }),
      });

      yield* harness.start;

      const bSessionId = harness.openCalls.find(
        (call) => call.instanceId === accountB,
      )?.providerSessionId;
      expect(bSessionId).toBeDefined();
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: bSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.resumedInstances).toEqual([
        { instanceId: accountA, nativeThreadId: "native-account-a" },
        { instanceId: accountC, nativeThreadId: "native-account-a" },
      ]);
      expect(harness.startedTurns).toEqual([{ instanceId: accountC, text: "Fix the parser bug" }]);
      expect(harness.projection().thread.activeProviderThreadId).toBe(harness.providerThreadId);
      expect(
        harness.projection().runs.find((r) => r.id === harness.runId)?.providerInstanceId,
      ).toBe(accountC);
    }),
);

effectIt.effect(
  "skips an alternate candidate when creditRefusal fails or defects instead of allowing spend",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountC = ProviderInstanceId.make("codex-account-c");
      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [
          { instanceId: accountB, model: "gpt-5.4" },
          { instanceId: accountC, model: "gpt-5.4" },
        ],
        creditRefusal: ({ instanceId }) =>
          instanceId === accountB
            ? Effect.die(new Error("settings store unavailable"))
            : Effect.succeed(null),
      });

      yield* harness.start;

      expect(harness.openedInstances).toEqual([accountA, accountC]);
      expect(harness.startedTurns).toEqual([{ instanceId: accountC, text: "Fix the parser bug" }]);
    }),
);

effectIt.effect(
  "tracks failover state across start() retries so willRetry cannot reset the two-retry cap",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const accountC = ProviderInstanceId.make("codex-account-c");
      const accountD = ProviderInstanceId.make("codex-account-d");
      const harness = makeUsageLimitFailoverHarness({
        willRetry: true,
        openUsageLimitInstances: new Set([accountA, accountC]),
        accountsWithRoom: [
          { instanceId: accountB, model: "gpt-5.4" },
          { instanceId: accountC, model: "gpt-5.4" },
          { instanceId: accountD, model: "gpt-5.4" },
        ],
        // On attempt 1, A fails over to B (failover retry #1), then committing the running transition
        // fails transiently. On attempt 2 (start() retried by caller), failover state remembers B was
        // tried and retry count = 1, so A fails over to C (failover retry #2) and hits the cap without
        // ever touching D.
        failFirstRunningCommit: true,
      });

      yield* harness.runWithService((service) =>
        Effect.gen(function* () {
          const first = yield* Effect.result(
            service.start({
              threadId: harness.threadId,
              runId: harness.runId,
              willRetry: true,
            }),
          );
          expect(first._tag).toBe("Failure");

          // Second call on the same runId must keep triedInstanceIds (including B) and retry count = 1.
          yield* service.start({
            threadId: harness.threadId,
            runId: harness.runId,
            willRetry: true,
          });
        }),
      );

      const bSessionId = harness.openCalls.find(
        (call) => call.instanceId === accountB,
      )?.providerSessionId;
      expect(bSessionId).toBeDefined();
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: bSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.openedInstances).toEqual([accountA, accountB, accountA, accountC]);
      expect(harness.openedInstances).not.toContain(accountD);
      expect(harness.projection().runs[0]?.status).toBe("failed");
      expect(harness.projection().runs[0]?.providerInstanceId).toBe(accountA);
    }),
);

effectIt.effect(
  "derives a shared ProviderSessionId when the alternate adapter supports multiple provider threads per session",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
        adapterMetadataByInstance: new Map([
          [
            accountB,
            { continuationKey: "shared-b", supportsMultipleProviderThreadsPerSession: true },
          ],
        ]),
      });

      const expectedSharedSessionId = yield* Effect.map(IdAllocator.IdAllocatorV2, (allocator) =>
        allocator.derive.providerSession({ providerInstanceId: accountB }),
      ).pipe(Effect.provide(IdAllocator.layer));

      yield* harness.start;

      const bOpenCall = harness.openCalls.find((call) => call.instanceId === accountB);
      expect(bOpenCall?.providerSessionId).toBe(expectedSharedSessionId);
    }),
);

effectIt.effect(
  "detaches the opened alternate session when committing the running transition is rejected",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
        rejectRunningCommit: true,
      });

      yield* harness.start;

      const bSessionId = harness.openCalls.find(
        (call) => call.instanceId === accountB,
      )?.providerSessionId;
      expect(bSessionId).toBeDefined();
      expect(harness.detach).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: bSessionId,
          revokeMcpCredential: false,
        }),
      );
      expect(harness.startRootRun).not.toHaveBeenCalled();
    }),
);

effectIt.effect(
  "falls through to the existing usage_limit failure when no alternate account has room",
  () =>
    Effect.gen(function* () {
      const harness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([ProviderInstanceId.make("codex-account-a")]),
        accountsWithRoom: [
          { instanceId: ProviderInstanceId.make("codex-account-a"), model: "gpt-5.4" },
        ],
      });

      yield* harness.start;

      expect(harness.openedInstances).toEqual([harness.accountA]);
      expect(harness.startedTurns).toEqual([]);
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(false);
      expect(harness.projection().runs[0]?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: { class: "usage_limit", code: "usage_limit_reached" },
        },
      ]);
    }),
);

effectIt.effect(
  "does not switch accounts on immediate usage_limit refusal when failoverLimitedThreads is false",
  () =>
    Effect.gen(function* () {
      const accountB = ProviderInstanceId.make("codex-account-b");
      const harness = makeUsageLimitFailoverHarness({
        failoverLimitedThreads: false,
        openUsageLimitInstances: new Set([ProviderInstanceId.make("codex-account-a")]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
      });

      yield* harness.start;

      expect(harness.accountsWithRoom).not.toHaveBeenCalled();
      expect(harness.openedInstances).toEqual([harness.accountA]);
      expect(harness.startedTurns).toEqual([]);
      expect(harness.events.some((event) => event.type === "thread.provider-switched")).toBe(false);
      expect(harness.projection().runs[0]?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: { class: "usage_limit", code: "usage_limit_reached" },
        },
      ]);
    }),
);

effectIt.effect(
  "settles unstarted background runs targeting allowBackground: false without opening a session, while interactive runs proceed",
  () =>
    Effect.gen(function* () {
      const accountA = ProviderInstanceId.make("codex-account-a");
      const accountB = ProviderInstanceId.make("codex-account-b");
      const codexDriver = ProviderDriverKind.make("codex");

      const backgroundHarness = makeUsageLimitFailoverHarness({
        messageCreatedBy: "agent",
        messageCreationSource: "mcp",
        providerInstances: {
          [accountA]: { driver: codexDriver, enabled: true, allowBackground: false },
          [accountB]: { driver: codexDriver, enabled: true },
        },
      });
      yield* backgroundHarness.start;
      expect(backgroundHarness.openedInstances).toEqual([]);
      expect(backgroundHarness.startedTurns).toEqual([]);
      expect(backgroundHarness.projection().runs[0]?.status).toBe("failed");
      expect(backgroundHarness.projection().turnItems).toMatchObject([
        {
          type: "error",
          status: "failed",
          failure: { code: "provider_instance_background_disallowed" },
        },
      ]);

      const interactiveHarness = makeUsageLimitFailoverHarness({
        messageCreatedBy: "user",
        messageCreationSource: "web",
        providerInstances: {
          [accountA]: { driver: codexDriver, enabled: true, allowBackground: false },
          [accountB]: { driver: codexDriver, enabled: true },
        },
      });
      yield* interactiveHarness.start;
      expect(interactiveHarness.openedInstances).toEqual([accountA]);
      expect(interactiveHarness.startedTurns).toEqual([
        { instanceId: accountA, text: "Fix the parser bug" },
      ]);

      // In-run failover queries accountsWithRoom with background: true so reserved accounts are never chosen.
      const failoverHarness = makeUsageLimitFailoverHarness({
        openUsageLimitInstances: new Set([accountA]),
        accountsWithRoom: [{ instanceId: accountB, model: "gpt-5.4" }],
      });
      yield* failoverHarness.start;
      expect(failoverHarness.accountsWithRoom).toHaveBeenCalledWith(
        expect.objectContaining({ background: true }),
      );
    }),
);
