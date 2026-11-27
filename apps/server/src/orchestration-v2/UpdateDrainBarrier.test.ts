import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  orchestrationV2RunAwaitsMemory,
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
import * as EffectOutbox from "./EffectOutbox.ts";
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

const makeLayerTest = (customAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = adapter) => {
  const layerDrain = UpdateDrain.layer;
  const layerOffers = Layer.effect(
    OfferQueue,
    Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>(),
  );
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerReplay = ProviderReplayHarness.layerWithRegistry(
    { name: "update-drain-barrier" },
    ProviderAdapterRegistry.layerFromAdapters([customAdapter]),
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

it.effect(
  "defer_start with workspaceStrategy queues under drain and promotes into preparing + workspace.prepare when drain clears",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drain = yield* UpdateDrain.UpdateDrain;
      const threadId = yield* createIdleThread("drain-defer-start");

      const lease = yield* acquireDrain(drain);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-defer-start"),
        threadId,
        messageId: MessageId.make("message:drain-defer-start"),
        text: "Prepare a worktree once drain clears",
        attachments: [],
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
        modelSelection,
      });

      const whileDraining = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(whileDraining.runs[0]?.status, "queued");
      assert.equal(whileDraining.runs[0]?.queueHeldByUpdateDrain, true);
      assert.equal(whileDraining.runs[0]?.workspacePreparation?.type, "worktree");

      const promoted = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "run.updated" &&
            event.payload.status === "preparing",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* releaseDrain(lease);
      yield* Fiber.join(promoted);

      const afterClear = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterClear.runs[0]?.status, "preparing");
      assert.equal(afterClear.runs[0]?.queueHeldByUpdateDrain, undefined);
      const claimed = yield* outbox.claimNext({ workerId: "test-drain-defer" });
      assert.isTrue(Option.isSome(claimed));
      if (Option.isSome(claimed)) {
        assert.equal(claimed.value.request.type, "workspace.prepare");
        assert.equal(
          claimed.value.request.type === "workspace.prepare" ? claimed.value.request.runId : null,
          afterClear.runs[0]?.id,
        );
      }
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "drain waits for an in-flight Orchestrator dispatch to commit before reading restartHold (no TOCTOU race)",
  () =>
    Effect.gen(function* () {
      const capabilitiesEntered = yield* Deferred.make<void>();
      const releaseCapabilities = yield* Deferred.make<void>();
      let blockNextCapabilities = false;
      const pausingAdapter = {
        ...adapter,
        getCapabilities: () =>
          blockNextCapabilities
            ? Deferred.succeed(capabilitiesEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCapabilities)),
                Effect.as(CodexProviderCapabilitiesV2),
              )
            : Effect.succeed(CodexProviderCapabilitiesV2),
      } as ProviderAdapter.ProviderAdapterV2["Service"];

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const drain = yield* UpdateDrain.UpdateDrain;
        const threadId = yield* createIdleThread("drain-toctou");

        blockNextCapabilities = true;
        const dispatchFiber = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:msg:drain-toctou"),
            threadId,
            messageId: MessageId.make("message:drain-toctou"),
            text: "Admitted just before drain arrives",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
            modelSelection,
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(capabilitiesEntered);

        const drainEntered = yield* Deferred.make<void>();
        const drainFiber = yield* UpdateDrain.whileDraining(
          Deferred.succeed(drainEntered, undefined).pipe(Effect.andThen(recovery.restartHold)),
        ).pipe(Effect.provideService(UpdateDrain.UpdateDrain, drain), Effect.forkChild);

        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(drainEntered));

        yield* Deferred.succeed(releaseCapabilities, undefined);
        yield* Fiber.join(dispatchFiber);
        const hold = yield* Fiber.join(drainFiber);

        assert.isTrue(hold.draining === true);
        assert.isTrue(hold.runningTurns?.some((turn) => turn.threadId === threadId));
      }).pipe(Effect.provide(makeLayerTest(pausingAdapter)));
    }),
);

