import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2RestartHold,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as SubscriptionRef from "effect/SubscriptionRef";

import * as UpdateDrain from "../cloud/updateDrain.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import { seedLiveParent as seedLiveParentThread } from "./testkit/LiveParentThread.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for update drain barrier tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

class OfferQueue extends Context.Service<
  OfferQueue,
  Queue.Queue<ProviderContinuationRequests.ProviderContinuationRequest>
>()("t3/orchestration-v2/UpdateDrainBarrier.test/OfferQueue") {}

const acquireDrain = (drain: SubscriptionRef.SubscriptionRef<UpdateDrain.DrainState>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* UpdateDrain.drainUntilClosed.pipe(
      Scope.provide(scope),
      Effect.provideService(UpdateDrain.UpdateDrain, drain),
    );
    return scope;
  });

const releaseDrain = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

const makeLayerTest = () => {
  const layerDrain = UpdateDrain.layer;
  const layerOffers = Layer.effect(
    OfferQueue,
    Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>(),
  );
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerReplay = ProviderReplayHarness.layerWithRegistry(
    { name: "update-drain-barrier" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerRecovery = ProviderRuntimeRecoveryService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerReplay, IdAllocator.layer, ServerSettings.layerTest(), layerDrain),
    ),
  );
  return Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    layerReplay,
    layerRecovery,
  ).pipe(
    Layer.provide(
      Layer.effect(
        ProviderContinuationRequests.ProviderContinuationRequests,
        OfferQueue.pipe(
          Effect.map((offers) => ({
            offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
              Queue.offer(offers, request).pipe(Effect.asVoid),
            take: Effect.never,
          })),
        ),
      ),
    ),
    Layer.provideMerge(layerOffers),
    Layer.provideMerge(layerDrain),
  );
};

const seedLiveParent = (name: string) => seedLiveParentThread({ name, driver, modelSelection });

const createIdleThread = Effect.fn("test.updateDrainBarrier.createIdleThread")(function* (
  name: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:create:${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  return threadId;
});

const waitForRunStarting = Effect.fn("test.updateDrainBarrier.waitForRunStarting")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const updated = yield* eventSink.stream({ threadId, eventType: "run.updated" }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        stored.event.payload.id === runId &&
        stored.event.payload.status === "starting",
    ),
    Stream.runHead,
  );
  assert.isTrue(Option.isSome(updated));
});

