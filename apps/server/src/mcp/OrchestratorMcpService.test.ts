import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpFailure,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpModelOption,
  OrchestratorMcpTarget,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const encodeCapabilities = Schema.encodeEffect(OrchestratorMcpCapabilitiesResult);
// main before usageLimited: the same fields, with only an optional string reset.
const { usageLimited: _usageLimited, ...shippedFields } = OrchestratorMcpProviderCapability.fields;
const shippedResult = Schema.Struct({
  ...OrchestratorMcpCapabilitiesResult.fields,
  providers: Schema.Array(
    Schema.Struct({
      ...shippedFields,
      limitedUntil: Schema.optional(Schema.String),
      models: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          label: Schema.optional(Schema.String),
          options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
        }),
      ),
    }),
  ),
});
const decodeShippedCapabilities = Schema.decodeEffect(shippedResult);

const decodeTarget = Schema.decodeUnknownEffect(OrchestratorMcpTarget);

const layerOrchestratorServiceWithGit = (git: Partial<GitVcsDriver.GitVcsDriver["Service"]>) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  );
const layerOrchestratorService = layerOrchestratorServiceWithGit({});

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [
          {
            id: RunId.make("run:mcp-restart-child"),
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
          },
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isNull(held.summary);
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("tells the parent to end its turn only while its task still runs", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-next-parent");
      const childThreadId = ThreadId.make("thread:mcp-next-child");
      const taskId = NodeId.make("node:mcp-next-task");
      let finished = false;
      let pendingRequest = false;
      const parentProjection = () =>
        ({
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: finished ? "completed" : "running",
              result: finished ? "done" : null,
              completionDelivery: { state: "pending" },
            },
          ],
        }) as unknown as OrchestrationV2ThreadProjection;
      const childRun = () => ({
        id: RunId.make("run:mcp-next-child"),
        ordinal: 1,
        status: finished ? ("completed" as const) : ("running" as const),
        delegatedTaskId: taskId,
      });
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs: [childRun()],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: pendingRequest ? [{ status: "pending" }] : [],
          nodes: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection() : childProjection()),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getProjectThreadRecords: () => Effect.succeed(childProjection()),
          waitForThread: () =>
            Effect.succeed({
              threadId: childThreadId,
              run: childRun() as unknown as OrchestrationV2ThreadProjection["runs"][number],
              timedOut: !finished,
            }),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-next"),
        requestNamespace: "provider-session:mcp-next",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-next",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const running = yield* service.taskStatus(scope, taskId);
        assert.equal(running.status, "running");
        assert.equal(running.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        const waiting = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(waiting.timedOut);
        assert.equal(waiting.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

        // A child waiting on a question or approval needs an answer, not a wake.
        pendingRequest = true;
        const asking = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(asking.timedOut);
        assert.notProperty(asking, "next");
        pendingRequest = false;

        finished = true;
        const completed = yield* service.taskStatus(scope, taskId);
        assert.equal(completed.status, "completed");
        assert.notProperty(completed, "next");
        const waited = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(waited.status, "completed");
        assert.notProperty(waited, "next");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["no runs", "a finished run"] as const)(
    "cancels an orphaned follow-up through its parent when the child has %s",
    (childState) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-orphan-parent");
        const childThreadId = ThreadId.make("thread:mcp-orphan-child");
        const taskId = NodeId.make("node:mcp-orphan-task");
        const parentRunId = RunId.make("run:mcp-orphan-parent");
        const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
        const status = yield* Ref.make("running");
        const parentProjection = (taskStatus: string) =>
          ({
            thread: { id: parentThreadId },
            runs: [],
            contextTransfers: [],
            subagents: [
              {
                id: taskId,
                threadId: parentThreadId,
                runId: parentRunId,
                origin: "app_owned",
                childThreadId,
                driver: "codex",
                model: "gpt-5.6-terra",
                status: taskStatus,
                result: null,
                completionDelivery: { state: "pending" },
              },
            ],
          }) as unknown as OrchestrationV2ThreadProjection;
        // A finished run whose binding to the follow-up was lost.
        const childProjection = {
          thread: { id: childThreadId, title: "Child" },
          runs:
            childState === "no runs"
              ? []
              : [{ id: RunId.make("run:mcp-orphan-child"), ordinal: 1, status: "completed" }],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              threadId === parentThreadId
                ? Effect.map(Ref.get(status), parentProjection)
                : Effect.succeed(childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            delegatedTaskResultPending: () => Effect.succeed(false),
            stopDelegatedTasks: () => Effect.void,
            // The orchestrator's subagent.stop repair is covered in ThreadStop.test.ts.
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  command.type === "subagent.stop" ? Ref.set(status, "cancelled") : Effect.void,
                ),
                Effect.as({} as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-orphan"),
          requestNamespace: "provider-session:mcp-orphan",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-orphan",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.cancelTask(scope, {
            taskId,
            clientRequestId: "cancel-orphan-task",
          });
          assert.deepEqual(result, { taskId, status: "cancelled" });
          const commands = yield* Ref.get(dispatched);
          // A child whose run finished can still run another turn's work, so it is stopped too.
          assert.deepEqual(
            commands.flatMap((command) =>
              command.type === "thread.stop" ? [command.threadId] : [],
            ),
            childState === "a finished run" ? [childThreadId] : [],
          );
          const stop = commands.find((command) => command.type === "subagent.stop");
          if (stop?.type !== "subagent.stop") return;
          assert.deepEqual(
            { threadId: stop.threadId, runId: stop.runId, subagentId: stop.subagentId },
            { threadId: parentThreadId, runId: parentRunId, subagentId: taskId },
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("disposes the wakes of follow-ups the cancel stops with their child", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-follow-up-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-follow-up-child");
      const taskId = NodeId.make("node:mcp-cancel-follow-up-task");
      const followUpId = NodeId.make("node:mcp-cancel-follow-up");
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const task = (id: NodeId, child: ThreadId, state: string, status: string) => ({
        id,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId: child,
        driver: "codex",
        model: "gpt-5.6-terra",
        status,
        result: null,
        completionDelivery: { state },
      });
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          task(taskId, childThreadId, "acknowledged", "completed"),
          task(followUpId, childThreadId, "pending", "running"),
          task(
            NodeId.make("node:mcp-cancel-follow-up-other"),
            ThreadId.make("thread:mcp-cancel-follow-up-other-child"),
            "pending",
            "running",
          ),
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: RunId.make("run:mcp-cancel-follow-up"), status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-follow-up"),
        requestNamespace: "provider-session:mcp-cancel-follow-up",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-follow-up",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.cancelTask(scope, { taskId, clientRequestId: "cancel-follow-up" });
        assert.deepEqual(
          (yield* Ref.get(dispatched)).flatMap((command) =>
            command.type === "delegated_task.completion-delivery.dispose" ? [command.taskId] : [],
          ),
          [taskId, followUpId],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const appOwnedTask = (id: string, threadId: ThreadId, childId: ThreadId) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        result: null,
        completionDelivery: { state: "pending" },
      });
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [appOwnedTask(taskId, parentThreadId, childThreadId)],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId, title: "Child" },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => Effect.succeed(projections.get(threadId)!),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false
      ? { message: "Provider is disabled in T3.CodeShip settings." }
      : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId, title: "Child" },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect.each([
    "parent completion",
    "nested child completion",
    "child run completion",
    "child question",
    "child approval",
  ] as const)("a task wait still returns on %s", (wake) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const subscribed = yield* Deferred.make<void>();
      const nestedId = NodeId.make("node:mcp-wait-nested");
      const childRunId = RunId.make("run:mcp-wait-child");
      const childRootId = NodeId.make("node:mcp-wait-child-root");
      const eventThreadId = wake === "parent completion" ? parentThreadId : childThreadId;
      const eventType =
        wake === "child run completion"
          ? "run.updated"
          : wake === "child question" || wake === "child approval"
            ? "runtime-request.updated"
            : "subagent.updated";
      const terminal = wake.endsWith("completion");
      let ready = false;
      const task = () => ({
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: ready && terminal ? "completed" : "running",
        result: ready && wake === "parent completion" ? "done" : null,
      });
      const child = () =>
        ({
          ...childProjection,
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status:
                wake === "nested child completion" || (ready && terminal) ? "completed" : "running",
              startedAt: DateTime.makeUnsafe(0),
              completedAt: ready && terminal ? DateTime.makeUnsafe(1) : null,
            },
          ],
          subagents:
            wake === "nested child completion"
              ? [{ id: nestedId, status: ready ? "completed" : "running" }]
              : [],
          nodes: [{ id: childRootId, runId: childRunId }],
          runtimeRequests:
            ready && !terminal
              ? [
                  {
                    id: "request:mcp-wait-answer",
                    nodeId: childRootId,
                    kind: wake === "child question" ? "user_input" : "command",
                    status: "pending",
                    responseCapability: { type: "live" },
                    createdAt: DateTime.makeUnsafe(0),
                  },
                ]
              : [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.sync(() => (threadId === parentThreadId ? parentProjection([task()]) : child())),
          getThreadEventSequence: () => Effect.succeed(0),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.threadId === eventThreadId && input.eventType === eventType
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          dispatch: () =>
            Effect.succeed({
              sequence: 1,
              storedEvents: [{ event: { type: "subagent.updated", payload: task() } }],
            } as never),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        ready = true;
        if (wake === "parent completion") {
          yield* Queue.offer(events, {
            sequence: 2,
            event: {
              type: "subagent.updated",
              threadId: parentThreadId,
              payload: { ...task(), id: nestedId },
            },
          } as unknown as OrchestrationV2StoredEvent);
        }
        yield* Queue.offer(events, {
          sequence: 3,
          event: {
            type: eventType,
            threadId: eventThreadId,
            payload: { id: wake === "parent completion" ? taskId : nestedId },
          },
        } as unknown as OrchestrationV2StoredEvent);
        const result = yield* Fiber.join(waiting);
        assert.isFalse(result.waitTimedOut);
        if (terminal) {
          assert.equal(result.status, "completed");
          if (wake === "parent completion") assert.equal(result.summary, "done");
        } else {
          assert.equal(result.status, "running");
          if (wake === "child question") assert.isTrue(result.hasPendingQuestion);
          else {
            assert.deepEqual(result.pendingApproval, {
              requestId: "request:mcp-wait-answer",
              kind: "command",
              runId: childRunId,
            });
          }
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    { name: "project-disabled", disabled: true },
    { name: "account window", window: "5h" },
    { name: "unknown-reset refusal", refusal: true },
    { name: "known reset", window: "5h", reset: "2099-01-01T00:00:00.000Z" },
    { name: "model window", window: "seven_day_opus" },
    { name: "API key", apiKey: true, window: "5h" },
  ])("capabilities expose $name eligibility", (row) =>
    Effect.gen(function* () {
      const provider: ServerProvider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          model: "claude-opus-5-5",
        }),
        models: ["claude-opus-5-5", "claude-sonnet-5-5"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
        ...("apiKey" in row ? { auth: { status: "authenticated" as const, type: "apiKey" } } : {}),
        ...("window" in row
          ? {
              usageLimits: {
                checkedAt: "2026-11-08T00:00:00Z",
                windows: [
                  {
                    id: row.window!,
                    kind: "weekly" as const,
                    label: "Usage",
                    usedPercent: 100,
                    ...("reset" in row ? { resetsAt: row.reset! } : {}),
                  },
                ],
              },
            }
          : {}),
      };
      const shared = Layer.mergeAll(
        providerRegistryLayer([provider]),
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [projectId]: {
              providerInstances: { [codexInstanceId]: { enabled: !("disabled" in row) } },
            },
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getUsageLimitedProviderInstances: () =>
            Effect.succeed(
              new Map(
                "refusal" in row
                  ? [[codexInstanceId, [{ resetAt: null, refusedAt: "2026-11-08T00:00:00Z" }]]]
                  : [],
              ),
            ),
        }),
      );
      const dependencies = Layer.mergeAll(
        shared,
        AccountRouting.layer.pipe(Layer.provide(shared)),
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const result = yield* (yield* OrchestratorMcpService.OrchestratorMcpService).capabilities(
          scope,
        );
        const account = result.providers[0]!;
        const accountLimited =
          "refusal" in row || ("window" in row && row.window === "5h" && !("apiKey" in row));
        const canRun = !("disabled" in row);
        const constraints = "disabled" in row ? ["Disabled for this project."] : [];
        const until =
          "reset" in row ? row.reset : accountLimited ? "2026-11-08T05:00:00.000Z" : undefined;
        assert.equal(account.canRunChildTask, canRun);
        assert.equal(account.canRunCrossProviderChildTask, canRun);
        assert.deepEqual(account.constraints, constraints);
        assert.equal(account.usageLimited, accountLimited ? true : undefined);
        assert.equal(account.limitedUntil, until);
        assert.deepEqual(
          account.models.map((model) => ({
            id: model.id,
            limited: "usageLimited" in model ? model.usageLimited : undefined,
          })),
          [
            {
              id: "claude-opus-5-5",
              limited: "window" in row && row.window === "seven_day_opus" ? true : undefined,
            },
            { id: "claude-sonnet-5-5", limited: undefined },
          ],
        );
        const encoded = yield* encodeCapabilities(result);
        const older = yield* decodeShippedCapabilities(encoded);
        assert.equal(older.providers[0]!.canRunChildTask, canRun);
        assert.equal(older.providers[0]!.canRunCrossProviderChildTask, canRun);
        assert.deepEqual(older.providers[0]!.constraints, constraints);
        assert.equal(older.providers[0]!.limitedUntil, until);
        assert.notProperty(older.providers[0]!, "usageLimited");
        for (const model of older.providers[0]!.models) assert.notProperty(model, "usageLimited");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest({
            providerInstances: Object.fromEntries(
              providers.map((provider) => [
                provider.instanceId,
                { driver: provider.driver, enabled: provider.enabled },
              ]),
            ),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          AccountRouting.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSettings.layerTest({
                  providerInstances: Object.fromEntries(
                    providers.map((provider) => [
                      provider.instanceId,
                      { driver: provider.driver, enabled: provider.enabled },
                    ]),
                  ),
                }),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getUsageLimitedProviderInstances: () => Effect.succeed(new Map()),
                }),
                Layer.mock(ProviderRegistry.ProviderRegistry)({
                  getProviders: Effect.succeed(
                    providers.map((provider) =>
                      provider.instanceId === codexInstanceId
                        ? {
                            ...provider,
                            usageLimits: {
                              checkedAt: "2026-11-08T00:00:00Z",
                              windows: [
                                {
                                  id: "5h",
                                  kind: "session" as const,
                                  label: "Session",
                                  usedPercent: 100,
                                },
                              ],
                            },
                          }
                        : provider,
                    ),
                  ),
                }),
              ),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          assert.deepEqual(
            capabilities.providers.flatMap((provider) =>
              provider.usageLimited === true
                ? [[provider.providerInstanceId, provider.limitedUntil]]
                : [],
            ),
            [[codexInstanceId, "2026-11-08T05:00:00.000Z"]],
          );
          const encoded = yield* encodeCapabilities(capabilities);
          assert.isTrue(
            encoded.providers.find((provider) => provider.providerInstanceId === codexInstanceId)
              ?.usageLimited,
          );
          assert.equal(
            encoded.providers.find((provider) => provider.providerInstanceId === codexInstanceId)
              ?.limitedUntil,
            "2026-11-08T05:00:00.000Z",
          );
          const decodedByOlderMachine = yield* decodeShippedCapabilities(encoded);
          assert.notProperty(
            decodedByOlderMachine.providers.find(
              (provider) => provider.providerInstanceId === codexInstanceId,
            ),
            "usageLimited",
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(entry!.canRunChildTask);
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  describe("listed models", () => {
    const opencodeInstanceId = ProviderInstanceId.make("opencode");
    const model = (slug: string, extra: Partial<ServerProvider["models"][number]> = {}) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...extra,
    });
    const opencodeSlugs = Array.from(
      { length: 12 },
      (_, index) => `oc/m${String(index + 1).padStart(2, "0")}`,
    );
    const catalog: ReadonlyArray<ServerProvider> = [
      {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        displayName: "Codex",
        models: [
          model("gpt-6", {
            name: "Sol",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  description: "How hard the model thinks.",
                  type: "select",
                  options: [
                    { id: "low", label: "Low", description: "Fast." },
                    { id: "high", label: "High", isDefault: true },
                  ],
                  promptInjectedValues: ["high"],
                },
                { id: "fastMode", label: "Fast", type: "boolean" },
                {
                  id: "agent",
                  label: "Agent",
                  type: "select",
                  options: [{ id: "build", label: "Build" }],
                  currentValue: "build",
                },
              ],
            },
          }),
          model("gpt-5", { name: "Code Legacy", isLegacy: true }),
          model("gpt-4", { isLegacy: true }),
          model("gpt-3", { name: "GPT-3", isLegacy: true }),
          model("my-alpha", { isCustom: true }),
        ],
      },
      {
        ...providerSnapshot({
          instanceId: opencodeInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        models: [
          ...opencodeSlugs.map((slug) => model(slug, { isLegacy: slug === "oc/m03" })),
          model("oc-custom", { isCustom: true }),
        ],
      },
    ];

    const capabilitiesWith = (search?: string) =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope, search === undefined ? {} : { search });
      }).pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed(
                      parentProjection([], { instanceId: codexInstanceId, model: "gpt-3" }),
                    ),
                }),
                ServerSettings.layerTest({
                  favorites: [
                    { provider: codexInstanceId, model: "gpt-4" },
                    { provider: opencodeInstanceId, model: "oc/m10" },
                  ],
                  providerModelPreferences: {
                    [opencodeInstanceId]: { hiddenModels: ["oc/m02"], modelOrder: ["oc/m12"] },
                  },
                }),
                providerRegistryLayer(catalog),
                adapterRegistryLayer([codexInstanceId, opencodeInstanceId]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );

    const listing = (capabilities: OrchestratorMcpCapabilitiesResult) =>
      capabilities.providers.map((provider) => ({
        id: provider.providerInstanceId,
        models: provider.models.map((entry) => entry.id),
        omitted: provider.omittedModels ?? 0,
      }));

    it.effect(
      "skips legacy models, lists the first 8 of large catalogs, and keeps pinned models",
      () =>
        Effect.gen(function* () {
          assert.deepEqual(listing(yield* capabilitiesWith()), [
            // gpt-4 is a favorite and gpt-3 is the caller's model; legacy gpt-5 is left out.
            { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
            {
              id: opencodeInstanceId,
              models: [
                "oc/m12",
                "oc/m01",
                "oc/m04",
                "oc/m05",
                "oc/m06",
                "oc/m07",
                "oc/m08",
                "oc/m09",
                "oc/m10",
                "oc-custom",
              ],
              omitted: 2,
            },
          ]);
        }),
    );

    it.effect("search matches every word and caps each provider's matches", () =>
      Effect.gen(function* () {
        assert.deepEqual(listing(yield* capabilitiesWith("GPT 5")), [
          { id: codexInstanceId, models: ["gpt-5"], omitted: 0 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        const opencode = listing(yield* capabilitiesWith("oc/m"))[1];
        assert.deepEqual(opencode, {
          id: opencodeInstanceId,
          models: ["oc/m12", "oc/m01", "oc/m03", "oc/m04", "oc/m05", "oc/m06", "oc/m07", "oc/m08"],
          omitted: 3,
        });
        // A word naming the provider matches all its models, so legacy ones stay out.
        assert.deepEqual(listing(yield* capabilitiesWith("Codex")), [
          { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        assert.deepEqual(listing(yield* capabilitiesWith(" ")), listing(yield* capabilitiesWith()));
        for (const search of ["code", "codex code", "  CODE  "]) {
          assert.deepEqual(listing(yield* capabilitiesWith(search))[0], {
            id: codexInstanceId,
            models: ["gpt-5"],
            omitted: 0,
          });
        }
        assert.deepEqual(
          listing(yield* capabilitiesWith("open"))[1],
          listing(yield* capabilitiesWith())[1],
        );
        assert.deepEqual(listing(yield* capabilitiesWith("codex gpt 5"))[0], {
          id: codexInstanceId,
          models: ["gpt-5"],
          omitted: 0,
        });
      }),
    );

    it.effect("describes models by id, distinct label, and option values", () =>
      Effect.gen(function* () {
        const codex = (yield* capabilitiesWith()).providers[0];
        assert.deepEqual(codex?.models.slice(0, 4), [
          {
            id: "gpt-6",
            label: "Sol",
            options: [
              { id: "effort", values: ["low", "high"], default: "high" },
              { id: "fastMode", values: [false, true] },
              { id: "agent", values: ["build"], default: "build" },
            ],
          },
          { id: "gpt-4" },
          { id: "gpt-3" },
          { id: "my-alpha" },
        ]);
      }),
    );
  });

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    { name: "project-disabled", disabled: true },
    { name: "account exhausted", window: "5h" },
    { name: "requested model exhausted", window: "seven_day_opus", explicit: true },
    { name: "inherited model exhausted", window: "seven_day_opus" },
    { name: "all accounts exhausted", window: "5h", allLimited: true },
    { name: "unknown-reset refusals", unknownReset: true, allLimited: true },
    {
      name: "inherited unknown-reset refusal",
      unknownReset: true,
      allLimited: true,
      inherited: true,
    },
    {
      name: "role default unknown-reset refusal",
      unknownReset: true,
      allLimited: true,
      roleDefault: true,
    },
    {
      name: "explicit account refuses recent unknown reset",
      unknownReset: true,
      namedAccount: true,
      allLimited: true,
    },
    { name: "subscription before API key", window: "5h", apiKey: true },
    { name: "saved failover order", window: "5h", ordered: true },
  ])("delegation checks $name", (row) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-08T00:03:00Z"));
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const driver = ProviderDriverKind.make("claudeAgent");
      const model = "claude-opus-5-5";
      const paidId = ProviderInstanceId.make("paid");
      const accounts = [
        codexInstanceId,
        ...("apiKey" in row || "ordered" in row ? [paidId] : []),
        altInstanceId,
      ].map((instanceId): ServerProvider => ({
        ...providerSnapshot({ instanceId, driver, model }),
        models: ["claude-sonnet-5-5", model].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
        ...(instanceId === paidId && "apiKey" in row
          ? { auth: { status: "authenticated" as const, type: "apiKey" } }
          : {}),
        ...(("window" in row || "unknownReset" in row) &&
        (instanceId === codexInstanceId || "allLimited" in row)
          ? {
              usageLimits: {
                checkedAt: "2026-11-08T00:00:00Z",
                windows: [
                  {
                    id: "window" in row ? row.window! : "5h",
                    kind: "weekly" as const,
                    label: "Usage",
                    usedPercent: "unknownReset" in row ? 10 : 100,
                  },
                ],
              },
            }
          : {}),
      }));
      const shared = Layer.mergeAll(
        providerRegistryLayer(accounts),
        ServerSettings.layerTest({
          providerInstances: Object.fromEntries(
            accounts.map((account) => [account.instanceId, { driver, enabled: true }]),
          ),
          ...("roleDefault" in row
            ? { delegatedTaskModelSelections: { general: { instanceId: altInstanceId, model } } }
            : {}),
          providerInstanceFailoverOrder:
            "ordered" in row
              ? [codexInstanceId, altInstanceId, paidId]
              : [codexInstanceId, paidId, altInstanceId],
          projectSettingsOverrides: {
            [projectId]: {
              providerInstances: { [codexInstanceId]: { enabled: !("disabled" in row) } },
            },
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getUsageLimitedProviderInstances: () =>
            Effect.succeed(
              new Map(
                "unknownReset" in row
                  ? accounts.map((account) => [
                      account.instanceId,
                      [{ resetAt: null, refusedAt: "2026-11-08T00:01:00Z" }],
                    ])
                  : [],
              ),
            ),
        }),
      );
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [], { instanceId: codexInstanceId, model })
                : childProjection,
            ),
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId || !("disabled" in row)),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId && "disabled" in row
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        shared,
        AccountRouting.layer.pipe(Layer.provide(shared)),
        adapterRegistryLayer(accounts.map((account) => account.instanceId)),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const request = service.delegateTask(scope, {
          task: "Summarize the diff.",
          ...("inherited" in row || "roleDefault" in row
            ? {}
            : {
                target:
                  "namedAccount" in row
                    ? { providerInstanceId: codexInstanceId }
                    : { driverKind: driver, ...("explicit" in row ? { model } : {}) },
              }),
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        if ("allLimited" in row) {
          const error = yield* Effect.flip(request);
          assert.equal(error.code, "provider_unavailable");
          assert.include(error.message, "usage-limited");
          assert.equal((yield* Ref.get(dispatched)).length, 0);
          return;
        }
        const result = yield* request;
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const command = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(
          command.modelSelection.instanceId,
          "namedAccount" in row ? codexInstanceId : altInstanceId,
        );
        assert.equal(command.modelSelection.model, "disabled" in row ? "claude-sonnet-5-5" : model);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    { name: "inherited account", alternateModel: false },
    { name: "only account advertising the model", alternateModel: true },
  ])(
    "retrying an accepted driver-only delegation preserves the $name after candidates are disabled or limited",
    ({ alternateModel }) =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const selection = {
          instanceId: alternateModel ? altInstanceId : codexInstanceId,
          model: alternateModel ? "gpt-5.5" : "gpt-5.4",
        };
        const target = { driverKind: ProviderDriverKind.make("codex"), model: selection.model };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const limit = yield* Ref.make<AccountRouting.LaunchLimit | null>(null);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: selection.instanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: selection.model,
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            getThreadShell: (id) =>
              Effect.gen(function* () {
                const command = (yield* Ref.get(dispatched))[0] as { commandId: CommandId };
                assert.equal(id, derive.delegatedTaskThread({ commandId: command.commandId }));
                return { ...liveThreadShell(id), modelSelection: selection };
              }),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: selection.model,
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(AccountRouting.AccountRouting)({
            launchLimit: () => Ref.get(limit),
            accountsWithRoom: () =>
              Ref.get(limit).pipe(Effect.map((limited) => (limited === null ? [selection] : []))),
          }),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target,
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");
          assert.equal(first.providerInstanceId, selection.instanceId);
          assert.equal(first.model, selection.model);
          assert.equal(first.childThreadId, childThreadId);
          const firstCommand = (yield* Ref.get(dispatched))[0] as {
            modelSelection: ModelSelection;
          };
          assert.deepEqual(firstCommand.modelSelection, selection);

          assert.deepEqual(
            yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: "delegate-driver-retry-after-disable-1",
            }),
            first,
          );

          yield* Ref.set(everyCandidateDisabled, true);
          yield* Ref.set(limit, {
            instanceId: selection.instanceId,
            limitedUntil: "2026-11-04T06:33:00.000Z",
          });

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target,
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.deepEqual(retry, first);

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 3);
          const retryCommand = commands[2] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.deepEqual(retryCommand.modelSelection, selection);

          // New work onto the limited account fails before a thread exists.
          yield* Ref.set(everyCandidateDisabled, false);
          yield* Ref.set(accepted, false);
          const limited = yield* service
            .delegateTask(scope, {
              task: "Summarize the diff.",
              target: { ...target, providerInstanceId: selection.instanceId },
              mode: "async",
              clientRequestId: "delegate-driver-retry-after-disable-2",
            })
            .pipe(Effect.flip);
          assert.equal(limited.code, "provider_unavailable");
          assert.include(limited.message, "2026-11-04T06:33:00.000Z");
          assert.equal((yield* Ref.get(dispatched)).length, 3);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.live.each([
    { name: "parent instance", parentEnabled: true, model: "gpt-5.4" },
    { name: "alternate instance", parentEnabled: false, model: "gpt-5.5" },
  ])(
    "replays accepted creation on the $name without authorizing new disabled work",
    ({ parentEnabled, model }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const altInstanceId = ProviderInstanceId.make("codex-alt");
          const driver = ProviderDriverKind.make("codex");
          const cwd = yield* checkpointWorkspace("mcp-create-retry");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
            [codexInstanceId, altInstanceId].map((instanceId) => ({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.die("These tests exercise committed commands before provider execution."),
            })),
          );
          const limit = yield* Ref.make<AccountRouting.LaunchLimit | null>(null);
          const layerDatabase = SqlitePersistence.layerMemory;
          const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
            { name: "mcp-create-retry", runtimePolicyOverride: { cwd } },
            layerRegistry,
            { databaseLayer: layerDatabase, runEffectWorker: false },
          );
          const layerSettings = ServerSettings.layerTest({
            providerInstances: {
              [codexInstanceId]: { driver: "codex", enabled: true },
              [altInstanceId]: { driver: "codex", enabled: true },
            },
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [codexInstanceId]: { enabled: parentEnabled } } },
            },
          });
          const layerThreads = ThreadManagementService.layer.pipe(
            Layer.provideMerge(layerOrchestrator),
            Layer.provide(
              LegacyV1ThreadImporter.layer.pipe(
                Layer.provide(layerOrchestrator),
                Layer.provide(layerDatabase),
              ),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
            Layer.provideMerge(layerSettings),
          );
          const layerTest = layerOrchestratorService.pipe(
            Layer.provideMerge(layerThreads),
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                layerRegistry,
                layerSettings,
                providerRegistryLayer([
                  providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                  providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
                ]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                Layer.mock(AccountRouting.AccountRouting)({
                  launchLimit: () => Ref.get(limit),
                  accountsWithRoom: () => Effect.succeed([]),
                }),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              runtimeMode: "auto",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("parent:message"),
              text: "Create a thread.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const request = {
              threads: [{ target: { driverKind: driver, model } }],
              clientRequestId: "create-retry",
            };
            const first = yield* service.createThreads(scope, request);
            const child = first.threads[0]!;
            const selection = parentEnabled
              ? { instanceId: codexInstanceId, model: "gpt-5.4" }
              : { instanceId: altInstanceId, model: "gpt-5.5" };
            assert.equal(first.threads.length, 1);
            assert.equal(child.providerInstanceId, selection.instanceId);
            assert.equal(child.model, selection.model);
            assert.deepEqual(yield* service.createThreads(scope, request), first);

            // A usage limit refuses new threads but not the replay of an accepted one.
            yield* Ref.set(limit, {
              instanceId: selection.instanceId,
              limitedUntil: "2026-11-04T06:33:00.000Z",
            });
            assert.deepEqual(yield* service.createThreads(scope, request), first);
            const limited = yield* service
              .createThreads(scope, { ...request, clientRequestId: "limited" })
              .pipe(Effect.flip);
            assert.equal(limited.code, "provider_unavailable");
            assert.match(limited.message, /^Thread 1: .*2026-11-04T06:33:00.000Z/);
            yield* Ref.set(limit, null);

            // The creation receipt exists, but this prompt has not been accepted yet.
            const withPrompt = {
              ...request,
              threads: [{ ...request.threads[0]!, prompt: "Start work." }],
            };
            const started = yield* service.createThreads(scope, withPrompt);
            assert.equal(started.threads[0]?.threadId, child.threadId);
            const before = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(before.runs[0]?.modelSelection, selection);
            assert.equal(before.messages.length, 1);
            const empty = yield* service.createThreads(scope, {
              ...request,
              clientRequestId: "empty",
            });

            // The user raised this thread above the caller after its creation.
            const raised = yield* service.createThreads(scope, {
              ...request,
              clientRequestId: "raised",
            });
            const raisedThreadId = raised.threads[0]!.threadId;
            yield* orchestrator.dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("user-raise"),
              threadId: raisedThreadId,
              runtimeMode: "full-access",
            });
            const raisedError = yield* service
              .createThreads(scope, { ...withPrompt, clientRequestId: "raised" })
              .pipe(Effect.flip);
            assert.equal(raisedError.code, "runtime_mode_escalation_denied");
            const unprompted = yield* orchestrator.getThreadProjection(raisedThreadId);
            assert.equal(unprompted.messages.length, 0);
            assert.equal(unprompted.runs.length, 0);

            yield* settings.updateSettings({
              projectSettingsOverrides: {
                [projectId]: {
                  providerInstances: {
                    [codexInstanceId]: { enabled: false },
                    [altInstanceId]: { enabled: false },
                  },
                },
              },
            });
            assert.deepEqual(yield* service.createThreads(scope, withPrompt), started);
            const after = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(after.thread.modelSelection, selection);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);

            const freshError = yield* service
              .createThreads(scope, {
                ...request,
                clientRequestId: "fresh",
              })
              .pipe(Effect.flip);
            assert.equal(freshError.code, "provider_unavailable");
            const promptError = yield* service
              .createThreads(scope, {
                ...withPrompt,
                clientRequestId: "empty",
              })
              .pipe(Effect.flip);
            assert.equal(promptError.code, "invalid_request");
            assert.include(promptError.message, "disabled");
            const untouched = yield* orchestrator.getThreadProjection(empty.threads[0]!.threadId);
            assert.equal(untouched.messages.length, 0);
            assert.equal(untouched.runs.length, 0);
          }).pipe(Effect.provide(layerTest));
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            Layer.mock(AccountRouting.AccountRouting)({
              launchLimit: () => Effect.succeed(null),
              accountsWithRoom: () =>
                Effect.succeed([
                  ...(testCase.peerEnabled
                    ? [{ instanceId: codexAltInstanceId, model: "codex-alt-model" }]
                    : []),
                  ...(testCase.inheritedEnabled
                    ? [{ instanceId: codexInstanceId, model: "gpt-5.4" }]
                    : []),
                ]),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeedSome({
                  id,
                  title: "Agent config",
                  workspaceRoot: "/repos/agent-config",
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.equal(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.equal(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
              const elsewhere = ProjectId.make("project:elsewhere");
              const shared = yield* service
                .delegateTask(scope, {
                  task: "Change the other repository.",
                  target: { projectId: elsewhere },
                  clientRequestId: "delegate-foreign-shared",
                })
                .pipe(Effect.flip);
              assert.equal(shared.code, "invalid_request");
              assert.include(shared.message, 'isolation "worktree"');
              assert.equal((yield* Ref.get(dispatched)).length, 1);
              yield* service.delegateTask(scope, {
                task: "Change the other repository.",
                target: { projectId: elsewhere },
                isolation: "worktree",
                clientRequestId: "delegate-foreign-worktree",
              });
              const foreign = (yield* Ref.get(dispatched))[1] as {
                projectId?: string;
                workspaceStrategy?: unknown;
              };
              assert.equal(foreign.projectId, elsewhere);
              assert.deepEqual(foreign.workspaceStrategy, {
                type: "worktree",
                baseRef: "main",
                startFromOrigin: true,
              });
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(
            Effect.provide(
              layerOrchestratorServiceWithGit({
                resolvePrimaryRemoteName: () =>
                  Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.test",
                      command: "git",
                      cwd: "/repos/agent-config",
                      detail: "No git remote is configured.",
                    }),
                  ),
                resolveCommit: ({ revision }) =>
                  revision === "refs/heads/main"
                    ? Effect.succeed({ commitSha: "abc123" })
                    : Effect.fail(
                        new GitCommandError({
                          operation: "GitVcsDriver.test",
                          command: "git",
                          cwd: "/repos/agent-config",
                          detail: "Needed a single revision",
                        }),
                      ),
              }).pipe(Layer.provide(layerDependencies)),
            ),
          );
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        assert.equal(listed.tasks[0]?.prompt, undefined);
        assert.equal(listed.tasks[0]?.promptHash?.length, 12);
        const withPrompt = yield* mcp.listScheduledTasks(supervisedClient, {
          projectId,
          includePrompt: true,
        });
        assert.equal(typeof withPrompt.tasks[0]?.prompt, "string");
        const one = yield* mcp.listScheduledTasks(supervisedClient, {
          scheduledTaskId: bound.id,
        });
        assert.deepStrictEqual(
          one.tasks.map((task) => [task.scheduledTaskId, task.prompt]),
          [[bound.id, bound.prompt]],
        );
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("refuses a replayed create over a task the user raised", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
        const upserted = yield* Ref.make(0);
        const project = {
          id: projectId,
          title: "Scheduled",
          workspaceRoot: "/tmp/scheduled",
          defaultModelSelection: task({}).modelSelection,
          scripts: [],
          createdAt: "2026-10-05T00:00:00.000Z",
          updatedAt: "2026-10-05T00:00:00.000Z",
          deletedAt: null,
        } as Project;
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            OrchestratorMcpService.layer.pipe(
              Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
              Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
              // An unbound task starts in a worktree from the project's default branch.
              Layer.provide(
                Layer.mock(GitVcsDriver.GitVcsDriver)({
                  resolvePrimaryRemoteName: () => Effect.succeed("origin"),
                  resolveDefaultBranchName: () => Effect.succeed("main"),
                  resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
                }),
              ),
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () => Effect.succeedSome(project),
                  }),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.map(Ref.get(saved), (tasks) => ({ tasks })),
                    upsert: (input) =>
                      Effect.gen(function* () {
                        yield* Ref.update(upserted, (count) => count + 1);
                        const saving = task({
                          ...(input.id === undefined ? {} : { id: input.id }),
                          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                          runtimeMode: input.runtimeMode,
                          interactionMode: input.interactionMode,
                          ...(input.placement === undefined ? {} : { placement: input.placement }),
                        });
                        yield* Ref.set(saved, [saving]);
                        return { task: saving };
                      }),
                  }),
                ),
              ),
            ),
          ),
        );
        const request = {
          projectId,
          prompt: "Check in",
          schedule: { type: "interval", everyMs: 3_600_000 },
          clientRequestId: "schedule-retry",
          placement: "pinned",
        } as const;
        assert.equal((yield* mcp.scheduleTask(supervisedClient, request)).placement, "pinned");
        yield* Ref.update(saved, (tasks) =>
          tasks.map((task) => ({ ...task, runtimeMode: "full-access" as const })),
        );
        const error = yield* mcp.scheduleTask(supervisedClient, request).pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 1);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });

  describe("the base branch of an unbound scheduled task", () => {
    const projectId = ProjectId.make("project:scheduled-base");
    const workspaceRoot = "/repo/scheduled-base";
    const existing: ScheduledTask = {
      id: ScheduledTaskId.make("scheduled-task:base"),
      title: "Nightly",
      prompt: "Check the build",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled-base"),
      requestNamespace: "client:scheduled-base",
      thread: undefined,
      client: {
        sessionId: "scheduled-base",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
      saved: Ref.Ref<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>,
      listed: ReadonlyArray<ScheduledTask> = [existing],
      threads: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
      tasks: Partial<ScheduledTaskService.ScheduledTaskService["Service"]> = {},
      providers: ReadonlyArray<ServerProvider> = [],
      linked: ReadonlyArray<EnvironmentId> = [],
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            listStored: Effect.succeed(linked.map((environmentId) => ({ environmentId }) as never)),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)(threads),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  id: projectId,
                  workspaceRoot,
                  defaultModelSelection: existing.modelSelection,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: listed }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.as({ task: existing }),
                ),
              ...tasks,
            }),
          ),
        ),
      );
    const masterRepository: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: (cwd, remoteName) =>
        Effect.succeed(cwd === workspaceRoot && remoteName === "origin" ? "master" : null),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    };
    const schedule = { type: "interval", everyMs: 3_600_000 } as const;

    it.effect(
      "updates a scheduled task's own model and restores the default without overwriting it",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const own = existing.modelSelection;
          const defaultModel = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-default",
          };
          const selected = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-explicit",
            options: [{ id: "reasoningEffort", value: "high" }],
            autoAccount: true,
          };
          const stored = yield* Ref.make<ScheduledTask>({ ...existing, followsDefaultModel: true });
          const effective = (task: ScheduledTask) =>
            task.followsDefaultModel ? { ...task, modelSelection: defaultModel } : task;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                [],
                {},
                {
                  list: (options) =>
                    Ref.get(stored).pipe(
                      Effect.map((task) => ({
                        tasks: [options?.resolveModels === false ? task : effective(task)],
                      })),
                    ),
                  upsert: (input) =>
                    Ref.updateAndGet(stored, (task) => ({
                      ...task,
                      title: input.title,
                      modelSelection: input.modelSelection,
                      followsDefaultModel: input.followsDefaultModel ?? task.followsDefaultModel,
                    })).pipe(Effect.map((task) => ({ task: effective(task) }))),
                },
                [
                  {
                    instanceId: selected.instanceId,
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    installed: true,
                    status: "ready",
                    version: null,
                    auth: { status: "authenticated" },
                    checkedAt: "2026-11-08T00:00:00Z",
                    models: [selected.model, own.model].map((slug) => ({
                      slug,
                      name: slug,
                      isCustom: false,
                      capabilities: null,
                    })),
                    slashCommands: [],
                    skills: [],
                  },
                ],
              ),
            ),
          );
          yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            title: "Renamed",
          });
          assert.deepEqual((yield* Ref.get(stored)).modelSelection, own);
          assert.equal((yield* Ref.get(stored)).followsDefaultModel, true);
          const changed = yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            modelSelection: selected,
          });
          assert.deepEqual(changed.modelSelection, selected);
          assert.equal(changed.followsDefaultModel, false);
          const restored = yield* mcp.updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            followsDefaultModel: true,
          });
          assert.deepEqual(restored.modelSelection, defaultModel);
          assert.equal(restored.followsDefaultModel, true);
          assert.deepEqual((yield* Ref.get(stored)).modelSelection, selected);
          const listed = yield* mcp.listScheduledTasks(client, {});
          assert.deepEqual(listed.tasks[0]?.modelSelection, defaultModel);
          const retained = yield* mcp
            .updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              modelSelection: own,
              followsDefaultModel: true,
            })
            .pipe(Effect.flip);
          const conflictingCreate = yield* mcp
            .scheduleTask(client, {
              projectId,
              prompt: "Run checks",
              schedule,
              modelSelection: own,
              followsDefaultModel: true,
            })
            .pipe(Effect.flip);
          assert.equal(conflictingCreate.code, "invalid_request");
          assert.include(conflictingCreate.message, "followsDefaultModel");
          assert.equal(retained.code, "invalid_request");
          assert.include(retained.message, "followsDefaultModel");
          assert.deepEqual((yield* Ref.get(stored)).modelSelection, selected);
        }),
    );

    it.effect.each(
      [
        { model: "gpt-5", options: [], code: "model_unavailable", catalog: "missing" },
        { model: "gpt-5", options: [], code: "model_unavailable", catalog: "empty" },
        { model: "typo", options: [], code: "model_unavailable" },
        { model: "gpt-5", options: [{ id: "effort", value: "invalid" }], code: "invalid_request" },
        { model: "gpt-5", options: [{ id: "bogus", value: "high" }], code: "invalid_request" },
        {
          model: "gpt-5",
          options: [
            { id: "effort", value: "high" },
            { id: "effort", value: "high" },
          ],
          code: "invalid_request",
        },
      ].flatMap((row) => ["create", "update"].map((operation) => ({ ...row, operation }))),
    )(
      "refuses $operation of an unverifiable scheduled model: $catalog $model $options",
      ({ model, options, code, catalog, operation }) =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const provider: ServerProvider = {
            instanceId: existing.modelSelection.instanceId,
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-11-08T00:00:00.000Z",
            models: [
              {
                slug: "gpt-5",
                name: "GPT",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Effort",
                      type: "select",
                      options: [{ id: "high", label: "High" }],
                    },
                  ],
                },
              },
            ],
            slashCommands: [],
            skills: [],
          };
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                [existing],
                {},
                {},
                catalog === "missing"
                  ? []
                  : [{ ...provider, models: catalog === "empty" ? [] : provider.models }],
              ),
            ),
          );
          const modelSelection = {
            instanceId: provider.instanceId,
            model,
            options,
            autoAccount: true,
          };
          const result =
            operation === "update"
              ? mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, modelSelection })
              : mcp.scheduleTask(client, {
                  projectId,
                  prompt: "Run checks",
                  schedule,
                  modelSelection,
                });
          assert.equal((yield* result.pipe(Effect.flip)).code, code);
          assert.deepEqual(
            (yield* mcp.listScheduledTasks(client, {})).tasks[0]?.modelSelection,
            existing.modelSelection,
          );
          assert.deepEqual(yield* Ref.get(saved), []);
        }),
    );

    it.effect("refuses a model override for a task bound to a thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const boundId = ThreadId.make("thread:bound-model");
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(masterRepository, saved, [{ ...existing, threadId: boundId }], {
              getThreadShell: () =>
                Effect.succeed(liveThreadShell(boundId, { runtimeMode: "approval-required" })),
            }),
          ),
        );
        const error = yield* mcp
          .updateScheduledTask(client, {
            scheduledTaskId: existing.id,
            modelSelection: existing.modelSelection,
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "bound to a thread");
        assert.deepEqual(yield* Ref.get(saved), []);
      }),
    );

    it.effect("starts from the project's default branch", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect("saves a group, keeps it when an update leaves it out, and clears it on null", () =>
      Effect.gen(function* () {
        const stored = yield* Ref.make(existing);
        const groups = yield* Ref.make<ReadonlyArray<string | null | undefined>>([]);
        const tasks: Partial<ScheduledTaskService.ScheduledTaskService["Service"]> = {
          list: () => Ref.get(stored).pipe(Effect.map((task) => ({ tasks: [task] }))),
          upsert: (input) =>
            Ref.update(groups, (saved) => [...saved, input.group]).pipe(
              Effect.andThen(
                Ref.updateAndGet(stored, (task) =>
                  input.group === undefined ? task : { ...task, group: input.group },
                ),
              ),
              Effect.map((task) => ({ task })),
            ),
        };
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved, [], {}, tasks)),
        );
        const created = yield* mcp.scheduleTask(client, {
          projectId,
          prompt: "Check the build",
          schedule,
          group: "Machine care",
        });
        const id = created.scheduledTaskId;
        const renamed = yield* mcp.updateScheduledTask(client, { scheduledTaskId: id, title: "R" });
        const cleared = yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: id,
          group: null,
        });
        assert.deepEqual(
          [created.group, renamed.group, "group" in cleared],
          ["Machine care", "Machine care", false],
        );
        assert.deepEqual(yield* Ref.get(groups), ["Machine care", undefined, null]);
      }),
    );

    it.effect.each([
      { name: "never run", task: {}, runStatus: undefined, outcome: null },
      {
        name: "still running",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "running" },
        runStatus: undefined,
        outcome: "working",
      },
      {
        name: "failed to start",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "failed" },
        runStatus: undefined,
        outcome: "failed",
      },
      {
        name: "started, thread still going",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "waiting",
        outcome: "working",
      },
      {
        name: "started, thread completed",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "completed",
        outcome: "completed",
      },
      {
        name: "started, thread failed",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "failed",
        outcome: "failed",
      },
      {
        name: "started, thread stopped by a user or agent",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "interrupted",
        stopRequested: true,
        outcome: "failed",
      },
      {
        name: "started, thread cut off by a restart that will continue it",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "interrupted",
        continues: true,
        outcome: "working",
      },
      {
        name: "started, thread gone",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: undefined,
        outcome: "completed",
      },
      {
        name: "completed, then its run condition is checking the next one",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          runCheckStartedAt: "2026-10-06T01:00:00.000Z",
        },
        runStatus: "completed",
        checkingSince: "2026-10-06T01:00:00.000Z",
        outcome: "completed",
      },
      {
        name: "completed, then its run condition found no work and was cleared",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          runCondition: null,
          lastNoWorkSkip: {
            at: "2026-10-06T01:00:00.000Z",
            scheduledFor: "2026-10-06T01:00:00.000Z",
            reason: "No open pull requests",
          },
        },
        runStatus: "completed",
        outcome: "completed",
      },
      {
        name: "never run, its run condition checking",
        task: { runCheckStartedAt: "2026-10-05T01:00:00.000Z" },
        runStatus: undefined,
        checkingSince: "2026-10-05T01:00:00.000Z",
        outcome: null,
      },
      {
        name: "started after an earlier skip",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          lastNoWorkSkip: { at: "2026-10-04T01:00:00.000Z", scheduledFor: null, reason: null },
        },
        runStatus: "failed",
        outcome: "failed",
      },
    ])(
      "reports the last run as $outcome when it was $name",
      ({ task, runStatus, outcome, checkingSince, ...row }) =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const listed: ScheduledTask = {
            ...existing,
            ...task,
            lastRunThreadId: ThreadId.make("thread:last-run"),
          } as ScheduledTask;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(masterRepository, saved, [listed], {
                getThreadRecords: (_threadId, records) =>
                  runStatus === undefined
                    ? Effect.fail("thread is gone" as never)
                    : (records as ReadonlyArray<string>).includes("turnItems")
                      ? Effect.succeed({
                          turnItems:
                            "stopRequested" in row ? [{ type: "run_interrupt_request" }] : [],
                        } as never)
                      : Effect.succeed({
                          runs: [{ ordinal: 1, status: runStatus, threadId: "thread:last-run" }],
                        } as never),
                restartContinuationPending: () =>
                  Effect.succeed("continues" in row && row.continues === true),
              }),
            ),
          );
          const { tasks } = yield* mcp.listScheduledTasks(client, { projectId });
          assert.deepEqual<unknown>(
            tasks[0]?.lastRun,
            outcome === null
              ? null
              : {
                  at: "2026-10-05T01:00:00.000Z",
                  outcome,
                  ...("stopRequested" in row ? { stopped: true } : {}),
                },
          );
          assert.equal(tasks[0]?.checkingSince, checkingSince);
          assert.deepEqual(
            tasks[0]?.lastSkipped,
            "lastNoWorkSkip" in task ? task.lastNoWorkSkip : undefined,
          );
        }),
    );

    it.effect(
      "sets and clears a run condition for a full-access caller only, and lists what it did",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const saves = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          const here = EnvironmentId.make("environment:here");
          const vps = EnvironmentId.make("environment:vps");
          const runCondition = { command: "node ~/check.mjs", timeoutSeconds: 60 };
          const lastNoWorkSkip = {
            at: "2026-10-05T01:00:00.000Z",
            scheduledFor: "2026-10-05T01:00:00.000Z",
            reason: "No open pull requests",
          };
          const sharing = (runOn: "one" | "every"): NonNullable<ScheduledTask["shared"]> => ({
            revision: { at: "2026-11-10T00:00:00.000Z", environmentId: here },
            project: { type: "repository", canonicalKey: "github.com/acme/app", title: "App" },
            excludedEnvironmentIds: [],
            runOn,
          });
          const listed: ReadonlyArray<ScheduledTask> = [
            { ...existing, runCondition, lastNoWorkSkip, shared: sharing("one") },
            {
              ...existing,
              id: ScheduledTaskId.make("scheduled-task:every"),
              shared: sharing("every"),
            },
            {
              ...existing,
              id: ScheduledTaskId.make("scheduled-task:unordered"),
              shared: {
                ...sharing("one"),
                project: { type: "repository", canonicalKey: "github.com/acme/other", title: "O" },
              },
            },
          ];
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                listed,
                {},
                {
                  list: () =>
                    Effect.succeed({
                      tasks: listed,
                      projectMachineOrders: [
                        {
                          project: sharing("one").project,
                          order: [vps, here],
                          revision: { at: "2026-11-10T00:00:00.000Z", environmentId: here },
                        },
                      ],
                    }),
                  upsert: (input) =>
                    Ref.update(saves, (all) => [...all, input]).pipe(Effect.as({ task: existing })),
                },
              ),
            ),
          );
          const fullAccess: McpInvocationScope = {
            ...client,
            client: { ...client.client!, access: "full-access" },
          };
          const fullAccessPlanning: McpInvocationScope = {
            ...client,
            client: {
              ...client.client!,
              access: "full-access",
              narrowedTo: { runtimeMode: "full-access", interactionMode: "plan" },
            },
          };
          const every = ScheduledTaskId.make("scheduled-task:every");
          yield* mcp.scheduleTask(fullAccess, {
            projectId,
            prompt: "Review PRs",
            schedule,
            runCondition,
          });
          yield* mcp.updateScheduledTask(fullAccess, {
            scheduledTaskId: existing.id,
            title: "Kept",
          });
          yield* mcp.updateScheduledTask(fullAccess, {
            scheduledTaskId: existing.id,
            runCondition: null,
          });
          // A task without a condition stays editable below full access.
          yield* mcp.updateScheduledTask(client, { scheduledTaskId: every, title: "Kept" });
          assert.deepEqual(
            (yield* Ref.get(saves)).map((input) =>
              "runCondition" in input ? input.runCondition : "omitted",
            ),
            [runCondition, "omitted", null, "omitted"],
          );
          // Setting one needs full access in default mode; a task that has one, the same to edit.
          const refusals: ReadonlyArray<Effect.Effect<object, OrchestratorMcpFailure>> = [
            mcp.scheduleTask(client, { projectId, prompt: "Review PRs", schedule, runCondition }),
            mcp.updateScheduledTask(client, { scheduledTaskId: every, runCondition }),
            mcp.scheduleTask(fullAccessPlanning, {
              projectId,
              prompt: "Review PRs",
              schedule,
              runCondition,
            }),
            mcp.updateScheduledTask(fullAccessPlanning, { scheduledTaskId: every, runCondition }),
            mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, title: "Edited" }),
            mcp.deleteScheduledTask(client, { scheduledTaskId: existing.id }),
          ];
          for (const refused of refusals) {
            assert.include(
              ["runtime_mode_escalation_denied", "interaction_mode_escalation_denied"],
              (yield* refused.pipe(Effect.flip)).code,
            );
          }
          assert.lengthOf(yield* Ref.get(saves), 4);

          const { tasks } = yield* mcp.listScheduledTasks(client, { projectId });
          assert.deepEqual(
            tasks.map((task) => [
              task.runCondition,
              task.lastSkipped,
              task.machineOrder,
              task.definedOn,
              task.definedAt,
            ]),
            [
              [runCondition, lastNoWorkSkip, [vps, here], here, "2026-11-10T00:00:00.000Z"],
              [undefined, undefined, undefined, here, "2026-11-10T00:00:00.000Z"],
              [undefined, undefined, [], here, "2026-11-10T00:00:00.000Z"],
            ],
          );
        }),
    );

    it.effect("saves a fixed-time task's catch-up choice and reads it back", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const saves = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const weekly: ScheduledTask = {
          ...existing,
          id: ScheduledTaskId.make("scheduled-task:weekly"),
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
          catchUpMissedRun: true,
        };
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              saved,
              [weekly, existing],
              {},
              {
                upsert: (input) =>
                  Ref.update(saves, (all) => [...all, input]).pipe(Effect.as({ task: weekly })),
              },
            ),
          ),
        );
        yield* mcp.scheduleTask(client, {
          projectId,
          prompt: "Sync from upstream",
          schedule: weekly.schedule,
          catchUpMissedRun: false,
        });
        yield* mcp.updateScheduledTask(client, { scheduledTaskId: weekly.id, prompt: "Sync" });
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          schedule: weekly.schedule,
          catchUpMissedRun: true,
        });
        assert.deepEqual(
          (yield* Ref.get(saves)).map((input) => input.catchUpMissedRun),
          [false, undefined, true],
        );
        const { tasks } = yield* mcp.listScheduledTasks(client, { projectId });
        assert.deepEqual(
          [weekly.id, existing.id].map(
            (id) => tasks.find((task) => task.scheduledTaskId === id)?.catchUpMissedRun,
          ),
          [true, undefined],
        );
      }),
    );

    it.effect(
      "refuses to bind a shared task to a thread, run one machine of an unshared task, or catch up a schedule without fixed times",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(service(masterRepository, saved)),
          );
          const created = yield* mcp
            .scheduleTask(client, {
              projectId,
              prompt: "Check the build",
              schedule,
              shared: true,
              bindToCurrentThread: true,
            })
            .pipe(Effect.flip);
          const updated = yield* mcp
            .updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              shared: true,
              bindToCurrentThread: true,
            })
            .pipe(Effect.flip);
          assert.deepEqual([created.code, updated.code], ["invalid_request", "invalid_request"]);

          const oneMachineErrors = [
            yield* mcp
              .scheduleTask(client, {
                projectId,
                prompt: "Check the build",
                schedule,
                oneMachine: true,
              })
              .pipe(Effect.flip),
            yield* mcp
              .updateScheduledTask(client, { scheduledTaskId: existing.id, oneMachine: true })
              .pipe(Effect.flip),
          ];
          for (const error of oneMachineErrors) {
            assert.deepEqual(
              { code: error.code, message: error.message },
              {
                code: "invalid_request",
                message: "oneMachine needs a shared task: pass shared: true as well.",
              },
            );
          }

          const catchUpErrors = [
            yield* mcp
              .scheduleTask(client, {
                projectId,
                prompt: "Check the build",
                schedule,
                catchUpMissedRun: true,
              })
              .pipe(Effect.flip),
            yield* mcp
              .updateScheduledTask(client, { scheduledTaskId: existing.id, catchUpMissedRun: true })
              .pipe(Effect.flip),
          ];
          for (const error of catchUpErrors) {
            assert.deepEqual(
              { code: error.code, message: error.message },
              {
                code: "invalid_request",
                message:
                  "catchUpMissedRun applies only to a fixed_time schedule: other schedules never catch up.",
              },
            );
          }
          assert.deepEqual(yield* Ref.get(saved), []);
        }),
    );

    it.effect("schedules a task that reads a prompt file, and keeps the file unless told", () =>
      Effect.gen(function* () {
        const promptFile = {
          path: "automations/daily.md",
          lastRead: { at: "2026-11-10T00:00:00.000Z", ref: "origin/main", commit: "c1" },
        };
        const fileTask: ScheduledTask = { ...existing, prompt: "Run the daily check.", promptFile };
        const saves = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              saved,
              [fileTask],
              {},
              {
                upsert: (input) =>
                  Ref.update(saves, (all) => [...all, input]).pipe(Effect.as({ task: fileTask })),
              },
            ),
          ),
        );

        const created = yield* mcp.scheduleTask(client, {
          projectId,
          promptFile: "automations/daily.md",
          schedule,
        });
        assert.deepEqual(created.promptFile, promptFile);
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          promptFile: null,
          prompt: "Typed instead.",
        });
        assert.deepEqual(
          (yield* Ref.get(saves)).map((input) => [input.title, input.prompt, input.promptFile]),
          [
            ["automations/daily.md", undefined, "automations/daily.md"],
            [existing.title, "Typed instead.", null],
          ],
        );

        const refusals = [
          mcp.scheduleTask(client, {
            projectId,
            prompt: "Run it",
            promptFile: "automations/daily.md",
            schedule,
          }),
          mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, prompt: "Run it" }),
        ];
        const messages = [];
        for (const refused of refusals) messages.push((yield* refused.pipe(Effect.flip)).message);
        assert.deepEqual(messages, [
          "Pass `prompt` or `promptFile`, not both: a task with a prompt file runs what the file says.",
          "This task reads its prompt from automations/daily.md. To give it a prompt instead, pass promptFile: null with prompt.",
        ]);
        assert.deepEqual(
          (yield* mcp.listScheduledTasks(client, { projectId })).tasks[0]?.promptFile,
          promptFile,
        );
      }),
    );

    describe("machines a shared task leaves out", () => {
      const work = EnvironmentId.make("environment:work-machine");
      const vps = EnvironmentId.make("environment:vps");
      const sharing = (
        excludedEnvironmentIds: ReadonlyArray<EnvironmentId>,
        runOn?: "one" | "every",
      ): NonNullable<ScheduledTask["shared"]> => ({
        revision: { at: "2026-11-10T00:00:00.000Z", environmentId: client.environmentId },
        project: { type: "none" },
        excludedEnvironmentIds,
        ...(runOn === undefined ? {} : { runOn }),
      });
      const sharedTask = (shared: ScheduledTask["shared"]): ScheduledTask => ({
        ...existing,
        shared,
      });
      // Stores what the service saves, so a later call reads it back the way the real one does.
      // Reached without a link from here: in the project's machine order, or pulling from here.
      const cpc = EnvironmentId.make("environment:cpc");
      const storeFor = (initial: ReadonlyArray<ScheduledTask>) =>
        Effect.gen(function* () {
          const stored = yield* Ref.make(initial);
          const saves = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          const tasks: Partial<ScheduledTaskService.ScheduledTaskService["Service"]> = {
            knownMachineIds: () => Effect.succeed([cpc]),
            list: () => Ref.get(stored).pipe(Effect.map((listed) => ({ tasks: listed }))),
            upsert: (input) =>
              Ref.update(saves, (all) => [...all, input]).pipe(
                Effect.andThen(
                  Ref.modify(stored, (listed) => {
                    const before = listed.find((task) => task.id === input.id);
                    const task: ScheduledTask = {
                      ...(before ?? existing),
                      id: input.id ?? existing.id,
                      shared:
                        input.shared === undefined
                          ? before?.shared
                          : input.shared === null
                            ? undefined
                            : sharing(
                                input.shared.excludedEnvironmentIds,
                                input.shared.runOn ?? before?.shared?.runOn,
                              ),
                    };
                    return [
                      task,
                      [...listed.filter((other) => other.id !== task.id), task] as const,
                    ];
                  }),
                ),
                Effect.map((task) => ({ task })),
              ),
          };
          return { saves, tasks };
        });
      const run = <A, E>(
        initial: ReadonlyArray<ScheduledTask>,
        body: (
          mcp: OrchestratorMcpService.OrchestratorMcpService["Service"],
          saves: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>,
        ) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          const { saves, tasks } = yield* storeFor(initial);
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(service(masterRepository, saved, [], {}, tasks, [], [work, vps])),
          );
          return yield* body(mcp, saves);
        });
      const sharedAs = (saves: ReadonlyArray<ScheduledTaskUpsertInput>) =>
        saves.map((input) => input.shared);

      it.effect("creates a shared task that leaves the work machine out, and reads it back", () =>
        run([], (mcp, saves) =>
          Effect.gen(function* () {
            const created = yield* mcp.scheduleTask(client, {
              projectId,
              prompt: "Check the build",
              schedule,
              shared: true,
              oneMachine: true,
              excludedMachines: [work, work],
            });
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [work], runOn: "one" },
            ]);
            assert.deepEqual([created.excludedMachines, created.oneMachine], [[work], true]);
            const listed = yield* mcp.listScheduledTasks(client, { projectId });
            assert.deepEqual(listed.tasks[0]?.excludedMachines, [work]);
          }),
        ),
      );

      it.effect("leaves excludedMachines out of the summary of a task that excludes none", () =>
        run([sharedTask(sharing([]))], (mcp) =>
          Effect.gen(function* () {
            const listed = yield* mcp.listScheduledTasks(client, { projectId });
            assert.equal("excludedMachines" in (listed.tasks[0] ?? {}), false);
          }),
        ),
      );

      it.effect("keeps the stored machines and run mode when an update does not mention them", () =>
        run([sharedTask(sharing([work], "one"))], (mcp, saves) =>
          Effect.gen(function* () {
            yield* mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, shared: true });
            yield* mcp.updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              title: "Renamed",
            });
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [work], runOn: "one" },
              undefined,
            ]);
            const listed = yield* mcp.listScheduledTasks(client, { projectId });
            assert.deepEqual(
              [listed.tasks[0]?.excludedMachines, listed.tasks[0]?.oneMachine],
              [[work], true],
            );
          }),
        ),
      );

      it.effect("keeps the stored machines when only the run mode changes", () =>
        run([sharedTask(sharing([work], "one"))], (mcp, saves) =>
          Effect.gen(function* () {
            yield* mcp.updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              oneMachine: false,
            });
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [work], runOn: "every" },
            ]);
          }),
        ),
      );

      it.effect("replaces the stored machines when an update names others, or none", () =>
        run([sharedTask(sharing([work], "one"))], (mcp, saves) =>
          Effect.gen(function* () {
            yield* mcp.updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              excludedMachines: [vps],
            });
            yield* mcp.updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              excludedMachines: [],
            });
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [vps], runOn: "one" },
              { excludedEnvironmentIds: [], runOn: "one" },
            ]);
          }),
        ),
      );

      it.effect("keeps the machines of a task a repeated create saves over", () =>
        run([], (mcp, saves) =>
          Effect.gen(function* () {
            const request = {
              projectId,
              prompt: "Check the build",
              schedule,
              shared: true,
              clientRequestId: "same-request",
            } as const;
            yield* mcp.scheduleTask(client, { ...request, excludedMachines: [work] });
            yield* mcp.scheduleTask(client, request);
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [work] },
              { excludedEnvironmentIds: [work] },
            ]);
          }),
        ),
      );

      it.effect.each([
        {
          name: "this machine",
          machines: [client.environmentId],
          message: `excludedMachines includes this machine (${client.environmentId}). A task can't be excluded from the machine it is saved on.`,
        },
        {
          name: "a machine no copy reaches",
          machines: [work, cpc, EnvironmentId.make("environment:stranger")],
          message:
            "excludedMachines names environment:stranger, which no copy of this task reaches: this environment does not link to it, it is not in the project's machine order, and it has not pulled shared tasks from here in the last 30 days. Use environmentId values from t3_environment_links.",
        },
      ])("refuses to exclude $name", ({ machines, message }) =>
        run([sharedTask(sharing([work], "one"))], (mcp, saves) =>
          Effect.gen(function* () {
            const errors = [
              yield* mcp
                .scheduleTask(client, {
                  projectId,
                  prompt: "Check the build",
                  schedule,
                  shared: true,
                  excludedMachines: machines,
                })
                .pipe(Effect.flip),
              yield* mcp
                .updateScheduledTask(client, {
                  scheduledTaskId: existing.id,
                  excludedMachines: machines,
                })
                .pipe(Effect.flip),
            ];
            assert.deepEqual(
              errors.map((error) => ({ code: error.code, message: error.message })),
              errors.map(() => ({ code: "invalid_request", message })),
            );
            assert.deepEqual(yield* Ref.get(saves), []);
          }),
        ),
      );

      it.effect("records only a peer link that pulls for its own environment", () =>
        Effect.gen(function* () {
          const recorded = yield* Ref.make<ReadonlyArray<boolean>>([]);
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                [],
                {},
                {
                  sharedCopies: (_forEnvironmentId, { recordPuller }) =>
                    Ref.update(recorded, (all) => [...all, recordPuller]).pipe(
                      Effect.as({ tasks: [], deletions: [], projectMachineOrders: [] }),
                    ),
                },
              ),
            ),
          );
          const peer = (linkedFrom: EnvironmentId | undefined): McpInvocationScope => ({
            ...client,
            client: {
              ...client.client!,
              linked: true,
              ...(linkedFrom === undefined ? {} : { linkedFrom }),
            },
          });
          for (const scope of [client, peer(undefined), peer(work), peer(cpc)]) {
            yield* mcp.sharedScheduledTasks(scope, { forEnvironmentId: cpc });
          }
          assert.deepEqual(yield* Ref.get(recorded), [false, false, false, true]);
        }),
      );

      it.effect("excludes a machine this one does not link to but whose copies it serves", () =>
        run([sharedTask(sharing([]))], (mcp, saves) =>
          Effect.gen(function* () {
            yield* mcp.scheduleTask(client, {
              projectId,
              prompt: "Check the build",
              schedule,
              shared: true,
              excludedMachines: [cpc],
            });
            yield* mcp.updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              excludedMachines: [cpc, work],
            });
            assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
              { excludedEnvironmentIds: [cpc] },
              { excludedEnvironmentIds: [cpc, work] },
            ]);
          }),
        ),
      );

      it.effect("sets the project's machine order through a one-machine task", () => {
        const everyMachine = ScheduledTaskId.make("scheduled-task:every-machine");
        return run(
          [sharedTask(sharing([], "one")), { ...existing, id: everyMachine, shared: sharing([]) }],
          (mcp, saves) =>
            Effect.gen(function* () {
              yield* mcp.updateScheduledTask(client, {
                scheduledTaskId: existing.id,
                machineOrder: [vps, client.environmentId, vps],
              });
              yield* mcp.scheduleTask(client, {
                projectId,
                prompt: "Check the build",
                schedule,
                shared: true,
                oneMachine: true,
                machineOrder: [cpc, client.environmentId],
              });
              assert.deepEqual(sharedAs(yield* Ref.get(saves)), [
                {
                  excludedEnvironmentIds: [],
                  runOn: "one",
                  machineOrder: [vps, client.environmentId],
                },
                {
                  excludedEnvironmentIds: [],
                  runOn: "one",
                  machineOrder: [cpc, client.environmentId],
                },
              ]);

              const refusals = [
                mcp.scheduleTask(client, {
                  projectId,
                  prompt: "Check the build",
                  schedule,
                  shared: true,
                  machineOrder: [vps],
                }),
                mcp.updateScheduledTask(client, {
                  scheduledTaskId: everyMachine,
                  machineOrder: [vps],
                }),
                mcp.updateScheduledTask(client, {
                  scheduledTaskId: existing.id,
                  machineOrder: [EnvironmentId.make("environment:stranger")],
                }),
              ];
              const messages = [];
              for (const refused of refusals)
                messages.push((yield* refused.pipe(Effect.flip)).message);
              assert.deepEqual(messages, [
                "machineOrder orders the machines of one-machine tasks: pass shared: true and oneMachine: true as well.",
                "machineOrder orders the machines of one-machine tasks: pass shared: true and oneMachine: true as well.",
                `machineOrder names environment:stranger, which is not this machine (${client.environmentId}), not linked from it, not in the project's machine order and has not pulled shared tasks from here in the last 30 days. Use environmentId values from t3_environment_links.`,
              ]);
              assert.lengthOf(yield* Ref.get(saves), 2);
            }),
        );
      });

      it.effect("refuses excludedMachines on a task that is not shared", () =>
        run([existing], (mcp, saves) =>
          Effect.gen(function* () {
            const errors = [
              yield* mcp
                .scheduleTask(client, {
                  projectId,
                  prompt: "Check the build",
                  schedule,
                  excludedMachines: [work],
                })
                .pipe(Effect.flip),
              yield* mcp
                .updateScheduledTask(client, {
                  scheduledTaskId: existing.id,
                  excludedMachines: [work],
                })
                .pipe(Effect.flip),
              yield* mcp
                .updateScheduledTask(client, {
                  scheduledTaskId: existing.id,
                  shared: false,
                  excludedMachines: [work],
                })
                .pipe(Effect.flip),
            ];
            for (const error of errors) {
              assert.deepEqual(
                { code: error.code, message: error.message },
                {
                  code: "invalid_request",
                  message: "excludedMachines needs a shared task: pass shared: true as well.",
                },
              );
            }
            assert.deepEqual(yield* Ref.get(saves), []);
          }),
        ),
      );
    });

    it.effect("follows the default branch when a task is unbound from its thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect.each([
      {
        name: "no remote, only master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master"],
        baseRef: "master",
      },
      {
        name: "no remote, main and master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/heads/main"],
        baseRef: "main",
      },
      {
        name: "no remote, neither main nor master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/develop"],
        baseRef: "main",
      },
      {
        name: "no recorded HEAD, remote main and a stale local master",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/remotes/origin/main"],
        baseRef: "origin/main",
      },
      {
        name: "no recorded HEAD, master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, local main and master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, nothing conventional on the remote, local main",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/develop"],
        baseRef: "main",
      },
      {
        name: "a recorded HEAD whose branch is gone",
        remote: "origin",
        remoteDefault: "main",
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "a remote not called origin",
        remote: "upstream",
        remoteDefault: "develop",
        refs: ["refs/remotes/upstream/develop"],
        baseRef: "upstream/develop",
      },
      {
        name: "a remote not called origin, no recorded HEAD",
        remote: "upstream",
        remoteDefault: null,
        refs: ["refs/remotes/upstream/main"],
        baseRef: "upstream/main",
      },
    ])("$name starts from $baseRef", ({ remote, remoteDefault, refs, baseRef }) =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const gitFailure = (cwd: string, detail: string) =>
          new GitCommandError({ operation: "GitVcsDriver.test", command: "git", cwd, detail });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              {
                resolvePrimaryRemoteName: (cwd) =>
                  remote === null
                    ? Effect.fail(gitFailure(cwd, "No git remote is configured."))
                    : Effect.succeed(remote),
                resolveDefaultBranchName: () => Effect.succeed(remoteDefault),
                resolveCommit: ({ cwd, revision }) =>
                  refs.includes(revision)
                    ? Effect.succeed({ commitSha: "abc123" })
                    : Effect.fail(gitFailure(cwd, "Needed a single revision")),
              },
              saved,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef, startFromOrigin: true },
        ]);
      }),
    );
  });
  it.effect(
    "reports the child run's selection after a restart and the thread selection before launch",
    () =>
      Effect.gen(function* () {
        const runSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent-personal"),
          model: "claude-opus-4-6",
          options: [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        } as const;
        const threadSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        let hasRun = true;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("claudeAgent-work"),
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection([task])
                  : ({
                      ...childProjection,
                      thread: { ...childProjection.thread, modelSelection: threadSelection },
                      runs: hasRun
                        ? [
                            {
                              id: RunId.make("run:mcp-restarted-child"),
                              ordinal: 1,
                              status: "running",
                              modelSelection: runSelection,
                            },
                          ]
                        : [],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const selection of [runSelection, threadSelection]) {
            const result = yield* service.taskStatus(scope, taskId);
            assert.equal(result.providerInstanceId, selection.instanceId);
            assert.equal(result.model, selection.model);
            assert.deepEqual(result.options, selection.options);
            hasRun = false;
          }
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect(
    "inherits delegated options, merges overrides, and resets on explicit clearing or a new target",
    () =>
      Effect.gen(function* () {
        const peerId = ProviderInstanceId.make("codex-subscription-2");
        const driver = ProviderDriverKind.make("codex");
        const inherited = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        } as const;
        const override = [{ id: "reasoningEffort", value: "max" }] as const;
        const cases = [
          {
            name: "partial override",
            target: { options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            name: "clear with array",
            target: { options: [] },
            expected: { ...inherited, options: [] },
          },
          {
            name: "clear with object",
            target: { options: {} },
            expected: { ...inherited, options: [] },
          },
          {
            name: "same model by alias",
            target: { model: "GPT" },
            expected: { ...inherited, model: "GPT" },
          },
          {
            name: "change model",
            target: { model: "other-model" },
            expected: { instanceId: codexInstanceId, model: "other-model" },
          },
          {
            name: "change provider with override",
            target: { providerInstanceId: peerId, options: { reasoningEffort: "max" } },
            expected: { instanceId: peerId, model: inherited.model, options: override },
          },
          {
            name: "old Ultracode effort level",
            target: { model: "ultracode-model", options: { effort: "ultracode" } },
            expected: {
              instanceId: codexInstanceId,
              model: "ultracode-model",
              options: [
                { id: "effort", value: "xhigh" },
                { id: "ultracode", value: true },
              ],
            },
          },
          {
            name: "effort override on an old Ultracode parent",
            parent: {
              instanceId: codexInstanceId,
              model: "ultracode-model",
              options: [{ id: "effort", value: "ultracode" }],
            },
            target: { options: { effort: "high" } },
            expected: {
              instanceId: codexInstanceId,
              model: "ultracode-model",
              options: [
                { id: "effort", value: "high" },
                { id: "ultracode", value: true },
              ],
            },
          },
        ] as const;
        for (const testCase of cases) {
          const parent = "parent" in testCase ? testCase.parent : inherited;
          const commands: Array<unknown> = [];
          const task = {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            providerInstanceId: testCase.expected.instanceId,
            model: testCase.expected.model,
            status: "running",
            result: null,
          };
          const dependencies = Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(commands.length > 0 ? [task] : [], parent)
                    : childProjection,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return {
                    sequence: 1,
                    storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                  } as never;
                }),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              {
                ...providerSnapshot({
                  instanceId: codexInstanceId,
                  driver,
                  model: inherited.model,
                }),
                models: [
                  ...[inherited.model, "other-model"].map((model) => ({
                    slug: model,
                    name: model,
                    isCustom: false,
                    capabilities: null,
                    ...(model === inherited.model ? { aliases: ["gpt"] } : {}),
                  })),
                  {
                    slug: "ultracode-model",
                    name: "ultracode-model",
                    isCustom: false,
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "effort",
                          label: "Reasoning",
                          type: "select",
                          options: [
                            { id: "high", label: "High" },
                            { id: "xhigh", label: "Extra High" },
                          ],
                        },
                        { id: "ultracode", label: "Ultracode", type: "boolean" },
                      ],
                    },
                  },
                ],
              },
              providerSnapshot({ instanceId: peerId, driver, model: inherited.model }),
            ]),
            adapterRegistryLayer([codexInstanceId, peerId]),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(capabilities.inheritedOptions, parent.options);
            yield* service.delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget(testCase.target),
              mode: "async",
              clientRequestId: testCase.name,
            });
            assert.deepEqual(
              (commands[0] as { modelSelection: unknown }).modelSelection,
              testCase.expected,
              testCase.name,
            );
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
        }
      }),
  );

  it.effect("validates options against the model a target names by alias", () =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection([]) : childProjection),
          dispatch: () => Effect.die("an invalid target must not dispatch"),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
            }),
            models: [
              {
                slug: "gpt-5.4",
                name: "gpt-5.4",
                aliases: ["gpt"],
                isCustom: false,
                capabilities: {
                  optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }],
                },
              },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const model of ["gpt-5.4", "GPT"]) {
          const error = yield* service
            .delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget({ model, options: { bogus: "x" } }),
              mode: "async",
              clientRequestId: model,
            })
            .pipe(Effect.flip);
          assert.equal(error.code, "invalid_request", model);
          assert.include(error.message, "Unknown option bogus", model);
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("accepts the inherited options it reports back as a delegate target", () =>
    Effect.gen(function* () {
      // t3_thread_launch keeps a model selection as given, so a thread can hold an option its model lacks.
      const inherited = {
        instanceId: codexInstanceId,
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: false },
        ],
      } as const;
      const commands: Array<{ readonly modelSelection?: unknown }> = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: codexInstanceId,
        model: inherited.model,
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(commands.length > 0 ? [task] : [], inherited)
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command as { readonly modelSelection?: unknown });
              return {
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never;
            }),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
            }),
            models: [
              {
                slug: inherited.model,
                name: inherited.model,
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [{ id: "low", label: "Low" }],
                    },
                  ],
                },
              },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const { inheritedOptions } = yield* service.capabilities(scope);
        yield* service.delegateTask(scope, {
          task: "Review the change.",
          target: yield* decodeTarget({ options: inheritedOptions }),
          mode: "async",
        });
        assert.deepEqual(commands[0]?.modelSelection, {
          ...inherited,
          options: [inherited.options[0]],
        });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("starts a task on its role's model, keeping the Auto settings chose", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claude_work");
      const commands: Array<{ readonly modelSelection?: unknown }> = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: codexInstanceId,
        model: "gpt-5.4",
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(commands.length > 0 ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command as { readonly modelSelection?: unknown });
              return {
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never;
            }),
        }),
        ServerSettings.layerTest({
          delegatedTaskModelSelections: {
            implementation: {
              instanceId: claudeInstanceId,
              model: "claude-opus",
              autoAccount: true,
            },
            // An account that is gone falls back to the parent's model.
            review: { instanceId: ProviderInstanceId.make("claude_removed"), model: "claude-opus" },
          },
          finalReviewModelSelections: [
            { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
          ],
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: claudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-opus",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const [role, target] of [
          ["implementation", undefined],
          ["implementation", { model: "gpt-5.4" }],
          ["review", undefined],
          // A reviewer named by account keeps the Auto its setting chose.
          ["review", { providerInstanceId: claudeInstanceId, model: "claude-opus" }],
        ] as const) {
          yield* service.delegateTask(scope, {
            task: "Do the work.",
            role,
            ...(target === undefined ? {} : { target: yield* decodeTarget(target) }),
            mode: "async",
            clientRequestId: `${role}:${target?.model ?? "role"}:${target && "providerInstanceId" in target ? "account" : ""}`,
          });
        }
        assert.deepEqual(
          commands.map((command) => command.modelSelection),
          [
            { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
            // A model the agent names wins over the role's.
            { instanceId: codexInstanceId, model: "gpt-5.4" },
            { instanceId: codexInstanceId, model: "gpt-5.4" },
            { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
          ],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("creates a thread in Auto mode on auto:true, and none while Auto is off", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claude_work");
      const created: Array<ModelSelection> = [];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection([])
                : ({
                    ...childProjection,
                    thread: { ...childProjection.thread, modelSelection: created.at(-1) },
                  } as unknown as OrchestrationV2ThreadProjection),
            ),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create") created.push(command.modelSelection);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        ServerSettings.layerTest({
          autoModeProvider: ProviderDriverKind.make("claudeAgent"),
          autoModeModels: { [ProviderDriverKind.make("claudeAgent")]: { model: "claude-opus" } },
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: claudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-opus",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const result = yield* service.createThreads(scope, {
          threads: [{ title: "Auto" }, { title: "Auto", auto: true }],
          clientRequestId: "auto",
        });
        assert.deepEqual(created, [
          { instanceId: codexInstanceId, model: "gpt-5.4" },
          { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
        ]);
        assert.equal(result.threads[1]?.providerInstanceId, claudeInstanceId);

        const both = yield* service
          .createThreads(scope, {
            threads: [{ auto: true, target: { model: "gpt-5.4" } }],
            clientRequestId: "both",
          })
          .pipe(Effect.flip);
        assert.equal(both.code, "invalid_request");

        yield* settings.updateSettings({ autoModeProvider: null });
        const off = yield* service
          .createThreads(scope, { threads: [{ auto: true }], clientRequestId: "off" })
          .pipe(Effect.flip);
        assert.equal(off.code, "invalid_request");
        assert.include(off.message, "Auto mode is off");
        assert.equal(created.length, 2);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(dependencies))));
    }),
  );

  describe("resolveRuntimeMode", () => {
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* resolveRuntimeMode("full-access", "auto-accept-edits", muse).pipe(
          Effect.flip,
        );
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(yield* resolveRuntimeMode("full-access", "inherit", muse), "full-access");
        assert.equal(yield* resolveRuntimeMode("auto", undefined, muse), "approval-required");
      }),
    );
  });
});

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const launched = liveThreadShell(ThreadId.make(`mcp:${bareId}`));
  const deletedLaunched = { ...launched, deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") };
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    sent: Ref.Ref<number>,
    overrides: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  ) =>
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            ...overrides,
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
  const failuresFor = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const read = yield* mcp.readThread(client, { threadId: bareId }).pipe(Effect.flip);
        const send = yield* mcp
          .sendToThread(client, { threadId: bareId, message: "hello" })
          .pipe(Effect.flip);
        const wait = yield* mcp.waitForThread(client, { threadId: bareId }).pipe(Effect.flip);
        return { read, send, wait, sends: yield* Ref.get(sent) };
      }).pipe(Effect.provide(service(shells, sent)));
    });

  it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const { read, send, wait, sends } = yield* failuresFor([launched]);
      for (const error of [read, send, wait]) {
        assert.equal(error.code, "thread_not_found");
        assert.include(error.message, `mcp:${bareId}`);
      }
      assert.equal(sends, 0);
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.code, "thread_not_found");
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("refuses waiting without orchestration capability before reading the target", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* mcp
          .waitForThread({ ...client, capabilities: new Set() }, { threadId: bareId })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unauthorized target access"),
          }),
        ),
      );
    }),
  );

  it.effect("waits on the caller's own thread without a separate shell lookup", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* mcp.waitForThread(
          {
            ...client,
            thread: {
              threadId: launched.id,
              providerSessionId: "provider-session:wait-self",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          { threadId: launched.id },
        );
        assert.deepEqual(result, {
          threadId: launched.id,
          runId: null,
          status: "idle",
          timedOut: false,
        });
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unexpected shell lookup for the caller"),
            getThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            waitForThread: () =>
              Effect.succeed({ threadId: launched.id, run: null, timedOut: false }),
          }),
        ),
      );
    }),
  );
});

