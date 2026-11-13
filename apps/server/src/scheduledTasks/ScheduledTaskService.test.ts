import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskPlacement,
  type ScheduledTask,
  type ScheduledTaskRunCheck,
  type ScheduledTaskUpsertInput,
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
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { layerSharedTaskDependencies } from "./sharedTaskTestLayers.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
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
  "releases interrupted runs and renames old live-run skips on startup, and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      yield* sql`
        INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, skip_reason)
        VALUES ('run:old-skip', 'due-healthy', 'scheduled', ${now}, 'skipped', 'last_run_working')
      `;
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
      const oldSkips = yield* sql<{ readonly skip_reason: string }>`
        SELECT skip_reason FROM scheduled_task_runs WHERE run_id = 'run:old-skip'
      `;
      assert.deepEqual(oldSkips, [{ skip_reason: "live_run_limit" }]);
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
      assert.strictEqual(edited?.lastRunScheduledFor, null);

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
      yield* service.upsert({ ...stored, title: "Renamed", promptFile: null });
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

// Run conditions. The poll is captured, so each test runs it when it wants; nothing sleeps.
const PROJECT_ROOT = "/work/test";
const FOUND_WORK: ScheduledTaskRunCheck = {
  outcome: "run",
  failure: null,
  exitCode: 0,
  detail: null,
};
const NO_WORK: ScheduledTaskRunCheck = {
  outcome: "skip",
  failure: null,
  exitCode: 10,
  detail: "No open pull requests",
};
const RUN_CONDITION = { command: "node ~/check.mjs needs-run", timeoutSeconds: 30 };

const conditionTask = (
  overrides: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make("task:checked"),
  title: "Review pull requests",
  prompt: "Review the open pull requests",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "worktree", baseRef: "main" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  runCondition: RUN_CONDITION,
  ...overrides,
});

type CheckCall = Parameters<RunConditionCheck.RunConditionCheck["Service"]["run"]>[0];
type LaunchInput = Parameters<ThreadLaunchService.ThreadLaunchService["Service"]["launch"]>[0];
interface ChatRuns {
  /** Oldest first. */
  readonly statuses: ReadonlyArray<OrchestrationV2RunStatus>;
  readonly continuationPending: boolean;
  /** A task the chat delegated still runs. */
  readonly delegating?: boolean;
  /** "dropped": a projection rebuild removed the deleted chat. */
  readonly deleted?: "kept" | "dropped";
}

const withRunConditions = <A, E>(
  answer: (call: CheckCall) => Effect.Effect<ScheduledTaskRunCheck>,
  body: (harness: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly poll: Effect.Effect<void>;
    readonly launches: Queue.Queue<LaunchInput>;
    readonly checks: Ref.Ref<ReadonlyArray<CheckCall>>;
    /** The runs of every launched chat; they have finished unless a test says otherwise. */
    readonly chatRuns: Ref.Ref<ChatRuns>;
    /** Runs of single chats, by thread id, in place of `chatRuns`. */
    readonly threadRuns: Ref.Ref<Readonly<Record<string, ChatRuns>>>;
    /**
     * Watches the list from now on; the effect it returns waits until the checked task matches.
     * Changes coalesce, so tests wait for a state, not a number of changes.
     */
    readonly whenTask: (
      matches: (task: ScheduledTask) => boolean,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
  }) => Effect.Effect<A, E, Scope.Scope>,
  policy?: Parameters<typeof ManagedPolicy.layerTest>[0],
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<LaunchInput>();
    const checks = yield* Ref.make<ReadonlyArray<CheckCall>>([]);
    const chatRuns = yield* Ref.make<ChatRuns>({
      statuses: ["completed"],
      continuationPending: false,
    });
    const threadRuns = yield* Ref.make<Readonly<Record<string, ChatRuns>>>({});
    const runsOfThread = (threadId: string) =>
      Effect.zipWith(Ref.get(threadRuns), Ref.get(chatRuns), (own, all) => own[threadId] ?? all);
    // The first chat keeps the plain id the older tests expect; later ones are numbered.
    let launched = 0;
    const workers = new Map<string, Effect.Effect<void>>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(policy),
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Queue.offer(launches, input).pipe(
                Effect.as({
                  threadId: ThreadId.make(
                    ++launched === 1 ? "thread:launched" : `thread:launched:${launched}`,
                  ),
                  resumed: false,
                } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              runsOfThread(threadId).pipe(
                Effect.filterOrFail(
                  ({ deleted }) => deleted !== "dropped",
                  () =>
                    new Orchestrator.OrchestratorProjectionError({
                      threadId,
                      cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                    }),
                ),
                Effect.map(
                  ({ statuses, delegating, deleted }) =>
                    ({
                      thread: {
                        deletedAt: deleted === "kept" ? "2026-01-01T00:00:00.000Z" : null,
                      },
                      runs: statuses.map((status, index) => ({
                        id: `run:chat:${index}`,
                        threadId,
                        ordinal: index + 1,
                        status,
                      })),
                      subagents:
                        delegating === true
                          ? [{ status: "running", completionDelivery: null }]
                          : [],
                      providerThreads: [],
                    }) as never,
                ),
              ),
            restartContinuationPending: (run) =>
              runsOfThread(run.threadId).pipe(Effect.map((chat) => chat.continuationPending)),
          }),
          layerSharedTaskDependencies(
            [
              {
                id: "project:test",
                title: "Test",
                workspaceRoot: PROJECT_ROOT,
                canonicalKey: null,
              },
            ],
            undefined,
            Layer.mock(RunConditionCheck.RunConditionCheck)({
              run: (call) =>
                Ref.update(checks, (all) => [...all, call]).pipe(Effect.andThen(answer(call))),
            }),
          ),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, {
            register: <E2, R>(name: string, work: Effect.Effect<void, E2, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const whenTask = (matches: (task: ScheduledTask) => boolean) =>
        service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some((task) => task.id === "task:checked" && matches(task)),
          ),
          Stream.runHead,
          Effect.orDie,
          Effect.forkScoped,
          Effect.map((fiber) => Fiber.join(fiber).pipe(Effect.asVoid)),
        );
      return yield* body({
        service,
        sql: yield* SqlClient.SqlClient,
        poll: Effect.suspend(() => workers.get("scheduled-tasks")!),
        launches,
        checks,
        chatRuns,
        threadRuns,
        whenTask,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const runsOf = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.listRuns({ id: ScheduledTaskId.make("task:checked") }).pipe(Effect.map((r) => r.runs));

it.effect("a check that finds no work starts no chat and records the occurrence as skipped", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, poll, launches, checks, whenTask }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(conditionTask());
        yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
        const skipped = yield* whenTask(
          (t) => t.lastNoWorkSkip != null && t.runCheckStartedAt == null,
        );
        yield* poll;
        yield* skipped;

        assert.equal(yield* Queue.size(launches), 0);
        assert.deepEqual(yield* Ref.get(checks), [
          { command: RUN_CONDITION.command, timeoutSeconds: 30, cwd: PROJECT_ROOT },
        ]);
        const [run] = yield* runsOf(service);
        assert.deepInclude(run, {
          outcome: "skipped",
          skipReason: "no_work",
          scheduledFor: task.nextRunAt,
          threadId: null,
          check: NO_WORK,
        });
        const after = (yield* service.list()).tasks[0]!;
        assert.deepEqual(after.lastNoWorkSkip, {
          at: run!.startedAt,
          scheduledFor: task.nextRunAt,
          reason: "No open pull requests",
        });
        assert.isTrue(Date.parse(after.nextRunAt!) > Date.parse(task.nextRunAt!));
        assert.deepEqual(
          [after.lastRunAt, after.lastRunStatus, after.runCount, after.runCheckStartedAt],
          [null, "never", 0, null],
        );

        // The skip stays history once the condition is cleared: other machines still read it.
        yield* service.upsert(conditionTask({ runCondition: null }));
        const cleared = (yield* service.list()).tasks[0]!;
        assert.deepEqual(
          [cleared.runCondition, cleared.lastNoWorkSkip],
          [null, after.lastNoWorkSkip],
        );
      }),
  ),
);

it.effect.each([
  { name: "found work", check: FOUND_WORK },
  {
    name: "failed with an exit code",
    check: { outcome: "failed", failure: "exit_code", exitCode: 2, detail: "auth failed" },
  },
  {
    name: "timed out",
    check: { outcome: "failed", failure: "timeout", exitCode: null, detail: null },
  },
  {
    name: "could not start",
    check: { outcome: "failed", failure: "not_started", exitCode: null, detail: "spawn ENOENT" },
  },
] satisfies ReadonlyArray<{ name: string; check: ScheduledTaskRunCheck }>)(
  "a check that $name starts the chat as a task without one would",
  ({ check }) =>
    withRunConditions(
      () => Effect.succeed(check),
      ({ service, poll, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(conditionTask());
          yield* service.upsert(
            conditionTask({ id: ScheduledTaskId.make("task:plain"), runCondition: null }),
          );
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          yield* poll;
          const launched = [yield* Queue.take(launches), yield* Queue.take(launches)];
          const comparable = (input: LaunchInput) => ({
            ...input,
            commandId: null,
            initialMessage: { ...input.initialMessage, messageId: null, scheduledTaskId: null },
          });
          const byTask = (id: string) =>
            launched.find((input) => input.initialMessage?.scheduledTaskId === id)!;
          assert.deepEqual(comparable(byTask("task:checked")), comparable(byTask("task:plain")));
          const [run] = yield* runsOf(service);
          assert.deepEqual(run?.check, check);
        }),
    ),
);

it.effect("a slow check holds up no other task, and the next poll starts no second check", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<ScheduledTaskRunCheck>();
    yield* withRunConditions(
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ({ service, poll, launches, checks, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(conditionTask());
          yield* service.upsert(
            conditionTask({ id: ScheduledTaskId.make("task:plain"), runCondition: null }),
          );
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          yield* poll;
          const plain = yield* Queue.take(launches);
          assert.equal(plain.initialMessage?.scheduledTaskId, "task:plain");
          yield* Deferred.await(started);

          yield* poll;
          assert.lengthOf(yield* Ref.get(checks), 1);
          const checking = (yield* service.list()).tasks.find((t) => t.id === task.id)!;
          assert.equal(checking.runCheckStartedAt, DateTime.formatIso(yield* DateTime.now));

          const ended = yield* whenTask((t) => t.runCheckStartedAt == null);
          yield* Deferred.succeed(release, NO_WORK);
          yield* ended;
          assert.equal(yield* Queue.size(launches), 0);
          assert.isNull(
            (yield* service.list()).tasks.find((t) => t.id === task.id)!.runCheckStartedAt,
          );
        }),
    );
  }),
);

it.effect("run now starts the chat without running the check", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, launches, checks }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(conditionTask());
        const ran = yield* service.runNow({ id: task.id });
        assert.equal(ran.threadId, ThreadId.make("thread:launched"));
        assert.equal(yield* Queue.size(launches), 1);
        assert.deepEqual(yield* Ref.get(checks), []);
        assert.isNull((yield* runsOf(service))[0]?.check);
      }),
  ),
);

it.effect.each([
  { name: "is still working", statuses: ["running"], continuationPending: false, skips: true },
  {
    name: "is still working behind a queued run someone cancelled",
    statuses: ["running", "cancelled"],
    continuationPending: false,
    skips: true,
  },
  {
    name: "was cut by a restart that has yet to continue it",
    statuses: ["interrupted"],
    continuationPending: true,
    skips: true,
  },
  {
    name: "delegated a task that still runs",
    statuses: ["completed"],
    continuationPending: false,
    delegating: true,
    skips: true,
  },
  {
    name: "was deleted while working",
    statuses: ["running"],
    continuationPending: false,
    deleted: "kept",
    skips: false,
  },
  {
    name: "was dropped by a projection rebuild",
    statuses: ["running"],
    continuationPending: false,
    deleted: "dropped",
    skips: false,
  },
  {
    name: "was interrupted",
    statuses: ["interrupted"],
    continuationPending: false,
    skips: false,
  },
  {
    name: "has finished",
    statuses: ["completed", "cancelled"],
    continuationPending: false,
    skips: false,
  },
] as const)(
  "the next occurrence of a task whose last chat $name is skipped: $skips",
  ({ skips, ...runs }) => {
    const logged: Array<unknown> = [];
    return withRunConditions(
      () => Effect.succeed(FOUND_WORK),
      ({ service, poll, launches, chatRuns, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(conditionTask({ runCondition: null }));
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          const recorded = yield* whenTask((t) => t.lastRunThreadId === "thread:launched");
          yield* poll;
          yield* Queue.take(launches);
          yield* recorded;

          yield* Ref.set(chatRuns, runs);
          const due = (yield* service.list()).tasks[0]!.nextRunAt!;
          yield* TestClock.setTime(Date.parse(due) + 1_000);
          const moved = yield* whenTask((t) => t.nextRunAt !== due);
          yield* poll;
          yield* moved;

          // A chat that is gone is ended, not a failed check.
          assert.notInclude(
            logged.map((message) => (message as ReadonlyArray<unknown>)[0]),
            "Could not check whether a scheduled task run is working",
          );
          if (!skips) {
            yield* Queue.take(launches);
            return;
          }
          assert.equal(yield* Queue.size(launches), 0);
          const [run] = yield* runsOf(service);
          assert.deepInclude(run, {
            outcome: "skipped",
            skipReason: "live_run_limit",
            scheduledFor: due,
            threadId: null,
          });
        }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            logged.push(message);
          }),
        ]),
      ),
    );
  },
);

it.effect(
  "a task whose live-run limit is 2 starts a second chat, skips a third and counts an ended chat that resumes",
  () =>
    withRunConditions(
      () => Effect.succeed(FOUND_WORK),
      ({ service, poll, launches, chatRuns, threadRuns, whenTask }) =>
        Effect.gen(function* () {
          yield* Ref.set(chatRuns, { statuses: ["running"], continuationPending: false });
          yield* service.upsert(conditionTask({ runCondition: null, maxLiveRuns: 2 }));
          const fireNext = Effect.gen(function* () {
            const due = (yield* service.list()).tasks[0]!.nextRunAt!;
            yield* TestClock.setTime(Date.parse(due) + 1_000);
            const moved = yield* whenTask((t) => t.nextRunAt !== due);
            yield* poll;
            yield* moved;
            return due;
          });

          yield* fireNext;
          yield* fireNext;
          assert.lengthOf(yield* Queue.takeAll(launches), 2);
          const skippedAt = yield* fireNext;
          assert.equal(yield* Queue.size(launches), 0);
          assert.deepInclude((yield* runsOf(service))[0], {
            outcome: "skipped",
            skipReason: "live_run_limit",
            scheduledFor: skippedAt,
          });

          const ended = { statuses: ["completed"], continuationPending: false } as const;
          yield* Ref.set(threadRuns, { "thread:launched": ended });
          yield* fireNext;
          assert.lengthOf(yield* Queue.takeAll(launches), 1);

          // A follow-up or a resume after a restart makes the first chat work again.
          yield* Ref.set(threadRuns, { "thread:launched:3": ended });
          const resumedAt = yield* fireNext;
          assert.equal(yield* Queue.size(launches), 0);
          assert.deepInclude((yield* runsOf(service))[0], {
            outcome: "skipped",
            skipReason: "live_run_limit",
            scheduledFor: resumedAt,
          });
        }),
    ),
);

it.effect("saving keeps a live-run limit it does not name, and deleting the task drops it", () =>
  withRunConditions(
    () => Effect.succeed(FOUND_WORK),
    ({ service, sql }) =>
      Effect.gen(function* () {
        const limitOf = service.list().pipe(Effect.map(({ tasks }) => tasks[0]?.maxLiveRuns));
        const stored = sql`SELECT max_live_runs FROM scheduled_task_live_run_limit`;
        yield* service.upsert(conditionTask({ runCondition: null }));
        assert.equal(yield* limitOf, 1);
        yield* service.upsert(conditionTask({ runCondition: null, maxLiveRuns: 3 }));
        yield* service.upsert(conditionTask({ runCondition: null, title: "Renamed" }));
        assert.equal(yield* limitOf, 3);
        yield* service.upsert(conditionTask({ runCondition: null, maxLiveRuns: 1 }));
        assert.equal(yield* limitOf, 1);
        assert.lengthOf(yield* stored, 0);

        yield* service.upsert(conditionTask({ runCondition: null, maxLiveRuns: 2 }));
        yield* service.delete({ id: ScheduledTaskId.make("task:checked") });
        assert.lengthOf(yield* stored, 0);
      }),
  ),
);

it.effect("saving keeps, clears and sets a run condition, and refuses one it can't run", () =>
  withRunConditions(
    () => Effect.succeed(FOUND_WORK),
    ({ service, sql }) =>
      Effect.gen(function* () {
        const conditionOf = (id = "task:checked") =>
          service
            .list()
            .pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === id)?.runCondition));
        yield* service.upsert(conditionTask({ runCondition: { command: "node ~/check.mjs" } }));
        assert.deepEqual(yield* conditionOf(), { command: "node ~/check.mjs", timeoutSeconds: 60 });
        const { runCondition: _omitted, ...withoutCondition } = conditionTask();
        yield* service.upsert({ ...withoutCondition, title: "Renamed" });
        assert.deepEqual(yield* conditionOf(), { command: "node ~/check.mjs", timeoutSeconds: 60 });
        yield* service.upsert(conditionTask());
        assert.deepEqual(yield* conditionOf(), RUN_CONDITION);
        yield* service.upsert(conditionTask({ runCondition: null }));
        assert.isNull(yield* conditionOf());

        const webhook = { type: "webhook", signature: null, maxDeliveryAgeMinutes: null } as const;
        for (const [input, message] of [
          [
            conditionTask({ runCondition: { command: `node "open` } }),
            "The check has a quote that is never closed.",
          ],
          [
            conditionTask({ runCondition: { command: "gh pr list | grep open" } }),
            "The check is one program with its arguments, without a shell. Put pipes, redirects and && in a script and run that.",
          ],
          [
            conditionTask({ schedule: webhook }),
            "A webhook task runs on each request, so it can't have a check.",
          ],
        ] as const) {
          assert.equal((yield* service.upsert(input).pipe(Effect.flip)).message, message);
        }
        assert.isNull(yield* conditionOf());

        // Saved as a webhook task, it loses the stored condition.
        yield* service.upsert(conditionTask());
        yield* service.upsert({ ...withoutCondition, schedule: webhook });
        assert.isNull(yield* conditionOf());

        yield* service.upsert(conditionTask());
        yield* service.delete({ id: ScheduledTaskId.make("task:checked") });
        assert.lengthOf(yield* sql`SELECT task_id FROM scheduled_task_run_conditions`, 0);
      }),
  ),
);

