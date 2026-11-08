import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
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

import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { layerSharedTaskDependencies } from "./sharedTaskTestLayers.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      ServerSettings.layerTest(),
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
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
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
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
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

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
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
        );
        // This poll records the new task's due time; the later ones must still fire it.
        yield* TestClock.adjust("6 seconds");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Deferred.await(launched)).toBe(created.task.title);
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const runHistoryLayer = (
  launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"],
  accountRouting: Layer.Layer<never> = Layer.empty,
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ServerSettings.layerTest(),
        ManagedPolicy.layerTest(),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        layerSharedTaskDependencies(),
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
      const layer = runHistoryLayer((input) =>
        Ref.update(launched, (titles) => [...titles, input.title]).pipe(
          Effect.as({ threadId: ThreadId.make("thread-caught-up"), resumed: false } as never),
        ),
      );
      const { daily, off, weekly } = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const daily = (yield* service.upsert(yield* historyTask("Daily"))).task;
        const off = (yield* service.upsert(
          yield* historyTask("No catch-up", { catchUpMissedRun: false }),
        )).task;
        const weekly = (yield* service.upsert(
          yield* historyTask("Mondays", {
            schedule: { type: "fixed_time", timeOfDay: "07:00", weekdays: [1] },
          }),
        )).task;
        return { daily, off, weekly };
      }).pipe(Effect.provide(layer));
      expect([daily, off, weekly].map((task) => task.catchUpMissedRun)).toEqual([
        true,
        false,
        false,
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
        expect((yield* service.listRuns({ id: off.id })).runs).toMatchObject([
          { outcome: "skipped", skipReason: "missed", scheduledFor: isoAt(13, 7) },
        ]);
      }).pipe(Effect.provide(layer));
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
      const { task } = yield* service.upsert(yield* historyTask("Flaky"));
      expect((yield* service.runNow({ id: task.id })).task.lastRunStatus).toBe("failed");
      yield* TestClock.adjust("1 minute");
      expect((yield* service.runNow({ id: task.id })).task.lastRunStatus).toBe("succeeded");

      const runs = (yield* service.listRuns({ id: task.id })).runs;
      expect(runs).toMatchObject([
        { trigger: "manual", outcome: "succeeded", threadId: "thread-second", error: null },
        { trigger: "manual", outcome: "failed", threadId: null },
      ]);
      expect(runs[1]?.error).toContain("Claude is out of usage until Friday.");

      // Each task keeps its latest runs only.
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 60; index += 1) {
        yield* sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome)
          VALUES (${`old-${index}`}, ${task.id}, 'scheduled', ${`2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`}, 'succeeded')`;
      }
      yield* TestClock.adjust("1 minute");
      yield* service.runNow({ id: task.id });
      const kept = (yield* service.listRuns({ id: task.id })).runs;
      expect(kept).toHaveLength(50);
      expect(kept[0]?.threadId).toBe("thread-second");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("starts a new thread on another account when the task's account is out of usage", () =>
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
        route: (input) => Effect.succeed(input.selection),
        failoverLaunch: (input) => Effect.succeed({ ...input.selection, instanceId: spare }),
        limitedAccounts: Effect.succeed(new Map()),
        launchLimit: () => Effect.succeed(null),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(yield* historyTask("Limited"));
      yield* service.runNow({ id: task.id });
      expect(yield* Ref.get(launchedOn)).toEqual([spare]);
      expect((yield* service.listRuns({ id: task.id })).runs).toMatchObject([
        { outcome: "succeeded", failover: { from: "claude_primary", to: spare } },
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
