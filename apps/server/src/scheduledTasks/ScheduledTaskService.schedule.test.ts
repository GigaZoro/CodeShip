import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type MemoryShortage,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  type ServerProvider,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  MessageId,
  RunId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { vi } from "vite-plus/test";
import { originalDemandId } from "../orchestration-v2/demandId.ts";
import { HERE_ENVIRONMENT_ID, layerSharedTaskDependencies } from "./sharedTaskTestLayers.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as RepoConcurrencyAdmission from "../peer/RepoConcurrencyAdmission.ts";
import { UpdateDrain } from "../cloud/updateDrain.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ServerSettings.layerTest(),
      MemoryAdmission.layerTest(),
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      layerSharedTaskDependencies(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit, ScheduledTaskService.CHANGED_IN_APP)).task.title).toBe(
        "Edited",
      );
      yield* service.delete({ id: created.task.id });

      const failure = yield* service
        .upsert(edit, ScheduledTaskService.CHANGED_IN_APP)
        .pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP)).task.id).toBe(
        created.task.id,
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ServerSettings.layerTest(),
      MemoryAdmission.layerTest(),
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      layerSharedTaskDependencies(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update, ScheduledTaskService.CHANGED_IN_APP);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert(
        {
          ...update,
          schedule: { type: "fixed_time", timeOfDay: "09:30" },
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ServerSettings.layerTest(),
      MemoryAdmission.layerTest(),
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      layerSharedTaskDependencies(),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(
        yield* decodeUpsertInput(input("scheduled-task:older")),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* TestClock.adjust("1 second");
      yield* service.upsert(
        yield* decodeUpsertInput(input("scheduled-task:newer")),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled(
        { id: older.task.id, enabled: false },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(
        yield* decodeUpsertInput({ ...edit, enabled: false }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps one queued occurrence of a recurring task while its bound thread is busy", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    // The bound thread's own run never finishes, so every scheduled send lands
    // in its queue and stays there.
    const activeRun = {
      id: RunId.make("run:busy"),
      status: "running",
      userMessageId: MessageId.make("message:busy"),
    } as OrchestrationV2Run;
    const thread = yield* Ref.make<{
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
      readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    }>({ runs: [activeRun], messages: [] });
    const runDueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const sql = yield* SqlClient.SqlClient;
    const outcomeDuringLookup = yield* Ref.make(false);
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      MemoryAdmission.layerTest(),
      layerSharedTaskDependencies(),
      ManagedPolicy.layerTest(),
      // Capture the poll pass so the test drives each due interval directly.
      Layer.mock(Scheduler.Scheduler)({
        register: (name, work) =>
          name !== "scheduled-tasks"
            ? Effect.void
            : Effect.context<Effect.Services<typeof work>>().pipe(
                Effect.flatMap((context) =>
                  Ref.set(runDueWork, work.pipe(Effect.provideContext(context), Effect.ignore)),
                ),
              ),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Ref.modify(thread, (current) => {
            const run = {
              id: RunId.make(`run:${input.messageId}`),
              status: "queued",
              userMessageId: input.messageId,
            } as OrchestrationV2Run;
            const message = {
              id: input.messageId,
              threadId: input.threadId,
              runId: run.id,
              role: "user",
              text: input.text,
              ...(input.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.scheduledTaskId }),
            } as OrchestrationV2ConversationMessage;
            return [
              {
                delivery: "queued",
                run,
                message,
              } as ThreadManagementService.ThreadManagementSendResult,
              { runs: [...current.runs, run], messages: [...current.messages, message] },
            ];
          }),
        getThreadRecords: (_id, fields) =>
          Effect.gen(function* () {
            if (
              fields.some((field) => field === "messages") &&
              (yield* Ref.get(outcomeDuringLookup))
            ) {
              yield* Ref.set(outcomeDuringLookup, false);
              yield* sql`UPDATE scheduled_tasks SET last_run_status = 'failed',
                last_run_error = 'Provider failed' WHERE task_id = 'scheduled-task:busy-thread'`;
            }
            return (yield* Ref.get(thread)) as never;
          }).pipe(Effect.orDie),
        getThreadShell: () =>
          Effect.succeed({
            projectId: "project-busy-thread",
            deletedAt: null,
            archivedAt: null,
          } as never),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decodeUpsertInput({
          id: "scheduled-task:busy-thread",
          title: "Check progress",
          prompt: "Check progress",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: "project-busy-thread",
          threadId: "thread:busy",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      );

      for (let interval = 0; interval < 3; interval++) {
        yield* TestClock.adjust("61 seconds");
        yield* Effect.flatten(Ref.get(runDueWork));
      }

      const queuedOccurrencesOf = (taskId: typeof task.id) =>
        Ref.get(thread).pipe(
          Effect.map(
            ({ runs, messages }) =>
              runs
                .filter((run) => run.status === "queued")
                .map((run) => messages.find((message) => message.id === run.userMessageId))
                .filter((message) => message?.scheduledTaskId === taskId).length,
          ),
        );
      const queuedOccurrences = queuedOccurrencesOf(task.id);
      expect(yield* queuedOccurrences).toBe(1);
      // Skipped intervals still move the schedule forward.
      const [listed] = (yield* service.list()).tasks;
      expect(Date.parse(listed?.nextRunAt ?? "")).toBeGreaterThan(
        Date.parse("2026-07-01T09:03:03.000Z"),
      );

      yield* Ref.update(thread, (current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.status === "queued" ? { ...run, queueHeld: true } : run,
        ),
      }));
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      const [blocked] = (yield* service.list()).tasks;
      expect(blocked?.lastRunStatus).toBe("failed");
      expect(blocked?.lastRunError).toBe(
        "A previous occurrence is held in the thread queue. Resume or remove it to run this task again.",
      );
      expect(yield* queuedOccurrences).toBe(1);

      // The prior run can finish while the poll is looking up its held occurrence.
      yield* sql`UPDATE scheduled_tasks SET last_run_status = 'succeeded', last_run_error = NULL
        WHERE task_id = ${task.id}`;
      yield* Ref.set(outcomeDuringLookup, true);
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      const [raced] = (yield* service.list()).tasks;
      expect(raced?.lastRunStatus).toBe("failed");
      expect(raced?.lastRunError).toBe("Provider failed");
      expect(Date.parse(raced?.nextRunAt ?? "")).toBeGreaterThan(
        Date.parse(blocked?.nextRunAt ?? ""),
      );

      // Run now is an explicit request, so it still queues behind the held one.
      yield* service.runNow({ id: task.id });
      expect(yield* queuedOccurrences).toBe(2);

      // Once the queued copies start, the next interval sends again.
      yield* Ref.update(thread, (current) => ({
        ...current,
        runs: current.runs.map((run) =>
          run.status === "queued" ? ({ ...run, status: "running" } as OrchestrationV2Run) : run,
        ),
      }));
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      expect(yield* queuedOccurrences).toBe(1);
      const [resumed] = (yield* service.list()).tasks;
      expect(resumed?.lastRunStatus).toBe("succeeded");
      expect(resumed?.lastRunError).toBeNull();

      // A one-time task's only scheduled occurrence still sends behind a queued Run now.
      const { task: once } = yield* service.upsert(
        yield* decodeUpsertInput({
          id: "scheduled-task:busy-thread-once",
          title: "Check once",
          prompt: "Check once",
          enabled: true,
          schedule: { type: "once", runAt: "2026-07-01T09:07:00.000Z" },
          projectId: "project-busy-thread",
          threadId: "thread:busy",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* service.runNow({ id: once.id });
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      expect(yield* queuedOccurrencesOf(once.id)).toBe(2);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "idle polls still wake for tasks saved later, recorded due times, and beside far-future tasks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
      const launched = yield* Deferred.make<string>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ServerSettings.layerTest(),
        MemoryAdmission.layerTest(),
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Deferred.succeed(launched, input.title).pipe(
              Effect.as({ threadId: "thread-idle-poll", resumed: false } as never),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        layerSharedTaskDependencies(),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        // The first poll finds no tasks and remembers that nothing is due.
        yield* TestClock.adjust("6 seconds");
        // Its year-10000+ next run sorts first as text; it must not hide the task below.
        yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Far future",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 3e14 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const created = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Idle poll",
            prompt: "Review the open pull requests.",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: "project-idle-poll",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        // This poll records the new task's due time; the later ones must still fire it.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(launched)).toBe(created.task.title);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { drain: "90 minutes", launches: 1, run: { outcome: "succeeded" } },
  { drain: "6 hours", launches: 1, run: { outcome: "succeeded" } },
  { drain: "14 hours", launches: 0, run: { outcome: "skipped", skipReason: "next_run_sooner" } },
] as const)(
  "never counts a fixed-time run an update's drain held for $drain as missed",
  ({ drain, launches, run }) =>
    Effect.gen(function* () {
      const at = (day: number, hour: number) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 7, day, hour, minute: 0, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      const isoAt = (day: number, hour: number) =>
        DateTime.formatIso(DateTime.toUtc(at(day, hour)));
      yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6)));
      const launched = yield* Ref.make(0);
      const layer = runHistoryLayer(() =>
        Ref.update(launched, (count) => count + 1).pipe(
          Effect.as({ threadId: ThreadId.make("thread-held"), resumed: false } as never),
        ),
      );
      // The update drains running turns past the task's time, then installs and restarts.
      const task = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* historyTask("Held by drain", { catchUpMissedRun: false }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* TestClock.adjust(drain);
        expect(yield* Ref.get(launched)).toBe(0);
        return task;
      }).pipe(
        Effect.provide(layer),
        Effect.provideServiceEffect(
          UpdateDrain,
          SubscriptionRef.make({ holders: 1, admitting: 0 }),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const settled = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some(
              (entry) => entry.nextRunAt === isoAt(2, 7) && entry.lastRunStatus !== "running",
            ),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(settled);
        expect(yield* Ref.get(launched)).toBe(launches);
        expect((yield* service.listRuns({ id: task.id })).runs).toMatchObject([
          { ...run, scheduledFor: isoAt(1, 7) },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("runs a fixed-time run an update held once a restart cut its run condition", () =>
  Effect.gen(function* () {
    const at = (day: number, hour: number) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day, hour, minute: 0, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
    const isoAt = (day: number, hour: number) => DateTime.formatIso(DateTime.toUtc(at(day, hour)));
    yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6)));
    const launched = yield* Ref.make(0);
    const firstCheck = yield* Deferred.make<void>();
    const layer = runHistoryLayer(
      () =>
        Ref.update(launched, (count) => count + 1).pipe(
          Effect.as({ threadId: ThreadId.make("thread-held"), resumed: false } as never),
        ),
      Layer.empty,
      MemoryAdmission.layerTest(),
      layerSharedTaskDependencies(
        [
          {
            id: "project-run-history",
            title: "Run history",
            workspaceRoot: "/work/run-history",
            canonicalKey: null,
          },
        ],
        undefined,
        // The first check never answers: a restart cuts it.
        Layer.mock(RunConditionCheck.RunConditionCheck)({
          run: () =>
            Deferred.succeed(firstCheck, undefined).pipe(
              Effect.flatMap((first) =>
                first
                  ? Effect.never
                  : Effect.succeed({ outcome: "run", failure: null, exitCode: 0, detail: null }),
              ),
            ),
        }),
      ),
    );
    const task = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* historyTask("Held, then cut", {
          catchUpMissedRun: false,
          runCondition: { command: "node ~/check.mjs" },
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* TestClock.adjust("90 minutes");
      return task;
    }).pipe(
      Effect.provide(layer),
      Effect.provideServiceEffect(UpdateDrain, SubscriptionRef.make({ holders: 1, admitting: 0 })),
    );

    yield* Effect.gen(function* () {
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.await(firstCheck);
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settled = yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) =>
          tasks.some(
            (entry) => entry.nextRunAt === isoAt(2, 7) && entry.lastRunStatus !== "running",
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* TestClock.adjust("6 seconds");
      yield* Fiber.join(settled);
      expect(yield* Ref.get(launched)).toBe(1);
      expect((yield* service.listRuns({ id: task.id })).runs).toMatchObject([
        { outcome: "succeeded", scheduledFor: isoAt(1, 7) },
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const runHistoryLayer = (
  launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"],
  accountRouting: Layer.Layer<never> = Layer.empty,
  memory: Layer.Layer<MemoryAdmission.MemoryAdmission> = MemoryAdmission.layerTest(),
  sharedDependencies: ReturnType<
    typeof layerSharedTaskDependencies
  > = layerSharedTaskDependencies(),
  threads = Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  repoAdmission: Layer.Layer<RepoConcurrencyAdmission.RepoConcurrencyAdmission> = RepoConcurrencyAdmission.layerTest(),
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ServerSettings.layerTest(),
        memory,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        threads,
        sharedDependencies,
        Layer.mock(SecretRequests.SecretRequests)({}),
        accountRouting,
        repoAdmission,
      ),
    ),
  );

const historyTask = (title: string, overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    title,
    prompt: "Publish today's lessons.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "07:00" },
    projectId: "project-run-history",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "claude_primary", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

it.effect(
  "catches up a daily run missed while the app was off once, and records skipped fires",
  () =>
    Effect.gen(function* () {
      const at = (day: number, hour: number) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 11, day, hour, minute: 0, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      const isoAt = (day: number, hour: number) =>
        DateTime.formatIso(DateTime.toUtc(at(day, hour)));
      yield* TestClock.setTime(DateTime.toEpochMillis(at(10, 12)));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      const prompts = yield* Ref.make<ReadonlyArray<string | null | undefined>>([]);
      const layer = runHistoryLayer((input) =>
        Ref.update(launched, (titles) => [...titles, input.title]).pipe(
          Effect.andThen(Ref.update(prompts, (ids) => [...ids, input.initialMessage?.messageId])),
          Effect.as({ threadId: ThreadId.make("thread-caught-up"), resumed: false } as never),
        ),
      );
      const { daily, off, weekly } = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const daily = (yield* service.upsert(
          yield* historyTask("Daily"),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        const off = (yield* service.upsert(
          yield* historyTask("No catch-up", { catchUpMissedRun: false }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        const weekly = (yield* service.upsert(
          yield* historyTask("Mondays", {
            schedule: { type: "fixed_time", timeOfDay: "07:00", weekdays: [1] },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        return { daily, off, weekly };
      }).pipe(Effect.provide(layer));
      expect([daily, off, weekly].map((task) => task.catchUpMissedRun)).toEqual([
        true,
        false,
        true,
      ]);

      // The app is off from the 10th until 09:00 on the 13th: three daily times pass.
      yield* TestClock.setTime(DateTime.toEpochMillis(at(13, 9)));
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const settled = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.every(
              (task) =>
                task.id === weekly.id ||
                (task.nextRunAt === isoAt(14, 7) && task.lastRunStatus !== "running"),
            ),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(settled);

        expect(yield* Ref.get(launched)).toEqual(["Daily"]);
        const [caughtUp] = (yield* service.listRuns({ id: daily.id })).runs;
        expect(caughtUp).toMatchObject({
          trigger: "catch_up",
          scheduledFor: isoAt(13, 7),
          outcome: "succeeded",
          threadId: "thread-caught-up",
          failover: null,
        });
        // It launches under its scheduled fire's key, where startup recovery looks for its prompt.
        expect(yield* Ref.get(prompts)).toEqual([
          `scheduled-task-message:${caughtUp?.id.replace(/:catch_up$/, ":scheduled")}`,
        ]);
        expect((yield* service.listRuns({ id: off.id })).runs).toMatchObject([
          { outcome: "skipped", skipReason: "missed", scheduledFor: isoAt(13, 7) },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "catches up a weekly or weekday run missed while the app was off once, unless the next run is sooner",
  () =>
    Effect.gen(function* () {
      const at = (day: number, hour: number) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 11, day, hour, minute: 0, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      const isoAt = (day: number, hour: number) =>
        DateTime.formatIso(DateTime.toUtc(at(day, hour)));
      // Sunday 2026-11-08.
      yield* TestClock.setTime(DateTime.toEpochMillis(at(8, 12)));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = runHistoryLayer((input) =>
        Ref.update(launched, (titles) => [...titles, input.title]).pipe(
          Effect.as({ threadId: ThreadId.make("thread-caught-up"), resumed: false } as never),
        ),
      );
      const { weekly, weekdays } = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const weekly = (yield* service.upsert(
          yield* historyTask("Mondays", {
            schedule: { type: "fixed_time", timeOfDay: "07:00", weekdays: [1] },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        const weekdays = (yield* service.upsert(
          yield* historyTask("Weekdays", {
            schedule: { type: "fixed_time", timeOfDay: "07:00", weekdays: [1, 2, 3, 4, 5] },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        return { weekly, weekdays };
      }).pipe(Effect.provide(layer));
      expect([weekly.catchUpMissedRun, weekdays.catchUpMissedRun]).toEqual([true, true]);

      // The app is off until `day` `hour`, then settles until both tasks wait for their next runs.
      // The clock moves before the service starts: a running scheduler would fire on time.
      const backAt = (day: number, hour: number, next: { weekly: string; weekdays: string }) =>
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const settled = yield* service.subscribeList().pipe(
            Stream.filter(({ tasks }) =>
              tasks.every(
                (task) =>
                  task.nextRunAt === (task.id === weekly.id ? next.weekly : next.weekdays) &&
                  task.lastRunStatus !== "running",
              ),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* TestClock.adjust("6 seconds");
          yield* Fiber.join(settled);
          const [weeklyRun] = (yield* service.listRuns({ id: weekly.id })).runs;
          const [weekdaysRun] = (yield* service.listRuns({ id: weekdays.id })).runs;
          return { weeklyRun, weekdaysRun };
        }).pipe(Effect.provide(layer), (started) =>
          TestClock.setTime(DateTime.toEpochMillis(at(day, hour))).pipe(Effect.andThen(started)),
        );

      // Monday 20:00: Monday's run is 13 hours late, and the weekly task's next is a week off;
      // the weekday task's next run, Tuesday 07:00, is sooner.
      const monday = yield* backAt(9, 20, { weekly: isoAt(16, 7), weekdays: isoAt(10, 7) });
      expect(yield* Ref.get(launched)).toEqual(["Mondays"]);
      expect(monday.weeklyRun).toMatchObject({
        trigger: "catch_up",
        scheduledFor: isoAt(9, 7),
        outcome: "succeeded",
      });
      expect(monday.weekdaysRun).toMatchObject({
        outcome: "skipped",
        skipReason: "next_run_sooner",
        scheduledFor: isoAt(9, 7),
      });

      // Saturday 12:00: Friday's run is 29 hours late and the next one is Monday, 43 hours off.
      const saturday = yield* backAt(14, 12, { weekly: isoAt(16, 7), weekdays: isoAt(16, 7) });
      expect(yield* Ref.get(launched)).toEqual(["Mondays", "Weekdays"]);
      expect(saturday.weekdaysRun).toMatchObject({
        trigger: "catch_up",
        scheduledFor: isoAt(13, 7),
        outcome: "succeeded",
      });

      // Sunday 2026-11-22 20:00: both missed runs are days old and Monday 07:00 is 11 hours off.
      const sunday = yield* backAt(22, 20, { weekly: isoAt(23, 7), weekdays: isoAt(23, 7) });
      expect(yield* Ref.get(launched)).toEqual(["Mondays", "Weekdays"]);
      expect(sunday.weeklyRun).toMatchObject({
        outcome: "skipped",
        skipReason: "next_run_sooner",
        scheduledFor: isoAt(16, 7),
      });
      expect(sunday.weekdaysRun).toMatchObject({
        outcome: "skipped",
        skipReason: "next_run_sooner",
        scheduledFor: isoAt(20, 7),
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps a run that failed before it had a thread, next to the run after it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
    const attempts = yield* Ref.make(0);
    const layer = runHistoryLayer(() =>
      Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((count) =>
          count === 1
            ? Effect.die(new Error("Claude is out of usage until Friday."))
            : Effect.succeed({ threadId: ThreadId.make("thread-second"), resumed: false } as never),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* historyTask("Flaky"),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      expect((yield* service.runNow({ id: task.id })).task.lastRunStatus).toBe("failed");
      yield* TestClock.adjust("1 minute");
      expect((yield* service.runNow({ id: task.id })).task.lastRunStatus).toBe("succeeded");

      const runs = (yield* service.listRuns({ id: task.id })).runs;
      expect(runs).toMatchObject([
        { trigger: "manual", outcome: "succeeded", threadId: "thread-second", error: null },
        { trigger: "manual", outcome: "failed", threadId: null },
      ]);
      expect(runs[1]?.error).toContain("Claude is out of usage until Friday.");

      // Each task keeps its latest 50 runs, and older ones from the last 90 days; the list shows
      // the newest 100, room for 50 runs and the five quiet skip buckets.
      const sql = yield* SqlClient.SqlClient;
      const insertRun = (runId: string, startedAt: string) =>
        sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome)
          VALUES (${runId}, ${task.id}, 'scheduled', ${startedAt}, 'succeeded')`;
      yield* insertRun("expired", "2026-08-01T00:00:00.000Z");
      yield* insertRun("in-window", "2026-08-13T00:00:00.000Z");
      for (let index = 0; index < 100; index += 1) {
        yield* insertRun(
          `recent-${index}`,
          DateTime.formatIso(
            DateTime.makeUnsafe(Date.parse("2026-11-01T00:00:00.000Z") + index * 1000),
          ),
        );
      }
      yield* TestClock.adjust("1 minute");
      yield* service.runNow({ id: task.id });
      const kept = (yield* service.listRuns({ id: task.id })).runs;
      expect(kept).toHaveLength(100);
      expect(kept[0]?.threadId).toBe("thread-second");
      const stored = yield* sql<{ run_id: string }>`
        SELECT run_id FROM scheduled_task_runs WHERE run_id IN ('expired', 'in-window')`;
      expect(stored).toEqual([{ run_id: "in-window" }]);
      const counted = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ${task.id}`;
      expect(counted).toEqual([{ count: 104 }]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { why: "out of usage", failover: { reason: "usageLimit" } },
  {
    why: "must sign in to an MCP server again",
    failover: { reason: "mcpSignIn", mcpServers: ["threadpage"] },
  },
] as const)(
  "starts a new thread on another account when the task's account is $why",
  ({ failover }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const launchedOn = yield* Ref.make<ReadonlyArray<string>>([]);
      const spare = ProviderInstanceId.make("claude_spare");
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launchedOn, (ids) => [...ids, input.modelSelection.instanceId]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-spare"), resumed: false } as never),
          ),
        Layer.succeed(AccountRouting.AccountRouting, {
          accountsWithRoom: () => Effect.succeed([]),
          scheduledRunBlock: () => Effect.succeed(null),
          releaseAllowedHolds: Effect.succeed(false),
          route: (input) => Effect.succeed(input.selection),
          failoverLaunch: (input) =>
            Effect.succeed({
              selection: { ...input.selection, instanceId: spare },
              failover,
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
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* historyTask("Limited"),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.runNow({ id: task.id });
        expect(yield* Ref.get(launchedOn)).toEqual([spare]);
        expect((yield* service.listRuns({ id: task.id })).runs).toMatchObject([
          { outcome: "succeeded", failover: { from: "claude_primary", to: spare, ...failover } },
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "skips a scheduled run while every account it needs is out of usage, and runs the next once one has room",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      const until = "2026-11-10T17:00:00.000Z";
      const codex = ProviderDriverKind.make("codex");
      const block = yield* Ref.make<AccountRouting.UsageBlock | null>({
        driver: codex,
        until,
        accounts: [ProviderInstanceId.make("codex_main")],
      });
      const asked = yield* Ref.make<
        ReadonlyArray<Parameters<AccountRouting.AccountRouting["Service"]["scheduledRunBlock"]>[0]>
      >([]);
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launched, (titles) => [...titles, input.title]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-room"), resumed: false } as never),
          ),
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: (input) =>
            Ref.update(asked, (inputs) => [...inputs, input]).pipe(Effect.andThen(Ref.get(block))),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* historyTask("Autopilot", {
            schedule: { type: "interval", everyMs: 60_000 },
            delegateProviders: ["codex"],
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        // Its only occurrence would be lost, so a one-time task waits for the room instead.
        const { task: once } = yield* service.upsert(
          yield* historyTask("Once", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        expect(task.delegateProviders).toEqual(["codex"]);
        const settled = (done: (tasks: ReadonlyArray<ScheduledTask>) => boolean) =>
          service.subscribeList().pipe(
            Stream.filter(({ tasks }) => done(tasks)),
            Stream.runHead,
            Effect.forkChild,
          );
        const byId = (tasks: ReadonlyArray<ScheduledTask>, id: string) =>
          tasks.find((entry) => entry.id === id);

        const skipped = yield* settled(
          (tasks) =>
            byId(tasks, task.id)?.nextRunAt !== task.nextRunAt &&
            byId(tasks, once.id)?.nextRunAt === until,
        );
        yield* TestClock.adjust("65 seconds");
        yield* Fiber.join(skipped);

        expect(yield* Ref.get(launched)).toEqual([]);
        expect((yield* Ref.get(asked)).find((input) => input.delegates.length > 0)).toMatchObject({
          selection: { instanceId: "claude_primary" },
          delegates: ["codex"],
        });
        expect((yield* service.listRuns({ id: task.id })).runs).toEqual([
          expect.objectContaining({
            trigger: "scheduled",
            scheduledFor: task.nextRunAt,
            outcome: "skipped",
            skipReason: "usage_limited",
            threadId: null,
            usageLimit: { driver: "codex", until },
          }),
        ]);
        const listed = (yield* service.list()).tasks;
        expect(byId(listed, task.id)).toMatchObject({ runCount: 0, lastRunAt: null });

        // Peers read the occurrence from the task row, which history writes may not have reached.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER no_run_history BEFORE INSERT ON scheduled_task_runs
          BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`;
        yield* Ref.set(block, null);
        const ran = yield* settled((tasks) => byId(tasks, task.id)?.lastRunStatus === "succeeded");
        yield* TestClock.adjust("65 seconds");
        yield* Fiber.join(ran);
        expect(yield* Ref.get(launched)).toContain("Autopilot");
        expect(byId((yield* service.list()).tasks, task.id)).toMatchObject({
          runCount: 1,
          lastRunScheduledFor: "2026-11-10T12:02:00.000Z",
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { scenario: "configured alternative", explicit: true, codexLimited: false },
  { scenario: "Auto model", explicit: false, codexLimited: false },
  { scenario: "all providers limited", explicit: true, codexLimited: true },
])("routes a scheduled occurrence with $scenario", ({ explicit, codexLimited }) =>
  Effect.gen(function* () {
    const start = "2026-11-10T12:00:00.000Z";
    const codexReset = "2026-11-10T14:00:00.000Z";
    const claudeReset = "2026-11-11T12:00:00.000Z";
    yield* TestClock.setTime(Date.parse(start));
    const codex = ProviderInstanceId.make("codex_test");
    const claude = ProviderInstanceId.make("claude_primary");
    const alternative = {
      instanceId: codex,
      model: "gpt-alternative",
      options: [{ id: "reasoningEffort", value: "high" }],
    } satisfies ModelSelection;
    const provider = (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      models: ReadonlyArray<string>,
    ): ServerProvider => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: start,
      models: models.map((slug) => ({
        slug,
        name: slug,
        aliases: [],
        isCustom: false,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    });
    const refusals = new Map([
      [claude, [{ resetAt: claudeReset, refusedAt: start }]],
      ...(codexLimited ? [[codex, [{ resetAt: codexReset, refusedAt: start }]] as const] : []),
    ]);
    const routing = AccountRouting.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            failoverLimitedThreads: true,
            autoModeModels: { [ProviderDriverKind.make("codex")]: { model: "gpt-auto" } },
            providerInstances: {
              [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true },
              [claude]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
            },
          }).pipe(Layer.orDie),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider(claude, ProviderDriverKind.make("claudeAgent"), ["claude-opus-5-5"]),
              provider(codex, ProviderDriverKind.make("codex"), ["gpt-auto", alternative.model]),
            ]),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getUsageLimitedProviderInstances: () => Effect.succeed(refusals),
          }),
          Layer.mock(ProviderMcp.ProviderMcp)({
            listLoaded: () => Effect.succeedNone,
            discover: () => Effect.succeedNone,
          }),
        ),
      ),
    );
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
    const layer = runHistoryLayer(
      (input) =>
        Ref.update(launches, (seen) => [...seen, input]).pipe(
          Effect.as({ threadId: ThreadId.make("thread-codex"), resumed: false } as never),
        ),
      routing,
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* historyTask("Routed occurrence", {
          schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          ...(explicit ? { fallbackModelSelections: [alternative] } : {}),
        }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      if (explicit) expect(task.fallbackModelSelections).toEqual([alternative]);
      const done = yield* service.subscribeList().pipe(
        Stream.filter(({ tasks }) =>
          tasks.some(
            (row) =>
              row.id === task.id &&
              (codexLimited ? row.nextRunAt === codexReset : row.lastRunStatus === "succeeded"),
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* TestClock.adjust("35 seconds");
      yield* Fiber.join(done);
      const { runs } = yield* service.listRuns({ id: task.id });
      const sent = yield* Ref.get(launches);
      if (codexLimited) {
        expect(sent).toEqual([]);
        expect(runs).toMatchObject([
          {
            outcome: "skipped",
            skipReason: "usage_limited",
            usageLimit: { driver: "codex", until: codexReset },
          },
        ]);
      } else {
        expect(sent).toMatchObject([
          {
            modelSelection: explicit ? alternative : { instanceId: codex, model: "gpt-auto" },
            initialMessage: { crossProviderFailoverFrom: claude },
          },
        ]);
        expect(runs).toMatchObject([
          { outcome: "succeeded", failover: { from: claude, to: codex, reason: "usageLimit" } },
        ]);
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { why: "returns before its next time", untilAt: [10, 12], nextAt: [10, 12] },
  { why: "returns after its next time", untilAt: [11, 9], nextAt: [11, 7] },
  { why: "has no known reset time", untilAt: null, nextAt: [11, 7] },
] as const)(
  "a fixed-time run skipped for usage waits once for the room when it $why",
  ({ untilAt, nextAt }) =>
    Effect.gen(function* () {
      const at = (day: number, hour: number, minute = 0) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 11, day, hour, minute, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      const isoAt = (day: number, hour: number) =>
        DateTime.formatIso(DateTime.toUtc(at(day, hour)));
      yield* TestClock.setTime(DateTime.toEpochMillis(at(10, 6, 59)));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      const until = untilAt === null ? null : isoAt(untilAt[0], untilAt[1]);
      const block = yield* Ref.make<AccountRouting.UsageBlock | null>({
        driver: ProviderDriverKind.make("claude"),
        until,
        accounts: [ProviderInstanceId.make("claude_primary")],
      });
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launched, (titles) => [...titles, input.title]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-room"), resumed: false } as never),
          ),
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: () => Ref.get(block),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* historyTask("Daily"),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const waiting = yield* service.subscribeList().pipe(
          Stream.filter(
            ({ tasks }) => tasks.find((t) => t.id === task.id)?.nextRunAt !== task.nextRunAt,
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("90 seconds");
        yield* Fiber.join(waiting);
        expect((yield* service.list()).tasks.find((t) => t.id === task.id)?.nextRunAt).toBe(
          isoAt(nextAt[0], nextAt[1]),
        );

        yield* Ref.set(block, null);
        const ran = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some((entry) => entry.id === task.id && entry.lastRunStatus === "succeeded"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.setTime(Date.parse(isoAt(nextAt[0], nextAt[1])) + 5_000);
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(ran);
        expect(yield* Ref.get(launched)).toEqual(["Daily"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  {
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T07:00Z",
    last: "2026-11-10T07:30Z",
    next: "2026-11-11T07:00Z",
    legacy: "",
    late: true,
  },
  ...[false, true].map((late) => ({
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T07:25Z",
    last: "2026-11-10T08:00Z",
    next: "2026-11-11T07:00Z",
    legacy: "",
    late,
    probe: "move-after-slot",
  })),
  {
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T06:50Z",
    last: "2026-11-10T08:00Z",
    next: "2026-11-11T07:00Z",
    legacy: "",
    late: true,
    probe: "superseded",
  },
  {
    from: "UTC",
    to: "UTC",
    first: "2026-11-10T07:00Z",
    retry: "2026-11-10T09:00Z",
    last: "2026-11-10T09:30Z",
    next: "2026-11-11T09:00Z",
    legacy: "",
    late: false,
    probe: "reschedule",
  },
  {
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T07:00Z",
    last: "2026-11-10T07:30Z",
    next: "2026-11-11T07:00Z",
    legacy: "migrate",
    late: true,
    probe: "migrate",
  },
  {
    from: "Europe/London",
    to: "UTC",
    first: "2026-03-28T07:00Z",
    retry: "2026-03-29T05:55Z",
    last: "2026-03-29T06:30Z",
    next: "2026-03-29T07:00Z",
    legacy: "",
    late: false,
  },
  ...[true, false].map((late) => ({
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T05:05Z",
    last: "2026-11-10T05:30Z",
    next: "2026-11-10T07:00Z",
    legacy: "",
    late,
  })),
  {
    from: "Europe/Kyiv",
    to: "Europe/London",
    first: "2026-11-10T05:00Z",
    retry: "2026-11-10T07:00Z",
    last: "2026-11-10T07:30Z",
    next: "2026-11-11T07:00Z",
    legacy: "history",
    late: true,
  },
  ...["history", "no zone"].map((legacy) => ({
    from: "America/Los_Angeles",
    to: "Europe/Kyiv",
    first: "2026-11-10T15:00Z",
    retry: "2026-11-10T15:05Z",
    last: "2026-11-10T15:30Z",
    next: "2026-11-11T05:00Z",
    legacy,
    late: true,
  })),
])(
  "admits the held fixed time from $from after restart in $to (retry=$retry, legacy=$legacy, late=$late)",
  (scenario) =>
    Effect.gen(function* () {
      const { from, to, first, retry, last, next, legacy, late } = scenario;
      const probe = "probe" in scenario ? scenario.probe : undefined;
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("TZ", from)),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const iso = (at: string) => DateTime.formatIso(DateTime.makeUnsafe(at));
      yield* TestClock.setTime(
        Date.parse(first) - (legacy === "history" ? 23 * 3_600_000 : 60_000),
      );
      const demands: Array<string | null | undefined> = [];
      let until: string | null = iso(retry);
      const layer = runHistoryLayer(
        (input) =>
          Effect.sync(() => {
            demands.push(input.initialMessage?.demandId);
            return { threadId: ThreadId.make("held"), resumed: false } as never;
          }),
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: () =>
            Effect.succeed(
              until === null
                ? null
                : {
                    driver: ProviderDriverKind.make("claude"),
                    until,
                    accounts: [ProviderInstanceId.make("claude_primary")],
                  },
            ),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      );
      const input = yield* historyTask("Held fixed time");
      const task = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        return (yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP)).task;
      }).pipe(Effect.provide(layer));
      expect(task.nextRunAt).toBe(iso(first));
      const poll = (when: number) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(when);
          return yield* Effect.gen(function* () {
            const service = yield* ScheduledTaskService.ScheduledTaskService;
            yield* TestClock.adjust("6 seconds");
            return (yield* service.list()).tasks[0]!;
          }).pipe(Effect.provide(layer));
        });
      expect((yield* poll(Date.parse(first))).nextRunAt).toBe(iso(retry));
      const sql = yield* SqlClient.SqlClient;
      if (probe === "move-after-slot") yield* TestClock.setTime(Date.parse("2026-11-10T07:22Z"));
      if (probe === "reschedule") {
        yield* TestClock.setTime(Date.parse("2026-11-10T07:05Z"));
        yield* Effect.gen(function* () {
          const svc = yield* ScheduledTaskService.ScheduledTaskService;
          const edited = yield* svc.upsert(
            { ...input, id: task.id, schedule: { type: "fixed_time", timeOfDay: "09:00" } },
            ScheduledTaskService.CHANGED_IN_APP,
          );
          expect(edited.task.nextRunAt).toBe(iso(retry));
        }).pipe(Effect.provide(layer));
      }
      if (legacy === "migrate") {
        yield* sql`DROP TRIGGER scheduled_task_clear_usage_hold`;
        yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN incarnation_id`;
        yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN usage_hold_json`;
      } else if (legacy) {
        yield* sql`UPDATE scheduled_tasks SET usage_hold_json = ${legacy === "history" ? sql`NULL` : sql`json_remove(usage_hold_json, '$.heldOccurrence.timeZone')`} WHERE task_id = ${task.id}`;
      }
      vi.stubEnv("TZ", to);
      until = iso(last);
      expect((yield* poll(Date.parse(retry) + (late ? 15 * 60_000 : 0))).nextRunAt).toBe(iso(last));
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const edit = yield* service.upsert(
          {
            ...input,
            id: task.id,
            schedule: { type: "fixed_time", timeOfDay: probe === "reschedule" ? "9:00" : "7:00" },
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        expect(edit.task.nextRunAt).toBe(iso(last));
      }).pipe(Effect.provide(layer));
      until = null;
      expect((yield* poll(Date.parse(last))).nextRunAt).toBe(iso(next));
      yield* poll(Date.parse(next));
      const [row] = yield* sql<{
        incarnation_id: string;
      }>`SELECT incarnation_id FROM scheduled_tasks WHERE task_id = ${task.id}`;
      const demand = (at: string) =>
        originalDemandId(
          "scheduled-task",
          HERE_ENVIRONMENT_ID,
          task.id,
          row!.incarnation_id ?? task.createdAt,
          "scheduled",
          iso(at),
        );
      expect(demands).toEqual([
        legacy
          ? null
          : demand(
              probe === "reschedule" ? retry : probe === "superseded" ? "2026-11-10T07:00Z" : first,
            ),
        demand(next),
      ]);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("separates bound fixed-time runs of tasks recreated in the same clock tick", () =>
  Effect.gen(function* () {
    const demands: Array<string | null | undefined> = [];
    const layer = runHistoryLayer(
      () => Effect.die("expected a bound send"),
      undefined,
      undefined,
      undefined,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            demands.push(input.demandId);
            return {} as never;
          }),
        getThreadShell: () =>
          Effect.succeed({
            projectId: "project-run-history",
            deletedAt: null,
            archivedAt: null,
          } as never),
        getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
      }),
    );
    const due = DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 10, hour: 7 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    const dueMs = DateTime.toEpochMillis(due);
    const input = yield* historyTask("Bound", { id: "recreated", threadId: "bound" });
    for (const replace of [false, true]) {
      yield* TestClock.setTime(dueMs - 60_000);
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        if (replace) yield* service.delete({ id: input.id! });
        const { task } = yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP);
        expect(task.nextRunAt).toBe(DateTime.formatIso(DateTime.toUtc(due)));
        yield* TestClock.adjust("65 seconds");
        expect((yield* service.listRuns({ id: task.id })).runs).toMatchObject([
          { outcome: "succeeded", scheduledFor: task.nextRunAt },
        ]);
      }).pipe(Effect.provide(layer));
    }
    expect(demands).toEqual([expect.stringMatching(/^demand:/), expect.stringMatching(/^demand:/)]);
    expect(demands[0]).not.toBe(demands[1]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { restart: false, until: null },
  { restart: true, until: null },
  { restart: false, until: "2026-12-01T00:00:00.000Z" },
  { restart: true, until: "2026-12-01T00:00:00.000Z" },
])(
  "readmits a once usage wait when capacity returns (restart: $restart, until: $until)",
  ({ restart, until }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const snapshots = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const account = (
        balanceState: "available" | "exhausted",
        auth: "authenticated" | "unauthenticated" = "authenticated",
      ): ServerProvider => ({
        instanceId: ProviderInstanceId.make("claude_api"),
        driver: ProviderDriverKind.make("claudeAgent"),
        billingKind: until === null ? "plan" : "payPerUse",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: auth },
        checkedAt: "2026-11-10T12:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        usageLimits: {
          checkedAt: "2026-11-10T12:00:00.000Z",
          windows: [],
          usageAllowed: balanceState === "available",
        },
        payPerUse:
          until === null
            ? undefined
            : {
                linkedPlanInstanceId: ProviderInstanceId.make("claude_plan"),
                grantUsd: 50,
                meteringStartedAt: "2026-09-01T00:00:00.000Z",
                unpricedUsage: false,
                cycleStart: "2026-09-01T00:00:00.000Z",
                cycleEnd: "2026-12-01T00:00:00.000Z",
                estimatedRemainingUsd: 48,
                balanceState,
                checkedAt: "2026-11-10T12:00:00.000Z",
                spendSource: "metered",
                spendUsd: null,
              },
      });
      const provider = yield* Ref.make(account("exhausted"));
      const launches = yield* Ref.make<ReadonlyArray<string>>([]);
      const dependencies = Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Ref.get(provider).pipe(Effect.map((value) => [value])),
          streamChanges: Stream.fromQueue(snapshots),
        }),
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: () =>
            Ref.get(provider).pipe(
              Effect.map((value) =>
                value.usageLimits?.usageAllowed === true ||
                value.payPerUse?.balanceState === "available"
                  ? null
                  : {
                      driver: value.driver,
                      until,
                      accounts: [value.instanceId],
                    },
              ),
            ),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
      );
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launches, (titles) => [...titles, input.title]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-recredited"), resumed: false } as never),
          ),
        dependencies,
      );
      const awaitTask = (
        service: ScheduledTaskService.ScheduledTaskService["Service"],
        title: string,
        done: (task: ScheduledTask) => boolean,
      ) =>
        service.subscribeList().pipe(
          Stream.filter(({ tasks }) => tasks.some((task) => task.title === title && done(task))),
          Stream.runHead,
        );
      const resumed = Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const ran = yield* awaitTask(
          service,
          "Waiting",
          (task) => task.lastRunStatus === "succeeded",
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(ran);
        expect(yield* Ref.get(launches)).toEqual(["Waiting"]);
        expect((yield* service.list()).tasks.find((task) => task.title === "Paused")?.enabled).toBe(
          false,
        );
      });
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const waiting = yield* service.upsert(
          yield* historyTask("Waiting", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const paused = yield* service.upsert(
          yield* historyTask("Paused", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const skipped = yield* awaitTask(
          service,
          "Waiting",
          (task) => task.nextRunAt === until,
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("35 seconds");
        yield* Fiber.join(skipped);
        yield* service.setEnabled(
          { id: paused.task.id, enabled: false },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        expect((yield* service.listRuns({ id: waiting.task.id })).runs[0]).toMatchObject({
          skipReason: "usage_limited",
          usageLimit: { until },
        });
        yield* Queue.offer(snapshots, [account("exhausted", "unauthenticated")]);
        yield* Queue.offer(snapshots, [account("exhausted")]);
        expect(yield* Ref.get(launches)).toEqual([]);
        if (!restart) {
          yield* Ref.set(provider, account("available"));
          yield* Queue.offer(snapshots, [account("available")]);
          yield* resumed;
        }
      }).pipe(Effect.provide(layer));
      if (restart) {
        yield* Ref.set(provider, account("available"));
        yield* resumed.pipe(Effect.provide(layer));
      }
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "skips a scheduled run while memory is short, names the reading, and runs the next once it frees",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      // The reading at the 2026-11-13 kernel panic: pressure still normal, compressor at 0.56.
      const panic = {
        kind: "compressor",
        totalBytes: 24 * 1024 ** 3,
        compressorBytes: 873_905 * 16_384,
        compressorShareLimit: 0.35,
        pressure: "normal",
      } as const;
      const shortage = yield* Ref.make<MemoryShortage | null>(panic);
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launched, (titles) => [...titles, input.title]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-memory"), resumed: false } as never),
          ),
        Layer.empty,
        Layer.mock(MemoryAdmission.MemoryAdmission)({ shortage: Ref.get(shortage) }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* historyTask("Autopilot", { schedule: { type: "interval", everyMs: 60_000 } }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        // Its only occurrence would be lost, so a one-time task tries again a little later.
        const { task: once } = yield* service.upsert(
          yield* historyTask("Once", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const settled = (done: (tasks: ReadonlyArray<ScheduledTask>) => boolean) =>
          service.subscribeList().pipe(
            Stream.filter(({ tasks }) => done(tasks)),
            Stream.runHead,
            Effect.forkChild,
          );
        const byId = (tasks: ReadonlyArray<ScheduledTask>, id: string) =>
          tasks.find((entry) => entry.id === id);

        const skipped = yield* settled(
          (tasks) =>
            byId(tasks, task.id)?.nextRunAt !== task.nextRunAt &&
            byId(tasks, once.id)?.nextRunAt !== once.nextRunAt,
        );
        yield* TestClock.adjust("65 seconds");
        yield* Fiber.join(skipped);

        expect(yield* Ref.get(launched)).toEqual([]);
        const memorySkip = expect.objectContaining({
          trigger: "scheduled",
          outcome: "skipped",
          skipReason: "memory",
          threadId: null,
          memory: panic,
        });
        expect((yield* service.listRuns({ id: task.id })).runs).toEqual([memorySkip]);
        expect((yield* service.listRuns({ id: once.id })).runs).toEqual([memorySkip]);
        const retry = byId((yield* service.list()).tasks, once.id);
        expect(retry).toMatchObject({ enabled: true, runCount: 0 });
        expect(Date.parse(retry!.nextRunAt!)).toBeGreaterThanOrEqual(
          Date.parse("2026-11-10T12:05:30.000Z"),
        );

        yield* Ref.set(shortage, null);
        const ran = yield* settled((tasks) => byId(tasks, task.id)?.lastRunStatus === "succeeded");
        yield* TestClock.adjust("65 seconds");
        yield* Fiber.join(ran);
        expect(yield* Ref.get(launched)).toEqual(["Autopilot"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a fixed-time slot missed while the server was off shows on the task", () =>
  Effect.gen(function* () {
    const at = (hour: number, minute = 0, day = 1) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
    yield* TestClock.setTime(DateTime.toEpochMillis(at(8)));
    const launches = yield* Ref.make(0);
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      ServerSettings.layerTest(),
      MemoryAdmission.layerTest(),
      layerSharedTaskDependencies(),
      Scheduler.layer,
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Ref.update(launches, (count) => count + 1).pipe(
            Effect.as({ threadId: "thread-missed-slot", resumed: false } as never),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
      );

    const taskId = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          yield* decodeUpsertInput({
            title: "Morning bookkeeping",
            prompt: "Update yesterday's notes.",
            enabled: true,
            schedule: { type: "fixed_time", timeOfDay: "09:00" },
            // Fixed-time tasks catch up by default; this one skips the missed slot.
            catchUpMissedRun: false,
            projectId: "project-missed-slot",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.runNow({ id: task.id });
        return task.id;
      }),
    );

    // The server is off across the 09:00 slot and comes back at 09:30.
    yield* TestClock.setTime(DateTime.toEpochMillis(at(9, 30)));
    const [listed] = yield* withServer(
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* TestClock.adjust("6 seconds");
        return (yield* service.list()).tasks;
      }),
    );

    expect(listed?.id).toBe(taskId);
    expect(yield* Ref.get(launches)).toBe(1);
    expect(listed?.nextRunAt).toBe(DateTime.formatIso(DateTime.toUtc(at(9, 0, 2))));
    // The skipped slot must not read as the earlier manual run's clean success.
    expect({ status: listed?.lastRunStatus, error: listed?.lastRunError }).not.toEqual({
      status: "succeeded",
      error: null,
    });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run made while the scheduler was busy is not overwritten by its stale missed slot",
  () =>
    Effect.gen(function* () {
      const at = (hour: number, minute = 0, day = 1) =>
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
          { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
        );
      yield* TestClock.setTime(DateTime.toEpochMillis(at(6)));
      const slowStarted = yield* Deferred.make<void>();
      const releaseSlow = yield* Deferred.make<void>();
      const lastProcessed = yield* Deferred.make<void>();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        ServerSettings.layerTest(),
        MemoryAdmission.layerTest(),
        layerSharedTaskDependencies(),
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            (input.title === "Slow"
              ? Deferred.succeed(slowStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSlow)),
                )
              : input.title === "Last"
                ? Deferred.succeed(lastProcessed, undefined)
                : Effect.void
            ).pipe(Effect.as({ threadId: `thread-${input.title}`, resumed: false } as never)),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const withServer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))),
        );
      const upsert = (
        title: string,
        schedule: { type: "interval"; everyMs: number } | { type: "fixed_time"; timeOfDay: string },
      ) =>
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const { task } = yield* service.upsert(
            yield* decodeUpsertInput({
              title,
              prompt: "Update the notes.",
              enabled: true,
              schedule,
              projectId: "project-stale-slot",
              workspaceStrategy: { type: "root" },
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
            }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          return task.id;
        });

      // Due at 07:00, 08:00 and 08:30; the server is off until 09:30.
      const morningId = yield* withServer(
        Effect.gen(function* () {
          yield* upsert("Slow", { type: "interval", everyMs: 60 * 60 * 1000 });
          const id = yield* upsert("Morning", { type: "fixed_time", timeOfDay: "08:00" });
          yield* upsert("Last", { type: "interval", everyMs: 150 * 60 * 1000 });
          return id;
        }),
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(at(9, 30)));
      const morning = yield* withServer(
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(slowStarted);
          yield* service.runNow({ id: morningId });
          yield* Deferred.succeed(releaseSlow, undefined);
          yield* Deferred.await(lastProcessed);
          return (yield* service.list()).tasks.find((task) => task.id === morningId);
        }),
      );

      expect({ status: morning?.lastRunStatus, error: morning?.lastRunError }).toEqual({
        status: "succeeded",
        error: null,
      });
      expect(morning?.nextRunAt).toBe(DateTime.formatIso(DateTime.toUtc(at(8, 0, 2))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "defers scheduled implementation runs when the repo is at cap, honors exemptions and manual runNow, and runs once a slot frees",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);
      const blocked = yield* Ref.make(true);
      const layer = runHistoryLayer(
        (input) =>
          Ref.update(launched, (titles) => [...titles, input.title]).pipe(
            Effect.as({
              threadId: ThreadId.make(`thread-${input.title}`),
              resumed: false,
            } as never),
          ),
        Layer.empty,
        MemoryAdmission.layerTest(),
        layerSharedTaskDependencies(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        RepoConcurrencyAdmission.layerTest(({ requestedCount }) =>
          Ref.get(blocked).pipe(
            Effect.map((isBlocked) => ({
              allowed: !isBlocked,
              activeCount: isBlocked ? 4 : 3,
              requestedCount: requestedCount ?? 1,
              limit: 4,
              repoKey: "github.com/pingdotgg/t3code",
              breakdown: [
                { environmentId: "local" as const, label: "local", count: isBlocked ? 4 : 3 },
              ],
            })),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task: autopilot } = yield* service.upsert(
          yield* historyTask("Autopilot", { schedule: { type: "interval", everyMs: 600_000 } }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const { task: once } = yield* service.upsert(
          yield* historyTask("Once", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const { task: planTask } = yield* service.upsert(
          yield* historyTask("Plan", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
            interactionMode: "plan",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const { task: brokenMainTask } = yield* service.upsert(
          yield* historyTask("BrokenMain", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
            capExemption: "broken_main",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const { task: incidentTask } = yield* service.upsert(
          yield* historyTask("Incident", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:30.000Z" },
            capExemption: "incident",
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );

        const listed = (yield* service.list()).tasks;
        const byId = (tasks: ReadonlyArray<ScheduledTask>, id: string) =>
          tasks.find((entry) => entry.id === id);
        expect(byId(listed, autopilot.id)?.capExemption).toBeNull();
        expect(byId(listed, brokenMainTask.id)?.capExemption).toBe("broken_main");
        expect(byId(listed, incidentTask.id)?.capExemption).toBe("incident");

        const settled = (done: (tasks: ReadonlyArray<ScheduledTask>) => boolean) =>
          service.subscribeList().pipe(
            Stream.filter(({ tasks }) => done(tasks)),
            Stream.runHead,
            Effect.forkChild,
          );

        const firstTick = yield* settled(
          (tasks) =>
            byId(tasks, once.id)?.nextRunAt !== once.nextRunAt &&
            byId(tasks, planTask.id)?.lastRunStatus === "succeeded" &&
            byId(tasks, brokenMainTask.id)?.lastRunStatus === "succeeded" &&
            byId(tasks, incidentTask.id)?.lastRunStatus === "succeeded",
        );
        yield* TestClock.adjust("35 seconds");
        yield* Fiber.join(firstTick);

        expect(yield* Ref.get(launched)).toEqual(
          expect.arrayContaining(["Plan", "BrokenMain", "Incident"]),
        );
        expect(yield* Ref.get(launched)).not.toContain("Once");
        expect((yield* service.listRuns({ id: once.id })).runs).toEqual([
          expect.objectContaining({
            trigger: "scheduled",
            outcome: "skipped",
            skipReason: "repo_capacity",
            threadId: null,
          }),
        ]);
        const postponedOnce = byId((yield* service.list()).tasks, once.id);
        expect(postponedOnce).toMatchObject({ enabled: true, runCount: 0 });
        expect(Date.parse(postponedOnce!.nextRunAt!)).toBeGreaterThanOrEqual(
          Date.parse("2026-11-10T12:02:30.000Z"),
        );

        // Manual runNow bypasses the repo concurrency cap even while at 4/4.
        yield* service.runNow({ id: autopilot.id });
        expect(yield* Ref.get(launched)).toContain("Autopilot");

        // Free a slot and verify the postponed one-time task runs on its 2-minute retry.
        yield* Ref.set(blocked, false);
        const onceRan = yield* settled(
          (tasks) => byId(tasks, once.id)?.lastRunStatus === "succeeded",
        );
        yield* TestClock.adjust("130 seconds");
        yield* Fiber.join(onceRan);
        expect(yield* Ref.get(launched)).toContain("Once");

        // Clearing capExemption: null re-enables cap enforcement on a previously exempted task.
        yield* Ref.set(blocked, true);
        const { task: unexempted } = yield* service.upsert(
          yield* historyTask("BrokenMain", {
            id: brokenMainTask.id,
            schedule: { type: "once", runAt: "2026-11-10T12:03:30.000Z" },
            capExemption: null,
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        expect(unexempted.capExemption).toBeNull();
        const unexemptedDeferred = yield* settled(
          (tasks) => byId(tasks, brokenMainTask.id)?.nextRunAt !== unexempted.nextRunAt,
        );
        yield* TestClock.adjust("60 seconds");
        yield* Fiber.join(unexemptedDeferred);
        expect((yield* service.listRuns({ id: brokenMainTask.id })).runs[0]).toMatchObject({
          trigger: "scheduled",
          outcome: "skipped",
          skipReason: "repo_capacity",
          threadId: null,
        });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "defers in checkThenRun if repo hits cap during runCondition and reserves a repo slot across scheduled launches",
  () =>
    Effect.gen(function* () {
      const start = Date.parse("2026-11-10T12:00:00.000Z");
      yield* TestClock.setTime(start);

      const projectId = ProjectId.make("project-run-history");
      const activeCount = yield* Ref.make(3);
      const checkEntered = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const launchEntered = yield* Deferred.make<void>();
      const releaseLaunch = yield* Deferred.make<void>();
      const launched = yield* Ref.make<ReadonlyArray<string>>([]);

      const existingThreads = new Map<ThreadId, OrchestrationV2AppThread>(
        (["thread:sched-1", "thread:sched-2", "thread:sched-3", "thread:sched-4"] as const).map(
          (id) => [
            ThreadId.make(id),
            {
              projectId,
              interactionMode: "default",
              archivedAt: null,
            } as unknown as OrchestrationV2AppThread,
          ],
        ),
      );
      const allThreadIds = [...existingThreads.keys()];
      const admissionDeps = Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux" as NodeJS.Platform),
        MemoryAdmission.layerTest(),
        Layer.succeed(HostResources.HostResources, {
          read: Effect.succeed({
            sampledAt: 1_000,
            cpuUtilization: 0.1,
            cpuCount: 8,
            availableMemoryBytes: 24 * 1024 ** 3,
            totalMemoryBytes: 32 * 1024 ** 3,
            loadAverage: [1, 1, 1] as const,
          }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getWithRepositoryIdentity: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    id,
                    workspaceRoot: "/work/run-history",
                    repositoryIdentity: {
                      canonicalKey: "github.com/pingdotgg/t3code",
                      locator: {
                        source: "git-remote",
                        remoteName: "origin",
                        remoteUrl: "https://github.com/pingdotgg/t3code.git",
                      },
                    },
                  } as unknown as Project)
                : Option.none(),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getActiveTurnWorkspaces: () =>
            Ref.get(activeCount).pipe(
              Effect.map((count) =>
                allThreadIds.slice(0, count).map((threadId) => ({
                  threadId,
                  projectId,
                  worktreePath: null,
                })),
              ),
            ),
          getOpenCommandTasks: Effect.succeed([]),
          getThread: (threadId) => {
            const found = existingThreads.get(threadId);
            return found === undefined
              ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
              : Effect.succeed(found);
          },
        }),
      );

      const liveAdmissionLayer = RepoConcurrencyAdmission.layerLive().pipe(
        Layer.provide(admissionDeps),
      );
      const serviceLayer = runHistoryLayer(
        (input) =>
          Effect.gen(function* () {
            yield* Ref.update(launched, (titles) => [...titles, input.title]);
            yield* Deferred.succeed(launchEntered, undefined);
            yield* Deferred.await(releaseLaunch);
            return { threadId: ThreadId.make(`thread:${input.title}`), resumed: false } as never;
          }),
        Layer.empty,
        MemoryAdmission.layerTest(),
        layerSharedTaskDependencies(
          [
            {
              id: "project-run-history",
              title: "Run history",
              workspaceRoot: "/work/run-history",
              canonicalKey: null,
            },
          ],
          undefined,
          Layer.mock(RunConditionCheck.RunConditionCheck)({
            run: () =>
              Deferred.succeed(checkEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCheck)),
                Effect.as({ outcome: "run" as const, failure: null, exitCode: 0, detail: null }),
              ),
          }),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        liveAdmissionLayer,
      );
      const combinedLayer = Layer.merge(serviceLayer, liveAdmissionLayer);

      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const admission = yield* RepoConcurrencyAdmission.RepoConcurrencyAdmission;

        // 1. Task with runCondition starts checking at 3/4, repo hits 4/4 before check finishes ->
        // checkThenRun defers with skipReason:"repo_capacity" and preserves the check answer.
        const { task: checkedTask } = yield* service.upsert(
          yield* historyTask("Checked", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:20.000Z" },
            runCondition: { command: "node ~/check.mjs" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const checkedDeferred = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) => {
            const current = tasks.find((entry) => entry.id === checkedTask.id);
            return current !== undefined && current.nextRunAt !== checkedTask.nextRunAt;
          }),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("25 seconds");
        yield* Deferred.await(checkEntered);
        // Repo fills to 4/4 while runCondition is running.
        yield* Ref.set(activeCount, 4);
        yield* Deferred.succeed(releaseCheck, undefined);
        yield* Fiber.join(checkedDeferred);

        expect(yield* Ref.get(launched)).not.toContain("Checked");
        expect((yield* service.listRuns({ id: checkedTask.id })).runs).toEqual([
          expect.objectContaining({
            trigger: "scheduled",
            outcome: "skipped",
            skipReason: "repo_capacity",
            check: expect.objectContaining({ outcome: "run", exitCode: 0 }),
            threadId: null,
          }),
        ]);

        // 2. Drop back to 3/4 and trigger a scheduled launch: while launch is in flight,
        // a concurrent admission on the same repo sees 4/4 and is rejected.
        yield* Ref.set(activeCount, 3);
        const { task: reservedTask } = yield* service.upsert(
          yield* historyTask("Reserved", {
            schedule: { type: "once", runAt: "2026-11-10T12:00:50.000Z" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const tickFiber = yield* TestClock.adjust("30 seconds").pipe(Effect.forkChild);
        yield* Deferred.await(launchEntered);

        const concurrentCheck = yield* admission.withReservation({ projectId }, () =>
          Effect.succeed("should-not-admit"),
        );
        expect(concurrentCheck.admitted).toBe(false);
        expect(concurrentCheck.decision.activeCount).toBe(4);

        yield* Deferred.succeed(releaseLaunch, undefined);
        yield* Fiber.join(tickFiber);
        expect(yield* Ref.get(launched)).toContain("Reserved");
        expect(
          (yield* service.list()).tasks.find((entry) => entry.id === reservedTask.id)
            ?.lastRunStatus,
        ).toBe("succeeded");
      }).pipe(Effect.provide(combinedLayer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
