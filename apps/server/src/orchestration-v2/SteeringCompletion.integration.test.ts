import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  GuestMessageId,
  GuestShareId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts/baseSchemas";
import { type ChatAttachment, ChatAttachmentId } from "@t3tools/contracts/chatAttachment";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Layer from "effect/Layer";
import * as Orchestrator from "./Orchestrator.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { delegatedCompletionUpdated } from "./testkit/DelegatedCompletionCohort.ts";
import { scratchWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  (
    [
      [false, "during delivery"],
      [false, "before dispatch"],
      [true, "after delivery"],
      [true, "without native steering"],
      [true, "with interrupting native steering"],
      [true, "settled only"],
      [true, "with unknown task owners"],
      [true, "with mixed task owners"],
      [false, "during continuation"],
    ] as const
  ).map(([mailbox, timing]) => ({
    mailbox,
    timing,
    label: mailbox ? "mailbox notification" : "steering",
  })),
)("delivers $label when completion wins $timing", ({ mailbox, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* scratchWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const rejectSteer = yield* Deferred.make<void>();
      const separateMailbox =
        timing === "with unknown task owners" || timing === "with mixed task owners";
      let steerCalls = 0;
      let interrupts = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: timing !== "without native steering",
          activeSteeringInterruptsTools: timing === "with interrupting native steering",
        },
      };
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
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
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steerCalls += 1;
                  if (
                    timing === "after delivery" ||
                    timing === "during continuation" ||
                    separateMailbox
                  )
                    return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () =>
                Effect.sync(() => {
                  interrupts += 1;
                }),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:steering-completion");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-completion"),
          title: "Steering race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: separateMailbox ? "agent" : "user",
          creationSource: separateMailbox ? "mcp" : "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const messageId = MessageId.make("message:steering");
        const taskId = NodeId.make("task:mailbox");
        const taskIds = separateMailbox ? [taskId, NodeId.make("task:another")] : [taskId];
        if (mailbox) {
          const sink = yield* EventSink.EventSinkV2;
          const source = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === first.runId,
          )!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              delegatedCompletionUpdated({
                id: "mailbox:cohort",
                threadId,
                runId: first.runId,
                occurredAt: now,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId, taskIds },
                },
              }),
              ...taskIds.map((id, index): OrchestrationV2DomainEvent => ({
                id: EventId.make(`mailbox:${id}`),
                type: "subagent.updated",
                threadId,
                runId: first.runId,
                nodeId: id,
                occurredAt: now,
                payload: {
                  id,
                  threadId,
                  runId: first.runId,
                  demandId:
                    timing === "with mixed task owners"
                      ? `demand:${String(index + 1).repeat(64)}`
                      : (source.demandId ?? null),
                  parentNodeId: first.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Do background work",
                  title: "Background test",
                  model: null,
                  completionWake: timing === "settled only" ? "settled_only" : "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              })),
            ],
          });
        }
        const dispatchSteer = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "fix the popover",
          attachments: [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          dispatchMode: mailbox
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox ? "agent" : "user",
          creationSource: mailbox ? "server" : "web",
          ...(mailbox
            ? {
                delegatedCompletion: {
                  parentRunId: first.runId,
                  generation: 1,
                  taskIds,
                },
              }
            : {}),
        });
        if (timing !== "before dispatch") yield* dispatchSteer;
        if (separateMailbox) {
          yield* worker.drain();
          assert.equal(steerCalls, 0);
          assert.equal(interrupts, 0);
          const { runs } = yield* orchestrator.getThreadProjection(threadId);
          assert.isNull(runs.find((run) => run.id === first.runId)?.demandId);
          const followup = runs.find((run) => run.userMessageId === messageId);
          assert.equal(followup?.status, "queued");
          assert.isNull(followup?.demandId);
          return;
        }
        if (timing === "during continuation") {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          const failed = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "failed",
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
          });
          yield* Fiber.join(failed);
          yield* worker.drain();
          assert.equal(steerCalls, 1);
          assert.lengthOf(started, 1);
          const continued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(continued.runs[0]?.status, "running");
          assert.equal(
            continued.messages.find((message) => message.id === messageId)?.runId,
            first.runId,
          );
          return;
        }
        if (timing === "after delivery") yield* worker.drain();
        const delivery =
          timing === "during delivery" ? yield* worker.runOnce().pipe(Effect.forkScoped) : null;
        if (delivery !== null) yield* Deferred.await(steerEntered);
        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        if (delivery !== null) {
          yield* Deferred.succeed(rejectSteer, undefined);
          yield* Fiber.join(delivery);
          const requeued = yield* orchestrator.getThreadProjection(threadId);
          const item = requeued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          );
          assert.equal(item?.status, "pending");
          assert.isNull(item?.startedAt);
          assert.isNull(item?.completedAt);
        }
        if (timing === "before dispatch") yield* dispatchSteer;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (timing === "after delivery") {
          assert.equal(steerCalls, 1);
          assert.equal(started.length, 1);
          if (mailbox) {
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
            assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
            assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
            assert.equal(
              delivered.turnItems.filter((item) => item.type === "notification").length,
              1,
            );
            yield* orchestrator.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make("duplicate-acceptance"),
              threadId,
              messageId,
            });
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-result"),
              parentThreadId: threadId,
              taskId,
              observedByRunId: first.runId,
            });
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
          }
          return;
        }
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
        else assert.equal(started[1]?.message.text, "fix the popover");
        assert.deepEqual(started[1]?.message.attachments, [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
        const final = yield* orchestrator.getThreadProjection(threadId);
        const original = final.runs.find((run) => run.id === first.runId)!;
        assert.isString(original.demandId);
        assert.equal(
          final.runs.find((run) => run.id === started[1]?.runId)?.demandId,
          original.demandId,
        );
        if (!mailbox) {
          assert.equal(
            final.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            )?.status,
            "completed",
          );
        }
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox
              ? item.type === "notification"
              : item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
        yield* worker.drain();
        assert.equal(started.length, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: `steering-completion-${timing}` },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false, inMemoryCheckpoints: true },
          ),
        ),
      );
    }),
  ),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  steerRequiresNewTurn = false,
  canSteer = true,
  interruptTurn: Effect.Effect<void> = Effect.void,
) {
  const cwd = yield* scratchWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  // A steer the provider can only run as its own turn waits here, so a test can Stop meanwhile.
  const steerEntered = yield* Deferred.make<void>();
  const releaseSteer = yield* Deferred.make<void>();
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: canSteer,
      supportsSteeringByInterruptRestart: canRestart,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const runningTurns = new Map<
          ProviderTurnId,
          {
            readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
            readonly providerTurn: {
              readonly id: ProviderTurnId;
              readonly providerThreadId: ProviderThreadId;
              readonly nodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
              readonly runAttemptId: ProviderAdapter.ProviderAdapterV2TurnInput["attemptId"];
              readonly nativeTurnRef: {
                readonly driver: typeof driver;
                readonly nativeId: string;
                readonly strength: "strong";
              };
              readonly ordinal: number;
              readonly status: "running";
              readonly startedAt: DateTime.Utc;
              readonly completedAt: null;
            };
          }
        >();
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            const providerTurn = {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong" as const,
              },
              ordinal: turn.providerTurnOrdinal,
              status: "running" as const,
              startedAt: now,
              completedAt: null,
            };
            runningTurns.set(providerTurn.id, { turn, providerTurn });
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn,
            });
          });
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
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            steerRequiresNewTurn
              ? Deferred.succeed(steerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSteer)),
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapter.ProviderAdapterSteerRunError({
                        driver,
                        providerThreadId: turn.providerThread.id,
                        providerTurnId: turn.providerTurnId,
                        requiresNewTurn: true,
                      }),
                    ),
                  ),
                )
              : Effect.sync(() => {
                  steered.push(turn.message.text);
                }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              interrupted.push(providerTurnId);
              yield* interruptTurn;
              const active = runningTurns.get(providerTurnId);
              if (active === undefined) return;
              runningTurns.delete(providerTurnId);
              const completedAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  ...active.providerTurn,
                  status: "interrupted",
                  completedAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: active.providerTurn.providerThreadId,
                providerTurnId,
                runOrdinal: active.turn.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false, inMemoryCheckpoints: true },
  );
  const createThread = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
  const startFirstTurnFrom = Effect.fn("startFirstTurnFrom")(function* (source: "web" | "mcp") {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = yield* createThread;
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: source === "web" ? "user" : "agent",
      creationSource: source,
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return {
    cwd,
    events,
    started,
    steered,
    interrupted,
    layer,
    createThread,
    startFirstTurn: startFirstTurnFrom("web"),
    startFirstTurnFrom,
    steerEntered,
    releaseSteer,
  };
});

