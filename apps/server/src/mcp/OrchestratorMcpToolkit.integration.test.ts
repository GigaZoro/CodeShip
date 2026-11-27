import * as NodeURL from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadReadResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer } from "effect/ai";

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
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
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
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const longFollowupResult = "Long delegated follow-up line. ".repeat(1_500);

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const claudeSettings = Schema.decodeSync(ClaudeSettings)({});

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(
  function* (followupResult: string) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(NodeURL.fileURLToPath(delegatedTaskStatusTranscriptFile));
    // The recording names the parent, then the child, after the fixture's titles; this test's differ.
    const threadNames = ["MCP replay parent", delegatedPrompt];
    const transcript = yield* decodeProviderReplayNdjson(
      text
        .replaceAll(queuedFollowupResult, followupResult)
        .replace(
          /"name":"Replay fixture: delegated_task_status"/g,
          () => `"name":${JSON.stringify(threadNames.shift())}`,
        ),
    );
    // The recording ends when the recorder closes the app-server while the parent
    // turn is still open. This test keeps acting as that parent afterwards, and
    // replaying the exit would kill the shared process and fail the parent run.
    return {
      ...transcript,
      entries: transcript.entries.filter((entry) => entry.type !== "runtime_exit"),
    };
  },
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

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
  Layer.mock(ProjectService.ProjectService)({ workspaceScanDirectory: Effect.succeed }),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(CommandRunner.CommandRunner)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("orchestrator MCP toolkit", () => {
  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
    { label: "emoji", result: "😀", latestSummary: "😀" },
    { label: "long", result: longFollowupResult, latestSummary: longFollowupResult },
  ])("reports $label child results", ({ result, latestSummary }) =>
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
      // SQL spans carry no bound parameters, so this records which thread each tool read.
      const threadRecordReads: Array<{
        readonly threadId: ThreadId;
        readonly fields: ReadonlyArray<string>;
      }> = [];
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.gen(function* () {
            const service = yield* ThreadManagementService.ThreadManagementService;
            return ThreadManagementService.ThreadManagementService.of({
              ...service,
              getThreadRecords: (threadId, fields, filter) =>
                Effect.sync(() => threadRecordReads.push({ threadId, fields })).pipe(
                  Effect.andThen(service.getThreadRecords(threadId, fields, filter)),
                ),
            });
          }),
        ).pipe(
          Layer.provide(
            ThreadManagementService.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
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
      const layerTest = layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(ReviewAssignmentRegistry.layer),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
            Layer.provide(McpProviderSessions.layer),
          ),
        ),
        Layer.provide(layerProviderRegistry),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(MemoryAdmission.layerTest()),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PeerLinkBack.PeerLinkBack)({}),
            Layer.mock(SharedSettings.SharedSettings)({}),
            Layer.mock(CommandRunner.CommandRunner)({}),
          ),
        ),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({ workspaceScanDirectory: Effect.succeed }),
        ),
        Layer.provideMerge(
          SecretRequests.layer.pipe(
            Layer.provide(layerMemorySecretStore),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
            Layer.provide(layerOrchestration),
          ),
        ),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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

        const delegationStartSequence = yield* orchestrator.getThreadEventSequence(parentThreadId);
        yield* (yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry)
          .register({
            handle: "synthetic-assignment",
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
            "not registered",
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
            text: expect.stringMatching(/invalid_request[\s\S]*accepted with different isolation/),
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
          (task) => task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
        );
        expect(followupTasks).toHaveLength(2);
        expect(followupTasks.every((task) => task.result === null)).toBe(true);
        expect(followupTasks.map((task) => task.id)).toEqual([
          runningFollowup.taskId,
          queuedFollowup.taskId,
        ]);
        expect(pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status).toBe(
          "completed",
        );
        expect(pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
          "running",
        );
        expect(pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
          "queued",
        );
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
        const interrupt = yield* decodeThreadInterruptResult(interruptCall.structuredContent).pipe(
          Effect.orDie,
        );
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
            (item) => item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
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
        const finalStatus = yield* decodeDelegateTaskResult(finalStatusCall.structuredContent).pipe(
          Effect.orDie,
        );
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
        const runReads: Array<string> = [];
        const projectionTableReads: Array<string> = [];
        const acknowledgementReads: Array<string> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query !== "string") return;
              let parent = Option.getOrUndefined(span.parent);
              while (parent?._tag === "Span") {
                if (
                  parent.name === "Orchestrator.dispatchDelegatedTaskCompletionDeliveryResolution"
                ) {
                  acknowledgementReads.push(query);
                  break;
                }
                parent = Option.getOrUndefined(parent.parent);
              }
              for (const [, table] of query.matchAll(/FROM orchestration_v2_projection_(\w+)/gi)) {
                projectionTableReads.push(table!);
              }
              if (/SELECT[\s\S]*FROM orchestration_v2_projection_context_transfers/i.test(query)) {
                transferReads.push(query);
              }
              if (/SELECT\s+payload_json\s+FROM orchestration_v2_projection_runs/i.test(query)) {
                runReads.push(query);
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
            maxCharsPerItem: result === "😀" ? 1 : 50_000,
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
          ...(result === "😀" ? { maxCharsPerItem: 1 } : {}),
        }).pipe(Effect.withTracer(tracer));
        expect(read.isError).not.toBe(true);
        expect(transferReads.length).toBeGreaterThan(0);
        const firstPage = yield* decodeThreadRead(read.structuredContent);
        const finalItem = firstPage.items.find((item) => item.text === result.slice(0, 500));
        expect(finalItem).toBeDefined();
        if (result.length > 500) {
          yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: result.length,
          });
        } else {
          expect(read.structuredContent).toEqual(parentlessRead.structuredContent);
        }
        let text = finalItem!.text ?? "";
        let nextTextOffset = finalItem?.nextTextOffset ?? null;
        while (nextTextOffset !== null) {
          const beforeContinuation = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            beforeContinuation.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const continuation = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: nextTextOffset,
            maxCharsPerItem: 50_000,
          }).pipe(Effect.withTracer(tracer));
          const nextPage = yield* decodeThreadRead(continuation.structuredContent);
          text += nextPage.items[0]?.text ?? "";
          nextTextOffset = nextPage.items[0]?.nextTextOffset ?? null;
        }
        expect(text).toBe(result);
        // The acknowledgement reads the task and its spawning run by id, not the parent's history.
        expect(acknowledgementReads.length).toBeGreaterThan(0);
        expect(
          acknowledgementReads.filter(
            (query) =>
              /FROM orchestration_v2_projection_(nodes|run_attempts)\b/.test(query) ||
              (/FROM orchestration_v2_projection_runs\b/.test(query) &&
                !query.includes("AND run_id IN")) ||
              (/FROM orchestration_v2_projection_subagents\b/.test(query) &&
                !query.includes("AND subagent_id IN")),
          ),
        ).toEqual([]);
        const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)?.completionDelivery
            ?.state,
        ).toBe("acknowledged");

        const messageReadsBeforeCapabilities = messageReads.length;
        const tableReadsBeforeCapabilities = projectionTableReads.length;
        const capabilities = yield* invoke("orchestrator_capabilities", {}).pipe(
          Effect.withTracer(tracer),
        );
        expect(capabilities.isError).not.toBe(true);
        expect(messageReads).toHaveLength(messageReadsBeforeCapabilities);
        // The caller check reads only the thread row, never its history.
        expect(new Set(projectionTableReads.slice(tableReadsBeforeCapabilities))).toEqual(
          new Set(["threads"]),
        );
        const runReadsBeforeStatus = runReads.length;
        const transferReadsBeforeStatus = transferReads.length;
        const threadRecordReadsBeforeStatus = threadRecordReads.length;
        const statusAgain = yield* invoke("task_status", { taskId: delegated.taskId }).pipe(
          Effect.withTracer(tracer),
        );
        expect(statusAgain.isError).not.toBe(true);
        // A task wait reads result transfers and runs from the child; the parent's stay unread.
        expect(runReads).toHaveLength(runReadsBeforeStatus + 1);
        expect(transferReads).toHaveLength(transferReadsBeforeStatus + 1);
        expect(
          threadRecordReads
            .slice(threadRecordReadsBeforeStatus)
            .filter(({ fields }) => fields.includes("runs") || fields.includes("contextTransfers"))
            .map(({ threadId }) => threadId),
        ).toEqual([delegated.childThreadId]);
      }).pipe(Effect.provide(layerTest));
    }),
  );

  it.live("runs an assignment-isolated Claude review and reports what it verified and read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("restricted-claude-review");
        const credentials = yield* McpSessionRegistry.McpSessionRegistry;
        const assignments = yield* ReviewAssignmentRegistry.ReviewAssignmentRegistry;
        const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
        const claudeModel = "claude-sonnet-4-6";
        const claudeSelection = { instanceId: claudeInstanceId, model: claudeModel };
        const handle = "restricted-review-assignment";
        const pin = { handle, side: "head", path: "src/app.ts" } as const;
        const reviewServer = McpProviderSession.REVIEW_ASSIGNMENT_MCP_SERVER;
        const reviewTool = McpProviderSession.REVIEW_ASSIGNMENT_TOOL;
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
        // A fake Claude process: the parent stays busy, and the reviewer reads its pin through the
        // credential the session manager issued before it answers.
        const queryRunner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape = {
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
              if (review !== undefined) reviewLaunches.push(options.cwd);
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
                    pin,
                  )
                  .pipe(Effect.orDie);
                yield* Queue.offerAll(sdkMessages, answer(sessionId, `Reviewed ${material}`));
              });
              return {
                messages: Stream.fromQueue(sdkMessages),
                ...(review === undefined
                  ? {}
                  : {
                      inspect: Effect.succeed({
                        model: claudeModel,
                        account: { email: "reviewer@example.com" },
                        mcpServers: [
                          { name: reviewServer, status: "connected", tools: [reviewTool] },
                        ],
                        mcpTools: [
                          { name: `mcp__${reviewServer}__${reviewTool}`, serverName: reviewServer },
                        ],
                        builtinTools: [],
                        memoryFiles: [],
                        agents: [],
                        skills: 0,
                        systemPromptSections: [],
                      }),
                    }),
                offer: () => (review === undefined ? Effect.void : readPin),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                renameSession: () => Effect.void,
                mcpServerStatus: Effect.succeed([]),
                readMcpResource: () => Effect.succeed({ contents: [] }),
                mcpAuthenticate: () => Effect.succeed(null),
                mcpSubmitOAuthCallbackUrl: () => Effect.void,
                reconnectMcpServer: () => Effect.void,
                callMcpTool: () => Effect.die("unused"),
                listPermissionRules: Effect.succeed([]),
                interrupt: Effect.void,
                close: Effect.void,
              } satisfies ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        };
        const adapterOptions = {
          instanceId: claudeInstanceId,
          settings: claudeSettings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
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
          { name: "restricted-claude-review" },
          layerClaudeAdapters,
          { mcp: layerSharedRegistries },
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
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(layerSharedRegistries),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(layerClaudeAdapters.pipe(Layer.provide(McpProviderSessions.layer))),
          Layer.provide(
            ProviderRegistryMock.layer([
              makeProviderSnapshot({
                instanceId: claudeInstanceId,
                driver: ProviderDriverKind.make("claudeAgent"),
                model: claudeModel,
              }),
            ]),
          ),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
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
            commandId: CommandId.make("command:restricted-review-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "Restricted review parent",
            modelSelection: claudeSelection,
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
            modelSelection: claudeSelection,
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
          const recorded: Array<unknown> = [];
          yield* assignments
            .register({
              handle,
              allowedReads: [pin],
              read: async () => new TextEncoder().encode("const answer = 42;\n"),
              record: async (receipt) => void recorded.push(receipt),
            })
            .pipe(Effect.orDie);
          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-restricted-review-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-restricted-review-parent",
              providerInstanceId: claudeInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const delegate = () =>
            server
              .callTool({
                name: "delegate_task",
                arguments: {
                  task: delegatedPrompt,
                  target: { providerInstanceId: claudeInstanceId, model: claudeModel },
                  isolation: { type: "assignment", handle },
                  mode: "async",
                  clientRequestId: "delegate-restricted-review-1",
                },
              })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const startedCall = yield* delegate();
          expect(startedCall.isError).not.toBe(true);
          const started = yield* decodeDelegateTaskResult(startedCall.structuredContent).pipe(
            Effect.orDie,
          );
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
          const statusCall = yield* server
            .callTool({ name: "task_status", arguments: { taskId: started.taskId } })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          const status = yield* decodeDelegateTaskResult(statusCall.structuredContent).pipe(
            Effect.orDie,
          );
          expect(status).toMatchObject({
            status: "completed",
            summary: "Reviewed const answer = 42;\n",
          });
          // The reviewer ran in the assignment's own empty workspace, never the parent's checkout.
          expect(reviewLaunches).toHaveLength(1);
          const reviewCwd = reviewLaunches[0];
          expect(reviewCwd).not.toBe(cwd);
          expect(status.reviewEvidence).toEqual({
            sessions: [
              expect.objectContaining({
                assignmentHandle: handle,
                runId: status.childRunId,
                providerInstanceId: claudeInstanceId,
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
            (yield* delegate()).structuredContent,
          ).pipe(Effect.orDie);
          expect(retried.taskId).toBe(started.taskId);
          expect(retried.reviewEvidence).toEqual(status.reviewEvidence);
        }).pipe(Effect.provide(layerTest));
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(McpSessionRegistry.layer, ReviewAssignmentRegistry.layer).pipe(
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:mcp-replay")),
            }),
          ),
          Layer.provide(NodeHttpServer.layerTest),
          Layer.provideMerge(IdAllocator.layer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
