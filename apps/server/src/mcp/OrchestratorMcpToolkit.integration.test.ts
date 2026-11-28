import * as NodeURL from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts/baseSchemas";
import type { ProviderOptionDescriptor } from "@t3tools/contracts/model";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import { isProviderNativeSubagentThread } from "@t3tools/contracts/orchestrationV2";
import {
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpReviewAssignmentResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts/orchestratorMcp";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ServerProvider } from "@t3tools/contracts/server";
import { ClaudeSettings } from "@t3tools/contracts/settings";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as CommandRunner from "../commandRunner/CommandRunner.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ReviewAssignmentRegistry from "./ReviewAssignmentRegistry.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkBack from "../peer/PeerLinkBack.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as SharedSettings from "../sharedSettings/SharedSettings.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

/** A task delegated here always has a local child thread. */
const localChild = (childThreadId: ThreadId | null): ThreadId => {
  if (childThreadId === null) throw new Error("expected a local delegated child");
  return childThreadId;
};

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeReviewAssignmentResult = Schema.decodeUnknownEffect(
  OrchestratorMcpReviewAssignmentResult,
);

const claudeSettings = Schema.decodeSync(ClaudeSettings)({});

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(NodeURL.fileURLToPath(delegatedTaskStatusTranscriptFile));
  const transcript = yield* decodeProviderReplayNdjson(
    text.replaceAll(queuedFollowupResult, followupResult),
  );
  // The recording ends when the recorder closes the app-server while the parent
  // turn is still open. This test keeps acting as that parent afterwards, and
  // replaying the exit would kill the shared process and fail the parent run.
  return {
    ...transcript,
    entries: transcript.entries.filter((entry) => entry.type !== "runtime_exit"),
  };
}, Effect.provide(NodeServices.layer));

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    setPlacement: () => Effect.die("unused in this test"),
    setGroupPaused: () => Effect.die("unused in this test"),
    setGroup: () => Effect.die("unused in this test"),
    reorderPinned: () => Effect.die("unused in this test"),
    setFollowsDefaultModel: () => Effect.die("unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    applyShared: () => Effect.die("unused in this test"),
    knownMachineIds: () => Effect.die("unused in this test"),
    claimOccurrence: () => Effect.die("unused in this test"),
    sharedCopies: () => Effect.die("unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    reportRunResult: () => Effect.die("unused in this test"),
    moveThreadTasks: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    liveRuns: () => Effect.die("unused in this test"),
    listRuns: () => Effect.die("unused in this test"),
    recentRunCounts: () => Effect.die("unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

/** Settings, schedules, peers and processes the toolkit needs but these tests never reach. */
const layerUnreachedServices = Layer.mergeAll(
  ServerSettings.layerTest(),
  MemoryAdmission.layerTest(),
  layerUnusedScheduledTaskStub,
  Layer.mock(PeerForwarding.PeerForwarding)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PeerLinkBack.PeerLinkBack)({}),
  Layer.mock(SharedSettings.SharedSettings)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(CommandRunner.CommandRunner)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

const reviewServer = McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER;
const reviewTool = McpProviderSession.REVIEW_ASSIGNMENT_TOOL;

/** The registries a review's credential and assignment live in, on a real HTTP server. */
const layerReviewRegistries = Layer.mergeAll(
  McpSessionRegistry.layer,
  ReviewAssignmentRegistry.layer,
).pipe(
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:mcp-replay")),
    }),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(NodeServices.layer),
);

const layerClaudeQueryRunner = ClaudeAdapterV2.layerQueryRunner.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
  Layer.provide(NodeServices.layer),
);

/** The parent stays mid-turn without a Claude process, so it can delegate. */
const busyParentSession: ClaudeAdapterV2.ClaudeAgentSdkQuerySession = {
  messages: Stream.never,
  offer: () => Effect.void,
  setModel: () => Effect.void,
  applyFlagSettings: () => Effect.void,
  setPermissionMode: () => Effect.void,
  backgroundTasks: () => Effect.succeed(false),
  stopTask: () => Effect.void,
  interrupt: Effect.void,
  close: Effect.void,
};

