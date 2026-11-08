import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskPlacement,
  type ServerSettings as ServerSettingsValue,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { layerSharedTaskDependencies } from "./sharedTaskTestLayers.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                ServerSettings.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                layerSharedTaskDependencies(),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                ServerSettings.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                layerSharedTaskDependencies(),
                Layer.mock(SecretRequests.SecretRequests)({}),
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
          }),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Rebind lands first, then the promotion commits between the shell read and the retry.
    const shellProjects = yield* Ref.make([scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [
                { projectId: next ?? promoted } as never,
                rest,
              ]),
          }),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a placement and the last run's thread survive edits and leave with the task", () =>
  Effect.gen(function* () {
    const legacySql = yield* SqlClient.SqlClient;
    // A table from before placements and pin order keys, holding a pinned task.
    yield* legacySql`
      CREATE TABLE scheduled_task_sidebar (
        task_id TEXT PRIMARY KEY,
        pinned_at TEXT,
        last_run_thread_id TEXT
      )
    `;
    yield* legacySql`
      INSERT INTO scheduled_task_sidebar (task_id, pinned_at)
      VALUES ('task:legacy', '2026-10-01T00:00:00.000Z')
    `;
    const runThreadId = ThreadId.make("thread:started-by-run");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () => Effect.succeed({ threadId: runThreadId } as never),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const upsert = (title: string, id = "task:pinned", placement?: ScheduledTaskPlacement) =>
        service.upsert({
          id: ScheduledTaskId.make(id),
          ...(placement === undefined ? {} : { placement }),
          title,
          prompt: "Check progress",
          enabled: true,
          schedule: { type: "interval", everyMs: 300_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const legacy = yield* sql<{ placement: string; pinned_at: string }>`
        SELECT placement, pinned_at FROM scheduled_task_sidebar WHERE task_id = 'task:legacy'
      `;
      assert.deepEqual(legacy, [{ placement: "pinned", pinned_at: "2026-10-01T00:00:00.000Z" }]);
      yield* sql`DELETE FROM scheduled_task_sidebar WHERE task_id = 'task:legacy'`;

      const { task } = yield* upsert("Check CI");
      assert.equal(task.placement, "pinned");
      assert.isNotNull(task.pinnedAt);
      yield* service.setPlacement({ ids: [task.id], placement: "chat" });
      const listed = () =>
        service.list().pipe(Effect.map(({ tasks }) => tasks.find(({ id }) => id === task.id)));

      yield* settings.updateSettings({ scheduledTaskDefaultPlacement: "pinned" });
      assert.equal((yield* upsert("Existing task")).task.placement, "chat");
      const automatic = (yield* upsert("New pinned task", "task:automatic")).task;
      assert.equal(automatic.placement, "pinned");
      assert.isNotNull(automatic.pinnedAt);
      yield* service.setPlacement({ ids: [automatic.id], placement: "chat" });
      assert.equal((yield* upsert("Stay regular", automatic.id)).task.placement, "chat");
      yield* settings.updateSettings({ scheduledTaskDefaultPlacement: "none" });
      const hidden = (yield* upsert("New hidden task", "task:hidden")).task;
      assert.equal(hidden.placement, "none");
      assert.isNull(hidden.pinnedAt);
      yield* settings.updateSettings({ scheduledTaskDefaultPlacement: "chat" });
      assert.equal((yield* upsert("New regular task", "task:regular")).task.placement, "chat");
      const chosen = (yield* upsert("Chosen", "task:chosen", "pinned")).task;
      assert.equal(chosen.placement, "pinned");
      assert.isNotNull(chosen.pinnedAt);
      assert.equal((yield* upsert("Chosen", chosen.id, "none")).task.placement, "none");
      assert.equal((yield* upsert("Chosen again", chosen.id)).task.placement, "none");
      yield* service.delete({ id: chosen.id });
      yield* service.delete({ id: automatic.id });
      yield* service.delete({ id: hidden.id });
      yield* service.delete({ id: ScheduledTaskId.make("task:regular") });

      assert.deepEqual((yield* service.setPlacement({ ids: [task.id], placement: "pinned" })).ids, [
        task.id,
      ]);
      const pinned = yield* listed();
      assert.isNotNull(pinned?.pinnedAt ?? null);
      assert.isNull(pinned?.pinOrderKey ?? null);
      const reordered = yield* service.reorderPinned({
        assignments: [
          { id: task.id, orderKey: "m" },
          { id: ScheduledTaskId.make("task:missing"), orderKey: "n" },
        ],
      });
      assert.deepEqual(reordered.ids, [task.id]);
      const run = yield* service.runNow({ id: task.id });
      assert.equal(run.threadId, runThreadId);
      assert.equal(run.task.lastRunThreadId, runThreadId);

      yield* upsert("Check CI and deploys");
      const edited = yield* listed();
      assert.equal(edited?.title, "Check CI and deploys");
      assert.equal(edited?.placement, "pinned");
      assert.equal(edited?.pinnedAt, pinned?.pinnedAt);
      assert.equal(edited?.pinOrderKey, "m");
      assert.equal(edited?.lastRunThreadId, runThreadId);

      yield* service.setPlacement({ ids: [task.id], placement: "none" });
      const hiddenTask = yield* listed();
      assert.equal(hiddenTask?.placement, "none");
      assert.isNull(hiddenTask?.pinnedAt ?? null);
      assert.equal(hiddenTask?.lastRunThreadId, runThreadId);

      yield* TestClock.adjust("1 minute");
      yield* service.setPlacement({ ids: [task.id], placement: "pinned" });
      assert.notEqual((yield* listed())?.pinnedAt, pinned?.pinnedAt);
      assert.deepEqual(
        (yield* service.setPlacement({ ids: [task.id], placement: "pinned" })).ids,
        [],
      );

      yield* service.setPlacement({ ids: [task.id], placement: "chat" });
      assert.isNull((yield* listed())?.pinnedAt ?? null);
      assert.isNull((yield* listed())?.pinOrderKey ?? null);
      const afterUnpin = yield* service.reorderPinned({
        assignments: [{ id: task.id, orderKey: "p" }],
      });
      assert.lengthOf(afterUnpin.ids, 0);

      yield* service.delete({ id: task.id });
      const leftover = yield* sql`SELECT task_id FROM scheduled_task_sidebar`;
      assert.lengthOf(leftover, 0);
      assert.deepEqual(
        (yield* service.setPlacement({ ids: [task.id], placement: "pinned" })).ids,
        [],
      );
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(ServerSettings.layerTest()))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a task that follows the default runs the scheduled tasks model and keeps its own", () =>
  Effect.gen(function* () {
    const ownModel: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    const settingsRef = yield* Ref.make<ServerSettingsValue>({
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-new" },
    });
    const settingsChanges = yield* Queue.unbounded<ServerSettingsValue>();
    const setSettings = (patch: Partial<ServerSettingsValue>) =>
      Ref.updateAndGet(settingsRef, (current) => ({ ...current, ...patch })).pipe(
        Effect.flatMap((next) => Queue.offer(settingsChanges, next)),
      );
    const launched = yield* Ref.make<ModelSelection | null>(null);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settingsRef),
            streamChanges: Stream.fromQueue(settingsChanges),
          }),
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.set(launched, input.modelSelection).pipe(
                Effect.as({ threadId: ThreadId.make("thread:run") } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const upsert = (followsDefaultModel?: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:default-model"),
          title: "Nightly review",
          prompt: "Review today's changes",
          enabled: true,
          schedule: { type: "interval", everyMs: 300_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: ownModel,
          ...(followsDefaultModel === undefined ? {} : { followsDefaultModel }),
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const { task } = yield* upsert(true);
      // With no scheduled tasks model, it runs the new-thread default.
      assert.equal(task.modelSelection.model, "gpt-new");
      const stored = (yield* service.list({ resolveModels: false })).tasks.find(
        (candidate) => candidate.id === task.id,
      )!;
      assert.deepEqual(stored.modelSelection, ownModel);
      yield* service.upsert({ ...stored, title: "Renamed" });
      assert.deepEqual(
        (yield* service.list({ resolveModels: false })).tasks[0]?.modelSelection,
        ownModel,
      );
      const listedModel = () =>
        service
          .list()
          .pipe(
            Effect.map(({ tasks }) => tasks.find(({ id }) => id === task.id)?.modelSelection.model),
          );

      const firstList = yield* Deferred.make<void>();
      const listedModels = yield* service.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(firstList, undefined)),
        Stream.map(({ tasks }) => tasks.find(({ id }) => id === task.id)?.modelSelection.model),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstList);
      yield* setSettings({
        scheduledTaskModelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "opus",
        },
      });
      assert.deepEqual(Array.from(yield* Fiber.join(listedModels)), ["gpt-new", "opus"]);

      yield* service.runNow({ id: task.id });
      assert.equal((yield* Ref.get(launched))?.model, "opus");

      // A client that predates the flag keeps it when re-saving.
      yield* upsert();
      assert.equal(yield* listedModel(), "opus");

      const off = { ids: [task.id], followsDefaultModel: false };
      assert.deepEqual((yield* service.setFollowsDefaultModel(off)).ids, [task.id]);
      assert.equal(yield* listedModel(), "gpt-5.4");
      assert.deepEqual((yield* service.setFollowsDefaultModel(off)).ids, []);

      yield* service.setFollowsDefaultModel({ ids: [task.id], followsDefaultModel: true });
      yield* service.delete({ id: task.id });
      assert.lengthOf(yield* sql`SELECT task_id FROM scheduled_task_default_model`, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses saving an enabled task above the policy ceiling", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (enabled: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:above-ceiling"),
          title: "Nightly",
          prompt: "Check progress",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:above-ceiling"), enabled: true })
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      yield* service.upsert({
        id: ScheduledTaskId.make("task:bound"),
        title: "Follow up",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: ThreadId.make("thread:bound"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          layerSharedTaskDependencies(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
