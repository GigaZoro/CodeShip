import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type MemoryShortage,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { vi } from "vite-plus/test";

import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import { originalDemandId } from "../orchestration-v2/demandId.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderMcp from "../provider/ProviderMcp.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { HERE_ENVIRONMENT_ID, layerSharedTaskDependencies } from "./sharedTaskTestLayers.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
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
      }).pipe(Effect.provide(layer), Effect.provideService(UpdateDrain, Ref.makeUnsafe(true)));

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
    }).pipe(Effect.provide(layer), Effect.provideService(UpdateDrain, Ref.makeUnsafe(true)));

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
  scheduler: Layer.Layer<Scheduler.Scheduler> = Scheduler.layer,
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        scheduler,
        ServerSettings.layerTest(),
        memory,
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        sharedDependencies,
        Layer.mock(SecretRequests.SecretRequests)({}),
        accountRouting,
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
          `scheduled-task-message:${caughtUp?.id.replace(":catch_up:", ":scheduled:")}`,
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
      // the newest 90, room for 50 runs and the four quiet skip buckets.
      const sql = yield* SqlClient.SqlClient;
      const insertRun = (runId: string, startedAt: string) =>
        sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome)
          VALUES (${runId}, ${task.id}, 'scheduled', ${startedAt}, 'succeeded')`;
      yield* insertRun("expired", "2026-08-01T00:00:00.000Z");
      yield* insertRun("in-window", "2026-08-13T00:00:00.000Z");
      for (let index = 0; index < 90; index += 1) {
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
      expect(kept).toHaveLength(90);
      expect(kept[0]?.threadId).toBe("thread-second");
      const stored = yield* sql<{ run_id: string }>`
        SELECT run_id FROM scheduled_task_runs WHERE run_id IN ('expired', 'in-window')`;
      expect(stored).toEqual([{ run_id: "in-window" }]);
      const counted = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE task_id = ${task.id}`;
      expect(counted).toEqual([{ count: 94 }]);
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
          limits: Effect.succeed({
            accounts: new Map(),
            estimated: new Set<never>(),
            models: new Map(),
          }),
          retryAccount: () => Effect.void,
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

