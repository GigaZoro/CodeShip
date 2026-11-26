// @effect-diagnostics nodeBuiltinImport:off -- The release CLI reads its thread bindings from SQLite.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AccountRouting from "./AccountRouting.ts";
import { linkDirectory } from "@t3tools/shared/testing/symlinks";
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
  GuestMessageId,
  GuestShareId,
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
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { AwakeSinceWake } from "@t3tools/shared/AwakeTime";
import { gitOutputLine } from "@t3tools/shared/git";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
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
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Command } from "effect/cli";

import { threadCommand } from "../cli/thread.ts";
import * as ServerConfig from "../config.ts";
import {
  decodeReleaseRequest,
  listWorktreeBackups,
  queueWorktreeRelease,
  releaseHold,
  releasePath,
  restoreStagedWindowsCheckout,
  worktreeReleaseName,
} from "../workspace/worktreeRelease.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { releaseDigest } from "../workspace/worktreeReleaseReceipt.ts";
import {
  sealSetupMarkers,
  sealSetupTrees,
  setupFileStamp,
  writeSetupProof,
} from "../../../../scripts/lib/worktree-setup-proof.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  familyHookOperation,
  pendingFamilyCheckoutHook,
  runningFamilyCheckoutHook,
} from "../vcs/familyWorktreeCheckout.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { prepareLinkedWorktreeRemoval, windowsRemovalStage } from "../vcs/worktreeRemoval.ts";
import { withWorkspaceProcessStart } from "../workspace/workspaceLease.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
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
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { sleepingTestClock } from "./testkit/DeterministicRuntime.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);
const decodeCommand = Schema.decodeEffect(OrchestrationV2Command);
const encodeShellBranch = Schema.encodeEffect(OrchestrationV2ThreadShell.fields.branch);
const decodeAppBranch = Schema.decodeEffect(OrchestrationV2AppThread.fields.branch);

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
  stateDir = `${worktreesDir}/../state`,
) =>
  Layer.mergeAll(
    pathLayer,
    Layer.mock(ServerConfig.ServerConfig)({
      worktreesDir,
      stateDir,
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
        WorktreeSetupTracker.layer,
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
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
          listActiveCommandCwds: () => Effect.succeed([]),
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
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          occupiedWorkspaces: Effect.succeed([]),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          activeWorkspaces: Effect.succeed([]),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () =>
            Effect.succeed({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: worktreePath,
            }),
        }),
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
  readonly stateDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly gitWorkflowMock?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
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
  /** A restart cut this run before its provider turn was recorded, and it starts again. */
  readonly restartRetry?: RestartRetryDelivery;
  /** The thread's provider session was already running when this turn started. */
  readonly sessionLive?: boolean;
  /** Account routing says this turn would spend prepaid credits the user did not allow it. */
  readonly creditRefusal?: AccountRouting.CreditRefusal;
  readonly activeTerminalWorkspaces?: ReadonlyArray<string>;
  readonly activeCommandCwds?: ReadonlyArray<string>;
  readonly occupiedWorkspaces?: ReadonlyArray<string>;
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
  const resolveRuntimePolicy = vi.fn<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>(({ thread }) =>
    Effect.succeed({
      cwd: thread.worktreePath ?? "/tmp/native-account-command",
      runtimeMode: thread.runtimeMode,
    } as never),
  );
  const getProject = vi.fn<ProjectService.ProjectService["Service"]["getById"]>(() =>
    Effect.succeedSome({
      workspaceRoot: input.workspaceRoot ?? "/tmp/native-account-project",
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
    Layer.provideMerge(WorktreeSetupTracker.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)(
          input.runSetup ? { runForThread: input.runSetup } : {},
        ),
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
        layerWorktreeLocation(
          input.worktreesDir,
          input.skillFailure,
          NodePath.layer,
          input.stateDir,
        ),
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
          ? FileSystem.layerNoop({
              exists: (target) =>
                Effect.succeed(!target.endsWith(ServerConfig.WORKTREE_RELEASE_DIRECTORY)),
            })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        input.gitWorkflow === undefined
          ? Layer.mock(GitWorkflow.GitWorkflowService)(
              input.gitWorkflowMock ?? {
                pruneWorktrees: () => Effect.void,
                listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
                currentBranch: () => Effect.succeed("feature/restore"),
                createWorktree,
              },
            )
          : Layer.succeed(GitWorkflow.GitWorkflowService, input.gitWorkflow),
        Layer.mock(ProjectService.ProjectService)({ getById: getProject }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getUsageLimitedProviderInstances: () =>
            input.limitsReadFailure
              ? Effect.fail(
                  new ProjectionStore.ProjectionStoreSetupError({
                    cause: new Error("database unavailable"),
                  }),
                )
              : Effect.succeed(new Map()),
          listActiveCommandCwds: () => Effect.succeed(input.activeCommandCwds ?? []),
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
        Layer.mock(TerminalManager.TerminalManager)({
          activeWorkspaces: Effect.succeed(input.activeTerminalWorkspaces ?? []),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          occupiedWorkspaces: Effect.succeed(input.occupiedWorkspaces ?? []),
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
    getProject,
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
    withRuntime: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
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

effectIt.live(
  "recovers the local or pushed thread tip, else the current branch, remote default, or detached HEAD",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-recreate-repo-" }),
      );
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
        "released-diverged-and-deleted": {
          tip: threadTip,
          file: "thread.txt",
          upstream: null,
          base: "",
        },
        "released-async": { tip: projectTip, file: "project.txt", upstream: null, base: "" },
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
        const asyncSetup = scenario === "released-async";
        const archived = scenario === "released-diverged-and-deleted";
        const released = scenario === "released" || asyncSetup || archived;
        const setupResult =
          yield* Deferred.make<ProjectSetupScriptRunner.ProjectSetupScriptCompletion>();
        let receipt: string | undefined;
        if (released) {
          yield* git(worktreePath, ["reset", "--hard", archived ? threadTip : baseTip]);
          if (archived)
            yield* git(workspaceRoot, ["update-ref", "refs/archive/previous-task", threadTip]);
          const { file: request } = yield* queueWorktreeRelease({
            threadId: "thread-native-account-command",
            runId: "finished",
            worktreePath,
            durableRef: archived ? "refs/archive/previous-task" : "refs/heads/project-current",
            stateDir: path.join(root, "state"),
          });
          receipt = request;
          if (scenario === "released") {
            const current = JSON.parse(yield* fileSystem.readFileString(request));
            const savedFiles = path.join(path.dirname(request), "saved-legacy");
            yield* fileSystem.makeDirectory(savedFiles);
            yield* fileSystem.writeFileString(path.join(savedFiles, "private.txt"), "old backup");
            yield* fileSystem.writeFileString(
              request + ".setup",
              JSON.stringify({
                ...current,
                runId: "obsolete-release",
                head: threadTip,
                savedFiles,
                savedAllocatedBytes: 4096,
              }),
            );
          }
          yield* fileSystem.rename(request, request + ".released");
        }
        yield* fileSystem.remove(worktreePath, { recursive: true });
        if (scenario !== "retained" && (!released || archived)) {
          yield* git(workspaceRoot, ["worktree", "prune"]);
          yield* git(workspaceRoot, ["branch", "-D", "feature/restore"]);
        }
        let setupCalls = 0;
        let interruptRecreation = scenario === "released";
        const harness = makeLocalCommandHarness({
          text: "Continue",
          workspaceRoot,
          worktreePath,
          worktreesDir,
          fileSystem,
          gitWorkflow: {
            ...gitWorkflow,
            createWorktree: (...args) =>
              gitWorkflow.createWorktree(...args).pipe(
                Effect.flatMap((result) => {
                  if (!interruptRecreation) return Effect.succeed(result);
                  interruptRecreation = false;
                  return Effect.interrupt;
                }),
              ),
          },
          failReadsAfterRunning: true,
          runSetup: (input) =>
            withWorkspaceLease(
              worktreePath,
              Effect.gen(function* () {
                expect(released).toBe(true);
                expect(input.worktreePath).toBe(worktreePath);
                expect(input.projectCwd).toBe(workspaceRoot);
                expect(yield* fileSystem.exists(path.join(worktreePath, expected.file!))).toBe(
                  true,
                );
                setupCalls++;
                if (asyncSetup || archived || setupCalls > 2) {
                  yield* fileSystem.writeFileString(path.join(worktreePath, "setup-ran"), "ready");
                }
                return {
                  status: "started",
                  scriptId: "install",
                  scriptName: "Install",
                  scriptCommand: "install",
                  terminalId: "setup-install",
                  cwd: worktreePath,
                  async: asyncSetup,
                  completion: asyncSetup
                    ? Deferred.await(setupResult)
                    : Effect.succeed({
                        exitCode: !archived && setupCalls <= 2 ? 2 : 0,
                        durationMs: 0,
                      }),
                } as const;
              }),
            ).pipe(Effect.orDie),
        });
        const open = harness.open.getMockImplementation()!;
        harness.open.mockImplementation(() =>
          Effect.gen(function* () {
            expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature/restore");
            expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(expected.tip);
            expect(yield* fileSystem.exists(path.join(worktreePath, "setup-ran"))).toBe(released);
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
            if (archived) expect(yield* branchConfig("t3-merge-base-ref")).toBe("");
            return yield* open();
          }).pipe(Effect.orDie),
        );

        if (asyncSetup) {
          yield* harness.withRuntime(
            Effect.gen(function* () {
              const starter = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
              const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
              const { thread, runs } = harness.projection();
              const start = starter.start({ threadId: thread.id, runId: runs[0]!.id });
              const original = harness.projection();
              yield* start;
              expect(harness.open).toHaveBeenCalledOnce();
              expect((yield* tracker.get(thread.id))?.phase).toBe("running");
              harness.setProjection(original);
              yield* start;
              expect(setupCalls).toBe(1);
              expect(harness.startRootRun).toHaveBeenCalledTimes(2);
              yield* Deferred.succeed(setupResult, { exitCode: 2, durationMs: 0 });
              const snapshot = yield* tracker.stream(thread.id).pipe(
                Stream.filter((snapshot) => snapshot?.phase === "failed"),
                Stream.runHead,
              );
              expect(Option.getOrUndefined(snapshot)).toMatchObject({
                phase: "failed",
                error: expect.stringContaining("Install exited with 2"),
                setupScript: expect.objectContaining({ name: "Install", command: "install" }),
                stages: [
                  { id: "setup-script", status: "failed" },
                  { id: "agent", status: "done" },
                ],
              });
              const diagnostic = Option.getOrUndefined(snapshot)?.error;
              for (const detail of [
                worktreePath,
                "feature/restore",
                receipt + ".setup",
                "Actions",
                "follow-up",
              ])
                expect(diagnostic).toContain(detail);
              expect(yield* fileSystem.exists(receipt + ".setup")).toBe(true);
              yield* git(worktreePath, ["switch", "-c", "user-branch"]);
              for (const branch of ["user-branch", ""]) {
                if (branch === "") yield* git(worktreePath, ["switch", "--detach"]);
                harness.setProjection(original);
                yield* start;
                expect(harness.projection().runs.at(-1)?.status).toBe("failed");
                const item = harness
                  .projection()
                  .turnItems.findLast((item) => item.type === "error");
                for (const detail of [
                  branch || "detached HEAD",
                  "feature/restore",
                  worktreePath,
                  receipt + ".setup",
                ])
                  expect(item?.failure?.message).toContain(detail);
                expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe(branch);
                expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(projectTip);
                expect(yield* fileSystem.exists(receipt + ".setup")).toBe(true);
              }
              expect(setupCalls).toBe(1);
              yield* git(worktreePath, ["switch", "feature/restore"]);
              yield* fileSystem.remove(receipt + ".setup");
            }),
          );
          continue;
        }
        if (scenario === "released") {
          const original = harness.projection();
          const interrupted = yield* Effect.exit(harness.startWithRetry);
          expect(interrupted._tag).toBe("Failure");
          if (interrupted._tag === "Failure")
            expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
          expect(setupCalls).toBe(0);
          expect(JSON.parse(yield* fileSystem.readFileString(receipt + ".setup")).runId).toBe(
            "finished",
          );
          yield* harness.startWithRetry;
          expect(harness.projection().runs.at(-1)?.status).toBe("failed");
          yield* harness.startWithRetry;
          expect(setupCalls).toBe(1);
          expect(harness.open).not.toHaveBeenCalled();
          expect(yield* fileSystem.exists(worktreePath)).toBe(true);
          expect(yield* fileSystem.exists(receipt + ".released")).toBe(false);
          expect(yield* fileSystem.exists(receipt + ".setup")).toBe(true);
          yield* fileSystem.writeFileString(
            path.join(worktreePath, "local.txt"),
            "retain on retry",
          );
          harness.setProjection(original);
          yield* harness.startWithRetry;
          expect(setupCalls).toBe(2);
          expect(yield* fileSystem.exists(receipt + ".setup")).toBe(true);
          const item = harness.projection().turnItems.findLast((item) => item.type === "error");
          expect(item?.failure?.message).toContain(receipt + ".setup");
          expect(harness.open).not.toHaveBeenCalled();
          harness.setProjection(original);
        }
        yield* harness.start;
        if (scenario === "released") {
          expect(yield* fileSystem.readFileString(path.join(worktreePath, "local.txt"))).toBe(
            "retain on retry",
          );
          expect(setupCalls).toBe(3);
          expect(yield* fileSystem.exists(receipt + ".setup")).toBe(false);
          const backups = yield* listWorktreeBackups(path.join(root, "state"));
          expect(backups).toEqual([
            expect.objectContaining({
              runId: "obsolete-release",
              worktreePath,
              savedAllocatedBytes: 4096,
            }),
          ]);
          expect(
            yield* fileSystem.readFileString(path.join(backups[0]!.savedFiles, "private.txt")),
          ).toBe("old backup");
        }

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

effectIt.live.each([
  "deleted branch",
  "owner recreated the branch",
  "legacy base setting",
  "singleton deleted branch",
  "singleton owner recreated the branch",
  "local base ref",
  "significant Unicode branch suffix",
  "significant Unicode base suffix",
] as const)(
  "preserves the recorded pull request base from CLI release through provider start: %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* releasePath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-pr-base-" }),
      );
      const workspaceRoot = path.join(root, "project");
      const baseDir = path.join(root, "server");
      const { dbPath, stateDir, worktreesDir } = yield* ServerConfig.deriveServerPaths(
        baseDir,
        undefined,
      );
      const worktreePath = path.join(worktreesDir, "project", "feature-restore");
      const plainBranch = "feature/restore";
      const unicode = scenario === "significant Unicode branch suffix";
      const branch = unicode ? plainBranch + "\u00a0" : plainBranch;
      const unicodeBase = scenario === "significant Unicode base suffix";
      const base = unicodeBase ? "release/1.2\u00a0" : "release/1.2";
      const baseRef =
        scenario === "local base ref" ? "refs/heads/" + base : "refs/remotes/upstream/" + base;
      const archive = "refs/archive/pr-base-task";
      const git = (cwd: string, args: string[]) =>
        driver
          .execute({ operation: "test.releasePrBase", cwd, args })
          .pipe(Effect.map((result) => gitOutputLine(result.stdout)));
      const config = (key: string) => `branch.${branch}.${key}`;
      const readBase = () =>
        Effect.forEach(["t3-merge-base", "t3-merge-base-ref"], (key) =>
          driver
            .execute({
              operation: "test.readPrBase",
              cwd: workspaceRoot,
              args: ["config", "--local", "--get-all", config(key)],
              allowNonZeroExit: true,
            })
            .pipe(
              Effect.map(({ exitCode, stdout }) => {
                expect([0, 1]).toContain(exitCode);
                return exitCode === 1 ? null : gitOutputLine(stdout);
              }),
            ),
        );
      yield* git(root, ["init", "-b", "main", workspaceRoot]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "README"), "shared history\n");
      yield* git(workspaceRoot, ["add", "README"]);
      yield* git(workspaceRoot, ["commit", "-m", "common root"]);
      const common = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      yield* git(root, ["init", "--bare", path.join(root, "upstream.git")]);
      yield* git(workspaceRoot, ["remote", "add", "upstream", path.join(root, "upstream.git")]);
      yield* git(workspaceRoot, ["switch", "-c", base]);
      yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "release branch base"]);
      yield* git(workspaceRoot, ["push", "upstream", base]);
      yield* git(workspaceRoot, ["switch", "main"]);
      yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "diverged default"]);
      const main = yield* git(workspaceRoot, ["rev-parse", "HEAD"]);
      if (unicode) yield* git(workspaceRoot, ["branch", plainBranch, main]);
      if (unicodeBase) {
        yield* git(workspaceRoot, ["push", "upstream", "main:refs/heads/release/1.2"]);
      }
      yield* gitWorkflow.createWorktree({
        cwd: workspaceRoot,
        refName: baseRef,
        baseRefName: baseRef,
        newRefName: branch,
        path: worktreePath,
      });
      yield* git(worktreePath, ["commit", "--allow-empty", "-m", "archived pull request"]);
      const tip = yield* git(worktreePath, ["rev-parse", "HEAD"]);
      yield* git(workspaceRoot, ["update-ref", archive, tip]);
      expect(yield* git(workspaceRoot, ["merge-base", "main", archive])).toBe(common);
      if (scenario === "local base ref")
        yield* git(workspaceRoot, ["config", config("t3-merge-base-ref"), baseRef]);
      expect(yield* readBase()).toEqual([base, baseRef]);
      const legacy = scenario === "legacy base setting";
      if (legacy) {
        yield* git(workspaceRoot, ["config", "--unset", config("t3-merge-base")]);
        yield* git(workspaceRoot, ["config", "--unset", config("t3-merge-base-ref")]);
        yield* git(workspaceRoot, ["config", config("gh-merge-base"), base]);
      }

      const harness = makeLocalCommandHarness({
        text: "Continue",
        nativeTurn: true,
        workspaceRoot,
        worktreePath,
        worktreesDir,
        stateDir,
        fileSystem: fs,
        gitWorkflow,
        runSetup: () => Effect.succeed({ status: "no-script" as const }),
      });
      const { thread } = harness.projection();
      yield* fs.makeDirectory(stateDir, { recursive: true });
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath)),
        (db) => Effect.sync(() => db.close()),
      );
      db.exec(`
      CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, payload_json TEXT, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, run_id TEXT, ordinal INTEGER);
    `);
      const singleton = scenario.startsWith("singleton ");
      for (const id of singleton ? [thread.id] : [thread.id, "child"]) {
        db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, NULL)").run(
          id,
          thread.projectId,
          JSON.stringify({
            worktreePath,
            branch: unicode ? plainBranch : branch,
            lineage:
              id === thread.id
                ? thread.lineage
                : {
                    rootThreadId: thread.id,
                    parentThreadId: thread.id,
                    relationshipToParent: "subagent",
                  },
          }),
        );
        db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, 1)").run(
          id,
          id + "-finished",
        );
      }
      const file = path.join(
        stateDir,
        ServerConfig.WORKTREE_RELEASE_DIRECTORY,
        worktreeReleaseName(worktreePath),
      );
      const queueRelease = Command.runWith(threadCommand, { version: "0.0.0" })([
        "release-worktree",
        thread.id,
        "--run",
        thread.id + "-finished",
        "--worktree",
        worktreePath,
        "--durable-ref",
        archive,
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provide(
          Layer.merge(NetService.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        ),
      );
      if (unicode) {
        // Both refs exist. An old projection cannot authorize the differently named checkout.
        const hold = yield* Effect.flip(queueRelease);
        expect(hold).toMatchObject({
          detail: "Only the root of the exact checkout family can release its current run.",
        });
        expect(yield* fs.exists(file)).toBe(false);
        const update = yield* decodeCommand({
          type: "thread.metadata.update",
          commandId: "save-exact-branch",
          threadId: thread.id,
          branch,
        });
        if (update.type !== "thread.metadata.update") throw new Error("Expected a branch update");
        const storedBranch = yield* encodeShellBranch(update.branch ?? null);
        db.prepare(
          "UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.branch',?)",
        ).run(storedBranch);
        harness.setProjection({
          ...harness.projection(),
          thread: {
            ...thread,
            branch: yield* decodeAppBranch(storedBranch),
          },
        });
      }
      yield* queueRelease;
      const request = yield* decodeReleaseRequest(yield* fs.readFileString(file));
      expect(request.branch).toBe(branch);
      if (singleton) expect(request.family).toBeUndefined();
      else expect(request.family).toHaveLength(2);
      expect(yield* releaseHold(request, workspaceRoot)).toBeNull();
      yield* fs.rename(file, file + ".releasing");
      yield* git(workspaceRoot, ["worktree", "remove", worktreePath]);
      yield* fs.rename(file + ".releasing", file + ".released");
      if (unicode) {
        const saved = harness.projection();
        harness.setProjection({ ...saved, thread: { ...saved.thread, branch: plainBranch } });
        yield* harness.start;
        expect(harness.open).not.toHaveBeenCalled();
        expect(yield* fs.exists(worktreePath)).toBe(false);
        expect(yield* fs.exists(file + ".released")).toBe(true);
        harness.setProjection(saved);
      } else {
        yield* git(workspaceRoot, ["branch", "-D", branch]);
        expect(yield* readBase()).toEqual([null, null]);
        expect(yield* git(workspaceRoot, ["branch", "--list", branch])).toBe("");
      }

      const expectedBase = scenario.endsWith("owner recreated the branch")
        ? (["release/2.0", "refs/remotes/upstream/release/2.0"] as const)
        : ([base, baseRef] as const);
      if (scenario.endsWith("owner recreated the branch")) {
        yield* git(workspaceRoot, ["push", "upstream", "main:refs/heads/release/2.0"]);
        yield* git(workspaceRoot, ["branch", branch, archive]);
        yield* git(workspaceRoot, ["config", config("t3-merge-base"), expectedBase[0]]);
        yield* git(workspaceRoot, ["config", config("t3-merge-base-ref"), expectedBase[1]]);
      }
      yield* harness.start;
      expect(harness.open).toHaveBeenCalledOnce();
      expect(harness.startTurn).toHaveBeenCalledOnce();
      expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(tip);
      expect(yield* git(worktreePath, ["symbolic-ref", "HEAD"])).toBe("refs/heads/" + branch);
      if (unicode) {
        expect(yield* gitWorkflow.currentBranch(worktreePath)).toBe(branch);
        expect(yield* git(workspaceRoot, ["rev-parse", "refs/heads/" + plainBranch])).toBe(main);
      }
      expect(yield* readBase()).toEqual(legacy ? [null, null] : expectedBase);
      if (unicodeBase) expect(yield* driver.readBranchBase(workspaceRoot, branch)).toBe(base);
      expect(yield* driver.readConfigValue(workspaceRoot, config("gh-merge-base"))).toBe(
        legacy ? base : null,
      );
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

for (const scenario of [
  "new fork",
  "new side chat",
  "unrelated thread",
  "unrelated thread under an alias with a missing parent",
  "different lineage root",
  "setup pending for a new side chat",
  "setup pending for an unrelated thread",
  "setup pending in another repository",
  "complete checkout",
  "no checkout",
  "index without files",
  "partially restored tracked files",
  "partially restored with an edited file",
  "interrupted with local files",
  "unrelated repository",
  "released with a foreign checkout",
  "released with a local file",
  "project read failed before restore",
  "released with an empty directory",
  "removal interrupted with the original checkout",
  "removal interrupted with a saved backup",
  "removal interrupted with a missing saved file",
  "removal interrupted with a missing saved root",
  "removal interrupted with a missing tracked file",
  "removal interrupted with replaced Git metadata",
  "removal interrupted after the branch moved",
] as const) {
  effectIt.effect(`restores a released family checkout safely: ${scenario}`, () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-family-restore-" }),
      );
      const workspaceRoot = path.join(root, "project");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const branch = "feature/restore";
      const git = (cwd: string, args: string[]) =>
        driver.execute({ operation: "test.familyRestore", cwd, args });
      yield* fileSystem.makeDirectory(workspaceRoot);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "tracked"), "from Git");
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "remaining"), "second file");
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "base"]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", branch, worktreePath]);

      const setupPending = scenario.startsWith("setup pending");
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const aliasWithMissingParent =
        scenario === "unrelated thread under an alias with a missing parent";
      const alias = path.join(root, "saved-worktrees");
      if (aliasWithMissingParent) yield* linkDirectory(worktreesDir, alias);
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreesDir,
        worktreePath: aliasWithMissingParent
          ? path.join(alias, "project", "restore")
          : worktreePath,
        workspaceRoot,
        fileSystem,
        gitWorkflow,
        runSetup,
        failReadsAfterRunning: true,
      });
      const projection = harness.projection();
      const actor = projection.thread.id;
      const owner = ThreadId.make("original-owner");
      const unrelatedThread =
        scenario === "unrelated thread" ||
        scenario === "setup pending for an unrelated thread" ||
        aliasWithMissingParent;
      const isNewThread =
        unrelatedThread ||
        [
          "new fork",
          "new side chat",
          "different lineage root",
          "setup pending for a new side chat",
        ].includes(scenario);
      const originalChild = isNewThread ? ThreadId.make("original-child") : actor;
      const childLineage = {
        parentThreadId: owner,
        relationshipToParent: "subagent" as const,
        rootThreadId: owner,
      };
      const hasBackup =
        scenario === "removal interrupted with a saved backup" ||
        scenario.startsWith("removal interrupted with a missing saved");
      const ignoredDir = path.join(worktreePath, "private-cache");
      if (hasBackup) {
        yield* fileSystem.writeFileString(
          path.join(workspaceRoot, ".git/info/exclude"),
          "private-cache/\n",
        );
        yield* fileSystem.makeDirectory(ignoredDir);
        yield* fileSystem.writeFileString(path.join(ignoredDir, "settings"), "private data");
        yield* fileSystem.writeFileString(path.join(ignoredDir, "cache"), "other data");
      }
      const { file, savedFiles } = yield* queueWorktreeRelease({
        threadId: owner,
        runId: "finished",
        worktreePath,
        durableRef: "refs/heads/main",
        stateDir: path.join(root, "state"),
        saveIgnored: hasBackup,
      });
      const request = yield* decodeReleaseRequest(yield* fileSystem.readFileString(file));
      const removalInterrupted = scenario.startsWith("removal interrupted");
      const intactRemoval =
        scenario === "removal interrupted with the original checkout" ||
        scenario === "removal interrupted with a saved backup";
      if (hasBackup) {
        // An older release may hold the only pointer to the private backup in its claim.
        yield* fileSystem.remove(savedFiles + ".json");
        if (scenario === "removal interrupted with a saved backup")
          yield* fileSystem.writeFileString(
            path.join(worktreePath, "new-note"),
            "owner's new note",
          );
        if (scenario === "removal interrupted with a missing saved file")
          yield* fileSystem.remove(path.join(ignoredDir, "settings"));
        if (scenario === "removal interrupted with a missing saved root")
          yield* fileSystem.remove(ignoredDir, { recursive: true });
      }
      const partialRestore = scenario.startsWith("partially restored");
      const newlyReleased = isNewThread || scenario.startsWith("released with");
      const receipt =
        file +
        (setupPending
          ? ".setup"
          : removalInterrupted
            ? ".releasing"
            : newlyReleased
              ? ".released"
              : ".restoring");
      yield* fileSystem.writeFileString(
        file,
        JSON.stringify({
          ...request,
          family: [
            {
              threadId: owner,
              runId: "finished",
              projectId: projection.thread.projectId,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner },
            },
            {
              threadId: originalChild,
              runId: "child-run",
              projectId: projection.thread.projectId,
              lineage: childLineage,
            },
          ],
        }),
      );
      yield* fileSystem.rename(file, receipt);
      if (!removalInterrupted) yield* git(workspaceRoot, ["worktree", "remove", worktreePath]);
      if (aliasWithMissingParent)
        yield* fileSystem.remove(path.dirname(worktreePath), { recursive: true });
      const lineage = !isNewThread
        ? childLineage
        : unrelatedThread
          ? projection.thread.lineage
          : {
              parentThreadId: owner,
              relationshipToParent: "fork" as const,
              rootThreadId: scenario === "different lineage root" ? actor : owner,
              ...(["new side chat", "setup pending for a new side chat"].includes(scenario)
                ? { sideChat: true }
                : {}),
            };
      harness.setProjection({ ...projection, thread: { ...projection.thread, lineage } });

      if (
        [
          "unrelated repository",
          "released with a foreign checkout",
          "setup pending in another repository",
        ].includes(scenario)
      ) {
        const otherRepo = path.join(root, "other-project");
        yield* git(root, ["clone", "--quiet", workspaceRoot, otherRepo]);
        yield* git(otherRepo, ["worktree", "add", "-b", branch, worktreePath]);
      } else if (
        scenario === "released with a local file" ||
        scenario === "released with an empty directory"
      ) {
        yield* fileSystem.makeDirectory(worktreePath);
        if (scenario === "released with a local file")
          yield* fileSystem.writeFileString(path.join(worktreePath, "tracked"), "local copy");
      } else if (setupPending || (!isNewThread && !removalInterrupted)) {
        yield* git(workspaceRoot, [
          "worktree",
          "add",
          ...(setupPending || scenario === "complete checkout" || partialRestore
            ? []
            : ["--no-checkout"]),
          worktreePath,
          branch,
        ]);
      }
      if (scenario === "setup pending for a new side chat")
        yield* fileSystem.writeFileString(path.join(worktreePath, "tracked"), "local setup edit");
      if (scenario === "index without files") yield* git(worktreePath, ["read-tree", "HEAD"]);
      if (scenario === "removal interrupted with a missing tracked file" || partialRestore)
        yield* fileSystem.remove(path.join(worktreePath, "remaining"));
      if (scenario === "removal interrupted with replaced Git metadata") {
        const pointer = path.join(worktreePath, ".git");
        yield* fileSystem.writeFileString(
          pointer + ".new",
          yield* fileSystem.readFileString(pointer),
        );
        yield* fileSystem.rename(pointer + ".new", pointer);
      }
      if (scenario === "removal interrupted after the branch moved")
        yield* git(worktreePath, ["commit", "--allow-empty", "-m", "later work"]);
      if (
        scenario === "interrupted with local files" ||
        scenario === "partially restored with an edited file"
      )
        yield* fileSystem.writeFileString(path.join(worktreePath, "tracked"), "local copy");
      if (scenario === "project read failed before restore") {
        harness.getProject.mockReturnValueOnce(
          Effect.fail(
            new ProjectService.ProjectOperationError({ operation: "read-project", cause: "busy" }),
          ),
        );
        const retry = yield* Effect.result(harness.startWithRetry);
        expect(retry).toMatchObject({
          _tag: "Failure",
          failure: {
            cause: { _tag: "WorktreeRecreateError", cause: { _tag: "ProjectOperationError" } },
          },
        });
        expect(harness.open).not.toHaveBeenCalled();
        expect(yield* fileSystem.exists(receipt)).toBe(true);
      }
      yield* scenario === "released with a local file" ? harness.startWithRetry : harness.start;
      if (
        (removalInterrupted && !intactRemoval) ||
        scenario === "partially restored with an edited file" ||
        scenario === "released with a foreign checkout" ||
        scenario === "released with a local file" ||
        scenario === "unrelated repository" ||
        scenario === "setup pending in another repository" ||
        scenario === "interrupted with local files" ||
        unrelatedThread ||
        scenario === "different lineage root"
      ) {
        expect(yield* fileSystem.exists(receipt)).toBe(true);
        expect(harness.open).not.toHaveBeenCalled();
        expect(runSetup).not.toHaveBeenCalled();
        if (aliasWithMissingParent) expect(yield* fileSystem.exists(worktreePath)).toBe(false);
        if (removalInterrupted || scenario.startsWith("released with")) {
          expect(harness.projection().turnItems.at(-1)).toMatchObject({
            failure: {
              message: expect.stringContaining(
                removalInterrupted ? "removal was interrupted" : "already occupied",
              ),
            },
          });
        }
        if (hasBackup) {
          expect(
            yield* fileSystem.readFileString(path.join(savedFiles!, "private-cache/settings")),
          ).toBe("private data");
          expect(yield* fileSystem.exists(path.join(ignoredDir, "settings"))).toBe(false);
        }
        if (scenario === "removal interrupted with a missing tracked file")
          expect(yield* fileSystem.exists(path.join(worktreePath, "remaining"))).toBe(false);
        if (
          scenario === "interrupted with local files" ||
          scenario === "partially restored with an edited file" ||
          scenario === "released with a local file"
        )
          expect(yield* fileSystem.readFileString(path.join(worktreePath, "tracked"))).toBe(
            "local copy",
          );
      } else {
        expect(yield* fileSystem.readFileString(path.join(worktreePath, "remaining"))).toBe(
          "second file",
        );
        expect(yield* fileSystem.readFileString(path.join(worktreePath, "tracked"))).toBe(
          scenario === "setup pending for a new side chat" ? "local setup edit" : "from Git",
        );
        expect(runSetup).toHaveBeenCalledTimes(intactRemoval ? 0 : 1);
        expect(yield* fileSystem.exists(receipt)).toBe(false);
        if (savedFiles) {
          const withdrawn = (yield* fileSystem.readDirectory(path.dirname(receipt))).filter(
            (name) => name.endsWith(".withdrawn"),
          );
          expect(withdrawn).toHaveLength(1);
          const savedRequest = yield* decodeReleaseRequest(
            yield* fileSystem.readFileString(path.join(path.dirname(receipt), withdrawn[0]!)),
          );
          expect(savedRequest.savedFiles).toBe(savedFiles);
          expect(yield* fileSystem.readFileString(path.join(worktreePath, "new-note"))).toBe(
            "owner's new note",
          );
          // A withdrawn claim from an older server is discoverable without a separate backup index.
          yield* fileSystem.remove(savedFiles + ".json");
          expect(yield* listWorktreeBackups(path.join(root, "state"))).toMatchObject([
            { savedFiles, threadId: owner, runId: "finished" },
          ]);
          expect(yield* fileSystem.readFileString(path.join(ignoredDir, "settings"))).toBe(
            "private data",
          );
        }
        expect(harness.open).toHaveBeenCalledOnce();
      }
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
  );
}