it.effect("sends a selected held message once and preserves the remaining queue order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-held-message");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* Effect.forEach(["queued-first", "selected", "queued-last"], (text) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(text),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        const before = yield* orchestrator.getThreadProjection(threadId);
        const selected = before.runs.find(
          (run) => run.userMessageId === MessageId.make("message:selected"),
        )!;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        // Restart recovery cancels the active run and holds every queued message.
        yield* sink.write({
          events: [
            ...before.runs.map((run) => ({
              id: EventId.make(`restart:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload:
                run.status === "queued"
                  ? { ...run, queueHeld: true }
                  : { ...run, status: "cancelled" as const, completedAt: now },
            })),
            ...before.providerTurns.map((turn) => ({
              id: EventId.make(`restart:${turn.id}`),
              type: "provider-turn.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "cancelled" as const, completedAt: now },
            })),
          ],
        });
        const command = {
          type: "queued-run.start" as const,
          commandId: CommandId.make("send-selected"),
          threadId,
          runId: selected.id,
        };
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === selected.id)?.status, "running");
        assert.deepEqual(
          started.map((input) => input.message.text),
          ["first", "selected"],
        );
        assert.equal(started[1]?.runId, selected.id);
        assert.equal(started[1]?.message.messageId, selected.userMessageId);
        assert.deepEqual(started[1]?.modelSelection, runSelection);
        assert.deepEqual(steered, []);
        assert.lengthOf(
          after.messages.filter((message) => message.id === selected.userMessageId),
          1,
        );
        assert.deepEqual(
          after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:queued-first"), MessageId.make("message:queued-last")],
        );
        assert.isFalse(after.runs.some((run) => run.status === "queued" && run.queueHeld));
        const duplicate = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("send-selected-again"),
          })
          .pipe(Effect.flip);
        assert.equal(duplicate._tag, "OrchestratorDispatchError");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a busy run takes steering only from its own demand", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, interrupted, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-demand", true);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const [first] = (yield* orchestrator.getThreadProjection(threadId)).runs;
        assert.isString(first!.demandId);
        const send = (
          text: string,
          demandId: string | null,
          mode: "steer_active" | "restart_active",
        ) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make(text),
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: mode, targetRunId: first!.id },
            demandId,
            createdBy: "agent",
            creationSource: "mcp",
          });
        const other = `demand:${"2".repeat(64)}`;
        yield* send("other", other, "steer_active");
        yield* send("other", other, "steer_active");
        yield* send("unknown", null, "restart_active");
        yield* send("same", first!.demandId!, "steer_active");
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          started.map((turn) => turn.runId),
          [first!.id],
        );
        assert.deepEqual(steered, ["same"]);
        assert.deepEqual(interrupted, []);
        const queued = projection.runs.filter((run) => run.status === "queued");
        assert.deepEqual(
          queued.map((run) => [run.userMessageId, run.demandId]),
          [
            [MessageId.make("message:other"), other],
            [MessageId.make("message:unknown"), null],
          ],
        );
        const promotion = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-other"),
            threadId,
            queuedRunId: queued[0]!.id,
            targetRunId: first!.id,
          })
          .pipe(Effect.flip);
        assert.equal(promotion._tag, "OrchestratorDispatchError");
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === queued[0]!.id,
          )?.status,
          "queued",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { mode: "steer_active", historical: false },
  { mode: "restart_active", historical: true },
  { mode: "queue_after_active", historical: true },
  { mode: "queue_after_active", historical: false },
] as const)(
  "keeps unowned MCP work separate for $mode (historical: $historical)",
  ({ mode, historical }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, interrupted, layer, startFirstTurnFrom } =
          yield* nextTurnSelectionHarness("unowned-steering", true);
        yield* Effect.gen(function* () {
          const engine = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurnFrom("mcp");
          const [active] = (yield* engine.getThreadProjection(threadId)).runs;
          assert.isDefined(active);
          assert.isNull(active.demandId);
          const omitDemand = Effect.fn("omitDemand")(function* () {
            const sink = yield* EventSink.EventSinkV2;
            const now = yield* DateTime.now;
            const { runs } = yield* engine.getThreadProjection(threadId);
            yield* sink.write({
              events: runs.map(({ demandId: _owner, ...run }) => ({
                id: EventId.make(`legacy:${runs.length}:${run.id}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: run,
              })),
            });
          });
          if (historical) yield* omitDemand();
          const messageId = MessageId.make("unowned");
          yield* engine.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("send-unowned"),
            messageId,
            text: "continue independently",
            attachments: [],
            dispatchMode:
              mode === "queue_after_active"
                ? { type: mode }
                : { type: mode, targetRunId: active.id },
            ...(historical ? {} : { demandId: null }),
            createdBy: "agent",
            creationSource: "mcp",
          });
          const queued = (yield* engine.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === messageId,
          );
          assert.equal(queued?.status, "queued");
          assert.isNull(queued?.demandId);
          if (mode === "queue_after_active") {
            if (historical) yield* omitDemand();
            const rejection = yield* engine
              .dispatch({
                type: "queued-message.promote-to-steer",
                threadId,
                commandId: CommandId.make("promote"),
                queuedRunId: queued!.id,
                targetRunId: active.id,
              })
              .pipe(Effect.flip);
            assert.include(String(rejection.cause), "separate turn");
          }
          yield* worker.drain();
          assert.lengthOf(started, 1);
          assert.deepEqual(steered, []);
          assert.deepEqual(interrupted, []);
          assert.equal(
            (yield* engine.getThreadProjection(threadId)).runs.find((run) => run.id === queued!.id)
              ?.status,
            "queued",
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("an owner can steer a historical run directly and by promoting a queued message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "historical-user-steering",
      );
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const threadId = yield* startFirstTurn;
        const [first] = (yield* engine.getThreadProjection(threadId)).runs;
        const { demandId: _owner, ...legacy } = first!;
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("historical-owner"),
              type: "run.updated",
              threadId,
              runId: legacy.id,
              occurredAt: yield* DateTime.now,
              payload: legacy,
            },
          ],
        });
        for (const delivery of ["steer_active", "queue_after_active"] as const) {
          yield* engine.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make(delivery),
            messageId: MessageId.make(delivery),
            text: delivery,
            attachments: [],
            dispatchMode:
              delivery === "steer_active"
                ? { type: delivery, targetRunId: legacy.id }
                : { type: delivery },
            createdBy: "user",
            creationSource: "mobile",
          });
        }
        const queued = (yield* engine.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* engine.dispatch({
          type: "queued-message.promote-to-steer",
          threadId,
          commandId: CommandId.make("promote"),
          queuedRunId: queued.id,
          targetRunId: legacy.id,
        });
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        assert.deepEqual(steered, ["steer_active", "queue_after_active"]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { source: "web" as const, historical: false },
  { source: "mobile" as const, historical: true },
])(
  "keeps an accepted guest message in its own queued run ($source, historical: $historical)",
  ({ source, historical }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("guest-promotion");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* startFirstTurn;
          const now = yield* DateTime.now;
          const shareId = GuestShareId.make("share:guest-promotion");
          const guestMessageId = GuestMessageId.make("guest:question");
          const messageId = MessageId.make("accept-guest");
          yield* orchestrator.dispatch({
            type: "thread.guest-share.open",
            commandId: CommandId.make("open"),
            threadId,
            shareId,
            host: "env.t3.test",
            access: "approve",
            expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 24 })),
          });
          yield* orchestrator.dispatch({
            type: "thread.guest-share.redeem",
            commandId: CommandId.make("redeem"),
            threadId,
            shareId,
            guestName: "Guest",
          });
          yield* orchestrator.dispatch({
            type: "thread.guest-message.submit",
            commandId: CommandId.make("submit"),
            threadId,
            shareId,
            guestMessageId,
            text: "Review this separately",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(messageId),
            threadId,
            messageId,
            guestMessageId,
            text: "",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: source,
          });
          const before = yield* orchestrator.getThreadProjection(threadId);
          const active = before.runs.find((run) => run.status === "running");
          const queued = before.runs.find((run) => run.userMessageId === messageId);
          assert.isDefined(active);
          assert.isDefined(queued);
          assert.isString(queued.demandId);
          assert.notEqual(queued.demandId, active.demandId);
          assert.equal(
            before.messages.find((message) => message.id === messageId)?.context?.guest
              ?.guestMessageId,
            guestMessageId,
          );
          if (historical) {
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: before.runs.map(({ demandId: _owner, ...run }) => ({
                id: EventId.make(`legacy:${run.id}`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: run,
              })),
            });
          }
          const rejection = yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote-guest"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: active.id,
            })
            .pipe(Effect.flip);
          assert.equal(rejection._tag, "OrchestratorDispatchError");
          assert.include(String(rejection.cause), "must run as a separate turn");
          const after = yield* orchestrator.getThreadProjection(threadId);
          const pending = after.runs.find((run) => run.id === queued.id);
          assert.equal(pending?.status, "queued");
          assert.equal(pending?.demandId, historical ? undefined : queued.demandId);
          assert.equal(
            after.messages.find((message) => message.id === messageId)?.runId,
            queued.id,
          );
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.deepEqual(steered, []);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("force sends multiple queued messages and can force send a requeued message again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "multiple-promoted-messages",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queue = (text: string, commandId: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(commandId),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        for (const text of ["one", "two", "remaining"]) yield* queue(text, `queue-${text}`);
        const promote = Effect.fn("test.promote")(function* (text: string, commandId: string) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const queued = projection.runs.find(
            (run) =>
              run.status === "queued" && run.userMessageId === MessageId.make(`message:${text}`),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(commandId),
            threadId,
            queuedRunId: queued.id,
            targetRunId: started[0]!.runId,
          });
        });
        yield* promote("one", "promote-one");
        yield* promote("two", "promote-two");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two"]);

        const requeuedId = MessageId.make("message:one");
        const unchangedId = MessageId.make("message:two");
        for (const messageId of [requeuedId, unchangedId]) {
          yield* orchestrator.dispatch({
            type: "thread.message.star",
            commandId: CommandId.make(`star:${messageId}`),
            threadId,
            messageId,
            starred: true,
          });
        }

        // The completion-race fallback redispatches the same message into the queue.
        const redispatch = yield* queue("one", "requeue-one");
        assert.deepEqual(
          redispatch.storedEvents.find(({ event }) => event.type === "thread.message-stars-updated")
            ?.event.payload,
          [unchangedId],
        );
        const requeued = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          requeued.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === "message:one",
          )?.status,
          "pending",
        );
        assert.deepEqual(requeued.thread.starredMessageIds, [unchangedId]);
        yield* promote("one", "promote-one-again");
        yield* worker.drain();
        assert.deepEqual(steered, ["one", "two", "one"]);
        assert.lengthOf(started, 1);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          final.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:remaining")],
        );
        for (const text of ["one", "two"]) {
          const items = final.turnItems.filter(
            (item) => item.type === "user_message" && item.messageId === `message:${text}`,
          );
          assert.lengthOf(items, 1);
          assert.equal(items[0]?.status, "completed");
        }
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a message queued when send now races with a running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-queued-race");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.find((run) => run.status === "queued")!;
        const error = yield* orchestrator
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("send-now"),
            threadId,
            runId: queued.id,
          })
          .pipe(Effect.flip);
        yield* worker.drain();
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(started.length, 1);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.runs, before.runs);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #19210 a provider that can restart the turn must still steer, since restarting ends its native subagents
it.effect(
  "steers a changed turn-scoped selection into a running turn the provider could restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "steering-selection-change",
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("preserves a queued message's model options when promoting it to a steer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-queued-selection",
        true,
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const queuedSelection = {
          ...runSelection,
          options: [{ id: "effort", value: "medium" }],
        };
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued with medium effort",
          attachments: [],
          modelSelection: queuedSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.find((run) => run.status === "queued")!;
        assert.deepEqual(queued.modelSelection, queuedSelection);
        assert.deepEqual(before.thread.modelSelection, runSelection);

        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queued.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["queued with medium effort"]);
        assert.lengthOf(started, 1);
        assert.deepEqual(after.thread.modelSelection, queuedSelection);
        assert.deepEqual(after.runs[0]?.modelSelection, runSelection);
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "cancelled");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([false, true])(
  "a fresh managed send that loses to archive only replays an already accepted send (%s)",
  (alreadyAccepted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, createThread } = yield* nextTurnSelectionHarness(
          "managed-send-archive",
          true,
        );
        const management = ThreadManagement.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        );
        const files = ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-archive-attachment-",
        }).pipe(
          Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* createThread;
          const fs = yield* FileSystem.FileSystem;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const contents = "Pending document";
          const extracted = "Extracted text";
          const upload: ChatAttachment = {
            type: "file",
            id: ChatAttachmentId.make(createPendingAttachmentId("docx")),
            name: "notes.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: contents.length,
          };
          const pathOf = (attachment: ChatAttachment) => {
            const path = resolveAttachmentPath({ attachmentsDir, attachment });
            assert.isNotNull(path);
            return path;
          };
          const pendingPath = pathOf(upload);
          yield* fs.writeFileString(pendingPath, contents);
          yield* fs.writeFileString(pendingPath + ".txt", extracted);
          const expectContents = (path: string) =>
            Effect.gen(function* () {
              assert.equal(yield* fs.readFileString(path), contents);
              assert.equal(yield* fs.readFileString(path + ".txt"), extracted);
            });
          const input = {
            threadId,
            projectId: ProjectId.make("project:managed-send-archive"),
            commandId: CommandId.make("fresh-after-archive"),
            messageId: MessageId.make("fresh-after-archive"),
            mode: "queue" as const,
            text: "Run next",
            attachments: [upload],
            createdBy: "agent" as const,
            creationSource: "mcp" as const,
          };
          const reached = yield* Deferred.make<ChatAttachment>();
          const proceed = yield* Deferred.make<void>();
          const dispatch = orchestrator.dispatch;
          let pauseFirst = true;
          using _pause = vi.spyOn(orchestrator, "dispatch").mockImplementation((command) => {
            if (
              command.type !== "message.dispatch" ||
              command.commandId !== input.commandId ||
              !pauseFirst
            )
              return dispatch(command);
            pauseFirst = false;
            return Deferred.succeed(reached, command.attachments[0]!).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(dispatch(command)),
            );
          });
          const sending = yield* ThreadMessageIntake.sendToThread(input).pipe(
            Effect.result,
            Effect.forkChild,
          );
          const firstCopy = pathOf(yield* Deferred.await(reached));
          assert.notEqual(firstCopy, pendingPath);
          yield* expectContents(firstCopy);
          const winner = alreadyAccepted
            ? yield* ThreadMessageIntake.sendToThread(input)
            : undefined;
          if (winner !== undefined) {
            const completedAt = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("winning-send-completed"),
                  type: "run.updated",
                  threadId,
                  runId: winner.run.id,
                  occurredAt: completedAt,
                  payload: { ...winner.run, status: "completed", completedAt },
                },
              ],
            });
          }
          yield* threads.dispatch({
            type: "thread.archive",
            threadId,
            commandId: CommandId.make("archive-winning-race"),
          });
          yield* Deferred.succeed(proceed, undefined);
          const result = yield* Fiber.join(sending);
          assert.isFalse(yield* fs.exists(firstCopy));
          assert.isFalse(yield* fs.exists(firstCopy + ".txt"));
          yield* expectContents(pendingPath);
          if (winner !== undefined) {
            assert.ok(Result.isSuccess(result));
            assert.isTrue(result.success.dispatch.replayed);
            assert.equal(result.success.run.id, winner.run.id);
            assert.deepEqual(result.success.message.attachments, winner.message.attachments);
            yield* expectContents(pathOf(winner.message.attachments[0]!));
            return;
          }
          assert.ok(Result.isFailure(result));
          assert.equal(result.failure._tag, "ThreadManagementThreadArchivedError");
          assert.isUndefined(yield* threads.acceptedCommandSequence(input.commandId));
          assert.isFalse(
            (yield* threads.getThreadProjection(threadId)).messages.some(
              (message) => message.id === input.messageId,
            ),
          );
          yield* threads.dispatch({
            type: "thread.unarchive",
            threadId,
            commandId: CommandId.make("unarchive-and-retry"),
          });
          const accepted = yield* ThreadMessageIntake.sendToThread(input);
          assert.equal(accepted.message.id, input.messageId);
          const storedPath = pathOf(accepted.message.attachments[0]!);
          assert.notEqual(storedPath, pendingPath);
          yield* expectContents(storedPath);
          const keptFiles = (yield* fs.readDirectory(attachmentsDir)).toSorted();
          assert.isTrue((yield* ThreadMessageIntake.sendToThread(input)).dispatch.replayed);
          assert.deepEqual((yield* fs.readDirectory(attachmentsDir)).toSorted(), keptFiles);
          yield* expectContents(pendingPath);
        }).pipe(Effect.provide(Layer.mergeAll(management, files)));
      }),
    ),
);

