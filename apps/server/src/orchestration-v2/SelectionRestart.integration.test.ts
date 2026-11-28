import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts/baseSchemas";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ServerProvider } from "@t3tools/contracts/server";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { runLiftsScope } from "./AccountRouting.ts";
import {
  backgroundWorkStoppedNoticeId,
  cancelledRosterTaskWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";
import { limitFailoverCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";

const codexDriver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-restart-test");
const initialSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-a",
} satisfies ModelSelection;
const replacementSelection = {
  instanceId: providerInstanceId,
  model: "restart-model-b",
} satisfies ModelSelection;
const seedSelection = {
  instanceId: providerInstanceId,
  model: "seed-model",
} satisfies ModelSelection;
const modelSwitches = (projection: OrchestrationV2ThreadProjection) =>
  projection.turnItems.flatMap((item) =>
    item.type === "user_message" && item.modelSwitch !== undefined ? [item.modelSwitch] : [],
  );
const pooledCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const exclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
  },
};

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: ProviderTurnId;
}

interface RestartAdapterState {
  readonly activeTurn: ActiveTurn | null;
  readonly opened: ReadonlyArray<{
    readonly model: string | null;
    readonly cwd: string | null;
  }>;
  readonly started: ReadonlyArray<{
    readonly model: string;
    readonly text: string;
    readonly cwd: string | null;
    readonly attemptId: string;
  }>;
  readonly closedSessionCount: number;
  readonly failedReplacementOpen: boolean;
}

