import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import * as EventStore from "./EventStore.ts";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-stop" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const encodeEffectRequest = Schema.encodeSync(Schema.fromJsonString(OrchestrationEffectRequestV2));

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const threadState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      runs: projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      watched: (projection.thread.pullRequests ?? [])
        .filter((link) => link.watch !== undefined)
        .map((link) => link.number),
    };
  });

it.effect.each([
  ["idle", "thread.stop"],
  ["idle", "run.interrupt"],
  ["idle", "subagent.stop"],
  ["running", "subagent.stop"],
  ["bound", "subagent.stop"],
  ["correlated", "subagent.stop"],
  ["archived", "thread.stop"],
  ["missing", "thread.stop"],
  ["running", "thread.stop"],
  ["queued", "thread.stop"],
  ["waiting", "thread.stop"],
  ["correlated", "thread.stop"],
  ["provider-active", "thread.stop"],
  ["roster", "thread.stop"],
  ["background", "thread.stop"],
  ["question", "thread.stop"],
  ["restart", "thread.stop"],
] as const)(
  "Stop clears an orphaned follow-up when its child is finished; its own Stop does unless a run is bound (%s via %s)",
  ([childState, type]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:orphan-parent:${childState}`);
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "original task");
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const original = parent.subagents[0]!;
      const originalItem = parent.turnItems.find((item) => item.type === "subagent")!;
      const originalNode = parent.nodes.find((node) => node.id === original.id)!;
      const taskId = NodeId.make(`node:orphan-followup:${childState}`);
      const itemId = TurnItemId.make(`item:orphan-followup:${childState}`);
      const followupChildThreadId =
        childState === "missing" ? ThreadId.make("thread:missing-child") : childThreadId;
      const now = yield* DateTime.now;
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:orphan:${childState}:${sequence++}`),
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          status: "completed",
          result: "Original result",
          completedAt: now,
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        },
      });
      yield* apply({
        type: "context-transfer.created",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...child.contextTransfers[0]!,
          id: ContextTransferId.make(`transfer:original-result:${childState}`),
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { threadId: childThreadId, runId: child.runs[0]!.id },
          targetRunId: parent.runs[0]!.id,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalItem, status: "completed", completedAt: now },
      });
      yield* apply({
        type: "subagent.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...original,
          id: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
          result: null,
          completedAt: null,
        },
      });
      yield* apply({
        type: "node.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...originalNode, id: taskId, status: "running" },
      });
      assert.equal(originalItem.type, "subagent");
      if (originalItem.type !== "subagent") return;
      yield* apply({
        type: "turn-item.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: {
          ...originalItem,
          id: itemId,
          nodeId: taskId,
          subagentId: taskId,
          childThreadId: followupChildThreadId,
          status: "running",
        },
      });
      const runAtStart = child.runs[0]!;
      const childRunStatus =
        childState === "running" || childState === "queued" || childState === "waiting"
          ? childState
          : childState === "bound"
            ? "running"
            : "completed";
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...runAtStart, status: "running", delegatedTaskId: taskId },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        taskId,
      );
      // A terminal write based on the attempt's start snapshot loses a later steer binding.
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...runAtStart,
          status: childRunStatus,
          completedAt: childRunStatus === "completed" ? now : null,
          ...(childState === "correlated" || childState === "bound"
            ? { delegatedTaskId: taskId }
            : {}),
        },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]?.delegatedTaskId,
        childState === "correlated" || childState === "bound" ? taskId : undefined,
      );
      if (childState === "provider-active" || childState === "roster") {
        yield* apply({
          type: "provider-thread.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...child.providerThreads[0]!,
            status: childState === "provider-active" ? "active" : "idle",
            pendingBackgroundTasks:
              childState === "roster" ? [{ taskId: "background-task", kind: "command" }] : [],
          },
        });
      }
      if (childState === "background") {
        yield* apply({
          type: "turn-item.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...originalItem,
            id: TurnItemId.make("item:child-background"),
            threadId: childThreadId,
            runId: runAtStart.id,
            nodeId: runAtStart.rootNodeId,
            type: "command_execution",
            status: "running",
            input: "test background work",
          },
        });
      }
      if (childState === "question") {
        yield* apply({
          type: "runtime-request.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:child-question"),
            nodeId: runAtStart.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (childState === "restart") {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          {
            id: `effect:restart-continuation:${runAtStart.id}`,
            commandId: CommandId.make("command:child-restart"),
            threadId: childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: runAtStart.id },
          },
        ]);
      }
      yield* apply({
        type: "run.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
      });
      if (type === "run.interrupt") {
        const run = parent.runs[0]!;
        yield* apply({
          type: "provider-turn.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("provider-turn:orphan-parent"),
            providerThreadId: run.providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId!,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        });
        yield* apply({
          type: "run-attempt.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: { ...parent.attempts[0]!, status: "completed", completedAt: now },
        });
        yield* apply({
          type: "node.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...parent.nodes.find((node) => node.id === run.rootNodeId)!,
            status: "completed",
            completedAt: now,
          },
        });
      }
      if (childState === "archived") {
        yield* apply({
          type: "thread.archived",
          threadId: childThreadId,
          occurredAt: now,
          payload: { ...child.thread, archivedAt: now },
        });
      }
      const childBeforeStop = yield* orchestrator.getThreadProjection(childThreadId);
      assert.lengthOf(
        ((yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []).filter(
          (task) => task.kind === "subagent",
        ),
        1,
      );
      const stop = {
        commandId: CommandId.make(`stop-orphan:${childState}`),
        threadId: parentThreadId,
      };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: parent.runs.at(-1)!.id, holdQueue: true }
          : type === "subagent.stop"
            ? { ...stop, type, runId: original.runId!, subagentId: taskId }
            : { ...stop, type },
      );
      const after = yield* orchestrator.getThreadProjection(parentThreadId);
      // The Lineage stop of one subagent leaves the parent's watches alone.
      assert.lengthOf(
        (after.thread.pullRequests ?? []).filter((link) => link.watch !== undefined),
        type === "subagent.stop" ? 1 : 0,
      );
      // A task with a bound run, live or ended, keeps its settlement path.
      const expected =
        childState === "bound" || childState === "correlated"
          ? "running"
          : type === "subagent.stop" || childState === "idle" || childState === "archived"
            ? "cancelled"
            : "running";
      assert.equal(after.subagents.find((task) => task.id === taskId)?.status, expected);
      assert.equal(after.nodes.find((node) => node.id === taskId)?.status, expected);
      assert.equal(after.turnItems.find((item) => item.id === itemId)?.status, expected);
      assert.equal(
        after.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
        type === "subagent.stop" && expected === "running" ? undefined : "disposed",
      );
      assert.equal(
        after.subagents.find((task) => task.id === original.id)?.result,
        "Original result",
      );
      assert.deepEqual(yield* orchestrator.getThreadProjection(childThreadId), childBeforeStop);
      if (expected === "cancelled") {
        assert.lengthOf(
          (
            (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks ?? []
          ).filter((task) => task.kind === "subagent"),
          0,
        );
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-orphan-again:${childState}`),
          threadId: parentThreadId,
        });
        const repeated = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(repeated.subagents.find((task) => task.id === taskId)?.status, "cancelled");
        assert.deepEqual(repeated.messages, after.messages);
        assert.deepEqual(repeated.contextTransfers, after.contextTransfers);
        if (type === "subagent.stop") {
          // A client that missed the cancel, such as one resumed from an older cache, still
          // shows the task as running. Its Stop gets the ended task back.
          const eventStore = yield* EventStore.EventStoreV2;
          const afterSequence = yield* eventStore.latestSequence({ threadId: parentThreadId });
          yield* orchestrator.dispatch({
            ...stop,
            commandId: CommandId.make(`stop-orphan-stale-client:${childState}`),
            type,
            runId: original.runId!,
            subagentId: taskId,
          });
          const resent = yield* eventStore
            .read({ threadId: parentThreadId, afterSequence })
            .pipe(Stream.runCollect);
          assert.deepEqual(
            resent.flatMap(({ event }) =>
              event.type === "subagent.updated" ? [event.payload.status] : [],
            ),
            ["cancelled"],
          );
        }
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt with holdQueue", "run.interrupt"] as const)(
  "%s still stops the thread when a delegated child cannot be read",
  (stop) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:unreadable-child-parent");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "unreadable child");
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET payload_json = '{"obsolete":true}'
        WHERE thread_id = ${childThreadId}
      `;
      const commandId = CommandId.make("stop:unreadable-child");
      yield* orchestrator.dispatch(
        stop === "thread.stop"
          ? { type: stop, commandId, threadId: parentThreadId }
          : {
              type: "run.interrupt",
              commandId,
              threadId: parentThreadId,
              runId: (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!.id,
              ...(stop === "run.interrupt" ? {} : { holdQueue: true }),
            },
      );
      const state = yield* threadState(parentThreadId);
      assert.deepEqual(state.runs, ["interrupted"]);
      if (stop !== "run.interrupt") assert.deepEqual(state.watched, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["run.interrupt with holdQueue", "thread.stop"] as const)(
  "%s Stop ends watches, holds queues, and stops the delegated tasks under the thread",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-parent");
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "child task");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(childThreadId, 2))));
      const grandchildThreadId = yield* delegate(childThreadId, "grandchild task");
      yield* send(childThreadId, "child follow-up", "queue_after_active");

      const now = yield* DateTime.now;
      const firstRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-parent:first-run-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: firstRun.id,
        occurredAt: now,
        payload: { ...firstRun, status: "completed", completedAt: now },
      });
      yield* send(parentThreadId, "second", "start_immediately");
      const secondRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;

      const stopCommandId = CommandId.make("stop-parent");
      yield* orchestrator.dispatch(
        type === "thread.stop"
          ? { type, commandId: stopCommandId, threadId: parentThreadId }
          : {
              type: "run.interrupt",
              commandId: stopCommandId,
              threadId: parentThreadId,
              runId: secondRun.id,
              holdQueue: true,
            },
      );

      assert.deepEqual(yield* threadState(parentThreadId), {
        runs: ["completed", "interrupted"],
        watched: [],
      });
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
      const effects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId}
    `;
      assert.include(
        effects.map((row) => row.effect_type),
        "delegated-tasks.stop",
      );

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual(yield* threadState(childThreadId), {
        runs: ["interrupted", "queued:held"],
        watched: [],
      });
      assert.deepEqual((yield* threadState(grandchildThreadId)).runs, ["interrupted"]);

      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId: stopCommandId });
      assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted", "queued:held"]);
      // The walk stops each level itself, so the child stops it sends queue no walk of their own.
      const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(
        walks.map((row) => row.command_id),
        [stopCommandId],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a scoped delegated Stop rechecks ownership after a child admits a follow-up", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentId = ThreadId.make("thread:parent-reusing-child");
    yield* createWatchingThread(parentId, 6);
    yield* send(parentId, "original owner", "start_immediately");
    const childId = yield* delegate(parentId, "original task");
    const previousGrandchild = yield* delegate(childId, "previous delegated work");
    const parent = yield* orchestrator.getThreadProjection(parentId);
    const child = yield* orchestrator.getThreadProjection(childId);
    const original = parent.subagents[0]!;
    const captured = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const read = orchestrator.getThreadRecords;
    const snapshot = vi
      .spyOn(orchestrator, "getThreadRecords")
      .mockImplementationOnce((id, fields, filter) =>
        read(id, fields, filter).pipe(
          Effect.tap(() =>
            Deferred.succeed(captured, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      );
    yield* Effect.addFinalizer(() => Effect.sync(() => snapshot.mockRestore()));
    const stop = yield* threads
      .stopDelegatedTasks({
        commandId: CommandId.make("stale-scoped-stop"),
        threadId: parentId,
        parentRunId: original.runId!,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(captured);
    const now = yield* DateTime.now;
    for (const run of [child.runs[0]!, parent.runs[0]!]) {
      yield* projections.apply({
        type: "run.updated",
        threadId: run.threadId,
        id: EventId.make(`completed:${run.id}`),
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
    }
    yield* projections.apply({
      type: "subagent.updated",
      threadId: parentId,
      id: EventId.make("task-result"),
      occurredAt: now,
      payload: { ...original, status: "completed", result: "Done", completedAt: now },
    });
    yield* send(parentId, "new owner", "start_immediately");
    yield* send(childId, "follow-up", "start_immediately");
    const grandchild = yield* delegate(childId, "follow-up work");
    const current = yield* orchestrator.getThreadProjection(parentId);
    assert.equal(current.subagents.at(-1)?.runId, current.runs.at(-1)?.id);
    assert.notEqual(current.subagents.at(-1)?.id, original.id);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(stop);
    assert.deepEqual((yield* threadState(childId)).runs, ["completed", "starting"]);
    assert.deepEqual((yield* threadState(grandchild)).runs, ["starting"]);
    assert.equal(
      (yield* orchestrator.getThreadProjection(parentId)).subagents.at(-1)?.result,
      null,
    );

    // A real Stop of the follow-up owns its grandchild, but not the previous child run's task.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
    yield* threads.stopDelegatedTasks({
      commandId: CommandId.make("stop-follow-up-owner"),
      threadId: parentId,
      parentRunId: current.runs.at(-1)!.id,
    });
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    assert.deepEqual((yield* threadState(grandchild)).runs, ["interrupted"]);
    assert.deepEqual((yield* threadState(previousGrandchild)).runs, ["starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("interrupting the restart source stops children owned by every run in its chain", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:restart-chain-children");
    yield* createWatchingThread(threadId, 3);
    const now = yield* DateTime.now;
    const finishWithChild = (name: string, restartContinuationOfRunId?: RunId) =>
      Effect.gen(function* () {
        yield* send(threadId, name, "start_immediately");
        const child = yield* delegate(threadId, name);
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        yield* projections.apply({
          id: EventId.make(name),
          threadId,
          occurredAt: now,
          type: "run.updated",
          payload: {
            ...run,
            restartContinuationOfRunId,
            startedAt: now,
            completedAt: now,
            status: "completed",
          },
        });
        return { child, run };
      });
    const other = yield* finishWithChild("unrelated");
    const source = yield* finishWithChild("source");
    const middle = yield* finishWithChild("first restart", source.run.id);
    yield* send(threadId, "second restart", "start_immediately");
    const active = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* projections.apply({
      id: EventId.make("active"),
      threadId,
      occurredAt: now,
      type: "run.updated",
      payload: {
        ...active,
        status: "running",
        startedAt: now,
        restartContinuationOfRunId: middle.run.id,
      },
    });
    yield* projections.apply({
      id: EventId.make("active-turn"),
      threadId,
      occurredAt: now,
      type: "provider-turn.updated",
      payload: {
        id: ProviderTurnId.make("turn:second-restart"),
        providerThreadId: active.providerThreadId!,
        nodeId: active.rootNodeId!,
        runAttemptId: active.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    const commandId = CommandId.make("interrupt-chain");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      threadId,
      commandId,
      runId: source.run.id,
    });
    yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
    yield* worker.drain();
    const stopped = yield* orchestrator.getThreadProjection(threadId);
    for (const { child } of [source, middle]) {
      assert.deepEqual((yield* threadState(child)).runs, ["interrupted"]);
      assert.equal(
        stopped.subagents.find((task) => task.childThreadId === child)?.completionDelivery?.state,
        "disposed",
      );
    }
    assert.deepEqual((yield* threadState(other.child)).runs, ["starting"]);
    assert.isUndefined(
      stopped.subagents.find((task) => task.childThreadId === other.child)?.completionDelivery,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { stop: "run.interrupt", retrying: "started" },
  { stop: "thread.stop", retrying: "started" },
  { stop: "run.interrupt", retrying: "unstarted" },
  { stop: "thread.stop", retrying: "unstarted" },
] as const)(
  "$stop ends a delegated task whose $retrying restart waits on a delayed retry as interrupted",
  ({ stop, retrying }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make("thread:stop-retrying-child");
      yield* createWatchingThread(parentThreadId, 21);
      yield* send(parentThreadId, "delegate", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "retrying task");
      yield* send(childThreadId, "continue", "queue_after_active");
      const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      const [cut, continuation] = (yield* orchestrator.getThreadProjection(childThreadId)).runs;
      assert.isDefined(cut);
      assert.isDefined(continuation);
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("parent-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        occurredAt: now,
        payload: { ...parentRun, status: "completed", startedAt: now, completedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("child-cut"),
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...cut, status: "cancelled", startedAt: now, completedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("continuation-failed"),
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: {
          ...continuation,
          restartContinuationOfRunId: cut.id,
          status: "failed",
          startedAt: retrying === "started" ? now : null,
          completedAt: now,
        },
      });
      // Setup effects would start the runs on a provider; only Stop's effects run.
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      yield* outbox.enqueue([
        EffectOutbox.restartContinuationEffect({
          commandId: CommandId.make("retry-child-continuation"),
          threadId: childThreadId,
          sourceRunId: continuation.id,
          availableAt: DateTime.add(now, { minutes: 1 }),
        }),
      ]);
      const finalized = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: yield* orchestrator.getThreadEventSequence(parentThreadId),
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.result !== null,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const commandId = CommandId.make("stop-retrying-child");
      yield* orchestrator.dispatch(
        stop === "run.interrupt"
          ? { type: stop, commandId, threadId: parentThreadId, runId: parentRun.id }
          : { type: stop, commandId, threadId: parentThreadId },
      );
      yield* worker.drain();
      yield* Fiber.join(finalized);
      const [task] = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents;
      assert.equal(task?.status, "interrupted");
      assert.isNotNull(task?.result);
      assert.isFalse(yield* orchestrator.restartContinuationPending(continuation));
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["run.interrupt", "run.interrupt only if active", "thread.stop"] as const)(
  "%s cancels a chain's delayed restart while another run is active",
  (stop) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-restart-beside-active-run");
      yield* createWatchingThread(threadId, 22);
      yield* send(threadId, "cut", "start_immediately");
      yield* send(threadId, "continue", "queue_after_active");
      const [cut, continuation] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(cut);
      assert.isDefined(continuation);
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("beside-active:cut"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...cut, status: "cancelled", startedAt: now, completedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("beside-active:continuation-failed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...continuation,
          restartContinuationOfRunId: cut.id,
          status: "failed",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* send(threadId, "unrelated", "start_immediately");
      const active = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      // Setup effects would start the runs on a provider; only Stop's effects run.
      yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
      yield* outbox.enqueue([
        EffectOutbox.restartContinuationEffect({
          commandId: CommandId.make("retry-beside-active-run"),
          threadId,
          sourceRunId: continuation.id,
          availableAt: DateTime.add(now, { minutes: 1 }),
        }),
      ]);
      assert.include(["preparing", "starting", "running"], active.status);
      assert.isTrue(yield* orchestrator.restartContinuationPending(continuation));

      const commandId = CommandId.make("stop-restart-beside-active-run");
      yield* orchestrator.dispatch(
        stop === "thread.stop"
          ? { type: stop, commandId, threadId }
          : {
              type: "run.interrupt",
              commandId,
              threadId,
              runId: cut.id,
              ...(stop === "run.interrupt" ? {} : { onlyIfActive: true }),
            },
      );
      assert.isFalse(yield* orchestrator.restartContinuationPending(continuation));
      if (stop === "thread.stop") return;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === active.id)?.status, active.status);
      assert.notInclude(
        (yield* outbox.listByCommandId(commandId)).map(({ request }) => request.type),
        "provider-turn.interrupt",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt with holdQueue"] as const)(
  "a repeated %s that changes nothing still stops the delegated tasks",
  (stop) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const parentThreadId = ThreadId.make(`thread:stop-again:${stop}`);
      yield* createWatchingThread(parentThreadId, 1);
      yield* send(parentThreadId, "first", "start_immediately");
      yield* delegate(parentThreadId, "stop-again child");
      const now = yield* DateTime.now;
      const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-again:run-completed"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const dispatchStop = (commandId: string) =>
        orchestrator.dispatch(
          stop === "thread.stop"
            ? {
                type: "thread.stop",
                commandId: CommandId.make(commandId),
                threadId: parentThreadId,
              }
            : {
                type: "run.interrupt",
                commandId: CommandId.make(commandId),
                threadId: parentThreadId,
                runId: run.id,
                holdQueue: true,
              },
        );
      yield* dispatchStop("stop-again:first");

      // The first Stop already disposed the delivery and ended the watch, so this one writes no
      // events, like Stop on a thread an older server stopped without stopping its children.
      const again = yield* dispatchStop("stop-again:second");
      assert.lengthOf(again.storedEvents, 0);
      const walks = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'delegated-tasks.stop'
    `;
      assert.deepEqual(
        walks.map((row) => row.command_id),
        ["stop-again:first", "stop-again:second"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s cancels buffered wakes and preserves durable queued messages",
  (type) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:stop-buffered:${type}`);
      yield* createWatchingThread(threadId, 5);
      yield* send(threadId, "active", "start_immediately");
      yield* send(threadId, "user follow-up", "queue_after_active");
      for (const creationSource of ["provider", "server"] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`notification:${type}:${creationSource}`),
          threadId,
          messageId: MessageId.make(`notification:${type}:${creationSource}`),
          text: "Background activity updated",
          attachments: [],
          createdBy: "agent",
          creationSource,
          notification: {
            source: { kind: "background_task" },
            outcome: "updated",
            summary: "Background activity updated",
          },
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const buffered = before.runs.find((run) =>
        before.messages.some(
          (message) => message.id === run.userMessageId && message.creationSource === "provider",
        ),
      )!;
      const stop = { commandId: CommandId.make(`stop:${type}`), threadId };
      yield* orchestrator.dispatch(
        type === "run.interrupt"
          ? { ...stop, type, runId: before.runs[0]!.id, holdQueue: true }
          : { ...stop, type },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(stopped.runs.find((run) => run.id === buffered.id)?.status, "cancelled");
      assert.equal(
        stopped.attempts.find((attempt) => attempt.runId === buffered.id)?.status,
        "cancelled",
      );
      assert.equal(
        stopped.nodes.find((node) => node.id === buffered.rootNodeId)?.status,
        "cancelled",
      );
      assert.deepEqual(
        stopped.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
        [true, true],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a message the user sends after Stop releases the held queue; an agent's does not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-release");
    const agentSend = (text: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`agent-send:${text}`),
        threadId,
        messageId: MessageId.make(`message:${threadId}:${text}`),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "queued before the stop", "queue_after_active");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-release"),
      threadId,
    });
    assert.deepEqual((yield* threadState(threadId)).runs, ["interrupted", "queued:held"]);

    // An agent's message starts on the idle thread, but the hold is the user's.
    yield* agentSend("agent nudge");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "starting",
    ]);
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:stop-release:nudge-completed"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: now,
      payload: { ...nudge, status: "completed", completedAt: now },
    });

    // A scheduled task the user created is not the user coming back.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("scheduled-send"),
      threadId,
      messageId: MessageId.make(`message:${threadId}:scheduled`),
      text: "Nightly check",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
    });
    const scheduled = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    yield* projections.apply({
      id: EventId.make("event:stop-release:scheduled-completed"),
      type: "run.updated",
      threadId,
      runId: scheduled.id,
      occurredAt: now,
      payload: { ...scheduled, status: "completed", completedAt: now },
    });

    // The user is back: the held message follows their run, and a wake that
    // queues behind it is not held by the old Stop.
    yield* send(threadId, "back", "start_immediately");
    yield* agentSend("task finished");
    assert.deepEqual((yield* threadState(threadId)).runs, [
      "interrupted",
      "queued",
      "completed",
      "completed",
      "starting",
      "queued",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:stop-idle");
      yield* createWatchingThread(threadId, 3);

      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle"),
        threadId,
      });
      assert.deepEqual(yield* threadState(threadId), { runs: [], watched: [] });

      const again = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-idle-again"),
        threadId,
      });
      assert.lengthOf(again.storedEvents, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "a completed watch records whether it ended through Stop (%s)",
  (stopped) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(`thread:watch-completion:${stopped}`);
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "watch", "start_immediately");
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const completedRun = {
        ...run,
        providerThreadId: run.providerThreadId ?? ProviderThreadId.make("provider-thread:watch"),
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:watch-completed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: completedRun,
      });
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);

      yield* orchestrator.dispatch(
        stopped
          ? { type: "thread.stop", commandId: CommandId.make("stop-watch"), threadId }
          : {
              type: "thread.pull-request.watch",
              commandId: CommandId.make("finish-watch"),
              threadId,
              ...pullRequest(7),
              watching: false,
            },
      );
      const shell = yield* projections.getThreadShell(threadId);
      const snapshot = (yield* projections.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const memoryShell = ProjectionStore.threadShellFromProjection(
        yield* orchestrator.getThreadProjection(threadId),
      );
      for (const result of [shell, snapshot, memoryShell]) {
        assert.equal(result?.status, "completed");
        assert.isEmpty(result?.pendingBackgroundTasks ?? []);
        assert.equal(result?.latestRunStopRequested, stopped);
      }

      yield* send(threadId, "next", "start_immediately");
      assert.isFalse((yield* projections.getThreadShell(threadId))?.latestRunStopRequested);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a run Stop reached cannot delegate or start a watch, even after it ends", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-barrier");
    yield* createWatchingThread(threadId, 4);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = { ...(yield* orchestrator.getThreadProjection(threadId)).runs[0]!, startedAt: now };
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    yield* send(threadId, "queued", "queue_after_active");
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-queued"),
      threadId,
      runId: queued.id,
    });
    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupt-request"),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:stop-barrier:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: run.providerThreadId!,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stop",
      },
    });

    assert.isTrue(Exit.isFailure(yield* Effect.exit(delegate(threadId, "late task"))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));

    yield* projections.apply({
      id: EventId.make("event:stop-barrier:interrupted"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 5))));
    assert.deepEqual(yield* threadState(threadId), {
      runs: ["interrupted", "cancelled"],
      watched: [4],
    });

    for (const watching of [false, true]) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`manual-watch:${watching}`),
        threadId,
        ...pullRequest(4),
        watching,
      });
    }
    assert.deepEqual((yield* threadState(threadId)).watched, [4]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "thread.snooze", "thread.settle"] as const)(
  "%s after the restart's check keeps its continuation from starting",
  (hold) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make(`thread:stop-restart:${hold}`);
      yield* createWatchingThread(threadId, 8);
      yield* send(threadId, "work", "start_immediately");
      const now = yield* DateTime.now;
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:stop-restart:cancelled"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`effect:restart-continuation:${run.id}`}, 'command:restart', ${threadId},
        'provider-runtime.continue',
        ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: run.id })},
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

      const commandId = CommandId.make(`${hold}-restart`);
      yield* orchestrator.dispatch(
        hold === "thread.snooze"
          ? {
              type: hold,
              commandId,
              threadId,
              snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
            }
          : { type: hold, commandId, threadId },
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`restart-continuation:${hold}`),
        threadId,
        messageId: MessageId.make(`message:restart-continuation:${hold}`),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: run.id,
      });
      assert.deepEqual((yield* threadState(threadId)).runs, ["cancelled"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "user send",
  "queue.resume",
  "persisted marker and user send",
  "persisted marker and queue.resume",
] as const)("thread Stop keeps a queued restart cancelled after %s", (release) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-queued-restart");
    yield* createWatchingThread(threadId, 7);
    yield* send(threadId, "source", "start_immediately");
    yield* send(threadId, "restart", "queue_after_active");
    yield* send(threadId, "ordinary message", "queue_after_active");
    const [source, restart, ordinary] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    assert.isDefined(source);
    assert.isDefined(restart);
    assert.isDefined(ordinary);
    const now = yield* DateTime.now;
    const queued = { ...restart, restartContinuationOfRunId: source.id };
    const persisted = release.startsWith("persisted");
    const userSend = release.endsWith("user send");
    if (!persisted) {
      yield* projections.apply({
        type: "run.updated",
        threadId,
        id: EventId.make("restart"),
        occurredAt: now,
        payload: queued,
      });
    }
    yield* projections.apply({
      type: "run.updated",
      threadId,
      id: EventId.make("source"),
      occurredAt: now,
      payload: { ...source, status: "completed", startedAt: now, completedAt: now },
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      threadId,
      commandId: CommandId.make("stop"),
    });
    if (persisted) {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue([
        EffectOutbox.restartContinuationEffect({
          threadId,
          commandId: CommandId.make("old-retry"),
          sourceRunId: restart.id,
          availableAt: DateTime.add(now, { minutes: 3 }),
        }),
      ]);
      assert.isTrue(yield* orchestrator.restartContinuationPending(restart));
      // A thread stopped by an older server still has this queued entry and a source marker.
      yield* projections.apply({
        type: "run.updated",
        threadId,
        id: EventId.make("old-queue"),
        occurredAt: now,
        payload: { ...queued, queueHeld: true },
      });
    }
    if (userSend) yield* send(threadId, "new work", "start_immediately");
    else
      yield* orchestrator.dispatch({
        type: "queue.resume",
        threadId,
        commandId: CommandId.make("resume"),
      });
    if (persisted) assert.isFalse(yield* orchestrator.restartContinuationPending(restart));
    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(after.runs.find((run) => run.id === restart.id)?.status, "cancelled");
    assert.equal(
      after.runs.find((run) => run.id === ordinary.id)?.status,
      userSend ? "queued" : "starting",
    );
    if (userSend) assert.equal(after.runs.at(-1)?.status, "starting");
    assert.sameMembers(
      after.turnItems
        .filter((item) => item.type === "run_interrupt_request")
        .map((item) => item.runId),
      [source.id, restart.id],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "MCP interrupt reports already_terminal while a completed run awaits live background work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const threadId = ThreadId.make("thread:terminal-live-background");
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "source", "start_immediately");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const source = before.runs[0]!;
      const owner = before.providerThreads[0]!;
      const sessionId = ProviderSessionId.make("session:live-background");
      const occurredAt = yield* DateTime.now;
      yield* projections.apply({
        type: "run.updated",
        threadId,
        id: EventId.make("source"),
        occurredAt,
        payload: { ...source, startedAt: occurredAt, completedAt: occurredAt, status: "completed" },
      });
      yield* projections.apply({
        type: "provider-session.attached",
        threadId,
        id: EventId.make("session"),
        occurredAt,
        payload: {
          id: sessionId,
          driver: owner.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: process.cwd(),
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          lastError: null,
        },
      });
      yield* projections.apply({
        type: "provider-thread.updated",
        threadId,
        id: EventId.make("owner"),
        occurredAt,
        payload: {
          ...owner,
          ownerNodeId: null,
          providerSessionId: sessionId,
          nativeThreadRef: { driver: owner.driver, strength: "strong", nativeId: "live" },
          pendingBackgroundTasks: [{ kind: "background_task", taskId: "awaited" }],
        },
      });
      const interrupted = yield* threads.interruptThread({
        projectId: before.thread.projectId,
        threadId,
        runId: source.id,
        commandId: CommandId.make("mcp-interrupt"),
      });
      assert.equal(interrupted.type, "already_terminal");
      assert.isFalse(
        (yield* orchestrator.getThreadProjection(threadId)).turnItems.some(
          (item) => item.type === "run_interrupt_request",
        ),
      );
      const messageId = MessageId.make("recovery-message");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("recover"),
        threadId,
        messageId,
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        automaticContinuationOfRunId: source.id,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.userMessageId,
        messageId,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "unrelated with missing session",
  "unrelated with live session",
  "thread Stop with unrelated live session",
  "cancelled later with missing session",
  "cancelled later with live session",
  "unprepared restart with missing session",
  "unprepared restart with live session",
  "missing session",
  "live session",
  "only if active",
  "MCP queued restart",
  "MCP delayed restart with live session",
] as const)(
  "per-run Stop reaches pending work on provider threads across a restart continuation (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:queued-restart-background");
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "unrelated", "start_immediately");
      const unrelatedChild = yield* delegate(threadId, "unrelated child");
      const unrelated = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const completedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("unrelated-completed"),
        type: "run.updated",
        threadId,
        occurredAt: completedAt,
        payload: { ...unrelated, status: "completed", completedAt },
      });
      yield* send(threadId, "source", "start_immediately");
      const sourceChild = yield* delegate(threadId, "awaited task");
      yield* send(threadId, "continuation", "queue_after_active");
      yield* send(threadId, "later", "queue_after_active");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const [, source, queued, later] = before.runs;
      assert.isDefined(source);
      assert.isDefined(queued);
      assert.isDefined(later);
      const attempt = before.attempts.find((candidate) => candidate.id === source.activeAttemptId)!;
      const owner = before.providerThreads.find(
        (candidate) => candidate.id === source.providerThreadId,
      )!;
      const now = yield* DateTime.now;
      const event = { threadId, occurredAt: now };
      const sessionId = ProviderSessionId.make("session:source");
      const turn = {
        id: ProviderTurnId.make("turn:source"),
        providerThreadId: owner.id,
        nodeId: source.rootNodeId!,
        runAttemptId: attempt.id,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      yield* projections.apply({
        ...event,
        id: EventId.make("source"),
        type: "run.updated",
        payload: { ...source, status: "completed", startedAt: now, completedAt: now },
      });
      yield* projections.apply({
        ...event,
        id: EventId.make("attempt"),
        type: "run-attempt.updated",
        payload: {
          ...attempt,
          attemptOrdinal: 2,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      const mcp = scenario.startsWith("MCP");
      const delayed = scenario.startsWith("MCP delayed");
      const unprepared = scenario.startsWith("unprepared");
      if (delayed) {
        yield* outbox.enqueue([
          EffectOutbox.restartContinuationEffect({
            commandId: CommandId.make("pending-retry"),
            threadId,
            sourceRunId: source.id,
            availableAt: DateTime.add(now, { minutes: 3 }),
          }),
        ]);
      }
      const live = scenario.endsWith("live session");
      yield* projections.apply({
        ...event,
        id: EventId.make("queued"),
        type: "run.updated",
        payload: {
          ...queued,
          ...(delayed ? {} : { restartContinuationOfRunId: source.id }),
          ...(unprepared
            ? {
                status: "failed" as const,
                rootNodeId: null,
                providerThreadId: null,
                activeAttemptId: null,
                completedAt: now,
              }
            : {}),
        },
      });
      yield* projections.apply({
        ...event,
        id: EventId.make("turn"),
        type: "provider-turn.updated",
        payload: turn,
      });
      const roster = [{ taskId: "awaited-task", kind: "background_task" as const }];
      yield* projections.apply({
        ...event,
        id: EventId.make("owner"),
        type: "provider-thread.updated",
        payload: { ...owner, providerSessionId: sessionId, pendingBackgroundTasks: roster },
      });
      const otherThreadId = ProviderThreadId.make("provider-thread:background");
      const otherTurnId = ProviderTurnId.make("turn:background");
      const threadWide = scenario.startsWith("thread Stop");
      const separateOwner = scenario.includes("unrelated");
      const backgroundOwner = separateOwner ? unrelated : source;
      const earlierAttemptId = RunAttemptId.make("attempt:background");
      yield* projections.apply({
        ...event,
        id: EventId.make("earlier-attempt"),
        type: "run-attempt.updated",
        payload: {
          ...attempt,
          id: earlierAttemptId,
          runId: backgroundOwner.id,
          attemptOrdinal: separateOwner ? 2 : 1,
          providerThreadId: otherThreadId,
          providerTurnId: otherTurnId,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        ...event,
        id: EventId.make("other-thread"),
        type: "provider-thread.updated",
        payload: { ...owner, id: otherThreadId, providerSessionId: sessionId },
      });
      yield* projections.apply({
        ...event,
        id: EventId.make("other-turn"),
        type: "provider-turn.updated",
        payload: {
          ...turn,
          id: otherTurnId,
          providerThreadId: otherThreadId,
          runAttemptId: earlierAttemptId,
        },
      });
      const itemId = TurnItemId.make("item:background-command");
      yield* projections.apply({
        ...event,
        id: EventId.make("background-command"),
        type: "turn-item.updated",
        payload: {
          id: itemId,
          threadId,
          runId: backgroundOwner.id,
          nodeId: backgroundOwner.rootNodeId,
          parentItemId: null,
          nativeItemRef: null,
          ordinal: before.turnItems.length + 1,
          title: "Background command",
          startedAt: now,
          updatedAt: now,
          type: "command_execution",
          status: "running",
          completedAt: null,
          providerThreadId: otherThreadId,
          providerTurnId: otherTurnId,
          input: "background command",
        },
      });
      const interruptedTurns: ProviderTurnId[] = [];
      if (live) {
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const unexpected = () => Effect.die("Only interruptTurn is expected during Stop");
        const session = vi.spyOn(sessions, "get").mockReturnValue(
          Effect.succeedSome({
            instanceId,
            driver: adapter.driver,
            providerSessionId: sessionId,
            providerSession: {
              id: sessionId,
              driver: adapter.driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd: process.cwd(),
              model: modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.empty,
            ensureThread: unexpected,
            resumeThread: unexpected,
            startTurn: unexpected,
            steerTurn: unexpected,
            respondToRuntimeRequest: unexpected,
            readThreadSnapshot: unexpected,
            rollbackThread: unexpected,
            forkThread: unexpected,
            interruptTurn: ({ providerTurnId }) =>
              Effect.sync(() => {
                interruptedTurns.push(providerTurnId);
              }),
          } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => session.mockRestore()));
      }
      const cancelledLater = scenario.startsWith("cancelled later");
      if (cancelledLater) {
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-later"),
          threadId,
          runId: later.id,
        });
      }
      const commandId = CommandId.make("stop-queued-restart");
      const onlyIfActive = scenario === "only if active";
      const { storedEvents } = yield* mcp
        ? Effect.gen(function* () {
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const result = yield* threads.interruptThread({
              projectId: before.thread.projectId,
              threadId,
              runId: source.id,
              commandId,
            });
            assert.equal(result.type, "interrupt_requested");
            if (result.type !== "interrupt_requested")
              return assert.fail("pending restart was not interrupted");
            return result.dispatch;
          })
        : orchestrator.dispatch(
            threadWide
              ? { type: "thread.stop", threadId, commandId }
              : {
                  type: "run.interrupt",
                  threadId,
                  commandId,
                  runId: source.id,
                  ...(onlyIfActive ? { onlyIfActive } : {}),
                },
          );
      const interrupts = (yield* outbox.listByCommandId(commandId)).flatMap(({ request }) =>
        request.type === "provider-turn.interrupt" ? [request] : [],
      );
      assert.sameDeepMembers(
        interrupts.map(({ providerSessionId, providerThreadId, providerTurnId }) => ({
          providerSessionId,
          providerThreadId,
          providerTurnId,
        })),
        live
          ? [
              { providerSessionId: sessionId, providerThreadId: owner.id, providerTurnId: turn.id },
              ...(separateOwner && !threadWide
                ? []
                : [
                    {
                      providerSessionId: sessionId,
                      providerThreadId: otherThreadId,
                      providerTurnId: otherTurnId,
                    },
                  ]),
            ]
          : [],
      );
      // These turns were seeded directly. Run only the effects produced by Stop.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.sameMembers(
        interruptedTurns,
        live ? [turn.id, ...(separateOwner && !threadWide ? [] : [otherTurnId])] : [],
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        stopped.providerThreads.find((p) => p.id === owner.id)!.pendingBackgroundTasks,
        [],
      );
      assert.equal(
        stopped.turnItems.find((item) => item.id === itemId)?.status,
        separateOwner && !threadWide ? "running" : "interrupted",
      );
      assert.equal(
        stopped.runs.find((run) => run.id === queued.id)?.status,
        delayed ? "queued" : unprepared ? "failed" : "cancelled",
      );
      if (unprepared)
        assert.deepInclude(
          stopped.turnItems.find(
            (item) => item.type === "run_interrupt_request" && item.runId === queued.id,
          ),
          { nodeId: null, providerThreadId: null },
        );
      assert.sameMembers(
        storedEvents.flatMap(({ event }) =>
          event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request"
            ? [event.runId]
            : [],
        ),
        delayed ? [source.id] : [queued.id, source.id],
      );
      assert.lengthOf(
        storedEvents.filter(
          ({ event }) =>
            event.type === "run.updated" &&
            event.payload.id === later.id &&
            event.payload.queueHeld,
        ),
        threadWide && !cancelledLater ? 1 : 0,
      );
      if (cancelledLater)
        assert.equal(stopped.runs.find((run) => run.id === later.id)?.status, "cancelled");
      assert.equal(
        stopped.subagents.find((task) => task.childThreadId === sourceChild)?.completionDelivery
          ?.state,
        "disposed",
      );
      assert.deepEqual((yield* threadState(sourceChild)).runs, ["interrupted"]);
      assert.deepEqual((yield* threadState(unrelatedChild)).runs, [
        threadWide ? "interrupted" : "starting",
      ]);
      if (threadWide) return;
      const unrelatedTask = before.subagents.find((task) => task.childThreadId === unrelatedChild)!;
      assert.deepEqual(
        stopped.subagents.find((task) => task.id === unrelatedTask.id),
        unrelatedTask,
      );
      const unrelatedItem = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === unrelatedTask.id,
      )!;
      assert.equal(
        stopped.turnItems.find((item) => item.id === unrelatedItem.id)?.status,
        unrelatedItem.status,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "a successful %s blocks a newer restart continuation when completion timestamps tie",
  (stopType) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:stop-resumed-queue");
      yield* createWatchingThread(threadId, 12);
      yield* send(threadId, "first", "start_immediately");
      yield* send(threadId, "queued", "queue_after_active");
      const now = yield* DateTime.now;
      const [first, queued] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      assert.isDefined(first);
      assert.isDefined(queued);
      for (const run of [first!, queued!]) {
        yield* projections.apply({
          id: EventId.make(`event:stop-resumed-queue:hold:${run.id}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === first!.id
              ? { ...run, status: "completed", completedAt: now }
              : { ...run, queueHeld: true },
        });
      }
      yield* send(threadId, "restart source", "start_immediately");
      const source = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* projections.apply({
        id: EventId.make("event:stop-resumed-queue:restart-cancelled"),
        type: "run.updated",
        threadId,
        runId: source.id,
        occurredAt: now,
        payload: { ...source, status: "cancelled", startedAt: now, completedAt: now },
      });
      const at = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:restart-continuation:${source.id}`}, 'command:restart', ${threadId},
          'provider-runtime.continue',
          ${encodeEffectRequest({ type: "provider-runtime.continue", sourceRunId: source.id })},
          'pending', 0, ${at}, ${at}, ${at}
        )
      `;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-older-queue"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === queued!.id,
        )?.status,
        "starting",
      );
      yield* orchestrator.dispatch(
        stopType === "thread.stop"
          ? { type: "thread.stop", commandId: CommandId.make("stop-resumed-queue"), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make("stop-resumed-queue"),
              threadId,
              runId: queued!.id,
              holdQueue: true,
            },
      );
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      const interrupted = stopped.runs.find((run) => run.id === queued!.id)!;
      assert.equal(interrupted.status, "interrupted");
      assert.equal(DateTime.toEpochMillis(interrupted.completedAt!), DateTime.toEpochMillis(now));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart-after-stop"),
        threadId,
        messageId: MessageId.make("message:restart-after-stop"),
        text: "Continue.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: source.id,
      });
      assert.deepEqual(yield* threadState(threadId), {
        runs: ["completed", "cancelled", "interrupted"],
        watched: [],
      });
    }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);