it.effect(
  "queue.resume during drain keeps queueHeldByUpdateDrain on every queued run and skips starting them",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const drain = yield* UpdateDrain.UpdateDrain;
      const threadId = yield* createIdleThread("drain-queue-resume");

      const lease = yield* acquireDrain(drain);
      for (const index of [1, 2] as const) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:msg:drain-queue-resume-${index}`),
          threadId,
          messageId: MessageId.make(`message:drain-queue-resume-${index}`),
          text: `Queued message ${index}`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
          modelSelection,
        });
      }

      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("command:queue-resume:drain"),
        threadId,
      });

      const afterResume = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterResume.runs.length, 2);
      for (const run of afterResume.runs) {
        assert.equal(run.status, "queued");
        assert.equal(run.queueHeldByUpdateDrain, true);
      }

      yield* releaseDrain(lease);
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect("run.memory-admit is skipped while draining and leaves the run waiting for memory", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const drain = yield* UpdateDrain.UpdateDrain;
    const threadId = yield* createIdleThread("drain-memory-admit");
    const runId = RunId.make("run:drain-memory-admit");
    const now = yield* DateTime.now;

    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:drain-memory-admit:run"),
          type: "run.created",
          threadId,
          runId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            status: "starting",
            requestedAt: now,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            modelSelection,
            providerInstanceId: instanceId,
            providerThreadId: null,
            rootNodeId: null,
            activeAttemptId: null,
            userMessageId: MessageId.make("message:drain-memory-admit"),
            memoryAdmission: {
              waitingSince: now,
            },
          },
        },
      ],
    });

    const lease = yield* acquireDrain(drain);
    yield* orchestrator.dispatch({
      type: "run.memory-admit",
      commandId: CommandId.make("command:memory-admit:drain"),
      threadId,
      runId,
    });

    const afterAdmit = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(afterAdmit.runs[0]?.status, "starting");
    assert.equal(afterAdmit.runs[0]?.memoryAdmission?.admittedAt, undefined);

    yield* releaseDrain(lease);
  }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "prepared-run.retry and user follow-ups during drain keep memory-waiting worktree runs out of restartHold",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drain = yield* UpdateDrain.UpdateDrain;
      const threadId = yield* createIdleThread("drain-retry-deadlock");

      // Create a worktree-backed preparing run before drain, then simulate a restart cutting it.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-retry-initial"),
        threadId,
        messageId: MessageId.make("message:drain-retry-initial"),
        text: "Initial worktree task",
        attachments: [],
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
      });
      yield* recovery.reconcile("startup");
      const afterRestart = yield* orchestrator.getThreadProjection(threadId);
      const cutRun = afterRestart.runs[0];
      assert.isDefined(cutRun);
      assert.equal(cutRun.status, "cancelled");

      // Clear outbox effects queued by startup reconciliation before testing drain behavior.
      while (true) {
        const claimed = yield* outbox.claimNext({ workerId: "test-clear-startup" });
        if (Option.isNone(claimed)) break;
        yield* outbox.succeed({
          effectId: claimed.value.id,
          workerId: "test-clear-startup",
        });
      }

      const lease = yield* acquireDrain(drain);

      // Automatic restart retry during drain puts the run into awaiting memory without blocking restartHold.
      yield* orchestrator.dispatch({
        type: "prepared-run.retry",
        automatic: true,
        commandId: CommandId.make("command:retry:drain-retry-initial"),
        threadId,
        runId: cutRun.id,
      });

      const afterRetry = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterRetry.runs[0]?.status, "preparing");
      assert.isTrue(orchestrationV2RunAwaitsMemory(afterRetry.runs[0]!));

      const holdAfterRetry = yield* recovery.restartHold;
      assert.deepEqual(holdAfterRetry.work, []);
      assert.deepEqual(holdAfterRetry.runningTurns, []);

      // A follow-up user message sent during drain must not bypass drain via startMemoryHeldRun.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-retry-followup"),
        threadId,
        messageId: MessageId.make("message:drain-retry-followup"),
        text: "Follow-up during drain",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });

      const afterFollowUp = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterFollowUp.runs.length, 2);
      assert.equal(afterFollowUp.runs[0]?.status, "preparing");
      assert.isTrue(orchestrationV2RunAwaitsMemory(afterFollowUp.runs[0]!));
      assert.equal(afterFollowUp.runs[1]?.status, "queued");

      const holdAfterFollowUp = yield* recovery.restartHold;
      assert.deepEqual(holdAfterFollowUp.work, []);
      assert.deepEqual(holdAfterFollowUp.runningTurns, []);

      // Neither retry nor follow-up may emit workspace.prepare or provider-turn.start during drain.
      const pendingEffects: Array<string> = [];
      while (true) {
        const claimed = yield* outbox.claimNext({ workerId: "test-check-drain-retry" });
        if (Option.isNone(claimed)) break;
        pendingEffects.push(claimed.value.request.type);
        yield* outbox.succeed({
          effectId: claimed.value.id,
          workerId: "test-check-drain-retry",
        });
      }
      assert.isFalse(pendingEffects.includes("workspace.prepare"));
      assert.isFalse(pendingEffects.includes("provider-turn.start"));

      yield* releaseDrain(lease);
    }).pipe(Effect.provide(makeLayerTest())),
);

it.effect(
  "user message.dispatch during drain revives a restart-cut run into memory-wait instead of starting it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drain = yield* UpdateDrain.UpdateDrain;
      const threadId = yield* createIdleThread("drain-user-revive");

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-user-revive-initial"),
        threadId,
        messageId: MessageId.make("message:drain-user-revive-initial"),
        text: "Original worktree task",
        attachments: [],
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
      });
      yield* recovery.reconcile("startup");
      while (true) {
        const claimed = yield* outbox.claimNext({ workerId: "test-clear-revive" });
        if (Option.isNone(claimed)) break;
        yield* outbox.succeed({
          effectId: claimed.value.id,
          workerId: "test-clear-revive",
        });
      }

      const lease = yield* acquireDrain(drain);

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:msg:drain-user-revive-followup"),
        threadId,
        messageId: MessageId.make("message:drain-user-revive-followup"),
        text: "User follow-up during drain",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });

      const afterDispatch = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterDispatch.runs.length, 2);
      assert.equal(afterDispatch.runs[0]?.status, "preparing");
      assert.isTrue(orchestrationV2RunAwaitsMemory(afterDispatch.runs[0]!));
      assert.equal(afterDispatch.runs[1]?.status, "queued");

      const hold = yield* recovery.restartHold;
      assert.deepEqual(hold.work, []);
      assert.deepEqual(hold.runningTurns, []);

      const pendingEffects: Array<string> = [];
      while (true) {
        const claimed = yield* outbox.claimNext({ workerId: "test-check-revive" });
        if (Option.isNone(claimed)) break;
        pendingEffects.push(claimed.value.request.type);
        yield* outbox.succeed({
          effectId: claimed.value.id,
          workerId: "test-check-revive",
        });
      }
      assert.isFalse(pendingEffects.includes("workspace.prepare"));
      assert.isFalse(pendingEffects.includes("provider-turn.start"));

      yield* releaseDrain(lease);
    }).pipe(Effect.provide(makeLayerTest())),
);
