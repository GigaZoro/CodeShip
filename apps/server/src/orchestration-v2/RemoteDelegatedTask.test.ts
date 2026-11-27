import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { seedLiveParent as seedLiveParentThread } from "./testkit/LiveParentThread.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

// A delegated task whose child runs in a linked environment, and a command task, is recorded on
// its parent without a child thread here, and completing it wakes the parent
// the way a local child's result does.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for delegated task records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Every parent wake the orchestrator offers, for the tests to read. */
class Offers extends Context.Service<
  Offers,
  Ref.Ref<ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>>
>()("t3/orchestration-v2/RemoteDelegatedTask.test/Offers") {}
const layerOffers = Layer.effect(
  Offers,
  Ref.make<ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>>([]),
);
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "remote-delegated-task" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.effect(
      ProviderContinuationRequests.ProviderContinuationRequests,
      Offers.pipe(
        Effect.map((offers) => ({
          offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
            Ref.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        })),
      ),
    ),
  ),
  Layer.provideMerge(layerOffers),
);

const parentDemand = `demand:${"d".repeat(64)}`;
const seedLiveParent = (name: string) =>
  seedLiveParentThread({ name, driver, modelSelection, demandId: parentDemand });

const remoteChild = {
  environmentId: EnvironmentId.make("environment:box"),
  threadId: ThreadId.make("thread:on-the-box"),
  label: "Box",
};

it.layer(layerTest)("a delegated task in a linked environment", (it) => {
  it.effect("is recorded on its parent without a child thread here, once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("records");
      const request = {
        type: "delegated_task.remote.request" as const,
        commandId: CommandId.make("command:remote-delegate:records"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection: {
          ...modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        remoteChild,
        completionWake: "always" as const,
      };
      yield* orchestrator.dispatch(request);
      yield* orchestrator.dispatch(request);
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(projection.subagents.length, 1);
      const [task] = projection.subagents;
      assert.equal(task?.childThreadId, null);
      assert.deepEqual(task?.remoteChild, remoteChild);
      // Its result wakes the parent under the demand of the run that delegated it.
      assert.equal(task?.demandId, parentDemand);
      // The parent shows the dispatched effort; no child thread here holds the selection.
      assert.deepEqual(task?.modelSelection, request.modelSelection);
      assert.equal(task?.status, "running");
      const item = projection.turnItems.find((candidate) => candidate.type === "subagent");
      assert.deepEqual(item?.type === "subagent" ? item.remoteChild : undefined, remoteChild);
      // No thread was created here for the child.
      assert.equal(yield* orchestrator.getThreadShell(remoteChild.threadId), null);
      const other = yield* seedLiveParent("records-no-task");
      const index = yield* (yield* ProjectionStore.ProjectionStoreV2).listActiveShellIndex();
      assert.isTrue(index.find((entry) => entry.id === parent.threadId)?.hasRemoteTasks);
      assert.isFalse(index.find((entry) => entry.id === other.threadId)?.hasRemoteTasks);
      // A live turn here blocks archiving on its own, so end the parent's turn first.
      const [parentRun] = (yield* orchestrator.getThreadProjection(parent.threadId)).runs;
      assert.isDefined(parentRun);
      const endedAt = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:end-run:records"),
        events: [
          {
            id: EventId.make("event:end-run:records"),
            type: "run.updated",
            threadId: parent.threadId,
            runId: parent.runId,
            nodeId: parent.rootNodeId,
            providerInstanceId: instanceId,
            occurredAt: endedAt,
            payload: { ...parentRun, status: "completed", completedAt: endedAt },
          },
        ],
      });
      // Nothing here can cancel the task there, so it must not block archiving.
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive:records"),
        threadId: parent.threadId,
      });
      assert.isNotNull((yield* orchestrator.getThreadShell(parent.threadId))?.archivedAt);
    }),
  );

  it.effect("keeps a newer stop recoverable after an older acknowledgement", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-generation");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-generation"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((entry) => entry.parentThreadId === parent.threadId)),
      );
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
        status: "completed" as const,
        result: "Original result.",
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-generation"),
        stoppedThere: "ran-out",
      });
      for (const count of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "delegated_task.remote.stop",
          parentThreadId: parent.threadId,
          taskId: task.id,
          commandId: CommandId.make(`command:stop-generation:${count}`),
        });
      }
      // Reports from before generation tracking cannot clear a later numbered Stop either:
      // they are done, and record nothing.
      for (const stopCount of [undefined, 1]) {
        const stale = yield* orchestrator.dispatch({
          ...complete,
          commandId: CommandId.make(`command:stale-stop:${stopCount}`),
          stoppedThere: "stopped",
          ...(stopCount === undefined ? {} : { stopCount }),
        });
        assert.deepEqual(stale.storedEvents, []);
        assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: task.id }]);
      }
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:current-stop:2"),
        stoppedThere: "stopped",
        stopCount: 2,
      });
      const settled = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(settled.result, "Original result.");
      assert.equal(settled.status, "completed");
      assert.equal(settled.remoteChild?.stoppedThere, true);
      assert.deepEqual(yield* openFor, []);
    }),
  );

  it.effect("owes a stop there for a Stop here that loses the race to its result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-after-result");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-after-result"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-after-result"),
        status: "completed",
        result: "Done there.",
        stoppedThere: "ran-out",
      });
      // The parent's Stop read the task before its result landed.
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:parent-stop:stop-after-result"),
        status: "interrupted",
        result: "Stopped with its parent.",
      });

      const stopped = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(stopped.status, "completed");
      assert.equal(stopped.result, "Done there.");
      assert.equal(stopped.remoteChild?.stoppedThere, false);
      assert.equal(stopped.remoteChild?.stopCount, 1);
      const open = yield* projections.getOpenRemoteDelegatedTasks;
      assert.deepEqual(
        open.filter((entry) => entry.parentThreadId === parent.threadId),
        [{ parentThreadId: parent.threadId, taskId: task.id }],
      );
    }),
  );

  it.effect("wakes its parent with the result when it completes there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("completes");
      const recorded = yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:completes"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
        completionWake: "always",
      });
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated" ? taskEvent.event.payload.id : undefined;
      assert.isDefined(taskId);
      // Until it completes, it is open, and a restarted follower picks it up.
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((task) => task.parentThreadId === parent.threadId)),
      );
      assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: taskId! }]);
      const offers = yield* Offers;
      yield* Ref.set(offers, []);
      const complete = (result: string) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make(`command:remote-complete:${result}`),
          parentThreadId: parent.threadId,
          taskId: taskId!,
          status: "completed",
          result,
          stoppedThere: "ran-out",
        });
      yield* complete("All 412 tests pass on the box.");
      // A second report is done and records nothing, so the first result stands.
      const late = yield* complete("A late, different answer.");
      assert.deepEqual(late.storedEvents, []);

      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "All 412 tests pass on the box.");
      // The live parent run claimed it, so task_status acknowledges it as for a local child.
      assert.equal(task?.completionDelivery?.state, "claimed");
      // Nothing is left for the follower to pick up after a restart.
      assert.deepEqual(yield* openFor, []);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === taskId,
      );
      assert.equal(item?.status, "completed");
      // The parent's live run is offered the delivery, as for a local child.
      const delivery = projection.runs.find((run) => run.id === parent.runId)?.delegatedCompletion
        ?.delivery;
      assert.deepEqual(delivery?.taskIds, [taskId]);
      const offered = yield* Ref.get(offers);
      assert.equal(offered.length, 1);
      assert.equal(offered[0]?.threadId, parent.threadId);
    }),
  );
});