it.effect("a policy that forbids full access refuses saving a run condition", () =>
  withRunConditions(
    () => Effect.succeed(FOUND_WORK),
    ({ service }) =>
      Effect.gen(function* () {
        const refused = yield* service
          .upsert(conditionTask({ runtimeMode: "auto-accept-edits" }))
          .pipe(Effect.flip);
        assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      }),
    {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: { maxRuntimeMode: "auto-accept-edits" },
    },
  ),
);

const clearCondition = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.upsert(conditionTask({ runCondition: null }));
const pause = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.setEnabled({ id: ScheduledTaskId.make("task:checked"), enabled: false });

it.effect.each([
  { name: "its condition is cleared", answer: NO_WORK, change: clearCondition, launchesAfter: 1 },
  {
    name: "its condition is cleared",
    answer: FOUND_WORK,
    change: clearCondition,
    launchesAfter: 1,
  },
  { name: "it is paused", answer: NO_WORK, change: pause, launchesAfter: 0 },
  { name: "it is paused", answer: FOUND_WORK, change: pause, launchesAfter: 0 },
  {
    name: "it is run by hand",
    answer: NO_WORK,
    change: (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
      service.runNow({ id: ScheduledTaskId.make("task:checked") }),
    launchesAfter: 1,
  },
])(
  "a check that answers $answer.outcome acts on nothing when $name meanwhile",
  ({ answer, change, launchesAfter }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<ScheduledTaskRunCheck>();
      yield* withRunConditions(
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ({ service, poll, launches, checks, whenTask }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(conditionTask());
            yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
            yield* poll;
            yield* Deferred.await(started);
            yield* change(service);
            const launchedByChange = yield* Queue.size(launches);

            const ended = yield* whenTask((t) => t.runCheckStartedAt == null);
            yield* Deferred.succeed(release, answer);
            yield* ended;
            assert.equal(yield* Queue.size(launches), launchedByChange);
            assert.isFalse((yield* runsOf(service)).some((run) => run.skipReason === "no_work"));
            assert.isNull((yield* service.list()).tasks[0]!.lastNoWorkSkip ?? null);

            // A cleared condition leaves the occurrence due, so the next poll starts the chat
            // directly, without a check.
            yield* poll;
            assert.equal(yield* Queue.size(launches), launchesAfter);
            assert.lengthOf(yield* Ref.get(checks), 1);
            assert.isTrue((yield* runsOf(service)).every((run) => run.check === null));
          }),
      );
    }),
);