it.effect.each(["steer", "restart"] as const)(
  "an accepted %s send replays after its run settles",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "receipt-after-settle",
          true,
        );
        const management = ThreadManagement.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        );
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const threadId = yield* startFirstTurn;
          const [run] = (yield* threads.getThreadProjection(threadId)).runs;
          assert.isDefined(run);
          assert(typeof run.demandId === "string");
          const input = {
            mode,
            projectId: ProjectId.make("project:receipt-after-settle"),
            threadId,
            commandId: CommandId.make("ordinary-send"),
            messageId: MessageId.make("ordinary-send"),
            text: "Continue",
            attachments: [],
            demandId: run.demandId,
            createdBy: "agent" as const,
            creationSource: "mcp" as const,
          };
          assert.isUndefined(yield* threads.acceptedCommandSequence(input.commandId));
          const first = yield* threads.sendToThread(input);
          assert.equal(
            yield* threads.acceptedCommandSequence(input.commandId),
            first.dispatch.sequence,
          );
          assert.equal(first.delivery, mode === "restart" ? "restarted" : "steered");
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const snapshot = yield* threads.getThreadProjection(threadId);
          yield* sink.write({
            events: snapshot.runs.map((row) => ({
              id: EventId.make(`settled:${row.id}`),
              type: "run.updated",
              threadId,
              runId: row.id,
              occurredAt: now,
              payload: { ...row, status: "completed", completedAt: now },
            })),
          });
          const retry = yield* threads.sendToThread(input);
          assert.equal(retry.delivery, first.delivery);
          assert.equal(retry.run.id, first.run.id);
          assert.isTrue(retry.dispatch.replayed);
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive-after-completion"),
            threadId,
          });
          const archived = yield* threads.sendToThread(input);
          assert.equal(archived.delivery, first.delivery);
          assert.equal(archived.run.id, first.run.id);
          assert.isTrue(archived.dispatch.replayed);
          const fresh = yield* Effect.flip(
            threads.sendToThread({
              ...input,
              commandId: CommandId.make("new-after-archive"),
              messageId: MessageId.make("new-after-archive"),
            }),
          );
          assert.equal(fresh._tag, "ThreadManagementThreadArchivedError");
          assert.lengthOf(
            (yield* threads.getThreadProjection(threadId)).messages.filter(
              (row) => row.id === input.messageId,
            ),
            1,
          );
        }).pipe(Effect.provide(management));
      }),
    ),
);