effectIt.effect(
  "starts a new checkout at a released family's path only for its own project and branch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-reallocation-" }),
      );
      const project = path.join(root, "project");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "feature-restore");
      const git = (cwd: string, args: string[]) =>
        driver.execute({ operation: "test.reallocation", cwd, args });
      yield* fs.makeDirectory(project);
      yield* git(project, ["init", "-b", "main"]);
      yield* git(project, ["config", "user.name", "Test"]);
      yield* git(project, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(project, "tracked"), "base");
      yield* git(project, ["add", "tracked"]);
      yield* git(project, ["commit", "-m", "base"]);
      yield* git(project, ["worktree", "add", "-b", "feature/restore", worktreePath]);
      const owner = ThreadId.make("released-owner");
      const { file } = yield* queueWorktreeRelease({
        threadId: owner,
        runId: "finished",
        worktreePath,
        durableRef: "refs/heads/main",
        stateDir: path.join(root, "state"),
      });
      const request = yield* decodeReleaseRequest(yield* fs.readFileString(file));
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const makeHarness = (workspaceRoot: string) =>
        makeLocalCommandHarness({
          text: "Continue",
          nativeTurn: true,
          worktreesDir,
          worktreePath,
          workspaceRoot,
          fileSystem: fs,
          gitWorkflow,
          runSetup,
        });
      const { projectId } = makeHarness(project).projection().thread;
      const contents = JSON.stringify({
        ...request,
        family: [
          {
            threadId: owner,
            runId: "finished",
            projectId,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: owner },
          },
          {
            threadId: "released-child",
            runId: "finished-child",
            projectId,
            lineage: {
              parentThreadId: owner,
              relationshipToParent: "subagent",
              rootThreadId: owner,
            },
          },
        ],
      });
      yield* fs.writeFileString(file, contents);
      yield* fs.rename(file, file + ".released");
      const start = Effect.fnUntraced(function* (
        workspaceRoot: string,
        branch: string,
        caller: "new owner" | "original family" | "read-only" = "new owner",
      ) {
        const harness = makeHarness(workspaceRoot);
        const projection = harness.projection();
        harness.setProjection({
          ...projection,
          thread: {
            ...projection.thread,
            branch,
            projectId: workspaceRoot === project ? projectId : ProjectId.make("new-project"),
            ...(caller === "original family"
              ? {
                  lineage: {
                    parentThreadId: owner,
                    relationshipToParent: "fork" as const,
                    rootThreadId: owner,
                  },
                }
              : {}),
          },
          runs: projection.runs.map((run) =>
            caller === "read-only" ? { ...run, readOnlyGuestShare: true } : run,
          ),
        });
        yield* harness.start;
        expect(harness.startTurn.mock.calls).toHaveLength(harness.open.mock.calls.length);
        return harness.startTurn.mock.calls.length;
      });
      yield* git(worktreePath, ["switch", "-c", "renamed-original"]);
      const pointer = path.join(worktreePath, ".git");
      // Git hides this file on Windows. Open the existing pointer without creating or truncating it.
      yield* fs.writeFile(pointer, yield* fs.readFile(pointer), { flag: "r+" });
      expect(yield* start(project, "renamed-original")).toBe(0);
      yield* git(project, ["worktree", "remove", worktreePath]);
      yield* git(project, ["worktree", "add", worktreePath, "feature/restore"]);
      expect(yield* start(project, "feature/restore")).toBe(0);
      yield* git(project, ["worktree", "remove", worktreePath]);
      yield* git(project, [
        "worktree",
        "add",
        "--no-checkout",
        "-b",
        "feature-restore",
        worktreePath,
      ]);
      expect(yield* start(project, "feature-restore")).toBe(0);
      expect(yield* fs.exists(path.join(worktreePath, "tracked"))).toBe(false);
      yield* git(worktreePath, ["reset", "--hard", "HEAD"]);
      yield* fs.writeFileString(path.join(worktreePath, "tracked"), "new owner's edit");
      const otherProject = path.join(root, "other-project");
      yield* git(root, ["clone", "--quiet", project, otherProject]);
      for (const suffix of [".releasing", ".restoring", ".setup"]) {
        yield* fs.rename(file + ".released", file + suffix);
        expect(yield* start(project, "feature-restore")).toBe(0);
        yield* fs.rename(file + suffix, file + ".released");
      }
      expect(yield* start(otherProject, "feature-restore")).toBe(0);
      expect(yield* start(project, "feature/restore")).toBe(0);
      expect(yield* start(project, "feature/restore", "original family")).toBe(0);
      expect(yield* start(project, "feature-restore", "original family")).toBe(0);
      yield* fs.writeFileString(
        file + ".released",
        JSON.stringify({ ...(yield* decodeReleaseRequest(contents)), identity: "unknown" }),
      );
      expect(yield* start(project, "feature-restore")).toBe(0);
      yield* fs.writeFileString(file + ".released", contents);
      expect(yield* start(project, "feature-restore")).toBe(1);
      expect(yield* start(project, "feature-restore", "read-only")).toBe(1);
      const admin = (yield* git(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      const head = (yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      const hookRecord = head + "\n" + worktreePath;
      const pending = path.join(admin, pendingFamilyCheckoutHook);
      const running = path.join(admin, runningFamilyCheckoutHook);
      yield* fs.writeFileString(pending, hookRecord);
      yield* fs.writeFileString(running, hookRecord);
      expect(yield* start(project, "feature-restore", "read-only")).toBe(0);
      expect(yield* fs.readFileString(running)).toBe(hookRecord);
      expect(yield* fs.readFileString(pending)).toBe(hookRecord);
      yield* fs.remove(running);
      yield* fs.remove(pending);
      expect(yield* fs.readFileString(file + ".released")).toBe(contents);
      expect(yield* fs.readFileString(path.join(worktreePath, "tracked"))).toBe("new owner's edit");
      yield* git(worktreePath, ["add", "tracked"]);
      yield* git(worktreePath, ["commit", "-m", "new owner's work"]);
      yield* git(project, ["worktree", "remove", worktreePath]);
      yield* git(otherProject, ["worktree", "add", "-b", "feature/restore", worktreePath]);
      expect(yield* start(otherProject, "feature/restore")).toBe(1);
      expect(yield* start(project, "feature/restore", "original family")).toBe(0);
      expect(yield* fs.readFileString(file + ".released")).toBe(contents);
      expect(runSetup).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

effectIt.effect.each([
  {
    name: "resumes the claimant after an intact removal interruption",
    state: "intact",
    owner: true,
    allowsStart: true,
  },
  {
    name: "holds the claimant after a partial removal",
    state: "partial",
    owner: true,
    allowsStart: false,
  },
  {
    name: "holds the claimant while the original Windows checkout is staged",
    state: "windows staged",
    owner: true,
    allowsStart: false,
  },
  {
    name: "finishes a verified partial Windows setup release after its durable ref advances",
    state: "verified partial setup",
    owner: true,
    allowsStart: true,
  },
  {
    name: "preserves a changed dependency in a staged Windows setup release",
    state: "verified changed setup",
    owner: true,
    allowsStart: false,
  },
  {
    name: "holds a staged Windows setup release after its durable ref is rewritten",
    state: "verified rewritten anchor",
    owner: true,
    allowsStart: false,
  },
  {
    name: "holds an unrelated chat while removal is claimed",
    state: "intact",
    owner: false,
    allowsStart: false,
  },
  {
    name: "recovers a missing checkout for its recorded owner",
    state: "missing",
    owner: true,
    allowsStart: true,
  },
  {
    name: "recreates an unregistered Windows checkout with an empty removal stage",
    state: "windows unregistered",
    owner: true,
    allowsStart: true,
  },
  {
    name: "recovers a missing checkout while another Windows release is staged",
    state: "sibling staged",
    owner: true,
    allowsStart: true,
  },
  {
    name: "holds an unrelated chat at the missing path",
    state: "missing",
    owner: false,
    allowsStart: false,
  },
  {
    name: "holds the former owner when a replacement occupies the path",
    state: "replacement",
    owner: true,
    allowsStart: false,
  },
  {
    name: "allows the unrelated owner of a complete replacement",
    state: "replacement",
    owner: false,
    allowsStart: true,
  },
  {
    name: "holds an unrelated owner of a checkout without an index",
    state: "no-index",
    owner: false,
    allowsStart: false,
  },
  {
    name: "holds setup before Git writes its index",
    state: "setup without index",
    owner: true,
    allowsStart: false,
  },
  {
    name: "holds setup during Git's initializing lock",
    state: "setup locked",
    owner: true,
    allowsStart: false,
  },
  {
    name: "holds setup with an index but missing tracked files",
    state: "setup missing file",
    owner: true,
    allowsStart: false,
  },
  {
    name: "retries setup with modified and untracked files",
    state: "setup retry",
    owner: true,
    allowsStart: true,
  },
] as const)("singleton release $name", ({ state, owner, allowsStart }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-singleton-restore-" }),
    );
    const workspaceRoot = path.join(root, "project");
    const worktreesDir = path.join(root, "worktrees");
    const worktreePath = path.join(worktreesDir, "project", "restore");
    const tracked = path.join(worktreePath, "tracked");
    const remaining = path.join(worktreePath, "remaining");
    const oldBranch = "feature/restore";
    const newBranch = "feature-restore";
    const git = (cwd: string, args: string[]) =>
      driver.execute({ operation: "test.singletonRestore", cwd, args });
    yield* fs.makeDirectory(workspaceRoot);
    yield* git(workspaceRoot, ["init", "-b", "main"]);
    yield* git(workspaceRoot, ["config", "user.name", "Test"]);
    yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(path.join(workspaceRoot, "tracked"), "original");
    yield* fs.writeFileString(path.join(workspaceRoot, "remaining"), "preserved");
    const unregistered = state === "windows unregistered";
    const changedSetup = state === "verified changed setup";
    const rewrittenAnchor = state === "verified rewritten anchor";
    const interruptedSetup = state === "verified partial setup" || changedSetup || rewrittenAnchor;
    if (interruptedSetup)
      yield* fs.writeFileString(path.join(workspaceRoot, ".gitignore"), ".t3/\nnode_modules/\n");
    yield* git(workspaceRoot, ["add", "."]);
    yield* git(workspaceRoot, ["commit", "-m", "base"]);
    yield* git(workspaceRoot, ["worktree", "add", "-b", oldBranch, worktreePath]);
    const isSetup = state.startsWith("setup ");
    if (interruptedSetup) {
      const marker = "83c3b572-0640-4e21-bdc7-c24f84a7830c\n";
      yield* fs.makeDirectory(path.join(worktreePath, ".t3"));
      yield* fs.writeFileString(path.join(worktreePath, ".t3", "setup-done"), marker);
      yield* fs.makeDirectory(path.join(worktreePath, "node_modules"));
      yield* fs.writeFileString(path.join(worktreePath, "node_modules", "installed.js"), "module");
      const admin = gitOutputLine(
        (yield* git(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout,
      );
      const head = gitOutputLine((yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout);
      yield* Effect.tryPromise(async (signal) =>
        writeSetupProof(admin, path.join(admin, "pending-setup"), {
          root: await NodeFSP.realpath(workspaceRoot),
          checkout: setupFileStamp(
            await NodeFSP.lstat(path.join(worktreePath, ".git"), { bigint: true }),
          ),
          head,
          marker,
          ...(await sealSetupTrees(worktreePath, ["node_modules"], signal)),
          markerMetadataV1: await sealSetupMarkers(worktreePath, "setup-done", signal),
          links: [],
        }),
      );
    }
    if (isSetup) {
      yield* fs.writeFileString(path.join(workspaceRoot, ".git/info/exclude"), "private.txt\n");
      yield* fs.writeFileString(path.join(worktreePath, "private.txt"), "saved private data");
    }
    const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
    const harness = makeLocalCommandHarness({
      text: "Continue",
      nativeTurn: true,
      workspaceRoot,
      worktreesDir,
      worktreePath,
      fileSystem: fs,
      gitWorkflow,
      runSetup,
    });
    const queue = queueWorktreeRelease({
      threadId: owner ? harness.projection().thread.id : "old-owner",
      runId: "finished",
      worktreePath,
      durableRef: "refs/heads/main",
      stateDir: path.join(root, "state"),
      saveIgnored: isSetup,
    });
    const { file, savedFiles } = yield* unregistered
      ? queue.pipe(Effect.provideService(HostProcess.Platform, "win32"))
      : queue;
    const contents = yield* fs.readFileString(file);
    const release = yield* decodeReleaseRequest(contents);
    expect(release.family).toBeUndefined();
    const staged = state === "windows staged";
    const siblingStaged = state === "sibling staged";
    const missing = state === "missing" || siblingStaged || unregistered;
    const stage = windowsRemovalStage(worktreePath);
    const removing =
      state === "intact" || state === "partial" || staged || interruptedSetup || unregistered;
    const receipt = file + (removing ? ".releasing" : isSetup ? ".setup" : ".released");
    yield* fs.rename(file, receipt);
    let lock: string | undefined;
    if (removing) {
      if (state === "partial") yield* fs.remove(tracked);
      if (staged || unregistered) yield* fs.rename(worktreePath, stage);
      if (unregistered) {
        yield* git(workspaceRoot, ["worktree", "remove", "--", worktreePath]);
        for (const name of ["tracked", "remaining", ".git"])
          yield* fs.remove(path.join(stage, name));
      }
      if (interruptedSetup) {
        expect(release.requiresSetupProof).toBe(true);
        const operation = "test.singletonRestore.interruptedSetup";
        const prepared = yield* prepareLinkedWorktreeRemoval({
          operation,
          cwd: workspaceRoot,
          worktreePath,
          force: false,
          release: { ...release, setupReceiptHash: releaseDigest(contents) },
          execute: driver.execute,
          run: (args) => driver.execute({ operation, cwd: workspaceRoot, args }),
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            remove: (target, options) =>
              target === path.join(stage, "node_modules", "installed.js")
                ? fs.remove(path.join(target, "locked"))
                : fs.remove(target, options),
          }),
        );
        yield* Effect.flip(prepared);
        expect(yield* fs.exists(path.join(stage, ".t3", "setup-done"))).toBe(false);
        expect(yield* fs.exists(path.join(stage, "node_modules", "installed.js"))).toBe(true);
        if (changedSetup)
          yield* fs.writeFileString(
            path.join(stage, "node_modules", "installed.js"),
            "owner edits",
          );
        if (rewrittenAnchor) {
          const unrelated = gitOutputLine(
            (yield* git(workspaceRoot, [
              "commit-tree",
              `${release.head}^{tree}`,
              "-m",
              "Rewrite durable ref",
            ])).stdout,
          );
          yield* git(workspaceRoot, ["update-ref", "refs/heads/main", unrelated]);
        } else if (!changedSetup) {
          yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "Advance durable ref"]);
        }
      }
    } else {
      yield* git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]);
      if (!missing) {
        yield* git(workspaceRoot, [
          "worktree",
          "add",
          ...(state === "no-index" || state === "setup without index" ? ["--no-checkout"] : []),
          ...(isSetup ? [] : ["-b", newBranch]),
          worktreePath,
          ...(isSetup ? [oldBranch] : []),
        ]);
        if (isSetup) {
          const admin = (yield* git(worktreePath, [
            "rev-parse",
            "--absolute-git-dir",
          ])).stdout.trim();
          expect(yield* fs.exists(path.join(admin, "index"))).toBe(state !== "setup without index");
          yield* fs.writeFileString(
            path.join(worktreePath, "setup.local"),
            "retain local setup output",
          );
          if (state === "setup locked") {
            lock = path.join(admin, "locked");
            yield* fs.writeFileString(lock, "initializing\n");
          }
          if (state === "setup missing file") yield* fs.remove(tracked);
          if (state === "setup retry") yield* fs.writeFileString(tracked, "tracked setup edit");
        }
        if (state === "replacement") yield* fs.writeFileString(tracked, "new owner's edit");
        if (!owner) {
          const projection = harness.projection();
          harness.setProjection({
            ...projection,
            thread: { ...projection.thread, branch: newBranch },
          });
        }
      }
    }

    if (siblingStaged) {
      const sibling = path.join(worktreesDir, "project", "sibling");
      yield* git(workspaceRoot, ["worktree", "add", "-b", "sibling", sibling]);
      const release = yield* queueWorktreeRelease({
        threadId: "sibling-owner",
        runId: "finished",
        worktreePath: sibling,
        durableRef: "refs/heads/main",
        stateDir: path.join(root, "state"),
      });
      const claim = release.file + ".releasing";
      yield* fs.rename(release.file, claim);
      yield* fs.rename(sibling, windowsRemovalStage(sibling));
      yield* harness.start.pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const request = yield* decodeReleaseRequest(yield* fs.readFileString(claim));
      expect(
        yield* restoreStagedWindowsCheckout(workspaceRoot, request).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(path.join(sibling, "remaining"))).toBe("preserved");
    } else if (staged || interruptedSetup || unregistered)
      yield* harness.start.pipe(Effect.provideService(HostProcess.Platform, "win32"));
    else yield* harness.start;

    expect(harness.open).toHaveBeenCalledTimes(allowsStart ? 1 : 0);
    expect(harness.startTurn).toHaveBeenCalledTimes(allowsStart ? 1 : 0);
    expect(runSetup).toHaveBeenCalledTimes(
      allowsStart && (missing || isSetup || interruptedSetup) ? 1 : 0,
    );
    if (allowsStart && owner) expect(yield* fs.exists(receipt)).toBe(false);
    else expect(yield* fs.readFileString(receipt)).toBe(contents);
    expect(yield* fs.exists(worktreePath)).toBe(
      !staged && !changedSetup && !rewrittenAnchor && (!missing || allowsStart),
    );
    if (unregistered) expect(yield* fs.exists(stage)).toBe(false);
    if (changedSetup)
      expect(yield* fs.readFileString(path.join(stage, "node_modules", "installed.js"))).toBe(
        "owner edits",
      );
    if (rewrittenAnchor)
      expect(yield* fs.readFileString(path.join(stage, "node_modules", "installed.js"))).toBe(
        "module",
      );
    if (state === "replacement") expect(yield* fs.readFileString(tracked)).toBe("new owner's edit");
    if (
      state === "partial" ||
      state === "no-index" ||
      state === "setup without index" ||
      state === "setup missing file"
    )
      expect(yield* fs.exists(tracked)).toBe(false);
    if (removing && !changedSetup && !rewrittenAnchor)
      expect(yield* fs.readFileString(staged ? path.join(stage, "remaining") : remaining)).toBe(
        "preserved",
      );
    if (staged)
      expect((yield* git(workspaceRoot, ["worktree", "list", "--porcelain"])).stdout).toContain(
        "branch refs/heads/" + oldBranch,
      );
    if (isSetup) {
      if (savedFiles === undefined) return yield* Effect.die("Expected a private backup.");
      expect(yield* fs.readFileString(path.join(savedFiles, "private.txt"))).toBe(
        "saved private data",
      );
      expect(yield* listWorktreeBackups(path.join(root, "state"))).toMatchObject([
        { savedFiles, threadId: harness.projection().thread.id, runId: "finished" },
      ]);
      expect(yield* fs.readFileString(path.join(worktreePath, "setup.local"))).toBe(
        "retain local setup output",
      );
      if (lock !== undefined) expect(yield* fs.readFileString(lock)).toBe("initializing\n");
      if (state === "setup retry")
        expect(yield* fs.readFileString(tracked)).toBe("tracked setup edit");
    }
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

effectIt.effect.each([
  { share: "open", checkout: "missing", blocked: true },
  { share: "closed", checkout: "setup pending", blocked: true },
  { share: "closed", checkout: "replacement receipt", blocked: false },
  { share: "open", checkout: "intact", blocked: false },
  { share: "unsupported", checkout: "missing", blocked: true },
] as const)(
  "keeps worktree startup read-only for $checkout when the guest link is $share",
  ({ share, checkout, blocked }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-read-only-turn-" }),
      );
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "checkout");
      const directory = path.join(root, "state", ServerConfig.WORKTREE_RELEASE_DIRECTORY);
      const pruneWorktrees = vi.fn(() => Effect.void);
      const createWorktree = vi.fn(() => Effect.succeed({} as never));
      const recoverInterruptedWorktree = vi.fn(() => Effect.void);
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const harness = makeLocalCommandHarness({
        text: "Continue",
        fileSystem: fs,
        worktreesDir,
        worktreePath,
        nativeTurn: true,
        gitWorkflowMock: {
          pruneWorktrees,
          createWorktree,
          recoverInterruptedWorktree,
          listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
          currentBranch: () => Effect.succeed("feature/restore"),
        },
        runSetup,
      });
      const projection = harness.projection();
      if (checkout === "missing") {
        yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
      } else {
        yield* fs.makeDirectory(worktreePath, { recursive: true });
      }
      const receipt = path.join(directory, worktreeReleaseName(worktreePath));
      const marker =
        checkout === "setup pending"
          ? receipt + ".setup"
          : checkout === "replacement receipt"
            ? receipt + ".released"
            : null;
      const contents = JSON.stringify({
        threadId: checkout === "replacement receipt" ? "former-owner" : projection.thread.id,
        runId: "finished",
        worktreePath,
        branch: checkout === "replacement receipt" ? "old-branch" : projection.thread.branch,
        durableRef: "refs/heads/main",
        head: "1".repeat(40),
        identity: "1/2/3/4",
      });
      if (marker !== null) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(marker, contents);
      }
      harness.setProjection({
        ...projection,
        thread: {
          ...projection.thread,
          guestShare:
            share === "closed"
              ? null
              : {
                  id: GuestShareId.make("read-only-link"),
                  host: "example.test",
                  access: "read-only",
                  createdAt: "2026-09-04T11:00:00Z",
                  expiresAt: "2026-09-04T13:00:00Z",
                  guestName: "Guest",
                  messages: [],
                },
        },
        runs: projection.runs.map((run) =>
          share === "closed" ? { ...run, readOnlyGuestShare: true } : run,
        ),
      });
      if (share === "unsupported") {
        harness.resolveRuntimePolicy.mockReturnValue(
          Effect.fail(
            new RuntimePolicy.RuntimePolicyReadOnlyUnsupportedError({
              threadId: projection.thread.id,
              providerInstanceId: harness.newInstanceId,
            }),
          ),
        );
      }

      yield* harness.startWithRetry;

      expect(pruneWorktrees).not.toHaveBeenCalled();
      expect(createWorktree).not.toHaveBeenCalled();
      if (checkout === "replacement receipt") {
        expect(recoverInterruptedWorktree.mock.calls).toEqual([
          [
            worktreePath,
            expect.any(String),
            projection.thread.branch,
            { replacementOf: "1/2/3/4" },
          ],
        ]);
      } else {
        expect(recoverInterruptedWorktree).not.toHaveBeenCalled();
      }
      expect(runSetup).not.toHaveBeenCalled();
      if (marker !== null) expect(yield* fs.readFileString(marker)).toBe(contents);
      if (blocked) {
        expect(harness.startTurn).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems.at(-1)).toMatchObject(
          share === "unsupported"
            ? { title: "Provider cannot run read-only" }
            : {
                failure: {
                  class: "permission_error",
                  message: expect.stringContaining("read-only"),
                },
              },
        );
      } else {
        expect(harness.startTurn).toHaveBeenCalledOnce();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect.each([
  { author: "owner on web", source: "web", retry: true },
  { author: "owner on mobile", source: "mobile", retry: true },
  { author: "approved guest", source: "web", retry: false },
  { author: "server follow-up", source: "server", retry: false },
  { author: "continuation of existing work", source: "web", retry: false },
] as const)(
  "uses only fresh owner input to retry a failed checkout hook ($author)",
  ({ author, source, retry }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-hook-retry-policy-" }),
      );
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "checkout");
      const directory = path.join(root, "state", ServerConfig.WORKTREE_RELEASE_DIRECTORY);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "Git registration fixture");
      const recoverInterruptedWorktree = vi.fn<
        GitWorkflow.GitWorkflowService["Service"]["recoverInterruptedWorktree"]
      >((_cwd, _project, _branch, options) =>
        options?.followUpAt === undefined
          ? Effect.fail(
              new GitCommandError({
                operation: familyHookOperation,
                command: "checkout hook",
                cwd: worktreePath,
                detail: "The checkout hook needs a new follow-up.",
              }),
            )
          : Effect.void,
      );
      const runSetup = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
      const harness = makeLocalCommandHarness({
        text: "Continue",
        fileSystem: fs,
        worktreesDir,
        worktreePath,
        nativeTurn: true,
        gitWorkflowMock: { recoverInterruptedWorktree },
        runSetup,
      });
      const projection = harness.projection();
      const receipt = path.join(directory, worktreeReleaseName(worktreePath)) + ".restoring";
      yield* fs.writeFileString(
        receipt,
        JSON.stringify({
          threadId: projection.thread.id,
          runId: "finished",
          worktreePath,
          branch: projection.thread.branch,
          durableRef: "refs/heads/main",
          head: "1".repeat(40),
          identity: "original",
        }),
      );
      harness.setProjection({
        ...projection,
        runs: projection.runs.map((run) =>
          author === "continuation of existing work" ? { ...run, demandId: null } : run,
        ),
        messages: projection.messages.map((message) => ({
          ...message,
          creationSource: source,
          ...(author === "approved guest"
            ? {
                context: {
                  version: 1 as const,
                  records: [],
                  guest: {
                    guestMessageId: GuestMessageId.make("guest-message"),
                    name: "Guest",
                    text: message.text,
                  },
                },
              }
            : {}),
        })),
      });

      yield* harness.startWithRetry;

      expect(
        recoverInterruptedWorktree.mock.calls.map(([, , , options]) => options?.followUpAt),
      ).toEqual([retry ? DateTime.toEpochMillis(projection.messages[0]!.createdAt) : undefined]);
      expect(runSetup).toHaveBeenCalledTimes(retry ? 1 : 0);
      expect(harness.startTurn).toHaveBeenCalledTimes(retry ? 1 : 0);
      expect(yield* fs.exists(receipt)).toBe(!retry);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect(
  "holds a damaged release receipt before setup and settles the start without retrying",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-invalid-receipt-" }),
      );
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "checkout");
      const directory = path.join(root, "state", ServerConfig.WORKTREE_RELEASE_DIRECTORY);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      const file = path.join(directory, worktreeReleaseName(worktreePath));
      const setup = JSON.stringify({
        threadId: "thread-native-account-command",
        runId: "finished",
        worktreePath,
        branch: "feature/restore",
        durableRef: "refs/heads/main",
        head: "1".repeat(40),
        identity: "original",
      });
      yield* fs.writeFileString(file + ".setup", setup);
      const marker = file + ".restoring";
      const invalid = "unrecognized receipt content";
      yield* fs.writeFileString(marker, invalid);
      const harness = makeLocalCommandHarness({
        text: "Continue",
        fileSystem: fs,
        worktreesDir,
        worktreePath,
      });
      yield* harness.startWithRetry;
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      const failure = harness.projection().turnItems.at(-1);
      expect(failure).toMatchObject({ failure: { message: expect.stringContaining(marker) } });
      expect(JSON.stringify(failure)).not.toContain(invalid);
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(yield* fs.readFileString(marker)).toBe(invalid);
      expect(yield* fs.readFileString(file + ".setup")).toBe(setup);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("cancels recovered synchronous setup and unblocks the awaiting run", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-recovered-setup-cancel-" }),
    );
    const project = path.join(root, "project");
    const worktreesDir = path.join(root, "worktrees");
    const checkout = path.join(worktreesDir, "project", "checkout");
    const receipts = path.join(root, "state", ServerConfig.WORKTREE_RELEASE_DIRECTORY);
    const git = (args: string[]) =>
      driver.execute({ operation: "test.setupCancellation", cwd: project, args });
    yield* fs.makeDirectory(project);
    yield* git(["init", "-b", "main"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(path.join(project, "tracked"), "base");
    yield* git(["add", "tracked"]);
    yield* git(["commit", "-m", "base"]);
    yield* git(["worktree", "add", "-b", "feature/restore", checkout]);
    yield* fs.makeDirectory(receipts, { recursive: true });
    const worktreePath = yield* fs.realPath(checkout);
    const receipt = path.join(receipts, worktreeReleaseName(worktreePath) + ".setup");
    yield* fs.writeFileString(
      receipt,
      JSON.stringify({
        threadId: "thread-native-account-command",
        runId: "finished",
        worktreePath,
        branch: "feature/restore",
        durableRef: "refs/heads/main",
        identity: "removed checkout",
        head: "1".repeat(40),
      }),
    );
    const cancel = vi.fn();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      fileSystem: fs,
      worktreesDir,
      worktreePath,
      workspaceRoot: project,
      gitWorkflow,
      runSetup: () =>
        Effect.succeed({
          status: "started",
          scriptId: "install",
          scriptName: "Install",
          scriptCommand: "install",
          terminalId: "setup-install",
          cwd: worktreePath,
          async: false,
          completion: Effect.never,
          cancel: Effect.sync(cancel),
        }),
    });
    yield* harness.withRuntime(
      Effect.gen(function* () {
        const starter = yield* ProviderTurnStart.ProviderTurnStartServiceV2;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const { thread, runs } = harness.projection();
        const start = yield* starter
          .start({ threadId: thread.id, runId: runs[0]!.id, willRetry: true })
          .pipe(Effect.forkScoped);
        yield* tracker.stream(thread.id).pipe(
          Stream.filter((snapshot) => snapshot?.setupScript != null),
          Stream.runHead,
        );
        expect(yield* tracker.cancel(thread.id)).toBe(true);
        yield* Fiber.join(start);
        expect(cancel).toHaveBeenCalledOnce();
        expect((yield* tracker.get(thread.id))?.phase).toBe("cancelled");
        expect(harness.projection().runs.at(-1)?.status).toBe("cancelled");
        expect(harness.open).not.toHaveBeenCalled();
        expect(yield* fs.exists(receipt)).toBe(true);
        expect(yield* fs.exists(worktreePath)).toBe(true);
      }),
    );
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
  "coordinates provider startup with %s across stored and canonical checkout paths",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const managed = path.join(yield* fileSystem.realPath(temp), "managed");
      yield* fileSystem.makeDirectory(managed);
      const workspaceRoot = path.join(temp, "saved-managed");
      yield* linkDirectory(managed, workspaceRoot);
      const worktreePath = path.join(workspaceRoot, "project", "worktree");
      const canonical = path.join(managed, "project", "worktree");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const cleanupHeld = yield* Deferred.make<void>();
      const startupRequested = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        worktreesDir: workspaceRoot,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(({ path: savedPath }) => {
        expect(savedPath).toBe(worktreePath);
        return fileSystem
          .makeDirectory(worktreePath, { recursive: true })
          .pipe(Effect.as({} as never), Effect.orDie);
      });
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
      let cleanupFinished = false;
      if (order === "cleanup-first") {
        harness.getThreadRecords.mockImplementationOnce(() =>
          Deferred.succeed(startupRequested, undefined).pipe(Effect.as(harness.projection())),
        );
        const read = harness.getTurnStartContext.getMockImplementation()!;
        harness.getTurnStartContext.mockImplementation(() => {
          expect(cleanupFinished).toBe(true);
          return read();
        });
      }
      const cleanupEffect = withWorkspaceLease(
        canonical,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "startup-first") {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          // Both the leaf and the project directory can disappear before a family follow-up begins.
          yield* fileSystem.remove(path.dirname(canonical), { recursive: true });
          yield* Deferred.succeed(cleanupHeld, undefined);
          if (order === "cleanup-first") yield* Deferred.await(release);
          cleanupFinished = true;
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (cleanup) yield* Deferred.await(cleanupHeld);
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") {
        yield* Deferred.await(startupRequested);
        expect(harness.open).not.toHaveBeenCalled();
      }
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
    const holderEntered = yield* Deferred.make<void>();
    const holder = yield* withWorkspaceLease(
      resolvedPath,
      Deferred.succeed(holderEntered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(holderEntered);
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

effectIt.effect.each(["terminal", "command", "process start"] as const)(
  "blocks Windows staged setup deletion during turn start when %s is active inside the stage",
  (blocker) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-stage-admit-" });
      const workspaceRoot = path.join(root, "repo");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const oldBranch = "feature/restore";
      const git = (cwd: string, args: string[]) =>
        driver.execute({ operation: "test.stageAdmit", cwd, args });
      yield* fs.makeDirectory(workspaceRoot);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "tracked"), "original");
      yield* fs.writeFileString(path.join(workspaceRoot, ".gitignore"), ".t3/\nnode_modules/\n");
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "base"]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", oldBranch, worktreePath]);
      const marker = "83c3b572-0640-4e21-bdc7-c24f84a7830c\n";
      yield* fs.makeDirectory(path.join(worktreePath, ".t3"));
      yield* fs.writeFileString(path.join(worktreePath, ".t3", "setup-done"), marker);
      yield* fs.makeDirectory(path.join(worktreePath, "node_modules"));
      yield* fs.writeFileString(path.join(worktreePath, "node_modules", "installed.js"), "module");
      const admin = gitOutputLine(
        (yield* git(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout,
      );
      const head = gitOutputLine((yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout);
      yield* Effect.tryPromise(async (signal) =>
        writeSetupProof(admin, path.join(admin, "pending-setup"), {
          root: await NodeFSP.realpath(workspaceRoot),
          checkout: setupFileStamp(
            await NodeFSP.lstat(path.join(worktreePath, ".git"), { bigint: true }),
          ),
          head,
          marker,
          ...(await sealSetupTrees(worktreePath, ["node_modules"], signal)),
          markerMetadataV1: await sealSetupMarkers(worktreePath, "setup-done", signal),
          links: [],
        }),
      );
      const stage = windowsRemovalStage(worktreePath);
      const harness = makeLocalCommandHarness({
        text: "Continue",
        nativeTurn: true,
        workspaceRoot,
        worktreesDir,
        worktreePath,
        fileSystem: fs,
        gitWorkflow,
        ...(blocker === "terminal"
          ? { activeTerminalWorkspaces: [path.join(stage, "node_modules")] }
          : {}),
        ...(blocker === "command" ? { activeCommandCwds: [path.join(stage, "node_modules")] } : {}),
      });
      const { file } = yield* queueWorktreeRelease({
        threadId: harness.projection().thread.id,
        runId: "finished",
        worktreePath,
        durableRef: "refs/heads/main",
        stateDir: path.join(root, "state"),
      });
      const contents = yield* fs.readFileString(file);
      const release = yield* decodeReleaseRequest(contents);
      const receipt = file + ".releasing";
      yield* fs.rename(file, receipt);
      const operation = "test.stageAdmit.prepare";
      const prepared = yield* prepareLinkedWorktreeRemoval({
        operation,
        cwd: workspaceRoot,
        worktreePath,
        force: false,
        release: { ...release, setupReceiptHash: releaseDigest(contents) },
        execute: driver.execute,
        run: (args) => driver.execute({ operation, cwd: workspaceRoot, args }),
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (target, options) =>
            target === path.join(stage, "node_modules", "installed.js")
              ? fs.remove(path.join(target, "locked"))
              : fs.remove(target, options),
        }),
      );
      yield* Effect.flip(prepared);
      expect(yield* fs.exists(path.join(stage, "node_modules", "installed.js"))).toBe(true);

      const startTurnOnWin = harness.start.pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      if (blocker === "process start") {
        const started = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        const fiber = yield* withWorkspaceProcessStart(
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
          [path.join(stage, "node_modules")],
        ).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.forkScoped);
        yield* Deferred.await(started);
        yield* startTurnOnWin;
        yield* Deferred.succeed(done, undefined);
        yield* Fiber.join(fiber);
      } else {
        yield* startTurnOnWin;
      }

      expect(harness.open).toHaveBeenCalledTimes(0);
      expect(harness.startTurn).toHaveBeenCalledTimes(0);
      expect(yield* fs.exists(path.join(stage, "node_modules", "installed.js"))).toBe(true);
      expect(yield* fs.readFileString(receipt)).toBe(contents);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.scoped,
      Effect.provide(layerRealGit),
    ),
);