function makeRestartAdapter(
  state: Ref.Ref<RestartAdapterState>,
  sessionCapabilities: OrchestrationV2ProviderCapabilities = pooledCapabilities,
  providerInstanceId = initialSelection.instanceId,
  {
    driver = codexDriver,
    heldUntil,
    completeHeldTurn,
    liftHold,
    lostOnInterrupt,
  }: {
    readonly driver?: ProviderDriverKind;
    readonly heldUntil?: DateTime.Utc;
    readonly completeHeldTurn?: Deferred.Deferred<Effect.Effect<void>>;
    readonly liftHold?: Deferred.Deferred<Effect.Effect<void>>;
    readonly lostOnInterrupt?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  } = {},
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(sessionCapabilities),
    planSelectionTransition: ({ current, target }) =>
      Effect.succeed(
        current.model === target.model
          ? ({ type: "apply_on_next_turn" } as const)
          : ({ type: "restart_session" } as const),
      ),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const failThisOpen = yield* Ref.modify(state, (current) => {
          const shouldFail =
            sessionInput.modelSelection.model === replacementSelection.model &&
            !current.failedReplacementOpen;
          return [
            shouldFail,
            {
              ...current,
              failedReplacementOpen: current.failedReplacementOpen || shouldFail,
              opened: [
                ...current.opened,
                {
                  model: sessionInput.modelSelection.model,
                  cwd: sessionInput.runtimePolicy.cwd,
                },
              ],
            },
          ] as const;
        });
        if (failThisOpen) {
          return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: sessionInput.providerSessionId,
            cause: "simulated replacement open failure",
          });
        }

        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: sessionCapabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        yield* Effect.addFinalizer(() =>
          Ref.update(state, (current) => ({
            ...current,
            closedSessionCount: current.closedSessionCount + 1,
          })),
        );

        const publishTerminal = (
          active: ActiveTurn,
          status: "completed" | "interrupted",
          beforeTerminal?: ProviderAdapter.ProviderAdapterV2Event,
        ) =>
          Effect.gen(function* () {
            const occurredAt = yield* DateTime.now;
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: active.providerTurnId,
                providerThreadId: active.input.providerThread.id,
                nodeId: active.input.rootNodeId,
                runAttemptId: active.input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${active.providerTurnId}`,
                  strength: "strong",
                },
                ordinal: active.input.providerTurnOrdinal,
                status,
                startedAt: occurredAt,
                completedAt: occurredAt,
              },
            });
            if (beforeTerminal !== undefined) yield* Queue.offer(events, beforeTerminal);
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: active.input.providerThread.id,
              providerTurnId: active.providerTurnId,
              runOrdinal: active.input.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
          });

        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${driver}:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(state, (current) => ({
                ...current,
                started: [
                  ...current.started,
                  {
                    model: input.modelSelection.model,
                    text: input.message.text,
                    cwd: input.runtimePolicy.cwd,
                    attemptId: input.attemptId,
                  },
                ],
              }));
              const active = {
                input,
                providerTurnId: ProviderTurnId.make(`provider-turn:${input.attemptId}`),
              } satisfies ActiveTurn;
              if (input.modelSelection.model === initialSelection.model) {
                const occurredAt = yield* DateTime.now;
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: active }));
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: active.providerTurnId,
                    providerThreadId: input.providerThread.id,
                    nodeId: input.rootNodeId,
                    runAttemptId: input.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${active.providerTurnId}`,
                      strength: "strong",
                    },
                    ordinal: input.providerTurnOrdinal,
                    status: "running",
                    startedAt: occurredAt,
                    completedAt: null,
                  },
                });
                if (heldUntil !== undefined && (yield* Ref.get(state)).started.length === 1) {
                  const retryItem = makeProviderRetryTurnItem({
                    driver,
                    threadId: input.threadId,
                    runId: input.runId,
                    nodeId: input.rootNodeId,
                    providerThreadId: input.providerThread.id,
                    providerTurnId: active.providerTurnId,
                    itemOrdinal: 1,
                    failure: makeProviderFailure({
                      class: "usage_limit",
                      message: "Claude API rate limit.",
                      code: "api_error_429",
                      retryable: true,
                      resetAt: DateTime.formatIso(heldUntil),
                    }),
                    retry: { attempt: 1, maxAttempts: 10, retryDelayMs: 300_000 },
                    status: "running",
                    startedAt: occurredAt,
                    updatedAt: occurredAt,
                  });
                  yield* Queue.offer(events, {
                    type: "turn_item.updated",
                    driver,
                    turnItem: retryItem,
                  });
                  if (liftHold !== undefined) {
                    yield* Deferred.succeed(
                      liftHold,
                      Effect.gen(function* () {
                        const updatedAt = yield* DateTime.now;
                        yield* Queue.offer(events, {
                          type: "turn_item.updated",
                          driver,
                          turnItem: {
                            ...retryItem,
                            status: "completed",
                            completedAt: updatedAt,
                            updatedAt,
                          },
                        });
                      }),
                    );
                  }
                  if (completeHeldTurn !== undefined) {
                    yield* Deferred.succeed(completeHeldTurn, publishTerminal(active, "completed"));
                  }
                }
                return;
              }
              yield* publishTerminal(active, "completed");
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Effect.gen(function* () {
              const active = (yield* Ref.get(state)).activeTurn;
              if (active !== null) {
                const updatedAt = yield* DateTime.now;
                const providerThread = {
                  ...active.input.providerThread,
                  status: "idle" as const,
                  updatedAt,
                };
                if (lostOnInterrupt === undefined) {
                  yield* Queue.offer(events, {
                    type: "provider_thread.updated",
                    driver,
                    providerThread,
                  });
                  yield* publishTerminal(active, "interrupted");
                } else {
                  // After the turn's own status, before its terminal.
                  yield* publishTerminal(active, "interrupted", {
                    type: "provider_thread.updated",
                    driver,
                    providerThread: { ...providerThread, pendingBackgroundTasks: [] },
                    lostBackgroundTasks: lostOnInterrupt,
                    lostBackgroundTasksCause: "stopped",
                  });
                }
                yield* Ref.update(state, (current) => ({ ...current, activeTurn: null }));
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live("retries a failed selection restart session open before completing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-restart-lifecycle");
      const threadId = ThreadId.make("thread:selection-restart-lifecycle");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const layerRegistry = ProviderAdapterRegistry.layerSingle(makeRestartAdapter(state));

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:create"),
          threadId,
          projectId: ProjectId.make("project:selection-restart"),
          title: "Selection restart",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const running = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence({ threadId }),
          })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:first"),
          threadId,
          messageId: MessageId.make("message:selection-restart:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(running);
        yield* worker.drain();
        const activeProjection = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(activeProjection.providerTurns.some((turn) => turn.status === "running"));
        const activeRunId = activeProjection.runs[0]?.id;
        if (activeRunId === undefined) {
          return yield* Effect.die("active restart test run is missing");
        }

        const completed = yield* eventSink
          .stream({
            threadId,
            afterSequence: yield* eventSink.latestSequence({ threadId }),
          })
          .pipe(
            Stream.map((stored) => stored.event),
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart:second"),
          threadId,
          messageId: MessageId.make("message:selection-restart:second"),
          text: "second",
          attachments: [],
          modelSelection: replacementSelection,
          dispatchMode: { type: "restart_active", targetRunId: activeRunId },
        });
        yield* Fiber.join(completed);
        yield* worker.drain();
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          captured: yield* Ref.get(state),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "selection-restart-lifecycle" },
            layerRegistry,
          ),
        ),
      );
      const { projection, captured } = result;

      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.attempts, 2);
      assert.deepEqual(
        projection.attempts.map((attempt) => attempt.status),
        ["superseded", "completed"],
      );
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.status),
        ["interrupted", "completed"],
      );
      assert.isFalse(
        projection.turnItems.some(
          (item) => item.type === "run_interrupt_request" || item.type === "run_interrupt_result",
        ),
        "selection restart supersede must not project hard-Stop interrupt items",
      );
      assert.equal(projection.runs.at(-1)?.modelSelection.model, replacementSelection.model);
      assert.deepEqual(modelSwitches(projection), [
        { from: initialSelection, to: replacementSelection },
      ]);
      assert.equal(projection.runs.at(-1)?.status, "completed");
      assert.isTrue(captured.failedReplacementOpen);
      assert.equal(captured.closedSessionCount, 0);
      assert.deepEqual(
        captured.opened.map((open) => [open.model, open.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.deepEqual(
        captured.started.map((turn) => [turn.model, turn.cwd]),
        [
          [initialSelection.model, cwd],
          [replacementSelection.model, cwd],
        ],
      );
      assert.notEqual(
        projection.providerSessions[0]?.id,
        projection.providerThreads[0]?.providerSessionId,
      );
      assert.equal(
        projection.providerThreads[0]?.providerSessionId,
        projection.providerSessions.find((session) => session.model === replacementSelection.model)
          ?.id,
      );
    }),
  ),
);

