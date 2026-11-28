import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkflowForge from "../workflows/WorkflowForge.ts";
import * as ProviderSkillsTestkit from "../provider/ProviderSkills.testkit.ts";
import {
  AUTHENTICATION_FAILED_FAILURE_CODE,
  ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  SourceControlProviderKind,
  orchestrationV2RunAwaitsMemory,
} from "@t3tools/contracts";
import { evidenceKey, makeDispatchRecorder } from "./StopDecisionEvidence.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { AccountRouting, routeAutoAccount, runLiftsScope } from "./AccountRouting.ts";
import { limitFailoverCommand, limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import { PullRequestUnavailableError } from "@t3tools/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MAX_THREAD_STARRED_MESSAGES,
  IssueTrackerKind,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  type PullRequestCheck,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  type PullRequestWatchUntil,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SharedSettings from "../sharedSettings/SharedSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { delegatedCompletionUpdated } from "./testkit/DelegatedCompletionCohort.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistrySync from "../provider/ProviderInstanceRegistrySync.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { LATER_RUN_ACTIVE_MESSAGE } from "./CheckpointRollbackService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./pullRequestWatch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import {
  backgroundWorkStoppedNotice,
  lostBackgroundWorkRecord,
  restartRetryNoticeId,
} from "./RestartBackgroundNote.ts";
import { CONTINUE_PROMPT, continueRestartedRun } from "./RestartContinuation.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ThreadPageCheckAccess from "../threadPage/ThreadPageCheckAccess.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  layerSharedTaskDependencies,
  layerSharedTaskIdentities,
} from "../scheduledTasks/sharedTaskTestLayers.ts";
import * as DeviceHost from "../device/DeviceHost.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.mergeAll(
  ProviderSkillsTestkit.layer,
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.merge(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  layerNoTaskFolders,
);
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;
const claudeInstanceId = ProviderInstanceId.make("claude_test");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const claudeProviderInstance = {
  ...providerInstance,
  instanceId: claudeInstanceId,
  driverKind: claudeDriver,
  continuationIdentity: { driverKind: claudeDriver, continuationKey: "claude:test" },
  displayName: "Claude test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: claudeInstanceId,
    driver: claudeDriver,
  },
} satisfies ProviderInstance;

const antigravityInstanceId = ProviderInstanceId.make("antigravity_test");
const antigravityDriver = ProviderDriverKind.make("antigravity");
const antigravityProviderInstance = {
  ...providerInstance,
  instanceId: antigravityInstanceId,
  driverKind: antigravityDriver,
  continuationIdentity: { driverKind: antigravityDriver, continuationKey: "antigravity:test" },
  displayName: "Antigravity test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: antigravityInstanceId,
    driver: antigravityDriver,
    getCapabilities: () =>
      Effect.succeed({
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsNativeGoals: true },
      }),
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(
        [
          providerInstance,
          alternateProviderInstance,
          claudeProviderInstance,
          antigravityProviderInstance,
        ].find((instance) => instanceId === instance.instanceId),
      ),
    listInstances: Effect.succeed([
      providerInstance,
      alternateProviderInstance,
      claudeProviderInstance,
      antigravityProviderInstance,
    ]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
).pipe(Layer.merge(ProviderInstanceRegistrySync.layerTest));

const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "pingdotgg/t3code",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/pingdotgg/t3code/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const moveProject = (projectId: ProjectId, workspaceRoot: string, updatedAt: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`move:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId, workspaceRoot, updatedAt },
    }),
  );

// Read-only oracle: projections still equal a replay of these unpruned test logs.
const layerProjectionReplayTest = ProjectionReplay.layer.pipe(
  Layer.provide(
    Layer.merge(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
      ),
      ProjectionStore.layer,
    ),
  ),
);

const makeRuntimeTestLayer = (database = SqlitePersistence.layerMemory) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    layerProjectionReplayTest,
    RuntimeLayer.layerEventSink,
    ProjectStore.layer,
    ProjectionStore.layer,
    EffectOutbox.layer,
    ThreadCommandExecutor.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(database),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerGitWorkflowTest),
    Layer.provide(layerProjectServiceTest),
    Layer.provide(layerPlatformTest),
  );

const layerTest = makeRuntimeTestLayer();
const layerBeforeSteerTargetMigration = makeRuntimeTestLayer(
  Layer.effectDiscard(runMigrations({ toCodeShipMigrationInclusive: 37 })).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

/** Lets a held automatic start go, as the memory admission queue does once there is room. */
const admitHeldRun = (threadId: ThreadId, runId: RunId, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const commandId = CommandId.make(`command:memory-admit:${runId}:${key}`);
    yield* orchestrator.dispatch({ type: "run.memory-admit", commandId, threadId, runId });
    return commandId;
  });

const layerLegacyImportTest = Layer.merge(RuntimeLayer.layer, layerProjectionReplayTest).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(Layer.merge(ServerSettings.layerTest(), MemoryAdmission.layerTest())),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerScheduledTasksTest = ScheduledTaskService.layer.pipe(
  Layer.provide(Layer.merge(ServerSettings.layerTest(), MemoryAdmission.layerTest())),
  Layer.provide(
    Layer.mergeAll(
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      // The orchestrator depends on this layer, so read the shell from its projection.
      Layer.unwrap(
        ProjectionStore.ProjectionStoreV2.pipe(
          Effect.map(({ getThreadShell }) =>
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) => getThreadShell(threadId).pipe(Effect.orDie),
            }),
          ),
        ),
      ).pipe(Layer.provide(ProjectionStore.layer)),
      layerSharedTaskDependencies(),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Scheduler.layer,
    ),
  ),
);
const bootedSimulatorReady: DeviceHost.DeviceHostAgentReady = {
  nodePath: process.execPath,
  hub: { origin: "http://device.test" },
  agentDevice: null,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  run: () => Effect.die("Thread cleanup must not run host commands"),
  releaseAgentSession: () => Effect.void,
  devices: {
    list: Effect.succeed({
      devices: [
        {
          id: "phone",
          name: "iPhone",
          platform: "ios",
          version: "26",
          booted: true,
          physical: false,
        },
      ],
      detail: undefined,
    }),
    boot: () => Effect.die("The simulator is already booted"),
    attach: () => Effect.void,
    shutdown: () => Effect.die("Thread cleanup must keep the simulator booted"),
    screenshot: () => Effect.die("unused screenshot"),
  },
};
const bootedSimulatorHost = DeviceHost.DeviceHost.of({
  id: "local",
  label: "Local",
  summary: Effect.succeed({
    id: "local",
    label: "Local",
    kind: "local",
    hubInstalled: true,
    agentDeviceInstalled: true,
    platforms: [{ platform: "ios", available: true }],
  }),
  platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
  ensureReady: () => Effect.succeed(bootedSimulatorReady),
  ensureAgentReady: () => Effect.succeed(bootedSimulatorReady),
  current: Effect.succeed(bootedSimulatorReady),
  stopAgent: Effect.void,
  stop: Effect.void,
});
const layerResourceCleanupTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(layerScheduledTasksTest),
  Layer.provideMerge(
    Layer.effect(
      DeviceService.DeviceService,
      DeviceService.makeWithHosts(new Map([[bootedSimulatorHost.id, bootedSimulatorHost]])),
    ).pipe(Layer.provide(SharedSettings.layerTest)),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
);

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provideMerge(layerResourceCleanupTest),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provideMerge(layerServerConfig),
  Layer.provide(Layer.merge(ServerSettings.layerTest(), MemoryAdmission.layerTest())),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provideMerge(layerPlatformTest),
);

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["thread", "project"] as const)(
    "deleting a %s removes its thread-bound automations through the effect worker",
    (deletion) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const projectId = ProjectId.make(`automation-delete-project:${deletion}`);
        const threadId = ThreadId.make(`automation-delete-thread:${deletion}`);
        const otherThreadId = ThreadId.make(`automation-surviving-thread:${deletion}`);
        const otherProjectId = ProjectId.make("automation-other-project");
        yield* projects.create({
          commandId: CommandId.make(`automation-create-project:${deletion}`),
          projectId,
          title: "Automation lifecycle",
          workspaceRoot: `/work/automation-lifecycle/${deletion}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`automation-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : otherProjectId,
            title: "Automation target",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
        }
        const save = (name: string, target: ThreadId | null, webhook = false) =>
          tasks.upsert(
            {
              threadMode: target === null ? "new_thread" : "continue",
              id: ScheduledTaskId.make(`automation:${deletion}:${name}`),
              title: name,
              prompt: "Check orchestration progress",
              enabled: !webhook,
              schedule: webhook ? { type: "webhook" } : { type: "interval", everyMs: 60_000 },
              projectId: target === otherThreadId ? otherProjectId : projectId,
              threadId: target,
              workspaceStrategy: { type: "root" },
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "agent",
              creationSource: "mcp",
            },
            ScheduledTaskService.CHANGED_IN_APP,
          );
        const { task: bound } = yield* save("bound", threadId);
        const { task: webhook } = yield* save("webhook", threadId, true);
        const { task: independent } = yield* save("independent", null);
        yield* save("detached", threadId);
        const { task: detached } = yield* save("detached", null);
        yield* save("moved", threadId);
        const { task: moved } = yield* save("moved", otherThreadId);
        const { task: other } = yield* save("other", otherThreadId);
        yield* tasks.triggerWebhook({
          hookId: webhook.id,
          token: webhook.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: webhook.webhook!.path,
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
        });
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 1);

        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`automation-archive:${deletion}`),
          threadId,
        });
        yield* worker.drain();
        assert.include(
          (yield* tasks.list()).tasks.map((task) => task.id),
          bound.id,
        );

        if (deletion === "thread") {
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`automation-delete:${deletion}`),
            threadId,
          });
        } else {
          yield* projects.delete({
            commandId: CommandId.make(`automation-delete:${deletion}`),
            projectId,
            force: true,
          });
        }
        yield* worker.drain();
        const remainingIds = (yield* tasks.list()).tasks.map((task) => task.id);
        assert.notInclude(remainingIds, bound.id);
        assert.notInclude(remainingIds, webhook.id);
        assert.includeMembers(remainingIds, [independent.id, detached.id, moved.id, other.id]);
        assert.lengthOf((yield* tasks.listWebhookDeliveries({ id: webhook.id })).deliveries, 0);
        const rejected = yield* tasks.runNow({ id: bound.id }).pipe(Effect.flip);
        assert.equal(rejected.message, "Schedule task not found.");
        assert.equal(
          (yield* tasks.triggerWebhook({
            hookId: webhook.id,
            token: webhook.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: webhook.webhook!.path,
            query: "",
            headers: {},
            body: new Uint8Array(),
            bodyText: "",
          }))._tag,
          "not_found",
        );
        // Retried cleanup is harmless and cannot affect unrelated tasks.
        yield* tasks.deleteForThread(threadId);
        assert.sameMembers(
          (yield* tasks.list()).tasks.map((task) => task.id),
          remainingIds,
        );
      }),
  );

  it.effect.each(["archive", "thread delete", "project delete"] as const)(
    "%s releases the thread's devices and keeps them booted",
    (lifecycle) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const devices = yield* DeviceService.DeviceService;
        yield* devices.configure({ enabled: true, agentAccessEnabled: true });
        const projectId = ProjectId.make(`device-cleanup-project:${lifecycle}`);
        const threadId = ThreadId.make(`device-cleanup-thread:${lifecycle}`);
        const otherThreadId = ThreadId.make(`device-surviving-thread:${lifecycle}`);
        yield* projects.create({
          commandId: CommandId.make(`device-cleanup-create-project:${lifecycle}`),
          projectId,
          title: "Device cleanup",
          workspaceRoot: `/work/device-cleanup/${lifecycle}`,
        });
        for (const id of [threadId, otherThreadId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`device-cleanup-create:${id}`),
            createdBy: "user",
            creationSource: "web",
            threadId: id,
            projectId: id === threadId ? projectId : ProjectId.make("device-cleanup-other-project"),
            title: "Device user",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* devices.open({ threadId: id, deviceId: "phone", platform: "ios" });
        }
        const otherSessions = yield* devices.sessionsForThread(otherThreadId);

        const commandId = CommandId.make(`device-cleanup:${lifecycle}`);
        if (lifecycle === "project delete") {
          yield* projects.delete({ commandId, projectId, force: true });
        } else {
          yield* orchestrator.dispatch({
            type: lifecycle === "archive" ? "thread.archive" : "thread.delete",
            commandId,
            threadId,
          });
        }
        yield* worker.drain();

        assert.deepEqual(yield* devices.sessionsForThread(threadId), []);
        assert.deepEqual(yield* devices.sessionsForThread(otherThreadId), otherSessions);
        assert.isTrue((yield* devices.state).devices[0]?.booted);
      }),
  );

  it.effect.each(["no fork", "a live fork"] as const)(
    "a queued edit's cleanup keeps a file earlier history still shows, with %s",
    (fork) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const key = `queued-edit-shared-file-${fork.replaceAll(" ", "-")}`;
        const threadId = ThreadId.make(key);
        const storedFile = (name: string) =>
          ({
            type: "image",
            id: createAttachmentId(threadId)!,
            name: `${name}.png`,
            mimeType: "image/png",
            sizeBytes: 5,
          }) as const;
        const shared = storedFile("shared");
        const dropped = storedFile("dropped");
        const filePath = (file: typeof shared) =>
          path.join(config.attachmentsDir, `${file.id}.png`);
        yield* fileSystem.writeFileString(filePath(shared), "bytes");
        yield* fileSystem.writeFileString(filePath(dropped), "bytes");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${key}:create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make("queued-edit-shared-file-project"),
          title: "Shared file",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const writeRun = Effect.fn("test.writeQueuedEditRun")(function* (input: {
          readonly name: string;
          readonly ordinal: number;
          readonly status: "completed" | "queued";
          readonly attachments: ReadonlyArray<typeof shared>;
        }) {
          const now = yield* DateTime.now;
          const runId = RunId.make(`${key}:${input.name}`);
          const messageId = MessageId.make(`${key}:${input.name}`);
          const completed = input.status === "completed";
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${key}:${input.name}:run`),
                type: "run.created",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId,
                  ordinal: input.ordinal,
                  providerInstanceId: modelSelection.instanceId,
                  modelSelection,
                  providerThreadId: null,
                  userMessageId: messageId,
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: input.status,
                  requestedAt: now,
                  startedAt: completed ? now : null,
                  completedAt: completed ? now : null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make(`${key}:${input.name}:message`),
                type: "message.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId,
                  nodeId: null,
                  role: "user",
                  text: `Send ${input.name} work`,
                  attachments: input.attachments,
                  streaming: false,
                  createdBy: "user",
                  creationSource: "web",
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          return runId;
        });

        const sourceRunId = yield* writeRun({
          name: "source",
          ordinal: 1,
          status: "completed",
          attachments: [shared],
        });
        if (fork !== "no fork") {
          const forkThreadId = ThreadId.make(`${key}:fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:fork`),
            sourceThreadId: threadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const queuedRunId = yield* writeRun({
          name: "queued",
          ordinal: 2,
          status: "queued",
          attachments: [shared, dropped],
        });
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`${key}:edit`),
          threadId,
          runId: queuedRunId,
          text: "Send queued work without files",
          attachments: [],
        });
        yield* worker.drain();

        assert.isFalse(yield* fileSystem.exists(filePath(dropped)));
        assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");

        if (fork !== "no fork") {
          const laterRunId = yield* writeRun({
            name: "later",
            ordinal: 3,
            status: "completed",
            attachments: [shared],
          });
          const laterForkId = ThreadId.make(`${key}:later-fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:later-fork`),
            sourceThreadId: threadId,
            targetThreadId: laterForkId,
            sourcePoint: { type: "run", runId: laterRunId },
            createdBy: "user",
            creationSource: "web",
          });
          for (const id of [threadId, laterForkId]) {
            yield* orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`${key}:delete:${id}`),
              threadId: id,
            });
            yield* worker.drain();
            assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");
          }
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${key}:delete-first-fork`),
            threadId: ThreadId.make(`${key}:fork`),
          });
          yield* worker.drain();
          assert.isFalse(yield* fileSystem.exists(filePath(shared)));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  it.effect(
    "deletes a side chat with its parent only after the side chat's in-flight command",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const projectId = ProjectId.make("runtime-side-chat-delete");
        const parentId = ThreadId.make("runtime-side-chat-delete-parent");
        const sideChatId = ThreadId.make("runtime-side-chat-delete-child");
        const updateCommandId = CommandId.make("runtime-side-chat-delete-update");
        yield* projects.create({
          commandId: CommandId.make("runtime-side-chat-delete-project"),
          projectId,
          title: "Side chat deletion",
          workspaceRoot: "/work/side-chat-deletion",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("runtime-side-chat-delete-create"),
          createdBy: "user",
          creationSource: "web",
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("runtime-side-chat-delete-fork"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });

        const updateReady = yield* Deferred.make<void>();
        const releaseUpdate = yield* Deferred.make<void>();
        const deletionQueued = yield* Deferred.make<void>();
        const commitCommand = eventSink.commitCommand;
        const withLock = executor.withLock;
        let sideChatLockRequests = 0;
        const commitSpy = vi
          .spyOn(eventSink, "commitCommand")
          .mockImplementation((input) =>
            input.commandId === updateCommandId
              ? Deferred.succeed(updateReady, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseUpdate)),
                  Effect.andThen(commitCommand(input)),
                )
              : commitCommand(input),
          );
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) => {
          if (key !== sideChatId || ++sideChatLockRequests !== 2) return withLock(key, effect);
          return Deferred.succeed(deletionQueued, undefined).pipe(
            Effect.andThen(withLock(key, effect)),
          );
        };
        const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const updateFiber = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: updateCommandId,
              threadId: sideChatId,
              title: "Updated before deletion",
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(updateReady),
            Fiber.join(updateFiber).pipe(
              Effect.andThen(
                Effect.die("The update completed before reaching its commit barrier."),
              ),
            ),
          );
          const deleteFiber = yield* orchestrator
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make("runtime-side-chat-delete-parent"),
              threadId: parentId,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.raceFirst(
            Deferred.await(deletionQueued),
            Fiber.join(deleteFiber).pipe(
              Effect.andThen(Effect.die("Parent deletion bypassed the side chat's command.")),
            ),
          );
          yield* Deferred.succeed(releaseUpdate, undefined);
          yield* Fiber.join(updateFiber);
          yield* Fiber.join(deleteFiber);
          const sideChat = yield* orchestrator.getThreadProjection(sideChatId);
          assert.isNotNull(sideChat.thread.deletedAt);
          assert.equal(sideChat.thread.title, "Updated before deletion");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              commitSpy.mockRestore();
              lockSpy.mockRestore();
            }),
          ),
        );
      }),
  );

  // A fork from a side chat onto its parent used to lock the side chat, then the parent: the
  // reverse of the parent delete's order.
  it.effect("a parent delete and a fork from its side chat onto the parent do not deadlock", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-side-chat-lock-order");
      const parentId = ThreadId.make("runtime-side-chat-lock-order-parent");
      const sideChatId = ThreadId.make("runtime-side-chat-lock-order-child");
      yield* projects.create({
        commandId: CommandId.make("runtime-side-chat-lock-order-project"),
        projectId,
        title: "Side chat lock order",
        workspaceRoot: "/work/side-chat-lock-order",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-side-chat-lock-order-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("runtime-side-chat-lock-order-fork"),
        sourceThreadId: parentId,
        targetThreadId: sideChatId,
        sourcePoint: { type: "latest_stable" },
        sideChat: true,
        createdBy: "user",
        creationSource: "web",
      });

      const deleteHoldsParent = yield* Deferred.make<void>();
      const releaseDelete = yield* Deferred.make<void>();
      const forkWaitsForParent = yield* Deferred.make<void>();
      const { withLock, withLocks } = executor;
      let parentLockRequests = 0;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== parentId) return withLock(key, effect);
        // Dispatch builds locks it may not run, so count when one runs.
        return Effect.suspend(() =>
          ++parentLockRequests === 1
            ? withLock(
                key,
                Deferred.succeed(deleteHoldsParent, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseDelete)),
                  Effect.andThen(effect),
                ),
              )
            : Deferred.succeed(forkWaitsForParent, undefined).pipe(
                Effect.andThen(withLock(key, effect)),
              ),
        );
      };
      const observeLocks: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLocks"] = (
        keys,
        effect,
      ) =>
        keys.includes(parentId)
          ? Deferred.succeed(forkWaitsForParent, undefined).pipe(
              Effect.andThen(withLocks(keys, effect)),
            )
          : withLocks(keys, effect);
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      const locksSpy = vi.spyOn(executor, "withLocks").mockImplementation(observeLocks);
      yield* Effect.gen(function* () {
        const deleteFiber = yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-side-chat-lock-order-delete"),
            threadId: parentId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(deleteHoldsParent);
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-side-chat-lock-order-fork-back"),
            sourceThreadId: sideChatId,
            targetThreadId: parentId,
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(forkWaitsForParent);
        yield* Deferred.succeed(releaseDelete, undefined);
        yield* Fiber.join(deleteFiber);
        yield* Fiber.join(forkFiber);
        assert.isNotNull((yield* orchestrator.getThreadProjection(parentId)).thread.deletedAt);
        assert.isNotNull((yield* orchestrator.getThreadProjection(sideChatId)).thread.deletedAt);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lockSpy.mockRestore();
            locksSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  // A fork decides to lock its source before it waits for it, and its target can meanwhile become
  // a newer side chat of the source's parent, which a parent delete locks before the source.
  it.effect("a parent delete and a fork onto a target created meanwhile do not deadlock", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-fork-target-race");
      const parentId = ThreadId.make("runtime-fork-target-race-parent");
      const sourceId = ThreadId.make("runtime-fork-target-race-source");
      const targetId = ThreadId.make("runtime-fork-target-race-target");
      yield* projects.create({
        commandId: CommandId.make("runtime-fork-target-race-project"),
        projectId,
        title: "Fork target race",
        workspaceRoot: "/work/fork-target-race",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-fork-target-race-create"),
        createdBy: "user",
        creationSource: "web",
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const forkFromParent = (targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`runtime-fork-target-race-side-chat-${targetThreadId}`),
          sourceThreadId: parentId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
      yield* forkFromParent(sourceId);

      const holdsSource = yield* Deferred.make<void>();
      const releaseSource = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          sourceId,
          Deferred.succeed(holdsSource, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSource)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(holdsSource);
      const sourceRequests = yield* Queue.unbounded<void>();
      const { withLock, withLocks } = executor;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) =>
        key === sourceId
          ? Queue.offer(sourceRequests, undefined).pipe(Effect.andThen(withLock(key, effect)))
          : withLock(key, effect);
      const observeLocks: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLocks"] = (
        keys,
        effect,
      ) =>
        keys.includes(sourceId)
          ? Queue.offer(sourceRequests, undefined).pipe(Effect.andThen(withLocks(keys, effect)))
          : withLocks(keys, effect);
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      const locksSpy = vi.spyOn(executor, "withLocks").mockImplementation(observeLocks);
      yield* Effect.gen(function* () {
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-fork-target-race-fork"),
            sourceThreadId: sourceId,
            targetThreadId: targetId,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Queue.take(sourceRequests);
        yield* forkFromParent(targetId);
        const deleteFiber = yield* orchestrator
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-fork-target-race-delete"),
            threadId: parentId,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        // The delete holds the newer side chat and waits for the source.
        yield* Queue.take(sourceRequests);
        yield* Deferred.succeed(releaseSource, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(deleteFiber);
        yield* Fiber.join(forkFiber);
        for (const threadId of [parentId, sourceId, targetId]) {
          assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.deletedAt);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lockSpy.mockRestore();
            locksSpy.mockRestore();
          }),
        ),
      );
    }),
  );

  // A command can create the source before the fork gets its locks, so the fork waits for the
  // source's lock even while no source exists.
  it.effect("a fork of a missing source waits for that source's lock", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const sourceId = ThreadId.make("runtime-fork-missing-source");
      const holdsSource = yield* Deferred.make<void>();
      const releaseSource = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          sourceId,
          Deferred.succeed(holdsSource, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSource)),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(holdsSource);
      const sourceRequested = yield* Deferred.make<void>();
      const { withLocks } = executor;
      const observeLocks: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLocks"] = (
        keys,
        effect,
      ) =>
        keys.includes(sourceId)
          ? Deferred.succeed(sourceRequested, undefined).pipe(
              Effect.andThen(withLocks(keys, effect)),
            )
          : withLocks(keys, effect);
      const locksSpy = vi.spyOn(executor, "withLocks").mockImplementation(observeLocks);
      yield* Effect.gen(function* () {
        const forkFiber = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("runtime-fork-missing-source-fork"),
            sourceThreadId: sourceId,
            targetThreadId: ThreadId.make("runtime-fork-missing-source-target"),
            sourcePoint: { type: "latest_stable" },
            sideChat: true,
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        const first = yield* Effect.raceFirst(
          Deferred.await(sourceRequested).pipe(Effect.as("waits for the source")),
          Fiber.await(forkFiber).pipe(Effect.as("finished without it")),
        );
        assert.strictEqual(first, "waits for the source");
        yield* Deferred.succeed(releaseSource, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(forkFiber);
      }).pipe(Effect.ensuring(Effect.sync(() => locksSpy.mockRestore())));
    }),
  );

  it.effect("deleted sources keep the html_render pages any live fork shows", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const projectId = ProjectId.make("html-fork-project");
      const sourceThreadId = ThreadId.make("html-fork-source");
      const forkThreadId = ThreadId.make("html-fork-target");
      yield* projects.create({
        commandId: CommandId.make("html-fork-project"),
        projectId,
        title: "Page family",
        workspaceRoot: "/work/html-fork",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("html-fork-create"),
        threadId: sourceThreadId,
        projectId,
        title: "Page source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const inherited = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "inherited",
        ordinal: 1,
      });
      const fork = (sourceThreadId: ThreadId, runId: RunId, targetThreadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`html-fork:${targetThreadId}`),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "run", runId },
          createdBy: "user",
          creationSource: "web",
        });
      yield* fork(sourceThreadId, inherited.runId, forkThreadId);
      const forkPage = yield* writeHtmlRenderRun({
        threadId: forkThreadId,
        key: "fork",
        ordinal: 1,
      });
      const [first, second] = [ThreadId.make("html-fork-first"), ThreadId.make("html-fork-second")];
      yield* fork(forkThreadId, forkPage.runId, first);
      // Project deletion goes newest first, so it reaches `second` before `first`.
      yield* TestClock.adjust("1 second");
      yield* fork(forkThreadId, forkPage.runId, second);
      const firstRun = yield* writeHtmlRenderRun({ threadId: first, key: "first", ordinal: 1 });
      const later = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "later",
        ordinal: 2,
      });
      const deleteThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`html-fork-delete:${threadId}`),
          threadId,
        });
      const pagesOnDisk = Effect.gen(function* () {
        yield* worker.drain();
        return yield* Effect.forEach([inherited, forkPage, later], (page) =>
          fileSystem.exists(page.pagePath),
        );
      });
      yield* deleteThread(forkThreadId);
      yield* deleteThread(sourceThreadId);
      assert.deepEqual(yield* pagesOnDisk, [true, true, false]);

      // `first`'s delete pauses after reading what to free. A fork of it and the project delete,
      // which reaches `second`, must each wait on a lock it holds rather than decide on the same
      // state; `blocked` hears each request for one.
      const firstPlanned = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const blocked = yield* Queue.unbounded<void>();
      const readAttachmentIds = projections.getThreadAttachmentIds;
      const attachmentSpy = vi
        .spyOn(projections, "getThreadAttachmentIds")
        .mockImplementation((threadId) =>
          threadId === first
            ? readAttachmentIds(threadId).pipe(
                Effect.tap(() => Deferred.succeed(firstPlanned, undefined)),
                Effect.tap(() => Deferred.await(releaseFirst)),
              )
            : readAttachmentIds(threadId),
        );
      const deletionHeld = yield* Ref.make(false);
      const requestsHeld = (held: Effect.Effect<boolean>) =>
        Effect.all([Deferred.isDone(firstPlanned), held]).pipe(
          Effect.flatMap(([planned, isHeld]) =>
            planned && isHeld ? Queue.offer(blocked, undefined) : Effect.void,
          ),
        );
      const { withLock, withLocks, withDeletionLock } = executor;
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => requestsHeld(Effect.succeed(key === first)).pipe(Effect.andThen(withLock(key, effect)));
      const observeLocks: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLocks"] = (
        keys,
        effect,
      ) =>
        requestsHeld(Effect.succeed(keys.includes(first))).pipe(
          Effect.andThen(withLocks(keys, effect)),
        );
      const observeDeletion: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withDeletionLock"] =
        (effect) =>
          requestsHeld(Ref.get(deletionHeld)).pipe(
            Effect.andThen(
              withDeletionLock(
                Ref.set(deletionHeld, true).pipe(
                  Effect.andThen(effect),
                  Effect.ensuring(Ref.set(deletionHeld, false)),
                ),
              ),
            ),
          );
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      const locksSpy = vi.spyOn(executor, "withLocks").mockImplementation(observeLocks);
      const deletionSpy = vi
        .spyOn(executor, "withDeletionLock")
        .mockImplementation(observeDeletion);
      const forkOfDeleted = yield* Effect.gen(function* () {
        const firstFiber = yield* deleteThread(first).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(firstPlanned);
        const forkFiber = yield* fork(first, firstRun.runId, ThreadId.make("html-fork-late")).pipe(
          Effect.match({
            onSuccess: () => "created",
            onFailure: (error) => ("cause" in error ? String(error.cause) : error._tag),
          }),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.raceFirst(Queue.take(blocked), Fiber.await(forkFiber));
        const projectFiber = yield* projects
          .delete({ commandId: CommandId.make("html-fork-project-delete"), projectId, force: true })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(Queue.take(blocked), Fiber.await(projectFiber));
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(projectFiber);
        return yield* Fiber.join(forkFiber);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lockSpy.mockRestore();
            locksSpy.mockRestore();
            deletionSpy.mockRestore();
            attachmentSpy.mockRestore();
          }),
        ),
      );
      assert.deepEqual(
        { afterLastForks: yield* pagesOnDisk, forkOfDeleted },
        { afterLastForks: [false, false, false], forkOfDeleted: `Thread ${first} was deleted.` },
      );
    }),
  );
});

const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  layerProjectionReplayTest,
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      refreshRepositoryIdentity: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(Layer.merge(ServerSettings.layerTest(), MemoryAdmission.layerTest())),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

const attachRunningTurn = (threadId: ThreadId, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const eventSink = yield* EventSink.EventSinkV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const providerThread = projection.providerThreads.find(
      (row) => row.id === run.providerThreadId,
    )!;
    const now = yield* DateTime.now;
    const providerSession = {
      id: providerThread.providerSessionId!,
      driver,
      providerInstanceId: run.providerInstanceId,
      status: "running" as const,
      cwd: process.cwd(),
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const providerTurn = {
      id: ProviderTurnId.make(`${run.id}:${run.activeAttemptId}:turn`),
      providerThreadId: providerThread.id,
      nodeId: run.rootNodeId!,
      runAttemptId: run.activeAttemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    yield* eventSink.write({
      commandId: CommandId.make(`${run.id}:${run.activeAttemptId}:running`),
      events: [
        {
          id: EventId.make(`${run.id}:${run.activeAttemptId}:run-event`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          id: EventId.make(`${run.id}:${run.activeAttemptId}:session-event`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: providerSession,
        },
        {
          id: EventId.make(`${run.id}:${run.activeAttemptId}:turn-event`),
          type: "provider-turn.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: providerTurn,
        },
      ],
    });
    const steerTurn = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"]>(
      () => Effect.void,
    );
    const session: Partial<ProviderAdapter.ProviderAdapterV2SessionRuntime> = {
      providerSession,
      steerTurn,
    };
    const sessionSpy = vi
      .spyOn(sessions, "get")
      .mockReturnValue(
        Effect.succeedSome(session as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
    yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));

    return { now, providerSession, providerThread, providerTurn, steerTurn };
  });

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  const seedFailingRollbackThread = (name: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make(name);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-create`),
        threadId,
        projectId: ProjectId.make(`${name}-project`),
        title: "Rollback failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `/tmp/t3-${name}`,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${name}-message`),
        threadId,
        messageId: MessageId.make(`${name}-message`),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const scope = (yield* orchestrator.getThreadProjection(threadId)).checkpointScopes[0]!;
      const now = yield* DateTime.now;
      const checkpointId = CheckpointId.make(`${name}-checkpoint`);
      yield* eventSink.write({
        commandId: CommandId.make(`${name}-seed`),
        events: [
          {
            id: EventId.make(`${name}-checkpoint-event`),
            type: "checkpoint.captured",
            threadId,
            occurredAt: now,
            payload: {
              id: checkpointId,
              threadId,
              scopeId: scope.id,
              runId: null,
              nodeId: scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make(`refs/t3/${name}`),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          },
        ],
      });
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "not under test",
      });
      return {
        threadId,
        rollback: (commandId: CommandId) =>
          orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          }),
      };
    });

  it.effect("projects a rollback that fails every attempt and clears it on the next one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const { threadId, rollback } = yield* seedFailingRollbackThread("runtime-rollback-failure");

      const rollbackCommandId = CommandId.make("runtime-rollback-failure-rollback");
      yield* rollback(rollbackCommandId);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* worker.drain();
        yield* TestClock.adjust("30 seconds");
      }

      const [rollbackEffect] = yield* outbox.listByCommandId(rollbackCommandId);
      assert.equal(rollbackEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      // The seeded run never leaves `starting`, so every attempt refuses to cut under it.
      assert.deepEqual(failed.thread.rollbackFailure, {
        requestId: rollbackCommandId,
        message: LATER_RUN_ACTIVE_MESSAGE,
      });

      yield* rollback(CommandId.make("runtime-rollback-failure-retry"));
      const retried = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(retried.thread.rollbackFailure);
    }),
  );

  it.effect("captures and repeatedly rewinds non-Git conversations without losing run links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-non-git-rewind-" });
      const threadId = ThreadId.make("runtime-non-git-rewind");
      const rollbackThread = vi.fn(
        ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({
            providerThread: {
              ...providerThread,
              nativeThreadRef: {
                driver,
                nativeId: "rewound-native-thread",
                strength: "strong" as const,
              },
            },
          }),
      );
      const sessionSpy = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("non-git-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("non-git-project"),
        title: "Non-Git rewind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });

      const completeMessage = (name: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(name),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(name),
            text: name,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.userMessageId === name)!;
          const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          )!;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`${name}-complete`);
          // The provider completion is the fixture boundary; capture and rollback use real effects.
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-turn.start"],
            reason: "provider completion supplied by fixture",
          });
          yield* eventSink.writeWithEffects({
            commandId,
            events: [
              {
                id: EventId.make(`${name}-run`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "waiting", startedAt: now },
              },
              {
                id: EventId.make(`${name}-node`),
                type: "node.updated",
                threadId,
                runId: run.id,
                nodeId: node.id,
                occurredAt: now,
                payload: { ...node, status: "completed", completedAt: now },
              },
              {
                id: EventId.make(`${name}-turn`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${name}-turn`),
                  providerThreadId: providerThread.id,
                  nodeId: node.id,
                  runAttemptId: run.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: run.ordinal,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
            effects: [
              {
                id: `${name}-capture`,
                commandId,
                threadId,
                request: {
                  type: "checkpoint.capture",
                  runId: run.id,
                  scopeId: node.checkpointScopeId!,
                },
              },
            ],
          });
          yield* worker.drain();
          const captured = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            captured.runs.find((candidate) => candidate.id === run.id)?.status,
            "completed",
          );
          const checkpoint = captured.checkpoints.find((candidate) => candidate.runId === run.id)!;
          assert.equal(checkpoint.status, "missing");
          return { run, checkpoint };
        });

      const first = yield* completeMessage("non-git-first");
      const second = yield* completeMessage("non-git-second");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        before.checkpoints.find((checkpoint) => checkpoint.id === first.checkpoint.id)?.runId,
        first.run.id,
        "capturing a later run must preserve the earlier checkpoint's run link",
      );
      const baseline = before.checkpoints.find(
        (checkpoint) => checkpoint.ordinalWithinScope === 0,
      )!;
      assert.equal(baseline.status, "missing");
      for (const checkpoint of [baseline, first.checkpoint]) {
        for (const restoreFiles of [undefined, true]) {
          const commandId = CommandId.make(`non-git-files-${checkpoint.id}-${restoreFiles}`);
          yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId,
              threadId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              ...(restoreFiles === undefined ? {} : { restoreFiles }),
            })
            .pipe(Effect.flip);
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
      assert.equal(rollbackThread.mock.calls.length, 0);

      const rewind = (name: string) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(name);
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId: baseline.id,
            scopeId: baseline.scopeId,
            restoreFiles: false,
          });
          yield* worker.drain();
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
            ["succeeded"],
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.ok(projection.runs.every((run) => run.status === "rolled_back"));
          assert.isNull(projection.providerThreads[0]!.lastRunOrdinal);
          assert.equal(
            projection.providerThreads[0]!.nativeThreadRef?.nativeId,
            "rewound-native-thread",
          );
          assert.isNull(projection.thread.rollbackFailure);
        });

      yield* rewind("non-git-rewind-first");
      assert.equal(rollbackThread.mock.calls[0]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[0]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-first-turn"), ProviderTurnId.make("non-git-second-turn")],
      );
      const discardedCommandId = CommandId.make("non-git-discarded-target");
      yield* orchestrator
        .dispatch({
          type: "checkpoint.rollback",
          commandId: discardedCommandId,
          threadId,
          checkpointId: second.checkpoint.id,
          scopeId: second.checkpoint.scopeId,
          restoreFiles: false,
        })
        .pipe(Effect.flip);
      assert.deepEqual(yield* outbox.listByCommandId(discardedCommandId), []);
      assert.equal(rollbackThread.mock.calls.length, 1);

      const resent = yield* completeMessage("non-git-resent");
      assert.isAbove(resent.run.ordinal, second.run.ordinal);
      yield* rewind("non-git-rewind-again");
      assert.equal(rollbackThread.mock.calls.length, 2);
      assert.equal(rollbackThread.mock.calls[1]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[1]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-resent-turn")],
      );
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layerTest), NodeServices.layer))),
  );

  it.effect("rejects non-ready rollback targets before persisting events or effects", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-rollback-readiness");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-create"),
        threadId,
        projectId: ProjectId.make("runtime-rollback-readiness-project"),
        title: "Rollback readiness",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-message"),
        threadId,
        messageId: MessageId.make("runtime-rollback-readiness-message"),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const scope = projection.checkpointScopes[0]!;
      const now = yield* DateTime.now;

      for (const status of ["missing", "error", "stale", "ready"] as const) {
        const checkpointId = CheckpointId.make("runtime-rollback-checkpoint");
        const commandId = CommandId.make(`runtime-rollback-${status}`);
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-rollback-${status}-seed`),
          events: [
            {
              id: EventId.make(`runtime-rollback-${status}-event`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: scope.id,
                runId: null,
                nodeId: scope.nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                ref: CheckpointRef.make(`refs/t3/runtime-rollback-${status}`),
                status,
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
        const previousSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const rollback = orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId,
          threadId,
          checkpointId,
          scopeId: scope.id,
        });

        if (status === "ready") {
          const accepted = yield* rollback;
          assert.deepEqual(
            accepted.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request.type),
            ["provider-thread.rollback"],
          );
          const path = yield* Path.Path.pipe(
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("runtime-rollback-ancestor-create"),
            threadId: ThreadId.make("runtime-rollback-ancestor"),
            projectId: ProjectId.make("runtime-rollback-readiness-project"),
            title: "Ancestor workspace owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: path.dirname(process.cwd()),
          });
          const overlapCommandId = CommandId.make("runtime-rollback-overlap");
          const overlapSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const overlap = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: overlapCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(overlap.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), overlapSequence);
          assert.deepEqual(yield* outbox.listByCommandId(overlapCommandId), []);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-rollback-share"),
            threadId,
            worktreePath: null,
          });
          const sharedCommandId = CommandId.make("runtime-rollback-shared");
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          const shared = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: sharedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(shared.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          assert.deepEqual(yield* outbox.listByCommandId(sharedCommandId), []);
          const conversationOnly = yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("runtime-rollback-conversation"),
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          });
          assert.deepEqual(
            conversationOnly.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-rollback-delete"),
            threadId,
          });
          const deletedCommandId = CommandId.make("runtime-rollback-deleted");
          const deletedSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const deleted = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: deletedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            })
            .pipe(Effect.flip);
          assert.instanceOf(deleted, Orchestrator.OrchestratorDispatchError);
          assert.equal(deleted.cause, `Thread ${threadId} is deleted.`);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), deletedSequence);
          assert.deepEqual(yield* outbox.listByCommandId(deletedCommandId), []);
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
          assert.equal(
            error.cause,
            `Checkpoint ${checkpointId} is ${status} and cannot be restored.`,
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), previousSequence);
          assert.deepEqual(
            yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect),
            [],
          );
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          if (status === "error") {
            // A failed capture still pins the conversation.
            const conversationCommandId = CommandId.make("runtime-rollback-error-conversation");
            const conversationOnly = yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: conversationCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            });
            assert.deepEqual(
              conversationOnly.storedEvents.map((stored) => stored.event.type),
              ["thread.metadata-updated", "checkpoint.rollback-requested"],
            );
            assert.deepEqual(
              (yield* outbox.listByCommandId(conversationCommandId)).map(
                (effect) => effect.request.type,
              ),
              ["provider-thread.rollback"],
            );
          }
        }
      }
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("resolves delivery intent against the active run and starts after it completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-delivery-intent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-create"),
        threadId,
        projectId: ProjectId.make("runtime-delivery-intent-project"),
        title: "Delivery intent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-first"),
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-first"),
        text: "Start work.",
        attachments: [],
        // Only the account choice changes; the thread still keeps it.
        modelSelection: { ...modelSelection, autoAccount: true },
        dispatchMode: { type: "start_immediately" },
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      assert.isTrue(initial.thread.modelSelection.autoAccount);
      const run = initial.runs[0]!;
      const { now, providerSession, providerThread, providerTurn } = yield* attachRunningTurn(
        threadId,
        run,
      );
      const steerCommandId = CommandId.make("runtime-delivery-intent-auto");
      const steerMessageId = MessageId.make("runtime-delivery-intent-auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: steerCommandId,
        threadId,
        messageId: steerMessageId,
        text: "Include this in the active work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const steered = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(steered.runs, 1);
      assert.equal(
        steered.messages.find((message) => message.id === steerMessageId)?.runId,
        run.id,
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(steerCommandId)).map((effect) => effect.request),
        [
          {
            type: "provider-turn.steer",
            providerSessionId: providerSession.id,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: steerMessageId,
            modelSelection: run.modelSelection,
            steerFollowUpAfterRunOrdinal: run.ordinal,
          },
        ],
      );

      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-completed"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-completed"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "completed", completedAt: now },
          },
        ],
      });
      const nextCommandId = CommandId.make("runtime-delivery-intent-next");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: nextCommandId,
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-next"),
        text: "The previous run finished before this arrived.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "restart",
      });
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        restarted.runs.map((candidate) => candidate.status),
        ["completed", "starting"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(nextCommandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );
    }),
  );

  // regression: #37412 one thread's busy lock held up every other thread's run-end reaction
  it.effect("starts an idle thread's queued run while another thread's lock is busy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const now = yield* DateTime.now;
      const startRun = Effect.fnUntraced(function* (threadId: ThreadId) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make("runtime-run-end-isolation-project"),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:first`),
          threadId,
          messageId: MessageId.make(`${threadId}:first`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* eventSink.write({
          commandId: CommandId.make(`${threadId}:running`),
          events: [
            {
              id: EventId.make(`${threadId}:running-event`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now },
            },
          ],
        });
        return run;
      });
      const endRun = (run: OrchestrationV2Run) =>
        eventSink.write({
          commandId: CommandId.make(`${run.threadId}:completed`),
          events: [
            {
              id: EventId.make(`${run.threadId}:completed-event`),
              type: "run.updated",
              threadId: run.threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
      const busyThreadId = ThreadId.make("runtime-run-end-isolation-busy");
      const idleThreadId = ThreadId.make("runtime-run-end-isolation-idle");
      const busyRun = yield* startRun(busyThreadId);
      const idleRun = yield* startRun(idleThreadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${idleThreadId}:queue`),
        threadId: idleThreadId,
        messageId: MessageId.make(`${idleThreadId}:queued`),
        text: "Run this after the current turn.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedRun = (yield* orchestrator.getThreadProjection(idleThreadId)).runs.find(
        (run) => run.status === "queued",
      );
      assert.isDefined(queuedRun);

      const order: string[] = [];
      const queuedRunStarted = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === queuedRun.id &&
            event.payload.status !== "queued",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.sync(() => order.push("idle thread's queued run started"))),
        Effect.forkScoped,
      );
      // Stands in for a long send or delegated bookkeeping holding the busy thread's lock.
      const lockHeld = yield* Deferred.make<void>();
      const busyLock = yield* executor
        .withLock(
          busyThreadId,
          Deferred.succeed(lockHeld, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => order.push("busy thread's lock released"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lockHeld);

      yield* endRun(busyRun);
      yield* endRun(idleRun);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(busyLock);
      yield* Fiber.join(queuedRunStarted);

      assert.deepEqual(order, ["idle thread's queued run started", "busy thread's lock released"]);
    }),
  );

  // regression: one coordinator's busy lock held up every other coordinator's question wake
  it.effect("wakes an idle coordinator for its task's question while another's lock is busy", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const now = yield* DateTime.now;
      const delegate = Effect.fnUntraced(function* (parentThreadId: ThreadId) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:create`),
          threadId: parentThreadId,
          projectId: ProjectId.make("runtime-question-wake-project"),
          title: parentThreadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:first`),
          threadId: parentThreadId,
          messageId: MessageId.make(`${parentThreadId}:first`),
          text: "Delegate the research.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`${parentThreadId}:delegate`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Research the sources.",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
        });
        const childThreadId = (yield* orchestrator.getThreadProjection(parentThreadId))
          .subagents[0]!.childThreadId!;
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        const requestId = RuntimeRequestId.make(`${childThreadId}:question`);
        return {
          wakeMessageId: MessageId.make(
            `message:delegated-task-question:${parentThreadId}:${requestId}`,
          ),
          ask: eventSink.write({
            events: [
              {
                id: EventId.make(`${childThreadId}:question-event`),
                type: "runtime-request.updated",
                threadId: childThreadId,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: requestId,
                  nodeId: childRun.rootNodeId!,
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "message" },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
            ],
          }),
        };
      });
      // Started as server.ts starts it, so its wakes come from its own event stream.
      yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor.pipe(
        Effect.flatMap((reactor) => reactor.start()),
        Effect.provide(DelegatedTaskQuestionReactor.layer),
      );
      const busyThreadId = ThreadId.make("runtime-question-wake-busy");
      const busy = yield* delegate(busyThreadId);
      const idle = yield* delegate(ThreadId.make("runtime-question-wake-idle"));

      const order: string[] = [];
      const idleWoken = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) => event.type === "message.updated" && event.payload.id === idle.wakeMessageId,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.andThen(Effect.sync(() => order.push("idle coordinator woken"))),
        Effect.forkScoped,
      );
      // Stands in for a long send or delegated bookkeeping holding the busy coordinator's lock.
      const lockHeld = yield* Deferred.make<void>();
      const busyLock = yield* executor
        .withLock(
          busyThreadId,
          Deferred.succeed(lockHeld, undefined).pipe(
            Effect.andThen(Effect.sleep("1 minute")),
            Effect.andThen(Effect.sync(() => order.push("busy coordinator's lock released"))),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(lockHeld);

      yield* busy.ask;
      yield* idle.ask;
      // The wake reads the workspace from disk; behind the busy lock it would never arrive here.
      yield* Fiber.join(idleWoken);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(busyLock);

      assert.deepEqual(order, ["idle coordinator woken", "busy coordinator's lock released"]);
    }),
  );

  const seedPendingQuestion = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    responseCapability: OrchestrationV2RuntimeRequest["responseCapability"],
  ) {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`${threadId}:request`);
    const nodeId = NodeId.make(`${threadId}:node`);
    const itemId = TurnItemId.make(`${threadId}:item`);
    yield* eventSink.write({
      commandId: CommandId.make(`${threadId}:seed`),
      events: [
        {
          id: EventId.make(`${threadId}:node-event`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:request-event`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:item-event`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "user_input_request",
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            questions: [
              { id: "color", header: "Color", question: "Which color?", options: [] },
              {
                id: "sizes",
                header: "Sizes",
                question: "Which sizes?",
                options: [],
                multiSelect: true,
              },
              {
                id: "note",
                header: "Note",
                question: "Anything else?",
                options: [],
                required: false,
              },
            ],
          },
        },
      ],
    });
    return { requestId, nodeId, itemId };
  });

  it.effect.each([
    { trigger: "startup", scope: "run" },
    { trigger: "shutdown", scope: "session" },
  ] as const)(
    "recovers only reconstructable user questions and keeps their cards pending on $trigger ($scope)",
    ({ trigger, scope }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`runtime-recovered-question-${trigger}-${scope}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`runtime-recovered-question-create-${trigger}-${scope}`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`runtime-recovered-question-project-${trigger}-${scope}`),
          title: "Async question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        if (scope === "run") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:run`),
            threadId,
            messageId: MessageId.make(`${threadId}:message`),
            text: "Ask me a question",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
        }
        const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id ?? null;
        const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, runId, {
          type: "live",
          providerSessionId: ProviderSessionId.make(`lost-session-${trigger}-${scope}`),
        });
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const original = yield* orchestrator.getThreadProjection(threadId);
        const request = original.runtimeRequests[0]!;
        const questionItem = original.turnItems.find((item) => item.type === "user_input_request")!;
        const nativeThreadId = ThreadId.make(`runtime-recovered-native-child-${trigger}-${scope}`);
        const nativeRequestId = RuntimeRequestId.make(
          `runtime-recovered-native-request-${trigger}-${scope}`,
        );
        const approvalId = RuntimeRequestId.make(`runtime-recovered-approval-${trigger}-${scope}`);
        const missingTextId = RuntimeRequestId.make(
          `runtime-recovered-missing-text-${trigger}-${scope}`,
        );
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`recovery-approval-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: approvalId, kind: "command" },
            },
            {
              id: EventId.make(`recovery-missing-text-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: { ...request, id: missingTextId },
            },
            {
              id: EventId.make(`recovery-native-thread-${trigger}-${scope}`),
              type: "thread.created",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...original.thread,
                id: nativeThreadId,
                creationSource: "provider",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
            {
              id: EventId.make(`recovery-native-request-${trigger}-${scope}`),
              type: "runtime-request.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: { ...request, id: nativeRequestId },
            },
            {
              id: EventId.make(`recovery-native-item-${trigger}-${scope}`),
              type: "turn-item.updated",
              threadId: nativeThreadId,
              occurredAt: now,
              payload: {
                ...questionItem,
                id: TurnItemId.make(`recovery-native-item-${trigger}-${scope}`),
                type: "user_input_request",
                threadId: nativeThreadId,
                runId: null,
                requestId: nativeRequestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });
        yield* recovery.reconcile(trigger);
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        if (scope === "run") {
          assert.equal(recovered.runs[0]?.status, "cancelled");
        } else {
          assert.isEmpty(recovered.runs);
        }
        assert.deepEqual(
          recovered.runtimeRequests.find((row) => row.id === requestId),
          {
            ...request,
            responseCapability: { type: "message" },
          },
        );
        assert.equal(recovered.nodes.find((row) => row.id === nodeId)?.status, "waiting");
        assert.equal(recovered.turnItems.find((row) => row.id === itemId)?.status, "waiting");
        for (const id of [approvalId, missingTextId]) {
          const closed = recovered.runtimeRequests.find((row) => row.id === id);
          assert.equal(closed?.status, trigger === "startup" ? "expired" : "cancelled");
          assert.equal(closed?.responseCapability.type, "not_resumable");
        }
        const native = yield* orchestrator.getThreadProjection(nativeThreadId);
        assert.equal(
          native.runtimeRequests[0]?.status,
          trigger === "startup" ? "expired" : "cancelled",
        );
        assert.equal(native.runtimeRequests[0]?.responseCapability.type, "not_resumable");
        yield* recovery.reconcile("shutdown");
        yield* recovery.reconcile("startup");
        const rerecovered = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(rerecovered.runtimeRequests, recovered.runtimeRequests);
        const runItems = rerecovered.turnItems.filter((item) => item.runId === runId);
        const notices = runItems.filter((item) => item.type === "system_notice");
        assert.lengthOf(notices, scope === "run" ? 1 : 0);
        if (scope === "run") {
          assert.equal(notices[0]?.title, "Server restarted");
          assert.equal(notices[0]?.nodeId, recovered.runs[0]?.rootNodeId);
          assert.equal(notices[0]?.ordinal, Math.max(...runItems.map((item) => item.ordinal)));
        }
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`recovery-answer-${trigger}-${scope}`),
          threadId,
          requestId,
          answers: { color: "Blue", sizes: ["Small", "Large"] },
        });
        const answered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          answered.runtimeRequests.find((row) => row.id === requestId)?.status,
          "resolved",
        );
        assert.equal(answered.nodes.find((row) => row.id === nodeId)?.status, "completed");
        assert.equal(answered.turnItems.find((row) => row.id === itemId)?.status, "completed");
        assert.lengthOf(answered.runs, recovered.runs.length + 1);
        assert.equal(answered.messages.at(-1)?.runId, answered.runs.at(-1)?.id);
        assert.equal(
          answered.messages.at(-1)?.text,
          "Which color?\nBlue\n\nWhich sizes?\nSmall, Large",
        );
        assert.deepEqual(
          (yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`recovery-answer-${trigger}-${scope}`),
          )).map((effect) => effect.request.type),
          ["provider-turn.start"],
        );
      }),
  );

  it.effect("answers an async question after its provider exits and commits the answer once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-async-question");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-project"),
        title: "Async question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, null, {
        type: "message",
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
      const snooze = {
        type: "thread.snooze" as const,
        commandId: CommandId.make("runtime-async-question-snooze"),
        threadId,
        snoozedUntil: "2099-07-25T09:00:00.000Z",
      };
      yield* orchestrator.dispatch(snooze);
      const snoozed = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(snoozed.thread.snoozedUntil);
      assert.deepEqual(snoozed.runtimeRequests, beforeSnooze.runtimeRequests);
      assert.deepEqual(snoozed.turnItems, beforeSnooze.turnItems);
      assert.deepEqual(snoozed.nodes, beforeSnooze.nodes);
      assert.deepEqual(snoozed.runs, beforeSnooze.runs);

      // A question arriving after an earlier snooze must be acknowledged even
      // when the user picks the same wake time again.
      const priorSnooze = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 1_000);
      yield* eventSink.write({
        commandId: CommandId.make("runtime-async-question-earlier-snooze"),
        events: [
          {
            id: EventId.make("runtime-async-question-earlier-snooze-event"),
            type: "thread.snoozed",
            threadId,
            occurredAt: priorSnooze,
            payload: { ...snoozed.thread, snoozedAt: priorSnooze },
          },
        ],
      });
      yield* orchestrator.dispatch({
        ...snooze,
        commandId: CommandId.make("runtime-async-question-resnooze"),
      });
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedAt, now);
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-async-question-wake"),
        threadId,
        reason: "user",
      });
      const awake = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awake.thread.snoozedUntil);
      assert.deepEqual(awake.runtimeRequests, beforeSnooze.runtimeRequests);

      const beforeInvalid = yield* orchestrator.getThreadProjection(threadId);
      const beforeSequence = yield* eventSink.latestSequence();
      for (const [index, answers] of [
        { color: " ", sizes: ["Small"] },
        { color: "Blue", sizes: ["Small", " "] },
        { color: "Blue", sizes: ["Small"], extra: " " },
      ].entries()) {
        const commandId = CommandId.make(`runtime-async-question-invalid:${index}`);
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId,
            threadId,
            requestId,
            answers,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure", JSON.stringify(answers));
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), beforeInvalid);
        assert.equal(yield* eventSink.latestSequence(), beforeSequence);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }

      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("runtime-async-question-answer"),
        threadId,
        requestId,
        answers: { color: "  Blue  ", sizes: [], note: "" },
      };
      const accepted = yield* orchestrator.dispatch(command);
      const repeated = yield* orchestrator.dispatch(command);
      assert.equal(repeated.sequence, accepted.sequence);
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.runtimeRequests[0]?.status, "resolved");
      assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
      assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
      assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
      const answeredItem = answered.turnItems.find((item) => item.id === itemId);
      assert.equal(answeredItem?.type, "user_input_request");
      if (answeredItem?.type === "user_input_request") {
        assert.deepEqual(answeredItem.questionAnswer, {
          requestId,
          answers: command.answers,
          attachmentsByQuestionId: {},
          questionTextById: {
            color: "Which color?",
            sizes: "Which sizes?",
            note: "Anything else?",
          },
        });
      }
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\nBlue\n\nWhich sizes?\nNone selected");
      assert.equal(answered.messages[0]?.role, "user");
      assert.equal(answered.runs.length, 1);
      assert.deepEqual(
        (yield* outbox.listByCommandId(command.commandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );

      const duplicate = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("runtime-async-question-duplicate"),
        })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
    }),
  );

  it.effect("keeps a question an agent asked without waiting after its run ends", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-ask-user");
      const requestId = RuntimeRequestId.make("runtime-ask-user-request");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-ask-user-create"),
        createdBy: "agent",
        creationSource: "mcp",
        threadId,
        projectId: ProjectId.make("runtime-ask-user-project"),
        title: "Machine inbox",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const ask = (commandId: string, runId: RunId) =>
        orchestrator.dispatch({
          type: "user_input_request.record",
          commandId: CommandId.make(commandId),
          threadId,
          runId,
          requestId,
          questions: [
            {
              id: "q1",
              header: "Approve",
              question: "Approve the autopilot on this machine?",
              options: [
                { label: "Approve", description: "Approve" },
                { label: "Not now", description: "Not now" },
              ],
            },
          ],
        });
      const idle = yield* ask(
        "runtime-ask-user-without-run",
        RunId.make("runtime-ask-user-missing-run"),
      ).pipe(Effect.result);
      assert.equal(idle._tag, "Failure");

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("runtime-ask-user-run"),
        threadId,
        messageId: MessageId.make("runtime-ask-user-message"),
        text: "Run the inbox",
        attachments: [],
        createdBy: "agent",
        creationSource: "mcp",
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* ask("runtime-ask-user-ask", run.id);
      yield* ask("runtime-ask-user-retry", run.id);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-ask-user-run-ends"),
        events: [
          {
            id: EventId.make("runtime-ask-user-run-ends-event"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });

      const asked = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(asked.runtimeRequests, 1);
      assert.deepInclude(asked.runtimeRequests[0], {
        id: requestId,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
      });
      const card = asked.turnItems.find((item) => item.type === "user_input_request");
      assert.deepInclude(card, { requestId, status: "waiting", responseMode: "message" });
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "completed");
      assert.deepInclude(shell?.pendingRuntimeRequest, { id: requestId, kind: "user_input" });

      const late = yield* ask("runtime-ask-user-late", run.id).pipe(Effect.result);
      assert.equal(late._tag, "Success", "a retry after the run ends finds its question");
    }),
  );
  it.effect("sends an async answer's files as attachments on the answer message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-async-question-files");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-files-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-files-project"),
        title: "Async question with files",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId } = yield* seedPendingQuestion(threadId, null, { type: "message" });
      const screenshot = {
        type: "image" as const,
        id: createAttachmentId(threadId)!,
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("runtime-async-question-files-answer"),
        threadId,
        requestId,
        answers: { color: "", sizes: ["Small"], note: "" },
        attachmentsByQuestionId: { color: [screenshot] },
      });
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\n\nWhich sizes?\nSmall");
      assert.deepEqual(answered.messages[0]?.attachments, [screenshot]);
    }),
  );
  it.effect("reports an answer that never reaches its provider without reopening it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("runtime-lost-answer");
      // Projected as attached, but no live session holds it, so every delivery fails.
      const providerSessionId = ProviderSessionId.make("runtime-lost-answer-session");
      const requestId = RuntimeRequestId.make("runtime-lost-answer-request");
      const nodeId = NodeId.make("runtime-lost-answer-node");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-lost-answer-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-lost-answer-project"),
        title: "Lost answer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-lost-answer-seed"),
        events: [
          {
            id: EventId.make("runtime-lost-answer-session-event"),
            type: "provider-session.attached",
            threadId,
            driver,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "running",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("runtime-lost-answer-node-event"),
            type: "node.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("runtime-lost-answer-request-event"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "live", providerSessionId },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      const commandId = CommandId.make("runtime-lost-answer-answer");
      const answers = { color: "Blue" };
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId,
        answers,
      });
      const errors = orchestrator
        .getThreadProjection(threadId)
        .pipe(
          Effect.map((projection) => projection.turnItems.filter((item) => item.type === "error")),
        );

      // A delivery that can still be retried reports nothing.
      yield* worker.drain();
      assert.deepEqual(yield* errors, []);
      for (let attempt = 1; attempt < 5; attempt++) {
        yield* TestClock.adjust("30 seconds");
        yield* worker.drain();
      }

      const [deliveryEffect] = yield* outbox.listByCommandId(commandId);
      assert.equal(deliveryEffect?.request.type, "runtime-request.respond");
      assert.equal(deliveryEffect?.status, "failed");
      const failed = yield* orchestrator.getThreadProjection(threadId);
      const reported = failed.turnItems.filter((item) => item.type === "error");
      assert.equal(reported.length, 1);
      assert.equal(reported[0]?.status, "failed");
      assert.equal(reported[0]?.nodeId, nodeId);
      // The answer stays recorded; the user is not asked again.
      const request = failed.runtimeRequests.find((row) => row.id === requestId);
      assert.equal(request?.status, "resolved");
      assert.deepEqual(request?.answers, answers);
    }),
  );

  it.effect("dismisses message-capable questions directly and while settling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;

      const seedQuestion = Effect.fn("runtimeLayerTest.seedQuestion")(function* (name: string) {
        const threadId = ThreadId.make(`${name}-thread`);
        const requestId = RuntimeRequestId.make(`${name}-request`);
        const nodeId = NodeId.make(`${name}-node`);
        const itemId = TurnItemId.make(`${name}-item`);
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}-create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make(`${name}-project`),
          title: "Dismissible question",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* eventSink.write({
          commandId: CommandId.make(`${name}-seed`),
          events: [
            {
              id: EventId.make(`${name}-node-event`),
              type: "node.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make(`${name}-request-event`),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make(`${name}-item-event`),
              type: "turn-item.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: itemId,
                type: "user_input_request",
                threadId,
                runId: null,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                responseMode: "message",
                questions: [{ id: "choice", header: "Choice", question: "Continue?", options: [] }],
              },
            },
          ],
        });
        return { threadId, requestId, nodeId, itemId };
      });

      const dismissed = yield* seedQuestion("runtime-dismiss-question");
      yield* orchestrator.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("runtime-dismiss-question-command"),
        threadId: dismissed.threadId,
        requestId: dismissed.requestId,
      });
      const dismissedProjection = yield* orchestrator.getThreadProjection(dismissed.threadId);
      assert.equal(dismissedProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(dismissedProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        dismissedProjection.nodes.find((node) => node.id === dismissed.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        dismissedProjection.turnItems.find((item) => item.id === dismissed.itemId)?.status,
        "cancelled",
      );
      assert.lengthOf(dismissedProjection.messages, 0);

      const settled = yield* seedQuestion("runtime-settle-question");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-settle-question-command"),
        threadId: settled.threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(settled.threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.equal(settledProjection.runtimeRequests[0]?.status, "resolved");
      assert.equal(settledProjection.runtimeRequests[0]?.decision, "cancel");
      assert.equal(
        settledProjection.nodes.find((node) => node.id === settled.nodeId)?.status,
        "cancelled",
      );
      assert.equal(
        settledProjection.turnItems.find((item) => item.id === settled.itemId)?.status,
        "cancelled",
      );
    }),
  );

  it.effect("refuses busy merge-back targets without blocking the queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("runtime-layer-waiting-merge-project");
      const targetThreadId = ThreadId.make("runtime-layer-waiting-merge-target");
      const sourceThreadId = ThreadId.make("runtime-layer-waiting-merge-source");
      const baseRunId = RunId.make("runtime-layer-waiting-merge-base-run");
      const sourceRunId = RunId.make("runtime-layer-waiting-merge-source-run");
      const sourceProviderThreadId = ProviderThreadId.make(
        "runtime-layer-waiting-merge-provider-thread",
      );
      const forkTransferId = ContextTransferId.make("runtime-layer-waiting-merge-fork-transfer");

      yield* seedProject({
        projectId,
        title: "Merge-back project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-waiting-merge-create-target"),
        threadId: targetThreadId,
        projectId,
        title: "Waiting merge target",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);

      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-waiting-merge-seed"),
        events: [
          {
            id: EventId.make("runtime-layer-waiting-merge-source-thread-event"),
            type: "thread.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...target.thread,
              id: sourceThreadId,
              title: "Waiting merge source",
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: targetThreadId,
                relationshipToParent: "fork",
                rootThreadId: targetThreadId,
              },
              forkedFrom: {
                type: "run",
                threadId: targetThreadId,
                runId: baseRunId,
              },
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-fork-transfer-event"),
            type: "context-transfer.created",
            threadId: sourceThreadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: forkTransferId,
              type: "fork",
              sourceThreadId: targetThreadId,
              targetThreadId: sourceThreadId,
              sourcePoint: { threadId: targetThreadId, runId: baseRunId },
              basePoint: null,
              sourceProviderInstanceId: modelSelection.instanceId,
              targetProviderInstanceId: modelSelection.instanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-provider-thread-event"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceProviderThreadId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: "native-waiting-merge-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("runtime-layer-waiting-merge-source-run-event"),
            type: "run.created",
            threadId: sourceThreadId,
            runId: sourceRunId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: sourceRunId,
              threadId: sourceThreadId,
              ordinal: 1,
              providerInstanceId: modelSelection.instanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make("runtime-layer-waiting-merge-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "waiting",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-start"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-message"),
        text: "Keep working in the parent.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const activeTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const targetRun = activeTarget.runs[0]!;
      for (const status of ["preparing", "starting", "waiting", "queued", "running"] as const) {
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-layer-merge-target-${status}`),
          events: [
            {
              id: EventId.make(`runtime-layer-merge-target-${status}-event`),
              type: "run.updated",
              threadId: targetThreadId,
              runId: targetRun.id,
              occurredAt: now,
              payload: { ...targetRun, status },
            },
          ],
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "mobile",
            commandId: CommandId.make(`runtime-layer-merge-refused-${status}`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          error.cause,
          "Finish or stop the target thread's active work and clear its queue before merging back.",
        );
        const refusedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.deepEqual(refusedTarget.contextTransfers, activeTarget.contextTransfers);
        assert.equal(refusedTarget.runs[0]?.status, status);
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-merge-target-queue"),
        threadId: targetThreadId,
        messageId: MessageId.make("runtime-layer-merge-target-queued-message"),
        text: "Run this after the current turn.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const queuedRun = queuedTarget.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-merge-target-cancel-queue"),
        threadId: targetThreadId,
        runId: queuedRun.id,
      });
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-merge-target-complete"),
        events: [
          {
            id: EventId.make("runtime-layer-merge-target-completed-event"),
            type: "run.updated",
            threadId: targetThreadId,
            runId: targetRun.id,
            occurredAt: now,
            payload: { ...targetRun, status: "completed", completedAt: now },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        createdBy: "user",
        creationSource: "mobile",
        commandId: CommandId.make("runtime-layer-waiting-merge"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdAt: now,
      });

      const mergedTarget = yield* orchestrator.getThreadProjection(targetThreadId);
      const transfer = mergedTarget.contextTransfers.find(
        (candidate) => candidate.type === "merge_back",
      );
      assert.isDefined(transfer);
      assert.equal(transfer.status, "pending");
      assert.equal(transfer.sourceThreadId, sourceThreadId);
      assert.equal(transfer.targetThreadId, targetThreadId);
      assert.equal(transfer.sourcePoint.runId, sourceRunId);
      assert.isUndefined(transfer.sourcePoint.checkpointId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.nativeId, "native-waiting-merge-source");
      assert.equal(transfer.basePoint?.runId, baseRunId);
      assert.isNull(transfer.error);
    }),
  );
});

it.layer(layerLegacyImportTest)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      assert.isTrue((yield* maintenance.verify).valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, Orchestrator.OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

const writeHtmlRenderRun = Effect.fn("test.writeHtmlRenderRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly ordinal: number;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`html-fork-run:${input.key}`);
  const messageId = MessageId.make(`html-fork-message:${input.key}`);
  const attachmentId = createAttachmentId(input.threadId, "html")!;
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const pagePath = (yield* Path.Path).join(attachmentsDir, `${attachmentId}.html`);
  yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
  yield* fileSystem.writeFileString(pagePath, "<p>Page</p>");
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`html-fork-run:${input.key}`),
        type: "run.created",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: input.threadId,
          ordinal: input.ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make(`html-fork-message:${input.key}`),
        type: "message.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: input.threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Publish a page",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`html-fork-item:${input.key}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`html-fork-item:${input.key}`),
          type: "dynamic_tool",
          threadId: input.threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          toolName: "mcp__t3-code__html_render",
          input: {},
          output: [
            {
              type: "text",
              text: JSON.stringify({ htmlRender: { attachmentId, title: "Page", height: 300 } }),
            },
          ],
        },
      },
    ],
  });
  return { runId, pagePath };
});
const restartHeldQueue = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make(`${threadId}:project`),
      title: "Held with no resume",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    });
    for (const [index, text] of ["Active", "Queued"].entries()) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message:${index}`),
        threadId,
        messageId: MessageId.make(`${threadId}:message:${index}`),
        text,
        attachments: [],
        modelSelection,
        dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
      });
    }
    const eventSink = yield* EventSink.EventSinkV2;
    const [active] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const startedAt = yield* DateTime.now;
    yield* eventSink.write({
      commandId: CommandId.make(`${threadId}:running`),
      events: [
        {
          id: EventId.make(`${threadId}:running-event`),
          type: "run.updated",
          threadId,
          runId: active!.id,
          occurredAt: startedAt,
          payload: { ...active!, status: "running", startedAt },
        },
      ],
    });
    yield* recovery.reconcile("startup");
    const queuedId = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!.id;
    const heldRun = () =>
      orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map(({ runs }) => runs.find((run) => run.id === queuedId)!));
    assert.isTrue((yield* heldRun()).queueHeldByRestart);
    return { orchestrator, active: active!, queuedId, heldRun };
  });

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("persists the bounded set of starred messages without changing thread activity", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("message-stars");
      const projectId = ProjectId.make("message-stars-project");
      yield* seedProject({
        projectId,
        title: "Message stars",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      });
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`message-stars-create:${threadId}`),
          threadId,
          projectId,
          title: "Message stars",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
      const foreignThreadId = ThreadId.make("message-stars-other-thread");
      const foreignId = MessageId.make("message-stars-foreign");
      yield* createThread(threadId);
      yield* createThread(foreignThreadId);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.starredMessageIds ?? [],
        [],
      );
      const now = yield* DateTime.now;
      const ids = Array.from({ length: MAX_THREAD_STARRED_MESSAGES + 1 }, (_, index) =>
        MessageId.make(`message-stars-${index}`),
      );
      yield* eventSink.write({
        events: [...ids, foreignId].map((id) => ({
          id: EventId.make(id),
          type: "message.updated" as const,
          threadId: id === foreignId ? foreignThreadId : threadId,
          occurredAt: now,
          payload: {
            createdBy: "agent" as const,
            creationSource: "provider" as const,
            id,
            threadId: id === foreignId ? foreignThreadId : threadId,
            runId: null,
            nodeId: null,
            role: "assistant" as const,
            text: "Bookmark this",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        })),
      });
      const setStar = (messageId: MessageId, starred: boolean, step = `star:set:${messageId}`) =>
        orchestrator.dispatch({
          type: "thread.message.star",
          commandId: CommandId.make(step),
          threadId,
          messageId,
          starred,
        });
      for (const id of [MessageId.make("message-stars-missing"), foreignId]) {
        const rejected = yield* setStar(id, true).pipe(Effect.flip);
        assert.instanceOf(rejected, Orchestrator.OrchestratorMessageStarError);
        assert.equal(
          (rejected as Orchestrator.OrchestratorMessageStarError).reason,
          "message-not-found",
        );
      }
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.starredMessageIds ?? [],
        [],
      );
      const before = (yield* orchestrator.getThreadProjection(threadId)).thread.updatedAt;
      yield* TestClock.adjust("1 minute");
      const beforeLimit = ids.slice(0, MAX_THREAD_STARRED_MESSAGES - 1);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("message-stars-near-limit"),
            type: "thread.message-stars-updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: beforeLimit,
          },
        ],
      });
      const maximum = ids.slice(0, MAX_THREAD_STARRED_MESSAGES);
      yield* setStar(maximum.at(-1)!, true);
      const last = ids[MAX_THREAD_STARRED_MESSAGES]!;
      const rejectedId = `star:set:${last}`;
      const expectLimitRejection = (error: Orchestrator.OrchestratorV2Error) => {
        assert.instanceOf(error, Orchestrator.OrchestratorMessageStarError);
        assert.equal((error as Orchestrator.OrchestratorMessageStarError).reason, "limit-reached");
      };
      expectLimitRejection(yield* setStar(last, true, rejectedId).pipe(Effect.flip));
      const first = maximum[0]!;
      const same = yield* setStar(first, true, "already-starred");
      assert.deepEqual(same.storedEvents, []);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(projection.thread.starredMessageIds, maximum);
      assert.equal(
        DateTime.toEpochMillis(projection.thread.updatedAt),
        DateTime.toEpochMillis(before),
      );
      yield* setStar(first, false, "remove");
      expectLimitRejection(yield* setStar(last, true, rejectedId).pipe(Effect.flip));
      const added = yield* setStar(last, true, `star:add-after-removal:${last}`);
      for (const mismatch of [setStar(first, true, rejectedId), setStar(last, false, rejectedId)]) {
        const error = yield* mismatch.pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorCommandPreviouslyRejectedError);
      }
      const expected = ids.slice(1);
      const stored = Array.from(
        yield* eventSink
          .readByCommandId({ commandId: CommandId.make(`star:add-after-removal:${last}`) })
          .pipe(Stream.runCollect),
      );
      assert.deepEqual(
        stored.map(({ event }) => [event.type, event.payload]),
        [["thread.message-stars-updated", expected]],
      );
      assert.equal(added.storedEvents[0]?.sequence, stored[0]?.sequence);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("message-stars-rename"),
        threadId,
        title: "Renamed",
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.starredMessageIds,
        expected,
      );
      const sql = yield* SqlClient.SqlClient;
      const visitId = CommandId.make("message-stars-visit");
      const visit = yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: visitId,
        threadId,
        visitedAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.equal(visit.storedEvents[0]?.event.type, "thread.visit-recorded");
      assert.notProperty(visit.storedEvents[0]!.event.payload, "starredMessageIds");
      const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_events WHERE command_id = ${visitId}
      `;
      assert.lengthOf(rows, 1);
      assert.notProperty(JSON.parse(rows[0]!.payload_json), "starredMessageIds");
      const sent = yield* eventSink
        .stream({ threadId, eventType: "thread.visit-recorded", bounded: true })
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.equal(sent.sequence, visit.storedEvents[0]?.sequence);
      assert.notProperty(sent.event.payload, "starredMessageIds");
      assert.deepEqual(
        (yield* orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 10 })).projection.thread
          .starredMessageIds,
        expected,
      );
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.starredMessageIds,
        expected,
      );
      const gone = MessageId.make("message-stars-gone");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("message-stars-dangling"),
            type: "thread.message-stars-updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: [...expected.slice(1), gone],
          },
        ],
      });
      yield* setStar(gone, false, "remove-dangling");
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.starredMessageIds,
        expected.slice(1),
      );
    }),
  );

  it.effect("applies lifecycle commands idempotently and emits archive/removal shell deltas", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-lifecycle-thread");
      const projectId = ProjectId.make("runtime-layer-lifecycle-project");
      const project = {
        projectId,
        title: "Lifecycle project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      } as const;
      yield* seedProject(project);
      const create = {
        type: "thread.create" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        commandId: CommandId.make("runtime-layer-lifecycle-create"),
        threadId,
        projectId,
        title: "Lifecycle thread",
        folder: "Autopilot",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };

      const firstCreate = yield* orchestrator.dispatch(create);
      const retriedCreate = yield* orchestrator.dispatch(create);
      assert.equal(retriedCreate.sequence, firstCreate.sequence);
      assert.lengthOf(retriedCreate.storedEvents, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-lifecycle-metadata"),
        threadId,
        title: "Renamed lifecycle thread",
        branch: "feature/v2",
        worktreePath: "/tmp/t3-v2-worktree",
      });
      const staleWorkspaceUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-workspace"),
          threadId,
          branch: "feature/stale",
          worktreePath: "/tmp/stale-worktree",
          expectedWorktreePath: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleWorkspaceUpdate, Orchestrator.OrchestratorDispatchError);
      const staleBranchUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-branch"),
          threadId,
          branch: "feature/stale",
          expectedBranch: "main",
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleBranchUpdate, Orchestrator.OrchestratorDispatchError);
      assert.isTrue(Orchestrator.isStaleDispatchError(staleBranchUpdate));
      const projectionAfterStaleUpdates = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projectionAfterStaleUpdates.thread.branch, "feature/v2");
      assert.equal(projectionAfterStaleUpdates.thread.worktreePath, "/tmp/t3-v2-worktree");
      const pullRequestSnapshot = yield* orchestrator.getShellSnapshot();
      const pullRequest = {
        projectId,
        repository: "owner/repository",
        number: 24,
        url: "https://github.com/owner/repository/pull/24",
      };
      yield* moveProject(projectId, "/workspace/moved", "2026-09-07T00:01:00.000Z");
      const staleProjectWorkspace = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale-project-workspace"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/t3-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleProjectWorkspace, Orchestrator.OrchestratorDispatchError);
      yield* moveProject(projectId, project.workspaceRoot, "2026-09-07T00:02:00.000Z");
      // An unrelated thread event during discovery must not drop the branch pull request.
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-lifecycle-visit-during-pr-sync"),
        threadId,
        visitedAt: "2026-09-07T00:02:30.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("runtime-layer-lifecycle-pr-sync"),
        threadId,
        projectId,
        snapshotSequence: pullRequestSnapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/project",
          branch: "feature/v2",
          worktreePath: "/tmp/t3-v2-worktree",
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: pullRequest,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.branchPullRequest,
        pullRequest,
      );
      const stalePullRequestSync = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/t3-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(stalePullRequestSync, Orchestrator.OrchestratorDispatchError);
      const staleLinkedPullRequestReplacement = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale-replacement"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/t3-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: pullRequest,
          },
          branchPullRequest: pullRequest,
          linkedPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleLinkedPullRequestReplacement, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-interaction"),
        threadId,
        interactionMode: "plan",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-lifecycle-model"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("runtime-layer-lifecycle-active-order"),
        threadId,
        orderKey: "a0",
      });
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.activeOrderKey, "a0");

      const shellOf = (shell: Pick<OrchestrationV2ShellSnapshot, "threads">) =>
        shell.threads.find((thread) => thread.id === threadId)!;
      const untaggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      yield* TestClock.adjust("1 minute");
      for (const [step, tag, tagged, expected] of [
        ["add", "demo", true, ["demo"]],
        ["retry", "demo", true, ["demo"]],
        ["add-other", "private", true, ["demo", "private"]],
        ["remove", "demo", false, ["private"]],
        ["remove-last", "private", false, []],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`runtime-layer-lifecycle-tag-${step}`),
          threadId,
          tag,
          tagged,
        });
        assert.deepEqual(
          shellOf(yield* orchestrator.getShellSnapshot()).tags ?? [],
          expected,
          step,
        );
      }
      for (const notificationLevel of ["muted", "following", "default"] as const) {
        yield* orchestrator.dispatch({
          type: "thread.notification-level.set",
          commandId: CommandId.make(`runtime-layer-lifecycle-notifications-${notificationLevel}`),
          threadId,
          notificationLevel,
        });
        assert.equal(
          shellOf(yield* orchestrator.getShellSnapshot()).notificationLevel,
          notificationLevel,
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).thread.notificationLevel,
          notificationLevel,
        );
      }
      for (const color of ["blue", "purple", null] as const) {
        yield* orchestrator.dispatch({
          type: "thread.color.set",
          commandId: CommandId.make(`runtime-layer-lifecycle-color-${color}`),
          threadId,
          color,
        });
        assert.equal(shellOf(yield* orchestrator.getShellSnapshot()).color, color);
        assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.color, color);
      }
      const taggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      // Tags are not activity, so the thread keeps its place in thread lists.
      assert.equal(
        DateTime.toEpochMillis(taggedShell.updatedAt),
        DateTime.toEpochMillis(untaggedShell.updatedAt),
      );

      // A thread created with a folder starts in it.
      assert.equal(untaggedShell.folder, "Autopilot");
      for (const [step, folder, from, expected] of [
        ["rename", "Optimization", undefined, "Optimization"],
        // `from` no longer names the thread's folder, so the move made meanwhile stays.
        ["stale", "Elsewhere", "Autopilot", "Optimization"],
        ["clear", null, " optimization", undefined],
      ] as const) {
        const moved = yield* orchestrator
          .dispatch({
            type: "thread.folder.set",
            commandId: CommandId.make(`runtime-layer-lifecycle-folder-${step}`),
            threadId,
            folder,
            ...(from === undefined ? {} : { from }),
          })
          .pipe(
            Effect.as(true),
            Effect.catchIf(Orchestrator.isStaleDispatchError, () => Effect.succeed(false)),
          );
        assert.equal(moved, step !== "stale", step);
        const folderShell = shellOf(yield* orchestrator.getShellSnapshot());
        assert.equal(folderShell.folder, expected, step);
        assert.equal(
          DateTime.toEpochMillis(folderShell.updatedAt),
          DateTime.toEpochMillis(untaggedShell.updatedAt),
          `${step}: a folder is not activity`,
        );
      }

      yield* orchestrator.dispatch({
        type: "thread.later.set",
        commandId: CommandId.make("runtime-layer-lifecycle-later"),
        threadId,
        later: true,
      });
      const laterShell = shellOf(yield* orchestrator.getShellSnapshot());
      assert.isNotNull(laterShell.laterAt ?? null);
      // Putting a wait off is not activity either; a wait that starts afterwards outranks it.
      assert.equal(
        DateTime.toEpochMillis(laterShell.updatedAt),
        DateTime.toEpochMillis(untaggedShell.updatedAt),
      );
      yield* orchestrator.dispatch({
        type: "thread.later.set",
        commandId: CommandId.make("runtime-layer-lifecycle-later-back"),
        threadId,
        later: false,
      });
      assert.isNull(shellOf(yield* orchestrator.getShellSnapshot()).laterAt ?? null);

      const artifactId = `${toSafeThreadAttachmentSegment(threadId)}-00000000-0000-4000-8000-000000000001-html`;
      for (const [step, hidden, expected] of [
        ["hide", true, [artifactId]],
        ["retry", true, [artifactId]],
        ["restore", false, []],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.artifact.hide",
          commandId: CommandId.make(`runtime-layer-lifecycle-artifact-${step}`),
          threadId,
          attachmentId: artifactId,
          hidden,
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(threadId)).thread.hiddenArtifacts ?? [],
          expected,
          step,
        );
      }
      const foreignArtifact = yield* orchestrator
        .dispatch({
          type: "thread.artifact.hide",
          commandId: CommandId.make("runtime-layer-lifecycle-artifact-foreign"),
          threadId,
          attachmentId: "some-other-thread-00000000-0000-4000-8000-000000000001-html",
          hidden: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(foreignArtifact, Orchestrator.OrchestratorDispatchError);
      const malformedArtifact = yield* orchestrator
        .dispatch({
          type: "thread.artifact.hide",
          commandId: CommandId.make("runtime-layer-lifecycle-artifact-malformed"),
          threadId,
          attachmentId: `${toSafeThreadAttachmentSegment(threadId)}-forged`,
          hidden: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(malformedArtifact, Orchestrator.OrchestratorDispatchError);
      const artifactAt = (n: number) =>
        `${toSafeThreadAttachmentSegment(threadId)}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}-html`;
      for (let n = 1; n <= 201; n += 1) {
        yield* orchestrator.dispatch({
          type: "thread.artifact.hide",
          commandId: CommandId.make(`runtime-layer-lifecycle-artifact-cap-${n}`),
          threadId,
          attachmentId: artifactAt(n),
          hidden: true,
        });
      }
      const cappedHidden = (yield* orchestrator.getThreadProjection(threadId)).thread
        .hiddenArtifacts;
      assert.equal(cappedHidden?.length, 200);
      assert.deepEqual([cappedHidden?.[0], cappedHidden?.[199]], [artifactAt(2), artifactAt(201)]);

      const preAutoProjection = yield* orchestrator.getThreadProjection(threadId);
      const staleAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-stale"),
          threadId,
          snapshotAt: DateTime.makeUnsafe(
            DateTime.toEpochMillis(preAutoProjection.thread.updatedAt) - 1,
          ),
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleAutoSettle, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-settle"),
        threadId,
        snapshotAt: preAutoProjection.thread.updatedAt,
      });
      const autoSettledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(autoSettledProjection.thread.settledOverride, "settled");
      assert.isNull(autoSettledProjection.thread.activeOrderKey);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-unsettle"),
        threadId,
        reason: "user",
      });
      const postUnsettleProjection = yield* orchestrator.getThreadProjection(threadId);
      const overriddenAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-overridden"),
          threadId,
          snapshotAt: postUnsettleProjection.thread.updatedAt,
        })
        .pipe(Effect.flip);
      assert.instanceOf(overriddenAutoSettle, Orchestrator.OrchestratorDispatchError);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-settle"),
        threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.isNotNull(settledProjection.thread.settledAt);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-unsettle"),
        threadId,
        reason: "user",
      });
      const activeProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(activeProjection.thread.settledOverride, "active");
      assert.isNull(activeProjection.thread.settledAt);
      assert.isNotNull(activeProjection.thread.unsettledAt);
      const activeShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(activeShell?.unsettledAt, activeProjection.thread.unsettledAt);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-resettle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("runtime-layer-lifecycle-pin-settled"),
        threadId,
      });
      const pinnedProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(pinnedProjection.thread.settledOverride, "active");
      assert.isNotNull(pinnedProjection.thread.unsettledAt);

      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-lifecycle-archive"),
        threadId,
      });
      const archivedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        archivedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.include(
        archivedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      const activeOnlyShell = yield* orchestrator.getShellSnapshot({ location: "active" });
      assert.notInclude(
        activeOnlyShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.lengthOf(activeOnlyShell.archivedThreads, 0);
      const archiveOnlyShell = yield* orchestrator.getShellSnapshot({ location: "archive" });
      assert.lengthOf(archiveOnlyShell.threads, 0);
      assert.include(
        archiveOnlyShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: archive.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: archive.sequence,
          location: "active",
          threadId,
        },
      );

      const remove = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-lifecycle-delete"),
        threadId,
      });
      const deletedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        deletedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.notInclude(
        deletedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: remove.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: remove.sequence,
          location: "active",
          threadId,
        },
      );

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed lifecycle thread");
      assert.equal(projection.thread.branch, "feature/v2");
      assert.equal(projection.thread.worktreePath, "/tmp/t3-v2-worktree");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "gpt-5.5");
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNotNull(projection.thread.deletedAt);
    }),
  );

  it.effect("keeps the branch pull request when linking another pull request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("branch-pr-link");
      const projectId = ProjectId.make("branch-pr-project");
      yield* seedProject({
        projectId,
        title: "PR links",
        workspaceRoot: "/workspace/pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("branch-pr-create"),
        threadId,
        projectId,
        title: "PR links",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/pr-links",
        worktreePath: null,
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("branch-pr-discover"),
        threadId,
        projectId,
        snapshotSequence: snapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/pr-links",
          branch: "feature/pr-links",
          worktreePath: null,
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: {
          projectId,
          repository: "pingdotgg/t3code",
          number: 1,
          url: "https://github.com/pingdotgg/t3code/pull/1",
        },
      });
      for (const [index, number] of [2, 2, 1, 3].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`branch-pr-link-${index}`),
          threadId,
          host: "GitHub.com",
          repository: "Pingdotgg/T3code",
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
          number === 3 ? [1, 2, 3] : [1, 2],
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("branch-pr-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 1,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("branch-pr-link-after-unlink"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 4,
        url: "https://github.com/pingdotgg/t3code/pull/4",
        source: "manual",
      });
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
        [2, 3, 4],
      );
      for (const [index, route] of ["pull", "pulls"].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`gitcafe-pr-link-${index}`),
          threadId,
          host: "git.cafe",
          repository: "pingdotgg/t3code",
          number: 21353 + index,
          url: `https://git.cafe/pingdotgg/t3code/${route}/${21353 + index}`,
          source: "manual",
        });
      }
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests
          ?.filter((link) => link.host === "git.cafe")
          .map((link) => link.url),
        [21353, 21354].map((number) => `https://git.cafe/pingdotgg/t3code/pulls/${number}`),
      );
    }),
  );

  it.effect("keeps the branch pull request beside one opened in another repository", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("repository-pr-project");
      yield* seedProject({
        projectId,
        title: "Repository PR links",
        workspaceRoot: "/workspace/repository-pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      const linkedNumbers = Effect.fn("linkedNumbers")(function* (
        id: string,
        created: { readonly repository: string; readonly number: number },
      ) {
        const threadId = ThreadId.make(id);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${id}-create`),
          threadId,
          projectId,
          title: "PR links",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/pr-links",
          worktreePath: null,
        });
        const snapshot = yield* orchestrator.getShellSnapshot();
        yield* orchestrator.dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make(`${id}-discover`),
          threadId,
          projectId,
          snapshotSequence: snapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/repository-pr-links",
            branch: "feature/pr-links",
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: {
            projectId,
            repository: "pingdotgg/t3code",
            number: 1,
            url: "https://github.com/pingdotgg/t3code/pull/1",
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`${id}-link`),
          threadId,
          host: "github.com",
          ...created,
          url: `https://github.com/${created.repository}/pull/${created.number}`,
          source: "created",
        });
        return (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map(
          (link) => `${link.repository}#${link.number}`,
        );
      });

      assert.deepEqual(
        yield* linkedNumbers("repository-pr-other", { repository: "pingdotgg/api", number: 7 }),
        ["pingdotgg/t3code#1", "pingdotgg/api#7"],
      );
      // A branch that moved on to a new pull request does not drag the old one along.
      assert.deepEqual(
        yield* linkedNumbers("repository-pr-same", { repository: "pingdotgg/t3code", number: 2 }),
        ["pingdotgg/t3code#2"],
      );
    }),
  );

  it.effect("retains multiple pull requests and dismissed stack members through rebuilds", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-multiple-pull-requests");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("multi-pr-create"),
        threadId,
        projectId: ProjectId.make("multi-pr-project"),
        title: "Stack",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "GitHub.com", repository: "Pingdotgg/T3code" };
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`multi-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: number === 1 ? "manual" : "stack",
        });
      }
      const linked = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(
        linked?.pullRequests?.map(({ host, repository, number }) => ({ host, repository, number })),
        [1, 2].map((number) => ({ host: "github.com", repository: "pingdotgg/t3code", number })),
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-dismiss"),
        threadId,
        ...key,
        number: 2,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-unlink"),
        threadId,
        ...key,
        number: 1,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map(({ number, source }) => ({
          number,
          source,
        })),
        [{ number: 2, source: "stack-dismissed" }],
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-rediscover"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/pingdotgg/t3code/pull/2",
        source: "stack",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-restore"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/pingdotgg/t3code/pull/2",
        source: "manual",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "manual",
      );
    }),
  );

  it.effect("links an issue, syncs its snapshot, and unlinks it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("runtime-issue-links");
      const projectId = ProjectId.make("issue-link-project");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("issue-link-create"),
        threadId,
        projectId,
        title: "Issue links",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = {
        tracker: IssueTrackerKind.make("github"),
        host: "GitHub.com",
        scope: "Pingdotgg/T3code",
        key: "42",
      };
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make("issue-link-1"),
        threadId,
        ...key,
        projectId,
        url: "https://github.com/pingdotgg/t3code/issues/42",
        displayKey: "#42",
        title: "Issue links",
        source: "manual",
      });
      // A second link of the same issue, spelled differently, is a no-op.
      yield* orchestrator.dispatch({
        type: "thread.issue.link",
        commandId: CommandId.make("issue-link-2"),
        threadId,
        ...key,
        host: "github.com",
        scope: "pingdotgg/t3code",
        projectId,
        url: "https://github.com/pingdotgg/t3code/issues/42",
        displayKey: "#42",
        title: "Issue links, renamed",
        source: "agent",
      });
      yield* worker.drain();
      const linked = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(
        linked?.issues?.map(({ host, scope, key, source, title }) => ({
          host,
          scope,
          key,
          source,
          title,
        })),
        [
          {
            host: "github.com",
            scope: "Pingdotgg/T3code",
            key: "42",
            source: "manual",
            title: "Issue links",
          },
        ],
      );
      yield* orchestrator.dispatch({
        type: "thread.issue.unlink",
        commandId: CommandId.make("issue-unlink"),
        threadId,
        ...key,
      });
      yield* worker.drain();
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.issues, []);
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.issues, []);
    }),
  );

  it.effect("starts, records, and stops a pull request watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-pull-request-watch");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-project"),
        title: "Watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-start"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "agent",
      );
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("pr-watch-legacy-relink"),
        threadId,
        linkedPullRequest: { projectId: ProjectId.make("pr-watch-project"), ...key, url },
      });
      assert.deepEqual(yield* watchOf, started);

      const recorded = { ...started, headSha: "abc123", failedChecks: ["lint"], wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: recorded,
      });
      assert.deepEqual(yield* watchOf, recorded);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* watchOf, recorded);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-stop"),
        threadId,
        ...key,
        watching: false,
      });
      const late = yield* orchestrator
        .dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("pr-watch-late-record"),
          threadId,
          ...key,
          startedAt: started.startedAt,
          watch: { ...recorded, wakes: 2 },
          wake: {
            messageId: MessageId.make("pr-watch-late-wake"),
            text: "Update",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        })
        .pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");
      assert.isUndefined(yield* watchOf);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(messages, []);

      // A client start sends no CI state, so the link's last sync seeds it.
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("pr-watch-ci-running"),
        threadId,
        ...key,
        snapshot: {
          state: "open",
          title: "Watched pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-02T12:30:00.000Z",
          checksState: "pending",
        },
        stack: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-client-start"),
        threadId,
        ...key,
        watching: true,
      });
      assert.isTrue((yield* watchOf)?.checksPending);
    }),
  );

  it.effect("keeps how long a watch holds across reads until the agent changes it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-pull-request-watch-until-merged");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-until-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-project"),
        title: "Watch until merged",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      const watch = (id: string, until?: PullRequestWatchUntil) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(id),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
          ...(until !== undefined && { until }),
        });

      yield* watch("pr-watch-until-start");
      assert.isUndefined((yield* watchOf)?.until);

      yield* watch("pr-watch-until-on", "merged");
      const started = yield* watchOf;
      assert.equal(started?.until, "merged");
      if (started === undefined) return;

      // A read that began before the agent set it must not drop it.
      const { until: _read, ...readBefore } = started;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-until-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...readBefore, headSha: "abc123", checksPending: false },
      });
      assert.equal((yield* watchOf)?.until, "merged");
      assert.equal((yield* watchOf)?.headSha, "abc123");

      yield* watch("pr-watch-until-again");
      assert.equal((yield* watchOf)?.until, "merged");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* watchOf)?.until, "merged");

      yield* watch("pr-watch-until-off", "checks");
      assert.isUndefined((yield* watchOf)?.until);
      assert.equal((yield* watchOf)?.headSha, "abc123");
    }),
  );

  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make(`pr-watch-settle-${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-settle-create-${mode}`),
        threadId,
        projectId: ProjectId.make("pr-watch-settle-project"),
        title: "Settle watched PRs",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      yield* orchestrator.dispatch({
        ...(mode === "manual"
          ? { type: "thread.settle" as const }
          : { type: "thread.auto-settle" as const, snapshotAt: before.updatedAt }),
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch, ...link }) => ({
        ...link,
        endedWatch: watch,
      }));
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({
          ...restart,
          commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`),
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );

  // A thread watching a pull request, with a wake queued behind a running turn.
  const queuedWatchWake = (prefix: string) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`${prefix}-auto-settle`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${prefix}-create`),
        threadId,
        projectId: ProjectId.make(`${prefix}-project`),
        title: "Queued watch wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`${prefix}-start`),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
      });
      const started = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${prefix}-active`),
        threadId,
        messageId: MessageId.make(`${prefix}-active`),
        text: "Merge it",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const wakeMessageId = MessageId.make(prefix);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${prefix}-sync`),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "merged", wakes: 1 },
        wake: {
          messageId: wakeMessageId,
          text: "Update",
          notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7 merged" },
        },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const wakeRun = before.runs.find((run) => run.userMessageId === wakeMessageId);
      assert.isDefined(activeRun);
      assert.isDefined(wakeRun);
      assert.equal(wakeRun.status, "queued");
      assert.notEqual(wakeRun.queueHeld, true);
      return { threadId, activeRun, wakeRun };
    });

  // regression: #29898 settle on merge cancelled a watch wake queued behind the finished run
  it.effect("automatic settlement refuses a held wake only within the queued-turn grace", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { threadId, activeRun, wakeRun } = yield* queuedWatchWake("pr-watch-held-wake");
      const now = yield* DateTime.now;
      // Startup recovery's command prefix skips the completion reaction, as after a restart.
      yield* eventSink.write({
        commandId: CommandId.make("command:runtime-reconcile:pr-watch-held-wake"),
        events: [
          {
            id: EventId.make("pr-watch-held-wake-completed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...activeRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("pr-watch-held-wake-hold"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...wakeRun, queueHeld: true },
          },
        ],
      });
      const autoSettle = (commandId: string) =>
        Effect.flatMap(orchestrator.getThreadShell(threadId), (shell) =>
          orchestrator.dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(commandId),
            threadId,
            snapshotAt: shell?.updatedAt ?? now,
          }),
        );
      const early = yield* autoSettle("pr-watch-held-wake-early").pipe(Effect.exit);
      assert.equal(early._tag, "Failure");

      yield* TestClock.adjust(Orchestrator.QUEUED_TURN_START_GRACE_MS);
      yield* autoSettle("pr-watch-held-wake-late");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(after.thread.settledAt);
      assert.equal(after.runs.find((run) => run.id === wakeRun.id)?.status, "cancelled");
    }),
  );

  it.effect("archiving ends watches, and an archived thread cannot start one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-archive");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-archive-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-archive-project"),
        title: "Archive watched PR",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = {
        type: "thread.pull-request.watch" as const,
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" as const },
      };
      const watched = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      yield* orchestrator.dispatch({
        ...watch,
        commandId: CommandId.make("pr-watch-archive-start"),
      });
      assert.isTrue(yield* watched);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("pr-watch-archive"),
        threadId,
      });
      assert.isFalse(yield* watched);
      const refused = yield* orchestrator
        .dispatch({ ...watch, commandId: CommandId.make("pr-watch-archive-restart") })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("pr-watch-unarchive"),
        threadId,
      });
      assert.isFalse(yield* watched);
    }),
  );

  it.effect.each([
    { reason: "failed", activityFails: false },
    { reason: "not-found", activityFails: false },
    { reason: "failed", activityFails: true },
    { reason: "not-found", activityFails: true },
    { reason: "forbidden", activityFails: true },
    { reason: "cli-unauthenticated", activityFails: false },
  ] as const)(
    "handles repeated host read failures: $reason (activity fails: $activityFails)",
    ({ reason, activityFails }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(
          `runtime-pull-request-watch-unreadable-${reason}-${activityFails}`,
        );
        const projectId = ProjectId.make(`pr-watch-unreadable-project-${reason}-${activityFails}`);
        yield* seedProject({
          projectId,
          title: "Watch unreadable",
          workspaceRoot: "/workspace/watch-unreadable",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-unreadable-create-${reason}-${activityFails}`),
          threadId,
          projectId,
          title: "Watch unreadable",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-start-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 8,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
        });
        let disconnected = false;
        let passed = false;
        let genericFailure = false;
        const activityFailures = yield* Queue.unbounded<void>();
        const readFailure = (operation: string, failure: typeof reason) =>
          failure === "cli-unauthenticated"
            ? new PullRequestUnavailableError({
                reason: failure,
                provider: SourceControlProviderKind.make("github"),
                requirement: "Run `gh auth login`.",
                cause: new Error("private subprocess output"),
              })
            : new PullRequestOperationError({
                operation,
                detail: "host read failed",
                cause: new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation,
                  reason: failure,
                  detail: "host read failed",
                }),
              });
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () => Effect.succeed(null),
                detail: () =>
                  genericFailure
                    ? Effect.die("host read failed")
                    : disconnected
                      ? (activityFails ? Queue.take(activityFailures) : Effect.void).pipe(
                          Effect.andThen(Effect.fail(readFailure("detail", reason))),
                        )
                      : Effect.succeed({
                          ...watchedPullRequestDetail({
                            projectId,
                            number: 8,
                            at: "2026-10-02T12:00:00.000Z",
                          }),
                          headSha: "abc1234def",
                          checks: [
                            {
                              name: "test",
                              status: passed ? ("success" as const) : ("pending" as const),
                              description: null,
                              url: null,
                              required: true,
                            },
                          ],
                        }),
                activity: () =>
                  disconnected && activityFails
                    ? Queue.offer(activityFailures, undefined).pipe(
                        Effect.andThen(Effect.fail(readFailure("activity", "failed"))),
                      )
                    : Effect.succeed({
                        comments: [],
                        commentCount: 0,
                        commentsTruncated: false,
                        reviewThreads: [],
                        commits: [],
                      }),
              }),
            ),
          ),
        );
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        yield* sweep;
        assert.deepEqual(yield* summaries, []);
        disconnected = true;
        for (let pass = 0; pass < 15; pass += 1) {
          genericFailure = reason === "failed" && (pass === 0 || (pass >= 2 && pass <= 8));
          yield* TestClock.adjust("2 minutes");
          yield* sweep;
        }

        const thread = yield* orchestrator.getThreadShell(threadId);
        if (reason !== "failed") {
          assert.isUndefined(thread?.pullRequests?.[0]?.watch);
          const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
          const stopped = messages.filter((message) => message.notification !== undefined);
          assert.deepEqual(
            stopped.map((message) => message.notification?.summary),
            [
              reason === "cli-unauthenticated"
                ? "#8: stopped watching, host not set up on the server"
                : "#8: stopped watching, could not read it",
            ],
          );
          if (reason === "cli-unauthenticated") {
            assert.include(stopped[0]?.text, "Run `gh auth login`.");
            assert.notInclude(stopped[0]?.text, "private subprocess output");
          }
          return;
        }
        assert.isDefined(thread?.pullRequests?.[0]?.watch);
        assert.deepEqual(yield* summaries, []);
        disconnected = false;
        genericFailure = false;
        passed = true;
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-stop-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 8,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: watched #26248 merged and its agent kept saying it was still watching
  it.effect("wakes once when a watched pull request merges, naming the merge commit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-merged");
      const projectId = ProjectId.make("pr-watch-merged-project");
      yield* seedProject({
        projectId,
        title: "Watch merged",
        workspaceRoot: "/workspace/watch-merged",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-merged-create"),
        threadId,
        projectId,
        title: "Watch merged",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-merged-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 15,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/15", source: "agent" },
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () =>
                Effect.succeed({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state: "merged" as const,
                  mergedAt: "2026-10-02T12:00:00.000Z",
                  mergeCommitSha: "3b2f958603a51d8c42c4ede02eee7b8cb310b2d9",
                  mergedBy: { login: "juliusmarminge", name: null, avatarUrl: null },
                }),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
            }),
          ),
        ),
      );
      yield* reactor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;

      assert.isUndefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
      const wakes = (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.filter(
        (message) => message.notification != null,
      );
      assert.deepEqual(
        wakes.map((message) => message.notification?.summary),
        ["#15: merged, stopped watching"],
      );
      assert.include(wakes[0]!.text, "merged into main by juliusmarminge as 3b2f958");
    }),
  );

  it.effect.each([
    // The agent's merge of #19 needs no wake, but its command did not close #20.
    { name: "completed", status: "completed", wakes: ["#20: closed, stopped watching"] },
    // A merge command that failed ended nothing itself.
    {
      name: "failed",
      status: "failed",
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
    {
      name: "exit-1",
      status: "completed",
      exitCode: 1,
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
    {
      name: "failure-output",
      status: "completed",
      output: "GraphQL: Pull request is not mergeable\n<exited with exit code 1>",
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
  ] as const)(
    "ends a watch without a wake when the thread's own agent merged it ($name)",
    ({ name: key, status: ended, wakes: expected, ...result }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-own-merge-${key}`);
        const projectId = ProjectId.make(`pr-watch-own-merge-${key}-project`);
        yield* seedProject({
          projectId,
          title: "Watch own merge",
          workspaceRoot: `/workspace/watch-own-merge-${key}`,
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-own-merge-${key}-create`),
          threadId,
          projectId,
          title: "Watch own merge",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        for (const number of [19, 20]) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-own-merge-${key}-start-${number}`),
            threadId,
            host: "github.com",
            repository: "pingdotgg/t3code",
            number,
            watching: true,
            link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
          });
        }

        const states = new Map<number, PullRequestDetail["state"]>([
          [19, "open"],
          [20, "open"],
        ]);
        const detailReads = yield* Queue.unbounded<number>();
        const agentRead = yield* Deferred.make<void>();
        // Each of the reactor's subscribers reads every event, as each event sink stream does.
        const agentEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.sync(() => states.get(input.number)!).pipe(
                Effect.tap(() => Queue.offer(detailReads, input.number)),
                // Reads of an open pull request are slow, so the first sweep outlasts the merge.
                Effect.tap((state) => (state === "open" ? Effect.sleep("1 second") : Effect.void)),
                Effect.map((state) => ({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: input.number,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state,
                })),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            // A fingerprint that never changes, so only a forced read sees an end.
            watchFingerprint: () => Effect.succeed({ status: "steady", remarks: "" }),
            invalidate: () => Effect.void,
            changes: () => Stream.never,
          }),
          Layer.succeed(Orchestrator.OrchestratorV2, {
            ...orchestrator,
            streamDomainEvents: Stream.fromPubSub(agentEvents),
          }),
          // Only the read at a command's end asks for one thread's watches.
          Layer.effect(
            ProjectionStore.ProjectionStoreV2,
            Effect.map(ProjectionStore.ProjectionStoreV2, (store) => ({
              ...store,
              getThreadsWithPullRequests: (thread?: ThreadId) =>
                store
                  .getThreadsWithPullRequests(thread)
                  .pipe(
                    Effect.tap(() =>
                      thread === undefined ? Effect.void : Deferred.succeed(agentRead, undefined),
                    ),
                  ),
            })),
          ),
        );
        const runId = RunId.make(`run:${threadId}:1`);
        const command = (status: "running" | typeof ended) =>
          Effect.map(DateTime.now, (at): OrchestrationV2DomainEvent => ({
            type: "turn-item.updated",
            id: EventId.make(`event:${threadId}:merge-${status}`),
            threadId,
            runId,
            occurredAt: at,
            payload: {
              id: TurnItemId.make(`item:${threadId}:merge`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status,
              title: null,
              startedAt: at,
              completedAt: status === "completed" ? at : null,
              updatedAt: at,
              type: "command_execution",
              input: "gh pr merge 19 --squash",
              ...(status === "running" ? {} : result),
            },
          }));
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The first sweep has read both as open, and has not recorded that yet.
        yield* Queue.take(detailReads);
        yield* Queue.take(detailReads);

        // While the agent merges #19, someone else closes #20.
        yield* PubSub.publish(agentEvents, yield* command("running"));
        states.set(19, "merged");
        states.set(20, "closed");
        // The command's end reads the thread's watches in full, after that sweep.
        yield* PubSub.publish(agentEvents, yield* command(ended));
        yield* Deferred.await(agentRead);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(detailReads);
        yield* Queue.take(detailReads);
        // A sweep waits for that read to finish.
        yield* reactor.sweep;
        yield* worker.drain();
        const thread = yield* orchestrator.getThreadShell(threadId);
        assert.isTrue(thread?.pullRequests?.every((link) => link.watch === undefined));
        const wakes = (yield* orchestrator.getThreadRecords(threadId, [
          "messages",
        ])).messages.flatMap((message) => message.notification?.summary ?? []);
        assert.sameMembers(wakes, [...expected]);
      }),
  );

  it.effect("a pull request closed, reopened, and then merged wakes once for each end", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-reopened");
      const projectId = ProjectId.make("pr-watch-reopened-project");
      yield* seedProject({
        projectId,
        title: "Watch reopened",
        workspaceRoot: "/workspace/watch-reopened",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-reopened-create"),
        threadId,
        projectId,
        title: "Watch reopened",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 16 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-reopened-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/16", source: "agent" },
        });
      yield* watch("start");

      let state: PullRequestDetail["state"] = "closed";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 16,
                at: "2026-10-02T12:00:00.000Z",
              }),
              state,
              checks: [{ name: "lint", status: "pending" as const, description: null, url: null }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const watching = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, ["#16: closed, stopped watching"]);
      assert.isFalse(yield* watching);

      // Reopening does not restart the watch; the agent was told to watch again.
      state = "open";
      yield* watch("again");
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.isTrue(yield* watching);
      assert.deepEqual(yield* summaries, ["#16: closed, stopped watching"]);

      // The link's own sync can see the merge before the watch reads it.
      state = "merged";
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("pr-watch-reopened-synced"),
        threadId,
        ...key,
        snapshot: {
          state: "merged",
          title: "Watched pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-02T12:30:00.000Z",
          mergedAt: "2026-10-02T12:30:00.000Z",
        },
        stack: null,
      });
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#16: closed, stopped watching",
        "#16: merged, stopped watching",
      ]);
      assert.isFalse(yield* watching);
    }),
  );

  it.effect.each([
    // A transport failure, which an open pull request's watch outlasts.
    { name: "unreachable", reason: "failed" },
    // A rate limit pauses the watch before its detail read.
    { name: "rate-limited", reason: "rate-limited" },
  ] as const)(
    "wakes from a merged snapshot when the host cannot be read ($name)",
    ({ name, reason }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make(`pr-watch-merged-unreadable-${name}-project`);
        yield* seedProject({
          projectId,
          title: "Watch merged unreadable",
          workspaceRoot: `/workspace/watch-merged-unreadable-${name}`,
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 8 };
        // Another thread watches the same pull request, before its own link syncs.
        const [merged, unsynced] = (["merged", "unsynced"] as const).map((which) =>
          ThreadId.make(`runtime-pull-request-watch-merged-unreadable-${name}-${which}`),
        ) as [ThreadId, ThreadId];
        for (const threadId of [merged, unsynced]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}-create`),
            threadId,
            projectId,
            title: "Watch merged unreadable",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`${threadId}-start`),
            threadId,
            ...key,
            watching: true,
            link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
          });
        }
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${merged}-synced`),
          threadId: merged,
          ...key,
          snapshot: {
            state: "merged",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-02T12:30:00.000Z",
            mergedAt: "2026-10-02T12:30:00.000Z",
          },
          stack: null,
        });
        const failure = (operation: string) =>
          new PullRequestOperationError({
            operation,
            detail: "host unreadable",
            cause: new PullRequestProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation,
              reason,
              detail: "host unreadable",
            }),
          });
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () =>
                  reason === "rate-limited"
                    ? Effect.fail(failure("watchFingerprint"))
                    : Effect.succeed(null),
                invalidate: () => Effect.void,
                detail: () => Effect.fail(failure("detail")),
                activity: () => Effect.fail(failure("activity")),
              }),
            ),
          ),
        );
        yield* reactor.sweep;
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;

        const watchOf = (threadId: ThreadId) =>
          Effect.map(
            orchestrator.getThreadShell(threadId),
            (thread) => thread?.pullRequests?.[0]?.watch,
          );
        assert.isUndefined(yield* watchOf(merged));
        assert.isDefined(yield* watchOf(unsynced));
        const wakes = (yield* orchestrator.getThreadRecords(merged, ["messages"])).messages.filter(
          (message) => message.notification != null,
        );
        assert.deepEqual(
          wakes.map((message) => message.notification?.summary),
          ["#8: merged, stopped watching"],
        );
        assert.include(wakes[0]!.text, "merged into main, so");
      }),
  );

  it.effect("ends a watch on a closed pull request whose activity cannot be read", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-closed-unreadable");
      const projectId = ProjectId.make("pr-watch-closed-unreadable-project");
      yield* seedProject({
        projectId,
        title: "Watch closed unreadable",
        workspaceRoot: "/workspace/watch-closed-unreadable",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-closed-unreadable-create"),
        threadId,
        projectId,
        title: "Watch closed unreadable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-closed-unreadable-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 8,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/8", source: "agent" },
      });
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              watchFingerprint: () => Effect.succeed(null),
              detail: () =>
                Effect.succeed({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 8,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state: "closed" as const,
                }),
              activity: () => Effect.die("host unreachable"),
            }),
          ),
        ),
      );
      yield* reactor.sweep;

      const thread = yield* orchestrator.getThreadShell(threadId);
      assert.isUndefined(thread?.pullRequests?.[0]?.watch);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) => message.notification?.summary ?? []),
        ["#8: closed, stopped watching"],
      );
    }),
  );

  it.effect.each([
    // Failures from before the watch stay baseline, even with checks still running.
    {
      label: "finished failing",
      atStart: "failing",
      reads: [
        { lint: "failure", test: "success" },
        { lint: "failure", test: "success" },
      ],
      told: [[], []],
    },
    {
      label: "failing and still running",
      atStart: "failing",
      reads: [
        { lint: "failure", test: "pending" },
        { lint: "failure", test: "failure" },
      ],
      told: [[], ["test"]],
    },
    // Pending CI had no failure, so one the first read finds landed after the start.
    {
      label: "pending",
      atStart: "pending",
      reads: [
        { lint: "failure", test: "pending" },
        { lint: "failure", test: "failure" },
      ],
      told: [["lint"], ["test"]],
    },
  ] as const)(
    "reports only failures after a watch that starts on $label CI",
    ({ label, atStart, reads, told }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-start-${label}`);
        const projectId = ProjectId.make("pr-watch-start-project");
        yield* seedProject({
          projectId,
          title: "Watch start",
          workspaceRoot: "/workspace/watch-start",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-start-create-${label}`),
          threadId,
          projectId,
          title: "Watch start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 13 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`pr-watch-start-link-${label}`),
          threadId,
          ...key,
          url: "https://github.com/pingdotgg/t3code/pull/13",
          source: "manual",
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`pr-watch-start-sync-${label}`),
          threadId,
          ...key,
          snapshot: {
            state: "open",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-02T12:00:00.000Z",
            checksState: atStart,
          },
          stack: null,
        });
        // A client start, which carries no CI state of its own.
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-start-watch-${label}`),
          threadId,
          ...key,
          watching: true,
        });

        let read = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Effect.sync(() => ({
                ...watchedPullRequestDetail({
                  projectId,
                  number: 13,
                  at: "2026-10-02T12:00:00.000Z",
                }),
                headSha: "ad70160aaa",
                checks: Object.entries(reads[read]!).map(([name, status]) => ({
                  name,
                  status,
                  description: null,
                  url: null,
                })),
              })),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const texts = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.map((message) => message.text),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        for (const [index, names] of told.entries()) {
          read = index;
          const before = (yield* texts).length;
          if (index > 0) yield* TestClock.adjust("10 minutes");
          yield* reactor.sweep;
          yield* worker.drain();
          const wakes = (yield* texts).slice(before);
          assert.equal(wakes.length, names.length === 0 ? 0 : 1);
          // The finished section lists every failing check, so only the failed one counts here.
          const failedSections = wakes.map((text) => text.split("- Every check has finished")[0]!);
          for (const name of ["lint", "test"]) {
            assert.equal(
              failedSections.some((text) => text.includes(`  - ${name}`)),
              names.includes(name as never),
              `read ${index} told ${name}`,
            );
          }
        }
      }),
  );

  it.effect("baselines a new watch across restarts and reports later changes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-told");
      const projectId = ProjectId.make("pr-watch-told-project");
      yield* seedProject({
        projectId,
        title: "Watch told",
        workspaceRoot: "/workspace/watch-told",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-told-create"),
        threadId,
        projectId,
        title: "Watch told",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-told-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let headSha = "ad70160aaa";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks: ["lint", "test"].map((name) => ({
                name,
                status: "success" as const,
                description: null,
                url: null,
                required: true,
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);
      const baseline = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(baseline?.headSha, headSha);
      assert.isTrue(baseline?.passed);
      assert.deepEqual(baseline?.passedChecks, ["lint", "test"]);
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      headSha = "bbbbbbbbbb";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      headSha = "cccccccccc";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* watch(false, "end");
    }),
  );

  it.effect.each(["host-read", "synced-snapshot"] as const)(
    "tells the agent once when a watched PR merges (%s)",
    (merged) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-merged-${merged}`);
        const projectId = ProjectId.make(`pr-watch-merged-${merged}-project`);
        yield* seedProject({
          projectId,
          title: "Watch merged",
          workspaceRoot: "/workspace/watch-merged",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-merged-${merged}-create`),
          threadId,
          projectId,
          title: "Watch merged",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 20 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-merged-${merged}-start`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/20", source: "agent" },
        });
        if (merged === "synced-snapshot") {
          yield* orchestrator.dispatch({
            type: "thread.pull-request-link.sync",
            commandId: CommandId.make(`pr-watch-merged-${merged}-sync`),
            threadId,
            ...key,
            snapshot: {
              state: "merged",
              title: "Watched pull request",
              headBranch: "feature",
              baseBranch: "main",
              isDraft: false,
              updatedAt: "2026-10-02T12:00:00.000Z",
              syncedAt: "2026-10-02T12:00:00.000Z",
              mergedAt: "2026-10-02T12:00:00.000Z",
            },
            stack: null,
          });
        }
        const reactor = yield* PullRequestWatchReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                detail: () =>
                  Effect.succeed({
                    ...watchedPullRequestDetail({
                      projectId,
                      number: 20,
                      at: "2026-10-02T12:00:00.000Z",
                    }),
                    state: "merged" as const,
                    mergedAt: "2026-10-02T12:00:00.000Z",
                  }),
                activity: () =>
                  Effect.succeed({
                    comments: [],
                    commentCount: 0,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                  }),
              }),
            ),
          ),
        );
        for (let pass = 0; pass < 3; pass += 1) {
          yield* reactor.sweep;
          yield* TestClock.adjust("2 minutes");
        }

        const thread = yield* orchestrator.getThreadShell(threadId);
        assert.isUndefined(thread?.pullRequests?.[0]?.watch);
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        const summaries = messages.flatMap((message) => message.notification?.summary ?? []);
        assert.lengthOf(summaries, 1);
        assert.match(summaries[0]!, /^#20: .*merged/);
      }),
  );

  it.effect.each([
    ["an idle", false],
    ["a busy", true],
  ] as const)(
    "wakes %s thread once for a pass that changed several of its pull requests",
    ([, busy]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-pass-${busy}`);
        const projectId = ProjectId.make(`pr-watch-pass-project-${busy}`);
        yield* seedProject({
          projectId,
          title: "Watch pass",
          workspaceRoot: "/workspace/watch-pass",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-pass-create-${busy}`),
          threadId,
          projectId,
          title: "Watch pass",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const numbers = [12, 13, 14];
        for (const number of numbers) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-pass-start-${busy}-${number}`),
            threadId,
            host: "github.com",
            repository: "pingdotgg/t3code",
            number,
            watching: true,
            link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
          });
        }
        if (busy) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("pr-watch-pass-busy"),
            threadId,
            messageId: MessageId.make("pr-watch-pass-busy"),
            text: "Keep this run active.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
        }
        let status: "pending" | "failure" = "pending";
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.sync(() => ({
                ...watchedPullRequestDetail({
                  projectId,
                  number: input.number,
                  at: "2026-10-02T12:00:00.000Z",
                }),
                headSha: `head${input.number}`,
                checks: [{ name: "test", status, description: null, url: null, required: true }],
              })),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );

        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        yield* reactor.sweep;
        status = "failure";
        yield* reactor.sweep;
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        const wakes = messages.filter((message) => message.notification !== undefined);
        const stamps = wakes.map(({ notification }) =>
          notification?.source.kind === "monitor"
            ? [notification.source.pullRequest, ...(notification.source.otherPullRequests ?? [])]
                .map((stamp) => stamp?.number)
                .toSorted()
            : [],
        );
        assert.deepEqual(stamps, [numbers]);
        for (const number of numbers) assert.include(wakes[0]!.text, `#${number}`);
        if (!busy) return;

        // A pull request unwatched while the wake waited leaves it; the others still start.
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-pass-stop-12"),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: false,
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("pr-watch-pass-interrupt"),
          threadId,
          runId: active.id,
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const woken = after.messages.find((message) => message.id === wakes[0]!.id)!;
        assert.notInclude(woken.text, "#12");
        for (const number of [13, 14]) assert.include(woken.text, `#${number}`);
        assert.notEqual(
          after.runs.find((run) => run.userMessageId === woken.id)?.status,
          "cancelled",
        );
      }),
  );

  it.effect(
    "records when a watched PR's checks finish, unless a push cleared that during the read",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-quiet");
        const projectId = ProjectId.make("pr-watch-quiet-project");
        yield* seedProject({
          projectId,
          title: "Watch quiet",
          workspaceRoot: "/workspace/watch-quiet",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-quiet-create"),
          threadId,
          projectId,
          title: "Watch quiet",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        // Two watches, as with a stack, so news on both wakes the thread once for both.
        for (const number of [17, 18]) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-quiet-start-${number}`),
            threadId,
            host: "github.com",
            repository: "pingdotgg/t3code",
            number,
            watching: true,
            link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
          });
        }

        let e2e: PullRequestCheck["status"] = "pending";
        let comments: ReadonlyArray<PullRequestComment> = [];
        let gate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.gen(function* () {
                if (gate !== null) {
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: input.number,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  checks: [
                    { name: "test", status: "failure" as const, description: null, url: null },
                    { name: "e2e", status: e2e, description: null, url: null },
                  ],
                };
              }),
            activity: () =>
              Effect.sync(() => ({
                comments,
                commentCount: comments.length,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              })),
          }),
        );
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        const checksPending = Effect.map(orchestrator.getThreadShell(threadId), (thread) => {
          const answers = (thread?.pullRequests ?? []).map((link) => link.watch?.checksPending);
          assert.lengthOf(answers, 2);
          assert.strictEqual(answers[0], answers[1]);
          return answers[0];
        });

        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, []);
        assert.isTrue(yield* checksPending);
        const reopen = (id: string) =>
          orchestrator.dispatch({
            type: "thread.pull-request-watch.checks-reopen",
            commandId: CommandId.make(`pr-watch-quiet-${id}`),
            threadId,
          });
        // A push forgets a running answer too, so a read begun before it cannot settle it.
        yield* reopen("push-pending");
        assert.isUndefined(yield* checksPending);

        e2e = "success";
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, ["#17: checks finished; #18: checks finished"]);
        assert.isFalse(yield* checksPending);

        // A push clears the answer while a read with news is in flight. That read's answer is the
        // old head's, so the answer stays cleared while its news still wakes the agent.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate = { started, release };
        comments = [
          {
            id: "comment-1",
            kind: "issue-comment",
            author: { login: "reviewer", name: null, avatarUrl: null },
            body: "Looks good once CI passes.",
            createdAt: "2999-01-01T00:00:00.000Z",
            url: null,
            path: null,
            reviewState: null,
          },
        ];
        yield* TestClock.adjust("10 minutes");
        const inFlight = yield* reactor.sweep.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        yield* reopen("push");
        // Another push before the watch read again finds nothing to clear, which is fine.
        yield* reopen("push-again");
        gate = null;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(inFlight);
        assert.lengthOf(yield* summaries, 2);
        assert.isUndefined(yield* checksPending);

        // The next sweep reads it again though nothing on the host changed.
        yield* TestClock.adjust("2 minutes");
        yield* reactor.sweep;
        assert.isFalse(yield* checksPending);
      }),
  );

  it.effect.each(["pending", "action-required"] as const)("recovers %s watches", (initialStatus) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-owed-${initialStatus}`);
      const projectId = ProjectId.make(`pr-watch-owed-project-${initialStatus}`);
      yield* seedProject({
        projectId,
        title: "Watch owed",
        workspaceRoot: "/workspace/watch-owed",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-owed-create-${initialStatus}`),
        threadId,
        projectId,
        title: "Watch owed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-owed-${initialStatus}-${id}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 12,
          watching: on,
          link: { url: "https://github.com/pingdotgg/t3code/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let remainingStatus: "pending" | "action-required" | "success" = initialStatus;
      const approval = initialStatus === "action-required";
      const runUrl = "https://github.com/pingdotgg/t3code/actions/runs/123";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha: "ad70160aaa",
              checks: ["lint", "test"].map((name) => ({
                name,
                status: name === "test" ? remainingStatus : ("success" as const),
                description: null,
                url: name === "test" ? `${runUrl}/job/7` : null,
                required: name === "lint",
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.[
          approval ? "awaitingApproval" : "owedChecks"
        ],
        approval ? [runUrl] : ["test"],
      );
      // The fresh reactor reloads the nonempty obligation from the persisted watch.
      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      // A new watch on the same pull request knows what the last one told, and that its checks
      // were still running. A finished answer may be an older head's, so it reads again.
      yield* watch(false, "stop");
      yield* watch(true, "again");
      assert.strictEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.checksPending,
        approval ? undefined : true,
      );
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.[
          approval ? "awaitingApproval" : "owedChecks"
        ],
        approval ? [runUrl] : ["test"],
      );
      remainingStatus = "success";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        [],
      );
      yield* watch(false, "end");
    }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("a watch that ends on the comment limit keeps what its last pass saw", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-limit");
      const projectId = ProjectId.make("pr-watch-limit-project");
      yield* seedProject({
        projectId,
        title: "Watch limit",
        workspaceRoot: "/workspace/watch-limit",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-limit-create"),
        threadId,
        projectId,
        title: "Watch limit",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 13 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-limit-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/13", source: "agent" },
        });
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0],
      );
      yield* watch("start");
      const started = (yield* watchOf)?.watch;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-limit-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: {
          ...started,
          headSha: "abc1234def",
          passed: true,
          passedChecks: ["lint"],
          wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
        },
      });

      let status: "pending" | "success" = "pending";
      const commentAt = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(started.startedAt), { seconds: 1 }),
      );
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({ projectId, number: 13, at: commentAt }),
              checks: [{ name: "lint", status, description: null, url: null, required: true }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [
                {
                  id: "reviewer-comment",
                  kind: "issue-comment" as const,
                  author: { login: "reviewer", name: null, avatarUrl: null },
                  body: "One more thing.",
                  createdAt: commentAt,
                  url: "https://github.com/pingdotgg/t3code/pull/13#comment",
                  path: null,
                  reviewState: null,
                },
              ],
              commentCount: 1,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      const ended = yield* watchOf;
      assert.isUndefined(ended?.watch);
      assert.isFalse(ended?.endedWatch?.passed);
      assert.deepEqual(yield* summaries, ["#13: new comments, stopped watching"]);

      status = "success";
      yield* TestClock.adjust("10 minutes");
      yield* watch("again");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#13: new comments, stopped watching",
        "#13: checks passed",
      ]);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-limit-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  // regression: #23701 a head no check runs on never woke the watch
  it.effect("wakes once when no checks report on the head, without saying they passed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-no-checks");
      const projectId = ProjectId.make("pr-watch-no-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch no checks",
        workspaceRoot: "/workspace/watch-no-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-no-checks-create"),
        threadId,
        projectId,
        title: "Watch no checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      // A docs-only push that path filters keep every workflow off.
      let headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const anHourOfSweeps = Effect.gen(function* () {
        for (let pass = 0; pass < 6; pass++) {
          yield* reactor.sweep;
          yield* TestClock.adjust("10 minutes");
        }
        yield* reactor.sweep;
      });

      yield* anHourOfSweeps;
      const told = yield* wakes;
      assert.equal(told.length, 1, "one wake for a head with no checks");
      assert.notMatch(told[0]!.text, /\bpass/i);
      assert.notEqual(told[0]!.notification?.outcome, "completed");

      // An empty read on a head whose checks were seen is a failed read, not "no checks".
      headSha = "7777777777";
      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      // Without a fingerprint, a quiet pull request is read again only once the reread is due.
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      checks = [];
      yield* anHourOfSweeps;
      assert.equal((yield* wakes).length, 1);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  it.effect(
    "reads a watched pull request when the host reports a change, and wakes once per change",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-host-event");
        const projectId = ProjectId.make("pr-watch-host-event-project");
        yield* seedProject({
          projectId,
          title: "Watch host events",
          workspaceRoot: "/workspace/watch-host-event",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-host-event-create"),
          threadId,
          projectId,
          title: "Watch host events",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 15 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-start"),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/15", source: "agent" },
        });

        let checks: PullRequestDetail["checks"] = [
          { name: "lint", status: "pending", description: null, url: null, required: true },
        ];
        let fingerprints = 0;
        const events = yield* Queue.unbounded<void>();
        const following = yield* Deferred.make<void>();
        const detailReads = yield* Queue.unbounded<void>();
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Queue.offer(detailReads, undefined).pipe(
                Effect.as({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "aaaaaaaaaa",
                  checks,
                }),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            // A fresh fingerprint every time, so every pass reads the detail.
            watchFingerprint: () =>
              Effect.sync(() => ({ status: String(++fingerprints), remarks: "" })),
            invalidate: () => Effect.void,
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(Stream.fromQueue(events)),
              ),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter(
              (message) => message.notification !== undefined && message.notification !== null,
            ),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The feed starts after the first sweep has read the pull request.
        yield* Deferred.await(following);
        yield* Queue.take(detailReads);

        checks = [
          { name: "lint", status: "failure", description: null, url: null, required: true },
        ];
        yield* Queue.offer(events, undefined);
        // The clock never moves, so no sweep can be the one that reads the failure.
        yield* Queue.take(detailReads);
        // Nothing new: this read must compare against the watch the last one recorded.
        yield* Queue.offer(events, undefined);
        yield* Queue.take(detailReads);
        // A sweep waits for the change read in flight.
        yield* reactor.sweep;
        yield* worker.drain();
        const woken = yield* wakes;
        assert.lengthOf(woken, 1);
        assert.include(woken[0]!.notification?.summary ?? "", "failed");

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-end"),
          threadId,
          ...key,
          watching: false,
        });
      }),
  );

  it.effect(
    "reads a pull request when its watch starts, so checks that pass before a sweep wake",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-start-read");
        const projectId = ProjectId.make("pr-watch-start-read-project");
        yield* seedProject({
          projectId,
          title: "Watch start read",
          workspaceRoot: "/workspace/watch-start-read",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-start-read-create"),
          threadId,
          projectId,
          title: "Watch start read",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });

        let checks: PullRequestDetail["checks"] = [
          { name: "lint", status: "pending", description: null, url: null, required: true },
        ];
        const detailReads = yield* Queue.unbounded<void>();
        const watchListings = yield* Queue.unbounded<void>();
        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // Earlier tests can leave watches in other projects; only this one's reads count.
            detail: (input) =>
              (input.projectId === projectId
                ? Queue.offer(detailReads, undefined)
                : Effect.void
              ).pipe(
                Effect.as({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 16,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "bbbbbbbbbb",
                  checks,
                }),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            invalidate: () => Effect.void,
            changes: () => Stream.never,
          }),
          // Each subscriber reads every event, as each event sink stream does, and replay means one
          // that subscribes late misses none.
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: orchestrator.dispatch,
            streamDomainEvents: Stream.fromPubSub(domainEvents),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadsWithPullRequests: (id) =>
              projections
                .getThreadsWithPullRequests(id)
                .pipe(Effect.tap(() => Queue.offer(watchListings, undefined))),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter(
              (message) => message.notification !== undefined && message.notification !== null,
            ),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The first sweep listed watches before this one existed, so it cannot be the read below.
        yield* Queue.take(watchListings);

        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 16 };
        const started = yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-start-read-start"),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/16", source: "agent" },
        });
        yield* PubSub.publishAll(
          domainEvents,
          started.storedEvents.map((stored) => stored.event),
        );
        // The clock never moves, so no sweep can be the read that sees the checks running.
        yield* Queue.take(detailReads);

        checks = [
          { name: "lint", status: "success", description: null, url: null, required: true },
        ];
        // A sweep waits for the watch-start read in flight.
        yield* reactor.sweep;
        yield* worker.drain();
        const woken = yield* wakes;
        assert.lengthOf(woken, 1);
        assert.equal(woken[0]!.notification?.summary, "#16: checks passed");

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-start-read-end"),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  it.effect("wakes for checks that complete after the no-checks notice on the same head", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-late-checks");
      const projectId = ProjectId.make("pr-watch-late-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch late checks",
        workspaceRoot: "/workspace/watch-late-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-late-checks-create"),
        threadId,
        projectId,
        title: "Watch late checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
      });

      const headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      let activityUnavailable = false;
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            activityUnavailable
              ? Effect.die("comments unavailable")
              : Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
      yield* sweep;
      assert.lengthOf(yield* wakes, 0);
      yield* TestClock.adjust("20 minutes");
      yield* sweep;
      const noChecks = yield* wakes;
      assert.lengthOf(noChecks, 1);
      assert.include(noChecks[0]!.text, "No checks have reported");
      assert.equal(noChecks[0]!.notification?.outcome, "updated");

      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      assert.lengthOf(yield* wakes, 1);

      activityUnavailable = true;
      checks = [{ name: "lint", status: "success", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      const completed = yield* wakes;
      assert.lengthOf(completed, 2);
      assert.equal(completed[1]!.notification?.summary, "#14: checks passed");
      assert.include(completed[1]!.text, "All 1 required check passed on 6074dd4.");
      assert.equal(completed[1]!.notification?.outcome, "completed");

      yield* TestClock.adjust("1 hour");
      yield* sweep;
      const settled = yield* wakes;
      assert.lengthOf(settled, 2);
      assert.lengthOf(
        settled.filter((message) => message.text.includes("No checks have reported")),
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
      yield* worker.drain();
    }),
  );

  it.effect.each([true, false])(
    "reads a quiet head when its no-checks notice comes due (fingerprint: %s)",
    (fingerprinted) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-due-${fingerprinted}`);
        const projectId = ProjectId.make(`pr-watch-due-project-${fingerprinted}`);
        yield* seedProject({
          projectId,
          title: "Watch no-checks deadline",
          workspaceRoot: "/workspace/watch-due",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-due-create-${fingerprinted}`),
          threadId,
          projectId,
          title: "Watch no-checks deadline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-start-${fingerprinted}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/pingdotgg/t3code/pull/14", source: "agent" },
        });

        let reads = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // The host reports the same fingerprint throughout, so only the deadline can prompt a read.
            watchFingerprint: () =>
              Effect.succeed(fingerprinted ? { status: "quiet", remarks: "none" } : null),
            invalidate: () => Effect.void,
            detail: () =>
              Effect.sync(() => {
                reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 14,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter((message) => message.text.includes("No checks have reported")),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.lengthOf(yield* wakes, 0);

        yield* TestClock.adjust("6 minutes");
        yield* sweep;
        const told = yield* wakes;
        assert.lengthOf(told, 1);
        assert.include(told[0]!.text, "after 16 minutes");

        // The notice clears the deadline, so the watch returns to its quiet cadence.
        const readsAfterNotice = reads;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, readsAfterNotice);
        assert.lengthOf(yield* wakes, 1);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-end-${fingerprinted}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  it.effect.each([true, false])(
    "rereads pending checks only on a fingerprint change when it covers them (covers: %s)",
    (coversDetail) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-covers-${coversDetail}`);
        const projectId = ProjectId.make(`pr-watch-covers-project-${coversDetail}`);
        yield* seedProject({
          projectId,
          title: "Watch pending checks",
          workspaceRoot: "/workspace/watch-covers",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-covers-create-${coversDetail}`),
          threadId,
          projectId,
          title: "Watch pending checks",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "gitlab.com", repository: "acme/web", number: 15 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-covers-start-${coversDetail}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://gitlab.com/acme/web/-/merge_requests/15", source: "agent" },
        });

        let reads = 0;
        let status = "running";
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            watchFingerprint: () => Effect.sync(() => ({ status, remarks: "none", coversDetail })),
            invalidate: () => Effect.void,
            detail: (input) =>
              Effect.sync(() => {
                // Watches left by earlier cases in this layer are swept too.
                if (input.projectId === projectId) reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [
                    {
                      name: "lint",
                      status: "pending",
                      description: null,
                      url: null,
                      required: true,
                    },
                  ],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, coversDetail ? 1 : 2);

        status = "passed";
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, coversDetail ? 2 : 3);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-covers-end-${coversDetail}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("watching a dismissed stack layer again keeps what its last watch told", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-dismissed");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-dismissed-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-dismissed-project"),
        title: "Watch dismissed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 14 };
      const url = "https://github.com/pingdotgg/t3code/pull/14";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("pr-watch-dismissed-link"),
        threadId,
        ...key,
        url,
        source: "stack",
      });
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-dismissed-${id}`),
          threadId,
          ...key,
          watching: on,
          link: { url, source: "agent" },
        });
      yield* watching(true, "start");
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-dismissed-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "abc1234def", passed: true, passedChecks: ["lint"] },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("pr-watch-dismissed-unlink"),
        threadId,
        ...key,
      });
      yield* watching(true, "again");
      const again = yield* watchOf;
      assert.equal(again?.headSha, "abc1234def");
      assert.isTrue(again?.passed);
      yield* watching(false, "end");
    }),
  );

  it.effect("persists each merge queue removal wake across reactor restarts", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("queue-removal-watch");
      const projectId = ProjectId.make("queue-removal-project");
      yield* seedProject({
        projectId,
        title: "Queue removal",
        workspaceRoot: "/workspace/watch",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("queue-removal-create"),
        threadId,
        projectId,
        title: "Queue removal",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("queue-removal-start"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
      });
      let removal: PullRequestDetail["mergeQueueRemoval"];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          watchFingerprint: () =>
            Effect.succeed({ status: removal?.id ?? "green", remarks: "none" }),
          invalidate: () => Effect.void,
          detail: () =>
            Effect.succeed({
              ...watchedPullRequestDetail({ projectId, number: 7, at: "2026-10-02T12:00:00.000Z" }),
              checks: [{ name: "lint", status: "success", description: null, url: null }],
              ...(removal === undefined ? {} : { mergeQueueRemoval: removal }),
            }),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      removal = {
        id: "first",
        removedAt: "2000-01-01T00:00:00Z",
        reason: "Required checks failed",
      };
      yield* reactor.sweep;
      yield* worker.drain();
      const persisted = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(persisted?.mergeQueueRemovalId, "first");
      const restarted = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      removal = { ...removal, id: "second" };
      yield* restarted.sweep;
      yield* worker.drain();
      yield* restarted.sweep;
      yield* worker.drain();
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      const removals = messages.filter(
        (message) => message.notification?.summary === "#7: removed from merge queue",
      );
      assert.lengthOf(removals, 2);
      for (const message of removals) {
        assert.equal(message.notification?.outcome, "failed");
        assert.include(message.text, "Required checks failed");
      }
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch
          ?.mergeQueueRemovalId,
        "second",
      );
    }),
  );

  it.effect.each([
    "single page",
    "paginated",
    "page failure",
    "repeated cursor",
    "missing comments",
    "thread list truncated",
    "hidden reply",
  ])("wakes a watched thread once: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-wake-${mode}`);
      const projectId = ProjectId.make(`pr-watch-wake-project-${mode}`);
      yield* seedProject({
        projectId,
        title: "Watch wake",
        workspaceRoot: "/workspace/watch",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-wake-create-${mode}`),
        threadId,
        projectId,
        title: "Watch wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
      const url = "https://github.com/pingdotgg/t3code/pull/7";
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`pr-watch-wake-link-${mode}`),
        threadId,
        ...key,
        url,
        source: "agent",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`pr-watch-wake-start-${mode}`),
        threadId,
        ...key,
        watching: true,
      });

      const at = "2026-10-02T12:00:00.000Z";
      const detail = watchedPullRequestDetail({ projectId, number: key.number, at });
      const initialWatch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(initialWatch);
      const remark: PullRequestComment = {
        id: "review-1",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "One more thing.",
        createdAt: "2999-01-01T00:00:03.000Z",
        url: null,
        path: "src/index.ts",
        reviewState: null,
      };
      const firstTen = Array.from({ length: 10 }, (_, index) => ({
        ...remark,
        id: `old-${index}`,
        createdAt: "1900-01-01T00:00:00.000Z",
      }));
      const eleventh = {
        ...remark,
        id: "reply-11",
        body: "Eleventh reply.",
        createdAt: "2999-01-01T00:00:01.000Z",
      };
      const twelfth = {
        ...remark,
        id: "reply-12",
        body: "Twelfth reply.",
        createdAt: "2999-01-01T00:00:02.000Z",
      };
      const incomplete = mode !== "single page" && mode !== "paginated" && mode !== "hidden reply";
      let recovering = false;
      let pagesRead = 0;
      const reactor = yield* PullRequestWatchReactor.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.succeed(detail),
              activity: () =>
                Effect.succeed({
                  comments:
                    mode === "single page"
                      ? [remark]
                      : [...firstTen, { ...remark, kind: "issue-comment" }],
                  commentCount: mode === "single page" ? 1 : 13,
                  commentsTruncated: mode !== "single page",
                  reviewThreadsTruncated: mode === "thread list truncated" && !recovering,
                  reviewThreads:
                    mode === "single page"
                      ? []
                      : [
                          {
                            id: "review-thread",
                            path: "src/index.ts",
                            line: 1,
                            side: "right",
                            isResolved: false,
                            isOutdated: false,
                            comments: firstTen,
                            commentCount: mode === "hidden reply" ? 13 : 12,
                            nextCommentsCursor: "after-10",
                          },
                        ],
                  commits: [],
                }),
              threadComments: (input) => {
                pagesRead += 1;
                assert.equal(input.threadId, "review-thread");
                if (input.cursor === "after-10") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                assert.equal(input.cursor, "after-11");
                if (!recovering && mode === "page failure") {
                  return Effect.fail(
                    new PullRequestOperationError({
                      operation: "threadComments",
                      detail: "Page unavailable",
                    }),
                  );
                }
                if (!recovering && mode === "repeated cursor") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                if (!recovering && mode === "missing comments") {
                  return Effect.succeed({ comments: [], nextCursor: null });
                }
                return Effect.succeed({
                  comments: [eleventh, twelfth],
                  nextCursor: null,
                  ...(mode === "hidden reply" ? { hiddenCount: 1 } : {}),
                });
              },
            }),
          ),
        ),
      );
      if (incomplete) {
        yield* reactor.sweep;
        const held = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
        assert.equal(held?.remarksThrough, initialWatch?.remarksThrough);
        assert.deepEqual(held?.remarkIds, initialWatch?.remarkIds);
        assert.deepEqual(held?.failedChecks, ["lint"]);
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        assert.deepEqual(messages, []);
        yield* TestClock.adjust("1 millis");
        recovering = true;
      }
      yield* reactor.sweep;
      const pagesBefore = pagesRead;
      yield* reactor.sweep;
      assert.equal(pagesRead, pagesBefore);

      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) =>
          message.notification === undefined ? [] : [message.notification.summary],
        ),
        ["#7: new comments"],
      );
      if (mode !== "single page") {
        const wake = messages.at(-1);
        assert.include(wake?.text ?? "", "3 new comments");
        assert.include(wake?.text ?? "", "Eleventh reply.");
        assert.include(wake?.text ?? "", "Twelfth reply.");
      }
      const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(watch?.remarksThrough, remark.createdAt);
      assert.deepEqual(watch?.remarkIds, [remark.id]);
      assert.deepEqual(
        { headSha: watch?.headSha, failedChecks: watch?.failedChecks, wakes: watch?.wakes },
        { headSha: "abc1234def", failedChecks: ["lint"], wakes: 1 },
      );
    }),
  );

  const createWatchedThread = Effect.fnUntraced(function* (name: string, reopened = false) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`pr-wake-${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}-create`),
      threadId,
      projectId: ProjectId.make(`${threadId}-project`),
      title: "Watch wake",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    });
    const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`${threadId}-watch`),
      threadId,
      ...key,
      watching: true,
      link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
    });
    let watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
    assert.isDefined(watch);
    const snapshotSyncedAt = reopened
      ? DateTime.formatIso(yield* DateTime.now)
      : "2026-10-02T12:00:00.000Z";
    if (reopened) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${threadId}-end-watch`),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: null,
      });
      yield* TestClock.adjust("1 millis");
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`${threadId}-rewatch`),
        threadId,
        ...key,
        watching: true,
      });
      watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(watch);
    }
    return { threadId, key, watch, snapshotSyncedAt };
  });

  it.effect.each([
    "unwatch",
    "unlink",
    "new watch",
    "merged",
    "closed",
    "newer head",
    "comments then newer head",
    "comment limit",
    "still watching",
    "closed notice",
    "closed notice unlinked and relinked",
    "reopened",
  ] as const)("revalidates a queued pull-request wake before promotion: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { threadId, key, watch, snapshotSyncedAt } = yield* createWatchedThread(
        `queued-${mode}`,
        mode === "reopened",
      );
      const finalNotice =
        mode === "closed notice" || mode === "closed notice unlinked and relinked";
      const deliverable =
        mode === "still watching" ||
        mode === "closed notice" ||
        mode === "reopened" ||
        mode === "comments then newer head" ||
        mode === "comment limit";
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}-active`),
        threadId,
        messageId: MessageId.make(`${threadId}-active`),
        text: "Active work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const wakeMessageId = MessageId.make(`${threadId}-wake`);
      const recordedWatch = { ...watch, headSha: "abc123", wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${threadId}-wake`),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: finalNotice ? null : recordedWatch,
        wake: {
          messageId: wakeMessageId,
          text: finalNotice ? "Closed, stopped watching" : "Checks failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: finalNotice ? "#7: closed, stopped watching" : "#7: checks failed",
          },
          ...(mode === "comments then newer head" || mode === "comment limit"
            ? { includesRemarks: true }
            : {}),
        },
      });
      const userMessageId = MessageId.make(`${threadId}-user`);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}-user`),
        threadId,
        messageId: userMessageId,
        text: "User follow-up",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const wakeRun = before.runs.find((run) => run.userMessageId === wakeMessageId);
      const userRun = before.runs.find((run) => run.userMessageId === userMessageId);
      assert.isDefined(activeRun);
      assert.isDefined(wakeRun);
      assert.isDefined(userRun);
      assert.equal(wakeRun.status, "queued");
      assert.equal(userRun.status, "queued");

      if (mode === "unwatch" || mode === "new watch") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`${threadId}-unwatch`),
          threadId,
          ...key,
          watching: false,
        });
        if (mode === "new watch") {
          yield* TestClock.adjust("1 millis");
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`${threadId}-rewatch`),
            threadId,
            ...key,
            watching: true,
          });
          const restarted = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]
            ?.watch;
          assert.isDefined(restarted);
          assert.notEqual(restarted.startedAt, watch.startedAt);
          yield* orchestrator.dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`${threadId}-same-head`),
            threadId,
            ...key,
            startedAt: restarted.startedAt,
            watch: { ...restarted, headSha: recordedWatch.headSha },
          });
        }
      } else if (mode === "unlink" || mode === "closed notice unlinked and relinked") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make(`${threadId}-unlink`),
          threadId,
          ...key,
        });
        if (mode === "closed notice unlinked and relinked") {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`${threadId}-relink`),
            threadId,
            ...key,
            url: "https://github.com/pingdotgg/t3code/pull/7",
            source: "manual",
          });
        }
      } else if (
        mode === "merged" ||
        mode === "closed" ||
        mode === "closed notice" ||
        mode === "reopened"
      ) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${threadId}-snapshot`),
          threadId,
          ...key,
          snapshot: {
            state: mode === "merged" ? "merged" : "closed",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            // A delayed sync can still report the closure from before this watch restarted.
            syncedAt: snapshotSyncedAt,
          },
          stack: null,
        });
      } else if (mode === "comment limit") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-exhausted`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: null,
          endedWatch: recordedWatch,
          wake: {
            messageId: MessageId.make(`${threadId}-exhausted`),
            text: "New comments, stopped watching",
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: "#7: new comments, stopped watching",
            },
            includesRemarks: true,
          },
        });
      } else if (mode === "newer head" || mode === "comments then newer head") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-advance`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: { ...recordedWatch, headSha: "def456" },
        });
      }

      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      const completedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}-completed`),
            type: "run.updated",
            threadId,
            runId: activeRun.id,
            ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: completedAt,
            payload: { ...activeRun, status: "completed", completedAt },
          },
        ],
      });
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        after.runs.find((run) => run.id === wakeRun.id)?.status,
        deliverable ? "starting" : "cancelled",
      );
      assert.equal(
        after.runs.find((run) => run.id === userRun.id)?.status,
        deliverable ? "queued" : "starting",
      );
      if (!deliverable) {
        assert.equal(
          after.attempts.find((attempt) => attempt.id === wakeRun.activeAttemptId)?.status,
          "cancelled",
        );
        assert.equal(
          after.nodes.find((node) => node.id === wakeRun.rootNodeId)?.status,
          "cancelled",
        );
        assert.isFalse(after.turnItems.some((item) => item.runId === wakeRun.id));
      }
      assert.deepEqual(
        after.messages
          .filter((message) => message.id === wakeMessageId)
          .map((message) => message.notification?.summary),
        [finalNotice ? "#7: closed, stopped watching" : "#7: checks failed"],
      );
    }),
  );

  it.effect.each(["open", "merged", "closed", "closed notice", "reopened"] as const)(
    "revalidates a pull-request wake before idle dispatch: %s",
    (mode) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, key, watch, snapshotSyncedAt } = yield* createWatchedThread(
          `idle-${mode}`,
          mode === "reopened",
        );
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${threadId}-snapshot`),
          threadId,
          ...key,
          snapshot: {
            state: mode === "closed notice" || mode === "reopened" ? "closed" : mode,
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: snapshotSyncedAt,
          },
          stack: null,
        });
        const wakeMessageId = MessageId.make(`${threadId}-wake`);
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-wake`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: mode === "closed notice" ? null : { ...watch, headSha: "abc123", wakes: 1 },
          wake: {
            messageId: wakeMessageId,
            text: mode === "closed notice" ? "Closed, stopped watching" : "Checks failed",
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary:
                mode === "closed notice" ? "#7: closed, stopped watching" : "#7: checks failed",
            },
          },
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        const deliverable = mode === "open" || mode === "closed notice" || mode === "reopened";
        assert.deepEqual(
          after.runs.map((run) => [run.userMessageId, run.status]),
          deliverable ? [[wakeMessageId, "starting"]] : [],
        );
        assert.deepEqual(
          after.messages.map((message) => message.id),
          deliverable ? [wakeMessageId] : [],
        );
      }),
  );

  it.effect("reads each watched PR as soon as its own fingerprint lands", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("pr-watch-pipeline-project");
      yield* seedProject({
        projectId,
        title: "Watch pipeline",
        workspaceRoot: "/workspace/watch-pipeline",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      for (const number of [21, 22]) {
        const threadId = ThreadId.make(`runtime-pull-request-watch-pipeline-${number}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-pipeline-create-${number}`),
          threadId,
          projectId,
          title: "Watch pipeline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-pipeline-start-${number}`),
          threadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number,
          watching: true,
          link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
        });
      }
      const at = "2026-10-02T12:00:00.000Z";
      const readHead = (number: number) =>
        orchestrator
          .getThreadShell(ThreadId.make(`runtime-pull-request-watch-pipeline-${number}`))
          .pipe(Effect.map((thread) => thread?.pullRequests?.[0]?.watch?.headSha));
      // #21's host answers only after #22 has been read, so waiting on every fingerprint first
      // never finishes.
      const read22 = yield* Deferred.make<void>();
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          watchFingerprint: (input) =>
            input.number === 21
              ? Deferred.await(read22).pipe(Effect.as(null))
              : Effect.succeed(null),
          detail: (input) =>
            (input.number === 22 ? Deferred.succeed(read22, undefined) : Effect.void).pipe(
              Effect.as(watchedPullRequestDetail({ projectId, number: input.number, at })),
            ),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const reactor = yield* PullRequestWatchReactor.make.pipe(Effect.provide(host));
      yield* reactor.sweep;
      assert.equal(yield* readHead(21), "abc1234def");
      assert.equal(yield* readHead(22), "abc1234def");
    }),
  );

  it.effect("persists rejected command receipts across retries", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("runtime-layer-rejected-command"),
        threadId: ThreadId.make("runtime-layer-missing-thread"),
      };

      const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.flip);

      assert.equal(first._tag, "OrchestratorProjectionError");
      assert.equal(retry._tag, "OrchestratorCommandPreviouslyRejectedError");
    }),
  );

  it.effect(
    "admits restart continuations once and rejects a stale continuation behind newer work",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("runtime-layer-restart-continuation");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-create"),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-user-message"),
          threadId,
          messageId: MessageId.make("restart-user-message"),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make("restart-cancel"),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make("restart-cancel-event"),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status: "cancelled", completedAt: now },
            },
            {
              id: EventId.make("restart-cut-wake-event"),
              type: "run.created",
              threadId,
              runId: RunId.make("restart-cut-wake"),
              occurredAt: now,
              payload: {
                ...original,
                id: RunId.make("restart-cut-wake"),
                ordinal: 2,
                status: "cancelled",
                startedAt: null,
                completedAt: now,
              },
            },
          ],
          effects: [],
        });
        const command = {
          type: "message.dispatch" as const,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          commandId: CommandId.make("restart-automatic-message"),
          threadId,
          messageId: MessageId.make("restart-automatic-message"),
          text: "Continue where you left off.",
          notification: {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: "T3.CodeShip restarted and resumed this turn",
            detail: "Continue where you left off.",
          },
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" as const },
          restartContinuationOfRunId: original.id,
        };
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(admitted.runs, 3);
        assert.equal(admitted.runs[2]?.restartContinuationOfRunId, original.id);
        const continuationItems = admitted.turnItems.filter(
          (item) => item.runId === admitted.runs[2]?.id,
        );
        assert.isFalse(continuationItems.some((item) => item.type === "user_message"));
        assert.deepInclude(
          continuationItems.flatMap((item) =>
            item.type === "notification" ? [[item.summary, item.detail]] : [],
          ),
          ["T3.CodeShip restarted and resumed this turn", "Continue where you left off."],
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("restart-stale-race"),
          messageId: MessageId.make("restart-stale-race"),
        });
        const raced = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(raced.runs, 3);
        assert.isFalse(raced.messages.some((message) => message.id === "restart-stale-race"));
      }),
  );

  it.effect.each([
    ["failed", "shell", false],
    ["completed", "shell", false],
    ["waiting", "shell", false],
    ["cancelled", "shell", false],
    ["completed", "monitor", false],
    ["failed", "task", false],
    ["completed", "task", true],
    ["waiting", "task", true],
    ["cancelled", "task", true],
  ] as const)(
    "admits a restart continuation of a %s run that lost a %s: %s",
    ([status, kind, admitted]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-restart-${status}-${kind}-source`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-create`),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart-failed",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`restart-${status}-${kind}-user-message`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-user-message`),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`restart-${status}-${kind}-reconcile`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make(`restart-${status}-${kind}-run`),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status, completedAt: now },
            },
            {
              id: EventId.make(`restart-${status}-${kind}-work`),
              type: "run.background-work-cancelled",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: {
                runId: original.id,
                restartCancelledBackgroundWork: [{ kind, label: "sleep 25" }],
              },
            },
          ],
          effects: [],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`restart-${status}-${kind}-continuation`),
          threadId,
          messageId: MessageId.make(`restart-${status}-${kind}-continuation`),
          text: "Note: the T3 server restarted.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: original.id,
        });
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, status);
        assert.deepEqual(
          projection.runs.slice(1).map((run) => run.restartContinuationOfRunId),
          admitted ? [original.id] : [],
        );
      }),
  );

  it.effect("rejects settling a thread while a run is active", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-active-settle-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-active-settle-project"),
        title: "Active settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-active-settle",
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-active-settle-initial"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-active-settle-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const nonEmptyClaim = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-active-settle-empty-claim"),
          threadId,
          worktreePath: "/tmp/reassigned-after-message",
          expectedEmpty: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(nonEmptyClaim, Orchestrator.OrchestratorDispatchError);

      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-active-settle"),
          threadId,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(error.cause, `Thread ${threadId} is still running. Stop it before settling.`);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.isNull(projection.thread.settledOverride);
      assert.isNull(projection.thread.settledAt);
      assert.isNotNull(projection.thread.unsettledAt);
    }),
  );

  it.effect("keeps a linked environment's sender on started and queued messages", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-linked-sender-thread");
      const linkedSender = {
        environmentId: EnvironmentId.make("environment-linked"),
        threadId: ThreadId.make("linked-sending-agent"),
        title: "Linked sending agent",
      };
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-linked-sender-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-linked-sender-project"),
        title: "Linked sender",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-linked-sender",
      });
      for (const [suffix, type] of [
        ["started", "start_immediately"],
        ["queued", "queue_after_active"],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          linkedSender,
          commandId: CommandId.make(`runtime-layer-linked-sender-${suffix}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-linked-sender-${suffix}`),
          text: `Linked ${suffix} message`,
          attachments: [],
          modelSelection,
          dispatchMode: { type },
        });
      }

      const projection = yield* orchestrator.getThreadProjection(threadId);
      for (const suffix of ["started", "queued"]) {
        const message = projection.messages.find(
          (candidate) => candidate.id === `runtime-layer-linked-sender-${suffix}`,
        );
        assert.deepStrictEqual(message?.linkedSender, linkedSender);
        assert.isUndefined(message?.senderThreadId);
      }
      const startedItem = projection.turnItems.find(
        (item) =>
          item.type === "user_message" && item.messageId === "runtime-layer-linked-sender-started",
      );
      assert.deepStrictEqual(
        startedItem?.type === "user_message" ? startedItem.linkedSender : undefined,
        linkedSender,
      );
    }),
  );

  it.effect.each(["settle", "archive"] as const)(
    "applies a %s its own agent asked for once the turn completes",
    (action) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadManagement = yield* ThreadManagementService.ThreadManagementService;
        const projectId = ProjectId.make(`runtime-layer-${action}-after-run-project`);
        const threadId = ThreadId.make(`runtime-layer-${action}-after-run-thread`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-${action}-after-run-create`),
          threadId,
          projectId,
          title: "Organize after run",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: `/tmp/runtime-layer-${action}-after-run`,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-${action}-after-run-message`),
          threadId,
          messageId: MessageId.make(`runtime-layer-${action}-after-run-message`),
          text: `Fix it and then ${action} this thread.`,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
        if (run === undefined) return yield* Effect.die(new Error("Run missing."));

        const applied = yield* orchestrator
          .streamStoredEventsFrom({
            threadId,
            afterSequence: 0,
            eventType: action === "settle" ? "thread.settled" : "thread.archived",
          })
          .pipe(Stream.runHead, Effect.forkChild);
        const result = yield* threadManagement.organizeThread({
          threadId,
          commandId: CommandId.make(`runtime-layer-${action}-after-run-${action}`),
          action,
          byOwnAgent: true,
        });
        assert.deepEqual(
          result,
          action === "settle" ? { settlesWhenTurnEnds: true } : { archivesWhenTurnEnds: true },
        );
        const during = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(during.thread.settledOverride);
        assert.isNull(during.thread.archivedAt);
        // Stopping the session mid-turn would end the turn as failed, so the command refuses.
        const refused = yield* orchestrator
          .dispatch({
            type: `thread.${action}`,
            commandId: CommandId.make(`runtime-layer-${action}-after-run-direct`),
            threadId,
          })
          .pipe(Effect.flip);
        assert.include(String(refused.cause), "is still running");
        const now = yield* DateTime.now;
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-layer-${action}-after-run-completed`),
          events: [
            {
              id: EventId.make(`runtime-layer-${action}-after-run-completed`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* Fiber.join(applied);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "completed");
        if (action === "settle") assert.equal(projection.thread.settledOverride, "settled");
        else assert.isNotNull(projection.thread.archivedAt);
      }),
  );

  it.effect("keeps a pull request watch its agent started after asking to settle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-settle-then-watch-project");
      const threadId = ThreadId.make("runtime-layer-settle-then-watch-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-create"),
        threadId,
        projectId,
        title: "Settle then watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-then-watch",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-settle-then-watch-message"),
        text: "Settle this thread, then watch the pull request.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die(new Error("Run missing."));

      // The deferred settle `settleThread` forks for its own agent's active run.
      const settleRequest = yield* threadManagement
        .organizeAfterRun({ projectId, threadId, runId: run.id, action: "settle" })
        .pipe(Effect.forkChild);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("runtime-layer-settle-then-watch-watch"),
        threadId,
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        watching: true,
        link: { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" },
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);

      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-then-watch-completed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-then-watch-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settleRequest);

      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.isDefined(shell?.pullRequests?.[0]?.watch);
      assert.isNull(shell?.settledOverride ?? null);
    }),
  );

  // Settling detaches the provider session, which ends work running inside it.
  it.effect.each([
    { name: "a native subagent", work: "subagent" as const, settles: false },
    {
      name: "a background command marked awaited",
      work: "awaited-command" as const,
      settles: false,
    },
    { name: "an unmarked background command", work: "command" as const, settles: true },
    { name: "a task delegated to another thread", work: "delegated" as const, settles: true },
  ])("settling a completed turn that left $name running settles: $settles", ({ work, settles }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`runtime-layer-settle-background-${work}`);

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Settle with background work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `/tmp/${threadId}`,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message`),
        threadId,
        messageId: MessageId.make(`${threadId}:message`),
        text: "Start the work in the background.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0];
      const providerThread = before.providerThreads[0];
      if (run === undefined || providerThread === undefined) {
        return yield* Effect.die(new Error("Run or provider thread missing."));
      }
      const now = yield* DateTime.now;
      const subagentItem = (origin: "provider_native" | "app_owned") => ({
        id: EventId.make(`${threadId}:subagent`),
        type: "turn-item.updated" as const,
        threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`${threadId}:subagent`),
          type: "subagent" as const,
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "running" as const,
          title: "Review",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          subagentId: NodeId.make(`${threadId}:subagent`),
          origin,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          childThreadId: origin === "app_owned" ? ThreadId.make(`${threadId}:child`) : null,
          prompt: "Review the change",
          result: null,
        },
      });
      const roster = (awaited: boolean) => ({
        id: EventId.make(`${threadId}:roster`),
        type: "provider-thread.updated" as const,
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          updatedAt: now,
          pendingBackgroundTasks: [
            {
              taskId: "background-command",
              kind: "command" as const,
              ...(awaited ? { awaited: true as const } : {}),
            },
          ],
        },
      });
      yield* eventSink.write({
        events: [
          work === "subagent"
            ? subagentItem("provider_native")
            : work === "delegated"
              ? subagentItem("app_owned")
              : roster(work === "awaited-command"),
          {
            id: EventId.make(`${threadId}:completed`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });

      const settle = orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`${threadId}:settle`),
        threadId,
      });
      if (settles) {
        yield* settle;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.thread.settledOverride, "settled");
        return;
      }
      const error = yield* settle.pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(
        error.cause,
        `Thread ${threadId} is still running background agents or commands, and settling would end them. Wait for them to finish, or press Stop, then settle.`,
      );
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(projection.thread.settledOverride);
    }),
  );

  it.effect("settles past held automatic messages but preserves a held user queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-settle-automatic-queued");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-create"),
        threadId,
        projectId: ProjectId.make("settle-automatic-project"),
        title: "Settle automatic queued",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-automatic",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active"),
        threadId,
        messageId: MessageId.make("settle-automatic-active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const queueMessage = (id: string, sender: "notification" | "agent" | "scheduled" | "user") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          ...(
            {
              notification: {
                createdBy: "agent",
                creationSource: "provider",
                notification: {
                  source: { kind: "background_task" },
                  outcome: "updated",
                  summary: "Background activity updated",
                },
              },
              agent: {
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("settle-automatic-sender"),
              },
              scheduled: {
                createdBy: "user",
                creationSource: "web",
                scheduledTaskId: ScheduledTaskId.make("settle-automatic-schedule"),
              },
              user: { createdBy: "user", creationSource: "web" },
            } as const
          )[sender],
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
      yield* queueMessage("settle-automatic-notification", "notification");
      yield* queueMessage("settle-automatic-agent", "agent");
      yield* queueMessage("settle-automatic-scheduled", "scheduled");

      const holdQueueAfterRestart = (commandId: string) =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const now = yield* DateTime.now;
          yield* eventSink.commitCommand({
            commandId: CommandId.make(commandId),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: now,
            events: projection.runs
              .filter((run) => run.status === "starting" || run.status === "queued")
              .map((run) => ({
                id: EventId.make(`${commandId}:${run.id}`),
                type: "run.updated" as const,
                threadId,
                runId: run.id,
                occurredAt: now,
                payload:
                  run.status === "queued"
                    ? { ...run, queueHeld: true }
                    : { ...run, status: "cancelled" as const, completedAt: now },
              })),
            effects: [],
          });
        });
      yield* holdQueueAfterRestart("settle-automatic-restart");
      const beforeSettle = yield* orchestrator.getThreadProjection(threadId);
      const oldestRun = beforeSettle.runs.reduce((oldest, run) =>
        run.ordinal < oldest.ordinal ? run : oldest,
      );
      const latestRun = beforeSettle.runs.reduce((latest, run) =>
        run.ordinal > latest.ordinal ? run : latest,
      );
      const staleSettle = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-automatic-stale"),
          threadId,
          expectedLatestRunId: oldestRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(staleSettle._tag, "OrchestratorDispatchError");
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.settledAt);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle-automatic-settle"),
        threadId,
        expectedLatestRunId: latestRun.id,
      });
      const settled = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(settled.thread.settledAt);
      assert.isTrue(settled.runs.every((run) => run.status === "cancelled"));

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("settle-automatic-unsettle"),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("settle-automatic-active-2"),
        threadId,
        messageId: MessageId.make("settle-automatic-active-2"),
        text: "Active again",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* queueMessage("settle-automatic-user-queued", "user");
      yield* queueMessage("settle-automatic-agent-queued-2", "agent");
      yield* holdQueueAfterRestart("settle-automatic-restart-2");
      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle-automatic-settle-2"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(
        error.cause,
        `Thread ${threadId} has a queued message. Send it or remove it from the queue before settling.`,
      );
      // An agent's archive at turn end must not cancel the message either.
      const archiveError = yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("settle-automatic-archive"),
          threadId,
          onlyIfNoQueuedMessage: true,
        })
        .pipe(Effect.flip);
      assert.equal(
        archiveError.cause,
        `Thread ${threadId} has a queued message. Send it or remove it from the queue before archiving.`,
      );
      const blocked = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(blocked.thread.settledAt);
      assert.deepEqual(
        blocked.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
        ["settle-automatic-user-queued", "settle-automatic-agent-queued-2"],
      );
    }),
  );

  it.effect("rejects archiving an idle parent until its delegated child completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("archive-delegated-parent");
      const projectId = ProjectId.make("archive-delegated-project");
      yield* seedProject({
        projectId,
        title: "Delegated archive",
        workspaceRoot: "/workspace/archive-delegated",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-delegated-create"),
        threadId,
        projectId,
        title: "Delegated archive",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-delegated-message"),
        threadId,
        messageId: MessageId.make("archive-delegated-message"),
        text: "Delegate the work, then finish your turn.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const parentRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("archive-delegated-request"),
        parentThreadId: threadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Keep working after the parent finishes.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const delegatedParentRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-delegated-parent-completed"),
            type: "run.updated",
            threadId,
            runId: parentRun.id,
            occurredAt: now,
            payload: { ...delegatedParentRun, status: "completed", completedAt: now },
          },
        ],
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents[0]!;
      assert.equal(parent.runs[0]?.status, "completed");
      assert.equal(task.origin, "app_owned");
      assert.equal(task.status, "running");
      assert.isNotNull(task.childThreadId);

      // Archive must preserve the idle parent's path for receiving this child's result.
      const error = yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-delegated-blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
      assert.equal(
        error.cause,
        `Thread ${threadId} has running delegated tasks. Wait for them or cancel them before archiving.`,
      );
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);

      const childThreadId = task.childThreadId!;
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-delegated-child-run-completed"),
            type: "run.updated",
            threadId: childThreadId,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...childRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("archive-delegated-child-completed"),
            type: "subagent.updated",
            threadId,
            nodeId: task.id,
            occurredAt: now,
            payload: { ...task, status: "completed", result: "Done", completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-delegated-allowed"),
        threadId,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
    }),
  );

  it.effect("cancels preparing work on archive and keeps it cancelled through replay", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-layer-archive-preparing-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-preparing-create"),
        threadId,
        projectId: ProjectId.make("archive-preparing-project"),
        title: "Archive preparing work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-preparing-message"),
        threadId,
        messageId: MessageId.make("archive-preparing-message"),
        text: "Prepare my workspace.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "defer_start" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(before.runs, 1);
      assert.isEmpty(before.subagents);
      const run = before.runs[0]!;
      assert.equal(run.status, "preparing");
      const preparation = before.turnItems.find((item) => item.type === "command_execution")!;
      assert.equal(preparation.status, "running");
      assert.isEmpty((yield* orchestrator.getThreadShell(threadId))!.pendingBackgroundTasks);

      const archive = {
        type: "thread.archive" as const,
        commandId: CommandId.make("archive-preparing-archive"),
        threadId,
      };
      const archivedResult = yield* orchestrator.dispatch(archive);
      assert.equal((yield* orchestrator.dispatch(archive)).sequence, archivedResult.sequence);

      const assertCancelled = Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const cancelledRun = projection.runs.find((candidate) => candidate.id === run.id)!;
        assert.equal(cancelledRun.status, "cancelled");
        assert.isNull(cancelledRun.queuePosition);
        assert.isNotNull(cancelledRun.completedAt);
        assert.equal(projection.attempts[0]?.status, "cancelled");
        assert.isNotNull(projection.attempts[0]?.completedAt);
        assert.equal(projection.nodes[0]?.status, "cancelled");
        assert.isNotNull(projection.nodes[0]?.completedAt);
        const item = projection.turnItems.find((candidate) => candidate.id === preparation.id)!;
        assert.equal(item.status, "cancelled");
        assert.equal(item.title, "Workspace preparation cancelled");
        assert.deepEqual(item.completedAt, cancelledRun.completedAt);
        assert.deepEqual(item.updatedAt, cancelledRun.completedAt);
        assert.isEmpty((yield* orchestrator.getThreadShell(threadId))!.pendingBackgroundTasks);
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
      yield* assertCancelled;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCancelled;

      // Late preparation callbacks must not revive archived runs, even after reopen.
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("archive-preparing-unarchive"),
        threadId,
      });
      for (const callback of [
        { type: "prepared-run.progress", phase: "setup" },
        { type: "prepared-run.release" },
        {
          type: "prepared-run.fail",
          failure: {
            class: "validation_error",
            message: "Late preparation failure",
            code: null,
            retryable: false,
          },
        },
      ] as const) {
        const error = yield* orchestrator
          .dispatch({
            ...callback,
            commandId: CommandId.make(`archive-preparing-late:${callback.type}`),
            threadId,
            runId: run.id,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "OrchestratorDispatchError");
      }
      yield* assertCancelled;
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCancelled;
    }),
  );

  it.effect.each([false, true])(
    "promotes only one queued run after each terminal run (notification: %s)",
    (automatic) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-serialized-queue-thread-${automatic}`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-create-${automatic}`),
          threadId,
          projectId: ProjectId.make(`runtime-layer-serialized-queue-project-${automatic}`),
          title: "Serialized queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          text: "Active",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: automatic ? "agent" : "user",
          creationSource: automatic ? "provider" : "web",
          ...(automatic
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Monitor updated",
                  detail: "Build is green",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          text: "First queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          text: "Second queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRuns = before.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => left.ordinal - right.ordinal);
        const firstQueuedRun = queuedRuns[0];
        const secondQueuedRun = queuedRuns[1];
        assert.isDefined(activeRun);
        assert.isDefined(firstQueuedRun);
        assert.isDefined(secondQueuedRun);
        assert.isFalse(
          before.turnItems.some(
            (item) =>
              item.type === "user_message" &&
              (item.messageId === firstQueuedRun.userMessageId ||
                item.messageId === secondQueuedRun.userMessageId),
          ),
          "queued messages must not exist as turn items before dispatch",
        );

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting"
              ? Queue.offer(promotedRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const activeCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-active-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: activeCompletedAt,
              payload: {
                ...activeRun,
                status: "completed",
                completedAt: activeCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), firstQueuedRun.id);
        const afterFirstPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "starting",
        );
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "queued",
        );
        const promotedMessageItem = afterFirstPromotion.turnItems.find(
          (item) =>
            item.runId === firstQueuedRun.id &&
            (item.type === "user_message" || item.type === "notification"),
        );
        assert.isDefined(promotedMessageItem);
        if (automatic) {
          assert.equal(promotedMessageItem.type, "notification");
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.text,
            "First queued",
          );
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.notification?.summary,
            "Monitor updated",
          );
          assert.isFalse(
            afterFirstPromotion.turnItems.some(
              (item) =>
                item.type === "user_message" && item.messageId === firstQueuedRun.userMessageId,
            ),
          );
        } else {
          assert.equal(promotedMessageItem.type, "user_message");
        }
        assert.isTrue(
          promotedMessageItem.startedAt !== null &&
            DateTime.toEpochMillis(promotedMessageItem.startedAt) >=
              DateTime.toEpochMillis(activeCompletedAt),
        );

        const promotedFirst = afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id);
        assert.isDefined(promotedFirst);
        const firstCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-first-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: promotedFirst.id,
              ...(promotedFirst.rootNodeId === null ? {} : { nodeId: promotedFirst.rootNodeId }),
              providerInstanceId: promotedFirst.providerInstanceId,
              occurredAt: firstCompletedAt,
              payload: {
                ...promotedFirst,
                status: "completed",
                completedAt: firstCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), secondQueuedRun.id);
        const afterSecondPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "completed",
        );
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "starting",
        );
      }),
  );

  it.effect("starts a wake's work clock from the run that ran before it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-wake-work-start-thread");
      const messageId = (key: string) => MessageId.make(`runtime-layer-wake-work-start-${key}`);

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-wake-work-start-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-wake-work-start-project"),
        title: "Wake work start",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const dispatch = (key: string, wake: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-wake-work-start-${key}`),
          threadId,
          messageId: messageId(key),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode:
            key === "prompt" ? { type: "start_immediately" } : { type: "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
          assert.isDefined(run);
          return run;
        });
      yield* dispatch("prompt", false);
      yield* dispatch("queued", false);
      yield* dispatch("early-wake", true);
      yield* orchestrator.dispatch({
        type: "queued-run.reorder",
        commandId: CommandId.make("runtime-layer-wake-work-start-reorder"),
        threadId,
        runId: (yield* runFor("queued")).id,
        beforeRunId: null,
      });
      yield* dispatch("late-wake", true);
      assert.isUndefined((yield* runFor("early-wake")).workStartedAt);

      const startedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(startedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      const now = yield* DateTime.now;
      const settle = (key: string, startedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`runtime-layer-wake-work-start-${key}-completed`),
                type: "run.updated",
                threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: startedAt,
                payload: { ...run, status: "completed", startedAt, completedAt: startedAt },
              },
            ],
          });
        });
      const millis = (value: DateTime.Utc | undefined) =>
        value === undefined ? undefined : DateTime.toEpochMillis(value);

      yield* settle("prompt", now);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("early-wake")).id);
      assert.equal(millis((yield* runFor("early-wake")).workStartedAt), millis(now));

      yield* settle("early-wake", DateTime.add(now, { seconds: 1 }));
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("queued")).id);
      assert.isUndefined((yield* runFor("queued")).workStartedAt);

      const queuedStartedAt = DateTime.add(now, { minutes: 10 });
      yield* settle("queued", queuedStartedAt);
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("late-wake")).id);
      assert.equal(millis((yield* runFor("late-wake")).workStartedAt), millis(queuedStartedAt));

      const ordinals = yield* Effect.forEach(
        ["prompt", "early-wake", "queued", "late-wake"],
        (key) => Effect.map(runFor(key), (run) => run.ordinal),
      );
      assert.deepEqual(
        ordinals,
        ordinals.toSorted((left, right) => left - right),
      );
    }),
  );

  it.effect.each([
    { origin: "agent" as const, delivery: "queued" as const },
    { origin: "agent" as const, delivery: "after-completion" as const },
    { origin: "agent" as const, delivery: "held-resume" as const },
    { origin: "agent" as const, delivery: "resume-before-stop-ends" as const },
    { origin: "child" as const, delivery: "after-completion" as const },
    { origin: "user" as const, delivery: "queued" as const },
  ])(
    "preserves queued agent and child updates but resets fresh requests (%j)",
    ({ origin, delivery }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`work-clock-${origin}-${delivery}`);
        const originalMessageId = MessageId.make(`${threadId}-original`);
        const followUpMessageId = MessageId.make(`${threadId}-follow-up`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: ProjectId.make(`${threadId}-project`),
          title: "Agent message work clock",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-original`),
          threadId,
          messageId: originalMessageId,
          text: "Original user work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const dispatchFollowUp = orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: origin === "user" ? "user" : "agent",
          creationSource: origin === "user" ? "web" : "mcp",
          ...(origin === "user" ? {} : { senderThreadId: ThreadId.make("sending-agent") }),
          commandId: CommandId.make(`${threadId}-follow-up`),
          threadId,
          messageId: followUpMessageId,
          text: "Follow-up work",
          attachments: [],
          modelSelection,
          dispatchMode: {
            type: delivery === "after-completion" ? "start_immediately" : "queue_after_active",
          },
        });
        const held = delivery === "held-resume" || delivery === "resume-before-stop-ends";
        const drainsOnEnd = delivery === "queued" || delivery === "resume-before-stop-ends";
        if (delivery === "queued" || held) yield* dispatchFollowUp;
        const startedRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting"
              ? Queue.offer(startedRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === originalMessageId,
        );
        assert.isDefined(original);
        if (origin === "child") {
          assert.isNotNull(original.rootNodeId);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}-child`),
                type: "subagent.updated",
                threadId,
                runId: original.id,
                occurredAt: original.requestedAt,
                payload: {
                  id: NodeId.make(`${threadId}-child`),
                  threadId,
                  runId: original.id,
                  parentNodeId: original.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: original.providerInstanceId,
                  providerThreadId: null,
                  childThreadId: ThreadId.make("sending-agent"),
                  nativeTaskRef: null,
                  prompt: "Delegated work",
                  title: null,
                  model: null,
                  status: "completed",
                  result: "Done",
                  startedAt: original.requestedAt,
                  completedAt: original.requestedAt,
                  updatedAt: original.requestedAt,
                },
              },
            ],
          });
        }
        if (held) {
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === followUpMessageId,
          );
          assert.isDefined(queued);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}-hold`),
                type: "run.updated",
                threadId,
                occurredAt: original.requestedAt,
                payload: { ...queued, queueHeld: true },
              },
              {
                id: EventId.make(`${threadId}-interrupt-request`),
                type: "turn-item.updated",
                threadId,
                runId: original.id,
                occurredAt: original.requestedAt,
                payload: {
                  id: TurnItemId.make(`${threadId}-interrupt-request`),
                  type: "run_interrupt_request",
                  threadId,
                  runId: original.id,
                  nodeId: original.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 90,
                  status: "completed",
                  title: "Interrupt requested",
                  startedAt: original.requestedAt,
                  completedAt: original.requestedAt,
                  updatedAt: original.requestedAt,
                  message: "Stopped by user",
                },
              },
            ],
          });
        }
        if (delivery === "resume-before-stop-ends") {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}-resume`),
            threadId,
          });
        }
        const originalStart = DateTime.makeUnsafe("2026-10-21T14:20:17.457Z");
        const completedAt = DateTime.makeUnsafe("2026-10-21T14:23:53.509Z");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}-completed`),
              type: "run.updated",
              threadId,
              runId: original.id,
              ...(original.rootNodeId === null ? {} : { nodeId: original.rootNodeId }),
              providerInstanceId: original.providerInstanceId,
              occurredAt: completedAt,
              payload: {
                ...original,
                status: held ? "interrupted" : "completed",
                startedAt: originalStart,
                completedAt,
              },
            },
          ],
        });
        if (delivery === "held-resume") {
          yield* TestClock.adjust("3 hours");
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === followUpMessageId,
          );
          assert.isDefined(queued);
          assert.equal(queued.status, "queued");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}-resume`),
            threadId,
          });
        } else if (delivery === "after-completion") yield* dispatchFollowUp;
        const startedRunId = drainsOnEnd ? yield* Queue.take(startedRunIds) : null;
        const followUp = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === followUpMessageId,
        );
        assert.isDefined(followUp);
        if (drainsOnEnd) assert.equal(startedRunId, followUp.id);
        assert.equal(followUp.status, "starting");
        if (origin === "child" || (origin === "agent" && delivery === "queued")) {
          assert.isDefined(followUp.workStartedAt);
          assert.equal(
            DateTime.toEpochMillis(followUp.workStartedAt),
            DateTime.toEpochMillis(originalStart),
          );
        } else {
          assert.isUndefined(followUp.workStartedAt);
        }
      }),
  );

  it.effect.each(["usage_limit", "provider_error"] as const)(
    "handles a queued message after a %s failure",
    (failureClass) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-failed-queue-${failureClass}`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Failed queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const index of [0, 1]) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text: index === 0 ? "Active" : "Queued",
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        }

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRun = before.runs.find((run) => run.status === "queued");
        assert.isDefined(activeRun);
        assert.isDefined(queuedRun);
        assert.isNotNull(activeRun.rootNodeId);

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const heldRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type !== "run.updated"
              ? Effect.void
              : stored.event.payload.status === "starting"
                ? Queue.offer(promotedRunIds, stored.event.payload.id)
                : stored.event.payload.queueHeld === true
                  ? Queue.offer(heldRunIds, stored.event.payload.id)
                  : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: activeRun.id,
                nodeId: activeRun.rootNodeId,
                providerThreadId: activeRun.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Provider failure",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: failureClass,
                  message: "Provider failed.",
                  code: "provider_failed",
                  retryable: null,
                  ...(failureClass === "usage_limit"
                    ? { resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })) }
                    : {}),
                },
              },
            },
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              nodeId: activeRun.rootNodeId,
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: now,
              payload: { ...activeRun, status: "failed", completedAt: now },
            },
          ],
        });

        if (failureClass === "provider_error") {
          assert.equal(yield* Queue.take(heldRunIds), queuedRun.id);
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });
          assert.equal(yield* Queue.take(promotedRunIds), queuedRun.id);
          return;
        }
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
        assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.equal(shell?.latestRunId, activeRun.id);
        assert.equal(shell?.status, "failed");
        assert.equal(shell?.lastErrorClass, "usage_limit");
      }),
  );

  // A thread fed by agent messages, with helpers to end its runs as a provider would.
  const queueTestThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Dispatcher",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const send = (key: string, createdBy: "user" | "agent", start: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy,
          creationSource: createdBy === "user" ? "web" : "server",
          commandId: CommandId.make(`${threadId}:message:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${key}`),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find(
            (candidate) => candidate.userMessageId === MessageId.make(`${threadId}:message:${key}`),
          );
          assert.isDefined(run);
          return run;
        });
      const startedRunIds = yield* Queue.unbounded<RunId>();
      // Run updates in commit order; the run-update listener handles them in this order too.
      const runUpdates: Array<OrchestrationV2Run> = [];
      yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.runForEach((stored) => {
            if (stored.event.type !== "run.updated") return Effect.void;
            runUpdates.push(stored.event.payload);
            return stored.event.payload.status === "starting"
              ? Queue.offer(startedRunIds, stored.event.payload.id)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      const releasedAfter = (key: string, completedKey: string) =>
        Effect.gen(function* () {
          const [run, completed] = [yield* runFor(key), yield* runFor(completedKey)];
          const released = runUpdates.findIndex(
            (update) => update.id === run.id && update.queueHeld === false,
          );
          const completion = runUpdates.findIndex(
            (update) => update.id === completed.id && update.status === "completed",
          );
          assert.isAbove(released, completion, `${key} was released before ${completedKey} ended`);
        });
      const end = (
        key: string,
        status: "completed" | "failed",
        revision = "",
        patch: Partial<OrchestrationV2Run> = {},
      ) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          assert.isNotNull(run.rootNodeId);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...(status === "failed"
                ? [
                    {
                      id: EventId.make(`${threadId}:${key}:error`),
                      type: "turn-item.updated" as const,
                      threadId,
                      runId: run.id,
                      nodeId: run.rootNodeId,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        id: TurnItemId.make(`${threadId}:${key}:error`),
                        type: "error" as const,
                        threadId,
                        runId: run.id,
                        nodeId: run.rootNodeId,
                        providerThreadId: run.providerThreadId,
                        providerTurnId: null,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 2,
                        status: "failed" as const,
                        title: "Provider failure",
                        startedAt: now,
                        completedAt: now,
                        updatedAt: now,
                        failure: {
                          class: "provider_error" as const,
                          message: "Provider failed.",
                          code: "provider_failed",
                          retryable: null,
                        },
                      },
                    },
                  ]
                : []),
              {
                id: EventId.make(`${threadId}:${key}:${status}${revision}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status, startedAt: now, completedAt: now, ...patch },
              },
            ],
          });
        });

      // The run-update listener places failure holds after the terminal event commits.
      const awaitHeld = (key: string) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          yield* eventSink.stream({ threadId, afterSequence: 0, eventType: "run.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === run.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.runHead,
          );
        });
      return { send, runFor, end, startedRunIds, releasedAfter, awaitHeld };
    });

  it.effect("releases held agent messages once a later run completes, not the user's", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-failed-queue-agent-messages");
      const { send, runFor, end, startedRunIds, releasedAfter, awaitHeld } =
        yield* queueTestThread(threadId);
      yield* send("earlier", "agent", true);
      yield* end("earlier", "completed");
      yield* send("active", "agent", true);
      yield* send("issue", "agent", false);
      yield* send("user", "user", false);
      yield* end("active", "failed");
      yield* awaitHeld("issue");
      assert.isTrue((yield* runFor("issue")).queueHeld);
      // Delivery bookkeeping rewrites an older completed run; the thread has not moved on.
      yield* end("earlier", "completed", ":bookkeeping");
      // A scheduled tick finds the thread idle and starts past the held queue.
      yield* send("tick", "agent", true);
      assert.equal((yield* runFor("tick")).status, "starting");
      yield* end("tick", "completed");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("issue")).id);
      yield* releasedAfter("issue", "tick");
      const user = yield* runFor("user");
      assert.equal(user.status, "queued");
      assert.isTrue(user.queueHeld);

      // A run that finishes despite a stop request does not release what the stop held.
      yield* send("after-stop", "agent", false);
      assert.isTrue((yield* runFor("after-stop")).queueHeld);
      const issue = yield* runFor("issue");
      assert.isNotNull(issue.rootNodeId);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:issue:interrupt-request`),
            type: "turn-item.updated",
            threadId,
            runId: issue.id,
            nodeId: issue.rootNodeId,
            providerInstanceId: issue.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:issue:interrupt-request`),
              type: "run_interrupt_request",
              threadId,
              runId: issue.id,
              nodeId: issue.rootNodeId,
              providerThreadId: issue.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "completed",
              title: "Interrupt requested",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: "Stopped by user",
            },
          },
        ],
      });
      yield* end("issue", "completed");
      // The next completed run releases it, which also shows the listener handled the stopped one.
      yield* send("probe", "agent", true);
      assert.equal((yield* runFor("probe")).status, "starting");
      yield* end("probe", "completed");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("after-stop")).id);
      yield* releasedAfter("after-stop", "probe");
    }),
  );

  it.effect(
    "completes a run whose checkpoint capture fails every attempt and starts the queue",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("runtime-layer-capture-failure-queue");
        const { send, runFor, startedRunIds } = yield* queueTestThread(threadId);
        yield* send("finished", "user", true);
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "not under test",
        });
        const finished = yield* runFor("finished");
        assert.isNotNull(finished.rootNodeId);
        const now = yield* DateTime.now;
        // The provider turn ended: the run waits for its checkpoint, as RunExecutionService leaves it.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:finished:waiting`),
              type: "run.updated",
              threadId,
              runId: finished.id,
              nodeId: finished.rootNodeId,
              providerInstanceId: finished.providerInstanceId,
              occurredAt: now,
              payload: { ...finished, status: "waiting", startedAt: now },
            },
          ],
        });
        yield* send("queued", "user", false);
        assert.equal((yield* runFor("queued")).status, "queued");
        const captureCommandId = CommandId.make(`command:effect:checkpoint.capture:${finished.id}`);
        // No such scope: every attempt fails the capture target check.
        yield* outbox.enqueue([
          {
            id: `effect:checkpoint.capture:${finished.id}`,
            commandId: captureCommandId,
            threadId,
            request: {
              type: "checkpoint.capture",
              runId: finished.id,
              scopeId: CheckpointScopeId.make(`${threadId}:missing-scope`),
            },
          },
        ]);
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* worker.drain();
          yield* TestClock.adjust("30 seconds");
        }

        const [capture] = yield* outbox.listByCommandId(captureCommandId);
        assert.equal(capture?.status, "failed");
        const settled = yield* runFor("finished");
        assert.equal(settled.status, "completed");
        assert.isNull(settled.checkpointId);
        assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("queued")).id);
      }),
  );

  it.effect.each(["listener", "startup", "stop"] as const)(
    "starts the user's restart-held queue once the continuation completes, unless Stop took the hold (%s)",
    (path) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-restart-held-queue-${path}`);
        const { send, runFor, end, startedRunIds, releasedAfter } =
          yield* queueTestThread(threadId);
        yield* send("cut", "agent", true);
        yield* send("queued", "user", false);
        // Recovery cuts the running turn and holds the queue behind its continuation.
        const [cut, queued] = [yield* runFor("cut"), yield* runFor("queued")];
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:cut:cancelled`),
              type: "run.updated",
              threadId,
              runId: cut.id,
              providerInstanceId: cut.providerInstanceId,
              occurredAt: now,
              payload: { ...cut, status: "cancelled", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:queued:restart-hold`),
              type: "run.updated",
              threadId,
              runId: queued.id,
              providerInstanceId: queued.providerInstanceId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true, queueHeldByRestart: true },
            },
          ],
        });
        if (path === "stop") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
          const held = yield* runFor("queued");
          assert.isTrue(held.queueHeld);
          assert.isUndefined(held.queueHeldByRestart);
          return;
        }
        yield* send("continuation", "agent", true);
        if (path === "listener") {
          yield* end("continuation", "completed");
        } else {
          // The server stopped before the run-update listener saw the completion.
          const continuation = yield* runFor("continuation");
          const completedAt = yield* DateTime.now;
          yield* eventSink.commitCommand({
            commandId: CommandId.make(`command:runtime-reconcile:${threadId}`),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: completedAt,
            events: [
              {
                id: EventId.make(`${threadId}:continuation:completed`),
                type: "run.updated",
                threadId,
                runId: continuation.id,
                providerInstanceId: continuation.providerInstanceId,
                occurredAt: completedAt,
                payload: {
                  ...continuation,
                  status: "completed",
                  startedAt: completedAt,
                  completedAt,
                },
              },
            ],
            effects: [],
          });
          assert.isTrue((yield* runFor("queued")).queueHeld);
          yield* orchestrator.resumeQueuedRuns;
        }
        assert.equal(yield* Queue.take(startedRunIds), queued.id);
        yield* releasedAfter("queued", "continuation");
        assert.isUndefined((yield* runFor("queued")).queueHeldByRestart);
      }),
  );

  it.effect("keeps held agent messages while the thread's worktree setup is unresolved", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const dispatcherId = ThreadId.make("runtime-layer-held-queue-worktree");
      const dispatcher = yield* queueTestThread(dispatcherId);
      const witness = yield* queueTestThread(ThreadId.make("runtime-layer-held-queue-witness"));
      yield* dispatcher.send("setup", "agent", true);
      yield* dispatcher.send("issue", "agent", false);
      yield* dispatcher.end("setup", "failed", "", {
        workspacePreparation: { type: "worktree", baseRef: "main" },
        startedAt: null,
      });
      yield* dispatcher.awaitHeld("issue");
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
      yield* dispatcher.send("tick", "agent", true);
      assert.equal((yield* dispatcher.runFor("tick")).status, "starting");
      yield* witness.send("active", "agent", true);
      yield* witness.send("queued", "agent", false);
      // The failed setup never produced the thread's worktree.
      const { thread } = yield* orchestrator.getThreadProjection(dispatcherId);
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${dispatcherId}:worktree-missing`),
            type: "thread.metadata-updated",
            threadId: dispatcherId,
            occurredAt: yield* DateTime.now,
            payload: { ...thread, worktreePath: null },
          },
        ],
      });
      yield* dispatcher.end("tick", "completed");
      // One listener handles every thread's completions in order, so the witness starting
      // means the tick's completion was handled too.
      yield* witness.end("active", "completed");
      assert.equal(yield* Queue.take(witness.startedRunIds), (yield* witness.runFor("queued")).id);
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
      const resume = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${dispatcherId}:resume`),
          threadId: dispatcherId,
        })
        .pipe(Effect.flip);
      assert.include(String(resume.cause), "Retry worktree setup");
      assert.isTrue((yield* dispatcher.runFor("issue")).queueHeld);
    }),
  );

  it.effect.each(["a new message", "the held queue"] as const)(
    "starts %s in the project checkout after a failed turn whose worktree was set up",
    (next) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-layer-worktree-left-for-checkout:${next}`);
        const checkoutRoot = `${process.cwd()}/src`;
        yield* seedProject({
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Checkout",
          workspaceRoot: checkoutRoot,
          defaultModelSelection: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const { send, runFor, end, awaitHeld } = yield* queueTestThread(threadId);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:first`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:first`),
          text: "first",
          attachments: [],
          modelSelection,
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { type: "worktree", baseRef: "main" },
          },
        });
        const first = yield* runFor("first");
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${threadId}:release`),
          threadId,
          runId: first.id,
        });
        yield* send("queued", "user", false);
        yield* end("first", "failed");
        yield* awaitHeld("queued");
        // The user switches the thread to the project checkout.
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`${threadId}:checkout`),
          threadId,
          worktreePath: null,
        });
        if (next === "a new message") {
          yield* send("second", "user", true);
          assert.equal((yield* runFor("second")).status, "starting");
          return;
        }
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        });
        const queued = yield* runFor("queued");
        assert.equal(queued.status, "starting");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const rootNode = projection.nodes.find((node) => node.id === queued.rootNodeId);
        assert.equal(
          projection.checkpointScopes.find((scope) => scope.id === rootNode?.checkpointScopeId)
            ?.cwd,
          checkoutRoot,
        );
      }),
  );

  it.effect("keeps queued user selections and pauses only the limited provider", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-queue-provider-limit");
      const queuedSelection = {
        instanceId: alternateInstanceId,
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        createdBy: "user",
        creationSource: "web",
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Limited queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const selections = [modelSelection, modelSelection, queuedSelection];
      for (const [index, selection] of selections.entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${index}`),
          text: `Prompt ${index}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          modelSelection: selection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      const [active, limited, available] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(active);
      assert.isDefined(limited);
      assert.isDefined(available);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:error`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            nodeId: active.rootNodeId!,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:error`),
              type: "error",
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId!,
              providerThreadId: active.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Usage limit reached",
                code: "usage_limit",
                retryable: null,
              },
            },
          },
          {
            id: EventId.make(`${threadId}:failed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`${threadId}:other-session`),
            type: "provider-session.attached",
            threadId,
            providerInstanceId: alternateInstanceId,
            occurredAt: now,
            payload: {
              id: ProviderSessionId.make(`${threadId}:other-session`),
              driver,
              providerInstanceId: alternateInstanceId,
              status: "error",
              cwd: process.cwd(),
              model: queuedSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: "Unrelated session error on the other provider",
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:select-other`),
        threadId,
        modelSelection: queuedSelection,
      });
      yield* orchestrator.resumeQueuedRuns;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.runs.find((run) => run.id === limited.id)?.status, "queued");
      const blocked = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:blocked`),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${threadId}:select-original`),
        threadId,
        modelSelection,
      });
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`${threadId}:cancel-limited`),
        threadId,
        runId: limited.id,
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:hold-available`),
            type: "run.updated",
            threadId,
            runId: available.id,
            occurredAt: now,
            payload: { ...available, queueHeld: true },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`${threadId}:resume-available`),
        threadId,
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const started = after.runs.find((run) => run.id === available.id);
      assert.equal(started?.status, "starting");
      assert.deepEqual(started?.modelSelection, queuedSelection);
      assert.deepEqual(after.thread.modelSelection, queuedSelection);
    }),
  );

  it.effect.each(["the reset passes", "the user resumes"] as const)(
    "holds a limited provider's queue through another provider's turn until %s",
    (release) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-queue-limit-switch-${release}`);
        const switchedSelection = { instanceId: alternateInstanceId, model: "gpt-5.5" };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Limit switch",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const send = (
          name: string,
          selection: typeof modelSelection | typeof switchedSelection,
          type: "start_immediately" | "queue_after_active",
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:${name}`),
            threadId,
            messageId: MessageId.make(`${threadId}:${name}`),
            text: name,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            modelSelection: selection,
            dispatchMode: { type },
          });
        yield* send("limited", modelSelection, "start_immediately");
        yield* send("queued", modelSelection, "queue_after_active");
        const [limited, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.isDefined(limited);
        assert.isDefined(queued);
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:error`),
              type: "turn-item.updated",
              threadId,
              runId: limited.id,
              nodeId: limited.rootNodeId!,
              providerInstanceId: limited.providerInstanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:error`),
                type: "error",
                threadId,
                runId: limited.id,
                nodeId: limited.rootNodeId!,
                providerThreadId: limited.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Usage limit",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Usage limit reached",
                  code: "usage_limit",
                  retryable: null,
                  resetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
                },
              },
            },
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              runId: limited.id,
              providerInstanceId: limited.providerInstanceId,
              occurredAt: now,
              payload: { ...limited, status: "failed", completedAt: now },
            },
          ],
        });

        // A message on another provider starts ahead of the held queue and
        // completes there.
        yield* send("switch", switchedSelection, "start_immediately");
        const switched = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make(`${threadId}:switch`),
        );
        assert.equal(switched?.status, "starting");
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:switch:completed`),
              type: "run.updated",
              threadId,
              runId: switched!.id,
              providerInstanceId: switched!.providerInstanceId,
              occurredAt: now,
              payload: { ...switched!, status: "completed", completedAt: now },
            },
          ],
        });

        yield* orchestrator.resumeQueuedRuns;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs.find((run) => run.id === queued.id)?.status, "queued");

        if (release === "the reset passes") {
          yield* TestClock.adjust("61 minutes");
          yield* orchestrator.resumeQueuedRuns;
        } else {
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });
        }
        const reset = yield* orchestrator.getThreadProjection(threadId);
        const resumed = reset.runs.find((run) => run.id === queued.id);
        assert.equal(resumed?.status, "starting");
        assert.deepEqual(resumed?.modelSelection, modelSelection);
      }),
  );

  it.effect.each([
    ["server", modelSelection],
    ["provider", modelSelection],
  ] as const)(
    "delivers a queued monitor update from %s after conversation selection %j",
    ([creationSource, currentSelection]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(
          `runtime-layer-queue-current-conversation-${creationSource}-${currentSelection.instanceId}`,
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Current conversation",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const type of ["start_immediately", "queue_after_active"] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:${type}`),
            messageId: MessageId.make(`${threadId}:${type}`),
            threadId,
            text: type,
            attachments: [],
            createdBy: "agent",
            creationSource,
            dispatchMode: { type },
            ...(type === "queue_after_active"
              ? {
                  notification: {
                    source: { kind: "monitor" as const },
                    outcome: "updated" as const,
                    summary: "PR update",
                  },
                }
              : {}),
          });
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const [active, queued] = before.runs;
        assert.isDefined(active);
        assert.isDefined(queued);
        const now = yield* DateTime.now;
        const current = {
          ...before.providerThreads[0]!,
          id: ProviderThreadId.make(`${threadId}:current`),
          updatedAt: now,
        };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-current`),
          threadId,
          modelSelection: currentSelection,
        });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "completed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:conversation`),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: current,
            },
          ],
        });
        const expectedThreadId =
          creationSource === "provider" ? queued.providerThreadId : current.id;
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.id === queued.id)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(delivered.modelSelection, modelSelection);
        assert.equal(delivered.providerInstanceId, modelSelection.instanceId);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          modelSelection.instanceId,
        );
        assert.equal(delivered.providerThreadId, expectedThreadId);
        assert.equal(after.thread.activeProviderThreadId, expectedThreadId);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerThreadId,
          expectedThreadId,
        );
        const root = after.nodes.find((node) => node.id === delivered.rootNodeId)!;
        assert.equal(root.providerThreadId, expectedThreadId);
        assert.equal(
          after.checkpointScopes.find((scope) => scope.id === root.checkpointScopeId)
            ?.providerThreadId,
          expectedThreadId,
        );
      }),
  );

  it.effect.each([
    { ...modelSelection, model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] },
  ])(
    "starts a queued delegated completion on a selection set while it waited: %j",
    (newerSelection) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(
          `runtime-layer-queued-delegated-completion-selection-${newerSelection.instanceId}`,
        );
        const taskId = NodeId.make(`${threadId}:task`);
        const completionMessageId = MessageId.make(`${threadId}:completion`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Delegated completion selection",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Delegate a task",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            delegatedCompletionUpdated({
              id: `${threadId}:cohort`,
              threadId,
              runId: active.id,
              occurredAt: now,
              delegatedCompletion: {
                disposition: "open",
                nextGeneration: 2,
                delivery: { messageId: completionMessageId, generation: 1, taskIds: [taskId] },
              },
            }),
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:completion`),
          threadId,
          messageId: completionMessageId,
          text: "Delegated task finished",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: active.id, generation: 1, taskIds: [taskId] },
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-newer`),
          threadId,
          modelSelection: newerSelection,
        });
        const waiting = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: {
                ...waiting.runs.find((run) => run.id === active.id)!,
                status: "completed",
                completedAt: now,
              },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.userMessageId === completionMessageId)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(delivered.modelSelection, newerSelection);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          newerSelection.instanceId,
        );
        assert.deepEqual(after.thread.modelSelection, newerSelection);
      }),
  );

  it.effect("keeps a model picked ahead of a queued agent message that names none", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-queued-agent-message-model-pick");
      const pickedSelection = { ...modelSelection, model: "gpt-5.5" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        createdBy: "user",
        creationSource: "web",
        title: "Queued model pick",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [key, selection] of [
        ["active", modelSelection],
        ["picked", pickedSelection],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${key}`),
          text: key,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: key === "active" ? "start_immediately" : "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      // What t3_thread_send dispatches: no model of its own.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:agent`),
        threadId,
        messageId: MessageId.make(`${threadId}:agent`),
        text: "Message from another thread",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const [active, picked, agent] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(active);
      assert.isDefined(picked);
      assert.isDefined(agent);
      const now = yield* DateTime.now;
      for (const runId of [active.id, picked.id]) {
        const current = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${runId}:completed`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                ...current.runs.find((run) => run.id === runId)!,
                status: "completed",
                completedAt: now,
              },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      const delivered = after.runs.find((run) => run.id === agent.id)!;
      assert.equal(delivered.status, "starting");
      assert.deepEqual(delivered.modelSelection, pickedSelection);
      assert.deepEqual(after.thread.modelSelection, pickedSelection);
    }),
  );

  it.effect(
    "starts a queued agent message that names no model on a pick made while it waited",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("runtime-layer-queued-agent-message-later-pick");
        const pickedSelection = { ...modelSelection, model: "gpt-5.5" };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Pick while an agent message waits",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "active",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:agent`),
          threadId,
          messageId: MessageId.make(`${threadId}:agent`),
          text: "Message from another thread",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:pick`),
          threadId,
          modelSelection: pickedSelection,
        });
        const [active, agent] = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.isDefined(active);
        assert.isDefined(agent);
        const now = yield* DateTime.now;
        const current = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${active.id}:completed`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: {
                ...current.runs.find((run) => run.id === active.id)!,
                status: "completed",
                completedAt: now,
              },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.id === agent.id)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(after.thread.modelSelection, pickedSelection);
        assert.deepEqual(delivered.modelSelection, pickedSelection);
      }),
  );

  it.effect("keeps a buffered provider wake on its own provider behind a queued pick", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-buffered-wake-behind-queued-pick");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        createdBy: "user",
        creationSource: "web",
        title: "Buffered wake behind a pick",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [key, selection] of [
        ["active", modelSelection],
        ["picked", { ...modelSelection, instanceId: alternateInstanceId }],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${key}`),
          text: key,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: key === "active" ? "start_immediately" : "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`${threadId}:wake`),
        threadId,
        messageId: MessageId.make(`${threadId}:wake`),
        text: "Background activity updated",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const active = projection.runs.find(
        (run) => run.userMessageId === MessageId.make(`${threadId}:active`),
      );
      const wake = projection.runs.find(
        (run) => run.userMessageId === MessageId.make(`${threadId}:wake`),
      );
      assert.deepEqual(wake?.modelSelection, modelSelection);
      assert.equal(wake?.providerThreadId, active?.providerThreadId);
    }),
  );

  it.effect.each(["", "pause", "resume", "clear", "edit"])(
    "refuses unsupported Antigravity goal controls: %s",
    (control) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`antigravity-goal-control-${control}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Native goal",
          modelSelection: { ...modelSelection, instanceId: antigravityInstanceId },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const sequence = yield* orchestrator.getThreadEventSequence(threadId);
        const refused = yield* Effect.flip(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:goal`),
            threadId,
            messageId: MessageId.make(`${threadId}:goal`),
            text: `/goal ${control}`,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.instanceOf(refused, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          refused.cause,
          "Antigravity accepts /goal followed by an objective. Interrupt the running turn, then ask Antigravity to stop the current goal.",
        );
        assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
      }),
  );

  it.effect("checks a queued goal pause against the model picked ahead of it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-goal-pause-behind-queued-pick");
      const claudeSelection = { ...modelSelection, instanceId: claudeInstanceId };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        createdBy: "user",
        creationSource: "web",
        title: "Goal pause behind a pick",
        modelSelection: claudeSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [key, selection] of [
        ["active", claudeSelection],
        ["picked", modelSelection],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${key}`),
          text: key,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: key === "active" ? "start_immediately" : "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const activeDemandId = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === MessageId.make(`${threadId}:active`),
      )?.demandId;
      const sendGoal = (key: string, text: string, deliveryIntent?: "auto") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${key}`),
          text,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(deliveryIntent === undefined ? {} : { deliveryIntent }),
          ...(activeDemandId === undefined ? {} : { demandId: activeDemandId }),
          createdBy: "agent",
          creationSource: "mcp",
        });
      // It runs after the pick, on a provider that can pause goals.
      yield* sendGoal("pause", "/goal pause");
      // A resume stops the active run and starts before the pick, so the thread's
      // Claude instance still refuses it.
      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      const refused = yield* Effect.flip(sendGoal("resume", "/goal resume", "auto"));
      assert.instanceOf(refused, Orchestrator.OrchestratorDispatchError);
      assert.equal(
        refused.cause,
        "Claude goals cannot be paused or resumed. Send /goal clear to remove the goal.",
      );
      assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);

      const pause = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === MessageId.make(`${threadId}:pause`),
      );
      assert.deepEqual(pause?.modelSelection, modelSelection);
    }),
  );

  it.effect.each([
    { ...modelSelection, model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] },
    { instanceId: alternateInstanceId, model: "gpt-5.5" },
  ])(
    "starts a queued scheduled delivery on a selection set while it waited: %j",
    (newerSelection) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(
          `runtime-layer-queued-scheduled-selection-${newerSelection.instanceId}-${"options" in newerSelection}`,
        );
        const scheduledMessageId = MessageId.make(`${threadId}:scheduled`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Scheduled delivery selection",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Busy",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        // Bound scheduled tasks send like ScheduledTaskService: no model of their own.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:scheduled`),
          threadId,
          messageId: scheduledMessageId,
          scheduledTaskId: ScheduledTaskId.make(`${threadId}:task`),
          text: "Scheduled prompt",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === scheduledMessageId,
        )!;
        assert.equal(queued.status, "queued");
        assert.deepEqual(queued.modelSelection, modelSelection);
        // Stop holds the queue; a thread changes instance only while no run is active.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${threadId}:stop`),
          threadId,
          runId: active.id,
          holdQueue: true,
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-newer`),
          threadId,
          modelSelection: newerSelection,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.userMessageId === scheduledMessageId)!;
        assert.equal(delivered.status, "starting");
        assert.deepEqual(delivered.modelSelection, newerSelection);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          newerSelection.instanceId,
        );
        assert.deepEqual(after.thread.modelSelection, newerSelection);
        assert.equal(after.thread.providerInstanceId, newerSelection.instanceId);
      }),
  );

  it.effect(
    "starts a queued scheduled delivery that pinned a model on its pin after the thread moved",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-queued-scheduled-pinned-selection");
        const scheduledMessageId = MessageId.make(`${threadId}:scheduled`);
        const pinnedSelection = { instanceId: modelSelection.instanceId, model: "gpt-5.5" };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Pinned scheduled selection",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Busy",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        // A task that pins a model names it on the delivery, as a fresh-thread launch seeds it.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:scheduled`),
          threadId,
          messageId: scheduledMessageId,
          scheduledTaskId: ScheduledTaskId.make(`${threadId}:task`),
          modelSelection: pinnedSelection,
          text: "Pinned scheduled prompt",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === scheduledMessageId,
        )!;
        assert.equal(queued.status, "queued");
        assert.deepEqual(queued.modelSelection, pinnedSelection);
        // Stop holds the queue; a thread changes instance only while no run is active.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${threadId}:stop`),
          threadId,
          runId: active.id,
          holdQueue: true,
        });
        // The user moves the thread off the pinned model while the delivery is held.
        const movedSelection = { instanceId: alternateInstanceId, model: "gpt-5.5" };
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-moved`),
          threadId,
          modelSelection: movedSelection,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.userMessageId === scheduledMessageId)!;
        assert.equal(delivered.status, "starting");
        // The pin wins: the run starts on the selection the delivery named, not the thread's later pick.
        assert.deepEqual(delivered.modelSelection, pinnedSelection);
        assert.equal(
          after.attempts.find((attempt) => attempt.id === delivered.activeAttemptId)
            ?.providerInstanceId,
          pinnedSelection.instanceId,
        );
        // Pinned tasks keep today's behaviour: the thread follows the run's selection back.
        assert.deepEqual(after.thread.modelSelection, pinnedSelection);
      }),
  );

  it.effect(
    "starts a fresh scheduled delivery on a new provider thread after a provider switch",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-fresh-scheduled-provider-thread");
        const switchedSelection = { instanceId: alternateInstanceId, model: "gpt-5.5" };
        const scheduledMessageId = MessageId.make(`${threadId}:scheduled`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          createdBy: "user",
          creationSource: "web",
          title: "Fresh scheduled provider thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Busy",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:scheduled`),
          threadId,
          messageId: scheduledMessageId,
          scheduledTaskId: ScheduledTaskId.make(`${threadId}:task`),
          text: "Scheduled prompt",
          attachments: [],
          freshContext: true,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedProjection = yield* orchestrator.getThreadProjection(threadId);
        const queued = queuedProjection.runs.find(
          (run) => run.userMessageId === scheduledMessageId,
        )!;
        // The queue reserved an unused provider thread on the original instance.
        const reserved = queuedProjection.providerThreads.find(
          (providerThread) => providerThread.id === queued.providerThreadId,
        )!;
        assert.equal(reserved.providerInstanceId, modelSelection.instanceId);
        assert.isNull(reserved.firstRunOrdinal);
        assert.isNull(reserved.nativeThreadRef);
        // Stop holds the queue; a thread changes instance only while no run is active.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`${threadId}:stop`),
          threadId,
          runId: active.id,
          holdQueue: true,
        });
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`${threadId}:select-switched`),
          threadId,
          modelSelection: switchedSelection,
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        });
        yield* orchestrator.resumeQueuedRuns;

        const after = yield* orchestrator.getThreadProjection(threadId);
        const delivered = after.runs.find((run) => run.userMessageId === scheduledMessageId)!;
        assert.equal(delivered.status, "starting");
        assert.isTrue(delivered.freshContext === true);
        assert.notEqual(delivered.providerThreadId, reserved.id);
        assert.equal(
          after.providerThreads.find(
            (providerThread) => providerThread.id === delivered.providerThreadId,
          )?.providerInstanceId,
          switchedSelection.instanceId,
        );
        assert.equal(
          after.providerThreads.find((providerThread) => providerThread.id === reserved.id)
            ?.providerInstanceId,
          modelSelection.instanceId,
        );
      }),
  );

  it.effect("keeps the queue after a user interrupts the active run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-interrupted-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Interrupted queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [index, text] of ["Active", "Queued"].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs[0]!;
      const queuedRun = before.runs[1]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: activeRun.id,
        holdQueue: true,
      });

      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === activeRun.id)?.status, "interrupted");
      assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
      assert.isTrue(after.runs.find((run) => run.id === queuedRun.id)?.queueHeld);
      assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
    }),
  );

  it.effect("places held queued messages after a continuation that started first", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-layer-continuation-before-queue");
      const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Continuation before queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const dispatch = (key: string, start: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${key}`),
          threadId,
          messageId: messageId(key),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
        });
      const runFor = (key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
          assert.isDefined(run);
          return run;
        });
      yield* dispatch("active", true);
      yield* dispatch("first-queued", false);
      yield* dispatch("second-queued", false);
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: (yield* runFor("active")).id,
        holdQueue: true,
      });
      yield* dispatch("continue", true);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make(`${threadId}:resume`),
        threadId,
      });

      const startedRunIds = yield* Queue.unbounded<RunId>();
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting"
            ? Queue.offer(startedRunIds, stored.event.payload.id)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const complete = (key: string) =>
        Effect.gen(function* () {
          const run = yield* runFor(key);
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}:${key}:completed`),
                type: "run.updated",
                threadId,
                runId: run.id,
                ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        });

      yield* complete("continue");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("first-queued")).id);
      yield* complete("first-queued");
      assert.equal(yield* Queue.take(startedRunIds), (yield* runFor("second-queued")).id);

      const keys = ["active", "continue", "first-queued", "second-queued"];
      const runs = yield* Effect.forEach(keys, runFor);
      const ordinals = runs.map((run) => run.ordinal);
      assert.deepEqual(
        ordinals,
        ordinals.toSorted((left, right) => left - right),
      );
      const { turnItems } = yield* orchestrator.getThreadProjection(threadId);
      const userItems = turnItems.filter((item) => item.type === "user_message");
      assert.deepEqual(
        userItems.map((item) => item.messageId),
        keys.map(messageId),
      );
    }),
  );

  it.effect.each([false, true])(
    "starts the queue before a send that arrives as the active run ends (worktree failed: %s)",
    (worktreeFailed) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const threadId = ThreadId.make(`runtime-layer-send-after-run-end-${worktreeFailed}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Send after run end",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const dispatch = (key: string, start: boolean) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "server",
            commandId: CommandId.make(`${threadId}:message:${key}`),
            threadId,
            messageId: messageId(key),
            text: key,
            attachments: [],
            modelSelection,
            dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
          });
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
            const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
            assert.isDefined(run);
            return run;
          });
        yield* dispatch("active", true);
        yield* dispatch("queued", false);
        const active = yield* runFor("active");
        assert.equal((yield* runFor("queued")).status, "queued");

        // Hold the run-end handler before it takes the thread lock, as a busy handler stream
        // does, then let it run once and signal when its queue release has finished.
        const handlerHeld = yield* Deferred.make<void>();
        const releaseHandler = yield* Deferred.make<void>();
        const releaseAttempted = yield* Deferred.make<void>();
        let lockCalls = 0;
        let armed = false;
        const withLock = executor.withLock;
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) => {
          if (key !== threadId || !armed) return withLock(key, effect);
          lockCalls += 1;
          if (lockCalls === 1) {
            return Deferred.succeed(handlerHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHandler)),
              Effect.andThen(withLock(key, effect)),
            );
          }
          if (lockCalls === 3) {
            return withLock(key, effect).pipe(
              Effect.ensuring(Deferred.succeed(releaseAttempted, undefined)),
            );
          }
          return withLock(key, effect);
        };
        const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          armed = true;
          const now = yield* DateTime.now;
          const { thread } = yield* orchestrator.getThreadProjection(threadId);
          yield* eventSink.write({
            events: [
              // A failed worktree setup leaves the thread without its worktree.
              ...(worktreeFailed
                ? [
                    {
                      id: EventId.make(`${threadId}:worktree-missing`),
                      type: "thread.metadata-updated" as const,
                      threadId,
                      occurredAt: now,
                      payload: { ...thread, worktreePath: null },
                    },
                  ]
                : []),
              {
                id: EventId.make(`${threadId}:active:completed`),
                type: "run.updated",
                threadId,
                runId: active.id,
                ...(active.rootNodeId === null ? {} : { nodeId: active.rootNodeId }),
                providerInstanceId: active.providerInstanceId,
                occurredAt: now,
                payload: worktreeFailed
                  ? {
                      ...active,
                      status: "failed",
                      workspacePreparation: { type: "worktree", baseRef: "main" },
                      startedAt: null,
                      completedAt: now,
                    }
                  : { ...active, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
          yield* Deferred.await(handlerHeld);
          yield* dispatch("newer", !worktreeFailed);
          // The thread is idle but has a queue, so the newer send waits behind it.
          assert.equal((yield* runFor("newer")).status, "queued");

          yield* Deferred.succeed(releaseHandler, undefined);
          yield* Deferred.await(releaseAttempted);
          const queued = yield* runFor("queued");
          if (worktreeFailed) {
            // Without a worktree the queue stays held instead of running in the project checkout.
            assert.equal(queued.status, "queued");
            assert.isTrue(queued.queueHeld);
          } else {
            assert.notEqual(queued.status, "queued");
          }
        }).pipe(Effect.ensuring(Effect.sync(() => lockSpy.mockRestore())));
      }),
  );

  it.effect.each([false, true])(
    "restarts a continuation that failed before its prompt, unless stopped (%s)",
    (stopped) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`runtime-layer-continuation-start-retry-${stopped}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Continuation start retry",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
            runs.find((candidate) => candidate.userMessageId === messageId(key)),
          );
        const write = (
          key: string,
          payload: OrchestrationV2Run,
          extra: Parameters<typeof eventSink.write>[0]["events"] = [],
        ) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                ...extra,
                {
                  id: EventId.make(`${threadId}:${key}`),
                  type: "run.updated",
                  threadId,
                  runId: payload.id,
                  providerInstanceId: payload.providerInstanceId,
                  occurredAt: now,
                  payload: { ...payload, startedAt: now, completedAt: now },
                },
              ],
            });
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:cut`),
          threadId,
          messageId: messageId("cut"),
          text: "Work that the restart cut",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const cut = (yield* runFor("cut"))!;
        yield* write("cut:cancelled", { ...cut, status: "cancelled" });
        yield* eventSink.writeWithEffects({
          events: [],
          effects: [
            {
              id: `effect:restart-continuation:${cut.id}`,
              commandId: CommandId.make(`${threadId}:crash-recovery`),
              threadId,
              request: {
                type: "provider-runtime.continue",
                sourceRunId: cut.id,
                processLossCount: 2,
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`${threadId}:message:continuation`),
          threadId,
          messageId: messageId("continuation"),
          text: "Continue where you left off.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: cut.id,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:queued`),
          threadId,
          messageId: messageId("queued"),
          text: "Queued behind the continuation",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        const continuation = (yield* runFor("continuation"))!;
        assert.isNotNull(continuation.rootNodeId);
        const queued = (yield* runFor("queued"))!;
        // The failure holds the queue after the reactor scheduled any retry.
        const held = yield* eventSink
          .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queued.id &&
                stored.event.payload.queueHeld === true,
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const now = yield* DateTime.now;
        yield* write("continuation:failed", { ...continuation, status: "failed" }, [
          {
            id: EventId.make(`${threadId}:continuation:error`),
            type: "turn-item.updated",
            threadId,
            runId: continuation.id,
            nodeId: continuation.rootNodeId,
            providerInstanceId: continuation.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:continuation:error`),
              type: "error",
              threadId,
              runId: continuation.id,
              nodeId: continuation.rootNodeId,
              providerThreadId: continuation.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Claude timed out while registering its MCP tools.",
                code: null,
                retryable: null,
              },
            },
          },
        ]);
        yield* Fiber.join(held);
        const retriesOf = Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) =>
          runs.filter((run) => run.restartContinuationOfRunId === continuation.id),
        );
        yield* worker.drain();
        assert.deepEqual(yield* retriesOf, [], "the retry waits out its backoff");
        const retryIntent = yield* (yield* EffectOutbox.EffectOutboxV2).get(
          `effect:restart-continuation:${continuation.id}`,
        );
        assert.deepEqual(Option.getOrUndefined(retryIntent)?.request, {
          type: "provider-runtime.continue",
          sourceRunId: continuation.id,
          processLossCount: 2,
        });
        if (stopped) {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
        }
        yield* TestClock.adjust("61 seconds");
        yield* worker.drain();
        assert.lengthOf(yield* retriesOf, stopped ? 0 : 1);
      }),
  );

  it.effect.each(["startup", "shutdown"] as const)(
    "preserves and holds queued messages across %s until explicitly resumed",
    (trigger) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const threadId = ThreadId.make(`queue-hold-${trigger}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Recover queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const [index, text] of ["Active", "First queued", "Second queued"].entries()) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.filter((run) => run.status === "queued");
        assert.equal(queued.length, 2);
        yield* recovery.reconcile(trigger);
        yield* recovery.reconcile("startup");
        const maintenance = yield* ProjectionReplay.ProjectionReplay;
        assert.isTrue((yield* maintenance.rebuild).valid);
        // The database is shared with other tests' threads, so only this thread's runs are checked.
        yield* orchestrator.resumeQueuedRuns;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          held.runs.map((run) => run.status),
          ["cancelled", "queued", "queued"],
        );
        for (const run of queued) {
          assert.deepEqual(
            held.runs.find((row) => row.id === run.id),
            { ...run, queueHeld: true, queueHeldByRestart: true },
          );
          assert.deepEqual(
            held.messages.find((row) => row.id === run.userMessageId),
            before.messages.find((row) => row.id === run.userMessageId),
          );
          assert.equal(
            held.attempts.find((row) => row.id === run.activeAttemptId)?.status,
            "pending",
          );
          assert.equal(held.nodes.find((row) => row.id === run.rootNodeId)?.status, "pending");
        }
        const first = queued[0]!;
        const second = queued[1]!;
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`${threadId}:edit`),
          threadId,
          runId: second.id,
          text: "Edited second message",
        });
        yield* orchestrator.dispatch({
          type: "queued-run.reorder",
          commandId: CommandId.make(`${threadId}:reorder`),
          threadId,
          runId: second.id,
          beforeRunId: first.id,
        });
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const resume = {
          type: "queue.resume" as const,
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        };
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        // The restart cut "Active" before its agent got it, so it goes first; the queue follows.
        const active = before.runs.find((run) => run.status !== "queued")!;
        assert.deepEqual(
          [active, second, first].map(
            (run) => resumed.runs.find((row) => row.id === run.id)?.status,
          ),
          ["starting", "queued", "queued"],
        );
        assert.isFalse(resumed.runs.some((run) => run.status === "queued" && run.queueHeld));
        assert.equal(
          resumed.messages.find((row) => row.id === second.userMessageId)?.text,
          "Edited second message",
        );
        assert.equal(resumed.runs.length, 3, "resume retries must not duplicate messages or runs");
        assert.lengthOf(resumed.messages, before.messages.length);
      }),
  );

  it.effect.each(["startup", "shutdown"] as const)(
    "starts a delegated task's prompt again after a %s cut it before the provider accepted it",
    (trigger) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const parentThreadId = ThreadId.make(`delegate-resend-${trigger}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:create`),
          threadId: parentThreadId,
          projectId: ProjectId.make(`${parentThreadId}:project`),
          title: "Delegating parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${parentThreadId}:message`),
          threadId: parentThreadId,
          messageId: MessageId.make(`${parentThreadId}:message`),
          text: "Delegate a review",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`${parentThreadId}:delegate`),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Review the diff",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const threadId = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!
          .childThreadId!;
        const before = yield* orchestrator.getThreadProjection(threadId);
        const run = before.runs[0]!;
        const attempt = before.attempts.find((row) => row.id === run.activeAttemptId)!;
        const rootNode = before.nodes.find((row) => row.id === run.rootNodeId)!;
        // What a provider turn start commits before the provider accepts the prompt.
        const startedAt = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make(`${threadId}:running:run`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: startedAt,
              payload: { ...run, status: "running", startedAt },
            },
            {
              id: EventId.make(`${threadId}:running:attempt`),
              type: "run-attempt.updated",
              threadId,
              runId: run.id,
              nodeId: rootNode.id,
              occurredAt: startedAt,
              payload: { ...attempt, status: "running", startedAt },
            },
            {
              id: EventId.make(`${threadId}:running:node`),
              type: "node.updated",
              threadId,
              runId: run.id,
              nodeId: rootNode.id,
              occurredAt: startedAt,
              payload: { ...rootNode, status: "running", startedAt },
            },
          ],
        });
        const expectCut = Effect.gen(function* () {
          const child = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            child.runs.map((row) => [row.id, row.status]),
            [[run.id, "cancelled"]],
          );
          const resume = yield* outbox.get(`effect:restart-continuation:${run.id}`);
          assert.equal(Option.getOrUndefined(resume)?.status, "pending");
        });
        if (trigger === "shutdown") yield* recovery.prepareForShutdown;
        yield* recovery.reconcile(trigger);
        yield* expectCut;
        // The server stops again before the restart started the task again.
        yield* TestClock.adjust("1 second");
        yield* recovery.reconcile("startup");
        yield* orchestrator.recoverDelegatedTasks;
        yield* expectCut;
        assert.deepInclude((yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0], {
          status: "running",
          result: null,
        });
        yield* continueRestartedRun({ threadId, sourceRunId: run.id }).pipe(
          Effect.provide(ServerSettings.layerTest()),
        );
        const child = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          child.runs.map((row) => [row.id, row.status]),
          [[run.id, "starting"]],
        );
        assert.deepEqual(child.messages, before.messages);
        // The automatic retry waits for memory, then starts once the queue lets it go.
        assert.deepEqual(
          yield* outbox.listByCommandId(CommandId.make(`command:restart-retry:${run.id}:1`)),
          [],
        );
        const admittedBy = yield* admitHeldRun(threadId, run.id, "restart-retry");
        const start = yield* outbox.get(`effect:${admittedBy}:provider-turn.start:${run.id}`);
        assert.equal(Option.getOrUndefined(start)?.status, "pending");
      }),
  );

  it.effect.each(
    (["preparing", "starting", "running"] as const).flatMap((cutWhile) =>
      (["recovery", "agent", "person"] as const).map((resumedBy) => ({ cutWhile, resumedBy })),
    ),
  )(
    "sends a run cut while $cutWhile again after a restart, on $resumedBy, then the messages behind it",
    ({ cutWhile, resumedBy }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const eventSink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = ThreadId.make(`restart-before-prompt-${cutWhile}-${resumedBy}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Restart before the prompt",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const send = (
          key: string,
          dispatchMode: Extract<
            OrchestrationV2Command,
            { readonly type: "message.dispatch" }
          >["dispatchMode"],
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${key}`),
            threadId,
            messageId: messageId(key),
            text: key,
            attachments: [],
            modelSelection,
            dispatchMode,
          });
        yield* send(
          "work",
          cutWhile === "preparing"
            ? { type: "defer_start", workspaceStrategy: { type: "worktree", baseRef: "main" } }
            : { type: "start_immediately" },
        );
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
            const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
            assert.isDefined(run);
            return run;
          });
        const work = yield* runFor("work");
        assert.equal(work.status, cutWhile === "preparing" ? "preparing" : "starting");
        if (cutWhile === "running") {
          // ProviderTurnStartService marks the run running before the provider has a native
          // thread or a turn.
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}:running`),
                type: "run.updated",
                threadId,
                runId: work.id,
                providerInstanceId: work.providerInstanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...work, status: "running", startedAt: yield* DateTime.now },
              },
            ],
          });
        }
        yield* send("queued", { type: "queue_after_active" });
        const queued = yield* runFor("queued");

        yield* recovery.reconcile("startup");
        const cut = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(cut.runs.find((run) => run.id === work.id)?.status, "cancelled");
        const resume = yield* outbox.get(`effect:restart-continuation:${work.id}`);
        assert.equal(Option.getOrUndefined(resume)?.status, "pending");

        // A later send, like an agent's t3_thread_send, must not start ahead of the cut message.
        const laterCommandId = CommandId.make(`${threadId}:message:later`);
        if (resumedBy === "recovery") {
          yield* continueRestartedRun({ threadId, sourceRunId: work.id }).pipe(
            Effect.provide(ServerSettings.layerTest()),
          );
        } else {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            ...(resumedBy === "agent"
              ? ({ createdBy: "agent", creationSource: "mcp" } as const)
              : ({ createdBy: "user", creationSource: "web" } as const)),
            commandId: laterCommandId,
            threadId,
            messageId: messageId("later"),
            text: "later",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          });
        }
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const again = resumed.runs.find((run) => run.id === work.id)!;
        assert.equal(again.status, cutWhile === "preparing" ? "preparing" : "starting");
        assert.equal(again.userMessageId, work.userMessageId);
        assert.deepEqual(
          resumed.runs.filter((run) => run.id !== work.id).map((run) => run.status),
          resumedBy === "recovery" ? ["queued"] : ["queued", "queued"],
          "the cut run starts again instead of a new one, ahead of later messages",
        );
        assert.isFalse(resumed.messages.some((message) => message.text === CONTINUE_PROMPT));
        assert.isTrue(
          resumed.turnItems.some(
            (item) =>
              item.id ===
              restartRetryNoticeId(work.id, 1, cutWhile === "running" ? "unconfirmed" : "unsent"),
          ),
        );
        // The restart's own retry and an agent's send wait for memory; a person's send does not.
        assert.equal(orchestrationV2RunAwaitsMemory(again), resumedBy !== "person");
        // The workspace it asked for is prepared again before its message goes out.
        const revivedBy =
          resumedBy === "person"
            ? laterCommandId
            : yield* admitHeldRun(threadId, work.id, resumedBy);
        for (const type of ["workspace.prepare", "provider-turn.start"] as const) {
          const effect = yield* outbox.get(`effect:${revivedBy}:${type}:${work.id}`);
          assert.equal(
            Option.isSome(effect),
            (type === "workspace.prepare") === (cutWhile === "preparing"),
            type,
          );
        }
        const behind = resumed.runs.find((run) => run.id === queued.id)!;
        // A person's message resumes the queue the restart held.
        assert.equal(behind.queueHeld, resumedBy !== "person");
        assert.equal(behind.queueHeldByRestart === true, resumedBy !== "person");

        // The user never held their message: it follows once the resumed run completes.
        const queuedStarts = yield* eventSink
          .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queued.id &&
                stored.event.payload.status === "starting",
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run.updated",
              threadId,
              runId: again.id,
              providerInstanceId: again.providerInstanceId,
              occurredAt: now,
              payload: { ...again, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        assert.isTrue(Option.isSome(yield* Fiber.join(queuedStarts)));
      }),
  );

  it.effect.each(["stopped", "skipped", "server", "removed", "send-now", "snoozed"] as const)(
    "brings back a message a restart kept from the agent only while it is still owed: %s",
    (scenario) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`restart-owed-${scenario}`);
        const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Owed message",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const send = (
          key: string,
          dispatchMode: Extract<
            OrchestrationV2Command,
            { readonly type: "message.dispatch" }
          >["dispatchMode"],
          creationSource: "web" | "mcp" | "server" = "web",
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: creationSource === "web" ? "user" : "agent",
            creationSource,
            commandId: CommandId.make(`${threadId}:message:${key}`),
            threadId,
            messageId: messageId(key),
            text: key,
            attachments: [],
            modelSelection,
            dispatchMode,
          });
        const runFor = (key: string) =>
          Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
            const run = runs.find((candidate) => candidate.userMessageId === messageId(key));
            assert.isDefined(run);
            return run;
          });
        yield* send("work", { type: "start_immediately" });
        yield* send("first", { type: "queue_after_active" });
        yield* send("second", { type: "queue_after_active" });
        yield* recovery.reconcile("startup");
        const work = yield* runFor("work");
        assert.equal(work.status, "cancelled");

        if (scenario === "stopped") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`${threadId}:stop`),
            threadId,
          });
        } else if (scenario === "skipped") {
          // Restart recovery found this scheduled occurrence stale and settled it.
          const now = yield* DateTime.now;
          const skipId = TurnItemId.make(`scheduled-recovery-skip:${work.id}`);
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}:skip`),
                type: "turn-item.updated",
                threadId,
                runId: work.id,
                providerInstanceId: work.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: skipId,
                  type: "system_notice",
                  threadId,
                  runId: work.id,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 10,
                  status: "completed",
                  title: "Skipped",
                  message: "Skipped: a newer run of Inbox replaced this one.",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        } else if (scenario === "removed") {
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`${threadId}:remove`),
            threadId,
            runId: (yield* runFor("second")).id,
          });
        }

        if (scenario === "send-now") {
          yield* orchestrator.dispatch({
            type: "queued-run.start",
            commandId: CommandId.make(`${threadId}:send-now`),
            threadId,
            runId: (yield* runFor("second")).id,
          });
        } else if (scenario === "snoozed") {
          // The person clears the queue, which a snooze needs, after the restart chose to send its
          // message again, then snoozes the thread.
          for (const key of ["first", "second"]) {
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`${threadId}:remove:${key}`),
              threadId,
              runId: (yield* runFor(key)).id,
            });
          }
          yield* orchestrator.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make(`${threadId}:snooze`),
            threadId,
            snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
          });
          const refused = yield* orchestrator
            .dispatch({
              type: "prepared-run.retry",
              automatic: true,
              commandId: CommandId.make(`command:restart-retry:${work.id}:1`),
              threadId,
              runId: work.id,
            })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "OrchestratorDispatchError");
        } else {
          yield* send(
            "later",
            { type: "start_immediately" },
            scenario === "server" ? "server" : "mcp",
          );
        }

        const revived = scenario === "removed" || scenario === "send-now";
        assert.equal(
          (yield* runFor("work")).status,
          revived ? "starting" : "cancelled",
          "a message is owed after a Stop, a skip, or a server's own message only if revived",
        );
        if (scenario === "send-now") {
          // The message Send now picked still goes right after the revived one.
          assert.deepEqual(
            [(yield* runFor("second")).queuePosition, (yield* runFor("first")).queuePosition],
            [1, 2],
          );
        }
      }),
  );

  it.effect("a Stop after a restart turns its hold into the user's own", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const threadId = ThreadId.make("restart-hold-then-stop");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Stop after a restart",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [index, text] of ["Active", "Queued"].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      yield* recovery.reconcile("startup");
      const [active, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      assert.isTrue(queued.queueHeldByRestart);
      yield* continueRestartedRun({ threadId, sourceRunId: active.id }).pipe(
        Effect.provide(ServerSettings.layerTest()),
      );
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: active.id,
        holdQueue: true,
      });
      const after = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === queued.id,
      )!;
      assert.isTrue(after.queueHeld);
      assert.isUndefined(after.queueHeldByRestart);
    }),
  );

  it.effect("starts a restart's held message when no resume of the cut run is pending", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restart-hold-without-resume");
      const { orchestrator, active, heldRun } = yield* restartHeldQueue(threadId);
      // The resume ran and declined, as when the cut run's turn had already finished.
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.deepEqual(
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-runtime.continue"],
          reason: "declined",
        }),
        [EffectOutbox.restartContinuationEffectId(active.id)],
      );
      yield* orchestrator.resumeQueuedRuns;
      assert.isUndefined((yield* heldRun()).queueHeldByRestart);
      assert.isNotTrue((yield* heldRun()).queueHeld);
    }),
  );

  it.effect("releases a hold a restart left before holds carried the restart flag", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("restart-hold-without-flag");
      const { orchestrator, queuedId, heldRun } = yield* restartHeldQueue(threadId);
      const eventSink = yield* EventSink.EventSinkV2;
      const { queueHeldByRestart: _flag, ...unflagged } = yield* heldRun();
      yield* eventSink.write({
        commandId: CommandId.make(`${threadId}:strip-flag`),
        events: [
          {
            id: EventId.make(`${threadId}:strip-flag-event`),
            type: "run.updated",
            threadId,
            runId: queuedId,
            occurredAt: yield* DateTime.now,
            payload: unflagged,
          },
        ],
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-runtime.continue"],
        reason: "declined",
      });
      const shellHeld = () =>
        orchestrator
          .getShellSnapshot()
          .pipe(
            Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === threadId)),
          );
      assert.isTrue((yield* heldRun()).queueHeld);
      assert.isTrue((yield* shellHeld())?.queueHeld);
      yield* orchestrator.resumeQueuedRuns;
      assert.isNotTrue((yield* heldRun()).queueHeld);
      assert.isNotTrue((yield* shellHeld())?.queueHeld);
      assert.notEqual((yield* heldRun()).status, "queued");
    }),
  );

  it.effect("keeps a restart's holds until its resume ran, past an older run's late update", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const eventSink = yield* EventSink.EventSinkV2;
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Resume before the queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
      const send = (threadId: ThreadId, key: string, start: boolean) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${key}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${key}`),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode: { type: start ? "start_immediately" : "queue_after_active" },
        });
      const runFor = (threadId: ThreadId, key: string) =>
        Effect.map(orchestrator.getThreadProjection(threadId), ({ runs }) => {
          const run = runs.find(
            (candidate) => candidate.userMessageId === MessageId.make(`${threadId}:${key}`),
          );
          assert.isDefined(run);
          return run;
        });
      const complete = (threadId: ThreadId, run: OrchestrationV2Run, key: string) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${threadId}:${key}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        });
      const threadId = ThreadId.make("restart-resume-before-queue");
      yield* createThread(threadId);
      yield* send(threadId, "earlier", true);
      yield* complete(threadId, yield* runFor(threadId, "earlier"), "earlier:completed");
      yield* send(threadId, "work", true);
      yield* send(threadId, "queued", false);
      yield* recovery.reconcile("startup");

      // A bookkeeping update to the older run, as delegated recovery writes at startup.
      yield* complete(threadId, yield* runFor(threadId, "earlier"), "earlier:bookkeeping");
      // Run updates are handled in order, so a queue starting after it shows it was handled.
      const barrier = ThreadId.make("restart-resume-before-queue:barrier");
      yield* createThread(barrier);
      yield* send(barrier, "active", true);
      yield* send(barrier, "next", false);
      const next = yield* runFor(barrier, "next");
      const nextStarted = yield* eventSink
        .stream({
          threadId: barrier,
          afterSequence: yield* orchestrator.getThreadEventSequence(barrier),
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === next.id &&
              stored.event.payload.status === "starting",
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* complete(barrier, yield* runFor(barrier, "active"), "active:completed");
      assert.isTrue(Option.isSome(yield* Fiber.join(nextStarted)));

      const queued = yield* runFor(threadId, "queued");
      assert.equal(queued.status, "queued");
      assert.isTrue(queued.queueHeld);
      yield* continueRestartedRun({
        threadId,
        sourceRunId: (yield* runFor(threadId, "work")).id,
      }).pipe(Effect.provide(ServerSettings.layerTest()));
      assert.equal((yield* runFor(threadId, "work")).status, "starting");
    }),
  );

  it.effect("leaves a cut delegated completion to delegated recovery", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("restart-cut-delegated-completion");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Delegated completion",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "server",
        commandId: CommandId.make(`${threadId}:delivery`),
        threadId,
        messageId: MessageId.make(`${threadId}:delivery`),
        text: "Delegated task reached a terminal state.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* recovery.reconcile("startup");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const [delivery] = projection.runs as [OrchestrationV2Run];
      const message = projection.messages.find((row) => row.id === delivery.userMessageId)!;
      const now = yield* DateTime.now;
      // Recovery offers this completion again under a new generation.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:delivery-message`),
            type: "message.updated",
            threadId,
            runId: delivery.id,
            occurredAt: now,
            payload: {
              ...message,
              delegatedCompletion: {
                parentRunId: delivery.id,
                generation: 1,
                taskIds: [NodeId.make(`${threadId}:task`)],
              },
            },
          },
        ],
      });
      yield* continueRestartedRun({ threadId, sourceRunId: delivery.id }).pipe(
        Effect.provide(ServerSettings.layerTest()),
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["cancelled"],
      );
    }),
  );

  it.effect.each([
    { text: "Rebase onto main", restarts: 2, resent: true },
    // A /goal reaches the provider verbatim, so an unconfirmed one is not replayed.
    { text: "/goal Ship the release", restarts: 1, resent: false },
  ] as const)(
    "keeps the doubt about a message the restart may have sent: %j",
    ({ text, restarts, resent }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`restart-unconfirmed-${restarts}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Unconfirmed delivery",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message`),
          threadId,
          messageId: MessageId.make(`${threadId}:message`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const [work] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
        ];
        const now = yield* DateTime.now;
        // Cut while running: the prompt may have reached the provider.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:running`),
              type: "run.updated",
              threadId,
              runId: work.id,
              providerInstanceId: work.providerInstanceId,
              occurredAt: now,
              payload: { ...work, status: "running", startedAt: now },
            },
          ],
        });
        for (let restart = 1; restart <= restarts; restart += 1) {
          // Later restarts cut the run again while it is starting over.
          yield* TestClock.adjust("1 minute");
          yield* recovery.reconcile("startup");
          yield* continueRestartedRun({ threadId, sourceRunId: work.id }).pipe(
            Effect.provide(ServerSettings.layerTest()),
          );
          // It starts before the next restart, which cuts it again.
          yield* admitHeldRun(threadId, work.id, `restart-${restart}`);
        }
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, resent ? "starting" : "cancelled");
        assert.deepEqual(
          after.turnItems.flatMap((item) =>
            item.type === "system_notice" && item.title === "Message sent again" ? [item.id] : [],
          ),
          resent
            ? Array.from({ length: restarts }, (_, index) =>
                restartRetryNoticeId(work.id, index + 1, "unconfirmed"),
              )
            : [],
        );
      }),
  );

  it.effect.each([
    { delivered: false, status: "starting", item: "cancelled" },
    { delivered: true, status: "failed", item: "failed" },
  ] as const)(
    "starts again a run whose provider failed to start before it took the message: %j",
    ({ delivered, status, item }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = ThreadId.make(`undelivered-start-${delivered}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Slept through the start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message`),
          threadId,
          messageId: MessageId.make(`${threadId}:message`),
          text: "Check the backlog",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const started = yield* orchestrator.getThreadProjection(threadId);
        const run = started.runs[0]!;
        const attempt = started.attempts.find((row) => row.id === run.activeAttemptId)!;
        const rootNode = started.nodes.find((row) => row.id === run.rootNodeId)!;
        const now = yield* DateTime.now;
        const failureId = TurnItemId.make(`${threadId}:start-failed`);
        yield* eventSink.write({
          events: [
            ...(delivered
              ? [
                  {
                    id: EventId.make(`${threadId}:turn`),
                    type: "provider-turn.updated" as const,
                    threadId,
                    runId: run.id,
                    occurredAt: now,
                    payload: {
                      id: ProviderTurnId.make(`${threadId}:turn`),
                      providerThreadId: started.providerThreads[0]!.id,
                      nodeId: rootNode.id,
                      runAttemptId: run.activeAttemptId,
                      nativeTurnRef: null,
                      ordinal: 1,
                      status: "failed" as const,
                      startedAt: now,
                      completedAt: now,
                    },
                  },
                ]
              : []),
            {
              id: EventId.make(`${threadId}:failure`),
              type: "turn-item.updated",
              threadId,
              runId: run.id,
              nodeId: rootNode.id,
              occurredAt: now,
              payload: {
                id: failureId,
                type: "error",
                threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerThreadId: run.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: "Provider start failed",
                failure: {
                  class: "transport_error",
                  message:
                    "Claude timed out while registering its MCP tools after the computer slept.",
                  code: ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
                  retryable: true,
                },
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`${threadId}:attempt-failed`),
              type: "run-attempt.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...attempt, status: "failed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:node-failed`),
              type: "node.updated",
              threadId,
              runId: run.id,
              nodeId: rootNode.id,
              occurredAt: now,
              payload: { ...rootNode, status: "failed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:run-failed`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "failed", completedAt: now },
            },
          ],
        });
        const commandId = CommandId.make(`${threadId}:retry`);
        const retried = yield* orchestrator
          .dispatch({
            type: "prepared-run.retry",
            automatic: true,
            commandId,
            threadId,
            runId: run.id,
          })
          .pipe(Effect.match({ onSuccess: () => "retried", onFailure: (error) => error._tag }));
        assert.equal(retried, delivered ? "OrchestratorDispatchError" : "retried");
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          [after.runs[0]?.status, after.turnItems.find((row) => row.id === failureId)?.status],
          [status, item],
        );
        // The automatic retry waits for memory, then starts once the queue lets it go.
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        const admittedBy = yield* admitHeldRun(threadId, run.id, "retry");
        assert.deepEqual(
          (yield* outbox.listByCommandId(admittedBy)).map((effect) => effect.request.type),
          delivered ? [] : ["provider-turn.start"],
        );
      }),
  );

  it.effect("turns a restart's holds into the user's own when the resumed run fails", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("restart-resumed-run-fails");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Resumed run fails",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [index, text] of ["Active", "Queued"].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      yield* recovery.reconcile("startup");
      // The resume starts the cut run again, and its effect settles as the worker would.
      const [cut] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
      ];
      yield* continueRestartedRun({ threadId, sourceRunId: cut.id }).pipe(
        Effect.provide(ServerSettings.layerTest()),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE orchestration_v2_effect_outbox
        SET status = 'succeeded', completed_at = updated_at
        WHERE effect_id = ${`effect:restart-continuation:${cut.id}`}
      `;
      const [active, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      assert.equal(active.status, "starting");
      assert.isTrue(queued.queueHeldByRestart);
      const adopted = yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === queued.id &&
              stored.event.payload.queueHeld === true &&
              stored.event.payload.queueHeldByRestart === undefined,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:failed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "failed", startedAt: now, completedAt: now },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* Fiber.join(adopted)));
    }),
  );

  it.effect.each([false, true])(
    "starts a provider wake queued beside a held queue (continuation on: %s)",
    (continues) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const events = yield* EventSink.EventSinkV2;
        const settings = yield* ServerSettings.ServerSettingsService;
        const previous = (yield* settings.getSettings).continueThreadsAfterServerUpdate;
        yield* Effect.acquireRelease(
          settings.updateSettings({ continueThreadsAfterServerUpdate: continues }),
          () =>
            settings
              .updateSettings({ continueThreadsAfterServerUpdate: previous })
              .pipe(Effect.orDie),
        );
        const threadId = ThreadId.make(`queue-hold-provider-wake-${continues}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Wake beside a held queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        const send = (index: number, text: string, source: "web" | "provider" | "server" = "web") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: source === "web" ? "user" : "agent",
            creationSource: source,
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        yield* send(0, "Active");
        yield* send(1, "Queued before the restart");
        yield* recovery.reconcile("startup");
        yield* send(2, "First background task completed.", "provider");
        yield* send(3, "Background task completed.", "provider");
        yield* send(4, "Continue after the command completed.", "server");
        const queued = yield* orchestrator.getThreadProjection(threadId);
        const [held, active, wake] = [queued.runs[1]!, queued.runs[2]!, queued.runs[3]!];
        assert.equal(active.status, "starting");
        assert.isTrue(held.queueHeld);
        assert.equal(wake.status, "queued");
        assert.notEqual(wake.queueHeld, true);
        const textContinuation = queued.runs[4]!;
        assert.isTrue(textContinuation.queueHeld);
        const now = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make(`${threadId}:active-done`),
              type: "run.updated",
              threadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "completed", completedAt: now },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (continues) {
          // A restart's hold ends once the thread completes a run, so the queue resumes in order.
          assert.equal(after.runs.find((run) => run.id === held.id)?.status, "starting");
          assert.equal(after.runs.find((run) => run.id === wake.id)?.status, "queued");
        } else {
          assert.equal(after.runs.find((run) => run.id === wake.id)?.status, "starting");
          assert.deepEqual(
            after.runs.find((run) => run.id === held.id),
            held,
          );
        }
        // Nobody will resume a server message, so the completed run released it behind the wake.
        assert.deepEqual(
          after.runs.find((run) => run.id === textContinuation.id),
          { ...textContinuation, queueHeld: false },
        );
      }),
  );

  it.effect("starts a provider wake when a provider failure holds the queue", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("provider-failure-wake");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Wake after a provider failure",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const send = (index: number, text: string, wake = false) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Background command completed",
                },
              }
            : {}),
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      yield* send(0, "Active");
      yield* send(1, "Queued by the user");
      yield* send(2, "Background command completed.", true);
      const [active, queued, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      assert.isNotNull(active.rootNodeId);
      const settled = yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === wake.id &&
              (stored.event.payload.status !== "queued" || stored.event.payload.queueHeld === true),
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:error`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            nodeId: active.rootNodeId,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:error`),
              type: "error",
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId,
              providerThreadId: active.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Failed to authenticate. API Error: 403",
                code: null,
                retryable: null,
              },
            },
          },
          {
            id: EventId.make(`${threadId}:failed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "failed", startedAt: now, completedAt: now },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* Fiber.join(settled)));
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => [run.id, run.status, run.queueHeld ?? false]),
        [
          [active.id, "failed", false],
          [queued.id, "queued", true],
          [wake.id, "starting", false],
        ],
      );
    }),
  );

  it.effect("stops a provider wake whose provider is turned off for the project", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const threadId = ThreadId.make("provider-off-wake");
      const projectId = ProjectId.make(`${threadId}:project`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Wake on a provider turned off",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const send = (index: number, text: string, wake = false) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Background command completed",
                },
              }
            : {}),
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      yield* send(0, "Active");
      yield* send(1, "Queued by the user");
      yield* send(2, "Background command completed.", true);
      const queuedProjection = yield* orchestrator.getThreadProjection(threadId);
      const [active, queued, wake] = queuedProjection.runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      const providerThread = queuedProjection.providerThreads.find(
        (thread) => thread.id === wake.providerThreadId,
      );
      assert.isDefined(providerThread);
      const providerSessionId = ProviderSessionId.make(`${threadId}:session`);
      const detached = yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-session.detached" &&
              stored.event.payload.providerSessionId === providerSessionId,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* Effect.acquireRelease(
        settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
          },
        }),
        () =>
          settings
            .updateSettings({ projectSettingsOverrides: { [projectId]: null } })
            .pipe(Effect.orDie),
      );
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:session`),
            type: "provider-session.attached",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "ready",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`${threadId}:provider-thread`),
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...providerThread, providerSessionId },
          },
          {
            id: EventId.make(`${threadId}:completed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* Fiber.join(detached)));
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => [run.id, run.status, run.queueHeld ?? false]),
        [
          [active.id, "completed", false],
          [queued.id, "queued", true],
          [wake.id, "cancelled", false],
        ],
      );
      assert.notInclude(
        after.providerSessions.map((session) => session.id),
        providerSessionId,
      );
    }),
  );

  it.effect("starts a provider wake when the message ahead of it is on a provider turned off", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const settings = yield* ServerSettings.ServerSettingsService;
      const threadId = ThreadId.make("provider-off-head-wake");
      const projectId = ProjectId.make(`${threadId}:project`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId,
        title: "Wake behind a provider turned off",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const send = (index: number, text: string, selection: ModelSelection, wake = false) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: wake ? "agent" : "user",
          creationSource: wake ? "provider" : "web",
          ...(wake
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Background command completed",
                },
              }
            : {}),
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      yield* send(0, "Active", modelSelection);
      yield* send(1, "Queued by the user", { instanceId: alternateInstanceId, model: "gpt-5.5" });
      yield* send(2, "Background command completed.", modelSelection, true);
      const [active, queued, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
        OrchestrationV2Run,
        OrchestrationV2Run,
      ];
      const started = yield* eventSink
        .stream({ threadId, afterSequence: yield* orchestrator.getThreadEventSequence(threadId) })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === wake.id &&
              (stored.event.payload.status !== "queued" || stored.event.payload.queueHeld === true),
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* Effect.acquireRelease(
        settings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [alternateInstanceId]: { enabled: false } } },
          },
        }),
        () =>
          settings
            .updateSettings({ projectSettingsOverrides: { [projectId]: null } })
            .pipe(Effect.orDie),
      );
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:completed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* Fiber.join(started)));
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => [run.id, run.status, run.queueHeld ?? false]),
        [
          [active.id, "completed", false],
          [queued.id, "queued", true],
          [wake.id, "starting", false],
        ],
      );
    }),
  );

  it.effect.each([
    ["when its provider thread is idle on it", true, false, true],
    ["not while a turn runs on its provider thread", false, false, false],
    ["not after its provider thread moved to another session", true, true, false],
  ] as const)("detach-idle stops a session %s", ([name, runEnded, rebound, detaches]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`detach-idle:${name}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Detach an idle session",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message`),
        threadId,
        messageId: MessageId.make(`${threadId}:message`),
        text: "Work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const [run] = projection.runs as [OrchestrationV2Run];
      const providerThread = projection.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      );
      assert.isDefined(providerThread);
      const providerSessionId = ProviderSessionId.make(`${threadId}:session`);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:session`),
            type: "provider-session.attached",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: providerSessionId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              status: "ready",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make(`${threadId}:provider-thread`),
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...providerThread,
              providerSessionId: rebound
                ? ProviderSessionId.make(`${threadId}:newer-session`)
                : providerSessionId,
            },
          },
          ...(runEnded
            ? [
                {
                  id: EventId.make(`${threadId}:completed`),
                  type: "run.updated" as const,
                  threadId,
                  runId: run.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...run,
                    status: "completed" as const,
                    startedAt: now,
                    completedAt: now,
                  },
                },
              ]
            : []),
        ],
      });
      yield* orchestrator.dispatch({
        type: "provider-session.detach-idle",
        commandId: CommandId.make(`${threadId}:detach`),
        threadId,
        providerThreadId: providerThread.id,
        providerSessionId,
        reason: "Provider turned off for this project.",
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.strictEqual(
        after.providerSessions.some((session) => session.id === providerSessionId),
        !detaches,
      );
    }),
  );

  it.effect("starts a provider wake queued behind a run that fails, holding the rest", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("queue-hold-provider-wake-after-failure");
      const messageId = (key: string) => MessageId.make(`${threadId}:${key}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Wake behind a failed run",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message:active`),
        threadId,
        messageId: messageId("active"),
        text: "Active",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:message:queued`),
        threadId,
        messageId: messageId("queued"),
        text: "Queued by the user",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      // The CLI started this execution itself as the active turn ended.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "provider",
        commandId: CommandId.make(`${threadId}:message:wake`),
        threadId,
        messageId: messageId("wake"),
        text: "Background task completed.",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      const { runs } = yield* orchestrator.getThreadProjection(threadId);
      const runFor = (key: string) => runs.find((run) => run.userMessageId === messageId(key))!;
      const [active, wake, queued] = [runFor("active"), runFor("wake"), runFor("queued")];
      assert.equal(wake.status, "queued");
      assert.notEqual(wake.queueHeld, true);
      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      const firstUpdateOf = (runId: RunId) =>
        eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.filter(
            (stored) => stored.event.type === "run.updated" && stored.event.payload.id === runId,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
      const wakeUpdate = yield* firstUpdateOf(wake.id);
      const queuedUpdate = yield* firstUpdateOf(queued.id);
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}:active:error`),
            type: "turn-item.updated",
            threadId,
            runId: active.id,
            nodeId: active.rootNodeId!,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`${threadId}:active:error`),
              type: "error",
              threadId,
              runId: active.id,
              nodeId: active.rootNodeId,
              providerThreadId: active.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider request failed with HTTP 502",
                code: null,
                retryable: null,
              },
            },
          },
          {
            id: EventId.make(`${threadId}:active:failed`),
            type: "run.updated",
            threadId,
            runId: active.id,
            providerInstanceId: active.providerInstanceId,
            occurredAt: now,
            payload: { ...active, status: "failed", startedAt: now, completedAt: now },
          },
        ],
      });
      const queuedEvent = Option.getOrUndefined(yield* Fiber.join(queuedUpdate))?.event;
      assert.deepInclude(
        queuedEvent?.type === "run.updated" ? queuedEvent.payload : undefined,
        { status: "queued", queueHeld: true },
        "the user's queued message waits after the provider failure",
      );
      const wakeEvent = Option.getOrUndefined(yield* Fiber.join(wakeUpdate))?.event;
      const wakeRun = wakeEvent?.type === "run.updated" ? wakeEvent.payload : undefined;
      assert.notEqual(
        wakeRun?.queueHeld,
        true,
        "the provider wake replays output the CLI already produced, so the failure must not hold it",
      );
      assert.equal(wakeRun?.status, "starting");
    }),
  );

  it.effect("starts an edited queued run on the provider and model it was edited to", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("queued-edit-model");
      const claudeSelection = { instanceId: claudeInstanceId, model: "claude-test" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Queued model",
        modelSelection: claudeSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      // Both queued runs reserve rows on codex, which has no conversation on this thread yet.
      for (const [name, type, selection] of [
        ["active", "start_immediately", claudeSelection],
        ["edited", "queue_after_active", modelSelection],
        ["next", "queue_after_active", modelSelection],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:${name}`),
          threadId,
          messageId: MessageId.make(`${threadId}:${name}`),
          text: name,
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const [active, queued, next] = before.runs;
      const selection = {
        instanceId: alternateInstanceId,
        model: "changed-model",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "fastMode", value: true },
        ],
      };
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make(`${threadId}:edit`),
        threadId,
        runId: queued!.id,
        text: "Edited",
        modelSelection: selection,
      });
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${threadId}:completed`),
            type: "run.updated",
            threadId,
            runId: active!.id,
            occurredAt: now,
            payload: { ...active!, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      const started = after.runs.find((run) => run.id === queued!.id)!;
      const instanceOf = (providerThreadId: string | null | undefined) =>
        after.providerThreads.find((row) => row.id === providerThreadId)?.providerInstanceId;
      assert.equal(started.status, "starting");
      assert.deepEqual(started.modelSelection, selection);
      assert.equal(started.providerInstanceId, alternateInstanceId);
      assert.equal(instanceOf(started.providerThreadId), alternateInstanceId);
      assert.equal(
        after.attempts.find((row) => row.id === started.activeAttemptId)?.providerInstanceId,
        alternateInstanceId,
      );
      assert.equal(
        instanceOf(after.runs.find((run) => run.id === next!.id)?.providerThreadId),
        modelSelection.instanceId,
      );
    }),
  );

  it.effect("edits and removes queued runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-layer-queued-edit-thread");
      const attachment = (name: string) =>
        ({
          type: "image",
          id: `runtime-layer-queued-edit-${name}`,
          name: `${name}.png`,
          mimeType: "image/png",
          sizeBytes: 128,
        }) as const;
      const kept = attachment("kept");
      const shared = attachment("shared");
      const dropped = attachment("dropped");
      const effectRequests = (commandId: string) =>
        Effect.map(outbox.listByCommandId(CommandId.make(commandId)), (effects) =>
          effects.map((effect) => effect.request),
        );

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queued-edit-project"),
        title: "Edit queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queued-edit",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-active-message"),
        text: "Keep the provider occupied.",
        attachments: [shared],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-queued-message"),
        text: "Original queued text.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      const editedSelection = {
        ...modelSelection,
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "serviceTier", value: "priority" },
        ],
      };
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-edit"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text.",
        modelSelection: editedSelection,
      });

      const afterEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterEdit.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
        "Updated queued text.",
      );
      assert.deepEqual(
        afterEdit.runs.find((run) => run.id === queuedRun.id)?.modelSelection,
        editedSelection,
      );
      assert.deepEqual(afterEdit.thread.modelSelection, before.thread.modelSelection);
      const editedItem = afterEdit.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === queuedRun.userMessageId,
      );
      assert.isUndefined(editedItem, "editing queue state must not create a timeline turn item");

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-attachments"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text with an attachment.",
        attachments: [kept, shared, dropped],
      });
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-drop-attachments"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text with an attachment.",
        attachments: [kept],
      });
      const afterAttachmentEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterAttachmentEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        [kept.id],
      );
      assert.deepEqual(
        yield* effectRequests("runtime-layer-queued-edit-drop-attachments"),
        [
          {
            type: "attachment.cleanup",
            attachmentIds: [shared.id, dropped.id],
            skipReferenced: true,
          },
        ],
        "dropped files are queued for a cleanup that skips files the thread still references",
      );

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-text-only"),
        threadId,
        runId: queuedRun.id,
        text: "Text-only edit keeps attachments.",
      });
      const afterTextOnlyEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterTextOnlyEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        [kept.id],
        "an edit without attachments must leave the stored attachments untouched",
      );
      assert.deepEqual(yield* effectRequests("runtime-layer-queued-edit-text-only"), []);
      assert.deepEqual(
        afterTextOnlyEdit.runs.find((run) => run.id === queuedRun.id)?.modelSelection,
        editedSelection,
      );

      const emptyEditError = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("runtime-layer-queued-edit-empty"),
          threadId,
          runId: queuedRun.id,
          text: "   ",
        })
        .pipe(Effect.flip);
      assert.equal(emptyEditError._tag, "OrchestratorCommandRejectedError");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-queued-edit-cancel"),
        threadId,
        runId: queuedRun.id,
      });

      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterCancel.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        afterCancel.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(
        afterCancel.nodes.find((node) => node.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.isFalse(
        afterCancel.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.runId === queuedRun.id,
        ),
        "removed queued message must not surface as a transcript row",
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const cancelAgainError = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("runtime-layer-queued-edit-cancel-again"),
          threadId,
          runId: queuedRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(cancelAgainError._tag, "OrchestratorDispatchError");
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce());
    }),
  );

  it.effect("cancels a named queued run and leaves the active one running", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-queued-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-queued-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-queued-interrupt-project-create"),
        projectId,
        title: "Queued interrupt project",
        workspaceRoot: "/tmp/runtime-layer-queued-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-interrupt-create"),
        threadId,
        projectId,
        title: "Queued interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      for (const [key, dispatchMode] of [
        ["active", { type: "start_immediately" }],
        ["queued", { type: "queue_after_active" }],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-queued-interrupt-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-queued-interrupt-${key}`),
          text: key,
          attachments: [],
          modelSelection,
          dispatchMode,
        });
      }
      const [active, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.equal(queued?.status, "queued");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-queued-interrupt-command"),
        threadId,
        runId: queued!.id,
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        [active!.status, "cancelled"],
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("run output after a stop", (it) => {
  it.effect("takes a result a completed turn still owes from the turn after it", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-owed-output-project");
      const threadId = ThreadId.make("runtime-layer-owed-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-owed-output-project-create"),
        projectId,
        title: "Owed output project",
        workspaceRoot: "/tmp/runtime-layer-owed-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-owed-output-create"),
        threadId,
        projectId,
        title: "Owed output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const send = (
        key: string,
        outputSchema?: { readonly type: "object" },
        freshContext?: boolean,
      ) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-owed-output-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-owed-output-${key}`),
          text: key,
          attachments: [],
          modelSelection,
          ...(outputSchema === undefined ? {} : { outputSchema }),
          ...(freshContext === undefined ? {} : { freshContext }),
          dispatchMode: { type: "start_immediately" },
        });
      const runOf = Effect.fn(function* (key: string) {
        const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
        return runs.find(
          (run) => run.userMessageId === MessageId.make(`runtime-layer-owed-output-${key}`),
        )!;
      });
      // The agent ends its turn, to wait for something or because it is done.
      const complete = Effect.fn(function* (key: string) {
        const run = yield* runOf(key);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}-${key}-completed`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: run.requestedAt,
              payload: { ...run, status: "completed", completedAt: run.requestedAt },
            },
          ],
        });
      });
      const submit = (key: string, json = '{"head":"abc"}') =>
        threadManagement.submitRunOutput({
          threadId,
          commandId: CommandId.make(`runtime-layer-owed-output-submit-${key}`),
          json,
        });
      const refused = Effect.fn(function* (key: string) {
        const rejected = yield* submit(key).pipe(Effect.flip);
        assert.include(rejected.message, "not asked for a result");
      });
      yield* send("asked", { type: "object" });
      const asked = yield* runOf("asked");
      yield* complete("asked");
      yield* send("woken");

      const accepted = yield* submit("asked");
      assert.equal(accepted.runId, asked.id);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.runs.find((run) => run.id === asked.id)?.output?.value, {
        head: "abc",
      });

      // Its reply was lost, and the retry comes once the next step's turn asked for a result.
      yield* complete("woken");
      yield* send("next", { type: "object" });
      assert.equal((yield* submit("asked")).runId, asked.id);
      assert.isUndefined((yield* runOf("next")).output);

      // A correction gave the result `next` owed, so a later plain turn owes nothing.
      yield* complete("next");
      yield* send("correction", { type: "object" });
      yield* submit("correction");
      yield* complete("correction");
      yield* send("plain");
      yield* refused("plain");

      // A turn in a fresh conversation cannot answer for one the agent no longer sees.
      yield* complete("plain");
      yield* send("before-fresh", { type: "object" });
      yield* complete("before-fresh");
      yield* send("fresh", undefined, true);
      yield* refused("fresh");
    }),
  );

  it.effect("turns down a provider command asked for a result", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-command-output-project");
      const threadId = ThreadId.make("runtime-layer-command-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-command-output-project-create"),
        projectId,
        title: "Command output project",
        workspaceRoot: "/tmp/runtime-layer-command-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-command-output-create"),
        threadId,
        projectId,
        title: "Command output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const rejected = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-command-output-message"),
          threadId,
          messageId: MessageId.make("runtime-layer-command-output-message"),
          text: "/goal Review the changes",
          attachments: [],
          modelSelection,
          outputSchema: { type: "object" },
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.flip);
      assert.include(String(rejected.cause), "cannot be asked for a result");
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, []);

      // Nor can a queued request for a result be edited into one.
      for (const [key, text, dispatchMode] of [
        ["active", "Start", { type: "start_immediately" }],
        ["queued", "Return a verdict.", { type: "queue_after_active" }],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-command-output-${key}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-command-output-${key}`),
          text,
          attachments: [],
          modelSelection,
          ...(key === "queued" ? { outputSchema: { type: "object" } } : {}),
          dispatchMode,
        });
      }
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      )!;
      const edit = (key: string, text: string) =>
        orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`runtime-layer-command-output-edit-${key}`),
          threadId,
          runId: queued.id,
          text,
        });
      const refused = yield* edit("goal", "/goal Review the changes").pipe(Effect.flip);
      assert.include(String(refused.cause), "cannot be asked for a result");
      yield* edit("prompt", "Return a verdict, briefly.");
    }),
  );

  it.effect("turns down a result submitted after a stop was requested", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-stopped-output-project");
      const threadId = ThreadId.make("runtime-layer-stopped-output-thread");
      yield* projects.create({
        commandId: CommandId.make("runtime-layer-stopped-output-project-create"),
        projectId,
        title: "Stopped output project",
        workspaceRoot: "/tmp/runtime-layer-stopped-output-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-stopped-output-create"),
        threadId,
        projectId,
        title: "Stopped output",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-stopped-output-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-stopped-output-message"),
        text: "Return a verdict.",
        attachments: [],
        modelSelection,
        outputSchema: { type: "object" },
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      // The stop is asked for while the provider has not settled it, so the run is still active.
      const at = run.requestedAt;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}-interrupt-request`),
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: at,
            payload: {
              id: TurnItemId.make(`${threadId}-interrupt-request`),
              type: "run_interrupt_request",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 90,
              status: "completed",
              title: "Interrupt requested",
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              message: "Stopped by user",
            },
          },
        ],
      });

      const rejected = yield* threadManagement
        .submitRunOutput({
          threadId,
          commandId: CommandId.make("runtime-layer-stopped-output-submit"),
          json: "{}",
        })
        .pipe(Effect.flip);
      assert.include(String((rejected as { cause?: unknown }).cause), "was stopped");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(after.runs[0]?.output);
    }),
  );
});

it.layer(layerTest)("snooze queued runs", (it) => {
  it.effect.each(["notification", "delegated-completion", "user", "limited-user"] as const)(
    "only user messages block snooze with a queued %s run, unless a usage limit holds them",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`snooze-queued:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-queued-project"),
          title: "Snooze with held queued work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-queued",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`active:${threadId}`),
          threadId,
          messageId: MessageId.make(`active:${threadId}`),
          text: "Active run",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        if (kind === "delegated-completion") {
          yield* eventSink.write({
            events: [
              delegatedCompletionUpdated({
                id: `completion:${threadId}`,
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: {
                    messageId: MessageId.make(`queued:${threadId}`),
                    generation: 1,
                    taskIds: [NodeId.make("snooze-queued-task")],
                  },
                },
              }),
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queued:${threadId}`),
          threadId,
          messageId: MessageId.make(`queued:${threadId}`),
          text: "Queued work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "user" || kind === "limited-user" ? "user" : "agent",
          creationSource: kind === "user" || kind === "limited-user" ? "web" : "server",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : kind === "delegated-completion"
              ? {
                  delegatedCompletion: {
                    parentRunId: activeRun.id,
                    generation: 1,
                    taskIds: [NodeId.make("snooze-queued-task")],
                  },
                }
              : {}),
        });
        if (kind === "limited-user") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`limited:${threadId}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`limited:${threadId}`),
                  type: "error",
                  threadId,
                  runId: activeRun.id,
                  nodeId: activeRun.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: "Usage limit reached",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  // A proxied provider can report no reset time.
                  failure: {
                    class: "usage_limit",
                    message: "Claude API rate limit reached. Try again later.",
                    code: "api_error_429",
                    retryable: true,
                    resetAt: null,
                  },
                },
              },
            ],
          });
        }
        const beforeRecovery = yield* orchestrator.getThreadProjection(threadId);
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`recovery:${threadId}`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: beforeRecovery.runs.map((run) => ({
            id: EventId.make(`recovery:${run.id}`),
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            occurredAt: now,
            payload:
              run.status === "queued"
                ? // A usage limit stops the queue from starting without marking it held.
                  kind === "limited-user"
                  ? run
                  : { ...run, queueHeld: true }
                : {
                    ...run,
                    status: kind === "limited-user" ? ("failed" as const) : ("cancelled" as const),
                    completedAt: now,
                  },
          })),
          effects: [],
        });
        const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(
          beforeSnooze.runs.some(
            (run) => run.status === "queued" && (kind === "limited-user" || run.queueHeld),
          ),
        );
        const snooze = orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        if (kind === "user") {
          const error = yield* snooze.pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.equal(error.cause, `Thread ${threadId} has a queued run and cannot be snoozed.`);
          assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
        } else {
          yield* snooze;
          const snoozed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(DateTime.formatIso(snoozed.thread.snoozedUntil!), snoozedUntil);
          assert.deepEqual(snoozed.runs, beforeSnooze.runs);
          yield* orchestrator.dispatch({
            type: "thread.unsnooze",
            commandId: CommandId.make(`unsnooze:${threadId}`),
            threadId,
            reason: "user",
          });
          const awake = yield* orchestrator.getThreadProjection(threadId);
          assert.isNull(awake.thread.snoozedUntil);
          assert.deepEqual(awake.runs, beforeSnooze.runs);
        }
      }),
  );

  it.effect.each(["notification", "scheduled-task", "user"] as const)(
    "a %s message on a snoozed thread keeps the snooze only when automatic",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`snooze-wake:${kind}`);
        const snoozedUntil = "2099-07-25T09:00:00.000Z";
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("snooze-wake-project"),
          title: "Snoozed long-running thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/snooze-wake",
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`snooze:${threadId}`),
          threadId,
          snoozedUntil,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`wake:${threadId}`),
          threadId,
          messageId: MessageId.make(`wake:${threadId}`),
          text: "Continue",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: kind === "notification" ? "agent" : "user",
          creationSource: kind === "notification" ? "provider" : "web",
          ...(kind === "notification"
            ? {
                notification: {
                  source: { kind: "background_task" as const },
                  outcome: "updated" as const,
                  summary: "Background activity updated",
                },
              }
            : {}),
          ...(kind === "scheduled-task"
            ? { scheduledTaskId: ScheduledTaskId.make(`scheduled-task:${threadId}`) }
            : {}),
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        if (kind === "user") {
          assert.isNull(thread.snoozedUntil);
        } else {
          assert.isNotNull(thread.snoozedUntil);
          assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
        }
      }),
  );
});

const SCRATCH_ROOT = "/tmp/runtime-layer-promotion-scratch";
const SCRATCH_PROJECT_ID = ProjectId.make("runtime-layer-promotion-scratch");
const layerScratchPromotionTest = ScratchThreadPromotion.layer.pipe(
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeedSome(SCRATCH_ROOT),
      isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH_PROJECT_ID),
      namedProjectsRoot: "/projects",
    }),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(layerProjectDeletionTest),
);

it.layer(layerScratchPromotionTest)("turning a No project thread into a project", (it) => {
  const setup = Effect.fn(function* (name: string) {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const folder = `${SCRATCH_ROOT}/2026-01-01-${name}`;
    if (Option.isNone(yield* projects.getById(SCRATCH_PROJECT_ID))) {
      yield* projects.create({
        commandId: CommandId.make("promotion-scratch-create"),
        projectId: SCRATCH_PROJECT_ID,
        title: "No project",
        workspaceRoot: SCRATCH_ROOT,
      });
    }
    const createThread = (suffix: string, worktreePath: string) =>
      orchestrator
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`promotion-${name}-${suffix}-create`),
          threadId: ThreadId.make(`promotion-${name}-${suffix}`),
          projectId: SCRATCH_PROJECT_ID,
          title: `${name} ${suffix}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath,
        })
        .pipe(Effect.as(ThreadId.make(`promotion-${name}-${suffix}`)));
    return { folder, createThread };
  });
  const shellOf = (threadId: ThreadId) =>
    Orchestrator.OrchestratorV2.pipe(
      Effect.flatMap((orchestrator) => orchestrator.getThreadShell(threadId)),
    );

  it.effect("moves every thread in the folder and its bound tasks into one project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const { folder, createThread } = yield* setup("moves");
      const threadId = yield* createThread("main", folder);
      const siblingId = yield* createThread("sibling", folder);
      const otherId = yield* createThread("other", `${SCRATCH_ROOT}/2026-01-01-elsewhere`);
      const { task } = yield* tasks.upsert(
        {
          id: ScheduledTaskId.make("promotion-moves-bound"),
          title: "Bound",
          prompt: "Check in",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: SCRATCH_PROJECT_ID,
          threadId: siblingId,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("promotion-moves-sibling-archive"),
        threadId: siblingId,
      });

      const { projectId } = yield* promotion.promote({ threadId });

      const project = yield* projects.getById(projectId);
      assert.equal(Option.getOrUndefined(project)?.workspaceRoot, folder);
      assert.equal(Option.getOrUndefined(project)?.title, "moves main");
      for (const id of [threadId, siblingId]) {
        const shell = yield* shellOf(id);
        assert.equal(shell?.projectId, projectId);
        assert.isNull(shell?.worktreePath);
      }
      assert.equal((yield* shellOf(otherId))?.projectId, SCRATCH_PROJECT_ID);
      const saved = (yield* tasks.list()).tasks.find((candidate) => candidate.id === task.id);
      assert.equal(saved?.projectId, projectId);
      assert.deepEqual(yield* promotion.promote({ threadId }), { projectId });
    }),
  );

  it.effect("changes nothing while a thread in the folder is busy", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("busy");
      const threadId = yield* createThread("idle", folder);
      const busyId = yield* createThread("delegate", folder);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-busy-message"),
        threadId: busyId,
        messageId: MessageId.make("promotion-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(error.message, '"busy delegate" is still working. Finish or stop it first.');
      assert.isTrue(Option.isNone(yield* projects.getByWorkspaceRoot(folder)));
      assert.equal((yield* shellOf(threadId))?.projectId, SCRATCH_PROJECT_ID);
    }),
  );

  it.effect("finishes a partial move from either thread", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { folder, createThread } = yield* setup("partial");
      const movedId = yield* createThread("moved", folder);
      const leftId = yield* createThread("left", folder);
      const earlier = yield* projects.create({
        commandId: CommandId.make("promotion-partial-project"),
        projectId: ProjectId.make("promotion-partial-project"),
        title: "Earlier",
        workspaceRoot: folder,
      });
      yield* orchestrator.dispatch({
        type: "thread.project.adopt-folder",
        commandId: CommandId.make("promotion-partial-adopt"),
        threadId: movedId,
        projectId: earlier.id,
      });

      assert.deepEqual(yield* promotion.promote({ threadId: movedId }), { projectId: earlier.id });
      assert.equal((yield* shellOf(leftId))?.projectId, earlier.id);
    }),
  );

  it.effect("refuses a thread outside No project", () =>
    Effect.gen(function* () {
      const promotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("promotion-regular-project");
      const threadId = ThreadId.make("promotion-regular-thread");
      yield* projects.create({
        commandId: CommandId.make("promotion-regular-project"),
        projectId,
        title: "Regular",
        workspaceRoot: "/tmp/runtime-layer-promotion-regular",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("promotion-regular-thread-create"),
        threadId,
        projectId,
        title: "Regular",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const error = yield* promotion.promote({ threadId }).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Only a No project thread with its own folder can become a project.",
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("snooze projection", (it) => {
  it.effect("carries snooze, settle and title state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      assert.isNotNull(firstSnoozedAt);

      // Restamp snoozedAt for identical wake times so previously waking failures do not keep the thread awake.
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.equal(
        DateTime.toEpochMillis(thread.snoozedAt!),
        DateTime.toEpochMillis(firstSnoozedAt!) + 1_000,
      );
      assert.deepEqual(thread.updatedAt, thread.snoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layer),
      );
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidate?.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-snoozed-thread-settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        titleSeed: "Woken thread",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
      assert.isNull(awakened.thread.settledOverride);
      assert.isNull(awakened.thread.settledAt);
      assert.equal(awakened.thread.title, "Woken thread");
      assert.equal(
        awakened.thread.titleRegeneration?.requestId,
        CommandId.make("runtime-layer-snoozed-message"),
      );
    }),
  );

  it.effect("moves a thread into a project rooted at its own folder", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const scratchProjectId = ProjectId.make("runtime-layer-adopt-scratch");
      const folderProjectId = ProjectId.make("runtime-layer-adopt-folder");
      const otherProjectId = ProjectId.make("runtime-layer-adopt-other");
      const folder = "/tmp/runtime-layer-adopt-scratch/2026-01-01-notes-a1b2c3d4";
      const createProject = (projectId: ProjectId, workspaceRoot: string) =>
        projects.create({
          commandId: CommandId.make(`${projectId}-create`),
          projectId,
          title: projectId,
          workspaceRoot,
        });
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}-create`),
          threadId,
          projectId: scratchProjectId,
          title: "Scratch work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: folder,
        });
      const adopt = (threadId: ThreadId, projectId: ProjectId, suffix: string) =>
        orchestrator.dispatch({
          type: "thread.project.adopt-folder",
          commandId: CommandId.make(`${threadId}-adopt-${suffix}`),
          threadId,
          projectId,
        });
      yield* createProject(scratchProjectId, "/tmp/runtime-layer-adopt-scratch");
      yield* createProject(folderProjectId, folder);
      yield* createProject(otherProjectId, "/tmp/runtime-layer-adopt-other");
      const idleThreadId = ThreadId.make("runtime-layer-adopt-idle");
      const busyThreadId = ThreadId.make("runtime-layer-adopt-busy");
      yield* createThread(idleThreadId);
      yield* createThread(busyThreadId);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-adopt-busy-message"),
        threadId: busyThreadId,
        messageId: MessageId.make("runtime-layer-adopt-busy-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const otherFolder = yield* adopt(idleThreadId, otherProjectId, "other").pipe(Effect.flip);
      assert.equal(
        otherFolder.cause,
        `Thread ${idleThreadId} does not work in /tmp/runtime-layer-adopt-other.`,
      );
      const missing = yield* adopt(idleThreadId, ProjectId.make("missing"), "missing").pipe(
        Effect.flip,
      );
      assert.equal(missing.cause, `Thread ${idleThreadId} cannot move to missing project missing.`);
      const busy = yield* adopt(busyThreadId, folderProjectId, "busy").pipe(Effect.flip);
      assert.equal(
        busy.cause,
        `Thread ${busyThreadId} still has work in progress. Finish or stop it first.`,
      );

      yield* adopt(idleThreadId, folderProjectId, "folder");
      const shell = yield* orchestrator.getShellSnapshot();
      const moved = shell.threads.find((thread) => thread.id === idleThreadId);
      assert.equal(moved?.projectId, folderProjectId);
      assert.isNull(moved?.worktreePath);
      const stayed = shell.threads.find((thread) => thread.id === busyThreadId);
      assert.equal(stayed?.projectId, scratchProjectId);
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("visited projection", (it) => {
  it.effect("carries the visited watermark through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-visited-project");
      const threadId = ThreadId.make("runtime-layer-visited-thread");
      const visitedAt = "2026-07-24T01:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-visited-project-create"),
        projectId,
        title: "Visited shell projection",
        workspaceRoot: "/tmp/runtime-layer-visited-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-visited-thread-create"),
        threadId,
        projectId,
        title: "Visited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const created = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(created.thread.lastVisitedAt);
      const createdUpdatedAt = created.thread.updatedAt;

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit"),
        threadId,
        visitedAt,
      });
      const visited = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(visited.thread.lastVisitedAt);
      assert.equal(DateTime.formatIso(visited.thread.lastVisitedAt!), visitedAt);
      assert.deepEqual(visited.thread.updatedAt, createdUpdatedAt);
      const sql = yield* SqlClient.SqlClient;
      const visitPayloadKeys = (commandId: string) =>
        sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events WHERE command_id = ${commandId}
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => Object.keys(JSON.parse(row.payload_json)).toSorted()),
          ),
        );
      // A visit stores read state, not a copy of the thread.
      for (const keys of yield* visitPayloadKeys("runtime-layer-visited-thread-visit")) {
        assert.includeMembers(["lastVisitedAt", "opens", "threadId"], keys);
      }

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-thread-visit-stale"),
        threadId,
        visitedAt: "2026-07-24T00:30:00.000Z",
      });
      const afterStaleVisit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(DateTime.formatIso(afterStaleVisit.thread.lastVisitedAt!), visitedAt);
      // A stale visit with no open changes nothing, so it stores nothing.
      assert.deepEqual(yield* visitPayloadKeys("runtime-layer-visited-thread-visit-stale"), []);

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread!.lastVisitedAt!), visitedAt);
      assert.deepEqual(thread!.updatedAt, createdUpdatedAt);

      const markUnread = yield* orchestrator
        .dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make("runtime-layer-visited-thread-mark-unread"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(markUnread, Orchestrator.OrchestratorDispatchError);

      yield* sql`INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        'item:visited:unreadable-history', ${threadId}, 1, 'dynamic_tool', 'completed',
        ${visitedAt}, '{broken'
      )`;
      const nextVisitedAt = "2026-07-24T02:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-visited-without-history"),
        threadId,
        visitedAt: nextVisitedAt,
      });
      const [watermark] = yield* sql<{ readonly visited_at: string; readonly updated_at: string }>`
        SELECT json_extract(payload_json, '$.lastVisitedAt') AS visited_at, updated_at
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      assert.equal(watermark!.visited_at, nextVisitedAt);
      assert.equal(watermark!.updated_at, DateTime.formatIso(createdUpdatedAt));
      const invalidVisit = yield* orchestrator
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("runtime-layer-visited-invalid-timestamp"),
          threadId,
          visitedAt: "invalid-timestamp",
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalidVisit, Orchestrator.OrchestratorDispatchError);
    }),
  );

  it.effect("marks unread before the user's last turn when an automatic compaction followed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-mark-unread-compacted");
      const turnCompletedAt = DateTime.makeUnsafe("2026-07-24T10:00:00.000Z");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Compacted thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const runs = [
        { text: "Continue", at: turnCompletedAt },
        {
          text: "/compact",
          idleCompaction: "beforeCacheExpires" as const,
          at: DateTime.makeUnsafe("2026-07-24T11:00:00.000Z"),
        },
      ];
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make(`${threadId}:seed`),
        events: runs.flatMap(({ at, ...message }, index) => {
          const runId = RunId.make(`${threadId}:run-${index}`);
          const messageId = MessageId.make(`${threadId}:message-${index}`);
          return [
            {
              id: EventId.make(`${messageId}:event`),
              type: "message.updated" as const,
              threadId,
              occurredAt: at,
              payload: {
                ...message,
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user" as const,
                attachments: [],
                streaming: false,
                createdBy: "user" as const,
                creationSource: "web" as const,
                createdAt: at,
                updatedAt: at,
              },
            },
            {
              id: EventId.make(`${runId}:event`),
              type: "run.created" as const,
              threadId,
              runId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: at,
              payload: {
                id: runId,
                threadId,
                ordinal: index + 1,
                providerInstanceId: modelSelection.instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed" as const,
                queuePosition: null,
                requestedAt: at,
                startedAt: at,
                completedAt: at,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ];
        }),
      });

      yield* orchestrator.dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`${threadId}:mark-unread`),
        threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.thread.lastVisitedAt,
        DateTime.subtract(turnCompletedAt, { milliseconds: 1 }),
      );
      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(shell!.latestRunCompletedAt, turnCompletedAt);
      assert.deepEqual(shell!.lastVisitedAt, projection.thread.lastVisitedAt);

      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make(`${threadId}:visit`),
        threadId,
        visitedAt: DateTime.formatIso(turnCompletedAt),
      });
      const revisited = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(revisited!.lastVisitedAt, turnCompletedAt);
    }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("thread opens", (it) => {
  it.effect(
    "counts opens on the server clock, merges quick reopens, and keeps picked queries",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-layer-opened-thread");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("runtime-layer-opened-thread-create"),
          threadId,
          projectId: ProjectId.make("runtime-layer-opened-project"),
          title: "Opened thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        let visits = 0;
        const visit = (input: { readonly opened?: boolean; readonly searchQuery?: string }) =>
          orchestrator.dispatch({
            type: "thread.visit",
            commandId: CommandId.make(`runtime-layer-opened-visit-${++visits}`),
            threadId,
            // A client clock far in the past must not move the open time.
            visitedAt: "2000-01-01T00:00:00.000Z",
            ...input,
          });
        const opens = Effect.map(
          orchestrator.getShellSnapshot(),
          (shell) => shell.threads.find((thread) => thread.id === threadId)?.opens ?? null,
        );
        const start = DateTime.toEpochMillis(yield* DateTime.now);

        yield* visit({ opened: true, searchQuery: "  Upl " });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [{ query: "upl", at: start }],
        });

        yield* TestClock.adjust("1 minute");
        yield* visit({ opened: true, searchQuery: "Uploadthing docs" });
        assert.deepEqual(yield* opens, {
          openedAt: start,
          score: 1,
          picks: [
            { query: "uploadthing docs", at: start + 60_000 },
            { query: "upl", at: start },
          ],
        });

        yield* TestClock.adjust("14 days");
        yield* visit({});
        yield* visit({ opened: true });
        const later = yield* opens;
        assert.closeTo(later!.score, 1 + 2 ** (-(14 * 24 * 60 + 1) / (14 * 24 * 60)), 1e-9);
        assert.equal(later!.openedAt, DateTime.toEpochMillis(yield* DateTime.now));
        // Opening without a query keeps each pick and its time.
        assert.deepEqual(later!.picks, [
          { query: "uploadthing docs", at: start + 60_000 },
          { query: "upl", at: start },
        ]);
      }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("PR link events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "pingdotgg/t3code" };
      const repositoryWebUrl = "https://github.com/pingdotgg/t3code/pull/2";
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/pingdotgg/t3code/pull/${number}`,
          source: "manual",
          ...(number === 2 ? { repositoryWebUrl } : {}),
        });
      }
      const watchedLink = {
        url: "https://github.com/pingdotgg/t3code/pull/3",
        repositoryWebUrl: "https://github.com/pingdotgg/t3code/pull/3",
        source: "manual" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-new"),
        threadId,
        ...key,
        number: 3,
        watching: true,
        link: watchedLink,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-existing"),
        threadId,
        ...key,
        number: 2,
        watching: true,
      });
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/pingdotgg/t3code/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.propertyVal(after?.pullRequests?.[1], "repositoryWebUrl", repositoryWebUrl);
      assert.deepInclude(after?.pullRequests?.[2], watchedLink);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectInput = {
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
      };

      const created = yield* projects.create(projectInput);
      const retried = yield* projects.create(projectInput);
      assert.deepEqual(retried, created);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.isTrue("aggregateKind" in projectEvent && projectEvent.aggregateId === projectId);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projects.getById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});

const RESUMABLE_STOPS = [
  "interrupted",
  "usage_limit",
  "transport_error",
  "authentication_failed",
] as const;

it.layer(layerTest)("usage-limit recovery", (it) => {
  it.effect.each(RESUMABLE_STOPS)(
    "manually resumes an %s run ahead of its queued message only once",
    (reason) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`manual-resume:${reason}`);
        const projectId = ProjectId.make(`manual-resume:project:${reason}`);
        const now = yield* DateTime.now;
        const createdAt = DateTime.formatIso(now);
        yield* seedProject({
          projectId,
          title: "Resume project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`manual-resume:create:${reason}`),
          threadId,
          projectId,
          title: "Interrupted thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:start:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:start:${reason}`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`manual-resume:queue:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:queue:${reason}`),
          text: "Follow up.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const [source, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
          OrchestrationV2Run,
        ];
        // Hold the queue like user Stop so the terminal worker cannot start it before explicit resume.
        yield* events.write({
          events: [
            {
              id: EventId.make(`manual-resume:hold:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, queueHeld: true },
            },
            {
              id: EventId.make(`manual-resume:stop:${reason}`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...source,
                status: reason === "interrupted" ? "interrupted" : "failed",
                completedAt: now,
              },
            },
          ],
        });
        let scheduledResume: ReturnType<typeof limitRecoveryCommand> = null;
        const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
        if (reason !== "interrupted") {
          yield* events.write({
            events: [
              {
                id: EventId.make(`manual-resume:error:${reason}`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`manual-resume:error:${reason}`),
                  type: "error",
                  threadId,
                  runId: source.id,
                  nodeId: source.rootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "failed",
                  title: reason === "usage_limit" ? "Usage limit reached" : "Provider error",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  failure: {
                    usage_limit: {
                      class: "usage_limit" as const,
                      message: "Plan limit reached.",
                      code: "usageLimitExceeded",
                      retryable: null,
                      resetAt,
                    },
                    transport_error: {
                      class: "transport_error" as const,
                      message:
                        "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
                      code: "api_error",
                      retryable: null,
                    },
                    authentication_failed: {
                      class: "provider_error" as const,
                      message: "Claude could not authenticate.",
                      code: AUTHENTICATION_FAILED_FAILURE_CODE,
                      retryable: null,
                    },
                  }[reason],
                },
              },
            ],
          });
        }
        if (reason === "usage_limit") {
          const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          yield* orchestrator.dispatch(
            limitRecoveryCommand(shell, true, DateTime.toEpochMillis(now))!,
          );
          const armed = (yield* orchestrator.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )!;
          scheduledResume = limitRecoveryCommand(armed, true, Date.parse(resetAt));
          assert.isNotNull(scheduledResume);
        }
        const resume = (suffix: string) => ({
          type: "message.dispatch" as const,
          commandId: CommandId.make(`manual-resume:${suffix}:${reason}`),
          threadId,
          messageId: MessageId.make(`manual-resume:${suffix}:${reason}`),
          manualContinuationOfRunId: source.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" as const },
          createdBy: "user" as const,
          creationSource: "web" as const,
        });
        yield* orchestrator.dispatch(resume("first"));
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(after.runs, 3);
        assert.equal(after.runs[1]?.status, "queued");
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(after.runs[2]?.manualContinuationOfRunId, source.id);
        const resumeMessage = after.messages.find(
          (message) => message.id === resume("first").messageId,
        );
        assert.equal(resumeMessage?.text, "");
        assert.equal(resumeMessage?.notification?.summary, "Resumed thread");
        assert.isFalse(
          after.turnItems.some(
            (item) => item.runId === after.runs[2]?.id && item.type === "user_message",
          ),
        );
        assert.equal(
          (yield* orchestrator.dispatch(resume("second")).pipe(Effect.exit))._tag,
          "Failure",
        );
        if (scheduledResume !== null) {
          yield* TestClock.adjust("1 minute");
          yield* orchestrator.dispatch(scheduledResume);
        }
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 3);
      }),
  );

  it.effect("does not continue a run whose workspace setup lost its connection", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("setup-offline");
      const projectId = ProjectId.make("setup-offline:project");
      const now = yield* DateTime.now;
      yield* seedProject({
        projectId,
        title: "Setup project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("setup-offline:create"),
        threadId,
        projectId,
        title: "Offline setup",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("setup-offline:start"),
        threadId,
        messageId: MessageId.make("setup-offline:start"),
        text: "Start work.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const [source] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
      ];
      yield* events.write({
        events: [
          {
            id: EventId.make("setup-offline:error"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("setup-offline:error"),
              type: "error",
              threadId,
              runId: source.id,
              nodeId: source.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Workspace preparation failed",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "transport_error",
                message: "Workspace preparation failed: Git could not reach the remote.",
                code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
                retryable: false,
              },
            },
          },
          {
            id: EventId.make("setup-offline:failed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...source, status: "failed", completedAt: now },
          },
        ],
      });
      // The agent never saw the message, so continuing would drop it; the setup is retried instead.
      const resumed = yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("setup-offline:resume"),
          threadId,
          messageId: MessageId.make("setup-offline:resume"),
          manualContinuationOfRunId: source.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.exit);
      assert.equal(resumed._tag, "Failure");
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
    }),
  );

  it.effect.each([
    "ordinary",
    "legacy-ordinary",
    "fresh",
    "superseded",
    "bound-superseded",
    "expired",
    "fixed-time",
    "shared-window",
    "fixed-fresh",
    "chain-expired",
    "legacy-chain-expired",
    "compacted-chain-expired",
    "manual-expired",
    "reset-expired",
    "restart-expired",
    "overlapped",
    "held-expired",
    "replay-held",
    "replay-agent",
    "replay-user",
    "replay-missed",
    "replay-missed-disabled",
    "replay-unrelated",
    "replay-lost-ack",
    "replay-missed-failed",
    "setup-expired",
  ] as const)("recovers only the current scheduled occurrence: %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`limit-failover:${scenario}`);
      const projectId = ProjectId.make(`limit-failover:project:${scenario}`);
      const now = yield* DateTime.now;
      yield* seedProject({
        projectId,
        title: "Failover project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(now),
      });
      const sql = yield* SqlClient.SqlClient;
      const taskId = ScheduledTaskId.make(`recovery-task:${scenario}`);
      const replay = scenario.startsWith("replay-");
      const scheduled = !replay && scenario !== "ordinary" && scenario !== "legacy-ordinary";
      const intervalMs = 60_000;
      const schedule = scenario.startsWith("fixed-")
        ? { type: "fixed_time", timeOfDay: "00:01" }
        : { type: "interval", everyMs: intervalMs };
      if (scheduled)
        yield* sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, next_run_at, last_run_at, last_run_status, run_count
        ) VALUES (
          ${taskId}, 'Inbox', 'Check inbox', 1, ${JSON.stringify(schedule)}, ${projectId},
          '{"type":"project"}', ${JSON.stringify(modelSelection)}, 'full-access', 'default',
          'user', 'web', ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)},
          ${DateTime.formatIso(DateTime.add(now, { milliseconds: scenario === "shared-window" ? 30_000 : intervalMs }))},
          ${DateTime.formatIso(now)}, 'succeeded', 1
        )
      `;
      if (scheduled)
        yield* sql`
        INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at, outcome, thread_id)
        VALUES (${`record:${scenario}`}, ${taskId}, 'scheduled',
          ${DateTime.formatIso(DateTime.subtract(now, { milliseconds: scenario === "shared-window" ? 30_000 : 0 }))},
          ${DateTime.formatIso(now)}, 'succeeded', ${threadId})
      `;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`limit-failover:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`limit-failover:start:${scenario}`),
        threadId,
        messageId: MessageId.make(`limit-failover:start:${scenario}`),
        ...(scheduled ? { scheduledTaskId: taskId } : {}),
        text: "Start work.",
        attachments: [],
        dispatchMode: { type: replay ? "start_immediately" : "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const [accepted] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
        OrchestrationV2Run,
      ];
      const { demandId: _owner, ...historical } = accepted;
      const source: OrchestrationV2Run = scenario === "legacy-ordinary" ? historical : accepted;
      // A newer run started while this one worked on, and the occurrence's window passed.
      if (scenario === "overlapped") {
        yield* sql`UPDATE scheduled_tasks SET last_run_at = ${DateTime.formatIso(DateTime.add(now, { minutes: 2 }))} WHERE task_id = ${taskId}`;
        yield* TestClock.adjust("5 minutes");
      }
      const stoppedAt = yield* DateTime.now;
      // The provider holds the turn until the reset instead of failing it.
      const held = scenario === "held-expired" || scenario === "replay-held";
      if (scenario === "replay-held") yield* attachRunningTurn(threadId, source);
      yield* events.write({
        events: [
          {
            id: EventId.make(`limit-failover:stop:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: stoppedAt,
            payload: held
              ? {
                  ...source,
                  status: "running",
                  activeAttemptId:
                    source.activeAttemptId ??
                    RunAttemptId.make(`limit-failover:attempt:${scenario}`),
                }
              : { ...source, status: "failed", completedAt: stoppedAt },
          },
          {
            id: EventId.make(`limit-failover:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`limit-failover:error:${scenario}`),
              type: "error",
              threadId,
              runId: source.id,
              nodeId: source.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: held ? "running" : "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: held ? null : now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt: DateTime.formatIso(DateTime.add(now, { days: held ? 2 : 1 })),
              },
            },
          },
        ],
      });
      const sweep = { now: stoppedAt, autoResume: false, snooze: false, waiting: true };
      const candidate = (yield* projections.getLimitRecoveryCandidates(sweep)).find(
        (row) => row.id === threadId,
      )!;
      const providers = [modelSelection.instanceId, alternateInstanceId].map(
        (instanceId): ServerProvider => ({
          instanceId,
          driver,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: DateTime.formatIso(now),
          models: [
            { slug: modelSelection.model, name: "GPT", isCustom: false, capabilities: null },
          ],
          slashCommands: [],
          skills: [],
        }),
      );
      const failover = limitFailoverCommand({
        mcpSignInsNeeded: new Map(),
        thread: candidate,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [alternateInstanceId]: { driver } },
        },
        providers,
        recordedLimits: yield* projections.getUsageLimitedProviderInstances(
          now,
          runLiftsScope(providers),
        ),
        nowMs: DateTime.toEpochMillis(stoppedAt),
      });
      assert.isNotNull(failover);
      if (replay) {
        const command = { ...failover!, commandId: CommandId.make(`${threadId}:dispatch`) };
        const recorder = makeDispatchRecorder(
          {
            source: source.id,
            heldAttempt: candidate.heldAttemptId,
            command,
            evidence: {
              reason: "selected",
              selected: evidenceKey(alternateInstanceId),
              candidates: [],
              omitted: 0,
            },
            nowMs: DateTime.toEpochMillis(now),
          },
          sql,
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.dispatch(command, recorder);
          yield* threads.dispatch(command, recorder);
        }).pipe(
          Effect.provide(
            ThreadManagementService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  CommandReceiptStore.layer,
                  Layer.mock(AccountRouting)({
                    route: (input) => Effect.succeed(input.selection),
                  }),
                  ServerSettings.layerTest({
                    providerInstances: { [alternateInstanceId]: { driver, enabled: true } },
                  }),
                ),
              ),
            ),
          ),
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs.find((row) => row.userMessageId === command.messageId)!;
        const attempt = projection.attempts.find((row) => row.id === run.activeAttemptId)!;
        const missed = scenario.startsWith("replay-missed");
        const lostAck = scenario === "replay-lost-ack";
        const failedTurn = scenario === "replay-missed-failed";
        if (!held) {
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          // The fixture supplies the running provider turn normally created by these start effects.
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-turn.start", "thread-title.generate"],
            reason: "Test provider already attached",
          });
          const { steerTurn, providerTurn } = yield* attachRunningTurn(threadId, run);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:change`),
            threadId,
            messageId: MessageId.make(`${threadId}:change`),
            createdBy: scenario === "replay-agent" ? "agent" : "user",
            creationSource: scenario === "replay-agent" ? "mcp" : "web",
            demandSourceRunId: run.id,
            dispatchMode: { type: "steer_active", targetRunId: run.id },
            text: "Do something else instead.",
            attachments: [],
          });
          const [delivery] = yield* outbox.listByCommandId(CommandId.make(`${threadId}:change`));
          assert(delivery?.request.type === "provider-turn.steer");
          const request = delivery.request;
          const endTurn = events.write({
            events: [
              {
                id: EventId.make(`${threadId}:turn-ended`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...providerTurn,
                  status: failedTurn ? "failed" : "completed",
                  completedAt: now,
                },
              },
              {
                id: EventId.make(`${threadId}:run-ended`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: failedTurn ? "failed" : "completed", completedAt: now },
              },
            ],
          });
          if (missed) yield* endTurn;
          if (lostAck)
            steerTurn.mockReturnValueOnce(
              endTurn.pipe(
                Effect.orDie,
                Effect.andThen(
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: providerTurn.providerThreadId,
                      providerTurnId: providerTurn.id,
                      cause: "acknowledgement lost",
                    }),
                  ),
                ),
              ),
            );
          if (missed || lostAck) {
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* settings.updateSettings({
              providerInstances: {
                [alternateInstanceId]: { driver, enabled: scenario !== "replay-missed-disabled" },
              },
            });
          }
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          assert.isTrue(yield* worker.runOnce());
          if (failedTurn) {
            yield* TestClock.adjust("1 second");
            assert.isTrue(yield* worker.runOnce());
          }
          const settled = (yield* outbox.listByCommandId(delivery.commandId))[0]!;
          assert.equal(settled.status, failedTurn ? "pending" : "succeeded");
          assert.equal(settled.attemptCount, failedTurn ? 2 : 1);
          if (missed) assert.isEmpty(steerTurn.mock.calls);
          else assert.equal(steerTurn.mock.calls[0]?.[0].message.messageId, request.messageId);
          if (missed || lostAck) {
            const afterFallback = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              afterFallback.runs.some((candidate) => candidate.userMessageId === request.messageId),
              !failedTurn && scenario !== "replay-missed-disabled",
            );
          }
          if (scenario === "replay-unrelated") {
            const otherTurn = ProviderTurnId.make(`${threadId}:older-turn`);
            yield* events.write({
              events: [
                {
                  id: EventId.make(`${threadId}:older-completed`),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    ...providerTurn,
                    id: otherTurn,
                    ordinal: providerTurn.ordinal + 1,
                    runAttemptId: source.activeAttemptId,
                    status: "completed",
                    completedAt: now,
                  },
                },
              ],
            });
            yield* outbox.enqueue([
              {
                ...delivery,
                id: `${delivery.id}:older-turn`,
                request: { ...request, providerTurnId: otherTurn },
                availableAt: now,
              },
            ]);
            assert.isTrue(yield* worker.runOnce());
            assert.deepEqual(
              yield* sql`SELECT provider_turn_id FROM usage_stop_missed_steers WHERE message_id = ${request.messageId}`,
              [{ provider_turn_id: otherTurn }],
            );
          }
        }
        yield* events.write({
          events: [
            {
              id: EventId.make(`${threadId}:completed`),
              type: "run-attempt.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                ...attempt,
                status: failedTurn ? "failed" : "completed",
                completedAt: now,
              },
            },
          ],
        });
        if (lostAck) {
          const [oldReplay] =
            yield* sql`SELECT classification FROM usage_stop_replay WHERE source_key = ${evidenceKey(source.id)}`;
          assert.equal(oldReplay?.classification, "recovered");
          assert.deepEqual(yield* sql`SELECT * FROM usage_stop_missed_steers`, []);
          const followUp = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (candidate) => candidate.userMessageId === MessageId.make(`${threadId}:change`),
          )!;
          yield* events.write({
            events: [
              {
                id: EventId.make(`${threadId}:follow-up-completed`),
                type: "run.updated",
                threadId,
                runId: followUp.id,
                occurredAt: now,
                payload: { ...followUp, status: "completed", completedAt: now },
              },
            ],
          });

          yield* orchestrator.dispatch({
            type: "thread.archive",
            threadId,
            commandId: CommandId.make(`${threadId}:archive`),
          });
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          yield* maintenance.pruneEventStore();
          const compacted = yield* maintenance.compactColdThreadHistory({
            idleBefore: DateTime.add(now, { days: 1 }),
          });
          assert.equal(compacted.threadCount, 1);
          yield* runMigrations({ toCodeShipMigrationInclusive: 38 });
          const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
            SELECT classification, COUNT(*) FROM usage_stop_replay GROUP BY classification`;
          assert.match(
            plan.map((row) => row.detail).join("\n"),
            /SEARCH steer USING (?:COVERING )?INDEX usage_stop_commanded_steer_idx \(<expr>=\? AND <expr>=\?\)/,
          );
        }
        assert.deepEqual(
          yield* sql`SELECT classification, decisions, attributable_lost_tokens
          FROM usage_stop_replay WHERE source_key = ${evidenceKey(source.id)}`,
          [
            {
              classification: failedTurn
                ? "failed_attempt"
                : held || missed
                  ? "recovered"
                  : "unknown",
              decisions: 1,
              attributable_lost_tokens: null,
            },
          ],
        );
        return;
      }
      if (scenario === "superseded" || scenario === "bound-superseded") {
        yield* TestClock.adjust("1 second");
        const newer = yield* DateTime.now;
        yield* sql`UPDATE scheduled_tasks SET last_run_at = ${DateTime.formatIso(newer)} WHERE task_id = ${taskId}`;
        const newerThreadId =
          scenario === "bound-superseded" ? threadId : ThreadId.make(`${threadId}:newer`);
        if (scenario !== "bound-superseded")
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${threadId}:newer:create`),
            threadId: newerThreadId,
            projectId,
            title: "Current inbox",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:newer:start`),
          messageId: MessageId.make(`${threadId}:newer:start`),
          threadId: newerThreadId,
          scheduledTaskId: taskId,
          text: "Check inbox",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      if (scenario === "bound-superseded") {
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        yield* events.write({
          events: [
            {
              id: EventId.make(`${threadId}:queued`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...queued, status: "queued", queueHeld: true },
            },
          ],
        });
      }
      let command = failover!;
      if (scenario.endsWith("chain-expired")) {
        // The source ends before the resumed run starts, so a compaction there reads past it.
        if (scenario === "compacted-chain-expired") yield* TestClock.adjust("1 second");
        yield* orchestrator.dispatch(command);
        const resumed = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const { automaticContinuationOfRunId: _automatic, ...legacy } = resumed;
        yield* events.write({
          events: [
            {
              id: EventId.make(`${threadId}:second-failure`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...(scenario === "legacy-chain-expired" ? legacy : resumed),
                status: "failed",
                completedAt: now,
              },
            },
            ...(scenario === "compacted-chain-expired"
              ? [
                  {
                    id: EventId.make(`${threadId}:compaction`),
                    type: "turn-item.updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: {
                      id: TurnItemId.make(`${threadId}:compaction`),
                      type: "compaction" as const,
                      driver: null,
                      threadId,
                      runId: resumed.id,
                      nodeId: resumed.rootNodeId,
                      providerThreadId: null,
                      providerTurnId: null,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 100,
                      status: "completed" as const,
                      title: null,
                      startedAt: now,
                      completedAt: now,
                      updatedAt: now,
                    },
                  },
                ]
              : []),
          ],
        });
        command = {
          ...command,
          commandId: CommandId.make(`${threadId}:second-recovery`),
          messageId: MessageId.make(`${threadId}:second-recovery`),
          automaticContinuationOfRunId: resumed.id,
          manualContinuationOfRunId: resumed.id,
        };
      }
      if (scenario.endsWith("expired") || scenario === "fixed-time")
        yield* TestClock.adjust("1 day");
      if (scenario === "shared-window") {
        // Another machine's watch can move the next check without extending this occurrence.
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${DateTime.formatIso(DateTime.add(now, { hours: 1 }))} WHERE task_id = ${taskId}`;
        yield* TestClock.adjust("30 seconds");
      }
      if (scenario === "manual-expired") {
        const { automaticContinuationOfRunId: _automatic, ...manual } = command;
        yield* orchestrator.dispatch(manual);
      } else if (scenario === "reset-expired") {
        const {
          automaticContinuationOfRunId: _automatic,
          manualContinuationOfRunId: _manual,
          ...reset
        } = command;
        yield* orchestrator.dispatch({ ...reset, usageLimitContinuationOfRunId: source.id });
      } else if (scenario === "restart-expired") {
        const {
          automaticContinuationOfRunId: _automatic,
          manualContinuationOfRunId: _manual,
          ...restart
        } = command;
        yield* orchestrator.dispatch({ ...restart, restartContinuationOfRunId: source.id });
      } else if (scenario === "setup-expired") {
        yield* orchestrator.dispatch({
          type: "prepared-run.retry",
          commandId: command.commandId,
          threadId,
          runId: source.id,
          automatic: true,
        });
      } else yield* orchestrator.dispatch(command);
      const after = yield* orchestrator.getThreadProjection(threadId);
      if (scenario === "bound-superseded") {
        assert.lengthOf(after.runs, 2);
        assert.equal(after.runs[0]?.status, "cancelled");
        assert.notEqual(after.thread.settledOverride, "settled");
        assert.notEqual(after.runs[1]?.queueHeld, true);
        assert.notEqual(after.runs[1]?.status, "cancelled");
        return;
      }
      const skipped = ![
        "ordinary",
        "legacy-ordinary",
        "fresh",
        "fixed-fresh",
        "manual-expired",
        "overlapped",
      ].includes(scenario);
      assert.equal(after.thread.settledOverride, skipped ? "settled" : null);
      if (skipped) {
        assert.lengthOf(after.runs, scenario.endsWith("chain-expired") ? 2 : 1);
        if (scenario === "superseded") {
          const newer = yield* orchestrator.getThreadProjection(ThreadId.make(`${threadId}:newer`));
          assert.lengthOf(newer.runs, 1);
          assert.equal(newer.runs[0]?.status, "starting");
          assert.isNull(newer.thread.settledOverride);
          assert.isTrue(
            after.turnItems.some(
              (item) =>
                item.type === "system_notice" &&
                item.message === "Skipped: a newer run of Inbox replaced this one.",
            ),
          );
        }
        assert.isTrue(
          after.turnItems.some(
            (item) => item.type === "system_notice" && item.message.startsWith("Skipped:"),
          ),
        );
        return;
      }
      if (scenario === "ordinary") assert.isString(source.demandId);
      if (scenario === "legacy-ordinary") assert.isUndefined(source.demandId);
      assert.deepEqual(
        after.runs.map((run) => [run.providerInstanceId, run.status, run.demandId]),
        [
          [modelSelection.instanceId, "failed", source.demandId],
          [alternateInstanceId, "starting", source.demandId ?? null],
        ],
      );
      assert.isUndefined(
        (yield* projections.getLimitRecoveryCandidates(sweep)).find((row) => row.id === threadId),
      );
    }).pipe(
      Effect.provide(
        scenario.startsWith("replay-")
          ? Layer.fresh(
              scenario === "replay-lost-ack" ? layerBeforeSteerTargetMigration : layerTest,
            )
          : Layer.empty,
      ),
    ),
  );

  it.effect.each(["still-current", "moved-on", "moved-on-then-lost-more"] as const)(
    "judges a restart continuation by when its background work first stopped, not when its turn ended: %s",
    (scenario) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make(`restart-note-stale:${scenario}`);
        const projectId = ProjectId.make(`restart-note-stale:project:${scenario}`);
        const taskId = ScheduledTaskId.make(`restart-note-stale:task:${scenario}`);
        const turnEndedAt = yield* DateTime.now;
        const newerStartedAt = DateTime.add(turnEndedAt, { minutes: 2 });
        const movedOn = scenario !== "still-current";
        const stoppedAt = DateTime.add(turnEndedAt, { minutes: movedOn ? 1 : 5 });
        const lostMoreAt = DateTime.add(turnEndedAt, { minutes: 4 });
        yield* seedProject({
          projectId,
          title: "Restart note project",
          workspaceRoot: process.cwd(),
          defaultModelSelection: modelSelection,
          createdAt: DateTime.formatIso(turnEndedAt),
        });
        yield* sql`
          INSERT INTO scheduled_tasks (
            task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
            model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
            created_at, updated_at, next_run_at, last_run_at, last_run_status, run_count
          ) VALUES (
            ${taskId}, 'Inbox', 'Check inbox', 1, '{"type":"interval","everyMs":3600000}', ${projectId},
            '{"type":"project"}', ${JSON.stringify(modelSelection)}, 'full-access', 'default',
            'user', 'web', ${DateTime.formatIso(turnEndedAt)}, ${DateTime.formatIso(turnEndedAt)},
            ${DateTime.formatIso(DateTime.add(turnEndedAt, { hours: 1 }))},
            ${DateTime.formatIso(newerStartedAt)}, 'succeeded', 2
          )
        `;
        yield* sql`
          INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at, outcome, thread_id)
          VALUES (${`record:${scenario}`}, ${taskId}, 'scheduled', ${DateTime.formatIso(turnEndedAt)},
            ${DateTime.formatIso(turnEndedAt)}, 'succeeded', ${threadId})
        `;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId,
          title: "Waiting on a command",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:start`),
          threadId,
          messageId: MessageId.make(`${threadId}:start`),
          scheduledTaskId: taskId,
          text: "Check inbox",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const [original] = (yield* orchestrator.getThreadProjection(threadId)).runs as [
          OrchestrationV2Run,
        ];
        const work = [{ kind: "task" as const, label: "sleep 5400", id: "shell-1" }];
        const notice = backgroundWorkStoppedNotice({
          run: original,
          cause: "server-restarted",
          work,
          stoppedAt,
          now: stoppedAt,
          ordinal: 5,
        });
        assert.isDefined(notice);
        yield* eventSink.commitCommand({
          commandId: CommandId.make(`${threadId}:reconcile`),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: stoppedAt,
          events: [
            {
              id: EventId.make(`${threadId}:run`),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: turnEndedAt,
              payload: {
                ...original,
                status: "completed",
                completedAt: turnEndedAt,
                restartCancelledBackgroundWork: work,
              },
            },
            {
              id: EventId.make(`${threadId}:notice`),
              type: "turn-item.updated",
              threadId,
              runId: original.id,
              occurredAt: stoppedAt,
              payload: notice,
            },
          ],
          effects: [],
        });
        if (scenario === "moved-on-then-lost-more") {
          // A later loss on the same run, after a newer run of the task started.
          const lostMore = lostBackgroundWorkRecord({
            run: { ...original, restartCancelledBackgroundWork: work },
            cause: "process-ended",
            work: [{ kind: "monitor", label: "tail -f build.log", id: "monitor-1" }],
            now: lostMoreAt,
          });
          assert.isDefined(lostMore.notice);
          yield* eventSink.commitCommand({
            commandId: CommandId.make(`${threadId}:lost-more`),
            threadId,
            commandType: "provider-runtime.reconcile",
            acceptedAt: lostMoreAt,
            events: [
              {
                id: EventId.make(`${threadId}:lost-more-run`),
                type: "run.background-work-cancelled",
                threadId,
                runId: original.id,
                occurredAt: lostMoreAt,
                payload: {
                  runId: original.id,
                  restartCancelledBackgroundWork: lostMore.restartCancelledBackgroundWork,
                },
              },
              {
                id: EventId.make(`${threadId}:lost-more-notice`),
                type: "turn-item.updated",
                threadId,
                runId: original.id,
                occurredAt: lostMoreAt,
                payload: lostMore.notice,
              },
            ],
            effects: [],
          });
        }
        yield* TestClock.adjust("5 minutes");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`${threadId}:continuation`),
          threadId,
          messageId: MessageId.make(`${threadId}:continuation`),
          text: "Note: the T3 server restarted.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          restartContinuationOfRunId: original.id,
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          after.turnItems.flatMap((item) =>
            item.type === "system_notice" && item.message.includes("stopped background work")
              ? [[item.title, item.startedAt && DateTime.formatIso(item.startedAt)]]
              : [],
          ),
          [
            ["Server restarted", DateTime.formatIso(stoppedAt)],
            ...(scenario === "moved-on-then-lost-more"
              ? [["Agent process ended", DateTime.formatIso(lostMoreAt)]]
              : []),
          ],
          "each loss keeps its own notice",
        );
        const skipped = movedOn;
        assert.equal(
          after.thread.settledOverride,
          skipped ? "settled" : null,
          "only a task that moved on while the chat was stopped skips the continuation",
        );
        assert.lengthOf(after.runs, skipped ? 1 : 2);
        assert.equal(
          after.turnItems.some(
            (item) => item.type === "system_notice" && item.message.startsWith("Skipped:"),
          ),
          skipped,
        );
      }),
  );

  it.effect.each([
    "resume",
    "resume-failover",
    "resume-started",
    "resume-untagged",
    "queued-resume",
    "rearm",
    "snooze-race",
    "archive",
    "replacement",
    "manual-snooze",
    "invalid-snooze",
    "settled",
    "cancel-resume-keep-snooze",
    "independent-patches",
    "expired-snooze",
    "wake",
    "stop",
    "stop-before-arm",
    "stop-before-arm-mismatched-recovery",
    "early-resume",
    "stop-before-limit",
    "user-snooze-before-arm",
    "hidden-continue",
    "person-snooze-until-reset",
  ] as const)("guards a scheduled usage-limit continuation against %s", (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`recovery:${scenario}`);
      const projectId = ProjectId.make(`recovery:project:${scenario}`);
      yield* seedProject({
        projectId,
        title: "Recovery project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: modelSelection,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`recovery:create:${scenario}`),
        threadId,
        projectId,
        title: "Limited thread",
        modelSelection:
          scenario === "resume-failover"
            ? { ...modelSelection, autoAccount: true }
            : modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:message:${scenario}`),
        threadId,
        messageId: MessageId.make(`recovery:message:${scenario}`),
        text: "Work on this.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      if (scenario === "queued-resume") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:queued:${scenario}`),
          threadId,
          messageId: MessageId.make(`recovery:queued:${scenario}`),
          text: "Run after recovery.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const now = yield* DateTime.now;
      const resetAt =
        scenario === "invalid-snooze"
          ? "not-a-date"
          : DateTime.formatIso(DateTime.add(now, { minutes: 1 })).replace(
              "Z",
              scenario === "wake" ? "+00:00" : "Z",
            );
      yield* events.write({
        commandId: CommandId.make(`recovery:failure:${scenario}`),
        events: [
          {
            id: EventId.make(`recovery:run:${scenario}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make(`recovery:error:${scenario}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`recovery:error:${scenario}`),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
          ...(scenario === "stop-before-limit"
            ? [
                {
                  id: EventId.make(`recovery:interrupt:${scenario}`),
                  type: "turn-item.updated" as const,
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: TurnItemId.make(`recovery:interrupt:${scenario}`),
                    type: "run_interrupt_request" as const,
                    threadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "completed" as const,
                    title: "Stop",
                    message: "Stopping",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ]
            : []),
        ],
      });
      if (scenario === "queued-resume") {
        const queuedRun = projection.runs[1]!;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:held:queued-resume"),
              type: "run.updated",
              threadId,
              runId: queuedRun.id,
              occurredAt: now,
              payload: { ...queuedRun, queueHeld: true },
            },
          ],
        });
        const resumeHeldQueue = yield* orchestrator
          .dispatch({
            type: "queue.resume",
            commandId: CommandId.make("recovery:resume-held:queued-resume"),
            threadId,
          })
          .pipe(Effect.exit);
        assert.equal(resumeHeldQueue._tag, "Failure");
        assert.isTrue((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.queueHeld);
      }
      const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.isNull(limitRecoveryCommand(shell, false, DateTime.toEpochMillis(now)));
      if (scenario === "invalid-snooze") {
        const result = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:invalid-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.limitRecovery ?? null);
        assert.isNull(current.thread.snoozedUntil);
        return;
      }
      if (scenario === "settled") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:arm-before-settle:settled"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true, snooze: true },
        });
        yield* orchestrator.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("recovery:settle:settled"),
          threadId,
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:arm:settled"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, autoResume: true },
          })
          .pipe(Effect.flip);
        assert(error._tag === "OrchestratorDispatchError");
        assert.equal(error.cause, "The thread is settled. Un-settle it to resume at the reset.");
        assert.deepInclude(
          (yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery,
          {
            runId: run.id,
            autoResume: false,
            snooze: false,
          },
        );
        return;
      }
      const userSnoozedUntil = DateTime.add(now, { hours: 2 });
      const hideRequested =
        scenario === "wake" ||
        scenario === "cancel-resume-keep-snooze" ||
        scenario === "user-snooze-before-arm" ||
        scenario === "hidden-continue";
      // Hiding the stop until its reset leaves a snooze the user set alone.
      const snooze = hideRequested && scenario !== "user-snooze-before-arm";
      const autoResume = scenario !== "wake";
      const arm = limitRecoveryCommand(
        shell,
        autoResume,
        DateTime.toEpochMillis(now),
        hideRequested,
      );
      assert(arm?.type === "thread.limit-recovery.arm" && arm.limitRecovery != null);
      const automaticArm = {
        commandId: arm.commandId,
        threadId,
        limitRecovery: arm.limitRecovery,
      };
      // What account switching and reset credits send once another account or a credit has room.
      const continueAutomatically = (attempt: string) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`recovery:automatic:${attempt}:${scenario}`),
          messageId: MessageId.make(`recovery:automatic:${attempt}:${scenario}`),
          threadId,
          automaticContinuationOfRunId: run.id,
          manualContinuationOfRunId: run.id,
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
        });
      if (scenario === "stop-before-limit") {
        // Nothing recorded the Stop on the thread yet; the run's own Stop marker refuses it.
        assert.equal(
          (yield* continueAutomatically("before-arm").pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* orchestrator.autoArmLimitRecovery(automaticArm);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery, {
          runId: run.id,
          resetAt,
          autoResume: false,
          snooze: false,
          requestId: arm.commandId,
        });
        return;
      }
      if (scenario === "user-snooze-before-arm") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:user-snooze:${scenario}`),
          threadId,
          snoozedUntil: DateTime.formatIso(userSnoozedUntil),
        });
      }
      const stopBeforeArm =
        scenario === "stop-before-arm" || scenario === "stop-before-arm-mismatched-recovery";
      if (stopBeforeArm) {
        if (scenario === "stop-before-arm-mismatched-recovery") {
          const current = yield* orchestrator.getThreadProjection(threadId);
          yield* events.write({
            events: [
              {
                id: EventId.make(`recovery:older-window:${scenario}`),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...current.thread,
                  limitRecovery: {
                    runId: run.id,
                    resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 2 })),
                    autoResume: true,
                    snooze: false,
                  },
                },
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates({
            now,
            autoResume: true,
            snooze: false,
          })).find((row) => row.id === threadId),
        );
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isNull(limitRecoveryCommand(stoppedShell, true, DateTime.toEpochMillis(now)));
        yield* orchestrator.autoArmLimitRecovery(automaticArm);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.limitRecovery, {
          runId: run.id,
          resetAt,
          autoResume: false,
          snooze: false,
          requestId: CommandId.make(`recovery:stop:${scenario}`),
        });
      }
      // After a Stop, only the person's choice arms the stop again.
      const armCommand = stopBeforeArm
        ? {
            type: "thread.metadata.update" as const,
            commandId: CommandId.make(`recovery:explicit-rearm:${scenario}`),
            threadId,
            limitRecovery: arm.limitRecovery,
          }
        : arm;
      if (stopBeforeArm) yield* orchestrator.dispatch(armCommand);
      else yield* orchestrator.autoArmLimitRecovery(automaticArm);
      let armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      )!;
      assert.deepEqual(armedShell.limitRecovery, {
        runId: run.id,
        resetAt,
        autoResume,
        // Settings left auto-resume off; nobody chose it.
        ...(autoResume ? {} : { autoResumeUnset: true }),
        snooze,
        // Only the settings' hide, which another account or a reset credit may still end sooner.
        ...(snooze ? { snoozeBySettings: true } : {}),
        requestId: armCommand.commandId,
      });
      if (snooze)
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
      if (scenario === "user-snooze-before-arm")
        assert.equal(
          DateTime.toEpochMillis(armedShell.snoozedUntil!),
          DateTime.toEpochMillis(userSnoozedUntil),
        );
      if (scenario === "hidden-continue") {
        // The settings' hide lets another account or a reset credit continue it before the reset.
        yield* continueAutomatically("hidden");
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
        return;
      }
      if (scenario === "person-snooze-until-reset") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:person-snooze:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        const snoozed = (yield* orchestrator.getThreadProjection(threadId)).thread;
        assert.isTrue(snoozed.limitRecovery!.snooze);
        assert.isUndefined(snoozed.limitRecovery!.snoozeBySettings);
        const refused = yield* continueAutomatically("snoozed").pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorContinuationSnoozedError");
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:person-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        // The refusal was not recorded, so the same continuation goes through once it wakes.
        yield* continueAutomatically("snoozed");
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
        return;
      }
      if (scenario === "cancel-resume-keep-snooze") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:independent-choice:${scenario}`),
          threadId,
          limitRecovery: {
            runId: run.id,
            resetAt,
            autoResume: false,
            snooze: true,
          },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.equal(DateTime.toEpochMillis(armedShell.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(armedShell.snoozedAt!),
          DateTime.toEpochMillis(armedShell.updatedAt),
        );
        assert.isFalse(armedShell.limitRecovery!.autoResume);
        // Choosing the snooze makes it the person's, so it holds the thread until it wakes.
        assert.isUndefined(armedShell.limitRecovery!.snoozeBySettings);
      }
      if (scenario === "independent-patches") {
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-snooze"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: true },
        });
        let current = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        yield* TestClock.adjust("10 seconds");
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-cancel-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
        current = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(current.thread.limitRecovery!.autoResume);
        assert.isTrue(current.thread.limitRecovery!.snooze);
        assert.equal(DateTime.toEpochMillis(current.thread.snoozedUntil!), Date.parse(resetAt));
        assert.equal(
          DateTime.toEpochMillis(current.thread.snoozedAt!),
          DateTime.toEpochMillis(current.thread.updatedAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:patch-resume"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        armedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.isTrue(armedShell.limitRecovery!.autoResume);
        assert.isTrue(armedShell.limitRecovery!.snooze);
      }
      if (scenario === "manual-snooze") {
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`recovery:manual-snooze:${scenario}`),
          threadId,
          snoozedUntil: resetAt,
        });
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:manual-cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false, snooze: false },
        });
        assert.equal(
          DateTime.toEpochMillis(
            (yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil!,
          ),
          Date.parse(resetAt),
        );
        yield* orchestrator.dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(`recovery:manual-wake:${scenario}`),
          threadId,
          reason: "user",
        });
        assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedUntil);
      }
      if (scenario === "wake") {
        // Clients wake a hidden stop by turning its snooze off, which chooses nothing about auto-resume.
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:wake:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, snooze: false },
        });
        let woken = (yield* orchestrator.getThreadProjection(threadId)).thread;
        assert.isNull(woken.snoozedUntil);
        assert.isTrue(woken.limitRecovery!.autoResumeUnset);
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop-after-wake:${scenario}`),
          threadId,
        });
        woken = (yield* orchestrator.getThreadProjection(threadId)).thread;
        // The Stop is recorded even though the arm had already left auto-resume off.
        assert.deepEqual(woken.limitRecovery, {
          runId: run.id,
          resetAt,
          autoResume: false,
          snooze: false,
          requestId: CommandId.make(`recovery:stop-after-wake:${scenario}`),
        });
        assert.equal(
          (yield* continueAutomatically("after-stop").pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      }
      assert.isNull(limitRecoveryCommand(armedShell, true, DateTime.toEpochMillis(now)));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`recovery:early:${scenario}`),
        messageId: MessageId.make(`recovery:early:${scenario}`),
        threadId,
        usageLimitContinuationOfRunId: run.id,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).runs,
        scenario === "queued-resume" ? 2 : 1,
      );
      if (scenario === "early-resume") {
        // Before the reset, a resume runs on the target the recovery worker found room on, even
        // where it stopped once that hold lifted, and only once for the stopped run.
        const early = (selection: ModelSelection) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`recovery:early:${selection.model}`),
            messageId: MessageId.make(`recovery:early:${selection.model}`),
            threadId,
            modelSelection: selection,
            usageLimitContinuationOfRunId: run.id,
            usageLimitRecoveryRequestId: armCommand.commandId,
            text: "Continue where you left off.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "server",
          });
        yield* early(modelSelection);
        yield* early({ ...modelSelection, model: "gpt-5.4-mini" });
        // Chat Doctor's resume names the run it saw stop (t3_thread_send's continuationOfRunId).
        const threadManagement = yield* ThreadManagementService.ThreadManagementService;
        const doctor = yield* threadManagement
          .sendToThread({
            projectId,
            commandId: CommandId.make("recovery:doctor"),
            threadId,
            messageId: MessageId.make("recovery:doctor"),
            text: "Continue where you left off.",
            attachments: [],
            mode: "auto",
            manualContinuationOfRunId: run.id,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.flip);
        assert.include(
          userFacingDispatchErrorMessage(doctor),
          "can no longer be resumed from that run",
        );
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(resumed.runs, 2);
        assert.equal(resumed.runs[1]?.modelSelection.model, modelSelection.model);
        assert.isFalse(resumed.messages.some((message) => message.id === "recovery:doctor"));
        return;
      }
      yield* TestClock.adjust("1 minute");
      const resume = limitRecoveryCommand(
        armedShell,
        true,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
      // The user's snooze holds the resume until it ends.
      if (
        autoResume &&
        scenario !== "cancel-resume-keep-snooze" &&
        scenario !== "user-snooze-before-arm"
      )
        assert.isNotNull(resume);
      else assert.isNull(resume);
      if (scenario === "snooze-race") {
        const wakeAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* orchestrator.dispatch({
          type: "thread.snooze",
          commandId: CommandId.make("recovery:raced-snooze"),
          threadId,
          snoozedUntil: wakeAt,
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        yield* TestClock.adjust("1 minute");
        const current = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          current,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "expired-snooze") {
        const staleSnooze = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("recovery:expired-snooze"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, snooze: true },
          })
          .pipe(Effect.exit);
        assert.equal(staleSnooze._tag, "Failure");
        const current = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(current.thread.snoozedUntil);
        assert.isFalse(current.thread.limitRecovery!.snooze);
        assert.isTrue(current.thread.limitRecovery!.autoResume);
      }

      if (scenario === "rearm")
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:cancel:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: false },
        });
      if (scenario === "archive")
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`recovery:archive:${scenario}`),
          threadId,
        });
      if (scenario === "stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`recovery:stop:${scenario}`),
          threadId,
        });
        const stoppedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        assert.deepInclude(stoppedShell.limitRecovery, { runId: run.id, autoResume: false });
      }
      if (scenario === "replacement") {
        const current = yield* orchestrator.getThreadProjection(threadId);
        const error = current.turnItems.find((item) => item.type === "error")!;
        if (error.type !== "error") throw new Error("Expected provider error");
        yield* events.write({
          commandId: CommandId.make(`recovery:replacement:${scenario}`),
          events: [
            {
              id: EventId.make(`recovery:replacement:${scenario}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...error,
                failure: {
                  ...error.failure,
                  class: "provider_error",
                  message: "A replacement failure.",
                },
              },
            },
          ],
        });
      }
      if (scenario === "rearm") {
        yield* orchestrator.dispatch(resume!);
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`recovery:rearm:${scenario}`),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        yield* orchestrator.dispatch(resume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
        const rearmedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const freshResume = limitRecoveryCommand(
          rearmedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert.isNotNull(freshResume);
        assert.notEqual(freshResume!.commandId, resume!.commandId);
        yield* orchestrator.dispatch(freshResume!);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      if (scenario === "resume-failover" && resume?.type === "message.dispatch") {
        assert.isUndefined(resume.modelSelection);
        const sql = yield* SqlClient.SqlClient;
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        for (const enabled of [false, true]) {
          const instances = [
            modelSelection.instanceId,
            alternateInstanceId,
            ...(enabled ? [ProviderInstanceId.make("third")] : []),
          ];
          const providers = instances.map((instanceId): ServerProvider => ({
            instanceId,
            driver,
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: DateTime.formatIso(now),
            models: [
              { slug: modelSelection.model, name: "GPT", isCustom: false, capabilities: null },
            ],
            slashCommands: [],
            skills: [],
          }));
          const settings = {
            ...DEFAULT_SERVER_SETTINGS,
            failoverLimitedThreads: true,
            autoModeProvider: driver,
            autoModeModels: { codex: { model: modelSelection.model } },
            providerInstances: Object.fromEntries(instances.map((id) => [id, { driver }])),
            providerInstanceFailoverOrder: [alternateInstanceId],
          };
          const dispatchLayer = ThreadManagementService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                CommandReceiptStore.layer,
                Layer.mock(AccountRouting)({
                  route: (input) =>
                    Effect.succeed(
                      routeAutoAccount({
                        ...input,
                        settings,
                        providers,
                        nowMs,
                        mcpSignInsNeeded: new Map(),
                        recordedLimits: new Map([
                          [
                            modelSelection.instanceId,
                            [
                              {
                                refusedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
                                resetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60000)),
                              },
                            ],
                          ],
                        ]),
                      }),
                    ),
                }),
                ServerSettings.layerTest({
                  providerInstances: { [alternateInstanceId]: { driver, enabled } },
                }),
              ),
            ),
          );
          const recorder = makeDispatchRecorder(
            {
              source: run.id,
              heldAttempt: undefined,
              command: resume,
              nowMs,
              evidence: { reason: "reset_elapsed", candidates: [], omitted: 0, selected: null },
            },
            sql,
          );
          yield* Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            if (enabled) yield* threads.dispatch(resume, recorder);
            else {
              const error = yield* Effect.flip(threads.dispatch(resume, recorder));
              assert.equal(error._tag, "ThreadManagementProviderInstanceDisabledError");
            }
          }).pipe(Effect.provide(dispatchLayer));
        }
        assert.deepEqual(
          yield* sql`SELECT selected_key, outcome, attempt_sequence IS NOT NULL AS started, json_array_length(snapshot,'$.dispatch.candidates') AS candidates FROM usage_stop_decisions WHERE source_key = ${evidenceKey(run.id)} ORDER BY rowid`,
          [
            // The route is recorded before the guard refuses it; the worker marks the refusal.
            {
              selected_key: evidenceKey(alternateInstanceId),
              outcome: "planned",
              started: 0,
              candidates: 2,
            },
            {
              selected_key: evidenceKey(alternateInstanceId),
              outcome: "accepted",
              started: 1,
              candidates: 3,
            },
          ],
        );
      }
      if (resume !== null) {
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      if (
        scenario === "resume" ||
        scenario === "resume-started" ||
        scenario === "resume-untagged"
      ) {
        assert.deepInclude(after.messages.at(-1), {
          text: "Continue where you left off.",
          createdBy: "agent",
          creationSource: "server",
        });
        let continuation = after.runs.at(-1)!;
        assert.equal(continuation.status, "starting");
        // Automatic resumes hold in memory admission until admitted; admit so startup cuts it.
        if (scenario === "resume" || scenario === "resume-untagged") {
          yield* admitHeldRun(threadId, continuation.id, scenario);
          continuation = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        }
        if (scenario === "resume-started") {
          const startedAt = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make("recovery:continuation-started:resume-started"),
                type: "run.updated",
                threadId,
                runId: continuation.id,
                occurredAt: startedAt,
                payload: { ...continuation, status: "running", startedAt },
              },
              {
                id: EventId.make("recovery:continuation-accepted:resume-started"),
                type: "provider-turn.updated",
                threadId,
                runId: continuation.id,
                occurredAt: startedAt,
                payload: {
                  id: ProviderTurnId.make("recovery:continuation-turn:resume-started"),
                  providerThreadId: continuation.providerThreadId!,
                  nodeId: continuation.rootNodeId!,
                  runAttemptId: continuation.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
              },
            ],
          });
        }
        if (scenario === "resume-untagged") {
          // A server older than the run tag stored the resume run without it.
          const { usageLimitContinuationOfRunId: _, ...untagged } = continuation;
          yield* events.write({
            events: [
              {
                id: EventId.make("recovery:continuation-untagged"),
                type: "run.updated",
                threadId,
                runId: continuation.id,
                occurredAt: yield* DateTime.now,
                payload: untagged,
              },
            ],
          });
        }
        yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService).reconcile(
          "startup",
        );
        const restartedShell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        )!;
        const retry = limitRecoveryCommand(
          restartedShell,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        if (scenario === "resume-started") assert.isNull(retry);
        else assert(retry?.type === "message.dispatch");
        if (scenario === "resume") {
          assert.notEqual(retry!.commandId, resume!.commandId);
        } else {
          assert.equal(
            restartedShell.limitRecovery?.requestId,
            after.thread.limitRecovery?.requestId,
          );
        }
        if (retry !== null) {
          yield* orchestrator.dispatch(retry);
          yield* orchestrator.dispatch(retry);
        }
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        const visible = createOrchestrationV2TurnItemVisibility({
          runs: resumed.runs,
          attempts: resumed.attempts,
          items: resumed.turnItems,
        });
        assert.deepEqual(
          resumed.turnItems.flatMap((item) =>
            item.type === "user_message" && visible(item) ? [item.runId] : [],
          ),
          [run.id, resumed.runs.at(-1)!.id],
        );
        assert.deepEqual(
          resumed.turnItems.flatMap((item) =>
            item.type === "system_notice" && item.title === "Server restarted" ? [item.runId] : [],
          ),
          scenario === "resume" ? [] : [continuation.id],
        );
        assert.deepEqual(
          resumed.runs.map((row) => row.status),
          scenario === "resume" ? ["failed", "cancelled", "starting"] : ["failed", "cancelled"],
        );
      }
      assert.lengthOf(
        after.runs,
        before.runs.length +
          (scenario === "resume" ||
          scenario === "resume-failover" ||
          scenario === "resume-started" ||
          scenario === "resume-untagged" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      assert.lengthOf(
        after.messages,
        before.messages.length +
          (scenario === "resume" ||
          scenario === "resume-failover" ||
          scenario === "resume-started" ||
          scenario === "resume-untagged" ||
          stopBeforeArm ||
          scenario === "queued-resume" ||
          scenario === "independent-patches" ||
          scenario === "expired-snooze"
            ? 1
            : 0),
      );
      if (scenario === "stop") {
        assert.deepInclude(after.thread.limitRecovery, { runId: run.id, autoResume: false });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sweep = { now: yield* DateTime.now, autoResume: true, snooze: false };
        assert.isUndefined(
          (yield* projections.getLimitRecoveryCandidates(sweep)).find((row) => row.id === threadId),
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("recovery:rearm-after-stop"),
          threadId,
          limitRecovery: { runId: run.id, resetAt, autoResume: true },
        });
        const rearmed = (yield* projections.getLimitRecoveryCandidates(sweep)).find(
          (row) => row.id === threadId,
        )!;
        assert.isDefined(rearmed);
        const freshResume = limitRecoveryCommand(rearmed, true, DateTime.toEpochMillis(sweep.now));
        assert.isNotNull(freshResume);
        yield* orchestrator.dispatch(freshResume!);
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 2);
      }
      if (scenario === "queued-resume") {
        const held = after.runs[1]!;
        assert.equal(held.status, "queued");
        assert.isTrue(held.queueHeld);
        const continuation = after.runs[2]!;
        const completedAt = yield* DateTime.now;
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:continuation-completed:queued-resume"),
              type: "run.updated",
              threadId,
              runId: continuation.id,
              occurredAt: completedAt,
              payload: { ...continuation, status: "completed", completedAt },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("recovery:resume-held-after-limit:queued-resume"),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          resumed.runs.map((run) => run.id),
          [run.id, continuation.id, held.id],
        );
        assert.equal(resumed.runs[2]?.status, "starting");
        assert.isFalse(resumed.runs[2]?.queueHeld);
      }
      if (scenario === "resume-failover") {
        // The stop replays from its persisted decisions: a refused route and the accepted retry.
        const sql = yield* SqlClient.SqlClient;
        const replay = (classification: string) =>
          Effect.gen(function* () {
            assert.deepEqual(
              yield* sql`SELECT classification, decisions, attributable_lost_tokens
                FROM usage_stop_replay WHERE source_key = ${evidenceKey(run.id)}`,
              [{ classification, decisions: 2, attributable_lost_tokens: null }],
            );
          });
        const settle = (
          target: (typeof after.runs)[number],
          status: "completed" | "failed" | "cancelled" | "superseded" | "interrupted",
        ) =>
          Effect.gen(function* () {
            const current = yield* orchestrator.getThreadProjection(threadId);
            const attempt = current.attempts.find((row) => row.id === target.activeAttemptId)!;
            const settledAt = yield* DateTime.now;
            yield* events.write({
              events: [
                {
                  id: EventId.make(`recovery:replay:${target.id}:${status}`),
                  type: "run-attempt.updated",
                  threadId,
                  runId: target.id,
                  occurredAt: settledAt,
                  payload: { ...attempt, status, completedAt: settledAt },
                },
                {
                  id: EventId.make(`recovery:replay-run:${target.id}:${status}`),
                  type: "run.updated",
                  threadId,
                  runId: target.id,
                  occurredAt: settledAt,
                  payload: {
                    ...target,
                    status: status === "completed" ? "completed" : "failed",
                    completedAt: settledAt,
                  },
                },
              ],
            });
          });
        const continuation = after.runs.find((row) => row.automaticContinuationOfRunId === run.id)!;
        yield* replay("unknown");
        // Ended attempts prove nothing about the account they ran on.
        for (const status of ["cancelled", "superseded", "interrupted"] as const) {
          yield* settle(continuation, status);
          yield* replay("unknown");
        }
        yield* settle(continuation, "failed");
        yield* replay("failed_attempt");
        // Later work on the thread is a changed request, so its completion recovers nothing.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("recovery:changed-request"),
          threadId,
          messageId: MessageId.make("recovery:changed-request"),
          text: "Do something else.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const changed = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (row) => String(row.userMessageId) === "recovery:changed-request",
        )!;
        yield* settle(changed, "completed");
        yield* replay("failed_attempt");
        yield* settle(continuation, "completed");
        yield* replay("recovered");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const steer = projection.turnItems.find((item) => item.type === "user_message")!;
        assert(continuation.rootNodeId !== null);
        yield* events.write({
          events: [
            {
              id: EventId.make("recovery:delivered-user-steer"),
              type: "turn-item.updated",
              threadId,
              runId: continuation.id,
              nodeId: continuation.rootNodeId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...steer,
                id: TurnItemId.make("recovery:delivered-user-steer"),
                runId: continuation.id,
                nodeId: continuation.rootNodeId,
                messageId: MessageId.make("recovery:delivered-user-steer"),
                inputIntent: "steer",
                createdBy: "user",
                text: "Do something else instead.",
                status: "completed",
                ordinal: Math.max(...projection.turnItems.map((item) => item.ordinal)) + 1,
              },
            },
          ],
        });
        yield* replay("unknown");
      }
    }),
  );
});

const queueResumeDisabledInstanceProjectId = ProjectId.make(
  "project:queue-resume-disabled-instance",
);

const layerQueueResumeDisabledInstanceTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [alternateInstanceId]: { driver: "codex", enabled: true },
      },
      projectSettingsOverrides: {
        [queueResumeDisabledInstanceProjectId]: {
          providerInstances: { [alternateInstanceId]: { enabled: false } },
        },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerQueueResumeDisabledInstanceTest)(
  "queue.resume on a project-disabled instance",
  (it) => {
    it.effect(
      "holds a queued run instead of starting it on an instance the project turned off",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const events = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("queue-resume-disabled-instance-thread");
          const queuedModelSelection = {
            instanceId: alternateInstanceId,
            model: "gpt-5.5",
          } satisfies ModelSelection;

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId: queueResumeDisabledInstanceProjectId,
            title: "Queue resume disabled instance",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:active`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:active`),
            text: "Active",
            attachments: [],
            dispatchMode: { type: "defer_start" },
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:queued`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:queued`),
            text: "Queued",
            attachments: [],
            modelSelection: queuedModelSelection,
            dispatchMode: { type: "queue_after_active" },
          });

          const before = yield* orchestrator.getThreadProjection(threadId);
          const activeRun = before.runs.find((run) => run.status !== "queued")!;
          const queuedRun = before.runs.find((run) => run.status === "queued")!;
          const now = yield* DateTime.now;
          yield* events.write({
            events: [
              {
                id: EventId.make(`${threadId}:active-completed`),
                type: "run.updated",
                threadId,
                runId: activeRun.id,
                occurredAt: now,
                payload: { ...activeRun, status: "completed", completedAt: now },
              },
            ],
          });

          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make(`${threadId}:resume`),
            threadId,
          });

          const resumed = yield* orchestrator.getThreadProjection(threadId);
          const resumedQueuedRun = resumed.runs.find((run) => run.id === queuedRun.id);
          assert.equal(
            resumedQueuedRun?.status,
            "queued",
            "a disabled instance must not start the queued run",
          );
          assert.isTrue(
            resumedQueuedRun?.queueHeld,
            "a refused resume re-holds the queue instead of leaving it looking resumable",
          );
        }),
    );
  },
);

const browserOverrideProjectId = ProjectId.make("project:browser-override");
const browserInheritProjectId = ProjectId.make("project:browser-inherit");
const browserOptOutProjectId = ProjectId.make("project:browser-opt-out");
const browserGlobalOffOptInProjectId = ProjectId.make("project:browser-global-off-opt-in");
const issuedMcpCapabilities = new Map<ThreadId, ReadonlySet<string>>();

const layerProductionBrowserAccessTest = RuntimeLayer.layerProduction.pipe(
  Layer.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.succeed(WorkflowForge.WorkflowForge, WorkflowForge.unavailable),
      Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    ),
  ),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
      Layer.mock(ProviderMcp.ProviderMcp)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      // A full service, not Layer.mock, so the store has no directory instead of a stub.
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.die("unused"),
          set: () => Effect.die("unused"),
          create: () => Effect.die("unused"),
          getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
          remove: () => Effect.die("unused"),
        }),
      ),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
      Layer.mock(AnalyticsService.AnalyticsService)({}),
      Layer.mock(DeviceService.DeviceService)({}),
      Layer.mock(DocumentText.DocumentText)({}),
      Layer.mock(SecretResolver.SecretResolver)({}),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({ streamBranchChanges: Stream.never }),
    ),
  ),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
  Layer.provide(
    Layer.effect(
      McpSessionRegistry.McpSessionRegistry,
      Effect.gen(function* () {
        const delegate = yield* McpSessionRegistry.McpSessionRegistry;
        return McpSessionRegistry.McpSessionRegistry.of({
          ...delegate,
          issue: (request) =>
            Effect.sync(() =>
              issuedMcpCapabilities.set(request.threadId, request.capabilities ?? new Set()),
            ).pipe(Effect.andThen(delegate.issue(request))),
        });
      }),
    ).pipe(Layer.provide(McpSessionRegistryTestkit.layer)),
  ),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(
    ServerSettings.layerTest({
      enableAgentBrowserAccess: true,
      projectSettingsOverrides: {
        [browserOverrideProjectId]: { enableAgentBrowserAccess: true },
        [browserOptOutProjectId]: { enableAgentBrowserAccess: false },
        [browserGlobalOffOptInProjectId]: { enableAgentBrowserAccess: true },
      },
    }),
  ),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(layerSharedTaskIdentities()),
  Layer.provide(Layer.merge(ManagedPolicy.layerTest(), MemoryAdmission.layerTest())),
  Layer.provide(Layer.mock(ThreadPageCheckAccess.ThreadPageCheckAccess)({})),
  Layer.provide(layerPlatformTest),
);

// regression: #23085 a project without an override lost browser tools once another project set one
it.layer(layerProductionBrowserAccessTest)("production agent browser access", (it) => {
  it.effect("grants preview per project policy when another project overrides it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const openWithMcp = (projectId: ProjectId) =>
        Effect.gen(function* () {
          yield* seedProject({
            projectId,
            title: projectId,
            workspaceRoot: `/workspace/${projectId}`,
            defaultModelSelection: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          });
          const threadId = ThreadId.make(`${projectId}:thread`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:create`),
            threadId,
            projectId,
            title: "Browser access",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          // The test adapter cannot open a session; MCP access is issued first.
          yield* sessions
            .open({
              threadId,
              providerSessionId: ProviderSessionId.make(`${threadId}:session`),
              modelSelection,
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: process.cwd(),
              },
            })
            .pipe(Effect.exit);
          return issuedMcpCapabilities.get(threadId)?.has("preview");
        });

      assert.isTrue(
        yield* openWithMcp(browserInheritProjectId),
        "a project without an override inherits the global opt-in",
      );
      assert.isTrue(
        yield* openWithMcp(browserOverrideProjectId),
        "an explicit project opt-in grants preview",
      );
      assert.isFalse(
        yield* openWithMcp(browserOptOutProjectId),
        "an explicit project opt-out still withholds preview",
      );

      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ enableAgentBrowserAccess: false });
      assert.isTrue(
        yield* openWithMcp(browserGlobalOffOptInProjectId),
        "an explicit project opt-in grants preview when the global setting is off",
      );
    }),
  );
});