describe("OrchestratorMcpService thread list", () => {
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-list"),
    requestNamespace: "client:thread-list",
    thread: undefined,
    client: { sessionId: "thread-list", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const shell = (id: string, projectId: string, snoozed: boolean) => ({
    ...liveThreadShell(ThreadId.make(id)),
    projectId: ProjectId.make(projectId),
    status: "completed" as const,
    snoozedUntil: snoozed ? DateTime.makeUnsafe("2099-01-01T00:00:00Z") : null,
  });
  const shells = [
    shell("thread:a-snoozed", "project:a", true),
    shell("thread:a-awake", "project:a", false),
    shell("thread:b-snoozed", "project:b", true),
  ];
  const service = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.succeed(
              shells.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

  it.effect("lists a compact row by default and every field with fields: full", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const compact = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
      });
      const full = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
        fields: "full",
      });
      assert.deepStrictEqual(Object.keys(compact.threads[0] ?? {}).toSorted(), [
        "link",
        "model",
        "parentThreadId",
        "status",
        "threadId",
        "title",
        "updatedAt",
      ]);
      assert.equal(full.threads[0]?.settled, false);
    }).pipe(Effect.provide(service)),
  );

  it.effect("lists snoozed threads across every project with allProjects", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        allProjects: true,
        projectId: ProjectId.make("project:a"),
        snoozed: true,
      });
      assert.equal(listed.projectId, null);
      assert.deepStrictEqual(
        listed.threads.map((thread) => [String(thread.threadId), String(thread.projectId)]),
        [
          ["thread:a-snoozed", "project:a"],
          ["thread:b-snoozed", "project:b"],
        ],
      );
    }).pipe(Effect.provide(service)),
  );
});