effectIt.effect(
  "recovers a missing registered checkout while a different sibling is staged unpinned on Windows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-prune-pin-" });
      const workspaceRoot = path.join(root, "repo");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const sibling = path.join(worktreesDir, "project", "sibling");
      const git = (cwd: string, args: string[]) =>
        driver.execute({ operation: "test.prunePin", cwd, args });
      yield* fs.makeDirectory(workspaceRoot);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "tracked"), "original");
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "base"]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", "feature/restore", worktreePath]);
      yield* git(workspaceRoot, ["worktree", "add", "-b", "sibling", sibling]);

      // Delete A on disk while still registered; stage B unpinned.
      yield* fs.remove(worktreePath, { recursive: true });
      yield* fs.rename(sibling, windowsRemovalStage(sibling));

      const harness = makeLocalCommandHarness({
        text: "Continue",
        nativeTurn: true,
        workspaceRoot,
        worktreesDir,
        worktreePath,
        fileSystem: fs,
        gitWorkflow,
      });
      yield* harness.start.pipe(Effect.provideService(HostProcess.Platform, "win32"));

      expect(harness.open).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(yield* fs.exists(worktreePath)).toBe(true);
      const registered = (yield* git(workspaceRoot, ["worktree", "list", "--porcelain"])).stdout;
      expect(registered).toContain("branch refs/heads/feature/restore");
      expect(registered).toContain("branch refs/heads/sibling");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.scoped,
      Effect.provide(layerRealGit),
    ),
);