it.effect.each([
  { kind: "once", shortage: "memory" },
  { kind: "once", shortage: "usage" },
  { kind: "fixed_time", shortage: "usage" },
  { kind: "fixed_time", shortage: "zone change" },
  { kind: "fixed_time", shortage: "late zone change" },
  { kind: "fixed_time", shortage: "legacy zone change" },
  { kind: "fixed_time", shortage: "legacy usage" },
  { kind: "fixed_time", shortage: "late wake usage" },
  { kind: "fixed_time", shortage: "equivalent schedule edit" },
  { kind: "fixed_time", shortage: "changed schedule edit" },
  { kind: "interval", shortage: "memory" },
] as const)(
  "$kind demand after two $shortage skips and a scheduler restart",
  ({ kind, shortage }) =>
    Effect.gen(function* () {
      const changesZone = shortage.endsWith("zone change");
      if (changesZone) {
        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("TZ", "Europe/Kyiv")),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );
      }
      const first = DateTime.makeZonedUnsafe(
        { year: 2026, month: 11, day: 10, hour: 7, minute: 0, second: 0, millisecond: 0 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
      const firstMs = DateTime.toEpochMillis(first);
      const firstAt = DateTime.formatIso(DateTime.toUtc(first));
      const isoMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
      yield* TestClock.setTime(firstMs - 60_000);
      const resetAt = yield* Ref.make<string | null>(isoMs(firstMs + 300_000));
      const demand = yield* Ref.make<string | null | undefined>(undefined);
      const layer = runHistoryLayer(
        (input) =>
          Ref.set(demand, input.initialMessage?.demandId).pipe(
            Effect.as({ threadId: ThreadId.make("thread-after-hold"), resumed: false } as never),
          ),
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: () =>
            Ref.get(resetAt).pipe(
              Effect.map((until) =>
                shortage !== "memory" && until !== null
                  ? {
                      driver: ProviderDriverKind.make("claude"),
                      until,
                      accounts: [ProviderInstanceId.make("claude_primary")],
                    }
                  : null,
              ),
            ),
          failoverLaunch: (input) => Effect.succeed({ selection: input.selection, failover: null }),
        }),
        Layer.mock(MemoryAdmission.MemoryAdmission)({
          shortage: Ref.get(resetAt).pipe(
            Effect.map((until) =>
              shortage === "memory" && until !== null
                ? {
                    kind: "compressor" as const,
                    totalBytes: 100,
                    compressorBytes: 60,
                    compressorShareLimit: 0.35,
                    pressure: "normal" as const,
                  }
                : null,
            ),
          ),
        }),
      );
      const task = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        return (yield* service.upsert(
          yield* historyTask("Held occurrence", {
            schedule:
              kind === "once"
                ? { type: kind, runAt: firstAt }
                : kind === "fixed_time"
                  ? { type: kind, timeOfDay: "07:00" }
                  : { type: kind, everyMs: 60_000 },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
      }).pipe(Effect.provide(layer));
      expect(task.nextRunAt).toBe(firstAt);

      // Each service starts from the persisted cursor. Keep both admissions blocked before
      // clearing the shortage, so a second retry cannot replace the first due instant.
      const afterSkip = (due: string) =>
        Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          const moved = yield* service.subscribeList().pipe(
            Stream.filter(({ tasks }) =>
              tasks.some(
                (entry) =>
                  entry.id === task.id &&
                  entry.nextRunAt !== null &&
                  Date.parse(entry.nextRunAt) > Date.parse(due),
              ),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* TestClock.adjust("6 seconds");
          yield* Fiber.join(moved);
          const current = (yield* service.list()).tasks.find((entry) => entry.id === task.id)!;
          expect(Date.parse(current.nextRunAt!)).toBeGreaterThan(Date.parse(due));
          expect(yield* Ref.get(demand)).toBeUndefined();
          if (shortage === "legacy usage" || shortage === "legacy zone change") {
            const sql = yield* SqlClient.SqlClient;
            // Remove the cursor evidence written by newer versions as well.
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
            if (columns.some((column) => column.name === "usage_hold_json"))
              yield* sql`UPDATE scheduled_tasks SET usage_hold_json=NULL WHERE task_id=${task.id}`;
            yield* sql`UPDATE scheduled_task_runs
              SET usage_limit_json = json_remove(usage_limit_json, '$.heldOccurrence')
              WHERE task_id = ${task.id} AND skip_reason = 'usage_limited'`;
          }
          return current.nextRunAt!;
        }).pipe(Effect.provide(layer));
      yield* TestClock.setTime(firstMs);
      const secondAt = yield* afterSkip(firstAt);
      if (changesZone) {
        expect(firstAt).toBe("2026-11-10T05:00:00.000Z");
        vi.stubEnv("TZ", "Europe/London");
      }
      // Waking after the grace period revisits 07:00. The 07:30 reset and original
      // occurrence must survive even though history already contains that 07:00 skip.
      const edit = shortage === "equivalent schedule edit" || shortage === "changed schedule edit";
      const late = shortage === "late wake usage" || edit;
      yield* Ref.set(resetAt, isoMs(late ? firstMs + 30 * 60_000 : Date.parse(secondAt) + 300_000));
      // Advance with the scheduler stopped. Advancing a running TestClock polls each intermediate deadline.
      yield* TestClock.setTime(late ? firstMs + 20 * 60_000 : Date.parse(secondAt));
      if (shortage === "late zone change") {
        yield* Ref.set(resetAt, isoMs(firstMs + 30 * 60_000));
        yield* TestClock.setTime(firstMs + 20 * 60_000);
      }
      const thirdAt = yield* afterSkip(secondAt);
      if (changesZone)
        expect(thirdAt).toBe(isoMs(firstMs + (shortage === "late zone change" ? 30 : 10) * 60_000));
      if (late) {
        expect(secondAt).toBe(isoMs(firstMs + 5 * 60_000));
        expect(thirdAt).toBe(isoMs(firstMs + 30 * 60_000));
        const sql = yield* SqlClient.SqlClient;
        const history =
          yield* sql`SELECT scheduled_for, json_extract(usage_limit_json, '$.until') AS reset_at
          FROM scheduled_task_runs WHERE task_id = ${task.id} AND skip_reason = 'usage_limited'`;
        // The late poll caught up the same 07:00 occurrence. Its first skip still has the old
        // reset, so passing this test requires recovering the occurrence from the moved cursor.
        expect(history).toEqual([{ scheduled_for: firstAt, reset_at: secondAt }]);
      }
      yield* Ref.set(resetAt, null);
      yield* TestClock.setTime(Date.parse(thirdAt));
      if (edit) {
        // As on a stopped scheduler, the app saves at 07:30 before the poll for that deadline.
        const editLayer = runHistoryLayer(
          () => Effect.die("editing a task cannot launch it"),
          undefined,
          undefined,
          undefined,
          Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        );
        const equivalent = shortage === "equivalent schedule edit";
        const changed = yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          return yield* service.upsert(
            yield* historyTask("Edited task", {
              id: task.id,
              schedule: {
                type: "fixed_time",
                timeOfDay: equivalent ? "7:00" : "08:00",
                ...(equivalent ? { weekdays: [6, 5, 4, 3, 2, 1, 0, 1] } : {}),
              },
            }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
        }).pipe(Effect.provide(editLayer));
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          usage_hold_json: string | null;
        }>`SELECT usage_hold_json FROM scheduled_tasks WHERE task_id=${task.id}`;
        if (equivalent) {
          expect(changed.task.nextRunAt).toBe(thirdAt);
          expect(row?.usage_hold_json).toBeTypeOf("string");
        } else {
          expect(changed.task.nextRunAt).toBe(isoMs(firstMs + 60 * 60_000));
          expect(row?.usage_hold_json).toBeNull();
          yield* TestClock.setTime(Date.parse(changed.task.nextRunAt!));
        }
      }
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const finished = yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some((entry) => entry.id === task.id && entry.lastRunStatus === "succeeded"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* TestClock.adjust("6 seconds");
        yield* Fiber.join(finished);
        expect((yield* service.listRuns({ id: task.id })).runs[0]?.outcome).toBe("succeeded");
      }).pipe(Effect.provide(layer));
      const incarnation = task.incarnationId ?? task.createdAt;
      expect(yield* Ref.get(demand)).toBe(
        shortage === "legacy zone change"
          ? null
          : originalDemandId(
              "scheduled-task",
              HERE_ENVIRONMENT_ID,
              task.id,
              incarnation,
              "scheduled",
              kind === "interval"
                ? thirdAt
                : shortage === "changed schedule edit"
                  ? isoMs(firstMs + 60 * 60_000)
                  : firstAt,
            ),
      );
      if (changesZone) {
        const next = "2026-11-10T07:00:00.000Z";
        yield* TestClock.setTime(Date.parse(next));
        yield* Effect.gen(function* () {
          const service = yield* ScheduledTaskService.ScheduledTaskService;
          expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(next);
          yield* TestClock.adjust("6 seconds");
          expect(yield* Ref.get(demand)).toBe(
            originalDemandId(
              "scheduled-task",
              HERE_ENVIRONMENT_ID,
              task.id,
              incarnation,
              "scheduled",
              next,
            ),
          );
        }).pipe(Effect.provide(layer));
      }
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  { state: "missing column, interrupted catch-up", expected: 0 },
  { state: "null column, interrupted catch-up", expected: 0 },
  { state: "unrelated earlier occurrence", expected: null },
  { state: "a completed run after the old hold", expected: null },
  { state: "a cursor moved inside the grace period", expected: null },
  { state: "another schedule's hold", expected: null },
  { state: "manual trigger", expected: null },
  { state: "webhook trigger", expected: null },
  { state: "a foreign machine", expected: null },
  { state: "an observation after the cursor write", expected: null },
  { state: "completion before observation", expected: null },
  { state: "a malformed reset", expected: null },
  { state: "a rollover reset", expected: null },
  { state: "a later settings edit", expected: null },
  { state: "missing edit evidence across a gap", expected: null },
  { state: "an exact catch-up deadline without edit metadata", expected: 0 },
  { state: "a malformed current origin", expected: null },
  { state: "the next configured slot", expected: 24 * 60 },
  { state: "a current cursor with unrelated history", expected: 0 },
] as const)("attributes a fixed-time cursor after upgrade with $state", ({ state, expected }) =>
  Effect.gen(function* () {
    const first = DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 10, hour: 7, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    const epoch = DateTime.toEpochMillis(first);
    const at = (minutes: number) =>
      DateTime.formatIso(DateTime.makeUnsafe(epoch + minutes * 60_000));
    yield* TestClock.setTime(epoch - 60_000);
    const demand = yield* Deferred.make<string | null | undefined>();
    const healthy = yield* Deferred.make<string | null | undefined>();
    const layer = runHistoryLayer((input) =>
      Deferred.succeed(
        input.title === "Unaffected task" ? healthy : demand,
        input.initialMessage?.demandId,
      ).pipe(Effect.as({ threadId: ThreadId.make("upgraded"), resumed: false } as never)),
    );
    const { task } = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      if (state === "a malformed reset") {
        yield* service.upsert(
          yield* historyTask("Unaffected task", {
            schedule: { type: "fixed_time", timeOfDay: "07:30" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
      }
      return yield* service.upsert(
        yield* historyTask("Upgraded fixed time"),
        ScheduledTaskService.CHANGED_IN_APP,
      );
    }).pipe(Effect.provide(layer));
    const sql = yield* SqlClient.SqlClient;
    const due = state === "the next configured slot" ? 24 * 60 : 30;
    const observed = state === "a cursor moved inside the grace period" ? 10 : 20;
    // Restore the old scheduler's persisted state, with the service stopped: the initial 07:00
    // skip reset at 07:05, and its duplicate at 07:20 moved the cursor but could not replace it.
    if (state === "missing column, interrupted catch-up") {
      yield* sql`DROP TRIGGER scheduled_task_clear_usage_hold`;
      yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN usage_hold_json`;
    }
    yield* sql`UPDATE scheduled_tasks SET next_run_at=${at(due)}, updated_at=${at(observed)},
        incarnation_id=NULL WHERE task_id=${task.id}`;
    const skip = state === "unrelated earlier occurrence" ? -24 * 60 : 0;
    const usage = {
      driver: "claude",
      until: at(skip + 5),
      ...(state === "another schedule's hold" || state === "null column, interrupted catch-up"
        ? {
            heldOccurrence: {
              at: at(skip),
              schedule:
                state === "another schedule's hold"
                  ? { type: "fixed_time", timeOfDay: "08:00" }
                  : task.schedule,
            },
          }
        : {}),
    };
    yield* sql`INSERT INTO scheduled_task_runs
        (run_id, task_id, trigger, scheduled_for, started_at, completed_at, outcome, skip_reason, usage_limit_json)
        VALUES (${task.id + ":" + at(skip) + ":usage_limited"}, ${task.id}, 'scheduled',
          ${at(skip)}, ${at(skip)}, ${at(skip)}, 'skipped', 'usage_limited', ${JSON.stringify(usage)})`;
    if (
      state === "a completed run after the old hold" ||
      state === "a current cursor with unrelated history"
    ) {
      yield* sql`INSERT INTO scheduled_task_runs
          (run_id, task_id, trigger, scheduled_for, started_at, completed_at, outcome)
          VALUES ('completed', ${task.id}, 'scheduled', ${at(5)}, ${at(5)}, ${at(5)}, 'succeeded')`;
    }
    if (state === "manual trigger" || state === "webhook trigger")
      yield* sql`UPDATE scheduled_task_runs SET trigger=${state === "manual trigger" ? "manual" : "webhook"} WHERE task_id=${task.id}`;
    if (state === "a foreign machine")
      yield* sql`UPDATE scheduled_task_runs SET ran_on='other-machine' WHERE task_id=${task.id}`;
    if (state === "a later settings edit")
      yield* sql`UPDATE scheduled_task_changed_by SET changed_by_json=json_set(changed_by_json,'$.at',${at(observed)}) WHERE task_id=${task.id}`;
    if (
      state === "missing edit evidence across a gap" ||
      state === "an exact catch-up deadline without edit metadata"
    )
      yield* sql`DELETE FROM scheduled_task_changed_by WHERE task_id=${task.id}`;
    if (state === "an exact catch-up deadline without edit metadata") {
      yield* sql`UPDATE scheduled_task_runs SET trigger='catch_up', started_at=${at(15)}, completed_at=${at(15)},
        usage_limit_json=json_set(usage_limit_json,'$.until',${at(due)}) WHERE task_id=${task.id}`;
    }
    if (
      state === "an observation after the cursor write" ||
      state === "completion before observation"
    ) {
      yield* sql`UPDATE scheduled_task_runs SET started_at=${at(state === "an observation after the cursor write" ? 25 : 4)},
        completed_at=${at(state === "an observation after the cursor write" ? 25 : 2)},
        usage_limit_json=json_set(usage_limit_json,'$.until',${at(due)}) WHERE task_id=${task.id}`;
    }
    if (state === "a malformed reset" || state === "a rollover reset")
      yield* sql`UPDATE scheduled_task_runs SET usage_limit_json=json_set(usage_limit_json,'$.until',
        ${state === "a malformed reset" ? "unknown" : "2026-11-31T07:05:00Z"}) WHERE task_id=${task.id}`;
    if (
      state === "a current cursor with unrelated history" ||
      state === "a malformed current origin"
    ) {
      const held = {
        driver: "claude",
        until: at(due),
        heldOccurrence: {
          at: state === "a malformed current origin" ? "unknown" : at(0),
          schedule: task.schedule,
        },
      };
      yield* sql`UPDATE scheduled_tasks SET usage_hold_json=${JSON.stringify(held)} WHERE task_id=${task.id}`;
    }
    yield* TestClock.setTime(Date.parse(at(due)));
    yield* Effect.gen(function* () {
      yield* ScheduledTaskService.ScheduledTaskService;
      yield* TestClock.adjust("6 seconds");
      if (state === "a malformed reset")
        expect(yield* Deferred.await(healthy)).toBeTypeOf("string");
      expect(yield* Deferred.await(demand)).toBe(
        expected === null
          ? null
          : originalDemandId(
              "scheduled-task",
              HERE_ENVIRONMENT_ID,
              task.id,
              task.createdAt,
              "scheduled",
              at(expected),
            ),
      );
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
      const until = isoAt(untilAt[0], untilAt[1]);
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
        yield* TestClock.setTime(Date.parse(isoAt(nextAt[0], nextAt[1])) + 5_000);
        yield* TestClock.adjust("6 seconds");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(launched)).toEqual(["Daily"]);
      }).pipe(Effect.provide(layer));
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