it.live("Stop during a restart interrupts the turn the restart could not stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("selection-restart-stop");
      const threadId = ThreadId.make("thread:selection-restart-stop");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: false,
      });
      const base = makeRestartAdapter(state);
      // A wedged provider ignores the restart's soft cancel; only Stop ends its turn.
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        ...base,
        openSession: (input) =>
          base.openSession(input).pipe(
            Effect.map((session) => ({
              ...session,
              interruptTurn: (interrupt: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
                interrupt.requestRuntimeRestart === true
                  ? session.interruptTurn(interrupt)
                  : Effect.never,
            })),
          ),
      };

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const running = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart-stop:create"),
          threadId,
          projectId: ProjectId.make("project:selection-restart-stop"),
          title: "Stop during restart",
          modelSelection: initialSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart-stop:first"),
          threadId,
          messageId: MessageId.make("message:selection-restart-stop:first"),
          text: "first",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:selection-restart-stop:steer"),
          threadId,
          messageId: MessageId.make("message:selection-restart-stop:steer"),
          text: "Are you still going?",
          attachments: [],
          modelSelection: initialSelection,
          dispatchMode: { type: "restart_active", targetRunId: runId },
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:selection-restart-stop:stop"),
          threadId,
          runId,
        });
        yield* worker.drain();
        return {
          projection: yield* orchestrator.getThreadProjection(threadId),
          captured: yield* Ref.get(state),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "selection-restart-stop" },
            ProviderAdapterRegistry.layerSingle(adapter),
          ),
        ),
      );

      assert.isNull(result.captured.activeTurn);
      assert.lengthOf(result.captured.started, 1);
      assert.equal(result.projection.runs[0]?.status, "interrupted");
      assert.deepEqual(
        result.projection.providerTurns.map((turn) => turn.status),
        ["interrupted"],
      );
    }),
  ),
);

it.live(
  "restarts the live session on a model change when a newer stopped session record exists",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "selection-restart-dead-stopped";
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        const layerRegistry = ProviderAdapterRegistry.layerSingle(
          makeRestartAdapter(state, exclusiveCapabilities),
        );

        const result = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const dispatch = (step: string, modelSelection: ModelSelection) =>
            Effect.gen(function* () {
              const terminal = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event) => event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`${name}:${step}`),
                threadId,
                messageId: MessageId.make(`${name}:${step}`),
                text: step,
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              });
              yield* worker.drain();
              yield* Fiber.join(terminal);
              yield* worker.drain();
              return yield* orchestrator.getThreadProjection(threadId);
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: seedSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          const first = yield* dispatch("first", seedSelection);
          const liveSession = first.providerSessions.find(
            (session) => session.status !== "stopped" && session.status !== "error",
          );
          assert.isDefined(liveSession);

          const deadAt = yield* DateTime.now;
          const deadSession: OrchestrationV2ProviderSession = {
            id: ProviderSessionId.make(`session:${name}:dead`),
            driver: codexDriver,
            providerInstanceId,
            status: "ready",
            cwd,
            model: seedSelection.model,
            capabilities: exclusiveCapabilities,
            createdAt: deadAt,
            updatedAt: deadAt,
            lastError: null,
          };
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`event:${name}:dead-attached`),
                type: "provider-session.attached",
                threadId,
                driver: codexDriver,
                providerInstanceId,
                occurredAt: deadAt,
                payload: deadSession,
              },
              {
                id: EventId.make(`event:${name}:dead-updated`),
                type: "provider-session.updated",
                threadId,
                driver: codexDriver,
                providerInstanceId,
                occurredAt: deadAt,
                payload: {
                  ...deadSession,
                  status: "stopped",
                  updatedAt: deadAt,
                  lastError: null,
                },
              },
            ],
          });

          const switchCommandId = CommandId.make(`${name}:switch`);
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: switchCommandId,
            threadId,
            modelSelection: replacementSelection,
          });
          yield* worker.drain();
          const storedSwitchEvents = yield* eventSink
            .readByCommandId({ commandId: switchCommandId })
            .pipe(Stream.runCollect);
          const detachedSessionIds = [...storedSwitchEvents].flatMap((stored) =>
            stored.event.type === "provider-session.detached"
              ? [stored.event.payload.providerSessionId]
              : [],
          );

          const second = yield* dispatch("second", replacementSelection);
          return {
            projection: second,
            captured: yield* Ref.get(state),
            liveSessionId: liveSession.id,
            detachedSessionIds,
          };
        }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name }, layerRegistry)));

        const { projection, captured } = result;
        assert.lengthOf(projection.runs, 2);
        assert.equal(projection.runs[1]?.modelSelection.model, replacementSelection.model);
        assert.deepEqual(modelSwitches(projection), [
          { from: seedSelection, to: replacementSelection },
        ]);
        assert.deepEqual(result.detachedSessionIds, [result.liveSessionId]);
        assert.equal(captured.closedSessionCount, 1);
        assert.deepEqual(
          captured.opened.map((open) => open.model),
          [seedSelection.model, replacementSelection.model],
        );
        assert.deepEqual(
          captured.started.map((turn) => turn.model),
          [seedSelection.model, replacementSelection.model],
        );
        const servingSession = projection.providerSessions.find(
          (session) =>
            session.id ===
            projection.providerThreads.find(
              (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
            )?.providerSessionId,
        );
        assert.equal(servingSession?.model, replacementSelection.model);
      }),
    ),
);

