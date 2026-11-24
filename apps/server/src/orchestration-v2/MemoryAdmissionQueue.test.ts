import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type MemoryShortage,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as MemoryAdmissionQueue from "./MemoryAdmissionQueue.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
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
  // No effect worker: a start shows as its provider-turn.start effect, and nothing runs it.
  ProviderReplayHarness.layerWithRegistry(
    { name: "memory-admission" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(TestClock.layer()),
);

const GIB = 1024 ** 3;
const short: MemoryShortage = {
  kind: "available",
  totalBytes: 32 * GIB,
  availableBytes: 1.7 * GIB,
  reserveBytes: 4 * GIB,
};

/** The queue, reading memory from `memory`, which the test changes. */
const queueReading = (memory: Ref.Ref<MemoryShortage | null>) =>
  MemoryAdmissionQueue.make.pipe(
    Effect.provideService(
      MemoryAdmission.MemoryAdmission,
      MemoryAdmission.MemoryAdmission.of({
        shortage: Ref.get(memory),
        shortageOn: () => Ref.get(memory),
      }),
    ),
  );

const fromPerson = { createdBy: "user", creationSource: "web" } as const;
const fromAgent = { createdBy: "agent", creationSource: "mcp" } as const;

const send = (
  threadId: ThreadId,
  text: string,
  from: typeof fromPerson | typeof fromAgent = fromPerson,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      ...from,
    });
    return (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
  });

const createThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:memory:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:memory"),
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const startThread = (name: string) =>
  Effect.gen(function* () {
    const threadId = yield* createThread(name);
    return { threadId, runId: yield* send(threadId, "work") };
  });

/** A thread whose run a restart cut, as recovery leaves it. */
const cutThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, runId } = yield* startThread(name);
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:memory:${name}:cut`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "cancelled", startedAt: null, completedAt: now },
    });
    return { name, threadId, cutRunId: runId };
  });

/** The restart's own continuation of a cut run; returns the run it creates. */
const continueCutRun = (cut: { readonly threadId: ThreadId; readonly cutRunId: RunId }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`restart-continuation:${cut.cutRunId}`),
      threadId: cut.threadId,
      messageId: MessageId.make(`message:restart-continuation:${cut.cutRunId}`),
      text: "Continue.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: cut.cutRunId,
    });
    return (yield* orchestrator.getThreadProjection(cut.threadId)).runs.at(-1)!.id;
  });

/** Which of `runs` have been started: their provider turn is in the outbox. */
const started = (runs: ReadonlyArray<{ readonly name: string; readonly runId: RunId }>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly run_id: string }>`
      SELECT json_extract(payload_json, '$.runId') AS run_id
      FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'provider-turn.start'
    `;
    const startedIds = new Set(rows.map((row) => row.run_id));
    return runs.filter((run) => startedIds.has(run.runId)).map((run) => run.name);
  });

/** The run reached its provider, as the provider turn's start reports. */
const reachProvider = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:memory:${runId}:running`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
  });