/**
 * A Claude parent thread mid-turn whose `delegate_task` launches assignment-isolated reviewers
 * through `reviewRunner`, with the reviewers' MCP route served where their credentials point.
 */
const openRestrictedClaudeReview = Effect.fn("openRestrictedClaudeReview")(function* (options: {
  readonly name: string;
  readonly model: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly reviewRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape;
}) {
  const cwd = yield* checkpointWorkspace(options.name);
  const credentials = yield* McpSessionRegistry.McpSessionRegistry;
  const assignments = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = { instanceId, model: options.model };
  const queryRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape = {
    ...options.reviewRunner,
    open: (input) =>
      input.options.mcpServers?.[reviewServer] === undefined
        ? Effect.succeed(busyParentSession)
        : options.reviewRunner.open(input),
  };
  const adapterOptions = {
    instanceId,
    settings: claudeSettings,
    environment: options.environment,
    attachmentsDir: cwd,
    fileSystem,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner,
  };
  // Built inside each registry so the adapter shares that graph's MCP sessions.
  const layerClaudeAdapters = Layer.unwrap(
    Effect.map(
      ClaudeAdapterV2.makeClaudeAdapterV2(adapterOptions),
      ProviderAdapterRegistry.layerSingle,
    ),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerSharedRegistries = Layer.mergeAll(
    Layer.succeed(McpSessionRegistry.McpSessionRegistry, credentials),
    Layer.succeed(ReviewAssignmentRegistry.ReviewAssignmentRegistry, assignments),
  );
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: options.name },
    layerClaudeAdapters,
    { mcp: layerSharedRegistries },
  );
  const layerOrchestration = Layer.merge(
    layerOrchestrator,
    ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
  const layerToolkit = layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(layerSharedRegistries),
    Layer.provideMerge(layerOrchestration),
    Layer.provide(layerClaudeAdapters.pipe(Layer.provide(McpProviderSessions.layer))),
    Layer.provide(
      ProviderRegistryMock.layer([
        makeProviderSnapshot({
          instanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          model: options.model,
        }),
      ]),
    ),
    Layer.provideMerge(
      SecretRequests.layer.pipe(
        Layer.provide(layerMemorySecretStore),
        Layer.provide(layerOrchestration),
      ),
    ),
    Layer.provide(layerUnreachedServices),
  );
  const layerReviewRoute = HttpRouter.serve(McpHttpServer.layerReviewAssignment, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerSharedRegistries),
    Layer.provide(layerOrchestration),
  );
  const context = yield* Layer.build(Layer.merge(layerToolkit, layerReviewRoute));
  const orchestrator = Context.get(context, Orchestrator.OrchestratorV2);
  const server = Context.get(context, McpServer.McpServer);

  const parentCreate = yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:restricted-review-parent:create"),
    threadId: parentThreadId,
    projectId,
    title: "Restricted review parent",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:restricted-review-parent:start"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:restricted-review-parent:start"),
    text: parentPrompt,
    attachments: [],
    modelSelection: selection,
    dispatchMode: { type: "start_immediately" },
  });
  yield* orchestrator
    .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence: parentCreate.sequence })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.status === "running",
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("Parent provider turn did not start."),
          onSome: () => Effect.void,
        }),
      ),
    );

  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-replay"),
    requestNamespace: "mcp-provider-session-restricted-review-parent",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "mcp-provider-session-restricted-review-parent",
      providerInstanceId: instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const invoke = (name: string, args: Record<string, unknown>) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const delegate = (assignment: string, clientRequestId: string, task = delegatedPrompt) =>
    invoke("delegate_task", {
      task,
      target: { providerInstanceId: instanceId, model: options.model },
      isolation: { type: "assignment", handle: assignment },
      mode: "async",
      clientRequestId,
    });
  const reviewAssignment = (args: Record<string, unknown>) =>
    invoke("t3_review_assignment", args).pipe(
      Effect.flatMap((call) => decodeReviewAssignmentResult(call.structuredContent)),
      Effect.orDie,
    );
  /** Delegates a review, waits for its result to reach the parent, and reads its `task_status`. */
  const runReview = Effect.fn("runReview")(function* (
    assignment: string,
    clientRequestId: string,
    task?: string,
  ) {
    const afterSequence = yield* orchestrator.getThreadEventSequence(parentThreadId);
    const call = yield* delegate(assignment, clientRequestId, task);
    if (call.isError === true) {
      return yield* Effect.die(new Error(JSON.stringify(call.content)));
    }
    const started = yield* decodeDelegateTaskResult(call.structuredContent).pipe(Effect.orDie);
    yield* orchestrator.streamStoredEventsFrom({ threadId: parentThreadId, afterSequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "context-transfer.created" &&
          stored.event.payload.type === "subagent_result" &&
          stored.event.payload.sourceThreadId === started.childThreadId,
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die("The review's result transfer was not created."),
          onSome: () => Effect.void,
        }),
      ),
    );
    return yield* invoke("task_status", { taskId: started.taskId }).pipe(
      Effect.flatMap((status) => decodeDelegateTaskResult(status.structuredContent)),
      Effect.orDie,
    );
  });
  /** Registers one file through `t3_review_assignment`, as an evaluator outside the server does. */
  const registerFile = Effect.fn("registerFile")(function* (path: string, content: string) {
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const file = `${directory}/material`;
    yield* fileSystem.writeFileString(file, content);
    return yield* reviewAssignment({
      action: "register",
      material: [{ side: "head", path, file }],
    });
  });
  return {
    cwd,
    instanceId,
    delegate,
    runReview,
    registerFile,
    revoke: (handle: string) => reviewAssignment({ action: "revoke", handle }),
  };
});