// "background-work" is "idle" with work the first account's process still runs for the chat.
// "queued-background-work" moves the chat with a message queued behind the turn that started it.
it.live.each([
  "active",
  "idle",
  "background-work",
  "queued-background-work",
  "selection-command",
  "pooled",
  "separate-home",
] as const)("preserves native history only for compatible account switches (%s)", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = `shared-home-${mode}`;
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const targetId = ProviderInstanceId.make("codex-shadow-account");
      const state = yield* Ref.make<RestartAdapterState>({
        activeTurn: null,
        opened: [],
        started: [],
        closedSessionCount: 0,
        failedReplacementOpen: true,
      });
      const resumes: Array<{
        instanceId: ProviderInstanceId;
        nativeId: string | null | undefined;
      }> = [];
      const messages: string[] = [];
      const backgroundWork = mode === "background-work" || mode === "queued-background-work";
      const lostWork = [{ taskId: "build", kind: "background_task" }] as const;
      const scope = yield* Effect.scope;
      const heldTurnMayComplete = yield* Deferred.make<void>();
      const capabilities = mode === "pooled" ? pooledCapabilities : exclusiveCapabilities;
      const adapters = [providerInstanceId, targetId].map((instanceId) => {
        const base = makeRestartAdapter(state, capabilities, instanceId);
        return {
          ...base,
          openSession: (input) =>
            Effect.all([
              base.openSession(input),
              Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>(),
            ]).pipe(
              Effect.map(([session, reported]) => ({
                ...session,
                events: Stream.merge(session.events, Stream.fromQueue(reported)),
                ...(backgroundWork
                  ? {
                      backgroundTasksEndWithProcess: true as const,
                      hasPendingBackgroundWorkForThread: () =>
                        Effect.succeed(instanceId === providerInstanceId),
                    }
                  : {}),
                resumeThread: (input) =>
                  Effect.gen(function* () {
                    resumes.push({
                      instanceId,
                      nativeId: input.providerThread.nativeThreadRef?.nativeId,
                    });
                    return yield* session.resumeThread(input);
                  }),
                startTurn: (input) =>
                  Effect.gen(function* () {
                    messages.push(input.message.text);
                    if (mode !== "queued-background-work" || input.message.text !== "first") {
                      return yield* session.startTurn(input);
                    }
                    // Starts work that outlives the turn, and stays the active turn until a
                    // message is queued behind it.
                    yield* Queue.offer(reported, {
                      type: "provider_thread.updated",
                      driver: codexDriver,
                      providerThread: { ...input.providerThread, pendingBackgroundTasks: lostWork },
                    });
                    yield* Deferred.await(heldTurnMayComplete).pipe(
                      Effect.andThen(session.startTurn(input)),
                      Effect.forkIn(scope),
                    );
                  }),
              })),
            ),
        } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
      });
      const layerRegistry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
        get: (instanceId) =>
          Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
        list: () => Effect.succeed([providerInstanceId, targetId]),
        getMetadata: (instanceId) =>
          Effect.succeed({
            driver: codexDriver,
            continuationKey:
              mode === "separate-home" ? `codex:home:/${instanceId}` : "codex:home:/shared",
            enabled: true,
            capabilities,
          }),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const selection = {
          ...initialSelection,
          model: mode === "active" ? initialSelection.model : "complete",
        };
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${name}:create`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const dispatch = (step: string, modelSelection: ModelSelection, targetRunId?: RunId) =>
          Effect.gen(function* () {
            const held = mode === "queued-background-work" && step === "first";
            const queued = mode === "queued-background-work" && step === "second";
            const terminal = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter((event) =>
                mode === "active" && step === "first"
                  ? event.type === "provider-turn.updated" && event.payload.status === "running"
                  : event.type === "run.updated" &&
                    event.payload.status === (held ? "running" : "completed"),
              ),
              // A queued message completes after the turn it waited behind.
              Stream.take(queued ? 2 : 1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${name}:${step}`),
              threadId,
              messageId: MessageId.make(`${name}:${step}`),
              text: step,
              attachments: [],
              modelSelection,
              dispatchMode: queued
                ? { type: "queue_after_active" }
                : targetRunId === undefined
                  ? { type: "start_immediately" }
                  : { type: "restart_active", targetRunId },
              createdBy: "user",
              creationSource: "web",
            });
            if (queued) yield* Deferred.succeed(heldTurnMayComplete, undefined);
            yield* worker.drain();
            yield* Fiber.join(terminal);
            yield* worker.drain();
            return yield* orchestrator.getThreadProjection(threadId);
          });
        const first = yield* dispatch("first", selection);
        const originalThread = first.providerThreads.find(
          (thread) => thread.id === first.thread.activeProviderThreadId,
        )!;
        const targetSelection = { instanceId: targetId, model: "complete" };
        if (mode === "background-work") {
          const eventSink = yield* EventSink.EventSinkV2;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`event:${name}:roster`),
                type: "provider-thread.updated",
                threadId,
                driver: codexDriver,
                occurredAt: yield* DateTime.now,
                payload: { ...originalThread, pendingBackgroundTasks: lostWork },
              },
            ],
          });
        }
        if (mode === "selection-command") {
          yield* orchestrator.dispatch({
            type: "provider.switch",
            commandId: CommandId.make(`${name}:switch`),
            threadId,
            modelSelection: targetSelection,
          });
          yield* worker.drain();
        }
        const second = yield* dispatch(
          "second",
          targetSelection,
          mode === "active" ? first.runs[0]!.id : undefined,
        );
        const targetThread = second.providerThreads.find(
          (thread) => thread.id === second.thread.activeProviderThreadId,
        )!;
        if (mode === "separate-home") {
          assert.notEqual(targetThread.id, originalThread.id);
          assert.lengthOf(second.contextHandoffs, 1);
          assert.lengthOf(second.contextTransfers, 1);
          assert.isEmpty(resumes);
          assert.notEqual(messages[1], "second");
          return;
        }
        // A queued move resumes the conversation under the second account's own provider thread.
        assert.equal(targetThread.id === originalThread.id, mode !== "queued-background-work");
        assert.deepEqual(targetThread.nativeThreadRef, originalThread.nativeThreadRef);
        assert.equal(targetThread.providerInstanceId, targetId);
        assert.notEqual(targetThread.providerSessionId, originalThread.providerSessionId);
        assert.isEmpty(second.contextHandoffs);
        assert.isEmpty(second.contextTransfers);
        assert.deepEqual(resumes, [
          { instanceId: targetId, nativeId: originalThread.nativeThreadRef?.nativeId },
        ]);
        // The turn that moved the chat is told what the first account's process took with it.
        const secondPrompt = backgroundWork
          ? `${restartCancelledBackgroundWorkNote(lostWork.map(cancelledRosterTaskWork))}\n\nUser message:\nsecond`
          : "second";
        assert.deepEqual(messages, ["first", secondPrompt]);
        if (backgroundWork) {
          assert.deepEqual(targetThread.pendingBackgroundTasks ?? [], []);
          assert.deepEqual(
            second.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", undefined],
            ],
          );
        }
        assert.equal((yield* Ref.get(state)).closedSessionCount, mode === "pooled" ? 0 : 1);
        if (mode === "pooled") {
          assert.isFalse(
            second.providerSessions.some(
              (session) => session.id === originalThread.providerSessionId,
            ),
          );
        }
        const third = yield* dispatch("third", { ...selection, model: "complete" });
        const returnedThread = third.providerThreads.find(
          (thread) => thread.id === third.thread.activeProviderThreadId,
        )!;
        assert.equal(returnedThread.id, targetThread.id);
        assert.deepEqual(returnedThread.nativeThreadRef, originalThread.nativeThreadRef);
        assert.equal(returnedThread.providerInstanceId, providerInstanceId);
        assert.isEmpty(third.contextHandoffs);
        assert.deepEqual(messages, ["first", secondPrompt, "third"]);
      }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name }, layerRegistry)));
    }),
  ),
);