it.effect(
  "restart-cut runs start none while memory is short, then one at a time in cut order",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const memory = yield* Ref.make<MemoryShortage | null>(short);
      const queue = yield* queueReading(memory);
      const cuts: Array<{ name: string; threadId: ThreadId; cutRunId: RunId }> = [];
      for (const name of ["a", "b", "c"]) {
        cuts.push(yield* cutThread(name));
        yield* TestClock.adjust("1 second");
      }
      // The restart continues them in its own order, not the order they stopped in.
      const continued = new Map<string, { name: string; threadId: ThreadId; runId: RunId }>();
      for (const cut of [cuts[2]!, cuts[0]!, cuts[1]!]) {
        continued.set(cut.name, { ...cut, runId: yield* continueCutRun(cut) });
        yield* TestClock.adjust("1 second");
      }
      const runOf = (name: string) => continued.get(name)!;
      const inCutOrder = cuts.map((cut) => runOf(cut.name));
      const timeline: Array<ReadonlyArray<string>> = [];

      yield* queue.queueChanged;
      timeline.push(yield* started(inCutOrder));
      // Memory frees up; the reading that found it short stands until its recheck.
      yield* Ref.set(memory, null);
      yield* queue.sweep;
      timeline.push(yield* started(inCutOrder));
      yield* TestClock.adjust(MemoryAdmission.SHORTAGE_RECHECK_MS);
      yield* queue.sweep;
      timeline.push(yield* started(inCutOrder));
      // The next waits while the one before it is still on its way to its provider.
      yield* queue.queueChanged;
      timeline.push(yield* started(inCutOrder));
      yield* reachProvider(runOf("a").threadId, runOf("a").runId);
      yield* queue.queueChanged;
      timeline.push(yield* started(inCutOrder));
      // A slow start, such as a long setup script or resume, holds the queue however long it takes.
      yield* TestClock.adjust("10 minutes");
      yield* queue.sweep;
      timeline.push(yield* started(inCutOrder));
      yield* reachProvider(runOf("b").threadId, runOf("b").runId);
      yield* queue.queueChanged;
      timeline.push(yield* started(inCutOrder));

      assert.deepEqual(timeline, [[], [], ["a"], ["a"], ["a", "b"], ["a", "b"], ["a", "b", "c"]]);
      const notices = yield* Effect.forEach(inCutOrder, (run) =>
        orchestrator
          .getThreadProjection(run.threadId)
          .pipe(
            Effect.map(
              (projection) =>
                projection.turnItems.filter(
                  (item) =>
                    item.runId === run.runId &&
                    item.type === "system_notice" &&
                    item.title === "Waiting for memory",
                ).length,
            ),
          ),
      );
      assert.deepEqual(notices, [1, 1, 1], "each waiting run says once that it waits for memory");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("admits a restarted run queued during the initial empty sweep", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const read = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const memory = yield* Ref.make<MemoryShortage | null>(null);
    const queue = yield* queueReading(memory).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        ...projections,
        getMemoryAdmissionQueue: () =>
          projections.getMemoryAdmissionQueue().pipe(
            Effect.tap(() => Deferred.succeed(read, undefined)),
            Effect.tap(() => Deferred.await(release)),
          ),
      }),
    );
    const cut = yield* cutThread("during-sweep");
    const initial = yield* Effect.forkChild(queue.sweep);
    yield* Deferred.await(read);
    const runId = yield* continueCutRun(cut);
    const changed = yield* queue.queueChanged.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(initial);
    yield* Fiber.join(changed);
    assert.deepEqual(yield* started([{ runId, name: cut.name }]), [cut.name]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("admits a restarted run queued between the initial sweep and subscription", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const cut = yield* cutThread("after-sweep");
    const restart = continueCutRun(cut).pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
      Effect.orDie,
    );
    yield* Layer.build(MemoryAdmissionQueue.layer).pipe(
      Effect.provide(MemoryAdmission.layerTest()),
      Effect.provideService(Scheduler.Scheduler, {
        register: (_, sweep) => sweep.pipe(Effect.orDie, Effect.andThen(restart), Effect.asVoid),
      }),
    );
    const admitted = yield* orchestrator
      .streamStoredEventsFrom({ threadId: cut.threadId, eventType: "run.updated" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" && event.payload.memoryAdmission?.admittedAt !== undefined,
        ),
        Stream.runHead,
      );
    assert.isTrue(Option.isSome(admitted));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a person's start is never held, and starts their chat's waiting run at once", () =>
  Effect.gen(function* () {
    const memory = yield* Ref.make<MemoryShortage | null>(short);
    const queue = yield* queueReading(memory);
    const cut = yield* cutThread("held");
    const held = { name: "held", runId: yield* continueCutRun(cut) };
    yield* queue.queueChanged;

    // An agent's message is no person at the chat, nor is a person's steer that the server
    // sends again after its turn ended: both wait behind the held run.
    yield* send(cut.threadId, "from an agent", fromAgent);
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:steer-follow-up:${cut.cutRunId}`),
      threadId: cut.threadId,
      messageId: MessageId.make(`message:${cut.threadId}:work`),
      text: "work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      ...fromPerson,
    });
    const beforePerson = yield* started([held]);
    const fresh = yield* startThread("fresh");
    yield* send(cut.threadId, "go on");

    assert.deepEqual(beforePerson, []);
    assert.deepEqual(yield* started([held, { name: "fresh", runId: fresh.runId }]), [
      "held",
      "fresh",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop ends a waiting run and the next takes its place; a snooze only hides one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const memory = yield* Ref.make<MemoryShortage | null>(short);
    const queue = yield* queueReading(memory);
    const stopped = yield* cutThread("stopped");
    yield* TestClock.adjust("1 second");
    const snoozed = yield* cutThread("snoozed");
    const runs = [
      { name: "stopped", runId: yield* continueCutRun(stopped) },
      { name: "snoozed", runId: yield* continueCutRun(snoozed) },
    ];
    yield* queue.queueChanged;

    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:waiting"),
      threadId: stopped.threadId,
      runId: runs[0]!.runId,
    });
    yield* orchestrator.dispatch({
      type: "thread.snooze",
      commandId: CommandId.make("snooze:waiting"),
      threadId: snoozed.threadId,
      snoozedUntil: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
    });
    yield* Ref.set(memory, null);
    yield* TestClock.adjust(MemoryAdmission.SHORTAGE_RECHECK_MS);
    yield* queue.sweep;

    assert.deepEqual(yield* started(runs), ["snoozed"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an automatic retry of a failed workspace setup waits for memory, set up or not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const memory = yield* Ref.make<MemoryShortage | null>(short);
    const queue = yield* queueReading(memory);
    const threadId = yield* createThread("setup");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("send:setup"),
      threadId,
      messageId: MessageId.make("message:setup"),
      text: "work",
      attachments: [],
      dispatchMode: {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      },
      ...fromPerson,
    });
    const runId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
    const on = (step: string) => ({ commandId: CommandId.make(`${step}:setup`), threadId, runId });
    yield* orchestrator.dispatch({
      type: "prepared-run.fail",
      ...on("fail"),
      failure: {
        class: "transport_error",
        message: "Git could not reach the remote.",
        code: null,
        retryable: true,
      },
    });
    yield* orchestrator.dispatch({ type: "prepared-run.retry", ...on("retry"), automatic: true });
    yield* queue.queueChanged;
    // A setup that finishes while the retry waits leaves it waiting, ready to start.
    yield* orchestrator.dispatch({ type: "prepared-run.release", ...on("release") });
    const whileShort = yield* started([{ name: "setup", runId }]);
    yield* Ref.set(memory, null);
    yield* TestClock.adjust(MemoryAdmission.SHORTAGE_RECHECK_MS);
    yield* queue.sweep;

    assert.deepEqual(whileShort, []);
    assert.deepEqual(yield* started([{ name: "setup", runId }]), ["setup"]);
  }).pipe(Effect.provide(layerTest)),
);