it.effect(
  "an answer that comes after a hand run starts no chat; the next occurrence checks again",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<ScheduledTaskRunCheck>();
      yield* withRunConditions(
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ({ service, poll, launches, checks, whenTask }) =>
          Effect.gen(function* () {
            const { task } = yield* service.upsert(
              conditionTask({ schedule: { type: "interval", everyMs: 5 * 60_000 } }),
            );
            yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
            yield* poll;
            yield* Deferred.await(started);
            yield* TestClock.adjust("1 minute");
            yield* service.runNow({ id: task.id });
            const nextDue = (yield* service.list()).tasks[0]!.nextRunAt!;
            // Due again while the first check still runs: the poll leaves the task to that check.
            yield* TestClock.setTime(Date.parse(nextDue) + 1_000);
            yield* poll;
            assert.lengthOf(yield* Ref.get(checks), 1);

            const ended = yield* whenTask((t) => t.runCheckStartedAt == null);
            yield* Deferred.succeed(release, FOUND_WORK);
            yield* ended;
            assert.equal(yield* Queue.size(launches), 1);

            yield* poll;
            yield* Queue.take(launches);
            yield* Queue.take(launches);
            assert.lengthOf(yield* Ref.get(checks), 2);
            assert.deepEqual(
              (yield* runsOf(service)).map((run) => [run.trigger, run.scheduledFor, run.check]),
              [
                ["scheduled", nextDue, FOUND_WORK],
                ["manual", null, null],
              ],
            );
          }),
      );
    }),
);