const command = {
  command: "vp run check:changed",
  cwd: "/work/checkout",
  logPath: "/state/logs/commands/task/output.log",
  timeoutMinutes: 60,
};

it.layer(layerTest)("a command task", (it) => {
  it.effect("is recorded once and wakes its parent once with the first result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("command");
      const request = {
        type: "delegated_task.command.request" as const,
        commandId: CommandId.make("command:command-run:command"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        title: "Checks",
        driver: ProviderDriverKind.make("command"),
        providerInstanceId: instanceId,
        command,
      };
      yield* orchestrator.dispatch(request);
      yield* orchestrator.dispatch(request);
      const recorded = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(recorded.subagents.length, 1);
      const task = recorded.subagents[0]!;
      assert.equal(task.childThreadId, null);
      assert.deepEqual(task.command, command);
      assert.equal(task.status, "running");
      assert.equal(task.title, "Checks");
      assert.equal(task.demandId, parentDemand);

      const offers = yield* Offers;
      yield* Ref.set(offers, []);
      const complete = (result: string) =>
        orchestrator.dispatch({
          type: "delegated_task.command.complete",
          commandId: CommandId.make(`command:command-complete:${result}`),
          parentThreadId: parent.threadId,
          taskId: task.id,
          status: "failed",
          result,
        });
      yield* complete("Exited with code 3 after 2s.");
      // The runner reports again after a restart; the first result stands and nothing wakes.
      yield* complete("Exited with code 3 after 2s, reported again.").pipe(Effect.ignore);

      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const settled = projection.subagents.find((candidate) => candidate.id === task.id);
      assert.equal(settled?.status, "failed");
      assert.equal(settled?.result, "Exited with code 3 after 2s.");
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
      );
      assert.deepEqual(item?.type === "subagent" ? item.command : undefined, command);
      assert.equal(item?.status, "failed");
      const offered = yield* Ref.get(offers);
      assert.equal(offered.length, 1);
      assert.equal(offered[0]?.threadId, parent.threadId);
    }),
  );

  it.effect(
    "waits with its reason until it starts, and a start after its result records nothing",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const parent = yield* seedLiveParent("command-waiting");
        const waiting = "Queued until this machine has memory for it.";
        yield* orchestrator.dispatch({
          type: "delegated_task.command.request",
          commandId: CommandId.make("command:command-run:command-waiting"),
          parentThreadId: parent.threadId,
          parentRunId: parent.runId,
          parentNodeId: parent.rootNodeId,
          title: "Checks",
          driver: ProviderDriverKind.make("command"),
          providerInstanceId: instanceId,
          command,
          waiting,
        });
        const recorded = yield* orchestrator.getThreadProjection(parent.threadId);
        const task = recorded.subagents[0]!;
        const itemOf = (projection: typeof recorded) =>
          projection.turnItems.find(
            (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
          );
        assert.equal(task.status, "pending");
        assert.equal(task.progress, waiting);
        assert.isNull(task.startedAt);
        assert.equal(itemOf(recorded)?.status, "pending");

        const start = (key: string) =>
          orchestrator.dispatch({
            type: "delegated_task.command.start",
            commandId: CommandId.make(`command:command-start:${key}`),
            parentThreadId: parent.threadId,
            taskId: task.id,
          });
        yield* start("first");
        const started = yield* orchestrator.getThreadProjection(parent.threadId);
        const running = started.subagents.find((candidate) => candidate.id === task.id);
        assert.equal(running?.status, "running");
        assert.notProperty(running, "progress");
        assert.isNotNull(running?.startedAt);
        const runningItem = itemOf(started);
        assert.equal(runningItem?.status, "running");
        assert.notProperty(runningItem, "progress");

        yield* orchestrator.dispatch({
          type: "delegated_task.command.complete",
          commandId: CommandId.make("command:command-complete:command-waiting"),
          parentThreadId: parent.threadId,
          taskId: task.id,
          status: "cancelled",
          result: "Cancelled.",
        });
        // The runner's start can lose the race to a cancel.
        yield* start("late").pipe(Effect.ignore);
        const settled = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents.find(
          (candidate) => candidate.id === task.id,
        );
        assert.equal(settled?.status, "cancelled");
        assert.equal(settled?.result, "Cancelled.");
      }),
  );

  it.effect("keeps its parent completed when checkpoint capture lands before its result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const parent = yield* seedLiveParent("command-capture-race");
      yield* orchestrator.dispatch({
        type: "delegated_task.command.request",
        commandId: CommandId.make("command:command-run:capture-race"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        title: "Checks",
        driver: ProviderDriverKind.make("command"),
        providerInstanceId: instanceId,
        command,
      });
      const recorded = yield* orchestrator.getThreadProjection(parent.threadId);
      const task = recorded.subagents[0]!;
      const running = recorded.runs.find((run) => run.id === parent.runId)!;
      const waiting = { ...running, status: "waiting" as const };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:capture-race:waiting"),
            type: "run.updated",
            threadId: parent.threadId,
            runId: parent.runId,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: waiting,
          },
        ],
      });
      const queuedMessageId = MessageId.make("message:capture-race:queued");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:capture-race:queued"),
        threadId: parent.threadId,
        messageId: queuedMessageId,
        text: "Next",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedRun = (yield* orchestrator.getThreadProjection(parent.threadId)).runs.find(
        (run) => run.userMessageId === queuedMessageId,
      );
      assert.equal(queuedRun?.status, "queued");

      const checkpointId = CheckpointId.make("checkpoint:capture-race");
      const commit = sink.commitCommand;
      let captured = false;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
            Effect.gen(function* () {
              if (!captured && input.commandType === "delegated_task.command.complete") {
                captured = true;
                // Capture commits after the completion planned from the waiting run.
                yield* commit({
                  commandId: CommandId.make(`command:effect:checkpoint.capture:${parent.runId}`),
                  threadId: parent.threadId,
                  commandType: "checkpoint.capture",
                  acceptedAt: now,
                  effects: [],
                  events: [
                    {
                      id: EventId.make("event:capture-race:completed"),
                      type: "run.updated",
                      threadId: parent.threadId,
                      runId: parent.runId,
                      providerInstanceId: instanceId,
                      occurredAt: now,
                      payload: { ...waiting, status: "completed", completedAt: now, checkpointId },
                    },
                  ],
                });
              }
              return yield* commit(input);
            }),
          ),
        ),
        () =>
          orchestrator.dispatch({
            type: "delegated_task.command.complete",
            commandId: CommandId.make("command:command-complete:capture-race"),
            parentThreadId: parent.threadId,
            taskId: task.id,
            status: "completed",
            result: "Exited with code 0 after 2s.",
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("command:capture-race:resume"),
        threadId: parent.threadId,
      });

      assert.isTrue(captured);
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const parentRun = projection.runs.find((run) => run.id === parent.runId);
      assert.equal(parentRun?.status, "completed");
      assert.equal(parentRun?.checkpointId, checkpointId);
      assert.deepEqual(parentRun?.delegatedCompletion?.delivery?.taskIds, [task.id]);
      const next = projection.runs.find((run) => run.userMessageId === queuedMessageId);
      assert.notEqual(next?.status, "queued");
    }),
  );
});