describe("orchestrator MCP toolkit", () => {
  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
    { label: "emoji", result: "😀", latestSummary: "😀" },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        // Records a task in another environment as the real delegation does, with no link to reach.
        const layerRemoteDelegation = Layer.unwrap(
          Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            return Layer.mock(RemoteDelegation.RemoteDelegation)({
              delegate: (scope, parent, input, { commandId }) =>
                threads
                  .dispatch({
                    type: "delegated_task.remote.request",
                    commandId,
                    parentThreadId: scope.thread.threadId,
                    parentRunId: parent.runId,
                    parentNodeId: parent.nodeId,
                    task: input.task,
                    driver: ProviderDriverKind.make("remote"),
                    modelSelection: { instanceId: codexInstanceId, model: codexModel },
                    remoteChild: {
                      environmentId: EnvironmentId.make("environment:box"),
                      threadId: ThreadId.make("thread:on-the-box"),
                      label: "Box",
                    },
                    completionWake: "always",
                  })
                  .pipe(
                    Effect.as({ taskId: IdAllocator.derive.delegatedTaskNode({ commandId }) }),
                    Effect.orDie,
                  ),
            });
          }),
        ).pipe(Layer.provide(layerOrchestration));
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(ReviewAssignmentRegistry.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(layerRemoteDelegation),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(layerUnreachedServices),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>, scope = invocation) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          yield* (yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry)
            .register({
              handle: "synthetic-assignment",
              owner: parentThreadId,
              allowedReads: [{ handle: "synthetic-assignment", side: "head", path: "src/app.ts" }],
              read: async () => new Uint8Array(),
              record: async () => undefined,
            })
            .pipe(Effect.orDie);
          const assignment = { type: "assignment", handle: "synthetic-assignment" } as const;
          for (const [args, code, reason] of [
            [
              { target: { providerInstanceId: "codex" }, isolation: assignment },
              "restricted_review_unsupported",
              "needs a Claude account",
            ],
            [
              {
                target: { providerInstanceId: "codex" },
                isolation: { type: "assignment", handle: "unregistered-assignment" },
              },
              "invalid_request",
              "registered no review assignment",
            ],
            [{ auto: true, isolation: assignment }, "restricted_review_unsupported", "auto:true"],
            [
              {
                target: { providerInstanceId: "codex" },
                runtimeMode: "full-access",
                isolation: assignment,
              },
              "restricted_review_unsupported",
              "omit runtimeMode",
            ],
            [
              {
                target: { providerInstanceId: "codex", environmentId: "environment:other" },
                isolation: assignment,
              },
              "restricted_review_unsupported",
              "only in this environment",
            ],
            [
              {
                target: { providerInstanceId: "codex", projectId: "project:other" },
                isolation: assignment,
              },
              "restricted_review_unsupported",
              "Omit target.projectId",
            ],
          ] as const) {
            const refused = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              ...args,
              clientRequestId: "delegate-codex-replay-1",
            });
            expect(refused.isError).toBe(true);
            expect(refused.content).toEqual([
              expect.objectContaining({
                text: expect.stringMatching(new RegExp(`${code}[\\s\\S]*${reason}`)),
              }),
            ]);
          }
          expect(yield* orchestrator.getThreadEventSequence(parentThreadId)).toBe(
            delegationStartSequence,
          );
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          // The accepted key keeps its isolation: a retry cannot pass this ordinary task off as a review.
          const collided = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            isolation: assignment,
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          expect(collided.isError).toBe(true);
          expect(collided.content).toEqual([
            expect.objectContaining({
              text: expect.stringMatching(
                /invalid_request[\s\S]*accepted with different isolation/,
              ),
            }),
          ]);
          // Nor a task accepted in another environment, where no read broker holds the assignment.
          const remoteCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
              environmentId: "environment:box",
            },
            mode: "async",
            clientRequestId: "delegate-remote-1",
          });
          expect(remoteCall.isError).not.toBe(true);
          const remoteCollided = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: { providerInstanceId: codexInstanceId, model: codexModel },
            isolation: assignment,
            mode: "async",
            clientRequestId: "delegate-remote-1",
          });
          expect(remoteCollided.isError).toBe(true);
          expect(remoteCollided.content).toEqual([
            expect.objectContaining({
              text: expect.stringMatching(
                /restricted_review_unsupported[\s\S]*accepted as a task in another environment/,
              ),
            }),
          ]);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(
            localChild(delegated.childThreadId),
          );
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            localChild(delegated.childThreadId),
          );
          const runningFollowupCall = yield* invoke("t3_thread_send", {
            threadId: localChild(delegated.childThreadId),
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: localChild(delegated.childThreadId),
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("t3_thread_send", {
            threadId: localChild(delegated.childThreadId),
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            localChild(delegated.childThreadId),
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(
            localChild(delegated.childThreadId),
          );
          const interruptCall = yield* invoke("t3_thread_interrupt", {
            threadId: localChild(delegated.childThreadId),
            runId: runningFollowup.runId,
            reason: "Allow the queued replay follow-up to run.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: localChild(delegated.childThreadId),
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(
            localChild(delegated.childThreadId),
          );
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(
            finalProjection.turnItems.find(
              (item) =>
                item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
            ),
          ).toMatchObject({
            message: "Stopped by an agent: Allow the queued replay follow-up to run.",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const transferReads: Array<string> = [];
          const messageReads: Array<string> = [];
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (endTime, exit) => {
                end(endTime, exit);
                const query = span.attributes.get("db.query.text");
                if (typeof query !== "string") return;
                if (
                  /SELECT[\s\S]*FROM orchestration_v2_projection_context_transfers/i.test(query)
                ) {
                  transferReads.push(query);
                }
                if (
                  /SELECT\s+payload_json\s+FROM orchestration_v2_projection_messages/i.test(query)
                ) {
                  messageReads.push(query);
                }
              };
              return span;
            },
          });
          const wait = yield* invoke(
            "t3_thread_wait",
            { threadId: delegated.childThreadId, runId: queuedFollowup.runId },
            { ...invocation, thread: undefined },
          ).pipe(Effect.withTracer(tracer));
          expect(wait.isError).not.toBe(true);
          const expectedWait = {
            threadId: delegated.childThreadId,
            runId: queuedFollowup.runId,
            status: "completed",
            timedOut: false,
          };
          expect(wait.structuredContent).toEqual(expectedWait);
          expect(messageReads).toEqual([]);
          expect(transferReads).toHaveLength(0);
          const settledWait = yield* invoke(
            "t3_thread_wait",
            {
              threadId: delegated.childThreadId,
              runId: queuedFollowup.runId,
              untilDelegatedWorkSettled: true,
            },
            { ...invocation, thread: undefined },
          ).pipe(Effect.withTracer(tracer));
          expect(settledWait.isError).not.toBe(true);
          expect(settledWait.structuredContent).toMatchObject({
            ...expectedWait,
            resultRun: { runId: queuedFollowup.runId, status: "completed" },
          });
          expect(messageReads.length).toBeGreaterThan(0);
          expect(
            messageReads.filter((query) => query.includes("$.notification.source.kind")),
          ).toHaveLength(1);
          // The orchestrator's restart-continuation guard still reads its own records.
          expect(
            messageReads.filter((query) => !query.includes("$.notification.source.kind")),
          ).toHaveLength(1);
          const parentlessRead = yield* invoke(
            "t3_thread_read",
            {
              threadId: delegated.childThreadId,
              limit: 100,
              maxCharsPerItem: result === "😀" ? 1 : 20_000,
            },
            { ...invocation, thread: undefined },
          ).pipe(Effect.withTracer(tracer));
          expect(parentlessRead.isError).not.toBe(true);
          expect(transferReads).toHaveLength(0);
          const afterParentlessRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterParentlessRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("claimed");

          const read = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
            maxCharsPerItem: result === "😀" ? 1 : 20_000,
          }).pipe(Effect.withTracer(tracer));
          expect(read.isError).not.toBe(true);
          expect(transferReads.length).toBeGreaterThan(0);
          expect(read.structuredContent).toEqual(parentlessRead.structuredContent);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");

          const messageReadsBeforeCapabilities = messageReads.length;
          const capabilities = yield* invoke("orchestrator_capabilities", {}).pipe(
            Effect.withTracer(tracer),
          );
          expect(capabilities.isError).not.toBe(true);
          expect(messageReads).toHaveLength(messageReadsBeforeCapabilities);
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );

  it.live("runs an assignment-isolated Claude review and reports what it verified and read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const credentials = yield* McpSessionRegistry.McpSessionRegistry;
        const assignments = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
        const claudeModel = "claude-sonnet-4-6";
        const handle = "restricted-review-assignment";
        const pin = { handle, side: "head", path: "src/app.ts" } as const;
        const frame = (value: unknown) => value as SDKMessage;
        const answer = (sessionId: string, text: string) => [
          frame({
            type: "assistant",
            uuid: `${sessionId}:answer`,
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              id: `${sessionId}:message`,
              role: "assistant",
              type: "message",
              model: claudeModel,
              content: [{ type: "text", text }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }),
          frame({
            type: "result",
            subtype: "success",
            uuid: `${sessionId}:result`,
            session_id: sessionId,
            is_error: false,
            num_turns: 1,
            result: text,
            stop_reason: "end_turn",
            terminal_reason: "completed",
            permission_denials: [],
            duration_ms: 1,
            duration_api_ms: 1,
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
          }),
        ];
        let sessionCount = 0;
        const reviewLaunches: Array<string | undefined> = [];
        // A fake Claude reviewer: it reads its pin through the credential the session manager
        // issued before it answers.
        const reviewRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape = {
          allocateSessionId: Effect.sync(() => `restricted-review-session-${++sessionCount}`),
          open: ({ options }) =>
            Effect.gen(function* () {
              const sdkMessages = yield* Queue.unbounded<SDKMessage>();
              const sessionId = options.sessionId ?? options.resume ?? "unallocated";
              const review = options.mcpServers?.[reviewServer];
              const authorization =
                review !== undefined && "headers" in review
                  ? review.headers?.["Authorization"]
                  : undefined;
              reviewLaunches.push(options.cwd);
              const readPin = Effect.gen(function* () {
                const scope = yield* credentials.resolve(
                  (authorization ?? "").replace(/^Bearer /, ""),
                );
                if (scope?.assignment === undefined) {
                  return yield* Effect.die("the review credential did not resolve");
                }
                const material = yield* assignments
                  .readMaterial(
                    { threadId: scope.thread.threadId, handle: scope.assignment.handle },
                    { ...pin, handle: scope.assignment.handle },
                  )
                  .pipe(Effect.orDie);
                yield* Queue.offerAll(sdkMessages, answer(sessionId, `Reviewed ${material}`));
              });
              return {
                messages: Stream.fromQueue(sdkMessages),
                inspect: Effect.succeed({
                  model: claudeModel,
                  account: { email: "reviewer@example.com" },
                  mcpServers: [{ name: reviewServer, status: "connected", tools: [reviewTool] }],
                  mcpTools: [
                    { name: `mcp__${reviewServer}__${reviewTool}`, serverName: reviewServer },
                  ],
                  builtinTools: [],
                  memoryFiles: [],
                  agents: [],
                  skills: 0,
                  systemPromptSections: [],
                  contextRows: ["system_prompt", "mcp_tools"],
                }),
                offer: () => readPin,
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        };
        const review = yield* openRestrictedClaudeReview({
          name: "restricted-claude-review",
          model: claudeModel,
          environment: {},
          reviewRunner,
        });
        const recorded: Array<unknown> = [];
        yield* assignments
          .register({
            handle,
            owner: parentThreadId,
            allowedReads: [pin],
            read: async () => new TextEncoder().encode("const answer = 42;\n"),
            record: async (receipt) => void recorded.push(receipt),
          })
          .pipe(Effect.orDie);

        const status = yield* review.runReview(handle, "delegate-restricted-review-1");
        expect(status).toMatchObject({
          status: "completed",
          summary: "Reviewed const answer = 42;\n",
        });
        // The reviewer ran in the assignment's own empty workspace, never the parent's checkout.
        expect(reviewLaunches).toHaveLength(1);
        const reviewCwd = reviewLaunches[0];
        expect(reviewCwd).not.toBe(review.cwd);
        expect(status.reviewEvidence).toEqual({
          sessions: [
            expect.objectContaining({
              assignmentHandle: handle,
              runId: status.childRunId,
              providerInstanceId: review.instanceId,
              driver: "claudeAgent",
              model: claudeModel,
              effectiveTools: [`${reviewServer}/${reviewTool}`],
              mcpServers: [reviewServer],
              cwd: reviewCwd,
              verifiedBeforeInference: true,
            }),
          ],
          receipts: [
            expect.objectContaining({
              runId: status.childRunId,
              handle,
              side: "head",
              path: "src/app.ts",
              byteLength: "const answer = 42;\n".length,
            }),
          ],
        });
        expect(recorded).toEqual(status.reviewEvidence?.receipts);
        expect(JSON.stringify(status.reviewEvidence)).not.toContain("reviewer@example.com");

        // A retry of the accepted request returns the same review and its evidence.
        const retried = yield* decodeDelegateTaskResult(
          (yield* review.delegate(handle, "delegate-restricted-review-1")).structuredContent,
        ).pipe(Effect.orDie);
        expect(retried.taskId).toBe(status.taskId);
        expect(retried.reviewEvidence).toEqual(status.reviewEvidence);

        // An evaluator outside the server registers files through the tool, under a handle it is given.
        const registered = yield* review.registerFile("src/app.ts", "const answer = 43;\n");
        expect(registered.handle).not.toBe(handle);
        // The accepted key keeps its assignment: a retry cannot turn this review into another one.
        const switched = yield* review.delegate(registered.handle, "delegate-restricted-review-1");
        expect(switched.isError).toBe(true);
        expect(switched.content).toEqual([
          expect.objectContaining({
            text: expect.stringMatching(/invalid_request[\s\S]*accepted with different isolation/),
          }),
        ]);
        const secondStatus = yield* review.runReview(
          registered.handle,
          "delegate-restricted-review-2",
        );
        expect(secondStatus.summary).toBe("Reviewed const answer = 43;\n");
        expect(secondStatus.reviewEvidence?.receipts).toEqual([
          expect.objectContaining({ handle: registered.handle, ...registered.material?.[0] }),
        ]);
        expect((yield* review.revoke(registered.handle)).revoked).toBe(true);
        expect((yield* review.revoke(registered.handle)).revoked).toBe(false);
        const afterRevoke = yield* review.delegate(
          registered.handle,
          "delegate-restricted-review-3",
        );
        expect(afterRevoke.isError).toBe(true);
        expect(afterRevoke.content).toEqual([
          expect.objectContaining({
            text: expect.stringMatching(/invalid_request[\s\S]*registered no review assignment/),
          }),
        ]);
      }),
    ).pipe(Effect.provide(layerReviewRegistries)),
  );

  // Opt-in, because it spends a real turn on the default Claude login: set
  // T3_TEST_LIVE_CLAUDE_REVIEW=1, and T3_TEST_LIVE_CLAUDE_REVIEW_MODEL to change the model.
  // The test setup clears T3CODE_, CLAUDE_ and ANTHROPIC_ variables, so these names avoid them.
  it.live.runIf(process.env.T3_TEST_LIVE_CLAUDE_REVIEW === "1")(
    "attests and runs an assignment-isolated review on the real Claude CLI",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* Layer.build(layerClaudeQueryRunner);
          const review = yield* openRestrictedClaudeReview({
            name: "live-restricted-claude-review",
            model: process.env.T3_TEST_LIVE_CLAUDE_REVIEW_MODEL ?? "claude-haiku-5-5",
            environment: process.env,
            reviewRunner: Context.get(runner, ClaudeAdapterV2.ClaudeAgentSdkQueryRunner),
          });
          const registered = yield* review.registerFile("src/app.ts", "const answer = 43;\n");
          const status = yield* review.runReview(
            registered.handle,
            "live-restricted-review",
            `Call ${reviewTool} once with handle "${registered.handle}", side "head" and path "src/app.ts". Then reply with only the text it returned.`,
          );
          yield* Effect.logInfo("live restricted Claude review", {
            status: status.status,
            summary: status.summary,
            reviewEvidence: status.reviewEvidence,
          });
          expect(status.status).toBe("completed");
          expect(status.summary).toContain("const answer = 43;");
          expect(status.reviewEvidence).toEqual({
            sessions: [
              expect.objectContaining({
                assignmentHandle: registered.handle,
                driver: "claudeAgent",
                effectiveTools: [`${reviewServer}/${reviewTool}`],
                mcpServers: [reviewServer],
                verifiedBeforeInference: true,
              }),
            ],
            receipts: [
              expect.objectContaining({ handle: registered.handle, ...registered.material?.[0] }),
            ],
          });
          expect((yield* review.revoke(registered.handle)).revoked).toBe(true);
        }),
      ).pipe(Effect.provide(layerReviewRegistries)),
  );
});
