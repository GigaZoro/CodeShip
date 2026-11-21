import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProviderThreadId,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { AgentScope } from "@t3tools/shared/AgentScope";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

it.effect.each([
  "active",
  "pending",
  "pending-ui",
  "queued-source",
  "queued-direct",
  "queued-ui",
  "queued-window",
  "manual",
  "unrelated",
  "ended",
  "racing",
  "failed-unprepared",
  "lost-work",
] as const)(
  "interruptThread follows only the restart chain when its continuation is %s",
  (scenario) =>
    Effect.gen(function* () {
      const database = SqlitePersistence.layerMemory;
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: "interrupt-restart" },
        ProviderAdapterRegistry.layerFromAdapters([
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: () => Effect.die("Provider execution is disabled in this test"),
          } as ProviderAdapter.ProviderAdapterV2["Service"],
        ]),
        { databaseLayer: database, runEffectWorker: false },
      );
      const layer = ThreadManagementService.layer.pipe(
        Layer.provideMerge(runtime),
        Layer.provideMerge(ProjectionStore.layer.pipe(Layer.provide(database))),
        Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(database))),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const projectId = ProjectId.make("project:interrupt-restart");
        const threadId = ThreadId.make("thread:interrupt-restart");
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create:interrupt-restart"),
          projectId,
          threadId,
          title: "Restart cancellation",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const send = (id: string, restartContinuationOfRunId?: RunId) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text: "Work",
            attachments: [],
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
            ...(restartContinuationOfRunId === undefined ? {} : { restartContinuationOfRunId }),
          });
        const update = (run: OrchestrationV2Run) =>
          projections.apply({
            id: EventId.make(`update:${run.id}:${run.status}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: run,
          });
        yield* send("source");
        const source = (yield* projections.getThreadProjection(threadId)).runs[0]!;
        yield* update({ ...source, status: "cancelled", completedAt: now });
        yield* send("middle");
        const middle = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
        const queued = scenario.startsWith("queued-");
        const pending = scenario === "pending" || scenario === "pending-ui";
        yield* update({
          ...middle,
          status: queued ? "preparing" : "cancelled",
          completedAt: queued ? null : now,
          restartContinuationOfRunId: source.id,
        });
        if (!pending) {
          yield* send("latest");
          const latest = (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
          yield* update({
            ...latest,
            ...(scenario === "manual"
              ? { manualContinuationOfRunId: middle.id }
              : scenario === "unrelated"
                ? {}
                : { restartContinuationOfRunId: middle.id }),
            ...(scenario === "ended" ? { status: "completed", completedAt: now } : {}),
            ...(scenario === "failed-unprepared"
              ? { status: "failed", completedAt: now, rootNodeId: null, providerThreadId: null }
              : scenario === "lost-work"
                ? {
                    status: "completed",
                    completedAt: now,
                    restartCancelledBackgroundWork: [{ kind: "task", label: "lost task" }],
                  }
                : {}),
          });
        }
        if (queued) {
          yield* update({
            ...middle,
            status: "failed",
            completedAt: now,
            restartContinuationOfRunId: source.id,
          });
          if (scenario !== "queued-window") {
            yield* projections.apply({
              id: EventId.make("usage-limit"),
              type: "turn-item.updated",
              threadId,
              runId: middle.id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("usage-limit"),
                threadId,
                runId: middle.id,
                nodeId: middle.rootNodeId,
                providerThreadId: middle.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: "Usage limit",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "error",
                failure: {
                  class: "usage_limit",
                  message: "Usage limit",
                  retryable: true,
                  code: null,
                },
              },
            });
            const held = yield* orchestrator
              .dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume-while-limited"),
                threadId,
              })
              .pipe(Effect.result);
            expect(Result.isFailure(held)).toBe(true);
          }
        }
        const before = yield* projections.getThreadProjection(threadId);
        const latest = before.runs.at(-1)!;
        if (queued) expect(latest.status).toBe("queued");
        if (scenario === "queued-direct") {
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-queued-continuation"),
            threadId,
          });
          expect((yield* projections.getThreadProjection(threadId)).runs.at(-1)).toMatchObject({
            id: latest.id,
            status: "cancelled",
          });
        }
        if (pending) {
          yield* outbox.enqueue([
            EffectOutbox.restartContinuationEffect({
              commandId: CommandId.make("pending-restart"),
              threadId,
              sourceRunId: latest.id,
              availableAt: DateTime.add(now, { minutes: 3 }),
            }),
          ]);
        }
        // The process that lost the work recorded it and owes the wake it is about to enqueue; the
        // record alone, which a user's session close also leaves, is no pending restart.
        const settleLostWorkWake =
          scenario === "lost-work" ? yield* outbox.oweRestartWake(latest.id) : Effect.void;
        const wait = () =>
          service.waitForThread({ projectId, threadId, runId: source.id, timeoutMs: 60_000 });
        const waiting = pending
          ? yield* Effect.gen(function* () {
              const subscribed = yield* Deferred.make<void>();
              const awaitRetry = orchestrator.awaitRestartContinuation;
              const subscription = vi
                .spyOn(orchestrator, "awaitRestartContinuation")
                .mockImplementation((run) =>
                  Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(awaitRetry(run))),
                );
              yield* Effect.addFinalizer(() => Effect.sync(() => subscription.mockRestore()));
              const fiber = yield* wait().pipe(Effect.forkScoped);
              yield* Deferred.await(subscribed);
              return fiber;
            })
          : undefined;
        // Expose the read/dispatch race without clocks or polling.
        let reads = 0;
        const racedService =
          scenario === "racing"
            ? yield* ThreadManagementService.ThreadManagementService.pipe(
                Effect.provide(
                  ThreadManagementService.layer.pipe(
                    Layer.provide(
                      Layer.mock(Orchestrator.OrchestratorV2)({
                        ...orchestrator,
                        getThreadRecords: (id, fields, filter) =>
                          orchestrator.getThreadRecords(id, fields, filter).pipe(
                            Effect.map((records) => {
                              const runs = (records as Partial<OrchestrationV2ThreadProjection>)
                                .runs;
                              return ++reads === 1 && runs !== undefined
                                ? { ...records, runs: runs.filter((run) => run.id !== latest.id) }
                                : records;
                            }),
                          ),
                        restartContinuationPending: () => Effect.succeed(true),
                      }),
                    ),
                    Layer.provide(runtime),
                    Layer.provide(ServerSettings.layerTest()),
                    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
                  ),
                ),
              )
            : service;
        const mayPromote = yield* Deferred.make<void>();
        const promotionReady = yield* Deferred.make<void>();
        const promotion =
          scenario === "queued-window"
            ? yield* Deferred.succeed(promotionReady, undefined).pipe(
                Effect.andThen(Deferred.await(mayPromote)),
                Effect.andThen(
                  orchestrator.dispatch({
                    type: "queue.resume",
                    commandId: CommandId.make("promote-after-commit"),
                    threadId,
                  }),
                ),
                Effect.forkScoped,
              )
            : undefined;
        if (promotion !== undefined) yield* Deferred.await(promotionReady);
        const requestedRunId = scenario === "queued-direct" ? latest.id : source.id;
        const ui = scenario === "pending-ui" || scenario === "queued-ui";
        const result = yield* ui
          ? orchestrator
              .dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("interrupt-source"),
                threadId,
                runId: requestedRunId,
                holdQueue: true,
              })
              .pipe(
                Effect.map((dispatch) => ({
                  type: "interrupt_requested" as const,
                  runId: latest.id,
                  dispatch,
                })),
                Effect.result,
              )
          : racedService
              .interruptThread({
                projectId,
                threadId,
                runId: requestedRunId,
                commandId: CommandId.make("interrupt-source"),
              })
              .pipe(Effect.result);
        yield* settleLostWorkWake;
        if (scenario === "manual" || scenario === "unrelated") {
          expect(Result.isSuccess(result) && result.success).toMatchObject({
            type: "already_terminal",
            runId: middle.id,
          });
          expect(
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("interrupt-ended-under-lock"),
              threadId,
              runId: source.id,
              onlyIfActive: true,
            }),
          ).toMatchObject({ storedEvents: [] });
          expect((yield* projections.getThreadProjection(threadId)).runs).toEqual(before.runs);
          return;
        }
        if (Result.isFailure(result)) return yield* result.failure;
        expect(result.success).toMatchObject({
          type:
            scenario === "ended" || scenario === "queued-direct"
              ? "already_terminal"
              : "interrupt_requested",
          runId: latest.id,
        });
        if (waiting !== undefined) {
          // The retry worker is paused. Both waiters must finish on Stop's commit.
          expect(yield* orchestrator.restartContinuationPending(latest)).toBe(false);
          for (const settled of [yield* Fiber.join(waiting), yield* wait()]) {
            expect(settled).toMatchObject({
              timedOut: false,
              run: { id: latest.id, status: "cancelled" },
            });
          }
        }
        if (pending || queued || scenario === "failed-unprepared" || scenario === "lost-work") {
          expect(
            yield* service.interruptThread({
              projectId,
              threadId,
              runId: source.id,
              commandId: CommandId.make("interrupt-pending-again"),
            }),
          ).toMatchObject({ type: "already_terminal", runId: latest.id });
          const stopped = yield* projections.getThreadProjection(threadId);
          if (queued) {
            expect(stopped.runs.at(-1)).toMatchObject({ id: latest.id, status: "cancelled" });
            expect(stopped.turnItems).toContainEqual(
              expect.objectContaining({
                runId: middle.id,
                type: "run_interrupt_request",
              }),
            );
            yield* send("late-source-restart", middle.id);
            expect((yield* projections.getThreadProjection(threadId)).runs).toEqual(stopped.runs);
            yield* update({
              ...middle,
              status: "completed",
              completedAt: now,
              restartContinuationOfRunId: source.id,
            });
            if (promotion !== undefined) {
              yield* Deferred.succeed(mayPromote, undefined);
              yield* Fiber.join(promotion);
            } else {
              yield* orchestrator.dispatch({
                type: "queue.resume",
                commandId: CommandId.make("resume-after-limit"),
                threadId,
              });
            }
            expect((yield* projections.getThreadProjection(threadId)).runs.at(-1)).toMatchObject({
              id: latest.id,
              status: "cancelled",
            });
          }
          const stoppedRuns = (yield* projections.getThreadProjection(threadId)).runs;
          yield* send("late-restart", latest.id);
          const after = yield* projections.getThreadProjection(threadId);
          expect(after.runs).toEqual(queued ? stoppedRuns : before.runs);
          expect(after.turnItems).toContainEqual(
            expect.objectContaining({
              runId: latest.id,
              type: "run_interrupt_request",
              ...(scenario === "failed-unprepared" ? { nodeId: null, providerThreadId: null } : {}),
            }),
          );
        } else if (scenario !== "ended") {
          expect((yield* projections.getThreadProjection(threadId)).runs.at(-1)).toMatchObject({
            id: latest.id,
            status: "interrupted",
          });
        }
        yield* send("later-work");
        const later = yield* projections.getThreadProjection(threadId);
        expect(
          yield* service.interruptThread({
            projectId,
            threadId,
            runId: source.id,
            commandId: CommandId.make("interrupt-after-later-work"),
          }),
        ).toMatchObject({ type: "already_terminal", runId: latest.id });
        expect((yield* projections.getThreadProjection(threadId)).runs).toEqual(later.runs);
      }).pipe(Effect.provide(layer));
    }),
);

const layerDispatchChokepointTest =
  (
    settingsLayer: ReturnType<typeof ServerSettings.layerTest>,
    options: {
      readonly autoAccount?: boolean;
      readonly accountRouting?: Layer.Layer<AccountRouting.AccountRouting>;
    } = {},
  ) =>
  (dispatched: Array<OrchestrationV2ServerCommand>) => {
    const thread = {
      id: ThreadId.make("thread:thread-management:chokepoint"),
      projectId: ProjectId.make("project:thread-management:chokepoint"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      activeProviderThreadId: null,
      latestRunId: null,
      deletedAt: null,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex_work"),
        model: "test",
        ...(options.autoAccount ? { autoAccount: true } : {}),
      },
    };
    return ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({ thread } as unknown as OrchestrationV2ThreadProjection),
          getThreadShell: () => Effect.succeed(thread as unknown as OrchestrationV2ThreadShell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(options.accountRouting ?? Layer.empty),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );
  };

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched.map((command) => command.type)).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect.each([{ scheduled: false }, { scheduled: true }])(
  "checks an Auto dispatch against the selected account (scheduled: $scheduled)",
  ({ scheduled }) => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const limited = ProviderInstanceId.make("codex_work");
    const routed = ProviderInstanceId.make("codex_personal");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const routeInputs: Array<unknown> = [];
    const firstLaunchChecks: Array<unknown> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: {
          [limited]: { driver: "codex", enabled: true },
          [routed]: { driver: "codex", enabled: true },
        },
        // The thread's own account would be refused; the routed one is not.
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [limited]: { enabled: false } } },
        },
      }),
      {
        autoAccount: true,
        accountRouting: Layer.succeed(AccountRouting.AccountRouting, {
          accountsWithRoom: () => Effect.succeed([]),
          scheduledRunBlock: () => Effect.succeed(null),
          releaseAllowedHolds: Effect.succeed(false),
          route: (input) =>
            Effect.sync(() => {
              routeInputs.push(input);
              return { ...input.selection, instanceId: routed };
            }),
          limits: Effect.succeed({
            accounts: new Map(),
            estimated: new Set<never>(),
            models: new Map(),
          }),
          retryAccount: () => Effect.void,
          holds: Effect.succeed([]),
          launchLimit: () => Effect.succeed(null),
          failoverLaunch: (input) =>
            Effect.sync(() => {
              firstLaunchChecks.push(input);
              return { selection: input.selection, failover: null };
            }),
        }),
      },
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:thread-management:chokepoint-auto"),
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-auto"),
        text: "First message",
        attachments: [],
        ...(scheduled
          ? {
              scheduledTaskId: ScheduledTaskId.make("scheduled-task:chokepoint-auto"),
              launchAlreadyRouted: true as const,
            }
          : {}),
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      // A thread that never ran has no account of its own to stay on.
      expect(routeInputs).toEqual([
        {
          selection: { instanceId: limited, model: "test", autoAccount: true },
          projectId,
          currentInstanceId: null,
          started: false,
          scheduled,
        },
      ]);
      expect(firstLaunchChecks).toHaveLength(scheduled ? 0 : 1);
      expect(dispatched).toMatchObject([
        { type: "message.dispatch", modelSelection: { instanceId: routed, autoAccount: true } },
      ]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("a buffered provider wake-up stays on its account when routing would move it", () => {
  const threadId = ThreadId.make("thread:thread-management:chokepoint");
  const current = ProviderInstanceId.make("codex_work");
  const routed = ProviderInstanceId.make("codex_personal");
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const routeInputs: Array<unknown> = [];
  const layerTest = layerDispatchChokepointTest(
    ServerSettings.layerTest({
      providerInstances: {
        [current]: { driver: "codex", enabled: true },
        [routed]: { driver: "codex", enabled: true },
      },
    }),
    {
      autoAccount: true,
      accountRouting: Layer.succeed(AccountRouting.AccountRouting, {
        accountsWithRoom: () => Effect.succeed([]),
        scheduledRunBlock: () => Effect.succeed(null),
        releaseAllowedHolds: Effect.succeed(false),
        route: (input) =>
          Effect.sync(() => {
            routeInputs.push(input);
            return { ...input.selection, instanceId: routed };
          }),
        limits: Effect.succeed({
          accounts: new Map(),
          estimated: new Set<never>(),
          models: new Map(),
        }),
        retryAccount: () => Effect.void,
        holds: Effect.succeed([]),
        launchLimit: () => Effect.succeed(null),
        failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
      }),
    },
  )(dispatched);

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:thread-management:provider-wake"),
      threadId,
      messageId: MessageId.make("message:thread-management:provider-wake"),
      text: 'Background command "verify" completed (exit code 0)',
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
    });

    expect(routeInputs).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty("modelSelection");
  }).pipe(Effect.provide(layerTest));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "subagent.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () => Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [rolledBack],
              messages: [],
              subagents: [],
              providerThreads: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each([
  { action: "settle" as const, status: "completed" as const, applies: true },
  { action: "settle" as const, status: "failed" as const, applies: false },
  { action: "settle" as const, status: "interrupted" as const, applies: false },
  { action: "archive" as const, status: "completed" as const, applies: true },
  { action: "archive" as const, status: "failed" as const, applies: false },
])("organizeAfterRun applies $action only when the run $status", ({ action, status, applies }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const completedAt = DateTime.makeUnsafe("2026-09-13T07:00:01.000Z");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status, completedAt }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.organizeAfterRun({ projectId, threadId, runId, action });

    // A settle is stamped at the completion, so clients still notify it like an auto-settle.
    // An archive keeps a message someone queued meanwhile, which settle refuses on its own.
    expect(dispatched).toEqual(
      !applies
        ? []
        : action === "settle"
          ? [expect.objectContaining({ type: "thread.settle", settledAt: completedAt })]
          : [expect.objectContaining({ type: "thread.archive", onlyIfNoQueuedMessage: true })],
    );
  }),
);

it.effect.each([
  { name: "a delegated result", wake: { delegatedCompletion: {} }, settlesAfterWake: true },
  { name: "a background notification", wake: { notification: {} }, settlesAfterWake: true },
  { name: "a message someone sent", wake: {}, settlesAfterWake: false },
])(
  "organizeAfterRun waits for the run $name starts as the turn ends",
  ({ wake, settlesAfterWake }) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:thread-management:settle-after-wake");
      const threadId = ThreadId.make("thread:thread-management:settle-after-wake");
      const runId = RunId.make("run:thread-management:settle-after-wake");
      const wakeRunId = RunId.make("run:thread-management:settle-after-wake:next");
      const wakeMessageId = MessageId.make("message:thread-management:settle-after-wake");
      const completedAt = DateTime.makeUnsafe("2026-09-13T07:00:01.000Z");
      const wakeCompletedAt = DateTime.makeUnsafe("2026-09-13T07:00:05.000Z");
      const dispatched: Array<OrchestrationV2ServerCommand> = [];
      let wakeStatus: "queued" | "running" | "completed" = "queued";
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        Layer.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadEventSequence: () => Effect.succeed(0),
            restartContinuationPending: () => Effect.succeed(false),
            getThreadShell: () => Effect.succeed({ pendingBackgroundTasks: [] } as never),
            getThreadRecords: (_threadId, fields) =>
              Effect.sync(() => {
                const records = {
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: [
                    { id: runId, ordinal: 1, status: "completed", completedAt },
                    {
                      id: wakeRunId,
                      ordinal: 2,
                      status: wakeStatus,
                      userMessageId: wakeMessageId,
                      completedAt: wakeStatus === "completed" ? wakeCompletedAt : null,
                    },
                  ],
                  messages: [{ id: wakeMessageId, role: "user", ...wake }],
                } as unknown as OrchestrationV2ThreadProjection;
                // The wake finishes while the settle waits on it.
                if ((fields as ReadonlyArray<string>).includes("messages"))
                  wakeStatus = "completed";
                return records;
              }),
            dispatch: (command) =>
              Effect.suspend(() => {
                dispatched.push(command);
                if (wakeStatus !== "queued") return Effect.succeed({ sequence: 1 } as never);
                // The queue started the wake before the settle reached the thread.
                wakeStatus = "running";
                return Effect.fail(
                  new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: `Thread ${threadId} is still running. Stop it before settling.`,
                  }),
                );
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const service = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(layerTest),
      );

      yield* service
        .organizeAfterRun({ projectId, threadId, runId, action: "settle" })
        .pipe(Effect.ignore);

      expect(dispatched).toMatchObject(
        settlesAfterWake
          ? [{ settledAt: completedAt }, { type: "thread.settle", settledAt: wakeCompletedAt }]
          : [{ settledAt: completedAt }],
      );
    }),
);

it.effect.each([
  {
    name: "kills the thread's own agent and ends its turn",
    others: [] as ReadonlyArray<string>,
    killed: true,
    expected: { outcome: "killed", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
  {
    name: "keeps a process another working thread shares and only ends this turn",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "still settles a finished run's background work in a shared process",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    settledRun: true,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "detaches when a sibling starts a turn just before the session is released",
    others: [] as ReadonlyArray<string>,
    killed: false,
    siblingBusy: true,
    expected: { outcome: "shared", sharedWithThreadIds: [] },
    teardown: ["release", "detach"],
  },
  {
    name: "reports a teardown that has not finished in time as still releasing",
    others: [] as ReadonlyArray<string>,
    killed: false,
    releaseHangs: true,
    expected: { outcome: "releasing", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
])("Force stop $name", ({ others, killed, expected, teardown, ...row }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:force-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:force-stop");
    const runId = RunId.make("run:thread-management:force-stop");
    const dispatched: Array<OrchestrationV2Command | { readonly type: string }> = [];
    const teardowns: Array<string> = [];
    const tornDown = yield* Deferred.make<void>();
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(true),
          otherWorkingThreads: () => Effect.succeed(others.map((id) => ThreadId.make(id))),
          releaseUnlessBusy: () =>
            Effect.sync(() => teardowns.push("release")).pipe(
              Effect.andThen(
                "releaseHangs" in row ? Effect.never : Effect.succeed(!("siblingBusy" in row)),
              ),
            ),
          detach: () =>
            Effect.sync(() => teardowns.push("detach")).pipe(
              Effect.andThen(Deferred.succeed(tornDown, undefined)),
              Effect.asVoid,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                {
                  id: runId,
                  ordinal: 1,
                  status: "settledRun" in row ? "completed" : "running",
                  activeAttemptId: "attempt",
                },
                // A queued follow-up neither supersedes the request nor becomes the target.
                { id: RunId.make("run:queued-follow-up"), ordinal: 2, status: "queued" },
              ],
              providerThreads: [{ id: providerThreadId, appThreadId: threadId, providerSessionId }],
              providerTurns: [
                {
                  id: "provider-turn:force-stop",
                  providerThreadId,
                  runAttemptId: "attempt",
                  status: "settledRun" in row ? "completed" : "running",
                },
              ],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.succeed(killed),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const stopping = yield* service.forceStopThread({ threadId, runId }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(stopping)).toEqual(expected);
      expect(dispatched).toMatchObject([
        {
          type: "thread.background-work.settle",
          providerThreadId,
          reason: "Force stopped by user",
        },
      ]);
      if (teardown.at(-1) === "detach") yield* Deferred.await(tornDown);
      expect(teardowns).toEqual(teardown);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("Force stop refuses once a newer run has started, before killing anything", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop-superseded");
    let killed = false;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                { id: RunId.make("run:stopped"), ordinal: 1, status: "running" },
                { id: RunId.make("run:newer"), ordinal: 2, status: "running" },
              ],
              providerThreads: [],
              providerTurns: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.sync(() => (killed = true)),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        service.forceStopThread({ threadId, runId: RunId.make("run:stopped") }),
      );
    }).pipe(Effect.provide(layerTest));
    expect(error.reason).toBe("superseded");
    expect(killed).toBe(false);
  }),
);