// A restart closes the interrupted turn's process with its background work, and the provider
// reports that work only after the turn's own status, as Claude does.
it.live.each(["earlier-run", "first-run"] as const)(
  "records the background work a restarted turn's process lost and tells it once (%s)",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = `restart-lost-work-${mode}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        const lostWork = [
          { taskId: "build", kind: "background_task", description: "vp run build" },
        ] as const;
        const messages: string[] = [];
        const base = makeRestartAdapter(state, pooledCapabilities, providerInstanceId, {
          lostOnInterrupt: lostWork,
        });
        const adapter = {
          ...base,
          openSession: (input) =>
            base.openSession(input).pipe(
              Effect.map((session) => ({
                ...session,
                startTurn: (turn) =>
                  Effect.sync(() => messages.push(turn.message.text)).pipe(
                    Effect.andThen(session.startTurn(turn)),
                  ),
              })),
            ),
        } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
        const completing = { ...initialSelection, model: "complete" };
        const projection = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: completing,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const dispatch = (step: string, modelSelection: ModelSelection, targetRunId?: RunId) =>
            Effect.gen(function* () {
              const settled = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter((event) =>
                  modelSelection.model === initialSelection.model
                    ? event.type === "provider-turn.updated" && event.payload.status === "running"
                    : event.type === "run.updated" &&
                      event.payload.status === "completed" &&
                      (targetRunId === undefined
                        ? event.payload.userMessageId === MessageId.make(`${name}:${step}`)
                        : event.payload.id === targetRunId),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${name}:${step}`),
                threadId,
                messageId: MessageId.make(`${name}:${step}`),
                text: step,
                attachments: [],
                modelSelection,
                dispatchMode:
                  targetRunId === undefined
                    ? { type: "start_immediately" }
                    : { type: "restart_active", targetRunId },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              yield* Fiber.join(settled);
              yield* worker.drain();
              return yield* orchestrator.getThreadProjection(threadId);
            });
          if (mode === "earlier-run") yield* dispatch("earlier", completing);
          const working = yield* dispatch("working", initialSelection);
          const workingRun = working.runs.at(-1)!;
          const restarted = yield* dispatch("restart", completing, workingRun.id);
          yield* dispatch("after", completing);
          yield* dispatch("again", completing);
          return restarted;
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name },
              ProviderAdapterRegistry.layerSingle(adapter),
            ),
          ),
        );

        const note = restartCancelledBackgroundWorkNote(lostWork.map(cancelledRosterTaskWork));
        // The run before the one started again carries the loss; a chat's first run has none
        // before it and keeps its own. Either way the restart's prompt tells it, once.
        const recordRun = projection.runs[0]!;
        assert.deepEqual(
          projection.runs.map((run) => [run.status, run.restartCancelledBackgroundWork]),
          mode === "earlier-run"
            ? [
                ["completed", lostWork.map(cancelledRosterTaskWork)],
                ["completed", undefined],
              ]
            : [["completed", lostWork.map(cancelledRosterTaskWork)]],
        );
        assert.deepInclude(
          projection.turnItems.find(
            (item) => item.id === backgroundWorkStoppedNoticeId(recordRun.id),
          ),
          {
            type: "system_notice",
            title: "Turn restarted",
            message: [
              "Restarting the turn ended the agent process and stopped background work before it finished:",
              "- task: vp run build (id build)",
              "This chat was waiting on it.",
            ].join("\n"),
          },
        );
        assert.deepEqual(
          messages,
          mode === "earlier-run"
            ? ["earlier", "working", `${note}\n\nUser message:\nrestart`, "after", "again"]
            : ["working", `${note}\n\nUser message:\nrestart`, "after", "again"],
        );
      }),
    ),
);

