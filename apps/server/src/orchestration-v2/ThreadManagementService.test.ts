import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProviderThreadId,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { AgentScope } from "@t3tools/shared/AgentScope";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AccountRouting from "./AccountRouting.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

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

const layerDispatchChokepointTest =
  (
    settingsLayer: ReturnType<typeof ServerSettings.layerTest>,
    options: {
      readonly autoAccount?: boolean;
      readonly accountRouting?: Layer.Layer<AccountRouting.AccountRouting>;
      readonly runs?: (threadId: ThreadId) => ReadonlyArray<Partial<OrchestrationV2Run>>;
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
          getThreadRecords: (threadId) =>
            Effect.succeed({
              thread,
              runs: options.runs?.(threadId) ?? [],
              providerTurns: [],
              messages: [],
              turnItems: [],
            } as unknown as OrchestrationV2ThreadProjection),
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

it.effect.each([
  { account: "the destination project enables", offIn: "parent", refused: false },
  { account: "the destination project turns off", offIn: "destination", refused: true },
] as const)(
  "a delegated task in another project's worktree is checked and routed on $account",
  ({ offIn, refused }) => {
    const parentProject = ProjectId.make("project:thread-management:chokepoint");
    const destination = ProjectId.make("project:thread-management:destination");
    const instanceId = ProviderInstanceId.make("codex_work");
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const routedIn: Array<ProjectId> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [offIn === "parent" ? parentProject : destination]: {
            providerInstances: { [instanceId]: { enabled: false } },
          },
        },
      }),
      {
        accountRouting: Layer.succeed(AccountRouting.AccountRouting, {
          accountsWithRoom: () => Effect.succeed([]),
          scheduledRunBlock: () => Effect.succeed(null),
          releaseAllowedHolds: Effect.succeed(false),
          route: (input) =>
            Effect.sync(() => {
              routedIn.push(input.projectId);
              return input.selection;
            }),
          limits: () =>
            Effect.succeed({
              accounts: new Map(),
              estimated: new Set<never>(),
              models: new Map(),
              credits: new Map(),
              grants: new Map(),
            }),
          retryAccount: () => Effect.succeed({}),
          creditRefusal: () => Effect.succeed(null),
          creditAccess: () => Effect.succeed({ spent: new Map(), requesters: [] }),
          creditOverruns: Effect.succeed([]),
          holds: Effect.succeed([]),
          launchLimit: () => Effect.succeed(null),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      },
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const outcome = yield* Effect.result(
        threads.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:thread-management:foreign-delegate-${offIn}`),
          parentThreadId: ThreadId.make("thread:thread-management:chokepoint"),
          parentRunId: RunId.make("run:thread-management:chokepoint"),
          parentNodeId: NodeId.make("node:thread-management:chokepoint"),
          task: "Fix the bug there.",
          modelSelection: { instanceId, model: "test", autoAccount: true },
          runtimeMode: "full-access",
          interactionMode: "default",
          projectId: destination,
        }),
      );

      expect(routedIn).toEqual([destination]);
      if (refused) {
        expect(outcome._tag).toBe("Failure");
        expect(outcome._tag === "Failure" ? outcome.failure : undefined).toMatchObject({
          projectId: destination,
          instanceId,
        });
        expect(dispatched).toEqual([]);
      } else {
        expect(outcome._tag).toBe("Success");
        expect(dispatched).toHaveLength(1);
      }
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

it.effect.each([
  { case: "another thread joins the demand its active run serves", to: "other", owned: true },
  { case: "another thread stays unattributed without an active run", to: "other", owned: false },
  { case: "its own thread keeps its own demand rules", to: "self", owned: true },
] as const)("an agent's message to $case", ({ to, owned }) => {
  const sender = ThreadId.make("thread:thread-management:sender");
  const threadId = ThreadId.make("thread:thread-management:chokepoint");
  const demandId = `demand:${"b".repeat(64)}`;
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layerTest = layerDispatchChokepointTest(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("codex_work")]: { driver: "codex", enabled: true },
      },
    }),
    {
      runs: (id) =>
        id === (to === "self" ? threadId : sender) && owned
          ? [
              { id: RunId.make("run:sender:old"), ordinal: 1, status: "completed", demandId: null },
              { id: RunId.make("run:sender:live"), ordinal: 2, status: "running", demandId },
            ]
          : [],
    },
  )(dispatched);

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("command:thread-management:agent-send"),
      threadId,
      senderThreadId: to === "self" ? threadId : sender,
      messageId: MessageId.make("message:thread-management:agent-send"),
      text: "Please check the build.",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });

    expect(dispatched).toMatchObject([{ type: "message.dispatch" }]);
    expect((dispatched[0] as { readonly demandId?: string | null }).demandId).toBe(
      to === "other" && owned ? demandId : undefined,
    );
  }).pipe(Effect.provide(layerTest));
});

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
          limits: () =>
            Effect.succeed({
              accounts: new Map(),
              estimated: new Set<never>(),
              models: new Map(),
              credits: new Map(),
              grants: new Map(),
            }),
          retryAccount: () => Effect.succeed({}),
          creditRefusal: () => Effect.succeed(null),
          creditAccess: () => Effect.succeed({ spent: new Map(), requesters: [] }),
          creditOverruns: Effect.succeed([]),
          holds: Effect.succeed([]),
          launchLimit: () => Effect.succeed(null),
          failoverLaunch: (input) =>
            Effect.sync(() => {
              firstLaunchChecks.push(input);
              if (input.selection.quotaAwareAuto === true) {
                return {
                  selection: { instanceId: routed, model: "fallback" },
                  failover: { reason: "usageLimit" as const, crossProviderFrom: limited },
                };
              }
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
          requesterThreadId: threadId,
          requestPrompt: { text: "First message", attachmentCount: 0 },
        },
      ]);
      expect(firstLaunchChecks).toHaveLength(scheduled ? 0 : 1);
      expect(dispatched).toMatchObject([
        { type: "message.dispatch", modelSelection: { instanceId: routed, autoAccount: true } },
      ]);
      const unresolved = { instanceId: routed, model: "placeholder", quotaAwareAuto: true };
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:thread-management:fresh-quota"),
        threadId,
        messageId: MessageId.make("message:thread-management:fresh-quota"),
        text: "First Auto message",
        attachments: [],
        modelSelection: unresolved,
        ...(scheduled
          ? { scheduledTaskId: ScheduledTaskId.make("scheduled-task:fresh-quota") }
          : {}),
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      expect(dispatched.at(-1)).toMatchObject({ modelSelection: unresolved });
      expect(firstLaunchChecks).toHaveLength(scheduled ? 0 : 1);
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
        limits: () =>
          Effect.succeed({
            accounts: new Map(),
            estimated: new Set<never>(),
            models: new Map(),
            credits: new Map(),
            grants: new Map(),
          }),
        retryAccount: () => Effect.succeed({}),
        creditRefusal: () => Effect.succeed(null),
        creditAccess: () => Effect.succeed({ spent: new Map(), requesters: [] }),
        creditOverruns: Effect.succeed([]),
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

it.effect(
  "routes web follow-ups, continuations, and server wakes through real routeAutoAccount without losing Sonnet or effort",
  () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const claudeMain = ProviderInstanceId.make("claude_main");
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const effortCaps = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    };
    const providers = [
      {
        instanceId: claudeMain,
        driver: claude,
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-11-26T00:00:00.000Z",
        models: [
          {
            slug: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            aliases: ["opus", "primary"],
            isCustom: false,
            capabilities: effortCaps,
          },
          {
            slug: "claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
            aliases: ["sonnet"],
            isCustom: false,
            capabilities: effortCaps,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ];
    const routingSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [claudeMain]: { driver: claude, enabled: true } },
      providerInstanceFailoverOrder: [claudeMain],
      failoverLimitedThreads: true,
      autoModeProvider: claude,
      autoModeModels: {
        [claude]: { model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
      },
    };
    const sonnetRunning = {
      instanceId: claudeMain,
      model: "claude-sonnet-5-5",
      autoAccount: true as const,
      options: [{ id: "effort", value: "low" }],
    };
    const webOpusSelection = {
      instanceId: claudeMain,
      model: "claude-opus-5-5",
      autoAccount: true as const,
      options: [{ id: "effort", value: "high" }],
    };
    const thread: {
      id: ThreadId;
      projectId: ProjectId;
      providerInstanceId: ProviderInstanceId;
      activeProviderThreadId: string;
      latestRunId: RunId;
      activeRunId: RunId | null;
      queueHeld?: boolean;
      deletedAt: null;
      modelSelection: typeof sonnetRunning;
    } = {
      id: threadId,
      projectId,
      providerInstanceId: claudeMain,
      activeProviderThreadId: "provider-thread:sonnet",
      latestRunId: RunId.make("run:initial-sonnet"),
      activeRunId: RunId.make("run:initial-sonnet"),
      deletedAt: null,
      modelSelection: sonnetRunning,
    };
    const queuedRuns: Array<{
      readonly id: RunId;
      readonly ordinal: number;
      readonly queuePosition?: number | null;
      readonly status: "queued";
      readonly modelSelection: typeof webOpusSelection;
    }> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (_threadId, fields) =>
            Effect.sync(() => {
              const requested = new Set<string>(fields.map((field) => field));
              return {
                thread,
                ...(requested.has("runs") ? { runs: queuedRuns } : {}),
              } as unknown as OrchestrationV2ThreadProjection;
            }),
          getThreadShell: () => Effect.succeed(thread as unknown as OrchestrationV2ThreadShell),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(AccountRouting.AccountRouting, {
          accountsWithRoom: () => Effect.succeed([]),
          scheduledRunBlock: () => Effect.succeed(null),
          releaseAllowedHolds: Effect.succeed(false),
          route: (input) =>
            Effect.succeed(
              AccountRouting.routeAutoAccount({
                ...input,
                settings: routingSettings,
                providers,
                recordedLimits: new Map(),
                mcpSignInsNeeded: new Map(),
                nowMs: Date.parse("2026-11-26T00:01:00.000Z"),
              }),
            ),
          limits: () =>
            Effect.succeed({
              accounts: new Map(),
              estimated: new Set<never>(),
              models: new Map(),
              credits: new Map(),
              grants: new Map(),
            }),
          retryAccount: () => Effect.succeed({}),
          creditRefusal: () => Effect.succeed(null),
          creditAccess: () => Effect.succeed({ spent: new Map(), requesters: [] }),
          creditOverruns: Effect.succeed([]),
          holds: Effect.succeed([]),
          launchLimit: () => Effect.succeed(null),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest(routingSettings)),
      Layer.provide(layerReceiptsTest),
    );

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      // 1. Web composer sends primary Opus with closing "thanks" -> stays on Sonnet + low
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-web-thanks"),
        threadId,
        messageId: MessageId.make("message:e2e-web-thanks"),
        text: "thanks!",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      // 2. Restart continuation -> stays on Sonnet + low
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-restart-cont"),
        threadId,
        messageId: MessageId.make("message:e2e-restart-cont"),
        text: "Continue where you left off.",
        attachments: [],
        modelSelection: sonnetRunning,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
        restartContinuationOfRunId: RunId.make("run:initial-sonnet"),
      });
      // 3. Usage-limit continuation -> stays on Sonnet + low
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-limit-cont"),
        threadId,
        messageId: MessageId.make("message:e2e-limit-cont"),
        text: "Continue where you left off.",
        attachments: [],
        modelSelection: sonnetRunning,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
        usageLimitContinuationOfRunId: RunId.make("run:initial-sonnet"),
      });
      // 4. Delegated-task completion wake (creationSource: "server", no continuation flags) -> stays on Sonnet + low
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-delegate-wake"),
        threadId,
        messageId: MessageId.make("message:e2e-delegate-wake"),
        text: "Delegated task finished with summary of changes across two files.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
      // 5. Web approval ("go ahead") -> upgrades to Opus + medium (never low effort)
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-web-go-ahead"),
        threadId,
        messageId: MessageId.make("message:e2e-web-go-ahead"),
        text: "go ahead",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      // Simulate run 5 entering the queue at queuePosition 2 (Opus), plus a higher-ordinal
      // redispatched Sonnet run moved ahead of it at queuePosition 1:
      queuedRuns.push(
        {
          id: RunId.make("run:queued-opus"),
          ordinal: 2,
          queuePosition: 2,
          status: "queued",
          modelSelection: {
            instanceId: claudeMain,
            model: "claude-opus-5-5",
            autoAccount: true,
            options: [{ id: "effort", value: "medium" }],
          },
        },
        {
          id: RunId.make("run:reordered-earlier-sonnet"),
          ordinal: 3,
          queuePosition: 1,
          status: "queued",
          modelSelection: sonnetRunning,
        },
      );
      // 6. Queued closing "thanks!" behind the reordered queue follows delivery order (queuePosition 2 = Opus)
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-queued-thanks-after-opus"),
        threadId,
        messageId: MessageId.make("message:e2e-queued-thanks-after-opus"),
        text: "thanks!",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      // 7. Steered closing "thanks!" joins the active Sonnet run instead of inheriting queued Opus
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-steered-thanks"),
        threadId,
        messageId: MessageId.make("message:e2e-steered-thanks"),
        text: "thanks!",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "steer_active", targetRunId: RunId.make("run:initial-sonnet") },
        createdBy: "user",
        creationSource: "web",
      });
      // 7b. Client steer via start_immediately + deliveryIntent: "steer" also stays on active Sonnet
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-client-steered-thanks"),
        threadId,
        messageId: MessageId.make("message:e2e-client-steered-thanks"),
        text: "thanks!",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "steer",
        createdBy: "user",
        creationSource: "web",
      });
      // 8. Held queue with no active run still uses the last queued Opus run as previousSelection
      thread.activeRunId = null;
      thread.queueHeld = true;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:tms:e2e-held-queue-thanks"),
        threadId,
        messageId: MessageId.make("message:e2e-held-queue-thanks"),
        text: "thanks!",
        attachments: [],
        modelSelection: webOpusSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });

      // Case 4 omitted modelSelection on the wake, and routing left it untouched (preserving thread.modelSelection).
      expect(
        dispatched[3]?.type === "message.dispatch" ? dispatched[3].modelSelection : "unexpected",
      ).toBeUndefined();
      const selections = dispatched.map((cmd) =>
        cmd.type === "message.dispatch" ? (cmd.modelSelection ?? thread.modelSelection) : undefined,
      );
      expect(selections).toEqual([
        sonnetRunning,
        sonnetRunning,
        sonnetRunning,
        sonnetRunning,
        {
          instanceId: claudeMain,
          model: "claude-opus-5-5",
          autoAccount: true,
          options: [{ id: "effort", value: "medium" }],
        },
        {
          instanceId: claudeMain,
          model: "claude-opus-5-5",
          autoAccount: true,
          options: [{ id: "effort", value: "low" }],
        },
        sonnetRunning,
        sonnetRunning,
        {
          instanceId: claudeMain,
          model: "claude-opus-5-5",
          autoAccount: true,
          options: [{ id: "effort", value: "low" }],
        },
      ]);
    }).pipe(Effect.provide(layerTest));
  },
);