effectIt.effect(
  "restores a released checkout from a checked-out project branch starting with '(' instead of origin/HEAD",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-turn-paren-branch-" });
      const remoteRoot = path.join(root, "remote.git");
      const workspaceRoot = path.join(root, "repo");
      const worktreesDir = path.join(root, "worktrees");
      const worktreePath = path.join(worktreesDir, "project", "restore");
      const oldBranch = "feature/restore";
      const git = (cwd: string, args: string[]) =>
        driver.execute({ operation: "test.parenBranch", cwd, args });

      yield* fs.makeDirectory(remoteRoot);
      yield* git(remoteRoot, ["init", "--bare", "-b", "main"]);
      yield* fs.makeDirectory(workspaceRoot);
      yield* git(workspaceRoot, ["init", "-b", "main"]);
      yield* git(workspaceRoot, ["config", "user.name", "Test"]);
      yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "base.txt"), "delivered\n");
      yield* git(workspaceRoot, ["add", "."]);
      yield* git(workspaceRoot, ["commit", "-m", "delivered"]);
      yield* git(workspaceRoot, ["remote", "add", "origin", remoteRoot]);
      yield* git(workspaceRoot, ["push", "-u", "origin", "main"]);
      yield* git(workspaceRoot, ["remote", "set-head", "origin", "main"]);

      // Create worktree at delivered commit, then advance origin/main and local (release) differently.
      yield* git(workspaceRoot, ["worktree", "add", "-b", oldBranch, worktreePath]);
      yield* git(workspaceRoot, ["checkout", "-b", "(release)"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "tip.txt"), "from local (release)\n");
      yield* git(workspaceRoot, ["add", "tip.txt"]);
      yield* git(workspaceRoot, ["commit", "-m", "local paren branch tip"]);
      const localParenTip = gitOutputLine(
        (yield* git(workspaceRoot, ["rev-parse", "HEAD"])).stdout,
      );

      // Advance origin/main to a distinct commit that also contains the delivered commit.
      yield* git(workspaceRoot, ["checkout", "main"]);
      yield* fs.writeFileString(path.join(workspaceRoot, "tip.txt"), "from origin main\n");
      yield* git(workspaceRoot, ["add", "tip.txt"]);
      yield* git(workspaceRoot, ["commit", "-m", "origin main tip"]);
      yield* git(workspaceRoot, ["push", "origin", "main"]);
      yield* git(workspaceRoot, ["checkout", "(release)"]);

      const harness = makeLocalCommandHarness({
        text: "Continue",
        nativeTurn: true,
        workspaceRoot,
        worktreesDir,
        worktreePath,
        fileSystem: fs,
        gitWorkflow,
        runSetup: vi.fn(() => Effect.succeed({ status: "no-script" as const })),
      });
      const { file } = yield* queueWorktreeRelease({
        threadId: harness.projection().thread.id,
        runId: "finished",
        worktreePath,
        durableRef: "refs/heads/(release)",
        stateDir: path.join(root, "state"),
      });
      yield* fs.rename(file, file + ".released");
      yield* git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]);

      yield* harness.start;

      expect(harness.open).toHaveBeenCalledTimes(1);
      expect(harness.startTurn).toHaveBeenCalledTimes(1);
      expect(gitOutputLine((yield* git(worktreePath, ["rev-parse", "HEAD"])).stdout)).toBe(
        localParenTip,
      );
      expect(yield* fs.readFileString(path.join(worktreePath, "tip.txt"))).toBe(
        "from local (release)\n",
      );
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