it.effect("a one-time task whose check finds no work is used up", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, poll, launches, checks, whenTask }) =>
      Effect.gen(function* () {
        const runAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 5 }));
        yield* service.upsert(conditionTask({ schedule: { type: "once", runAt } }));
        yield* TestClock.setTime(Date.parse(runAt) + 1_000);
        const usedUp = yield* whenTask((t) => t.nextRunAt === null && t.runCheckStartedAt == null);
        yield* poll;
        yield* usedUp;

        yield* TestClock.adjust("1 day");
        yield* poll;
        assert.equal(yield* Queue.size(launches), 0);
        assert.lengthOf(yield* Ref.get(checks), 1);
        assert.deepEqual(
          (yield* runsOf(service)).map((run) => [run.skipReason, run.scheduledFor]),
          [["no_work", runAt]],
        );
      }),
  ),
);

it.effect("a check that skips a caught-up missed run records it as a catch-up", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, poll, launches, whenTask }) =>
      Effect.gen(function* () {
        const at = (day: number, hour: number) =>
          DateTime.makeZonedUnsafe(
            { year: 2026, month: 11, day, hour, minute: 0, second: 0, millisecond: 0 },
            { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
          );
        const isoAt = (day: number, hour: number) =>
          DateTime.formatIso(DateTime.toUtc(at(day, hour)));
        yield* TestClock.setTime(DateTime.toEpochMillis(at(10, 12)));
        yield* service.upsert(
          conditionTask({ schedule: { type: "fixed_time", timeOfDay: "07:00" } }),
        );
        // The app was off over three daily times.
        yield* TestClock.setTime(DateTime.toEpochMillis(at(13, 9)));
        const skipped = yield* whenTask(
          (t) => t.lastNoWorkSkip != null && t.runCheckStartedAt == null,
        );
        yield* poll;
        yield* skipped;
        assert.equal(yield* Queue.size(launches), 0);
        const [run] = yield* runsOf(service);
        assert.deepInclude(run, {
          trigger: "catch_up",
          skipReason: "no_work",
          scheduledFor: isoAt(13, 7),
        });
        assert.equal((yield* service.list()).tasks[0]!.nextRunAt, isoAt(14, 7));
      }),
  ),
);