describe("OrchestratorMcpService thread stop", () => {
  const driver = ProviderDriverKind.make("codex");
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "gpt-5.4" };
  const threadId = ThreadId.make("thread:mcp-stop");
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-stop"),
    requestNamespace: "client:mcp-stop",
    thread: undefined,
    client: { sessionId: "mcp-stop", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  // A provider whose turns run until they are interrupted.
  const liveAdapter = (cwd: string): ProviderAdapter.ProviderAdapterV2["Service"] => ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId: appThreadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${appThreadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${appThreadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: null,
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            }).pipe(Effect.asVoid),
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  });

  it.effect.each([
    { name: "a running turn", queued: false },
    { name: "a running turn with a queued message", queued: true },
  ])("t3_thread_interrupt stop reports the run it interrupted on $name", ({ queued }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("mcp-thread-stop");
        const layerAdapters = ProviderAdapterRegistry.layerSingle(liveAdapter(cwd));
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-thread-stop" },
          layerAdapters,
          { databaseLayer: layerDatabase, runEffectWorker: false },
        );
        const layerThreads = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
        );
        const layerTest = layerOrchestratorService.pipe(
          Layer.provideMerge(layerThreads),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              layerAdapters,
              ServerSettings.layerTest(),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(RemoteDelegation.RemoteDelegation)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const send = (text: string, type: "start_immediately" | "queue_after_active") =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${text}`),
              threadId,
              messageId: MessageId.make(`message:${text}`),
              text,
              attachments: [],
              dispatchMode: { type },
              createdBy: "user",
              creationSource: "web",
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:mcp-stop"),
            title: "Stop",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* send("work", "start_immediately");
          yield* worker.drain();
          yield* Fiber.join(running);
          if (queued) yield* send("later", "queue_after_active");
          const before = yield* orchestrator.getThreadProjection(threadId);
          const runningRun = before.runs.find((run) => run.status === "running")!;
          assert.equal(before.runs.filter((run) => run.status === "queued").length, queued ? 1 : 0);

          const stopped = yield* service.interruptThread(client, {
            threadId,
            stop: true,
            clientRequestId: "stop",
          });
          assert.deepEqual(stopped, {
            threadId,
            runId: runningRun.id,
            status: "interrupt_requested",
          });
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