it.effect("starts a stop-and-send that arrives after the provider turn completed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, interrupted, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("restart-after-turn-completed", true);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turnCompleted = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" && event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Fiber.join(turnCompleted);

        // The composer still showed the turn running when the user chose Stop and send.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "late stop and send",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "restart",
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:restart"));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a steer the provider can only run as its own turn behind the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn, releaseSteer } =
        yield* nextTurnSelectionHarness("steering-requires-new-turn", false, true);
      yield* Deferred.succeed(releaseSteer, undefined);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const steerId = MessageId.make("message:skill");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-skill"),
          threadId,
          messageId: steerId,
          text: "$zebra-probe",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const queued = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 1);
        assert.equal(queued.runs.find((run) => run.id === first.runId)?.status, "running");
        const next = queued.runs.find((run) => run.userMessageId === steerId);
        assert.equal(next?.status, "queued");
        assert.equal(queued.messages.find((message) => message.id === steerId)?.runId, next?.id);

        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = queued.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, steerId);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { queued: true, settled: false, label: "behind a queued message" },
  { queued: false, settled: false, label: "alone" },
  { queued: false, settled: true, label: "after the stopped turn ended" },
])("holds a steer that raced Stop and has to wait for a new turn, $label", ({ queued, settled }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn, steerEntered, releaseSteer } =
        yield* nextTurnSelectionHarness("steering-requires-new-turn-stop", false, true);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const skillId = MessageId.make("message:skill");
        const laterId = MessageId.make("message:later");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer-skill"),
          threadId,
          messageId: skillId,
          text: "$zebra-probe",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        if (queued) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-later"),
            threadId,
            messageId: laterId,
            text: "later",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const steering = yield* worker.runOnce().pipe(Effect.forkScoped);
        yield* Deferred.await(steerEntered);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });
        if (settled) {
          const interrupted = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === first.runId &&
                event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "interrupted", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: first.runOrdinal,
            status: "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(interrupted);
        }
        yield* Deferred.succeed(releaseSteer, undefined);
        yield* Fiber.join(steering);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 1, "nothing may start after Stop");
        const waiting = queued ? [skillId, laterId] : [skillId];
        for (const messageId of waiting) {
          const run = projection.runs.find((candidate) => candidate.userMessageId === messageId);
          assert.equal(run?.status, "queued");
          assert.isTrue(run?.queueHeld, `${messageId} must stay held after Stop`);
        }
        assert.deepEqual(
          queuedRunsInDeliveryOrder(projection).map((run) => run.userMessageId),
          waiting,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("sends a promoted message first when it cannot steer the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, releaseSteer } =
        yield* nextTurnSelectionHarness("steering-requires-new-turn-promote", false, true);
      yield* Deferred.succeed(releaseSteer, undefined);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const earlierId = MessageId.make("message:earlier");
        const skillId = MessageId.make("message:skill");
        for (const [messageId, text] of [
          [earlierId, "earlier"],
          [skillId, "$zebra-probe"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queue-${text}`),
            threadId,
            messageId,
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const queued = yield* orchestrator.getThreadProjection(threadId);
        const skillRun = queued.runs.find((run) => run.userMessageId === skillId)!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote-skill"),
          threadId,
          queuedRunId: skillRun.id,
          targetRunId: first.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.deepEqual(
          queuedRunsInDeliveryOrder(projection).map((run) => run.userMessageId),
          [skillId, earlierId],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #26695 cancelling a Copilot prompt to steer it kills its background agents
it.effect("queues a steer until the turn ends when the provider cannot steer it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, interrupted, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-unsupported", false, false, false);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const messageId = MessageId.make("message:steer");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "follow up",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "steer",
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 1);
        assert.equal(held.runs.find((run) => run.id === first.runId)?.status, "running");
        const queued = held.runs.find((run) => run.userMessageId === messageId);
        assert.equal(queued?.status, "queued");

        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = held.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        assert.deepEqual(interrupted, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.runId, queued?.id);
        assert.equal(started[1]?.message.text, "follow up");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// Codex flushes held drafts after the final answer; reserve their pre-steer position before turn end.
it.effect("keeps a held commentary draft before the steer when turn end flushes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-held-draft");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        const assistantItem = (id: string, text: string, streaming: boolean) =>
          ({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(id),
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: now,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming,
            },
          }) satisfies ProviderAdapter.ProviderAdapterV2Event;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", true));
        const commentaryWritten = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === "commentary",
        );
        yield* Queue.offer(events, assistantItem("commentary", "Checking the popover.", false));
        yield* Fiber.join(commentaryWritten);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "fix the popover",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, assistantItem("answer", "All fixed.", false));
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", false));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message"
              ? [String(item.messageId)]
              : item.type === "assistant_message"
                ? [String(item.id)]
                : [],
          );
        assert.deepEqual(items, [
          "message:first",
          "draft",
          "commentary",
          "message:steer",
          "answer",
        ]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("steers a promoted queued message with the selection it was queued with", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-queued-selection",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, ["queued"]);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("marks the model switch on a promoted message that restarts the turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "promote-restart-switch",
        true,
        false,
        false,
      );
      const otherSelection = { ...runSelection, model: "other-model" };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: otherSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: queuedRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        const promoted = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
          (item) => item.type === "user_message" && item.messageId === "message:queued",
        );
        assert.deepEqual(promoted?.type === "user_message" ? promoted.modelSwitch : undefined, {
          from: runSelection,
          to: otherSelection,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message queued when promoted into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });

        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(promoteError._tag, "OrchestratorDispatchError");
        assert.deepEqual(steered, []);
        const queued = projection.runs.find((run) => run.id === queuedRun.id);
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const interruptReached = yield* Deferred.make<void>();
      const releaseInterrupt = yield* Deferred.make<void>();
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "plain-send-after-stop",
        false,
        false,
        true,
        Deferred.succeed(interruptReached, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInterrupt)),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        // Once the stop settles, the run-update reactor promotes the queue on
        // its own fiber, so read the queue while the provider is still stopping.
        const draining = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(interruptReached);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
        yield* Deferred.succeed(releaseInterrupt, undefined);
        yield* Fiber.join(draining);
        assert.deepEqual(steered, []);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

const goalHarness = Effect.fn("goalHarness")(function* (name: string) {
  const harness = yield* nextTurnSelectionHarness(name);
  const send = (id: string, text: string, delivery: "queue" | "auto") =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(`thread:${name}`),
        messageId: MessageId.make(`message:${id}`),
        text,
        attachments: [],
        modelSelection: runSelection,
        ...(delivery === "queue"
          ? { dispatchMode: { type: "queue_after_active" } }
          : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
        createdBy: "user",
        creationSource: "web",
      });
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      const textOf = (run: (typeof projection.runs)[number]) =>
        projection.messages.find((message) => message.id === run.userMessageId)?.text;
      return {
        queue: projection.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
          .map(textOf),
        started: harness.started.map((turn) => turn.message.text),
        stopRequested: projection.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" && item.runId === harness.started[0]?.runId,
        ),
      };
    });
  return { ...harness, send, read };
});

it.effect("a web on-return compaction and its owner message share one demand", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { layer, startFirstTurn } = yield* nextTurnSelectionHarness("compact-owner");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = yield* startFirstTurn;
        const trigger = MessageId.make("owner-prompt");
        for (const [id, text] of [
          ["auto-compact", "/compact"],
          [trigger, "Continue"],
          ["manual-compact", "/compact"],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            ...(id === "auto-compact"
              ? { idleCompaction: "onReturn" as const, compactionForMessageId: trigger }
              : {}),
            dispatchMode: { type: "queue_after_active" },
          });
        }
        const { runs } = yield* orchestrator.getThreadProjection(threadId);
        const owner = runs.find((run) => run.userMessageId === trigger)?.demandId;
        assert.isString(owner);
        assert.equal(runs.find((run) => run.userMessageId === "auto-compact")?.demandId, owner);
        assert.notEqual(
          runs.find((run) => run.userMessageId === "manual-compact")?.demandId,
          owner,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("stops the running turn and starts a goal sent into it next", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-steer");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();
        const runs = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
          .runs;
        const goal = runs.find((run) => run.userMessageId === MessageId.make("message:goal"));
        assert.isString(goal?.demandId);
        assert.notEqual(goal?.demandId, runs[0]!.demandId);

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal all tests pass"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a goal clear without stopping work when no goal drives it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-clear");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued", "/goal clear"],
          started: ["first"],
          stopRequested: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("promotes a queued goal by stopping the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } =
        yield* goalHarness("goal-promote");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal ship it", "queue");
        const goalRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("message:goal"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: goalRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal ship it"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["next", "/goal ship it"])(
  "promoting %s into a compaction stops it and sends it next",
  (promoted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, layer, send, read, started, steered, startFirstTurn } = yield* goalHarness(
          `compaction-promote-${promoted.length}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("compact", "/compact", "queue");
          yield* send("queued", "queued", "queue");
          yield* send("next", promoted, "queue");
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === started[0]!.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const compacting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.runAttemptId !== started[0]!.attemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* Fiber.join(compacting);
          const compactRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:compact"),
          )!;
          const nextRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:next"),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: nextRun.id,
            targetRunId: compactRun.id,
          });
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === compactRun.id,
            ),
          );
          assert.deepEqual((yield* read(threadId)).queue, ["queued"]);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "/compact", promoted],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("stops a turn that is still starting when a goal is sent into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, send, started } = yield* goalHarness("goal-during-start");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:goal-during-start");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:goal-during-start"),
          title: "Goal during start",
          modelSelection: runSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        // The stopped run's end starts the queue, which then needs one more drain.
        const goalStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* send("first", "first", "auto");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();
        yield* Fiber.join(goalStarting);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const statusOf = (text: string) =>
          projection.runs.find(
            (run) =>
              projection.messages.find((message) => message.id === run.userMessageId)?.text ===
              text,
          )?.status;
        assert.equal(statusOf("first"), "interrupted");
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["/goal all tests pass"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("stops the running turn when a goal clear ends the goal driving it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, startFirstTurn, send, read, steered } =
        yield* goalHarness("goal-clear-active");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const providerThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const goalSeen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-thread.updated" && event.payload.goal?.status === "active",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: {
            ...providerThread,
            goal: { objective: "all tests pass", status: "active" },
          },
        });
        yield* Fiber.join(goalSeen);
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: [],
          started: ["first", "/goal clear"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("a side chat that opens with /goal gets its context on the next question", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, started, startFirstTurn } = yield* goalHarness("side-chat-goal");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const parentId = yield* startFirstTurn;
        const sideChatId = ThreadId.make("thread:side-chat-goal-child");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("side-chat"),
          sourceThreadId: parentId,
          targetThreadId: sideChatId,
          sourcePoint: { type: "latest_stable" },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        const ask = (id: string, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId: sideChatId,
            messageId: MessageId.make(`message:${id}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
        const sideChatEvent = (matches: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter((event) => event.threadId === sideChatId && matches(event)),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
        const running = yield* sideChatEvent(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        const settled = yield* sideChatEvent(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* ask("goal", "/goal clear");
        yield* worker.drain();
        yield* Fiber.join(running);
        const turn = (yield* orchestrator.getThreadProjection(sideChatId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: started[1]!.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* ask("question", "What is the main thread doing?");
        yield* worker.drain();

        const [first, goal, question] = started.map((turn) => turn.message.text);
        assert.deepEqual([first, goal], ["first", "/goal clear"]);
        assert.include(question, "You are in a side chat beside the main thread.");
        assert.include(question, "- User: first");
        assert.isTrue(question?.endsWith("What is the main thread doing?"));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect(
  "agent auto message steers an active run on the same demand and queues behind a different demand",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "agent-demand-steer",
          false,
          false,
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const activeRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          assert.isString(activeRun.demandId);

          // Same demand steers the live run directly.
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("agent-same-demand-auto"),
            threadId,
            messageId: MessageId.make("message:agent-same-demand"),
            text: "Add this detail to the current task",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
            demandId: activeRun.demandId ?? null,
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          assert.deepEqual(steered, ["Add this detail to the current task"]);
          assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);

          // A different demand queues behind the active run so demands never mix.
          const otherDemand = `demand:${"f".repeat(64)}`;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("agent-other-demand-auto"),
            threadId,
            messageId: MessageId.make("message:agent-other-demand"),
            text: "Unrelated request",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
            demandId: otherDemand,
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* worker.drain();
          assert.deepEqual(steered, ["Add this detail to the current task"]);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs.length, 2);
          assert.equal(projection.runs[1]!.status, "queued");
          assert.equal(projection.runs[1]!.demandId, otherDemand);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