it.effect(
  "no-work and usage-limited skips each keep their own history, so they never push real runs out",
  () =>
    withRunConditions(
      () => Effect.succeed(NO_WORK),
      ({ service, sql, poll, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(conditionTask());
          yield* service.runNow({ id: task.id });
          const ranAt = Date.parse((yield* runsOf(service))[0]!.startedAt);
          // More skips of each kind than the whole history keeps, all after the run.
          for (let index = 1; index <= 60; index += 1) {
            const at = DateTime.formatIso(DateTime.makeUnsafe(ranAt + index * 1_000));
            yield* sql`
            INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at,
              completed_at, outcome, skip_reason, check_json)
            VALUES (${`skip-${index}`}, ${task.id}, 'scheduled', ${at}, ${at}, ${at}, 'skipped',
              'no_work', ${JSON.stringify(NO_WORK)})
          `;
            yield* sql`
            INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at,
              completed_at, outcome, skip_reason)
            VALUES (${`limited-${index}`}, ${task.id}, 'scheduled', ${at}, ${at}, ${at}, 'skipped',
              'usage_limited')
          `;
          }
          const next = (yield* service.list()).tasks[0]!.nextRunAt!;
          yield* TestClock.setTime(Math.max(Date.parse(next), ranAt + 61_000) + 1_000);
          const skipped = yield* whenTask(
            (t) => t.nextRunAt !== next && t.runCheckStartedAt == null,
          );
          yield* poll;
          yield* skipped;

          const runs = yield* runsOf(service);
          const skips = runs.filter((run) => run.skipReason === "no_work");
          assert.lengthOf(skips, 10);
          assert.deepEqual(
            skips.slice(1).map((run) => run.id),
            Array.from({ length: 9 }, (_, index) => `skip-${60 - index}`),
          );
          assert.deepEqual(
            runs.filter((run) => run.skipReason === "usage_limited").map((run) => run.id),
            Array.from({ length: 10 }, (_, index) => `limited-${60 - index}`),
          );
          assert.deepEqual(
            runs.filter((run) => run.skipReason == null).map((run) => run.trigger),
            ["manual"],
          );
        }),
    ),
);

