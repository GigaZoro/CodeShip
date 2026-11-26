import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  type PeerLinkSummary,
  GitCommandError,
  isLiveSubagentShell,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpFailure,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpModelOption,
  type OrchestratorMcpListScheduledTasksInput,
  type Project,
  OrchestratorMcpTarget,
  PlanId,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { formatThreadLink, hostedThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { resolveRuntimeMode } from "./delegatedTaskModes.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
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

const layerOrchestratorServiceWithGit = (
  git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
  memory = MemoryAdmission.layerTest(),
  links: ReadonlyArray<PeerLinkSummary> = [],
) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({ list: Effect.succeed(links) })),
    Layer.provide(memory),
    Layer.provide(NodeCrypto.layer),
  );
const layerOrchestratorService = layerOrchestratorServiceWithGit({});

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const resultTransferId = ContextTransferId.make("transfer:mcp-ack-result");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            title: "Merge",
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
        contextTransfers: [
          {
            id: resultTransferId,
            type: "subagent_result",
            sourceThreadId: childThreadId,
            targetThreadId: parentThreadId,
            sourcePoint: { runId: childRunId },
          },
        ],
        messages: [
          {
            id: MessageId.make("message:mcp-ack-result"),
            runId: childRunId,
            role: "assistant",
            text: "terminal result",
            createdAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
        ],
        turnItems: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      let settleAfterTaskRead = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.sync(() => {
              if (threadId !== parentThreadId) {
                return hasNestedWork
                  ? {
                      ...childProjection,
                      contextTransfers: [],
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection;
              }
              const snapshot = hasNestedWork
                ? {
                    ...parentProjection,
                    subagents: parentProjection.subagents.map((task) => ({
                      ...task,
                      result: null,
                      status: "running" as const,
                    })),
                  }
                : parentProjection;
              if (settleAfterTaskRead) {
                settleAfterTaskRead = false;
                hasNestedWork = false;
              }
              return snapshot;
            }),
          delegatedTaskResultPending: () => Effect.succeed(false),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        assert.isNull(pending.resultContextTransferId);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        // Completion lands after task selection, before the remaining parent/child reads.
        hasNestedWork = true;
        settleAfterTaskRead = true;
        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        assert.equal(result.resultContextTransferId, resultTransferId);
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);

        const missing = yield* service
          .taskStatus(scope, NodeId.make("node:mcp-ack-missing"))
          .pipe(Effect.flip);
        assert.equal(missing.code, "task_not_found");
        assert.include(missing.message, "No delegated task with id node:mcp-ack-missing");
        assert.include(missing.message, `${taskId} (Merge)`);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const cutRunId = RunId.make("run:mcp-restart-child");
      const continuationRunId = RunId.make("run:mcp-restart-continuation");
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
            id: cutRunId,
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let childRuns = childProjection.runs;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection
                : { ...childProjection, runs: childRuns },
            ),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        assert.isNull(held.latestTerminalRunId);
        assert.isNull(held.latestTerminalStatus);
        assert.equal(yield* Ref.get(dispatched), 0);

        const continuationRun = {
          id: continuationRunId,
          ordinal: 3,
          status: "running",
          delegatedTaskId: taskId,
          startedAt: DateTime.makeUnsafe("2026-10-03T10:06:00Z"),
          restartContinuationOfRunId: cutRunId,
        } as unknown as (typeof childRuns)[number];
        childRuns = [...childProjection.runs, continuationRun];
        const continuing = yield* service.taskStatus(scope, taskId);
        assert.equal(continuing.status, "running");
        assert.isNull(continuing.latestTerminalRunId);
        assert.isNull(continuing.latestTerminalStatus);

        // A second restart cut the continuation, and its own continuation declined.
        childRuns = [
          ...childProjection.runs,
          {
            ...continuationRun,
            status: "cancelled",
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
        ];
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(settled.latestTerminalRunId, continuationRunId);
        assert.equal(settled.latestTerminalStatus, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);

        // A continuation cancelled before it started leaves the cut run as the result.
        childRuns = [
          ...childProjection.runs,
          { ...continuationRun, status: "cancelled", startedAt: null },
        ];
        const unstarted = yield* service.taskStatus(scope, taskId);
        assert.equal(unstarted.latestTerminalRunId, cutRunId);
        assert.equal(unstarted.latestTerminalStatus, "cancelled");

        // That unstarted continuation was itself continued, so the whole chain is still live.
        childRuns = [
          ...childProjection.runs,
          { ...continuationRun, status: "cancelled", startedAt: null },
          {
            ...continuationRun,
            id: RunId.make("run:mcp-restart-continuation-2"),
            ordinal: 4,
            restartContinuationOfRunId: continuationRunId,
          },
        ];
        const chained = yield* service.taskStatus(scope, taskId);
        assert.isNull(chained.latestTerminalRunId);
        assert.isNull(chained.latestTerminalStatus);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a child run the provider has not started yet as starting", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-starting-parent");
      const childThreadId = ThreadId.make("thread:mcp-starting-child");
      const childRunId = RunId.make("run:mcp-starting-child");
      const taskId = NodeId.make("node:mcp-starting-task");
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
            completionDelivery: null,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      let providerStarted = false;
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs: [
            {
              id: childRunId,
              ordinal: 1,
              status: providerStarted ? "running" : "starting",
              startedAt: providerStarted ? DateTime.makeUnsafe("2026-10-24T10:00:00Z") : null,
              delegatedTaskId: taskId,
            },
          ],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [{ status: "not_loaded", pendingBackgroundTasks: [] }],
          providerTurns: [],
          runtimeRequests: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection()),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-starting"),
        requestNamespace: "provider-session:mcp-starting",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-starting",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service.taskStatus(scope, taskId);
        assert.equal(waiting.status, "starting");
        assert.equal(waiting.workState, "working");
        assert.equal(waiting.childRunId, childRunId);
        providerStarted = true;
        const started = yield* service.taskStatus(scope, taskId);
        assert.equal(started.status, "running");
        assert.equal(started.workState, "working");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("takes a silent run's report only from the same task's earlier runs", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-report-parent");
      const childThreadId = ThreadId.make("thread:mcp-report-child");
      const taskA = NodeId.make("node:mcp-report-task-a");
      const taskB = NodeId.make("node:mcp-report-task-b");
      const silent = "Child task completed without an assistant result.";
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [taskA, taskB].map((id) => ({
          id,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          driver: "codex",
          model: "gpt-5.6-terra",
          status: "running",
          result: null,
          completionDelivery: null,
        })),
      } as unknown as OrchestrationV2ThreadProjection;
      const run = (ordinal: number, delegatedTaskId: NodeId) => ({
        id: RunId.make(`run:mcp-report-${ordinal}`),
        ordinal,
        status: "completed",
        delegatedTaskId,
        startedAt: DateTime.makeUnsafe(`2026-10-24T10:0${ordinal}:00Z`),
        completedAt: DateTime.makeUnsafe(`2026-10-24T10:0${ordinal}:30Z`),
      });
      const runs = [run(1, taskA), run(2, taskA), run(3, taskB)];
      let reports: ReadonlyArray<readonly [number, string]> = [];
      // The mock ignores run filters, so every report is loaded whichever runs are asked for.
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs,
          contextTransfers: [],
          messages: reports.map(([ordinal, text]) => ({
            id: MessageId.make(`message:mcp-report-${ordinal}`),
            runId: runs[ordinal - 1]!.id,
            role: "assistant",
            text,
            createdAt: runs[ordinal - 1]!.completedAt,
            updatedAt: runs[ordinal - 1]!.completedAt,
          })),
          subagents: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection()),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-report"),
        requestNamespace: "provider-session:mcp-report",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-report",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // Task A reported, then a run queued behind the report ended without text.
        reports = [[1, "REPORT-A"]];
        const reported = yield* service.taskStatus(scope, taskA);
        assert.equal(reported.status, "completed");
        assert.equal(reported.summary, "REPORT-A");
        assert.equal(reported.latestTerminalRunId, runs[2]!.id);
        assert.equal(reported.latestTerminalSummary, silent);
        assert.equal((yield* service.taskStatus(scope, taskB)).summary, silent);

        // A later task's report is not the result of a task that said nothing.
        reports = [[3, "REPORT-B"]];
        const quiet = yield* service.taskStatus(scope, taskA);
        assert.equal(quiet.summary, silent);
        assert.equal(quiet.latestTerminalSummary, "REPORT-B");
        assert.equal((yield* service.taskStatus(scope, taskB)).summary, "REPORT-B");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("tells the parent to end its turn only while its task still runs", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-next-parent");
      const childThreadId = ThreadId.make("thread:mcp-next-child");
      const taskId = NodeId.make("node:mcp-next-task");
      let finished = false;
      let firstRun = false;
      let pendingRequest: "live" | "message" | null = null;
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
        status: finished && !firstRun ? ("completed" as const) : ("running" as const),
        // A task's first run is untagged; the child's fork node names the task.
        ...(firstRun ? {} : { delegatedTaskId: taskId }),
      });
      const childProjection = () =>
        ({
          thread: {
            id: childThreadId,
            title: "Child task",
            forkedFrom: { type: "node", nodeId: taskId },
          },
          runs: [childRun()],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests:
            pendingRequest === null
              ? []
              : [
                  {
                    kind: "user_input",
                    status: "pending",
                    responseCapability: { type: pendingRequest },
                  },
                ],
          nodes: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection() : childProjection()),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getProjectThreadRecords: () => Effect.succeed(childProjection()),
          waitForThread: () =>
            Effect.succeed({
              threadId: childThreadId,
              run: childRun() as unknown as OrchestrationV2ThreadProjection["runs"][number],
              timedOut: !finished || firstRun,
            }),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        pendingRequest = "live";
        const asking = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(asking.timedOut);
        assert.notProperty(asking, "next");

        // A question answered by message does not stop the child.
        pendingRequest = "message";
        const working = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(working.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        pendingRequest = null;

        firstRun = true;
        const first = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(first.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

        // An untagged run after the task has its result is no longer that task.
        finished = true;
        const followUp = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(followUp.timedOut);
        assert.notProperty(followUp, "next");
        firstRun = false;

        const completed = yield* service.taskStatus(scope, taskId);
        assert.equal(completed.status, "completed");
        assert.notProperty(completed, "next");
        const waited = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(waited.status, "completed");
        assert.notProperty(waited, "next");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a command that waits for memory as queued, saying why", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-queued-command");
      const taskId = NodeId.make("node:mcp-queued-command");
      const waiting = "Queued until this machine has memory for it: 1 GiB of 8 GiB is available.";
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: parentThreadId },
              runs: [],
              contextTransfers: [],
              subagents: [
                {
                  id: taskId,
                  threadId: parentThreadId,
                  origin: "app_owned",
                  childThreadId: null,
                  command: {
                    command: "vp run typecheck",
                    cwd: "/repo",
                    logPath: "/logs/output.log",
                    timeoutMinutes: 60,
                  },
                  driver: "command",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  model: null,
                  status: "pending",
                  progress: waiting,
                  result: null,
                  completionDelivery: { state: "pending" },
                },
              ],
            } as unknown as OrchestrationV2ThreadProjection),
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
        environmentId: EnvironmentId.make("environment:mcp-queued-command"),
        requestNamespace: "provider-session:mcp-queued-command",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-queued-command",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      const status = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
        Effect.flatMap((service) => service.taskStatus(scope, taskId)),
        Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))),
      );
      assert.equal(status.status, "queued");
      assert.equal(status.workState, "working");
      assert.equal(status.summary, waiting);
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
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
          providerTurns: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              threadId === parentThreadId
                ? Effect.map(Ref.get(status), parentProjection)
                : Effect.succeed(childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            listAppOwnedChildThreadIds: () => Effect.succeed([]),
            delegatedTaskResultPending: () => Effect.succeed(false),
            stopDelegatedTasks: () => Effect.void,
            cancelDelegatedTask: ({ command }) =>
              Ref.update(dispatched, (commands) => [...commands, command]),
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
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
          stopDelegatedTasks: () => Effect.void,
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
              Effect.andThen(
                Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: new Error("simulated stop failure"),
                  }) as never,
                ),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        assert.equal(
          error.message,
          `Unable to stop delegated task ${taskId}: simulated stop failure`,
        );
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
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
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
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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

  it.effect(
    "reports the dispatch cause instead of the generic wrapper when disposing a finished task's completion delivery fails",
    () =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-cause-parent");
        const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-cause-child");
        const taskId = NodeId.make("node:mcp-cancel-dispose-cause-task");
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
              status: "completed",
              result: "Done.",
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
          providerTurns: [],
          runtimeRequests: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            listAppOwnedChildThreadIds: () => Effect.succeed([]),
            stopDelegatedTasks: () => Effect.void,
            cancelDelegatedTask: () => Effect.void,
            dispatch: (command) =>
              command.type === "delegated_task.completion-delivery.dispose"
                ? Effect.fail(
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: new Error("refused by the orchestrator"),
                    }) as never,
                  )
                : Effect.succeed({} as never),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-cause"),
          requestNamespace: "provider-session:mcp-cancel-dispose-cause",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-cancel-dispose-cause",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const error = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service
            .cancelTask(scope, { taskId, clientRequestId: "cancel-dispose-dispatch-cause" })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        assert.equal(error.code, "orchestration_error");
        assert.equal(
          error.message,
          `Unable to dispose delegated task ${taskId} completion delivery: refused by the orchestrator`,
        );
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
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
      const subagentReads = yield* Ref.make<ReadonlyArray<ProjectionRecordFilter | undefined>>([]);
      const appOwnedTask = (
        id: string,
        threadId: ThreadId,
        childId: ThreadId,
        settled?: "settled",
      ) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        status: settled === undefined ? "running" : "completed",
        result: settled === undefined ? null : "Done.",
        completionDelivery: { state: settled === undefined ? "pending" : "delivered" },
      });
      // Older tasks the parent and child dispatched and that have long settled.
      const settledThreadId = ThreadId.make("thread:mcp-cancel-grandchild-settled");
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
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-old",
                parentThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask(taskId, parentThreadId, childThreadId),
            ],
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
              appOwnedTask(
                "node:mcp-cancel-grandchild-done",
                childThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
        [
          settledThreadId,
          {
            thread: { id: settledThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
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
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) =>
            ((fields as ReadonlyArray<string>).includes("subagents")
              ? Ref.update(subagentReads, (reads) => [...reads, filter])
              : Effect.void
            ).pipe(Effect.as(projections.get(threadId)!)),
          listAppOwnedChildThreadIds: (threadId) =>
            Effect.succeed(
              projections
                .get(threadId)!
                .subagents.flatMap((task) =>
                  task.origin === "app_owned" && task.childThreadId !== null
                    ? [task.childThreadId]
                    : [],
                ),
            ),
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
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        // No read decodes every task a thread has dispatched.
        for (const filter of yield* Ref.get(subagentReads)) {
          assert.isTrue(
            filter?.subagentIds !== undefined || filter?.omitSettledSubagents !== undefined,
          );
        }
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

describe("OrchestratorMcpService.pageIncludesTerminalTaskResult", () => {
  const parentThreadId = ThreadId.make("thread:ack-parent");
  const childThreadId = ThreadId.make("thread:ack-child");
  const runId = RunId.make("run:ack-child");
  const delivered = {
    id: TurnItemId.make("turn-item:ack-delivered"),
    runId,
    ordinal: 0,
    type: "assistant_message" as const,
    messageId: MessageId.make("message:ack-delivered"),
    text: "The answer the parent received.",
  };
  const laterPlan = {
    id: TurnItemId.make("turn-item:ack-later-plan"),
    runId,
    ordinal: 1,
    type: "proposed_plan" as const,
    planId: PlanId.make("plan:ack-later"),
    markdown: "1. A plan the result would pick now.",
  };

  it.each([
    ["the item the transfer delivered", delivered, true],
    ["a later item the run's result would pick now", laterPlan, false],
  ] as const)("acknowledges a page that holds %s", (_, item, acknowledged) => {
    assert.equal(
      OrchestratorMcpService.pageIncludesTerminalTaskResult({
        parentThreadId,
        items: [
          {
            sourceThreadId: childThreadId,
            itemId: item.id,
            type: item.type,
            messageId: item.type === "assistant_message" ? item.messageId : null,
            text: item.type === "assistant_message" ? item.text : item.markdown,
            textTruncated: false,
          } as never,
        ],
        task: {
          id: NodeId.make("node:ack-task"),
          threadId: parentThreadId,
          childThreadId,
          origin: "app_owned",
        } as never,
        target: {
          thread: { id: childThreadId },
          runs: [{ id: runId, ordinal: 1, status: "completed" }],
          contextTransfers: [
            {
              type: "subagent_result",
              sourceThreadId: childThreadId,
              targetThreadId: parentThreadId,
              sourcePoint: { threadId: childThreadId, runId, turnItemId: delivered.id },
            },
          ],
          messages: [],
          turnItems: [delivered, laterPlan],
          providerTurns: [],
        } as never,
      }),
      acknowledged,
    );
  });
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
      refreshUsageIfStale: () => Effect.succeed(providers),
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
      readonly autoAccount?: boolean;
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
    providerTurns: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect.each([
    "parent completion",
    "nested child completion",
    "child run completion",
    "child question",
    "child approval",
    "Node fetch's 300 s idle timeout",
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
        NodeCrypto.layer,
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
        if (wake === "Node fetch's 300 s idle timeout") {
          // Nothing is written during the wait, so undici drops the call at 300 s, before any handle.
          const beforeClientTimeout = yield* Fiber.join(waiting).pipe(
            Effect.timeoutOption(Duration.seconds(299)),
            Effect.forkChild,
          );
          yield* TestClock.adjust(Duration.seconds(299));
          const result = yield* Fiber.join(beforeClientTimeout);
          assert.isTrue(
            Option.isSome(result),
            "a wait without timeoutMs was still silent at 299 s, so a Node MCP client loses the taskId",
          );
          if (Option.isSome(result)) {
            assert.equal(result.value.taskId, taskId);
            assert.isTrue(result.value.waitTimedOut);
          }
          return;
        }
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
        AccountRouting.layer.pipe(
          Layer.provide(Layer.mergeAll(shared, Layer.mock(ProviderMcp.ProviderMcp)({}))),
        ),
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
  it.effect("leaves a result undelivered when the caller goes away after its wait times out", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const upgrading = yield* Deferred.make<void>();
      const finishUpgrade = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make<ReadonlyArray<{ readonly type: string }>>([]);
      let task: Record<string, unknown> = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.sync(() =>
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          getThreadEventSequence: () => Effect.succeed(0),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.wake-policy"
                  ? Deferred.succeed(upgrading, undefined).pipe(
                      Effect.andThen(Deferred.await(finishUpgrade)),
                    )
                  : Effect.void,
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never),
            ),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait", timeoutMs: 500 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        yield* TestClock.adjust(Duration.millis(500));
        yield* Deferred.await(upgrading);
        yield* Effect.sync(() => waiting.interruptUnsafe());
        task = { ...task, status: "completed", result: "Reviewed." };
        yield* Deferred.succeed(finishUpgrade, undefined);
        yield* Fiber.await(waiting);
        assert.notInclude(
          (yield* Ref.get(dispatched)).map((command) => command.type),
          "delegated_task.completion-delivery.acknowledge",
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  // Command receipts dedupe by commandId, so a later run reusing the identity gets no card.
  it.effect("opens a new secret card when a later run reuses a clientRequestId", () =>
    Effect.gen(function* () {
      const runId = yield* Ref.make(parentRunId);
      const pending = yield* Queue.unbounded<{
        readonly commandId: CommandId;
        readonly turnItemId: string;
      }>();
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Ref.get(runId).pipe(
              Effect.map((id) => {
                const projection = parentProjection([]);
                return {
                  ...projection,
                  runs: projection.runs.map((run) => ({ ...run, id })),
                  turnItems: [],
                };
              }),
            ),
          dispatch: (command) => {
            if (command.type !== "secret_request.record") return Effect.die("Unexpected command");
            return (
              command.secretStatus === "pending"
                ? Queue.offer(pending, {
                    commandId: command.commandId,
                    turnItemId: command.turnItemId,
                  })
                : Effect.void
            ).pipe(Effect.as({} as never));
          },
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
        const ask = Effect.gen(function* () {
          const call = yield* service
            .requestSecret(scope, {
              label: "Router API key",
              reason: "Reads the firewall rules.",
              clientRequestId: "router-key",
              timeoutMs: 1_000,
            })
            .pipe(Effect.forkChild);
          const card = yield* Queue.take(pending);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.include(yield* Fiber.join(call), { status: "timed_out" });
          return card;
        });

        const first = yield* ask;
        assert.deepEqual(yield* ask, first);
        yield* Ref.set(runId, RunId.make("run:mcp-providers-parent-later"));
        const later = yield* ask;
        assert.notEqual(later.commandId, first.commandId);
        assert.notEqual(later.turnItemId, first.turnItemId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const projectDisabledInstanceId = ProviderInstanceId.make("codex-project-off");
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
          providerSnapshot({
            instanceId: projectDisabledInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
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
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: { [projectDisabledInstanceId]: { enabled: false } },
              },
            },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            projectDisabledInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          AccountRouting.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderMcp.ProviderMcp)({}),
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

          const projectDisabled = byId.get(projectDisabledInstanceId);
          assert.isDefined(projectDisabled);
          assert.isFalse(projectDisabled!.canRunChildTask);
          assert.deepEqual(projectDisabled!.constraints, ["Disabled for this project."]);

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
                NodeCrypto.layer,
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
                Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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

  it.effect("capabilities refresh only stale runnable meters through the usage reader", () =>
    Effect.gen(function* () {
      const now = "2026-11-13T00:20:00.000Z";
      const before = "2026-11-13T00:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const instance = (id: string, checkedAt = before): ServerProvider => ({
        ...providerSnapshot({
          instanceId: ProviderInstanceId.make(id),
          driver: ProviderDriverKind.make("custom"),
          model: "standard",
        }),
        checkedAt,
        usageLimits: {
          checkedAt,
          windows: [{ id: "quota", kind: "weekly", label: "Weekly", usedPercent: 20 }],
        },
      });
      const stale = instance("stale");
      const blocked = instance("project-disabled");
      const noAdapter = instance("no-adapter");
      const fresh = instance("fresh", now);
      const unsupported: ServerProvider = {
        ...instance("unsupported"),
        usageLimits: { checkedAt: before, windows: [], unavailable: { reason: "unsupported" } },
      };
      let providers = [stale, blocked, noAdapter, fresh, unsupported];
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerInstances: Object.fromEntries(
            providers.map(({ instanceId, driver }) => [instanceId, { driver, enabled: true }]),
          ),
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [blocked.instanceId]: { enabled: false } } },
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => providers),
          refreshUsageIfStale: ({ instanceIds, staleObservations }) =>
            Effect.sync(() => {
              assert.deepEqual(instanceIds, [stale.instanceId]);
              assert.deepEqual(staleObservations(instance("stale", now)), []);
              assert.deepEqual(staleObservations(stale), ["account", "window:quota"]);
              providers = [instance("stale", now), blocked, noAdapter, fresh, unsupported];
              return providers;
            }),
        }),
        adapterRegistryLayer([
          stale.instanceId,
          blocked.instanceId,
          fresh.instanceId,
          unsupported.instanceId,
        ]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const result = yield* Effect.flatMap(
        OrchestratorMcpService.OrchestratorMcpService,
        (service) => service.capabilities(scope, { usage: true }),
      ).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      assert.equal(
        result.providers.find((provider) => provider.providerInstanceId === stale.instanceId)?.usage
          ?.measuredAt,
        now,
      );
    }),
  );

  it.effect.each([
    {
      name: "outside the re-check window",
      checkedAt: "2026-11-13T00:00:00.000Z",
      checkedMeanwhile: false,
      expected: { usable: true, refreshes: 1 },
    },
    {
      name: "inside the re-check window",
      checkedAt: "2026-11-13T00:00:50.000Z",
      checkedMeanwhile: false,
      expected: { usable: false, refreshes: 0 },
    },
    {
      name: "once when a concurrent caller checked it first",
      checkedAt: "2026-11-13T00:00:00.000Z",
      checkedMeanwhile: true,
      expected: { usable: true, refreshes: 0 },
    },
  ])("capabilities re-check a provider last seen not installed $name", (row) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-13T00:01:00.000Z"));
      let installed = false;
      let reads = 0;
      let refreshes = 0;
      const snapshot = (): ServerProvider => ({
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...(installed ? {} : { installed: false, status: "error" as const }),
        checkedAt: installed ? "2026-11-13T00:01:00.000Z" : row.checkedAt,
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => {
            reads += 1;
            // Another caller's check finishes between this caller's first read and its own check.
            if (row.checkedMeanwhile && reads > 1) installed = true;
            return [snapshot()];
          }),
          refreshInstance: () =>
            Effect.sync(() => {
              refreshes += 1;
              installed = true;
              return [snapshot()];
            }),
        }),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      const result = yield* Effect.flatMap(
        OrchestratorMcpService.OrchestratorMcpService,
        (service) => service.capabilities(scope),
      ).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      assert.deepEqual({ usable: result.providers[0]!.canRunChildTask, refreshes }, row.expected);
    }),
  );

  it.effect.each(["already advertised", "newly advertised", "still unavailable"] as const)(
    "rechecks a delegated model that is %s",
    (availability) =>
      Effect.gen(function* () {
        const museInstanceId = ProviderInstanceId.make("muse");
        const model = "muse-wonder-1.0";
        const provider = (advertisedModel: string) =>
          providerSnapshot({
            instanceId: museInstanceId,
            driver: ProviderDriverKind.make("muse"),
            model: advertisedModel,
          });
        const commands: Array<unknown> = [];
        const refreshedInstances: Array<ProviderInstanceId> = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: museInstanceId,
          model,
          status: "running",
          result: null,
        };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(commands.length > 0 ? [task] : [])
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
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            // A refresh replaces the registry's snapshot, which later reads return.
            getProviders: Effect.sync(() => [
              provider(
                availability === "already advertised" ||
                  (availability === "newly advertised" && refreshedInstances.length > 0)
                  ? model
                  : "muse-spark-1.3",
              ),
            ]),
            refreshInstance: (instanceId) =>
              Effect.sync(() => {
                refreshedInstances.push(instanceId);
                return [provider(availability === "still unavailable" ? "muse-spark-1.3" : model)];
              }),
          }),
          adapterRegistryLayer([museInstanceId]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const delegation = service.delegateTask(scope, {
            task: "Review the change.",
            target: { providerInstanceId: museInstanceId, model },
            mode: "async",
            clientRequestId: availability,
          });
          if (availability === "still unavailable") {
            const error = yield* delegation.pipe(Effect.flip);
            assert.equal(error.code, "model_unavailable");
            assert.deepEqual(commands, []);
          } else {
            const result = yield* delegation;
            assert.equal(result.model, model);
            assert.equal(commands.length, 1);
            assert.deepEqual((commands[0] as { modelSelection: unknown }).modelSelection, {
              instanceId: museInstanceId,
              model,
            });
          }
          assert.deepEqual(
            refreshedInstances,
            availability === "already advertised" ? [] : [museInstanceId],
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );
  it.effect(
    "a re-check that outlasts one wait piece finishes on its own while the request is answered",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-13T00:01:00.000Z"));
        let installed = false;
        let refreshes = 0;
        const snapshot = (): ServerProvider => ({
          ...providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          ...(installed ? {} : { installed: false, status: "error" as const }),
          checkedAt: installed ? "2026-11-13T00:02:20.000Z" : "2026-11-13T00:00:00.000Z",
        });
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => [snapshot()]),
            // A probe slower than a linked machine's request may stay silent.
            refreshInstance: () =>
              Effect.sleep("80 seconds").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    refreshes += 1;
                    installed = true;
                    return [snapshot()];
                  }),
                ),
              ),
          }),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const answered = <A, E>(fiber: Fiber.Fiber<A, E>) =>
            TestClock.withLive(Fiber.join(fiber).pipe(Effect.timeout("10 seconds")));

          const reading = yield* service.capabilities(scope).pipe(Effect.forkChild);
          const delegating = yield* service
            .delegateTask(scope, {
              task: "Summarize the diff.",
              target: { providerInstanceId: codexInstanceId },
              mode: "async",
              clientRequestId: "delegate-while-checking",
            })
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("50 seconds");
          const read = yield* answered(reading);
          assert.isFalse(read.providers[0]!.canRunChildTask);
          assert.include(
            read.providers[0]!.constraints,
            "A new check of this provider is still running; ask again for its result.",
          );
          const refused = yield* answered(delegating);
          assert.equal(refused.code, "provider_unavailable");
          assert.isTrue(refused.message.endsWith("ask again for its result."), refused.message);

          yield* TestClock.adjust("30 seconds");
          const again = yield* service.capabilities(scope);
          assert.deepEqual(
            { usable: again.providers[0]!.canRunChildTask, refreshes },
            { usable: true, refreshes: 1 },
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );
  it.effect(
    "a role's provider and the parent's, both still being checked, hold a delegation for one wait",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-13T00:01:00.000Z"));
        const roleInstanceId = ProviderInstanceId.make("codex-alt");
        const installed = new Set<ProviderInstanceId>();
        const snapshot = (instanceId: ProviderInstanceId): ServerProvider => ({
          ...providerSnapshot({
            instanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          ...(installed.has(instanceId) ? {} : { installed: false, status: "error" as const }),
          checkedAt: installed.has(instanceId)
            ? "2026-11-13T00:02:20.000Z"
            : "2026-11-13T00:00:00.000Z",
        });
        const snapshots = () => [snapshot(codexInstanceId), snapshot(roleInstanceId)];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest({
            delegatedTaskModelSelections: {
              general: { instanceId: roleInstanceId, model: "gpt-5.4" },
            },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(snapshots),
            // Each provider's probe outlasts one wait piece.
            refreshInstance: (instanceId) =>
              Effect.sleep("80 seconds").pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    installed.add(instanceId);
                    return snapshots();
                  }),
                ),
              ),
          }),
          adapterRegistryLayer([codexInstanceId, roleInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          // The role's provider is checked first, then the parent's as its fallback.
          const delegating = yield* service
            .delegateTask(scope, {
              task: "Summarize the diff.",
              mode: "async",
              clientRequestId: "delegate-role-while-checking",
            })
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("50 seconds");
          const refused = yield* TestClock.withLive(
            Fiber.join(delegating).pipe(Effect.timeout("10 seconds")),
          );
          assert.equal(refused.code, "provider_unavailable");
          assert.isTrue(refused.message.endsWith("ask again for its result."), refused.message);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );
  it.effect(
    "requests that come while a provider's check runs wait for it, not for checks of their own",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-13T00:01:00.000Z"));
        let refreshes = 0;
        // A check can end without a new reading, as for an instance the registry no longer knows.
        const snapshot = (): ServerProvider => ({
          ...providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          installed: false,
          status: "error" as const,
          checkedAt: "2026-11-13T00:00:00.000Z",
        });
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => [snapshot()]),
            refreshInstance: () =>
              Effect.sync(() => {
                refreshes += 1;
              }).pipe(Effect.andThen(Effect.sleep("80 seconds")), Effect.as([snapshot()])),
          }),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const readings = yield* Effect.forEach([1, 2, 3], () =>
            service.capabilities(scope).pipe(Effect.forkChild),
          );
          yield* TestClock.adjust("50 seconds");
          for (const reading of readings) {
            const read = yield* TestClock.withLive(
              Fiber.join(reading).pipe(Effect.timeout("10 seconds")),
            );
            assert.include(
              read.providers[0]!.constraints,
              "A new check of this provider is still running; ask again for its result.",
            );
          }
          // Long after that check ended, none of the requests has started another.
          yield* TestClock.adjust("200 seconds");
          assert.equal(refreshes, 1);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("delegates to a model only the parent project's folder config advertises", () =>
    Effect.gen(function* () {
      const opencodeInstanceId = ProviderInstanceId.make("opencode");
      const workspaceRoot = "/work/uni";
      const model = "uni/medium-local";
      const machineModels = [
        { slug: "opencode/big-pickle", name: "Big Pickle", isCustom: false, capabilities: null },
      ];
      const opencode: ServerProvider = {
        ...providerSnapshot({
          instanceId: opencodeInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        models: machineModels,
        workspaceSnapshots: [
          {
            cwd: workspaceRoot,
            checkedAt: "2026-09-13T00:00:00.000Z",
            slashCommands: [],
            skills: [],
            models: [
              ...machineModels,
              { slug: model, name: "Medium Local", isCustom: false, capabilities: null },
            ],
          },
        ],
      };
      const commands: Array<unknown> = [];
      const task = {
        id: taskId,
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId,
        providerInstanceId: opencodeInstanceId,
        model,
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(commands.length > 0 ? [task] : [])
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
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([opencode]),
          refreshInstance: () => Effect.succeed([opencode]),
          refreshWorkspaceSnapshot: () => Effect.succeed([opencode]),
        }),
        adapterRegistryLayer([opencodeInstanceId]),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId, workspaceRoot } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope, { search: "local" });
        assert.deepEqual(
          capabilities.providers
            .find((provider) => provider.providerInstanceId === opencodeInstanceId)
            ?.models.map((listed) => listed.id),
          [model],
        );
        const result = yield* service.delegateTask(scope, {
          task: "Review the change.",
          target: { providerInstanceId: opencodeInstanceId, model },
          mode: "async",
          clientRequestId: "folder-scoped-model",
        });
        assert.equal(result.model, model);
        assert.deepEqual((commands[0] as { modelSelection: unknown }).modelSelection, {
          instanceId: opencodeInstanceId,
          model,
        });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("gives a worktree child in a project whose folder holds several repositories", () =>
    Effect.gen(function* () {
      // A plain project folder: Git finds no repository at its root, only in a/ and b/.
      const workspaceRoot = "/work/several-repos";
      const commands: Array<unknown> = [];
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
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? (() => {
                    const parent = parentProjection(commands.length > 0 ? [task] : []);
                    return {
                      ...parent,
                      thread: { ...parent.thread, worktreePath: null },
                    } as OrchestrationV2ThreadProjection;
                  })()
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
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ id: projectId, title: "parent", workspaceRoot } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const notARepository = (cwd: string) =>
        new GitCommandError({
          operation: "GitVcsDriver.resolveCommit",
          command: "git rev-parse --verify HEAD^{commit}",
          cwd,
          detail: "fatal: not a git repository (or any of the parent directories): .git",
        });
      const layerService = OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            isNonGitProject: () => Effect.succeed(true),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit: ({ cwd }) => Effect.fail(notARepository(cwd)),
          }),
        ),
        Layer.provide(dependencies),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service
          .delegateTask(scope, {
            task: "Add a line to a/README.md.",
            isolation: "worktree",
            mode: "async",
            clientRequestId: "worktree-several-repos",
          })
          .pipe(Effect.result);
        assert.isTrue(
          Result.isSuccess(result),
          `worktree isolation was refused: ${Result.isFailure(result) ? result.failure.message : ""}`,
        );
        assert.equal(
          (commands[0] as { workspaceStrategy?: { type: string } }).workspaceStrategy?.type,
          "worktree",
        );
      }).pipe(Effect.provide(layerService));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryAdmission.layerTest(),
          Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(false) }),
        ),
      ),
    ),
  );

  // docs/user/multi-repo-projects.md: each repository starts from the thread's base branch
  // where it has one, so the child's launch has to carry the parent's branch, not only its commit.
  it.live(
    "names the parent's branch as a worktree child's base so other repositories can match it",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const workspaceRoot = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-delegate-base-" }),
        );
        for (const args of [
          ["init", "-b", "main"],
          ["config", "user.email", "delegate@example.test"],
          ["config", "user.name", "Delegate"],
          ["commit", "--allow-empty", "-m", "main"],
          ["checkout", "-b", "release"],
          ["commit", "--allow-empty", "-m", "release"],
        ]) {
          yield* git.execute({ operation: "delegate-base-test", cwd: workspaceRoot, args });
        }
        const commands: Array<unknown> = [];
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
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? (() => {
                      const parent = parentProjection(commands.length > 0 ? [task] : []);
                      return {
                        ...parent,
                        thread: { ...parent.thread, worktreePath: null, branch: "release" },
                      } as OrchestrationV2ThreadProjection;
                    })()
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
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({ id: projectId, title: "parent", workspaceRoot } as never),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            isNonGitProject: () => Effect.succeed(false),
          }),
          Layer.succeed(GitVcsDriver.GitVcsDriver, git),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          yield* service.delegateTask(scope, {
            task: "Change a and b together.",
            isolation: "worktree",
            mode: "async",
            clientRequestId: "worktree-parent-branch",
          });
          const workspaceStrategy = (commands[0] as { workspaceStrategy?: unknown })
            .workspaceStrategy;
          assert.include(
            JSON.stringify(workspaceStrategy),
            "release",
            "the child's workspace names only the parent's commit, so other repositories fall back to their default branch",
          );
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(dependencies))));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            GitVcsDriver.layer.pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-delegate-base-" }),
              ),
              Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            MemoryAdmission.layerTest(),
            Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(false) }),
          ),
        ),
      ),
  );

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
        NodeCrypto.layer,
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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

  const peer = (status: PeerLinkSummary["status"], access: PeerLinkSummary["access"]) =>
    ({
      environmentId: EnvironmentId.make("env-vps"),
      label: "Zoro-VPS",
      status,
      access,
    }) as PeerLinkSummary;

  it.effect.each([
    {
      name: "names a reachable full-access linked machine",
      links: [peer("reachable", "full-access")],
      includes: ["Zoro-VPS, environmentId env-vps", "target.environmentId"],
      excludes: ["Do the work inline"],
    },
    {
      name: "advises inline work when no linked machine can take it",
      links: [peer("unreachable", "full-access"), peer("reachable", "read-only")],
      includes: ["Do the work inline in this thread instead"],
      excludes: ["env-vps"],
    },
  ])("refuses a delegated task while memory is short and $name", ({ links, includes, excludes }) =>
    Effect.gen(function* () {
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
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const shortage = {
        kind: "available",
        totalBytes: 8 * 1024 ** 3,
        availableBytes: 1024 ** 3,
        reserveBytes: 2 * 1024 ** 3,
      } as const;

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // Nothing that creates a thread is mocked, so a start past the check would die.
        const refused = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-memory-1",
          })
          .pipe(Effect.flip);
        assert.equal(refused.code, "memory_short");
        assert.include(refused.message, "1 GiB of 8 GiB is available, under the 2 GiB reserve");
        for (const text of includes) assert.include(refused.message, text);
        for (const text of excludes) assert.notInclude(refused.message, text);
      }).pipe(
        Effect.provide(
          layerOrchestratorServiceWithGit({}, MemoryAdmission.layerTest(shortage), links).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
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
        NodeCrypto.layer,
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
        AccountRouting.layer.pipe(
          Layer.provide(Layer.mergeAll(shared, Layer.mock(ProviderMcp.ProviderMcp)({}))),
        ),
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
          NodeCrypto.layer,
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
            failoverLaunch: (input) =>
              Effect.succeed({ selection: input.selection, failover: null }),
            accountsWithRoom: () =>
              Ref.get(limit).pipe(
                Effect.map((limited) =>
                  limited === null
                    ? [{ ...selection, mcpSignInsNeeded: [], onCredits: false }]
                    : [],
                ),
              ),
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
  it.effect.each(["async", "wait"] as const)(
    "prepares a delegated child whose %s caller goes away after its run commits",
    (mode) =>
      Effect.gen(function* () {
        const runCommitted = yield* Deferred.make<void>();
        const wakePolicies = yield* Ref.make<ReadonlyArray<string>>([]);
        const finishDispatch = yield* Deferred.make<void>();
        const prepared = yield* Deferred.make<void>();
        const childRunId = RunId.make("run:mcp-delegate-caller-gone");
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
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
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection([]) : childProjection),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            assertProviderInstanceEnabled: () => Effect.void,
            dispatch: (command) =>
              command.type === "delegated_task.wake-policy"
                ? Ref.update(wakePolicies, (policies) => [
                    ...policies,
                    command.completionWake,
                  ]).pipe(Effect.as({ sequence: 3, storedEvents: [] } as never))
                : Deferred.succeed(runCommitted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishDispatch)),
                    Effect.as({
                      sequence: 2,
                      storedEvents: [
                        {
                          sequence: 1,
                          commandId: null,
                          event: { type: "subagent.updated", payload: task },
                        },
                        {
                          sequence: 2,
                          commandId: null,
                          event: {
                            type: "run.created",
                            threadId: childThreadId,
                            payload: { id: childRunId, workspacePreparation: { type: "root" } },
                          },
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
          ]),
          adapterRegistryLayer([codexInstanceId]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );
        const layerService = OrchestratorMcpService.layer.pipe(
          Layer.provide(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              prepareRun: (input) =>
                input.runId === childRunId ? Deferred.succeed(prepared, undefined) : Effect.void,
            }),
          ),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const delegation = yield* Effect.forkChild(
            service.delegateTask(scope, {
              task: "Summarize the diff.",
              target: { driverKind: ProviderDriverKind.make("codex") },
              mode,
              clientRequestId: `delegate-caller-gone-${mode}`,
            }),
          );
          yield* Deferred.await(runCommitted);
          yield* Effect.sync(() => delegation.interruptUnsafe());
          yield* Deferred.succeed(finishDispatch, undefined);
          yield* Fiber.await(delegation);
          yield* Deferred.await(prepared);
          assert.deepEqual(yield* Ref.get(wakePolicies), mode === "wait" ? ["always"] : []);
        }).pipe(Effect.provide(layerService.pipe(Layer.provide(layerDependencies))));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            MemoryAdmission.layerTest(),
            Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(false) }),
          ),
        ),
      ),
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
          const registered = yield* Ref.make<ReadonlyArray<ServerProvider>>([
            providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
            providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
          ]);
          const limit = yield* Ref.make<AccountRouting.LaunchLimit | null>(null);
          const failover = yield* Ref.make(false);
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
                NodeCrypto.layer,
                layerRegistry,
                layerSettings,
                Layer.mock(ProviderRegistry.ProviderRegistry)({
                  getProviders: Ref.get(registered),
                  refreshInstance: () => Ref.get(registered),
                }),
                Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                Layer.mock(AccountRouting.AccountRouting)({
                  launchLimit: () => Ref.get(limit),
                  failoverLaunch: (input) =>
                    Ref.get(failover).pipe(
                      Effect.map((moved) =>
                        moved
                          ? {
                              selection: { instanceId: altInstanceId, model: "gpt-5.5" },
                              failover: {
                                reason: "usageLimit" as const,
                                crossProviderFrom: input.selection.instanceId,
                              },
                            }
                          : { selection: input.selection, failover: null },
                      ),
                    ),
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

            // Routing moves a fresh run off a limited account; the call reports the one it runs on.
            yield* Ref.set(failover, true);
            const moved = yield* service.createThreads(scope, {
              ...withPrompt,
              clientRequestId: "failover",
            });
            yield* Ref.set(failover, false);
            assert.equal(moved.threads[0]?.providerInstanceId, altInstanceId);
            assert.equal(moved.threads[0]?.model, "gpt-5.5");
            // A replay still reports that run after the user starts another on a different model.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("moved:later"),
              threadId: moved.threads[0]!.threadId,
              messageId: MessageId.make("moved:later"),
              text: "Then this.",
              attachments: [],
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              dispatchMode: { type: "queue_after_active" },
            });
            assert.deepEqual(
              yield* service.createThreads(scope, { ...withPrompt, clientRequestId: "failover" }),
              moved,
            );
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

            // A retry of an accepted entry does not depend on the provider still being registered.
            yield* Ref.set(registered, []);
            assert.deepEqual(yield* service.createThreads(scope, withPrompt), started);

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

  it.effect.each(["local", "remote"] as const)(
    "a blocking %s delegation cancelled mid-wait wakes its parent like an async task",
    (placement) =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          {
            instanceId: codexInstanceId,
            driver,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: () => Effect.die("The child never starts: the effect worker is off."),
          },
        ]);
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-wait-cancelled" },
          layerRegistry,
          { databaseLayer: layerDatabase, runEffectWorker: false },
        );
        const layerSettings = ServerSettings.layerTest({
          providerInstances: { [codexInstanceId]: { driver: "codex", enabled: true } },
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
        const waiting = yield* Deferred.make<void>();
        const layerWatchedThreads = Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            return {
              ...threads,
              streamStoredEventsFrom: (input) =>
                Stream.unwrap(
                  Deferred.succeed(waiting, undefined).pipe(
                    Effect.as(threads.streamStoredEventsFrom(input)),
                  ),
                ),
            } satisfies ThreadManagementService.ThreadManagementService["Service"];
          }),
        ).pipe(Layer.provideMerge(layerThreads));
        const remoteChild = {
          environmentId: EnvironmentId.make("environment:mcp-providers-box"),
          threadId: ThreadId.make("thread:mcp-providers-on-the-box"),
          label: "Box",
        };
        // Records the task as the real delegation does once the linked environment launched it.
        const layerRemoteDelegation = Layer.unwrap(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            return Layer.mock(RemoteDelegation.RemoteDelegation)({
              delegate: (_scope, anchor, input) =>
                Effect.gen(function* () {
                  yield* orchestrator.dispatch({
                    type: "delegated_task.remote.request",
                    commandId: CommandId.make("command:remote-delegate:wait-cancelled"),
                    parentThreadId,
                    parentRunId: anchor.runId,
                    parentNodeId: anchor.nodeId,
                    task: input.task,
                    driver: ProviderDriverKind.make("remote"),
                    modelSelection: anchor.thread.modelSelection,
                    remoteChild,
                    completionWake: "settled_only",
                  });
                  const parent = yield* orchestrator.getThreadProjection(parentThreadId);
                  return { taskId: parent.subagents[0]!.id };
                }).pipe(Effect.orDie),
              runStatus: () => Effect.succeed(null),
            });
          }),
        ).pipe(Layer.provide(layerWatchedThreads));
        const layerTest = layerOrchestratorService.pipe(
          Layer.provideMerge(layerWatchedThreads),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              layerRegistry,
              layerSettings,
              providerRegistryLayer([
                providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
              ]),
              Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              layerRemoteDelegation,
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP parent",
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("parent:message"),
            text: "Delegate a review and wait for it.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const call = yield* service
            .delegateTask(scope, {
              task: "Review the change.",
              ...(placement === "remote"
                ? { target: { environmentId: remoteChild.environmentId } }
                : {}),
              mode: "wait",
              clientRequestId: "delegate-wait-cancelled",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          // A steered Claude parent cancels the tools/call, which interrupts this fiber.
          yield* Fiber.interrupt(call);
          const parent = yield* orchestrator.getThreadProjection(parentThreadId);
          const task = parent.subagents.find((subagent) => subagent.origin === "app_owned");
          assert.equal(task?.status, "running");
          assert.equal(
            task?.completionWake,
            "always",
            "a cancelled blocking delegation left the task settled_only, so its result never reaches the still-live parent run",
          );
        }).pipe(Effect.provide(layerTest));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
          {
            name: "untargeted-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            target: undefined,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "explicit-model",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            target: { model: parentModelSelection.model },
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "explicit-options",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            target: { options: parentModelSelection.options },
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "driver-only-rechecks-not-installed",
            inheritedEnabled: true,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "inherited-needs-mcp-sign-in",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "inherited-on-prepaid-credits",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          // The last check ran while an update had the CLI moved aside.
          let installed = testCase.name !== "driver-only-rechecks-not-installed";
          const snapshots = (): ReadonlyArray<ServerProvider> => [
            {
              ...providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              ...(installed ? {} : { installed: false, status: "error" as const }),
            },
            providerSnapshot({
              instanceId: codexAltInstanceId,
              driver: testCase.candidateDriver,
              model: "codex-alt-model",
              enabled: testCase.peerEnabled,
            }),
          ];
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
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
              failoverLaunch: (input) =>
                Effect.sync(() => {
                  assert.equal(testCase.name, "untargeted-healthy");
                  assert.isFalse(input.discoverMcpSignIns);
                  return { selection: input.selection, failover: null };
                }),
              accountsWithRoom: () =>
                Effect.succeed([
                  ...(testCase.peerEnabled
                    ? [
                        {
                          instanceId: codexAltInstanceId,
                          model: "codex-alt-model",
                          mcpSignInsNeeded: [],
                          onCredits: false,
                        },
                      ]
                    : []),
                  ...(testCase.inheritedEnabled
                    ? [
                        {
                          instanceId: codexInstanceId,
                          model: "gpt-5.4",
                          mcpSignInsNeeded:
                            testCase.name === "inherited-needs-mcp-sign-in" ? ["threadpage"] : [],
                          onCredits: testCase.name === "inherited-on-prepaid-credits",
                        },
                      ]
                    : []),
                ]),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.sync(snapshots),
              refreshInstance: () =>
                Effect.sync(() => {
                  installed = true;
                  return snapshots();
                }),
            }),
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
              "target" in testCase
                ? testCase.target
                : testCase.name === "inherited-unavailable"
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
            } else if (testCase.selectedInstanceId === codexInstanceId) {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
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
      saved: ScheduledTask = tasks[0]!,
      /** Stores each keyed create under the id its key derives, as the real service does. */
      created?: Ref.Ref<ReadonlyArray<ScheduledTask>>,
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(MemoryAdmission.layerTest(), Layer.mock(PeerLinks.PeerLinks)({})),
        ),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
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
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeedSome({
                  id,
                  workspaceRoot: "/repo/scheduled",
                  defaultModelSelection: saved.modelSelection,
                } as Project),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              liveRuns: () => Effect.succeed(null),
              recentRunCounts: () => Effect.succeed(new Map()),
              list: () =>
                created === undefined
                  ? Effect.succeed({ tasks })
                  : Ref.get(created).pipe(Effect.map((stored) => ({ tasks: stored }))),
              upsert: (input) =>
                Ref.update(upserted, (count) => count + 1).pipe(
                  Effect.andThen(
                    created === undefined || input.commandId === undefined
                      ? Effect.void
                      : Ref.set(created, [
                          {
                            ...saved,
                            id: ScheduledTaskService.scheduledTaskIdForCommand(input.commandId),
                          },
                        ]),
                  ),
                  Effect.as({ task: saved }),
                ),
            }),
          ),
        ),
      );

    it.effect("lists a webhook task without its URL to a caller that may run it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => [summary.webhookUrl, summary.webhookSignature]),
          [[undefined, "none"]],
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
                    liveRuns: () => Effect.succeed(null),
                    recentRunCounts: () => Effect.succeed(new Map()),
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
        assert.deepEqual(
          listed.tasks.map((summary) => [summary.webhookUrl, summary.webhookSignature]),
          [[undefined, "none"]],
        );
      }),
    );

    it.effect("lists only the named task within the requested project", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const first = task({});
        const second = task({ id: ScheduledTaskId.make("scheduled-task:second") });
        const elsewhere = task({
          id: ScheduledTaskId.make("scheduled-task:elsewhere"),
          projectId: ProjectId.make("project:elsewhere"),
        });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service([first, second, elsewhere], null, upserted)),
        );
        const ids = (input: OrchestratorMcpListScheduledTasksInput) =>
          mcp
            .listScheduledTasks(supervisedClient, input)
            .pipe(Effect.map(({ tasks }) => tasks.map((summary) => summary.scheduledTaskId)));
        assert.deepEqual(yield* ids({ scheduledTaskId: second.id }), [second.id]);
        assert.deepEqual(yield* ids({ projectId, scheduledTaskId: elsewhere.id }), []);
      }),
    );

    it.effect("returns a webhook URL when creating a task, not when updating it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const hook = task({});
        const timer = task({
          schedule: { type: "interval", everyMs: 3_600_000 },
          webhook: undefined,
        });
        const created = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt: hook.prompt,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([hook], null, upserted)),
        );
        assert.equal(created.webhookUrl, "https://t3.example/hooks/secret");
        const converted = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.updateScheduledTask(supervisedClient, {
              scheduledTaskId: timer.id,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([timer], null, upserted, hook)),
        );
        assert.equal(converted.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId, description: "Checks the latest build." });
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
        assert.equal(listed.tasks[0]?.description, bound.description);
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
              Layer.provide(MemoryAdmission.layerTest()),
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
                  NodeCrypto.layer,
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
                    liveRuns: () => Effect.succeed(null),
                    recentRunCounts: () => Effect.succeed(new Map()),
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
    it.effect(
      "refuses to replay a creation over a task whose thread now runs above the caller",
      () =>
        Effect.gen(function* () {
          const upserted = yield* Ref.make(0);
          const created = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
          const bound = task({ threadId: boundThreadId });
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                [bound],
                liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
                upserted,
                bound,
                created,
              ),
            ),
          );
          const create = (prompt: string) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt,
              schedule: { type: "webhook" },
              freshSession: true,
              clientRequestId: "nightly",
            });
          yield* create("Check the build");
          const error = yield* create("Something else").pipe(Effect.flip);
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
                  NodeCrypto.layer,
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
                  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    liveRuns: () => Effect.succeed(null),
                    recentRunCounts: () => Effect.succeed(new Map()),
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
    /** An instant as the wall-clock time here, with no offset, as a fixed time names occurrences. */
    const localTime = (instant: string) => {
      const at = DateTime.toParts(
        DateTime.makeZonedUnsafe(instant, { timeZone: DateTime.zoneMakeLocal() }),
      );
      const two = (value: number) => String(value).padStart(2, "0");
      return `${at.year}-${two(at.month)}-${two(at.day)}T${two(at.hour)}:${two(at.minute)}`;
    };
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
      inputs?: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>,
      defaults: {
        readonly project: ScheduledTask["modelSelection"] | null;
        readonly environment?: ScheduledTask["modelSelection"];
      } = { project: existing.modelSelection },
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
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(null),
              ...threads,
            }),
            ServerSettings.layerTest(
              defaults.environment === undefined
                ? {}
                : { defaultModelSelection: defaults.environment },
            ),
            MemoryAdmission.layerTest(),
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
                  defaultModelSelection: defaults.project,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              liveRuns: () => Effect.succeed(null),
              recentRunCounts: () => Effect.succeed(new Map()),
              list: () => Effect.succeed({ tasks: listed }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.andThen(
                    inputs === undefined
                      ? Effect.void
                      : Ref.update(inputs, (all) => [...all, input]),
                  ),
                  Effect.as({ task: listed[0] ?? existing }),
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

    it.effect("a change names the chat that made it, or the client outside a chat", () =>
      Effect.gen(function* () {
        const at = "2026-11-13T19:41:29.000Z";
        const callerId = ThreadId.make("thread:scheduled-author");
        const caller = idleThreadProjection({ ...liveThreadShell(callerId), projectId });
        const stored = yield* Ref.make<ScheduledTask>(existing);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              [],
              { getThreadRecords: () => Effect.succeed(caller) },
              {
                list: () => Ref.get(stored).pipe(Effect.map((task) => ({ tasks: [task] }))),
                upsert: (input, by) =>
                  Ref.updateAndGet(stored, (task) => ({
                    ...task,
                    enabled: input.enabled,
                    changedBy: { ...by, at },
                  })).pipe(Effect.map((task) => ({ task }))),
              },
            ),
          ),
        );
        const author = Effect.map(
          mcp.listScheduledTasks(client, {}),
          (listed) => listed.tasks[0]?.changedBy,
        );
        assert.equal(yield* author, undefined);

        yield* mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, enabled: false });
        assert.deepEqual(yield* author, {
          kind: "mcp",
          threadId: null,
          client: "Claude Code",
          at,
        });

        const fromChat: McpInvocationScope = {
          ...client,
          thread: {
            threadId: callerId,
            providerSessionId: "provider:scheduled-author",
            providerInstanceId: caller.thread.providerInstanceId,
          },
          client: undefined,
        };
        yield* mcp.updateScheduledTask(fromChat, { scheduledTaskId: existing.id, enabled: true });
        assert.deepEqual(yield* author, { kind: "mcp", threadId: callerId, at });
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
      ].flatMap((row) =>
        ["create", "update"].flatMap((operation) =>
          ["model", "fallback"].flatMap((field) =>
            // A fallback on an account this machine lacks is the machine's that has it to check.
            field === "fallback" && row.catalog !== undefined ? [] : [{ ...row, operation, field }],
          ),
        ),
      ),
    )(
      "refuses $operation of an unverifiable scheduled $field: $catalog $model $options",
      ({ model, options, code, catalog, operation, field }) =>
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
          const selection =
            field === "fallback"
              ? { fallbackModelSelections: [modelSelection] }
              : { modelSelection };
          const result =
            operation === "update"
              ? mcp.updateScheduledTask(client, { scheduledTaskId: existing.id, ...selection })
              : mcp.scheduleTask(client, {
                  projectId,
                  prompt: "Run checks",
                  schedule,
                  ...selection,
                });
          assert.equal((yield* result.pipe(Effect.flip)).code, code);
          assert.deepEqual(
            (yield* mcp.listScheduledTasks(client, {})).tasks[0]?.modelSelection,
            existing.modelSelection,
          );
          assert.deepEqual(yield* Ref.get(saved), []);
        }),
    );

    it.effect.each(
      ["create", "update"].flatMap((operation) =>
        ["missing", "not installed"].map((account) => ({ operation, account })),
      ),
    )(
      "saves on $operation a scheduled fallback for an account $account here",
      ({ operation, account }) =>
        Effect.gen(function* () {
          // Another machine's account, with a custom model and an option this one does not list.
          const fallback = {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-custom",
            options: [{ id: "serviceTier", value: "fast" }],
            autoAccount: true,
          };
          const savedFallbacks: Array<ReadonlyArray<ModelSelection> | undefined> = [];
          const withoutCli: ServerProvider = {
            instanceId: fallback.instanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            checkedAt: "2026-11-08T00:00:00.000Z",
            models: [
              {
                slug: "claude-opus",
                name: "Claude Opus",
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
                yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
                [existing],
                {},
                {
                  upsert: (input) =>
                    Effect.sync(() => {
                      savedFallbacks.push(input.fallbackModelSelections);
                      return { task: existing };
                    }),
                },
                account === "missing" ? [] : [withoutCli],
              ),
            ),
          );
          const fallbackModelSelections = [fallback];
          yield* operation === "update"
            ? mcp.updateScheduledTask(client, {
                scheduledTaskId: existing.id,
                fallbackModelSelections,
              })
            : mcp.scheduleTask(client, {
                projectId,
                prompt: "Run checks",
                schedule,
                fallbackModelSelections,
              });
          assert.deepEqual(savedFallbacks, [fallbackModelSelections]);
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
        name: "started, thread quiet for longer than its provider's turns go",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "running",
        quietHours: 6,
        outcome: "failed",
      },
      {
        name: "started, thread still going behind a queued run someone cancelled",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "running",
        cancelledQueuedRun: true,
        outcome: "working",
      },
      {
        name: "started, thread completed before a queued run someone cancelled",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "completed",
        cancelledQueuedRun: true,
        outcome: "completed",
      },
      {
        name: "started, thread gone",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: undefined,
        outcome: "completed",
      },
      {
        name: "started, thread's turn over while a task it delegated runs",
        task: { lastRunAt: "2026-10-05T01:00:00.000Z", lastRunStatus: "succeeded" },
        runStatus: "completed",
        delegating: true,
        outcome: "working",
      },
      {
        name: "started for its 01:00 occurrence, thread completed",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          lastRunScheduledFor: "2026-10-05T01:00:00.000Z",
        },
        runStatus: "completed",
        outcome: "completed",
        occurrence: "2026-10-05T01:00:00.000Z",
      },
      {
        // Each machine reads a fixed time's occurrence in its own zone, so it carries no offset.
        name: "started for its fixed time, thread completed",
        task: {
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          lastRunScheduledFor: "2026-10-05T01:00:00.000Z",
        },
        runStatus: "completed",
        outcome: "completed",
        occurrence: localTime("2026-10-05T01:00:00.000Z"),
      },
      {
        name: "started now by hand, thread completed",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          lastRunScheduledFor: null,
        },
        runStatus: "completed",
        outcome: "completed",
        occurrence: null,
      },
      {
        name: "completed, then its run condition is checking the next one",
        task: {
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
          runCheckStartedAt: "2026-10-06T01:00:00.000Z",
          runCheckScheduledFor: "2026-10-06T01:00:00.000Z",
        },
        runStatus: "completed",
        checkingSince: "2026-10-06T01:00:00.000Z",
        checkingFor: "2026-10-06T01:00:00.000Z",
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
        name: "routed to another provider",
        task: {
          threadId: null,
          lastRunAt: "2026-10-05T01:00:00.000Z",
          lastRunStatus: "succeeded",
        },
        runStatus: "completed",
        outcome: "completed",
        routedModel: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
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
      ({ task, runStatus, outcome, checkingSince, checkingFor, ...row }) =>
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
                      : DateTime.now.pipe(
                          Effect.map(
                            (now) =>
                              ({
                                thread: {
                                  id: "thread:last-run",
                                  updatedAt: DateTime.subtract(now, {
                                    hours: "quietHours" in row ? row.quietHours : 0,
                                  }),
                                },
                                runs: [
                                  {
                                    ordinal: 1,
                                    status: runStatus,
                                    threadId: "thread:last-run",
                                    startedAt: "2026-10-05T01:00:00.000Z",
                                    ...("routedModel" in row
                                      ? {
                                          modelSelection: row.routedModel,
                                          crossProviderFailoverFrom: "claudeAgent",
                                        }
                                      : {}),
                                  },
                                  ...("cancelledQueuedRun" in row
                                    ? [
                                        {
                                          ordinal: 2,
                                          status: "cancelled",
                                          threadId: "thread:last-run",
                                          startedAt: null,
                                        },
                                      ]
                                    : []),
                                ],
                                subagents:
                                  "delegating" in row
                                    ? [
                                        {
                                          status: "running",
                                          completionDelivery: null,
                                          childThreadId: null,
                                        },
                                      ]
                                    : [],
                                providerThreads: [],
                              }) as never,
                          ),
                        ),
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
                  ...("occurrence" in row ? { occurrence: row.occurrence } : {}),
                  ...("routedModel" in row
                    ? { modelSelection: row.routedModel, crossProviderFailover: "usageLimit" }
                    : {}),
                },
          );
          assert.equal(tasks[0]?.checkingSince, checkingSince);
          assert.equal(tasks[0]?.checkingFor, checkingFor);
          assert.deepEqual(
            tasks[0]?.lastSkipped,
            "lastNoWorkSkip" in task
              ? { ...task.lastNoWorkSkip, occurrence: task.lastNoWorkSkip.scheduledFor }
              : undefined,
          );
        }),
    );

    it.effect(
      "lists a new-thread task's live runs against its limit and each task's recent run counts, and none for others",
      () =>
        Effect.gen(function* () {
          const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
          // The service counts no live runs for a task its limit does not apply to.
          const unlimited = { ...existing, id: ScheduledTaskId.make("task:unlimited") };
          const counts = {
            last7Days: { outcomes: { skipped: 3 }, skipReasons: { no_work: 3 } },
            last30Days: {
              outcomes: { succeeded: 1, skipped: 9 },
              skipReasons: { no_work: 8, usage_limited: 1 },
            },
          };
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                saved,
                [{ ...existing, maxLiveRuns: 2 }, unlimited],
                {},
                {
                  liveRuns: (task) => Effect.succeed(task.id === unlimited.id ? null : 1),
                  recentRunCounts: () => Effect.succeed(new Map([[existing.id, counts]])),
                },
              ),
            ),
          );
          const { tasks } = yield* mcp.listScheduledTasks(client, { projectId });
          assert.deepEqual(
            tasks.map((task) => [task.maxLiveRuns, task.liveRuns, task.runCounts]),
            [
              [2, 1, counts],
              [
                undefined,
                undefined,
                {
                  last7Days: { outcomes: {}, skipReasons: {} },
                  last30Days: { outcomes: {}, skipReasons: {} },
                },
              ],
            ],
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
              [
                runCondition,
                { ...lastNoWorkSkip, occurrence: lastNoWorkSkip.scheduledFor },
                [vps, here],
                here,
                "2026-11-10T00:00:00.000Z",
              ],
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

      it.effect(
        "lets a linked machine claim a shared task run only for itself or from itself",
        () =>
          Effect.gen(function* () {
            const claims = yield* Ref.make<ReadonlyArray<unknown>>([]);
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
              Effect.provide(
                service(
                  masterRepository,
                  yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
                  [{ ...existing, lastRunAt: "2026-11-12T07:35:01.000Z", lastRunStatus: "failed" }],
                  {},
                  {
                    claimOccurrence: (input) =>
                      Ref.update(claims, (all) => [...all, input]).pipe(Effect.as(input.holder)),
                  },
                ),
              ),
            );
            const peer = (linkedFrom: EnvironmentId): McpInvocationScope => ({
              ...client,
              client: { ...client.client!, linked: true, linkedFrom },
            });
            const claim = (
              scope: McpInvocationScope,
              holder: EnvironmentId,
              replaces: EnvironmentId | null,
            ) =>
              mcp.claimScheduledTaskOccurrence(scope, {
                scheduledTaskId: existing.id,
                occurrence: "2026-11-12T07:35:00.000Z",
                holder,
                replaces,
              });
            const refused = yield* Effect.all([
              claim(client, work, null).pipe(Effect.flip),
              claim(peer(cpc), work, null).pipe(Effect.flip),
              claim(peer(cpc), work, client.environmentId).pipe(Effect.flip),
            ]);
            assert.deepEqual(
              refused.map((error) => error.code),
              ["capability_denied", "capability_denied", "capability_denied"],
            );
            assert.deepEqual(yield* claim(peer(cpc), cpc, null), { holder: cpc });
            assert.deepEqual(yield* claim(peer(cpc), work, cpc), { holder: work });
            // Taking over from another machine tells the service whether this one's last run failed.
            assert.deepEqual(yield* claim(peer(cpc), cpc, work), { holder: cpc });
            const asked = (holder: EnvironmentId, replaces: EnvironmentId | null) => ({
              taskId: existing.id,
              occurrence: "2026-11-12T07:35:00.000Z",
              holder,
              replaces,
              by: cpc,
            });
            assert.deepEqual(yield* Ref.get(claims), [
              { ...asked(cpc, null), lastRunFailed: false },
              { ...asked(work, cpc), lastRunFailed: false },
              { ...asked(cpc, work), lastRunFailed: true },
            ]);
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
    it.effect("uses the environment's default model when the project inherits it", () =>
      Effect.gen(function* () {
        const environmentDefault = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5-5",
        };
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              [existing],
              {},
              {},
              [],
              [],
              inputs,
              { project: null, environment: environmentDefault },
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.modelSelection),
          [environmentDefault],
        );
      }),
    );

    it.effect.each([
      {
        name: "drops an emoji the limit splits",
        prompt: `${"a".repeat(79)}😀 rest`,
        title: "a".repeat(79),
      },
      {
        name: "keeps an emoji that ends at the limit",
        prompt: `${"a".repeat(78)}😀 rest`,
        title: `${"a".repeat(78)}😀`,
      },
    ])("a prompt-derived title $name", ({ prompt, title }) =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              [existing],
              {},
              {},
              [],
              [],
              inputs,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt, schedule });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.title),
          [title],
        );
      }),
    );

    it.effect("keeps one thread when fresh sessions are turned off before the first run", () =>
      Effect.gen(function* () {
        const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              masterRepository,
              yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
              [{ ...existing, threadMode: "fresh_session" }],
              {},
              {},
              [],
              [],
              inputs,
            ),
          ),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          freshSession: false,
        });
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(
          (yield* Ref.get(inputs)).map((input) => input.threadMode),
          ["continue", "new_thread"],
        );
      }),
    );

    it.effect(
      "refuses unbinding into fresh sessions in one call, which would keep the thread",
      () =>
        Effect.gen(function* () {
          const inputs = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                masterRepository,
                yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]),
                [
                  {
                    ...existing,
                    threadId: ThreadId.make("thread:scheduled-base"),
                    threadMode: "continue",
                  },
                ],
                {},
                {},
                [],
                [],
                inputs,
              ),
            ),
          );
          const refused = yield* mcp
            .updateScheduledTask(client, {
              scheduledTaskId: existing.id,
              bindToCurrentThread: false,
              freshSession: true,
            })
            .pipe(Effect.flip);
          assert.include(refused.message, "first unbind it");
          assert.deepEqual(yield* Ref.get(inputs), []);
        }),
    );

    it.effect("follows the default branch when a task is unbound from its thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(masterRepository, saved, [
              {
                ...existing,
                threadId: ThreadId.make("thread:scheduled-base"),
                threadMode: "continue",
              },
            ]),
          ),
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

    it.effect("keeps the saved workspace when an unbound task stays unbound", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [{ type: "root" }]);
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
        baseRef: "develop",
      },
      {
        name: "no remote, neither main nor master, a detached checkout",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/trunk", "HEAD"],
        detached: true,
        baseRef: "abc123",
      },
      {
        name: "a single-branch clone of a feature branch, no recorded HEAD",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/topic", "refs/remotes/origin/topic"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "a single-branch clone of a feature branch, a recorded HEAD",
        remote: "origin",
        remoteDefault: "trunk",
        refs: ["refs/heads/topic", "refs/remotes/origin/topic"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "no recorded HEAD, remote main and a stale local master",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/remotes/origin/main"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "no recorded HEAD, master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/remotes/origin/master"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "no recorded HEAD, local main and master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "no recorded HEAD, nothing conventional on the remote, local main",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/develop"],
        baseRef: "refs/remotes/origin/HEAD",
      },
      {
        name: "a recorded HEAD whose branch is gone",
        remote: "origin",
        remoteDefault: "main",
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "refs/remotes/origin/HEAD",
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
        baseRef: "refs/remotes/upstream/HEAD",
      },
    ])("$name starts from $baseRef", ({ remote, remoteDefault, refs, detached, baseRef }) =>
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
                // A repository here has its first local branch checked out unless detached.
                resolveBranchName: () =>
                  Effect.succeed(
                    detached === true
                      ? null
                      : (refs
                          .find((ref) => ref.startsWith("refs/heads/"))
                          ?.slice("refs/heads/".length) ?? null),
                  ),
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
          NodeCrypto.layer,
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
                              activeAttemptId: "attempt:mcp-restarted-child",
                            },
                          ]
                        : [],
                      // Claude ran the requested Opus on Sonnet.
                      providerTurns: [
                        {
                          runAttemptId: "attempt:mcp-restarted-child",
                          ordinal: 1,
                          model: "claude-sonnet-4-6",
                        },
                      ],
                    } as unknown as OrchestrationV2ThreadProjection),
              ),
          }),
          ServerSettings.layerTest(),
          providerRegistryLayer([]),
          adapterRegistryLayer([]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          for (const [selection, executedModel] of [
            [runSelection, "claude-sonnet-4-6"],
            [threadSelection, null],
          ] as const) {
            const result = yield* service.taskStatus(scope, taskId);
            assert.equal(result.providerInstanceId, selection.instanceId);
            assert.equal(result.model, selection.model);
            assert.deepEqual(result.options, selection.options);
            assert.equal(result.executedModel, executedModel);
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
        const antigravityId = ProviderInstanceId.make("antigravity");
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
            name: "parent named the same model by alias",
            parent: { ...inherited, model: "gpt" },
            target: { model: inherited.model },
            expected: inherited,
          },
          {
            name: "same model as a parent on its alias",
            parent: { ...inherited, model: "gpt" },
            target: { model: inherited.model, options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
          },
          {
            // Auto picks its own model when a child starts, so a model the target names runs as named.
            name: "an Auto parent's model",
            parent: { ...inherited, autoAccount: true },
            target: { model: inherited.model },
            expected: inherited,
          },
          {
            // Auto would run the options saved for Auto in place of the given ones.
            name: "an Auto parent's model with options",
            parent: { ...inherited, autoAccount: true },
            target: { model: inherited.model, options: override },
            expected: { ...inherited, options: [...override, inherited.options[1]] },
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
            name: "Antigravity model with a thinking suffix",
            target: { providerInstanceId: antigravityId, model: "gemini-4-neon-high" },
            expected: {
              instanceId: antigravityId,
              model: "gemini-4-neon",
              options: [{ id: "thought_level", value: "high" }],
            },
          },
          {
            name: "explicit Antigravity thinking overrides the suffix",
            target: {
              providerInstanceId: antigravityId,
              model: "gemini-4-neon-high",
              options: { thought_level: "medium" },
            },
            expected: {
              instanceId: antigravityId,
              model: "gemini-4-neon",
              options: [{ id: "thought_level", value: "medium" }],
            },
          },
          {
            name: "clear Antigravity suffix options",
            target: { providerInstanceId: antigravityId, model: "gemini-4-neon-high", options: {} },
            expected: { instanceId: antigravityId, model: "gemini-4-neon", options: [] },
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
            // Listed as the model runs the old level, which it no longer offers by that name.
            inheritedOptions: [
              { id: "effort", value: "xhigh" },
              { id: "ultracode", value: true },
            ],
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
          {
            name: "a parent's level the model no longer offers, and one saved twice",
            parent: {
              instanceId: codexInstanceId,
              model: "ultracode-model",
              options: [
                { id: "effort", value: "max" },
                { id: "effort", value: "high" },
                { id: "effort", value: "xhigh" },
                { id: "ultracode", value: true },
              ],
            },
            inheritedOptions: [
              { id: "effort", value: "high" },
              { id: "ultracode", value: true },
            ],
            target: { model: "ultracode-model" },
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
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(
                        commands.length > 0 ? [task] : [],
                        "parent" in testCase ? testCase.parent : inherited,
                      )
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
              {
                ...providerSnapshot({
                  instanceId: antigravityId,
                  driver: ProviderDriverKind.make("antigravity"),
                }),
                models: [
                  {
                    slug: "gemini-4-neon",
                    name: "Gemini 4 Neon",
                    isCustom: false,
                    capabilities: {
                      optionDescriptors: [
                        {
                          id: "thought_level",
                          role: "reasoning",
                          label: "Thinking",
                          type: "select",
                          options: [
                            { id: "medium", label: "Medium" },
                            { id: "high", label: "High" },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ]),
            adapterRegistryLayer([codexInstanceId, peerId, antigravityId]),
            Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const capabilities = yield* service.capabilities(scope);
            assert.deepEqual(
              capabilities.inheritedOptions,
              "inheritedOptions" in testCase ? testCase.inheritedOptions : parent.options,
            );
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

  it.effect("a task may pick the agent's own mode only from a full-access parent", () =>
    Effect.gen(function* () {
      const agentId = ProviderInstanceId.make("acp-agent");
      const mode = [{ id: "_t3/session-mode", value: "yolo" }] as const;
      const delegateFrom = (
        runtimeMode: "approval-required" | "full-access",
        held: ReadonlyArray<{ readonly id: string; readonly value: unknown }> | undefined,
      ) => {
        const commands: Array<unknown> = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: agentId,
          model: "default",
          status: "running",
          result: null,
        };
        const parent = () =>
          parentProjection(commands.length > 0 ? [task] : [], {
            instanceId: agentId,
            model: "default",
            ...(held === undefined ? {} : { options: held }),
          });
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? { ...parent(), thread: { ...parent().thread, runtimeMode } }
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
                instanceId: agentId,
                driver: ProviderDriverKind.make("acpRegistry"),
                model: "default",
              }),
              models: [
                {
                  slug: "default",
                  name: "Default",
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "_t3/session-mode",
                        label: "Mode",
                        type: "select",
                        role: "mode",
                        options: [
                          { id: "ask", label: "Ask" },
                          { id: "yolo", label: "YOLO" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ]),
          adapterRegistryLayer([agentId]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        return Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const outcome = yield* service
            .delegateTask(scope, {
              task: "Review the change.",
              target: yield* decodeTarget({ options: mode }),
              mode: "async",
              clientRequestId: `mode-${runtimeMode}-${held === undefined ? "new" : "held"}`,
            })
            .pipe(Effect.exit);
          return { outcome, commands };
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      };

      const refused = yield* delegateFrom("approval-required", undefined);
      assert.isTrue(Exit.isFailure(refused.outcome));
      assert.include(JSON.stringify(refused.outcome), "runtime_mode_escalation_denied");
      assert.lengthOf(refused.commands, 0);

      // A parent already running in that mode hands it on; a full-access parent may pick it.
      for (const allowed of [
        yield* delegateFrom("approval-required", mode),
        yield* delegateFrom("full-access", undefined),
      ]) {
        assert.isTrue(Exit.isSuccess(allowed.outcome), JSON.stringify(allowed.outcome));
        assert.deepEqual(
          (allowed.commands[0] as { modelSelection: { options: unknown } }).modelSelection.options,
          mode,
        );
      }
    }),
  );
  it.effect("validates options against the model a target names by alias", () =>
    Effect.gen(function* () {
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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

  // t3_thread_launch keeps a model selection as given, so a thread can hold a model alias, and an
  // option or a value its model lacks.
  it.effect.each(["gpt-5.4", "sol"] as const)(
    "accepts the inherited options it reports back as a delegate target, on a parent model stored as %s",
    (storedModel) =>
      Effect.gen(function* () {
        const inherited = {
          instanceId: codexInstanceId,
          model: storedModel,
          options: [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: false },
            { id: "serviceTier", value: "priority" },
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
          NodeCrypto.layer,
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
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  aliases: ["sol"],
                  isCustom: false,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "reasoningEffort",
                        label: "Reasoning",
                        type: "select",
                        options: [
                          { id: "low", label: "Low" },
                          { id: "high", label: "High" },
                        ],
                      },
                      {
                        id: "serviceTier",
                        label: "Service tier",
                        type: "select",
                        options: [{ id: "flex", label: "Flex" }],
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
            clientRequestId: "reported",
          });
          // Options the agent names join the inherited ones the model still offers.
          yield* service.delegateTask(scope, {
            task: "Review the change.",
            target: yield* decodeTarget({ options: { reasoningEffort: "high" } }),
            mode: "async",
            clientRequestId: "named",
          });
          // A target that names only the parent's account still inherits its model and options.
          yield* service.delegateTask(scope, {
            task: "Review the change.",
            target: yield* decodeTarget({ providerInstanceId: codexInstanceId }),
            mode: "async",
            clientRequestId: "account",
          });
          assert.deepEqual(inheritedOptions, [inherited.options[0]]);
          assert.deepEqual(
            commands.map((command) => command.modelSelection),
            [
              { ...inherited, options: [inherited.options[0]] },
              { ...inherited, options: [{ id: "reasoningEffort", value: "high" }] },
              { ...inherited, options: [inherited.options[0]] },
            ],
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      }),
  );

  it.effect("starts a task on its role's model, keeping the Auto settings chose", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claude_work");
      const staleInstanceId = ProviderInstanceId.make("claude_stale");
      const maxEffort = { id: "effort", value: "max" };
      const commands: Array<{ readonly modelSelection?: unknown; readonly review?: unknown }> = [];
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
      let staleRechecked = false;
      const providers = (): ReadonlyArray<ServerProvider> => [
        providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        {
          ...providerSnapshot({
            instanceId: claudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-opus",
          }),
          models: [
            {
              slug: "claude-opus",
              name: "claude-opus",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select",
                    options: [{ id: "max", label: "Max" }],
                  },
                ],
              },
            },
          ],
        },
        staleRechecked
          ? providerSnapshot({
              instanceId: staleInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              model: "claude-opus",
            })
          : {
              ...providerSnapshot({
                instanceId: staleInstanceId,
                driver: ProviderDriverKind.make("claudeAgent"),
                model: "claude-retired",
              }),
              installed: false,
              status: "error",
            },
      ];
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
            command.type === "delegated_task.request" && command.task.endsWith("Round 4.")
              ? Effect.fail(
                  new Orchestrator.OrchestratorReviewRoundLimitError({
                    commandId: command.commandId,
                    threadId: parentThreadId,
                    part: 1,
                    rounds: 3,
                  }),
                )
              : Effect.sync(() => {
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
            // An account that is gone falls back to the parent's model, as does a model it dropped.
            review: { instanceId: ProviderInstanceId.make("claude_removed"), model: "claude-opus" },
            research: { instanceId: claudeInstanceId, model: "claude-retired" },
            // Its account read unusable with the model, and once rechecked offers it no more.
            design: { instanceId: staleInstanceId, model: "claude-retired" },
          },
          finalReviewModelSelections: [
            { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
          ],
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.sync(() => providers()),
          refreshInstance: (instanceId) =>
            Effect.sync(() => {
              if (instanceId === staleInstanceId) staleRechecked = true;
              return providers();
            }),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId, staleInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const newPartReason = "Split the migration into its own change.";
        for (const [index, [role, target, newReviewPart]] of (
          [
            ["implementation", undefined, undefined],
            ["implementation", { model: "gpt-5.4" }, undefined],
            ["review", undefined, undefined],
            // A reviewer named by account runs there, though a setting picks it with Auto.
            [
              "review",
              { providerInstanceId: claudeInstanceId, model: "claude-opus" },
              newPartReason,
            ],
            // Given options run as named, on the role's model or the reviewer's account.
            ["implementation", { options: { effort: "max" } }, undefined],
            [
              "review",
              {
                providerInstanceId: claudeInstanceId,
                model: "claude-opus",
                options: { effort: "max" },
              },
              undefined,
            ],
            ["research", { options: { effort: "max" } }, undefined],
            ["design", undefined, undefined],
          ] as const
        ).entries()) {
          yield* service.delegateTask(scope, {
            task: "Do the work.",
            role,
            ...(target === undefined ? {} : { target: yield* decodeTarget(target) }),
            ...(newReviewPart === undefined ? {} : { newReviewPart }),
            mode: "async",
            clientRequestId: `${role}:${index}`,
          });
        }
        // The parent's model would take the option, but the role's model is the one asked for.
        const rejected = yield* service
          .delegateTask(scope, {
            task: "Do the work.",
            role: "implementation",
            target: yield* decodeTarget({ options: { effort: "turbo" } }),
            mode: "async",
            clientRequestId: "implementation:rejected",
          })
          .pipe(Effect.flip);
        assert.equal(rejected.code, "invalid_request");
        assert.deepEqual(
          commands.map((command) => command.modelSelection),
          [
            { instanceId: claudeInstanceId, model: "claude-opus", autoAccount: true },
            // A model the agent names wins over the role's.
            { instanceId: codexInstanceId, model: "gpt-5.4" },
            { instanceId: codexInstanceId, model: "gpt-5.4" },
            { instanceId: claudeInstanceId, model: "claude-opus" },
            { instanceId: claudeInstanceId, model: "claude-opus", options: [maxEffort] },
            { instanceId: claudeInstanceId, model: "claude-opus", options: [maxEffort] },
            { instanceId: codexInstanceId, model: "gpt-5.4", options: [maxEffort] },
            { instanceId: codexInstanceId, model: "gpt-5.4" },
          ],
        );
        // Only a review task asks its parent to count it.
        assert.deepEqual(
          commands.map((command) => command.review),
          [undefined, undefined, {}, { newPartReason }, undefined, {}, undefined, undefined],
        );
        const misplaced = yield* service
          .delegateTask(scope, {
            task: "Do the work.",
            role: "implementation",
            newReviewPart: newPartReason,
            mode: "async",
          })
          .pipe(Effect.flip);
        assert.equal(misplaced.code, "invalid_request");
        const refused = yield* service
          .delegateTask(scope, {
            task: "Round 4.",
            role: "review",
            mode: "async",
            clientRequestId: "review:round-4",
          })
          .pipe(Effect.flip);
        assert.equal(refused.code, "review_round_limit");
        assert.include(refused.message, "~/.agents/rules/review.md");
        assert.equal(commands.length, 8);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  // A Claude Auto thread reviewing on its own account while Codex is out of usage: Auto would pick
  // the child's provider, account and options again, so a child that names any of them runs as named.
  it.effect.each(["codex", "claudeAgent"] as const)(
    "runs a child as its target names, and on Auto only when asked, while Auto starts on %s",
    (active) =>
      Effect.gen(function* () {
        const claudeInstanceId = ProviderInstanceId.make("claude_work");
        const commands: Array<{ readonly modelSelection?: unknown }> = [];
        const task = {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          providerInstanceId: claudeInstanceId,
          model: "claude-opus",
          status: "running",
          result: null,
        };
        const parentSelection = {
          instanceId: claudeInstanceId,
          model: "claude-opus",
          autoAccount: true,
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
                  ? parentProjection(commands.length > 0 ? [task] : [], parentSelection)
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
            providerInstances: {
              [claudeInstanceId]: { driver: ProviderDriverKind.make("claudeAgent") },
              [codexInstanceId]: { driver: ProviderDriverKind.make("codex") },
            },
            autoModeProvider: ProviderDriverKind.make(active),
            autoModeModels: {
              [ProviderDriverKind.make("claudeAgent")]: { model: "claude-opus" },
              [ProviderDriverKind.make("codex")]: { model: "gpt-5.4" },
            },
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
          const delegate = (
            clientRequestId: string,
            request: { readonly auto?: boolean; readonly target?: Record<string, unknown> },
          ) =>
            Effect.gen(function* () {
              return yield* service.delegateTask(scope, {
                task: "Review the diff.",
                role: "review",
                ...(request.auto === undefined ? {} : { auto: request.auto }),
                ...(request.target === undefined
                  ? {}
                  : { target: yield* decodeTarget(request.target).pipe(Effect.orDie) }),
                mode: "async",
                clientRequestId: `${active}:${clientRequestId}`,
              });
            });
          yield* delegate("inherit", {});
          yield* delegate("account", {
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus" },
          });
          yield* delegate("options", { target: { options: { effort: "high" } } });
          yield* delegate("auto", { auto: true });
          yield* delegate("pinned", { auto: false });
          assert.deepEqual(
            commands.map((command) => command.modelSelection),
            [
              parentSelection,
              { instanceId: claudeInstanceId, model: "claude-opus" },
              {
                instanceId: claudeInstanceId,
                model: "claude-opus",
                options: [{ id: "effort", value: "high" }],
              },
              active === "codex"
                ? { instanceId: codexInstanceId, model: "gpt-5.4", autoAccount: true }
                : parentSelection,
              { instanceId: claudeInstanceId, model: "claude-opus" },
            ],
          );

          const both = yield* delegate("both", {
            auto: true,
            target: { providerInstanceId: claudeInstanceId },
          }).pipe(Effect.flip);
          assert.equal(both.code, "invalid_request");
          yield* settings.updateSettings({ autoModeProvider: null });
          const off = yield* delegate("off", { auto: true }).pipe(Effect.flip);
          assert.equal(off.code, "auto_mode_unavailable");
          assert.include(off.message, "Auto mode is off");
          assert.equal(commands.length, 5);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(dependencies))));
      }),
  );

  it.effect(
    "starts a role set to Auto where Auto mode starts, and on its saved model while Auto is off",
    () =>
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
        const parentSelection = { instanceId: claudeInstanceId, model: "claude-opus" };
        const dependencies = Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(commands.length > 0 ? [task] : [], parentSelection)
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
            providerInstances: {
              [claudeInstanceId]: { driver: ProviderDriverKind.make("claudeAgent") },
              [codexInstanceId]: { driver: ProviderDriverKind.make("codex") },
            },
            autoModeProvider: ProviderDriverKind.make("codex"),
            autoModeModels: { [ProviderDriverKind.make("codex")]: { model: "gpt-5.4" } },
            // Saved while its account was signed in; the account is gone now.
            delegatedTaskModelSelections: {
              review: {
                instanceId: ProviderInstanceId.make("claude_removed"),
                model: "claude-opus",
                autoAccount: true,
              },
            },
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
          const delegate = (clientRequestId: string, auto?: boolean) =>
            service.delegateTask(scope, {
              task: "Review the diff.",
              role: "review",
              ...(auto === undefined ? {} : { auto }),
              mode: "async",
              clientRequestId,
            });
          yield* delegate("auto-on");
          // Not Auto: the saved model, whose account is gone, so the parent's.
          yield* delegate("pinned", false);
          yield* settings.updateSettings({ autoModeProvider: null });
          yield* delegate("auto-off");
          assert.deepEqual(
            commands.map((command) => command.modelSelection),
            [
              { instanceId: codexInstanceId, model: "gpt-5.4", autoAccount: true },
              parentSelection,
              parentSelection,
            ],
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(dependencies))));
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
          providerInstances: {
            [claudeInstanceId]: { driver: ProviderDriverKind.make("claudeAgent") },
          },
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
        assert.equal(off.code, "auto_mode_unavailable");
        assert.include(off.message, "Auto mode is off");
        assert.equal(created.length, 2);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(dependencies))));
    }),
  );

  it.effect(
    "reports the dispatch cause instead of the generic wrapper when interrupting fails",
    () =>
      Effect.gen(function* () {
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
            interruptThread: (input) =>
              Effect.fail(
                new OrchestratorDispatchError({
                  commandId: input.commandId,
                  commandType: "thread.interrupt",
                  cause: new Error("refused by the orchestrator"),
                }) as never,
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const error = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service
            .interruptThread(scope, {
              threadId: parentThreadId,
              clientRequestId: "interrupt-dispatch-cause",
            })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        assert.equal(error.code, "orchestration_error");
        assert.equal(
          error.message,
          `Unable to interrupt thread ${parentThreadId}: refused by the orchestrator`,
        );
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

  it.effect("an unadvertised model refusal names advertised slugs to retry with", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              { slug: "claude-opus-4-1", isLegacy: true },
              ...Array.from({ length: 9 }, (_, index) => ({ slug: `claude-opus-5-${index + 1}` })),
            ].map((model) => ({ ...model, name: model.slug, isCustom: false, capabilities: null })),
            version: "2.1.302",
            updateRequiredModels: [
              { slug: "claude-fable-5-2", name: "Claude Fable 5.2", minVersion: "2.1.321" },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const refuse = (model: string) =>
          service
            .delegateTask(scope, {
              task: "Summarize the diff.",
              target: { providerInstanceId: codexInstanceId, model },
              mode: "async",
              clientRequestId: `delegate-unadvertised-${model}`,
            })
            .pipe(Effect.flip);

        const prefixed = yield* refuse("anthropic/claude-opus-5-3");
        assert.equal(prefixed.code, "model_unavailable");
        assert.equal(
          prefixed.message,
          "Model anthropic/claude-opus-5-3 is not advertised by provider codex. " +
            "Did you mean claude-opus-5-3?",
        );

        const unmatched = yield* refuse("opus-5.5");
        assert.equal(
          unmatched.message,
          "Model opus-5.5 is not advertised by provider codex. Advertised models: " +
            "claude-opus-5-1, claude-opus-5-2, claude-opus-5-3, claude-opus-5-4, claude-opus-5-5, " +
            "claude-opus-5-6, claude-opus-5-7, claude-opus-5-8 and 2 more; " +
            "orchestrator_capabilities with search finds them.",
        );

        const updateRequired = yield* refuse("claude-fable-5-2");
        assert.equal(updateRequired.code, "model_unavailable");
        assert.include(updateRequired.message, "v2.1.302");
        assert.include(updateRequired.message, "2.1.321");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    { failingType: "thread.create", prefix: "Unable to create thread 1: " },
    { failingType: "message.dispatch", prefix: "Unable to start thread 1: " },
    {
      failingType: "thread.created.record",
      prefix: "Unable to record thread 1 in the parent timeline: ",
    },
  ] as const)(
    "reports the dispatch cause instead of the generic wrapper when create_threads' $failingType dispatch fails",
    ({ failingType, prefix }) =>
      Effect.gen(function* () {
        const childThreadId = ThreadId.make("thread:mcp-providers-create-child");
        const childShell = {
          thread: {
            id: childThreadId,
            title: "Child",
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          },
          runs: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(threadId === parentThreadId ? parentProjection([]) : childShell),
            dispatch: (command) =>
              command.type === failingType
                ? Effect.fail(
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: new Error("refused by the orchestrator"),
                    }) as never,
                  )
                : Effect.succeed({ storedEvents: [] } as never),
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
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const error = yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service
            .createThreads(scope, {
              threads: [{ prompt: "Summarize the diff." }],
              clientRequestId: `create-threads-dispatch-cause-${failingType}`,
            })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        assert.equal(error.code, "orchestration_error");
        assert.equal(error.message, `${prefix}refused by the orchestrator`);
      }),
  );

  it.effect("reports the dispatch cause instead of the generic wrapper when delegating fails", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: new Error("refused by the orchestrator"),
              }) as never,
            ),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const error = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            mode: "async",
            clientRequestId: "delegate-dispatch-cause",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      assert.equal(error.code, "orchestration_error");
      assert.equal(error.message, "Unable to create delegated task: refused by the orchestrator");
    }),
  );

  it.effect.each([
    { name: "ten-minute default", timeoutMs: undefined, budgetMs: 600_000 },
    { name: "one-hour maximum", timeoutMs: 3_600_000, budgetMs: 3_600_000 },
  ])("keeps a secret request pending for its $name", (scenario) =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const statuses = yield* Ref.make<ReadonlyArray<string>>([]);
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ ...parentProjection([]), turnItems: [] }),
          dispatch: (command) => {
            if (command.type !== "secret_request.record") return Effect.die("Unexpected command");
            return Ref.update(statuses, (values) => [...values, command.secretStatus]).pipe(
              Effect.andThen(Deferred.succeed(pending, undefined)),
              Effect.as({} as never),
            );
          },
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .requestSecret(scope, {
            label: "Token",
            reason: "Connect the account.",
            ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }),
          })
          .pipe(
            Effect.tap(() => Deferred.succeed(returned, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(pending);
        yield* TestClock.adjust(Duration.millis(scenario.budgetMs - 1));
        assert.isFalse(yield* Deferred.isDone(returned));
        assert.deepEqual(yield* Ref.get(statuses), ["pending"]);
        yield* TestClock.adjust(Duration.millis(1));
        assert.include(yield* Fiber.join(waiting), { status: "timed_out" });
        assert.deepEqual(yield* Ref.get(statuses), ["pending", "cancelled"]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    { name: "default", timeoutMs: undefined, budgetMs: 30_000 },
    { name: "capped", timeoutMs: 3_600_000, budgetMs: 45_000 },
    { name: "shorter requested", timeoutMs: 500, budgetMs: 500 },
  ])("returns task and thread handles at the $name wait budget", (scenario) =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const threadWaitBudgets = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          getThreadEventSequence: () => Effect.succeed(0),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          waitForThread: (input) =>
            Ref.update(threadWaitBudgets, (budgets) => [...budgets, input.timeoutMs]).pipe(
              Effect.as({ threadId: parentThreadId, run: null, timedOut: true }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never),
            ),
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
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const budget = scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs };
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait", ...budget })
          .pipe(
            Effect.tap(() => Deferred.succeed(returned, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(subscribed);
        yield* TestClock.adjust(Duration.millis(scenario.budgetMs - 1));
        assert.isFalse(yield* Deferred.isDone(returned));
        yield* TestClock.adjust(Duration.millis(1));
        const result = yield* Fiber.join(waiting);
        assert.include(result, { taskId, childThreadId, status: "running", waitTimedOut: true });
        assert.include((yield* Ref.get(dispatched)).at(-1), {
          type: "delegated_task.wake-policy",
          completionWake: "always",
        });

        yield* service.waitForThread(scope, { threadId: parentThreadId, ...budget });
        assert.deepEqual(yield* Ref.get(threadWaitBudgets), [scenario.budgetMs]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );
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
    linkedEnvironments: false,
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
          NodeCrypto.layer,
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
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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

  it.effect("points a pasted thread link at the thread it names", () =>
    Effect.gen(function* () {
      const delegated = liveThreadShell(ThreadId.make("thread:delegated-task:command%3Amcp%3Aabc"));
      const ref = { environmentId: client.environmentId, threadId: delegated.id };
      const sent = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const link of [
          `t3-thread://v2/${ref.environmentId}/${ref.threadId}`,
          formatThreadLink(ref, "Delegated task"),
          hostedThreadLink(ref),
        ]) {
          const read = yield* mcp
            .readThread(client, { threadId: ThreadId.make(link) })
            .pipe(Effect.flip);
          assert.equal(read.code, "thread_not_found");
          assert.include(read.message, `\`${delegated.id}\``);
          assert.include(read.message, "is a thread link");
          assert.notInclude(read.message, "no longer available");
        }
      }).pipe(Effect.provide(service([delegated], sent)));
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} was not found.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.code, "thread_not_found");
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} was not found.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("tells an agent steering a finished thread to start a new turn instead", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const mode of ["steer", "restart"] as const) {
          const error = yield* mcp
            .sendToThread(client, { threadId: launched.id, message: "hello", mode })
            .pipe(Effect.flip);
          assert.equal(error.code, "thread_not_sendable");
          assert.include(error.message, 'mode: "auto"');
          assert.include(error.message, '"queue"');
        }
      }).pipe(
        Effect.provide(
          service([launched], sent, {
            getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            sendToThread: (input) =>
              Effect.fail(
                new ThreadManagementService.ThreadManagementNoSteerableRunError({
                  threadId: input.threadId,
                  mode: input.mode === "restart" ? "restart" : "steer",
                }),
              ),
          }),
        ),
      );
    }),
  );

  it.effect("records the linked environment's thread that sent a message", () =>
    Effect.gen(function* () {
      const target = liveThreadShell(ThreadId.make("thread:target"));
      const sender = {
        environmentId: EnvironmentId.make("environment:a"),
        threadId: ThreadId.make("thread:orc"),
        title: "orc lead",
      };
      const linked = (senderThread?: typeof sender): McpInvocationScope => ({
        ...client,
        client: {
          sessionId: "link-a",
          label: "A",
          access: "full-access",
          linked: true,
          ...(senderThread === undefined ? {} : { senderThread }),
        },
      });
      const sendAs = (scope: McpInvocationScope) =>
        Effect.gen(function* () {
          const inputs: Array<ThreadManagementService.ThreadManagementSendInput> = [];
          const sent = yield* Ref.make(0);
          yield* Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            yield* mcp.sendToThread(scope, { threadId: target.id, message: "hello" });
          }).pipe(
            Effect.provide(
              service([target], sent, {
                getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(target)),
                sendToThread: (input) => {
                  inputs.push(input);
                  return Effect.succeed({
                    run: { id: RunId.make("run:sent"), status: "running" },
                    delivery: "started",
                  } as never);
                },
              }),
            ),
          );
          return inputs[0];
        });

      const fromLink = yield* sendAs(linked(sender));
      assert.deepStrictEqual(fromLink?.linkedSender, sender);
      assert.isUndefined(fromLink?.senderThreadId);
      assert.isUndefined((yield* sendAs(linked()))?.linkedSender);
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
  const shell = (
    id: string,
    projectId: string,
    snoozed: boolean,
    waiting = false,
    pinned = false,
  ) => ({
    ...liveThreadShell(ThreadId.make(id)),
    projectId: ProjectId.make(projectId),
    status: "completed" as const,
    snoozedUntil: snoozed ? DateTime.makeUnsafe("2099-01-01T00:00:00Z") : null,
    pinnedAt: pinned ? DateTime.makeUnsafe("2026-01-01T00:00:00Z") : null,
    blockedOnThreadWait: waiting,
    pendingBackgroundTasks: waiting
      ? [
          {
            taskId: "task-subagent",
            kind: "subagent" as const,
            description: "Review the diff",
            parentTaskId: "task-parent",
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ThreadId.make("thread:b-child"),
          },
          { taskId: "task-tests", kind: "command" as const, awaited: true as const },
        ]
      : [],
  });
  const shells = [
    shell("thread:a-snoozed", "project:a", true),
    shell("thread:a-awake", "project:a", false),
    shell("thread:b-snoozed", "project:b", true, true, true),
    {
      ...shell("thread:a-awaiting-command", "project:a", false),
      activityRunStatus: null,
      pendingBackgroundTasks: [
        { taskId: "sleep-600", kind: "command" as const, awaited: true as const },
      ],
    },
    {
      ...shell("thread:c-settled", "project:c", false),
      settledOverride: "settled" as const,
      settledAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z"),
    },
    {
      ...shell("thread:c-awaiting-command", "project:c", false),
      activityRunStatus: null,
      pendingBackgroundTasks: [
        { taskId: "sleep-600", kind: "command" as const, awaited: true as const },
      ],
    },
  ];
  const shellRequests: Array<ReadonlyArray<ThreadId>> = [];
  const service = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.succeed(
              shells.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
          listActiveShellIndex: () =>
            Effect.succeed(
              shells.map((thread) => ({
                ...thread,
                mayBeLive: isLiveSubagentShell(thread),
                hasRemoteTasks: false,
              })),
            ),
          getShellSnapshot: (options) => {
            const threadIds = options?.threadIds ?? shells.map((thread) => thread.id);
            shellRequests.push(threadIds);
            return Effect.succeed({
              threads: shells.filter((thread) => threadIds.includes(thread.id)),
            } as never);
          },
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            shells.some((thread) => thread.projectId === id)
              ? Effect.succeedSome({
                  id,
                  title: id,
                  workspaceRoot: `/projects/${id}`,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-10-18T00:00:00.000Z",
                  updatedAt: "2026-10-18T00:00:00.000Z",
                  deletedAt: null,
                })
              : Effect.succeedNone,
        }),
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
      const full = yield* mcp.listThreads(client, {
        allProjects: true,
        snoozed: true,
        fields: "full",
      });
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.pinned),
        [false, true],
      );
      assert.deepStrictEqual(
        full.threads.map((thread) => [thread.blockedOnThreadWait, thread.pendingBackgroundTasks]),
        [
          [false, []],
          [
            true,
            [
              {
                taskId: "task-subagent",
                kind: "subagent",
                description: "Review the diff",
                childThreadId: ThreadId.make("thread:b-child"),
              },
              { taskId: "task-tests", kind: "command", awaited: true },
            ],
          ],
        ],
      );
    }).pipe(Effect.provide(service)),
  );

  it.effect("refuses a projectId that names no project", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp
        .listThreads(client, { projectId: ProjectId.make("project:missing") })
        .pipe(Effect.result);
      if (Result.isSuccess(listed)) {
        assert.fail(`listed threads for a missing project: ${JSON.stringify(listed.success)}`);
      }
      assert.equal(listed.failure.code, "invalid_request");
      assert.include(listed.failure.message, "not found");
    }).pipe(Effect.provide(service)),
  );

  it.effect("counts a thread holding awaited background work as live in the status filter", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
        statuses: ["preparing", "queued", "starting", "running", "waiting"],
      });
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.threadId),
        ["thread:a-awaiting-command"],
      );
    }).pipe(Effect.provide(service)),
  );

  it.effect("skips building shells for settled threads when every status filter is live", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      shellRequests.length = 0;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:c"),
        statuses: ["preparing", "queued", "starting", "running", "waiting"],
      });
      assert.deepStrictEqual(
        listed.threads.map((thread) => thread.threadId),
        ["thread:c-awaiting-command"],
      );
      assert.notInclude(shellRequests.flat(), ThreadId.make("thread:c-settled"));
    }).pipe(Effect.provide(service)),
  );

  it.effect("builds shells only for the threads on the page", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      shellRequests.length = 0;
      const listed = yield* mcp.listThreads(client, {
        projectId: ProjectId.make("project:a"),
        limit: 1,
      });
      assert.deepStrictEqual(
        [listed.threads.map((thread) => thread.threadId), listed.total, listed.nextCursor],
        [["thread:a-snoozed"], 3, 1],
      );
      assert.deepStrictEqual(shellRequests, [[ThreadId.make("thread:a-snoozed")]]);
    }).pipe(Effect.provide(service)),
  );

  it.effect("points a caller outside any thread at allProjects when it omits projectId", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* mcp.listThreads(client, {}).pipe(Effect.flip);
      assert.equal(error.code, "target_required");
      assert.include(error.message, "allProjects");
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
    {
      name: "a running turn",
      queued: false,
      stop: { reason: undefined, message: "Stopped by an agent" },
    },
    {
      name: "a running turn with a queued message",
      queued: true,
      stop: { reason: "Make room", message: "Stopped by an agent: Make room" },
    },
  ])("t3_thread_interrupt stop reports the run it interrupted on $name", ({ queued, stop }) =>
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
            NodeCrypto.layer,
            layerAdapters,
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
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
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
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
        // A task the thread delegated, running when the thread is stopped.
        const childRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.threadId !== threadId &&
              event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId: threadId,
          parentRunId: runningRun.id,
          parentNodeId: runningRun.rootNodeId!,
          task: "child work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain();
        yield* Fiber.join(childRunning);
        const childThreadId = (yield* orchestrator.getThreadProjection(threadId)).subagents[0]!
          .childThreadId!;

        const stopped = yield* service.interruptThread(client, {
          threadId,
          stop: true,
          clientRequestId: "stop",
          ...(stop.reason === undefined ? {} : { reason: stop.reason }),
        });
        assert.deepEqual(stopped, {
          threadId,
          runId: runningRun.id,
          status: "interrupt_requested",
        });
        // An agent's Stop must not read as the user's, on its thread or a task it delegated.
        const interruptMessages = (id: ThreadId) =>
          orchestrator
            .getThreadProjection(id)
            .pipe(
              Effect.map(({ turnItems }) =>
                turnItems.flatMap((item) =>
                  item.type === "run_interrupt_request" ? [item.message] : [],
                ),
              ),
            );
        assert.deepEqual(yield* interruptMessages(threadId), [stop.message]);
        assert.deepEqual(yield* interruptMessages(childThreadId), [stop.message]);
      }).pipe(Effect.provide(layerTest));
    }),
  );
});