it.effect("queues new user turns on an idle thread during drain and starts them when cleared", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const drain = yield* UpdateDrain.UpdateDrain;
    const threadId = yield* createIdleThread("user-turn-drain");

    const lease = yield* acquireDrain(drain);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:msg:user-turn-drain"),
      threadId,
      messageId: MessageId.make("message:user-turn-drain"),
      text: "Hello during update drain",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      modelSelection,
    });

    const whileDraining = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(whileDraining.runs.length, 1);
    const queuedRun = whileDraining.runs[0]!;
    assert.equal(queuedRun.status, "queued");
    assert.equal(queuedRun.queueHeldByUpdateDrain, true);
    assert.equal(queuedRun.queueHeld, undefined);

    const promoted = yield* Effect.forkChild(waitForRunStarting(threadId, queuedRun.id), {
      startImmediately: true,
    });
    yield* releaseDrain(lease);
    yield* Fiber.join(promoted);

    const afterDrain = yield* orchestrator.getThreadProjection(threadId);
    const startedRun = afterDrain.runs.find((candidate) => candidate.id === queuedRun.id);
    assert.equal(startedRun?.status, "starting");
    assert.equal(startedRun?.queueHeldByUpdateDrain, undefined);
    assert.equal(startedRun?.queueHeld, undefined);
  }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "holds idle-thread command completion wakes during drain and delivers them when cleared",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const offers = yield* OfferQueue;
      const drain = yield* UpdateDrain.UpdateDrain;
      const parent = yield* seedLiveParent("command-wake-drain");

      yield* orchestrator.dispatch({
        type: "delegated_task.command.request",
        commandId: CommandId.make("command:cmd-req:command-wake-drain"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        title: "Checks",
        driver: ProviderDriverKind.make("command"),
        providerInstanceId: instanceId,
        command: {
          command: "vp run check:changed",
          cwd: "/repo",
          logPath: "/tmp/checks.log",
          timeoutMinutes: 60,
        },
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;

      // Settle the parent run so the thread is idle when the command finishes.
      const beforeSettle = yield* orchestrator.getThreadProjection(parent.threadId);
      const parentRun = beforeSettle.runs.find((candidate) => candidate.id === parent.runId)!;
      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("command:settle-parent:command-wake-drain"),
        events: [
          {
            id: EventId.make("event:settle-parent-run:command-wake-drain"),
            type: "run.updated",
            threadId: parent.threadId,
            runId: parent.runId,
            nodeId: parent.rootNodeId,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...parentRun, status: "completed", completedAt: now },
          },
        ],
      });

      const lease = yield* acquireDrain(drain);
      yield* orchestrator.dispatch({
        type: "delegated_task.command.complete",
        commandId: CommandId.make("command:cmd-complete:command-wake-drain"),
        parentThreadId: parent.threadId,
        taskId: task.id,
        status: "completed",
        result: "All checks passed.",
      });

      // The completion is recorded on the parent, but no wake is offered while draining.
      const settled = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents.find(
        (candidate) => candidate.id === task.id,
      );
      assert.equal(settled?.status, "completed");
      assert.equal(yield* Queue.size(offers), 0);

      // Clearing drain triggers recoverDelegatedTasks and offers the wake.
      yield* releaseDrain(lease);
      const offered = yield* Queue.take(offers);
      assert.equal(offered.threadId, parent.threadId);
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "bypasses drain for mode=wait delegations while queueing mode=async delegations until drain clears",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const drain = yield* UpdateDrain.UpdateDrain;
      const parent = yield* seedLiveParent("delegation-deadlock");

      const lease = yield* acquireDrain(drain);

      // mode: "wait" uses completionWake: "settled_only" (or omitted) — must start immediately so
      // the running parent turn waiting on it cannot deadlock.
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:delegate-wait"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Finish blocking check",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
      });

      // mode: "async" uses completionWake: "always" — parent does not block on it, so queue under drain.
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:delegate-async"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Background async work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });

      const parentProjection = yield* orchestrator.getThreadProjection(parent.threadId);
      const waitTask = parentProjection.subagents.find(
        (candidate) => candidate.completionWake === "settled_only",
      );
      const asyncTask = parentProjection.subagents.find(
        (candidate) => candidate.completionWake === "always",
      );
      assert.isNotNull(waitTask?.childThreadId);
      assert.isNotNull(asyncTask?.childThreadId);

      const waitChild = yield* orchestrator.getThreadProjection(waitTask!.childThreadId!);
      assert.equal(waitChild.runs[0]?.status, "starting");
      assert.equal(waitChild.runs[0]?.queueHeldByUpdateDrain, undefined);

      const asyncChild = yield* orchestrator.getThreadProjection(asyncTask!.childThreadId!);
      const asyncRun = asyncChild.runs[0]!;
      assert.equal(asyncRun.status, "queued");
      assert.equal(asyncRun.queueHeldByUpdateDrain, true);
      assert.equal(asyncRun.queueHeld, undefined);

      const asyncPromoted = yield* Effect.forkChild(
        waitForRunStarting(asyncTask!.childThreadId!, asyncRun.id),
        { startImmediately: true },
      );
      yield* releaseDrain(lease);
      yield* Fiber.join(asyncPromoted);

      const asyncAfter = yield* orchestrator.getThreadProjection(asyncTask!.childThreadId!);
      assert.equal(asyncAfter.runs[0]?.status, "starting");
      assert.equal(asyncAfter.runs[0]?.queueHeldByUpdateDrain, undefined);
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "startup reconciliation leaves runs queued solely by update drain unheld so they start after restart",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const drain = yield* UpdateDrain.UpdateDrain;
      const threadId = yield* createIdleThread("drain-reconcile-startup");

      const lease = yield* acquireDrain(drain);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-reconcile-startup"),
        threadId,
        messageId: MessageId.make("message:drain-reconcile-startup"),
        text: "Queued right before clean drained restart",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
        modelSelection,
      });

      const beforeReconcile = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = beforeReconcile.runs[0]!;
      assert.equal(queuedRun.status, "queued");
      assert.equal(queuedRun.queueHeldByUpdateDrain, true);
      assert.equal(queuedRun.queueHeld, undefined);

      // Reconcile as if the new server process just booted after a clean drained shutdown.
      yield* recovery.reconcile("startup");

      const afterReconcile = yield* orchestrator.getThreadProjection(threadId);
      const reconciledRun = afterReconcile.runs[0]!;
      assert.equal(reconciledRun.status, "queued");
      assert.equal(reconciledRun.queueHeld, undefined);
      assert.equal(reconciledRun.queueHeldByRestart, undefined);
      assert.equal(reconciledRun.queueHeldByUpdateDrain, true);

      // Clean up the lease before test finishes.
      yield* releaseDrain(lease);
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect("restartHold and watchRestartHold reactively reflect draining state", () =>
  Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
    const drain = yield* UpdateDrain.UpdateDrain;

    const initial = yield* recovery.restartHold;
    assert.equal(initial.draining, undefined);

    const observed = yield* Queue.unbounded<OrchestrationV2RestartHold>();
    const subscribed = yield* Deferred.make<void>();
    const watcher = yield* recovery.watchRestartHold.pipe(
      Stream.tap((hold) =>
        Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Queue.offer(observed, hold))),
      ),
      Stream.runDrain,
      Effect.forkChild,
    );

    yield* Deferred.await(subscribed);
    const first = yield* Queue.take(observed);
    assert.equal(first.draining, undefined);

    const lease = yield* acquireDrain(drain);
    const whileDraining = yield* Queue.take(observed);
    assert.equal(whileDraining.draining, true);
    assert.equal((yield* recovery.restartHold).draining, true);

    yield* releaseDrain(lease);
    const afterClear = yield* Queue.take(observed);
    assert.equal(afterClear.draining, undefined);
    assert.equal((yield* recovery.restartHold).draining, undefined);

    yield* Fiber.interrupt(watcher);
  }).pipe(Effect.provide(makeLayerTest())),
);