it.effect("a group pause turns off the group's running tasks and resume turns on only those", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-10T12:00:00.000Z"));
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
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
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (
        id: string,
        options: {
          readonly enabled?: boolean;
          readonly group?: string | null;
          readonly runAt?: string;
        } = {},
      ) =>
        service.upsert({
          id: ScheduledTaskId.make(id),
          title: id,
          prompt: "Check progress",
          enabled: options.enabled ?? true,
          schedule:
            options.runAt === undefined
              ? { type: "interval", everyMs: 300_000 }
              : { type: "once", runAt: options.runAt },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          ...(options.group === undefined ? {} : { group: options.group }),
        });
      const listed = service
        .list()
        .pipe(
          Effect.map(({ tasks }) =>
            Object.fromEntries(
              tasks.map((task) => [
                task.id,
                { enabled: task.enabled, marked: task.pausedWithGroup === true },
              ]),
            ),
          ),
        );
      const group = "Machine care";
      assert.equal((yield* save("task:on", { group })).task.group, group);
      // A save that leaves the group out keeps it.
      assert.equal((yield* save("task:on")).task.group, group);
      yield* save("task:off", { group, enabled: false });
      yield* save("task:once", { group, runAt: "2026-11-10T13:00:00.000Z" });
      yield* save("task:toggled", { group });
      assert.isNull((yield* save("task:ungrouped")).task.group);
      yield* save("task:paused-again", { group });
      const ids = [
        "task:on",
        "task:off",
        "task:once",
        "task:toggled",
        "task:ungrouped",
        "task:paused-again",
      ].map((id) => ScheduledTaskId.make(id));

      const paused = yield* service.setGroupPaused({ ids, paused: true });
      assert.deepEqual(paused, { ids: [ids[0]!, ids[2]!, ids[3]!, ids[5]!], refused: [] });
      assert.deepEqual(yield* listed, {
        "task:on": { enabled: false, marked: true },
        "task:off": { enabled: false, marked: false },
        "task:once": { enabled: false, marked: true },
        "task:toggled": { enabled: false, marked: true },
        "task:ungrouped": { enabled: true, marked: false },
        "task:paused-again": { enabled: false, marked: true },
      });
      // Saving a paused task with enabled:false keeps the mark; switching one by hand clears it,
      // even a pause sent by a client that still showed the task on.
      yield* save("task:on", { enabled: false });
      yield* service.setEnabled({ id: ids[3]!, enabled: true });
      yield* service.setEnabled({ id: ids[3]!, enabled: false });
      yield* service.setEnabled({ id: ids[5]!, enabled: false });

      yield* TestClock.adjust("2 hours");
      const resumed = yield* service.setGroupPaused({ ids, paused: false });
      assert.deepEqual(resumed, {
        ids: [ids[0]!],
        refused: [{ id: ids[2]!, message: "The run time has passed. Pick a time in the future." }],
      });
      assert.deepEqual(yield* listed, {
        "task:on": { enabled: true, marked: false },
        "task:off": { enabled: false, marked: false },
        "task:once": { enabled: false, marked: false },
        "task:toggled": { enabled: false, marked: false },
        "task:ungrouped": { enabled: true, marked: false },
        "task:paused-again": { enabled: false, marked: false },
      });
      assert.isNotNull((yield* service.list()).tasks.find(({ id }) => id === ids[0])?.nextRunAt);
      assert.deepEqual(yield* service.setGroupPaused({ ids, paused: false }), {
        ids: [],
        refused: [],
      });

      assert.isNull((yield* save("task:on", { group: null })).task.group);
      yield* service.delete({ id: ids[1]! });
      assert.deepEqual(yield* sql`SELECT task_id FROM scheduled_task_group ORDER BY task_id`, [
        { task_id: "task:once" },
        { task_id: "task:paused-again" },
        { task_id: "task:toggled" },
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