it.effect.each([
  { ending: "cancelled", question: "resolved" },
  { ending: "interrupted", question: "resolved" },
  { ending: "completed", question: "pending" },
  { ending: "failed", question: "pending" },
] as const)(
  "a $ending delegated task leaves its async question $question",
  ({ ending, question }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make(`thread:stop-question-parent:${ending}`);
      yield* createWatchingThread(parentThreadId, 20);
      yield* send(parentThreadId, "first", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, `question task ${ending}`);
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).nodes.find(
          (node) => node.id === childRun.rootNodeId,
        )?.runId,
        childRun.id,
      );
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-question:request"),
        type: "runtime-request.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("request:stop-question"),
          nodeId: childRun.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const request = Effect.map(
        orchestrator.getThreadProjection(childThreadId),
        (projection) => projection.runtimeRequests[0],
      );

      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, "pending");
      if (ending === "interrupted") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-question-child"),
          threadId: childThreadId,
        });
      } else {
        yield* projections.apply({
          id: EventId.make(`event:stop-question:${ending}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: { ...childRun, status: ending, startedAt: now, completedAt: now },
        });
      }
      yield* orchestrator.recoverDelegatedTask(childThreadId, childRun.id);
      assert.equal((yield* request)?.status, question);
      assert.equal((yield* request)?.decision, question === "resolved" ? "cancel" : undefined);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated task that cannot be stopped fails the walk after its siblings stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parentThreadId = ThreadId.make("thread:stop-partial");
    yield* createWatchingThread(parentThreadId, 6);
    yield* send(parentThreadId, "work", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, "stoppable task");
    const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-partial:missing-task"),
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: task.runId!,
      nodeId: NodeId.make("node:stop-partial:missing"),
      providerInstanceId: instanceId,
      occurredAt: yield* DateTime.now,
      payload: {
        ...task,
        id: NodeId.make("node:stop-partial:missing"),
        childThreadId: ThreadId.make("thread:stop-partial:missing"),
        startedAt: DateTime.subtract(task.startedAt!, { hours: 1 }),
      },
    });

    const walked = yield* Effect.exit(
      threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-partial"),
      }),
    );
    assert.isTrue(Exit.isFailure(walked));
    assert.deepEqual((yield* threadState(childThreadId)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("thread.stop marks a turn it cannot interrupt so a late agent watch is refused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:stop-lost-session");
    yield* createWatchingThread(threadId, 11);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:running"),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* projections.apply({
      id: EventId.make("event:stop-lost-session:turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("provider-turn:stop-lost-session"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-lost-session"),
      threadId,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(watch(threadId, 12))));
    assert.deepEqual(yield* threadState(threadId), { runs: ["running"], watched: [] });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing session", "completed", "failed", "cancelled"] as const)(
  "a native child Stop only settles a confirmed %s outcome and preserves its owner and sibling",
  (providerState) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:native-child-stop");
      yield* createWatchingThread(threadId, 20);
      yield* send(threadId, "owner", "start_immediately");
      yield* delegate(threadId, "native-child-fixture");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const now = yield* DateTime.now;
      const subagent = {
        ...before.subagents[0]!,
        origin: "provider_native" as const,
        driver: CLAUDE_PROVIDER,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        nativeTaskRef: {
          driver: CLAUDE_PROVIDER,
          nativeId: "claude-task",
          strength: "strong" as const,
        },
        status: "running" as const,
        startedAt: now,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:agent"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: now,
        payload: subagent,
      });
      const sibling = {
        ...subagent,
        id: NodeId.make("node:native-stop-sibling"),
        childThreadId: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:sibling"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: sibling.id,
        occurredAt: now,
        payload: sibling,
      });
      const item = before.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:item"),
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...item, status: "running", completedAt: null },
      });
      const childRoot = {
        ...before.nodes.find((node) => node.id === run.rootNodeId)!,
        id: NodeId.make("node:native-stop-child-root"),
        threadId: subagent.childThreadId!,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      };
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-root"),
        type: "node.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: childRoot,
      });
      const childTurnId = ProviderTurnId.make("turn:native-stop-child");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:child-turn"),
        type: "provider-turn.updated",
        threadId: childRoot.threadId,
        nodeId: childRoot.id,
        occurredAt: now,
        payload: {
          id: childTurnId,
          providerThreadId: ProviderThreadId.make("provider-thread:native-stop-child"),
          nodeId: childRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const providerThread = before.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )!;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...providerThread,
          driver: CLAUDE_PROVIDER,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          providerSessionId: ProviderSessionId.make("session:native-child-stop"),
        },
      });
      const providerTurnId = ProviderTurnId.make("turn:native-child-stop");
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:owner-completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      yield* send(threadId, "queued", "queue_after_active");
      const stateBefore = yield* threadState(threadId);
      const eventStore = yield* EventStore.EventStoreV2;
      const afterSequence = yield* eventStore.latestSequence({ threadId });
      const confirmedStatus =
        providerState === "completed" || providerState === "failed" || providerState === "cancelled"
          ? providerState
          : null;
      const confirmedOutcome =
        confirmedStatus === null
          ? undefined
          : { status: confirmedStatus, completedAt: now, result: "Actual provider outcome" };
      const commandId = CommandId.make("stop-native-child");
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId,
        threadId,
        runId: run.id,
        subagentId: subagent.id,
      });
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      const effects = yield* sql<{ payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}
    `;
      assert.equal(effects.length, 1);
      assert.deepEqual(JSON.parse(effects[0]!.payload_json), {
        type: "provider-turn.interrupt",
        providerSessionId: "session:native-child-stop",
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, nativeTaskId: "claude-task" },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.status,
        "running",
      );
      const unrelated = yield* Effect.exit(
        orchestrator.dispatch({
          type: "subagent.stop",
          commandId: CommandId.make("stop-unknown-child"),
          threadId,
          runId: run.id,
          subagentId: NodeId.make("unknown-child"),
        }),
      );
      assert.isTrue(Exit.isFailure(unrelated));
      yield* TestClock.adjust("1 second");
      yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE command_id != ${commandId}`;
      if (providerState === "missing session") {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
      } else {
        yield* orchestrator.dispatch({
          type: "thread.background-work.settle",
          commandId: CommandId.make("repair-native-child"),
          threadId,
          providerThreadId: providerThread.id,
          providerTurnId,
          subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome! },
        });
      }
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const cancelled = settled.subagents.find((task) => task.id === subagent.id)!;
      if (confirmedOutcome === undefined) {
        const events = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
        assert.isFalse(
          events.some(
            ({ event }) =>
              (event.type === "subagent.updated" ||
                event.type === "node.updated" ||
                event.type === "turn-item.updated") &&
              ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
          ),
        );
        assert.equal(cancelled.status, "running");
        assert.equal(
          (yield* orchestrator.getThreadProjection(childRoot.threadId)).nodes.find(
            (node) => node.id === childRoot.id,
          )?.status,
          "running",
        );
        assert.deepEqual(yield* threadState(threadId), stateBefore);
        return;
      }

      const repaired = yield* eventStore.read({ threadId, afterSequence }).pipe(Stream.runCollect);
      const terminal = repaired.flatMap(({ event }) =>
        (event.type === "subagent.updated" ||
          event.type === "node.updated" ||
          event.type === "turn-item.updated") &&
        event.payload.status === confirmedStatus
          ? [event]
          : [],
      );
      assert.deepEqual(terminal.map((event) => event.type).sort(), [
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
      ]);
      for (const event of terminal) {
        assert.equal(event.nodeId, subagent.id);
        assert.equal(
          DateTime.toEpochMillis(event.payload.completedAt!),
          DateTime.toEpochMillis(confirmedOutcome!.completedAt),
        );
        if (event.type === "subagent.updated" || event.type === "turn-item.updated") {
          assert.isDefined(event.payload.updatedAt);
        }
      }

      assert.equal(cancelled.status, confirmedStatus);
      assert.isNotNull(cancelled.completedAt);
      assert.equal(
        DateTime.toEpochMillis(cancelled.completedAt!),
        DateTime.toEpochMillis(confirmedOutcome!.completedAt),
      );
      assert.equal(cancelled.result, confirmedOutcome!.result);
      assert.equal(
        settled.turnItems.find((candidate) => candidate.id === item.id)?.status,
        confirmedStatus,
      );
      const child = yield* orchestrator.getThreadProjection(childRoot.threadId);
      assert.equal(child.nodes.find((node) => node.id === childRoot.id)?.status, confirmedStatus);
      assert.equal(
        child.providerTurns.find((turn) => turn.id === childTurnId)?.status,
        confirmedStatus,
      );
      assert.isNotNull(child.nodes.find((node) => node.id === childRoot.id)?.completedAt);
      assert.equal(settled.subagents.find((task) => task.id === sibling.id)?.status, "running");
      assert.deepEqual(yield* threadState(threadId), stateBefore);
      yield* TestClock.adjust("1 second");
      const resumedAt = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:native-child-stop:resume"),
        type: "subagent.updated",
        threadId,
        runId: run.id,
        nodeId: subagent.id,
        occurredAt: resumedAt,
        payload: { ...cancelled, status: "running", startedAt: resumedAt, completedAt: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.background-work.settle",
        commandId: CommandId.make("old-stop-after-resume"),
        threadId,
        providerThreadId: providerThread.id,
        providerTurnId,
        subagent: { id: subagent.id, stoppedAt: now, outcome: confirmedOutcome },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === subagent.id,
        )?.status,
        "running",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an unanswered Stop is flagged until Force stop ends the run with its own reason", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:force-stop");
    yield* createWatchingThread(threadId, 6);
    yield* send(threadId, "work", "start_immediately");
    const now = yield* DateTime.now;
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = started.runs[0]!;
    const providerThreadId = run.providerThreadId!;
    const providerTurnId = ProviderTurnId.make("provider-turn:force-stop");
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:force-stop:${event.type}`),
        threadId,
      } as OrchestrationV2DomainEvent);
    const attempt = started.attempts[0]!;
    const attemptId = attempt.id;
    yield* apply({
      type: "run.updated",
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now, activeAttemptId: attemptId },
    });
    yield* apply({
      type: "run-attempt.updated",
      occurredAt: now,
      payload: { ...attempt, status: "running", startedAt: now },
    });
    yield* apply({
      type: "provider-turn.updated",
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: run.rootNodeId!,
        runAttemptId: attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "turn-item.updated",
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:force-stop:interrupt-request"),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Stopped by user",
      },
    });
    const target = { threadId, providerThreadId, providerTurnId };
    const request = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
      projection.turnItems.find((item) => item.type === "run_interrupt_request"),
    );

    yield* orchestrator.dispatch({
      ...target,
      type: "thread.interrupt.unresponsive",
      commandId: CommandId.make("force-stop:unresponsive"),
    });
    const flagged = yield* request;
    assert.isTrue(
      flagged?.type === "run_interrupt_request" && flagged.unresponsiveAt !== undefined,
    );
    assert.deepEqual((yield* threadState(threadId)).runs, ["running"]);

    yield* orchestrator.dispatch({
      ...target,
      type: "thread.background-work.settle",
      commandId: CommandId.make("force-stop:settle"),
      reason: "Force stopped by user",
    });
    const settled = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      settled.runs.map((candidate) => candidate.status),
      ["interrupted"],
    );
    const result = settled.turnItems.find((item) => item.type === "run_interrupt_result");
    assert.equal(
      result?.type === "run_interrupt_result" ? result.message : undefined,
      "Force stopped by user",
    );

    // A provider confirming late changes nothing once the run has ended.
    const late = yield* orchestrator.dispatch({
      ...target,
      type: "thread.interrupt.unresponsive",
      commandId: CommandId.make("force-stop:late-unresponsive"),
    });
    assert.lengthOf(late.storedEvents, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["Stop", "Force stop", "Stop awaiting continuation"] as const)(
  "%s ends a running run whose provider turn already completed",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:stop-completed-turn");
      yield* createWatchingThread(threadId, 7);
      yield* send(threadId, "go", "start_immediately");
      const now = yield* DateTime.now;
      const started = yield* orchestrator.getThreadProjection(threadId);
      const run = started.runs[0]!;
      const attempt = started.attempts[0]!;
      const providerThreadId = run.providerThreadId!;
      const providerTurnId = ProviderTurnId.make("provider-turn:stop-completed-turn");
      yield* send(threadId, "follow", "queue_after_active");
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
        projections.apply({
          ...event,
          id: EventId.make(`event:stop-completed-turn:${event.type}`),
          threadId,
        } as OrchestrationV2DomainEvent);
      yield* apply({
        type: "run.updated",
        runId: run.id,
        occurredAt: now,
        payload: {
          ...run,
          status: action === "Stop awaiting continuation" ? "completed" : "running",
          startedAt: now,
          completedAt: action === "Stop awaiting continuation" ? now : null,
          activeAttemptId: attempt.id,
        },
      });
      yield* apply({
        type: "run-attempt.updated",
        occurredAt: now,
        payload: { ...attempt, status: "completed", startedAt: now, completedAt: now },
      });
      yield* apply({
        type: "provider-turn.updated",
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: run.rootNodeId!,
          runAttemptId: attempt.id,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      // The provider session was already released.
      yield* apply({
        type: "provider-thread.updated",
        occurredAt: now,
        payload: {
          ...started.providerThreads.find((thread) => thread.id === providerThreadId)!,
          providerSessionId: ProviderSessionId.make("session:gone"),
          ...(action === "Stop awaiting continuation"
            ? {
                pendingBackgroundTasks: [
                  { taskId: "awaited-task", kind: "background_task" as const },
                ],
              }
            : {}),
        },
      });
      if (action === "Stop awaiting continuation") {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* outbox.enqueue([
          EffectOutbox.restartContinuationEffect({
            commandId: CommandId.make("pending-background-continuation"),
            threadId,
            sourceRunId: run.id,
          }),
        ]);
      }
      if (action !== "Force stop") {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-completed-turn"),
          threadId,
        });
      } else {
        const threads = yield* ThreadManagementService.ThreadManagementService;
        yield* threads.forceStopThread({ threadId });
      }
      const stopped = yield* orchestrator.getThreadProjection(threadId);
      if (action === "Stop awaiting continuation") {
        assert.isEmpty(
          stopped.providerThreads.find((thread) => thread.id === providerThreadId)
            ?.pendingBackgroundTasks ?? [],
        );
        assert.isTrue(stopped.runs.at(-1)?.queueHeld);
      }
      assert.notEqual(stopped.runs[0]?.status, "running", "the stopped run is still running");
      assert.deepInclude(stopped.attempts[0], { status: "completed", completedAt: now });
      assert.isTrue(
        stopped.turnItems.some(
          (item) =>
            item.type ===
            (action === "Stop awaiting continuation"
              ? "run_interrupt_request"
              : "run_interrupt_result"),
        ),
        "the stopped run has no interrupt result",
      );
    }).pipe(Effect.provide(layerTest)),
);