it.live.each([
  [codexDriver, "held"],
  [ProviderDriverKind.make("claudeAgent"), "held"],
  [ProviderDriverKind.make("claudeAgent"), "completed"],
  [ProviderDriverKind.make("claudeAgent"), "hold lifted"],
  [ProviderDriverKind.make("claudeAgent"), "healthy replacement"],
] as const)(
  "moves a turn its provider holds for a usage limit to an account with room on %s (source before dispatch: %s)",
  ([targetDriver, sourceState]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const crossProvider = targetDriver !== codexDriver;
        const name = `held-limit-failover-${targetDriver}-${sourceState.replaceAll(" ", "-")}`;
        const cwd = yield* checkpointWorkspace(name);
        const threadId = ThreadId.make(`thread:${name}`);
        const targetId = ProviderInstanceId.make(`${targetDriver}-account-with-room`);
        const selection = crossProvider
          ? { ...initialSelection, autoAccount: true }
          : initialSelection;
        const targetModel = crossProvider ? "claude-sonnet-4-6" : initialSelection.model;
        const state = yield* Ref.make<RestartAdapterState>({
          activeTurn: null,
          opened: [],
          started: [],
          closedSessionCount: 0,
          failedReplacementOpen: true,
        });
        const now = yield* DateTime.now;
        const completeHeldTurn = yield* Deferred.make<Effect.Effect<void>>();
        const liftHold = yield* Deferred.make<Effect.Effect<void>>();
        const adapters = [
          makeRestartAdapter(state, exclusiveCapabilities, providerInstanceId, {
            heldUntil: DateTime.add(now, { hours: 2 }),
            completeHeldTurn,
            liftHold,
          }),
          makeRestartAdapter(state, exclusiveCapabilities, targetId, { driver: targetDriver }),
        ];
        const layerRegistry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: (instanceId) =>
            Effect.succeed(adapters.find((adapter) => adapter.instanceId === instanceId)!),
          list: () => Effect.succeed([providerInstanceId, targetId]),
          getMetadata: (instanceId) =>
            Effect.succeed({
              driver: instanceId === targetId ? targetDriver : codexDriver,
              continuationKey:
                instanceId === targetId && crossProvider ? "claude:test" : "codex:home:/shared",
              enabled: true,
              capabilities: exclusiveCapabilities,
            }),
        });
        const providers = [providerInstanceId, targetId].map((instanceId): ServerProvider => ({
          instanceId,
          driver: instanceId === targetId ? targetDriver : codexDriver,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: DateTime.formatIso(now),
          models: [
            {
              slug: instanceId === targetId ? targetModel : initialSelection.model,
              name: "Test model",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        }));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const held = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.type === "error" &&
                event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${name}:create`),
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            title: name,
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${name}:first`),
            threadId,
            messageId: MessageId.make(`${name}:first`),
            text: "first",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(held);

          const queuedMessageId = MessageId.make(`${name}:queued`);
          if (crossProvider) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(queuedMessageId),
              threadId,
              messageId: queuedMessageId,
              text: "Also check the tests.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
          }
          const candidates = (failover: boolean) =>
            projections
              .getLimitRecoveryCandidates({
                now,
                autoResume: true,
                snooze: true,
                waiting: failover,
              })
              .pipe(Effect.map((rows) => rows.find((row) => row.id === threadId)));
          // Without account switching, the held turn waits for its reset as before.
          assert.isUndefined(yield* candidates(false));
          const candidate = yield* candidates(true);
          assert.equal(candidate?.status, "running");
          const limitedInstanceIds = yield* projections.getUsageLimitedProviderInstances(
            now,
            runLiftsScope(providers),
          );
          assert.isTrue(limitedInstanceIds.has(providerInstanceId));
          const failover =
            candidate === undefined
              ? null
              : limitFailoverCommand({
                  mcpSignInsNeeded: new Map(),
                  thread: candidate,
                  settings: {
                    ...DEFAULT_SERVER_SETTINGS,
                    failoverLimitedThreads: true,
                    autoModeProvider: codexDriver,
                    autoModeModels: {
                      [codexDriver]: { model: initialSelection.model },
                      [targetDriver]: { model: targetModel },
                    },
                    providerInstances: {
                      [providerInstanceId]: { driver: codexDriver },
                      [targetId]: { driver: targetDriver },
                    },
                  },
                  providers,
                  recordedLimits: limitedInstanceIds,
                  nowMs: DateTime.toEpochMillis(now),
                });
          assert.isNotNull(failover);
          if (sourceState !== "held") {
            assert(failover?.dispatchMode.type === "restart_active");
            const sourceId = failover.dispatchMode.targetRunId;
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.userMessageId === queuedMessageId,
            );
            assert.isDefined(queued);
            // A person's held message stays queued when the original turn finishes.
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${name}:queue-held`),
                  type: "run.updated",
                  threadId,
                  runId: queued.id,
                  occurredAt: yield* DateTime.now,
                  payload: { ...queued, queueHeld: true },
                },
              ],
            });
            if (sourceState === "completed") {
              const complete = yield* Deferred.await(completeHeldTurn);
              yield* complete;
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.runId === sourceId &&
                    event.payload.status === "completed",
                ),
                Stream.runHead,
              );
            } else if (sourceState === "hold lifted") {
              const lift = yield* Deferred.await(liftHold);
              yield* lift;
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "turn-item.updated" &&
                    event.runId === sourceId &&
                    event.payload.type === "error" &&
                    event.payload.status === "completed",
                ),
                Stream.runHead,
              );
            } else {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${name}:replace`),
                threadId,
                messageId: MessageId.make(`${name}:replace`),
                text: "Restart here.",
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "restart_active", targetRunId: sourceId },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "provider-turn.updated" &&
                    event.payload.status === "running" &&
                    event.payload.runAttemptId !== candidate?.heldAttemptId,
                ),
                Stream.runHead,
              );
            }
            yield* worker.drain();
            const before = yield* orchestrator.getThreadProjection(threadId);
            const source = before.runs.find((run) => run.id === sourceId);
            assert.isDefined(source);
            assert.equal(source.status, sourceState === "completed" ? "completed" : "running");
            if (sourceState === "healthy replacement") {
              assert.notEqual(source.activeAttemptId, candidate?.heldAttemptId);
              const replacement = before.providerTurns.find(
                (turn) => turn.runAttemptId === source.activeAttemptId && turn.status === "running",
              );
              assert.isDefined(replacement);
              assert.isFalse(
                before.turnItems.some(
                  (item) =>
                    item.providerTurnId === replacement.id &&
                    item.nodeId === source.rootNodeId &&
                    item.type === "error" &&
                    item.status === "running" &&
                    item.failure.class === "usage_limit",
                ),
              );
            }
            assert.equal(before.runs.find((run) => run.id === queued.id)?.status, "queued");
            assert.deepEqual(before.thread.modelSelection, selection);
            const result = yield* orchestrator
              .dispatch(failover)
              .pipe(Effect.catchIf(Orchestrator.isStaleDispatchError, () => Effect.succeed(null)));
            yield* worker.drain();
            const after = yield* orchestrator.getThreadProjection(threadId);
            const events = result?.storedEvents.map(({ event }) => event) ?? [];
            assert.deepEqual(
              {
                targetStarts: (yield* Ref.get(state)).started.filter(
                  (turn) => turn.model === targetModel,
                ).length,
                newRuns: after.runs.length - before.runs.length,
                providerSwitches: events.filter(
                  (event) => event.type === "thread.provider-switched",
                ).length,
                moveNotices: after.turnItems.filter(
                  (item) =>
                    item.type === "system_notice" &&
                    item.message === failover.usageLimitMove?.notice,
                ).length,
                queueRewrites: events.filter(
                  (event) =>
                    event.type === "run.updated" &&
                    event.runId === queued.id &&
                    event.payload.providerInstanceId !== queued.providerInstanceId,
                ).length,
              },
              {
                targetStarts: 0,
                newRuns: 0,
                providerSwitches: 0,
                moveNotices: 0,
                queueRewrites: 0,
              },
            );
            assert.isNull(result);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.attempts, before.attempts);
            assert.deepEqual(after.thread.modelSelection, selection);
            return;
          }
          yield* orchestrator.dispatch(failover!);
          yield* worker.drain();
          if (crossProvider) {
            const moved = yield* orchestrator.getThreadProjection(threadId);
            const restarted = moved.runs[0];
            assert.isDefined(restarted);
            assert.equal(restarted.crossProviderFailoverFrom, providerInstanceId);
            assert.deepInclude(
              moved.contextHandoffs.find((handoff) => handoff.id === restarted.contextHandoffId),
              {
                targetRunId: restarted.id,
                coveredRunOrdinals: { from: 1, to: 1 },
                strategy: "full_thread_summary",
              },
            );
            assert.isTrue(
              moved.turnItems.some(
                (item) =>
                  item.type === "system_notice" &&
                  item.message === failover!.usageLimitMove?.notice,
              ),
            );
            assert.equal(
              moved.runs.find((run) => run.userMessageId === queuedMessageId)?.providerInstanceId,
              targetId,
            );
          }
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(({ event }) =>
              crossProvider
                ? event.type === "run.updated" &&
                  event.payload.userMessageId === queuedMessageId &&
                  event.payload.status === "completed"
                : event.type === "provider-turn.updated" &&
                  event.providerInstanceId === targetId &&
                  event.payload.status === "running",
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.thread.providerInstanceId, targetId);
          assert.deepEqual(
            projection.runs.map((run) => [run.providerInstanceId, run.status]),
            crossProvider
              ? [
                  [targetId, "completed"],
                  [targetId, "completed"],
                ]
              : [[targetId, "running"]],
          );
          assert.deepEqual(
            projection.messages.map((message) => message.text),
            crossProvider
              ? ["first", "Continue where you left off.", "Also check the tests."]
              : ["first", "Continue where you left off."],
          );
          const { started } = yield* Ref.get(state);
          if (crossProvider) assert.include(started.at(-1)!.text, "Also check the tests.");
          assert.deepEqual(
            started.map((turn) => turn.model),
            crossProvider
              ? [initialSelection.model, targetModel, targetModel]
              : [initialSelection.model, initialSelection.model],
          );
          // The account that held the turn stays skipped until its reset.
          assert.isUndefined(yield* candidates(true));
          const stillLimited = yield* projections.getUsageLimitedProviderInstances(
            now,
            runLiftsScope(providers),
          );
          assert.isTrue(stillLimited.has(providerInstanceId));
          assert.isFalse(stillLimited.has(targetId));
        }).pipe(Effect.provide(ProviderReplayHarness.layerWithRegistry({ name }, layerRegistry)));
      }),
    ),
);
