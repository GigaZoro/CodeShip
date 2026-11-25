import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type MemoryShortage,
  MessageId,
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
  sameThreadFolder,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

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
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
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
  "releases interrupted runs, keeps the chat of one whose prompt landed, deletes the empty chat of one whose prompt never landed unless the user wrote in it or moved it, leaves one whose chat it cannot read running, and renames old live-run skips on startup, and still executes due tasks, naming each chat before launching it, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const cutAt = "2026-09-09T11:59:00.000Z";
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
        { id: "stuck-prompted", next: now, status: "running" },
        { id: "stuck-caught-up", next: now, status: "running" },
        { id: "stuck-unprompted", next: now, status: "running" },
        { id: "stuck-user-only", next: now, status: "running" },
        { id: "stuck-moved", next: now, status: "running" },
        { id: "stuck-unread", next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      // A restart cut these runs after their chats were named: one chat got its prompt, so did a
      // catch-up run's, one is empty, the user wrote in one that never got it, moved another, and
      // one cannot be read.
      yield* sql`
        UPDATE scheduled_tasks SET last_run_at = ${cutAt}
        WHERE task_id IN ('stuck-valid', 'stuck-prompted', 'stuck-caught-up', 'stuck-unprompted',
          'stuck-user-only', 'stuck-moved', 'stuck-unread')
      `;
      // The service adds this column at startup; these runs were recorded by one that had it.
      yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN chat_folder TEXT`;
      yield* sql`
        INSERT INTO scheduled_task_runs
          (run_id, task_id, trigger, started_at, outcome, thread_id, chat_folder)
        VALUES
          ('run:cut-unnamed', 'stuck-valid', 'scheduled', ${cutAt}, 'running', NULL, NULL),
          ('run:cut-prompted', 'stuck-prompted', 'scheduled', ${cutAt}, 'running', 'thread:prompted', NULL),
          ('run:cut-caught-up:catch_up', 'stuck-caught-up', 'catch_up', ${cutAt}, 'running', 'thread:caught-up', NULL),
          ('run:cut-unprompted', 'stuck-unprompted', 'scheduled', ${cutAt}, 'running', 'thread:unprompted', 'Reports'),
          ('run:cut-user-only', 'stuck-user-only', 'scheduled', ${cutAt}, 'running', 'thread:user-only', NULL),
          ('run:cut-moved', 'stuck-moved', 'scheduled', ${cutAt}, 'running', 'thread:moved', 'Reports'),
          ('run:cut-unread', 'stuck-unread', 'scheduled', ${cutAt}, 'running', 'thread:unread', NULL)
      `;
      // Marking each task running named its run.
      yield* sql`
        UPDATE scheduled_tasks SET last_run_id = (
          SELECT run_id FROM scheduled_task_runs WHERE task_id = scheduled_tasks.task_id
        )
        WHERE last_run_at = ${cutAt}
      `;
      const chats = new Map<string, { folder: string | null; messageIds: ReadonlyArray<string> }>([
        [
          "thread:prompted",
          { folder: null, messageIds: ["scheduled-task-message:run:cut-prompted"] },
        ],
        [
          "thread:caught-up",
          { folder: null, messageIds: ["scheduled-task-message:run:cut-caught-up:scheduled"] },
        ],
        ["thread:unprompted", { folder: "reports", messageIds: [] }],
        ["thread:user-only", { folder: null, messageIds: ["message:typed-by-user"] }],
        ["thread:moved", { folder: "Mine", messageIds: [] }],
      ]);
      const readChat = (
        threadId: ThreadId,
        read: (chat: { folder: string | null; messageIds: ReadonlyArray<string> }) => unknown,
      ) => {
        const chat = chats.get(threadId);
        return chat === undefined
          ? Effect.die(new Error("test read failure"))
          : Effect.succeed(read(chat) as never);
      };
      const dispatchedCommands = yield* Ref.make<ReadonlyArray<{ readonly commandId: string }>>([]);

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const namedBeforeLaunch = yield* Ref.make<ReadonlyArray<boolean>>([]);
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
                MemoryAdmission.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: (input) =>
                    sql<{ readonly run_id: string; readonly thread_id: string | null }>`
                      SELECT run_id, thread_id FROM scheduled_task_runs
                      WHERE task_id = ${input.initialMessage?.scheduledTaskId ?? null}
                        AND outcome = 'running'
                    `.pipe(
                      Effect.orDie,
                      Effect.flatMap((records) =>
                        Ref.update(namedBeforeLaunch, (named) => [
                          ...named,
                          input.threadId !== undefined &&
                            records.length === 1 &&
                            records[0]?.thread_id === input.threadId &&
                            input.initialMessage?.messageId ===
                              `scheduled-task-message:${records[0]?.run_id}`,
                        ]),
                      ),
                      Effect.andThen(Ref.updateAndGet(dispatched, (n) => n + 1)),
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
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadShell: (threadId) =>
                    readChat(threadId, (chat) => ({
                      id: threadId,
                      folder: chat.folder,
                      deletedAt: null,
                    })),
                  getThreadRecords: (threadId, _fields, filter) =>
                    readChat(threadId, (chat) => ({
                      messages: chat.messageIds
                        .filter((id) => filter?.messageIds?.includes(MessageId.make(id)) ?? true)
                        .map((id) => ({ id })),
                    })),
                  getMessageCount: (threadId) =>
                    readChat(threadId, (chat) => chat.messageIds.length),
                  dispatch: (command) =>
                    Ref.update(dispatchedCommands, (commands) => [...commands, command]).pipe(
                      Effect.as({ sequence: 1, storedEvents: [] } as never),
                    ),
                }),
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
      assert.equal(rows.length, 15);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      // A task whose run's chat could not be read still moves on, so its schedule continues.
      for (const id of [
        "stuck-valid",
        "stuck-corrupt",
        "stuck-huge",
        null,
        "stuck-unprompted",
        "stuck-user-only",
        "stuck-moved",
        "stuck-unread",
      ]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["stuck-prompted", "stuck-caught-up"]) {
        const prompted = byId.get(id);
        assert.equal(prompted?.last_run_status, "succeeded");
        assert.isNull(prompted?.last_run_error);
        assert.isNotNull(prompted?.next_run_at);
        assert.equal(prompted?.run_count, 1);
      }
      assert.deepEqual(
        yield* sql`
          SELECT run_id, outcome, thread_id, error, completed_at IS NOT NULL AS completed
          FROM scheduled_task_runs WHERE run_id LIKE 'run:cut-%' ORDER BY run_id
        `,
        [
          {
            run_id: "run:cut-caught-up:catch_up",
            outcome: "succeeded",
            thread_id: "thread:caught-up",
            error: null,
            completed: 1,
          },
          {
            run_id: "run:cut-moved",
            outcome: "failed",
            thread_id: null,
            error: "Run was interrupted by a server restart.",
            completed: 1,
          },
          {
            run_id: "run:cut-prompted",
            outcome: "succeeded",
            thread_id: "thread:prompted",
            error: null,
            completed: 1,
          },
          {
            run_id: "run:cut-unnamed",
            outcome: "failed",
            thread_id: null,
            error: "Run was interrupted by a server restart.",
            completed: 1,
          },
          {
            run_id: "run:cut-unprompted",
            outcome: "failed",
            thread_id: null,
            error: "Run was interrupted by a server restart.",
            completed: 1,
          },
          {
            run_id: "run:cut-unread",
            outcome: "running",
            thread_id: "thread:unread",
            error: null,
            completed: 0,
          },
          {
            run_id: "run:cut-user-only",
            outcome: "failed",
            thread_id: null,
            error: "Run was interrupted by a server restart.",
            completed: 1,
          },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT task_id, last_run_thread_id FROM scheduled_task_sidebar ORDER BY task_id`,
        [
          { task_id: "stuck-caught-up", last_run_thread_id: "thread:caught-up" },
          { task_id: "stuck-prompted", last_run_thread_id: "thread:prompted" },
        ],
      );
      assert.deepEqual(
        (yield* Ref.get(dispatchedCommands)).map(({ commandId: _, ...command }) => command),
        [{ type: "thread.delete", threadId: "thread:unprompted", onlyIfUnused: true }],
      );
      assert.deepEqual(yield* Ref.get(namedBeforeLaunch), [true, true, true, true]);
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
      // Runs recorded before the counts existed, runs settled at startup and runs started since are
      // each counted once, under the outcome and skip reason they end with.
      const counted = yield* sql`
        SELECT task_id, day, outcome, skip_reason, count FROM scheduled_task_daily_counts
        WHERE count > 0 ORDER BY task_id, outcome
      `;
      assert.deepEqual(
        counted,
        yield* sql`
          SELECT task_id, substr(started_at, 1, 10) AS day, outcome,
            coalesce(skip_reason, '') AS skip_reason, count(*) AS count
          FROM scheduled_task_runs WHERE outcome <> 'running'
          GROUP BY 1, 2, 3, 4 ORDER BY task_id, outcome
        `,
      );
      assert.lengthOf(counted, 11);
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
                MemoryAdmission.layerTest(),
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
          MemoryAdmission.layerTest(),
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
      const { task } = yield* service.upsert(
        {
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
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
      // Added once the run is underway, which already read its prompt.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO scheduled_task_prompt_files (task_id, path) VALUES (${task.id}, 'check.md')
      `;
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT m.name FROM sqlite_master m
        WHERE m.type = 'table' AND m.name LIKE 'scheduled_task%'
          AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'task_id')
      `;
      const leftover = yield* Effect.forEach(tables, ({ name }) =>
        sql`SELECT 1 FROM ${sql(name)} WHERE task_id = ${task.id}`.pipe(
          Effect.map((rows) => (rows.length === 0 ? [] : [name])),
        ),
      );
      assert.deepEqual(leftover.flat(), []);
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
          MemoryAdmission.layerTest(),
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
      const { task } = yield* service.upsert(
        {
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
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );

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
          MemoryAdmission.layerTest(),
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
        service.upsert(
          {
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
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
          MemoryAdmission.layerTest(),
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
        service.upsert(
          {
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
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
      const { task } = yield* upsert(true);
      // With no scheduled tasks model, it runs the new-thread default.
      assert.equal(task.modelSelection.model, "gpt-new");
      const stored = (yield* service.list({ resolveModels: false })).tasks.find(
        (candidate) => candidate.id === task.id,
      )!;
      assert.deepEqual(stored.modelSelection, ownModel);
      yield* service.upsert(
        { ...stored, title: "Renamed", promptFile: null },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
      assert.deepEqual(
        (yield* service.setFollowsDefaultModel(off, ScheduledTaskService.CHANGED_IN_APP)).ids,
        [task.id],
      );
      assert.equal(yield* listedModel(), "gpt-5.4");
      assert.deepEqual(
        (yield* service.setFollowsDefaultModel(off, ScheduledTaskService.CHANGED_IN_APP)).ids,
        [],
      );

      yield* service.setFollowsDefaultModel(
        { ids: [task.id], followsDefaultModel: true },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
          MemoryAdmission.layerTest(),
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
        service.upsert(
          {
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
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled(
          { id: ScheduledTaskId.make("task:above-ceiling"), enabled: true },
          ScheduledTaskService.CHANGED_IN_APP,
        )
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      yield* service.upsert(
        {
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
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
          MemoryAdmission.layerTest(),
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
      const { task } = yield* service.upsert(
        {
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
        },
        ScheduledTaskService.CHANGED_IN_APP,
      );

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
  /** "dropped": a projection rebuild removed the deleted chat. */
  readonly deleted?: "kept" | "dropped";
  /** How long nothing has happened in the chat, on which provider. */
  readonly quiet?: { readonly driver: string; readonly hours: number };
  /**
   * The delegated task the chat waits on, then the one that task's chat waits on, and so on, with
   * how long nothing has happened in each one's chat. A remote task has no chat here.
   */
  readonly delegated?: ReadonlyArray<{
    readonly driver: string;
    readonly hours: number;
    readonly remote?: true;
  }>;
}
type ThreadCommand = Parameters<
  ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
>[0];

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
    readonly threadCommands: Ref.Ref<ReadonlyArray<ThreadCommand>>;
    /**
     * Watches the list from now on; the effect it returns waits until the checked task matches.
     * Changes coalesce, so tests wait for a state, not a number of changes.
     */
    readonly whenTask: (
      matches: (task: ScheduledTask) => boolean,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
  }) => Effect.Effect<A, E, Scope.Scope>,
  policy?: Parameters<typeof ManagedPolicy.layerTest>[0],
  memory: Layer.Layer<MemoryAdmission.MemoryAdmission> = MemoryAdmission.layerTest(),
  database = SqlitePersistence.layerMemory,
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
    const threadCommands = yield* Ref.make<ReadonlyArray<ThreadCommand>>([]);
    // The first chat keeps the plain id the older tests expect; later ones are numbered.
    let launched = 0;
    const workers = new Map<string, Effect.Effect<void>>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(policy),
          ServerSettings.layerTest(),
          memory,
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
              Effect.gen(function* () {
                // A delegated task's chat is "<chat>/task/<depth>".
                const [chatId = threadId, depth] = threadId.split("/task/");
                const { statuses, deleted, quiet, delegated = [] } = yield* runsOfThread(chatId);
                if (deleted === "dropped") {
                  return yield* new Orchestrator.OrchestratorProjectionError({
                    threadId,
                    cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
                  });
                }
                const now = yield* DateTime.now;
                const tasksAt = (index: number) => {
                  const task = delegated[index];
                  if (task === undefined) return [];
                  const remote = task.remote === true;
                  return [
                    {
                      status: "running",
                      completionDelivery: null,
                      driver: task.driver,
                      childThreadId: remote ? null : `${chatId}/task/${index}`,
                      ...(remote ? { remoteChild: { environmentId: "environment:other" } } : {}),
                    },
                  ];
                };
                if (depth !== undefined) {
                  const index = Number(depth);
                  return {
                    thread: {
                      id: threadId,
                      updatedAt: DateTime.subtract(now, { hours: delegated[index]!.hours }),
                    },
                    subagents: tasksAt(index + 1),
                  } as never;
                }
                return {
                  thread: {
                    id: threadId,
                    deletedAt: deleted === "kept" ? "2026-01-01T00:00:00.000Z" : null,
                    updatedAt: DateTime.subtract(now, { hours: quiet?.hours ?? 0 }),
                  },
                  runs: statuses.map((status, index) => ({
                    id: `run:chat:${index}`,
                    threadId,
                    ordinal: index + 1,
                    status,
                    providerThreadId: "provider-thread:chat",
                  })),
                  providerThreads: [
                    { id: "provider-thread:chat", driver: quiet?.driver ?? "codex" },
                  ],
                  subagents: tasksAt(0),
                } as never;
              }),
            restartContinuationPending: (run) =>
              runsOfThread(run.threadId).pipe(Effect.map((chat) => chat.continuationPending)),
            dispatch: (command) =>
              Ref.update(threadCommands, (all) => [...all, command]).pipe(
                Effect.as({ sequence: 1 } as never),
              ),
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
        threadCommands,
        whenTask,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  }).pipe(Effect.provide(database));

const runsOf = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.listRuns({ id: ScheduledTaskId.make("task:checked") }).pipe(Effect.map((r) => r.runs));

it.effect.each([
  "edited to 09:00",
  "replaced",
  "weekdays edited",
  "catch-up enabled",
  "unchanged",
  "history insert fails",
] as const)("settles a missed 07:00 occurrence (%s)", (change) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const database = SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
      Layer.orDie,
    );
    yield* withRunConditions(
      () => Effect.succeed(FOUND_WORK),
      ({ service, sql, poll }) =>
        Effect.gen(function* () {
          const at = (day: number, hour: number, minute = 0) =>
            DateTime.makeZonedUnsafe(
              { year: 2026, month: 7, day, hour, minute, second: 0, millisecond: 0 },
              { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
            );
          const input = conditionTask({
            schedule: { type: "fixed_time", timeOfDay: "07:00" },
            catchUpMissedRun: false,
          });
          const save = (input: ScheduledTaskUpsertInput) =>
            service.upsert(input, ScheduledTaskService.CHANGED_IN_APP);
          yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6)));
          const { task } = yield* save(input);
          yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6, 30)));
          const observed = (yield* save(input)).task;
          yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 8)));

          const hasWriter = yield* Deferred.make<void>();
          const decided = yield* Deferred.make<void>();
          const tracer = Tracer.make({
            span(options) {
              if (options.name === "ScheduledTaskService.rescheduleMissedRun") {
                Deferred.doneUnsafe(decided, Effect.void);
              }
              return new Tracer.NativeSpan(options);
            },
          });
          // The poll can read through the reader pool. Its skip must wait for this writer.
          const writer = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(hasWriter, undefined);
                yield* Deferred.await(decided);
                if (change === "edited to 09:00") {
                  yield* save({ ...input, schedule: { type: "fixed_time", timeOfDay: "09:00" } });
                } else if (change === "replaced") {
                  yield* service.delete({ id: task.id });
                  // Give both rows the same due time and edit timestamp, but distinct creation times.
                  yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6, 30)));
                  const replacement = (yield* save(input)).task;
                  assert.notEqual(replacement.createdAt, task.createdAt);
                  assert.equal(replacement.updatedAt, observed.updatedAt);
                  assert.equal(replacement.nextRunAt, observed.nextRunAt);
                } else if (change === "weekdays edited" || change === "catch-up enabled") {
                  yield* TestClock.setTime(DateTime.toEpochMillis(at(1, 6, 30)));
                  const edit =
                    change === "weekdays edited"
                      ? {
                          ...input,
                          schedule: {
                            type: "fixed_time" as const,
                            timeOfDay: "07:00",
                            weekdays: [3],
                          },
                        }
                      : { ...input, catchUpMissedRun: true };
                  const edited = (yield* save(edit)).task;
                  assert.equal(edited.updatedAt, observed.updatedAt);
                  assert.equal(edited.nextRunAt, observed.nextRunAt);
                } else if (change === "history insert fails") {
                  yield* sql`CREATE TRIGGER reject_skip BEFORE INSERT ON scheduled_task_runs
                      BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`;
                }
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(hasWriter);
          let reportedSkips = 0;
          yield* poll.pipe(
            Effect.withTracer(tracer),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  if (
                    Array.isArray(message) &&
                    message[0] === "Skipping missed schedule task run"
                  ) {
                    reportedSkips++;
                  }
                }),
              ]),
            ),
          );
          yield* Fiber.join(writer);

          const skipped = change === "unchanged";
          const expectedNext =
            change === "edited to 09:00" ? at(1, 9) : skipped ? at(2, 7) : at(1, 7);
          const [current] = (yield* service.list()).tasks;
          assert.equal(current?.nextRunAt, DateTime.formatIso(expectedNext));
          const runs = yield* runsOf(service);
          assert.deepEqual(
            runs.map(({ outcome, skipReason, scheduledFor }) => ({
              outcome,
              skipReason,
              scheduledFor,
            })),
            skipped
              ? [{ outcome: "skipped", skipReason: "missed", scheduledFor: task.nextRunAt }]
              : [],
          );
          assert.equal(reportedSkips, skipped ? 1 : 0);
        }),
      undefined,
      undefined,
      database,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a check that finds no work starts no chat and records the occurrence as skipped", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, poll, launches, checks, whenTask }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          conditionTask(),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
        yield* service.upsert(
          conditionTask({ runCondition: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
          const { task } = yield* service.upsert(
            conditionTask(),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* service.upsert(
            conditionTask({ id: ScheduledTaskId.make("task:plain"), runCondition: null }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          yield* poll;
          const launched = [yield* Queue.take(launches), yield* Queue.take(launches)];
          const comparable = (input: LaunchInput) => ({
            ...input,
            commandId: null,
            threadId: null,
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

// The run condition's contract with the chat it starts: skills read these lines to take the work.
it.effect.each([
  {
    name: "a JSON answer's reason and unit",
    check: { ...FOUND_WORK, detail: "New unit", unit: "AB#6663" },
    block: "Run condition found work.\nReason: New unit\nUnit: AB#6663",
  },
  {
    name: "a plain answer's reason line",
    check: { ...FOUND_WORK, detail: "3 open PRs" },
    block: "Run condition found work.\nReason: 3 open PRs",
  },
] satisfies ReadonlyArray<{ name: string; check: ScheduledTaskRunCheck; block: string }>)(
  "a check that found work starts the chat with $name at the end of its first prompt",
  ({ check, block }) =>
    withRunConditions(
      () => Effect.succeed(check),
      ({ service, poll, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            conditionTask(),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          yield* poll;
          const launched = yield* Queue.take(launches);
          assert.equal(launched.initialMessage?.text, `Review the open pull requests\n\n${block}`);
          const [run] = yield* runsOf(service);
          assert.deepEqual(run?.check, check);
        }),
    ),
);

it.effect("lists a task's run condition as failing once its last 3 checks here failed", () =>
  withRunConditions(
    () => Effect.succeed(FOUND_WORK),
    ({ service, sql }) =>
      Effect.gen(function* () {
        yield* service.upsert(conditionTask(), ScheduledTaskService.CHANGED_IN_APP);
        const failed = (detail: string): ScheduledTaskRunCheck => ({
          outcome: "failed",
          failure: "exit_code",
          exitCode: 1,
          detail,
        });
        const record = (
          minute: number,
          check: ScheduledTaskRunCheck | null,
          options: {
            readonly ranOn?: string;
            readonly trigger?: string;
            readonly skipReason?: string;
          } = {},
        ) => {
          const at = `2026-11-16T07:${String(minute).padStart(2, "0")}:00.000Z`;
          const skipReason =
            options.skipReason ?? (options.ranOn === undefined ? null : "ran_elsewhere");
          return sql`
            INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at,
              outcome, skip_reason, ran_on, check_json)
            VALUES (${`run:${minute}`}, 'task:checked', ${options.trigger ?? "scheduled"}, ${at},
              ${at}, ${skipReason === null ? "succeeded" : "skipped"}, ${skipReason},
              ${options.ranOn ?? null}, ${check === null ? null : JSON.stringify(check)})
          `.pipe(Effect.as(at));
        };
        const failingCheck = service
          .list()
          .pipe(Effect.map(({ tasks }) => tasks[0]!.failingCheck ?? null));

        yield* record(0, NO_WORK);
        yield* record(1, failed("ADO token expired"));
        yield* record(2, failed("ADO token expired"));
        // Another machine's answer to a one-machine occurrence is not this machine's check.
        yield* record(3, NO_WORK, { ranOn: "environment:peer" });
        assert.isNull(yield* failingCheck);

        const third = yield* record(4, failed("ADO token still expired"));
        // Run now skips the check, so it neither ends nor extends the streak.
        yield* record(5, null, { trigger: "manual" });
        const failing = { at: third, check: failed("ADO token still expired") };
        assert.deepEqual(yield* failingCheck, failing);

        const withoutCondition = yield* service.upsert(
          conditionTask({ runCondition: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.isNull(withoutCondition.task.failingCheck);
        assert.isNull(yield* failingCheck);
        const withCondition = yield* service.upsert(
          conditionTask(),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.deepEqual(withCondition.task.failingCheck, failing);
        // The chat was held back for memory after the check passed; later memory skips ran no check.
        yield* record(6, FOUND_WORK, { skipReason: "memory" });
        for (let minute = 7; minute <= 16; minute += 1) {
          yield* record(minute, null, { skipReason: "memory" });
        }
        assert.isNull(yield* failingCheck);
        // Recording a run prunes old skips but keeps the newest checks, so the failures stay cleared.
        yield* service.runNow({ id: withCondition.task.id });
        assert.isNull(yield* failingCheck);
      }),
  ),
);

it.effect("a check that finds work starts no chat when memory went short while it ran", () =>
  Effect.gen(function* () {
    const short: MemoryShortage = {
      kind: "compressor",
      totalBytes: 24 * 1024 ** 3,
      compressorBytes: 873_905 * 16_384,
      compressorShareLimit: 0.35,
      pressure: "normal",
    };
    const shortage = yield* Ref.make<MemoryShortage | null>(null);
    yield* withRunConditions(
      () => Ref.set(shortage, short).pipe(Effect.as(FOUND_WORK)),
      ({ service, poll, launches, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            conditionTask(),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
          const moved = yield* whenTask((t) => t.nextRunAt !== task.nextRunAt);
          yield* poll;
          yield* moved;

          assert.equal(yield* Queue.size(launches), 0);
          const [run] = yield* runsOf(service);
          assert.deepInclude(run, {
            outcome: "skipped",
            skipReason: "memory",
            threadId: null,
            check: FOUND_WORK,
            memory: short,
          });
        }),
      undefined,
      Layer.mock(MemoryAdmission.MemoryAdmission)({ shortage: Ref.get(shortage) }),
    );
  }),
);

it.effect("a slow check holds up no other task, and the next poll starts no second check", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<ScheduledTaskRunCheck>();
    yield* withRunConditions(
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ({ service, poll, launches, checks, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            conditionTask(),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* service.upsert(
            conditionTask({ id: ScheduledTaskId.make("task:plain"), runCondition: null }),
            ScheduledTaskService.CHANGED_IN_APP,
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
        const { task } = yield* service.upsert(
          conditionTask(),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
    delegated: [{ driver: "codex", hours: 0 }],
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
  {
    name: "has been quiet for 4 hours on Codex",
    statuses: ["running"],
    continuationPending: false,
    quiet: { driver: "codex", hours: 4 },
    skips: true,
  },
  {
    name: "has been quiet for 5 hours on Codex, so it is stopped, and",
    statuses: ["running"],
    continuationPending: false,
    quiet: { driver: "codex", hours: 5 },
    skips: false,
    stopped: true,
  },
  {
    name: "has been quiet for 2 hours on Claude, so it is stopped, and",
    statuses: ["running"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 2 },
    skips: false,
    stopped: true,
  },
  {
    name: "holds only a queued message, quiet for 6 hours, so it is left as it is, and",
    statuses: ["interrupted", "queued"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 6 },
    skips: false,
  },
  {
    name: "waits on a delegated Codex task that worked 4 hours ago",
    statuses: ["waiting"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 6 },
    delegated: [{ driver: "codex", hours: 4 }],
    skips: true,
  },
  {
    name: "waits on a delegated Codex task quiet for 5 hours, so it is stopped, and",
    statuses: ["waiting"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 6 },
    delegated: [{ driver: "codex", hours: 5 }],
    skips: false,
    stopped: true,
  },
  {
    name: "waits on a delegated Claude task whose own Codex task worked 1 hour ago",
    statuses: ["waiting"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 6 },
    delegated: [
      { driver: "claudeAgent", hours: 6 },
      { driver: "codex", hours: 1 },
    ],
    skips: true,
  },
  {
    name: "waits on a delegated task on another machine",
    statuses: ["waiting"],
    continuationPending: false,
    quiet: { driver: "claudeAgent", hours: 6 },
    delegated: [{ driver: "codex", hours: 6, remote: true }],
    skips: true,
  },
] satisfies ReadonlyArray<
  ChatRuns & { readonly name: string; readonly skips: boolean; readonly stopped?: true }
>)(
  "the next occurrence of a task whose last chat $name is skipped: $skips",
  ({ skips, stopped = false, ...runs }) => {
    const logged: Array<unknown> = [];
    return withRunConditions(
      () => Effect.succeed(FOUND_WORK),
      ({ service, poll, launches, chatRuns, threadCommands, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            conditionTask({ runCondition: null }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
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
            const hours = Math.min(
              runs.quiet?.hours ?? Infinity,
              ...(runs.delegated ?? []).map((task) => task.hours),
            );
            const reason = `Stopped: nothing happened in this chat for ${hours} hours, so it no longer holds back the runs of this scheduled task.`;
            const stops = (yield* Ref.get(threadCommands)).flatMap((command) =>
              command.type === "thread.stop"
                ? [{ threadId: command.threadId, reason: command.reason }]
                : [],
            );
            assert.deepEqual(
              stops,
              stopped ? [{ threadId: ThreadId.make("thread:launched"), reason }] : [],
            );
            if (stopped) {
              const first = (yield* runsOf(service)).find(
                (run) => run.scheduledFor === task.nextRunAt,
              );
              assert.deepInclude(first, { outcome: "failed", error: reason });
              // Its count moves with it; the run launched after the stop succeeded.
              assert.deepEqual(
                (yield* service.recentRunCounts()).get(task.id)?.last7Days.outcomes,
                { failed: 1, succeeded: 1 },
              );
            }
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
          yield* service.upsert(
            conditionTask({ runCondition: null, maxLiveRuns: 2 }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
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
        yield* service.upsert(
          conditionTask({ runCondition: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.equal(yield* limitOf, 1);
        yield* service.upsert(
          conditionTask({ runCondition: null, maxLiveRuns: 3 }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.upsert(
          conditionTask({ runCondition: null, title: "Renamed" }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.equal(yield* limitOf, 3);
        yield* service.upsert(
          conditionTask({ runCondition: null, maxLiveRuns: 1 }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.equal(yield* limitOf, 1);
        assert.lengthOf(yield* stored, 0);

        yield* service.upsert(
          conditionTask({ runCondition: null, maxLiveRuns: 2 }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
        yield* service.upsert(
          conditionTask({ runCondition: { command: "node ~/check.mjs" } }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.deepEqual(yield* conditionOf(), { command: "node ~/check.mjs", timeoutSeconds: 60 });
        const { runCondition: _omitted, ...withoutCondition } = conditionTask();
        yield* service.upsert(
          { ...withoutCondition, title: "Renamed" },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.deepEqual(yield* conditionOf(), { command: "node ~/check.mjs", timeoutSeconds: 60 });
        yield* service.upsert(conditionTask(), ScheduledTaskService.CHANGED_IN_APP);
        assert.deepEqual(yield* conditionOf(), RUN_CONDITION);
        yield* service.upsert(
          conditionTask({ runCondition: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
          assert.equal(
            (yield* service.upsert(input, ScheduledTaskService.CHANGED_IN_APP).pipe(Effect.flip))
              .message,
            message,
          );
        }
        assert.isNull(yield* conditionOf());

        // Saved as a webhook task, it loses the stored condition.
        yield* service.upsert(conditionTask(), ScheduledTaskService.CHANGED_IN_APP);
        yield* service.upsert(
          { ...withoutCondition, schedule: webhook },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.isNull(yield* conditionOf());

        yield* service.upsert(conditionTask(), ScheduledTaskService.CHANGED_IN_APP);
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
          .upsert(
            conditionTask({ runtimeMode: "auto-accept-edits" }),
            ScheduledTaskService.CHANGED_IN_APP,
          )
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
  service.upsert(conditionTask({ runCondition: null }), ScheduledTaskService.CHANGED_IN_APP);
const pause = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.setEnabled(
    { id: ScheduledTaskId.make("task:checked"), enabled: false },
    ScheduledTaskService.CHANGED_IN_APP,
  );

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
            const { task } = yield* service.upsert(
              conditionTask(),
              ScheduledTaskService.CHANGED_IN_APP,
            );
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
              ScheduledTaskService.CHANGED_IN_APP,
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
        yield* service.upsert(
          conditionTask({ schedule: { type: "once", runAt } }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
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
          ScheduledTaskService.CHANGED_IN_APP,
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
  "no-work and usage-limited skips each keep their own history, so they never push real runs out, and daily counts keep every occurrence for 90 days, any task's, until the task is deleted, and count each window from its oldest day",
  () =>
    withRunConditions(
      () => Effect.succeed(NO_WORK),
      ({ service, sql, poll, whenTask }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            conditionTask(),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          yield* service.runNow({ id: task.id });
          const ranAt = Date.parse((yield* runsOf(service))[0]!.startedAt);
          const daysBefore = (time: number, days: number) =>
            DateTime.formatIso(DateTime.makeUnsafe(time - days * 24 * 60 * 60 * 1_000));
          const skipAt = (
            id: string,
            taskId: string,
            at: string,
            reason: "no_work" | "usage_limited",
          ) => sql`
            INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at,
              completed_at, outcome, skip_reason)
            VALUES (${id}, ${taskId}, 'scheduled', ${at}, ${at}, ${at}, 'skipped', ${reason})
          `;
          yield* skipAt("skip-20-days-ago", task.id, daysBefore(ranAt, 20), "no_work");
          // A task that no longer runs, so only another task's run can prune its counts.
          yield* skipAt("idle-91-days-ago", "task:idle", daysBefore(ranAt, 91), "no_work");
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

          const days = sql<{ readonly day: string }>`
            SELECT DISTINCT day FROM scheduled_task_daily_counts ORDER BY day
          `;
          assert.equal((yield* days)[0]?.day, daysBefore(ranAt, 20).slice(0, 10));
          // Each window's oldest day and the day before it, as of when the counts are read.
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          yield* skipAt("limited-6-days-ago", task.id, daysBefore(now, 6), "usage_limited");
          yield* skipAt("limited-7-days-ago", task.id, daysBefore(now, 7), "usage_limited");
          yield* skipAt("skip-29-days-ago", task.id, daysBefore(now, 29), "no_work");
          yield* skipAt("skip-30-days-ago", task.id, daysBefore(now, 30), "no_work");
          assert.deepEqual((yield* service.recentRunCounts()).get(task.id), {
            last7Days: {
              outcomes: { succeeded: 1, skipped: 122 },
              skipReasons: { no_work: 61, usage_limited: 61 },
            },
            last30Days: {
              outcomes: { succeeded: 1, skipped: 125 },
              skipReasons: { no_work: 63, usage_limited: 62 },
            },
          });
          yield* service.delete({ id: task.id });
          assert.lengthOf(yield* days, 0);
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
          MemoryAdmission.layerTest(),
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
        service.upsert(
          {
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
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
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

      const paused = yield* service.setGroupPaused(
        { ids, paused: true },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
      yield* service.setEnabled(
        { id: ids[3]!, enabled: true },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* service.setEnabled(
        { id: ids[3]!, enabled: false },
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* service.setEnabled(
        { id: ids[5]!, enabled: false },
        ScheduledTaskService.CHANGED_IN_APP,
      );

      yield* TestClock.adjust("2 hours");
      const resumed = yield* service.setGroupPaused(
        { ids, paused: false },
        ScheduledTaskService.CHANGED_IN_APP,
      );
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
      assert.deepEqual(
        yield* service.setGroupPaused({ ids, paused: false }, ScheduledTaskService.CHANGED_IN_APP),
        {
          ids: [],
          refused: [],
        },
      );

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

it.effect("a run that starts a chat puts it in the task's group folder", () =>
  withRunConditions(
    () => Effect.succeed(NO_WORK),
    ({ service, launches }) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(
          conditionTask({ group: "Autopilot" }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.runNow({ id: task.id });
        assert.equal((yield* Queue.take(launches)).folder, "Autopilot");
      }),
  ),
);

it.effect(
  "a task's group files its chats from before they were tracked and after their runs are pruned, and leaves the ones the user moved",
  () =>
    Effect.gen(function* () {
      const folders = new Map<string, string | undefined>([
        ["thread:legacy", undefined],
        ["thread:moved", "Elsewhere"],
        ["thread:raced", undefined],
      ]);
      const moves: Array<readonly [string, string | null, string | null | undefined]> = [];
      const workers = new Map<string, Effect.Effect<void>>();
      const makeLayer = () =>
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              ServerSettings.layerTest(),
              MemoryAdmission.layerTest(),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: (threadId) =>
                  Effect.succeed({ deletedAt: null, folder: folders.get(threadId) } as never),
                dispatch: (command) => {
                  if (command.type !== "thread.folder.set") return Effect.succeed({} as never);
                  // The user files this chat between the pass's read and its move.
                  if (command.threadId === "thread:raced") folders.set(command.threadId, "Mine");
                  moves.push([command.threadId, command.folder, command.from]);
                  if (
                    command.from !== undefined &&
                    !sameThreadFolder(folders.get(command.threadId), command.from)
                  ) {
                    return Effect.fail(
                      new Orchestrator.OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        stale: true,
                      }),
                    );
                  }
                  folders.set(command.threadId, command.folder ?? undefined);
                  return Effect.succeed({} as never);
                },
              }),
              layerSharedTaskDependencies(),
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
      const sql = yield* SqlClient.SqlClient;
      const { task } = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        return yield* service.upsert(
          conditionTask({ group: "Autopilot" }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
      }).pipe(Effect.provide(makeLayer()));
      // As before chats were tracked: only run history names them, and none is in the group yet.
      yield* sql`DROP TABLE scheduled_task_threads`;
      const at = "2026-11-10T12:00:00.000Z";
      for (const threadId of folders.keys()) {
        yield* sql`
          INSERT INTO scheduled_task_runs (run_id, task_id, trigger, scheduled_for, started_at,
            completed_at, outcome, thread_id)
          VALUES (${`run-${threadId}`}, ${task.id}, 'manual', ${at}, ${at}, ${at}, 'started',
            ${threadId})
        `;
      }
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* workers.get("scheduled-task-chat-folders") ?? Effect.die("not registered");
        const afterStartup = Object.fromEntries(folders);
        yield* sql`DELETE FROM scheduled_task_runs WHERE task_id = ${task.id}`;
        yield* service.setGroup(
          { id: task.id, group: "Machine care" },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        assert.deepEqual(
          { afterStartup, afterChange: Object.fromEntries(folders), moves },
          {
            afterStartup: {
              "thread:legacy": "Autopilot",
              "thread:moved": "Elsewhere",
              "thread:raced": "Mine",
            },
            afterChange: {
              "thread:legacy": "Machine care",
              "thread:moved": "Elsewhere",
              "thread:raced": "Mine",
            },
            moves: [
              ["thread:legacy", "Autopilot", null],
              ["thread:raced", "Autopilot", null],
              ["thread:legacy", "Machine care", "Autopilot"],
            ],
          },
        );
      }).pipe(Effect.provide(makeLayer()));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a group change during a launch moves the chat it starts", () =>
  Effect.gen(function* () {
    const folders = new Map<string, string | null | undefined>();
    const duringLaunch = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          MemoryAdmission.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.flatten(Ref.get(duringLaunch)).pipe(
                Effect.andThen(Effect.sync(() => folders.set("thread:new", input.folder))),
                Effect.as({ threadId: ThreadId.make("thread:new"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed({ deletedAt: null, folder: folders.get(threadId) } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "thread.folder.set") {
                  folders.set(command.threadId, command.folder);
                }
                return {} as never;
              }),
          }),
          layerSharedTaskDependencies([
            { id: "project:test", title: "Test", workspaceRoot: PROJECT_ROOT, canonicalKey: null },
          ]),
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
      const { task } = yield* service.upsert(
        conditionTask({ group: "Autopilot", runCondition: null }),
        ScheduledTaskService.CHANGED_IN_APP,
      );
      yield* Ref.set(
        duringLaunch,
        service
          .setGroup({ id: task.id, group: "Machine care" }, ScheduledTaskService.CHANGED_IN_APP)
          .pipe(Effect.asVoid, Effect.orDie),
      );
      yield* service.runNow({ id: task.id });
      assert.equal(folders.get("thread:new"), "Machine care");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run a restart cut links its chat only once settled, files it as its launch did, and its task keeps that outcome when the next startup is cut too or gets it from a later startup that can read the chat, and each run is counted once across both startups, an older build's pruned skip under its reason's new name",
  () =>
    Effect.gen(function* () {
      const cutAt = "2026-11-10T12:00:00.000Z";
      const skippedAt = "2026-11-10T11:00:00.000Z";
      const moves: Array<string> = [];
      const workers = new Map<string, Effect.Effect<void>>();
      const makeLayer = () =>
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              ServerSettings.layerTest(),
              MemoryAdmission.layerTest(),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                // Each chat holds its own run's prompt.
                getThreadRecords: (threadId, _fields, filter) => {
                  const prompt = MessageId.make(
                    `scheduled-task-message:${threadId.replace("thread:", "run:")}`,
                  );
                  return Effect.succeed({
                    messages:
                      (filter?.messageIds?.includes(prompt) ?? true) ? [{ id: prompt }] : [],
                  } as never);
                },
                // The user moved the chat out of the task's group before the restart.
                getThreadShell: () => Effect.succeed({ deletedAt: null, folder: "Mine" } as never),
                dispatch: (command) =>
                  Effect.sync(() => {
                    moves.push(command.type);
                    return {} as never;
                  }),
              }),
              layerSharedTaskDependencies(),
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
      const sql = yield* SqlClient.SqlClient;
      const cutChat = Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { runs } = yield* service.listRuns({ id: ScheduledTaskId.make("task:cut") });
        return runs.map((run) => run.threadId);
      });
      const whileRunning = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        for (const id of ["task:cut", "task:settled", "task:misread"]) {
          yield* service.upsert(
            conditionTask({ id: ScheduledTaskId.make(id), group: "Autopilot", runCondition: null }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
        }
        // A restart cut task:cut's run after its chat got its prompt. An earlier startup settled
        // task:settled's run record, and a restart cut it before it reached the task. An earlier
        // startup could not read task:misread's chat, so it settled only the task.
        yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = ${cutAt}`;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed', last_run_error = 'Run was interrupted by a server restart.',
              run_count = 1
          WHERE task_id = 'task:misread'
        `;
        yield* sql`
          INSERT INTO scheduled_task_runs
            (run_id, task_id, trigger, started_at, outcome, thread_id, chat_folder)
          VALUES
            ('run:cut', 'task:cut', 'scheduled', ${cutAt}, 'running', 'thread:cut', 'Autopilot'),
            ('run:settled', 'task:settled', 'scheduled', ${cutAt}, 'succeeded', 'thread:settled',
              'Autopilot'),
            ('run:misread', 'task:misread', 'scheduled', ${cutAt}, 'running', 'thread:misread',
              'Autopilot')
        `;
        // Marking each task running named its run.
        yield* sql`
          UPDATE scheduled_tasks SET last_run_id = (
            SELECT run_id FROM scheduled_task_runs WHERE task_id = scheduled_tasks.task_id
          )
        `;
        // An older build recorded two skips under the reason's old name and pruned one.
        yield* sql`
          INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, skip_reason)
          VALUES
            ('run:old-skip', 'task:settled', 'scheduled', ${skippedAt}, 'skipped', 'last_run_working'),
            ('run:pruned-skip', 'task:settled', 'scheduled', ${skippedAt}, 'skipped',
              'last_run_working')
        `;
        yield* sql`DELETE FROM scheduled_task_runs WHERE run_id = 'run:pruned-skip'`;
        return yield* cutChat;
      }).pipe(Effect.provide(makeLayer()));
      const afterRestart = yield* Effect.gen(function* () {
        yield* workers.get("scheduled-task-chat-folders") ?? Effect.die("not registered");
        return {
          linked: yield* cutChat,
          tasks: yield* sql`
            SELECT task_id, last_run_status, last_run_error, run_count
            FROM scheduled_tasks ORDER BY task_id
          `,
          sidebar: yield* sql`
            SELECT task_id, last_run_thread_id FROM scheduled_task_sidebar ORDER BY task_id
          `,
          chats: yield* sql`
            SELECT task_id, thread_id, filed_folder, detached FROM scheduled_task_threads
            ORDER BY task_id
          `,
          counts: yield* sql`
            SELECT task_id, day, outcome, skip_reason, count FROM scheduled_task_daily_counts
            ORDER BY task_id, outcome
          `,
        };
      }).pipe(Effect.provide(makeLayer()));
      const settled = { last_run_status: "succeeded", last_run_error: null, run_count: 1 };
      const counted = { day: "2026-11-10", outcome: "succeeded", skip_reason: "", count: 1 };
      assert.deepEqual(
        { whileRunning, ...afterRestart, moves },
        {
          whileRunning: [null],
          linked: ["thread:cut"],
          tasks: [
            { task_id: "task:cut", ...settled },
            { task_id: "task:misread", ...settled },
            { task_id: "task:settled", ...settled },
          ],
          sidebar: [
            { task_id: "task:cut", last_run_thread_id: "thread:cut" },
            { task_id: "task:misread", last_run_thread_id: "thread:misread" },
            { task_id: "task:settled", last_run_thread_id: null },
          ],
          chats: [
            {
              task_id: "task:cut",
              thread_id: "thread:cut",
              filed_folder: "Autopilot",
              detached: 0,
            },
            {
              task_id: "task:misread",
              thread_id: "thread:misread",
              filed_folder: "Autopilot",
              detached: 0,
            },
          ],
          counts: [
            { task_id: "task:cut", ...counted },
            { task_id: "task:misread", ...counted },
            {
              ...counted,
              task_id: "task:settled",
              outcome: "skipped",
              skip_reason: "live_run_limit",
              count: 2,
            },
            { task_id: "task:settled", ...counted },
          ],
          moves: [],
        },
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a run outlives the request that started it, and one that shutdown cuts keeps its chat after the restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const launched = yield* Deferred.make<ThreadId | undefined>();
      const prompts = yield* Ref.make<ReadonlyArray<MessageId>>([]);
      const makeLayer = () =>
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              ServerSettings.layerTest(),
              MemoryAdmission.layerTest(),
              // The prompt landed, and the launch is still finishing when the server stops.
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) =>
                  Ref.update(prompts, (ids) =>
                    input.initialMessage?.messageId == null
                      ? ids
                      : [...ids, input.initialMessage.messageId],
                  ).pipe(
                    Effect.andThen(Deferred.succeed(launched, input.threadId)),
                    Effect.andThen(Effect.never),
                  ),
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadRecords: (_threadId, _fields, filter) =>
                  Ref.get(prompts).pipe(
                    Effect.map(
                      (ids) =>
                        ({
                          messages: ids
                            .filter((id) => filter?.messageIds?.includes(id) ?? true)
                            .map((id) => ({ id })),
                        }) as never,
                    ),
                  ),
                getThreadShell: () =>
                  Effect.succeed({ deletedAt: null, folder: "Autopilot" } as never),
              }),
              layerSharedTaskDependencies([
                {
                  id: "project:test",
                  title: "Test",
                  workspaceRoot: PROJECT_ROOT,
                  canonicalKey: null,
                },
              ]),
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
      const stored = sql`
        SELECT r.outcome, r.thread_id, t.last_run_status
        FROM scheduled_task_runs r JOIN scheduled_tasks t USING (task_id)
      `;
      const beforeShutdown = yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task } = yield* service.upsert(
          conditionTask({ group: "Autopilot", runCondition: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const request = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
        const threadId = yield* Deferred.await(launched);
        // A client that disconnects drops its request.
        yield* Fiber.interrupt(request);
        return { threadId, rows: yield* stored };
      }).pipe(Effect.provide(makeLayer()));
      // Leaving the layer stopped the server mid-launch; providing it again starts it.
      const afterRestart = yield* stored.pipe(Effect.provide(makeLayer()));
      const { threadId } = beforeShutdown;
      assert.deepEqual(
        { beforeShutdown: beforeShutdown.rows, afterRestart },
        {
          beforeShutdown: [{ outcome: "running", thread_id: threadId, last_run_status: "running" }],
          afterRestart: [
            { outcome: "succeeded", thread_id: threadId, last_run_status: "succeeded" },
          ],
        },
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a startup that cannot delete a cut run's unprompted chat moves its task on but leaves the run running, and a later startup deletes the chat and settles the run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cutAt = "2026-11-10T12:00:00.000Z";
      const deleted = yield* Ref.make(false);
      const tried = yield* Ref.make<ReadonlyArray<string>>([]);
      const makeLayer = () =>
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ManagedPolicy.layerTest(),
              ServerSettings.layerTest(),
              MemoryAdmission.layerTest(),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () =>
                  Ref.get(deleted).pipe(
                    Effect.map(
                      (gone) => ({ deletedAt: gone ? cutAt : null, folder: "Autopilot" }) as never,
                    ),
                  ),
                getThreadRecords: () => Effect.succeed({ messages: [] } as never),
                getMessageCount: () => Effect.succeed(0),
                // As the orchestrator's receipts do: the first delete is rejected, and a rejected
                // command id is refused for good.
                dispatch: (command) =>
                  Effect.gen(function* () {
                    const earlier = yield* Ref.getAndUpdate(tried, (ids) => [
                      ...ids,
                      command.commandId,
                    ]);
                    if (earlier.length === 0 || earlier.includes(command.commandId)) {
                      return yield* Effect.die(new Error("test delete rejected"));
                    }
                    yield* Ref.set(deleted, true);
                    return {} as never;
                  }),
              }),
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
      const stored = sql`
        SELECT r.outcome, r.thread_id, t.last_run_status
        FROM scheduled_task_runs r JOIN scheduled_tasks t USING (task_id)
      `;
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        yield* service.upsert(
          conditionTask({
            id: ScheduledTaskId.make("task:empty"),
            group: "Autopilot",
            runCondition: null,
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        // A restart cut the run after its chat was made, before the prompt reached it.
        yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = ${cutAt}, last_run_id = 'run:empty'`;
        yield* sql`
          INSERT INTO scheduled_task_runs
            (run_id, task_id, trigger, started_at, outcome, thread_id, chat_folder)
          VALUES
            ('run:empty', 'task:empty', 'scheduled', ${cutAt}, 'running', 'thread:empty', 'Autopilot')
        `;
      }).pipe(Effect.provide(makeLayer()));
      const afterRejection = yield* stored.pipe(Effect.provide(makeLayer()));
      const afterRetry = yield* stored.pipe(Effect.provide(makeLayer()));
      assert.deepEqual(
        { afterRejection, afterRetry, deleted: yield* Ref.get(deleted) },
        {
          afterRejection: [
            { outcome: "running", thread_id: "thread:empty", last_run_status: "failed" },
          ],
          afterRetry: [{ outcome: "failed", thread_id: null, last_run_status: "failed" }],
          deleted: true,
        },
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an agent's report decides its occurrence, once, and only for its own chat", () =>
  Effect.gen(function* () {
    const project = ProjectId.make("project:reported");
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          ServerSettings.layerTest(),
          MemoryAdmission.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            sendToThread: () => Effect.succeed({} as never),
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
      const make = (id: string, threadId: string) =>
        service.upsert(
          {
            id: ScheduledTaskId.make(id),
            title: id,
            prompt: "Check",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
            projectId: project,
            threadId: ThreadId.make(threadId),
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          ScheduledTaskService.CHANGED_IN_APP,
        );
      const blocked = yield* make("task:blocked", "thread:blocked");
      const noop = yield* make("task:noop", "thread:noop");
      yield* service.runNow({ id: blocked.task.id });
      yield* service.runNow({ id: noop.task.id });

      yield* service.reportRunResult({
        threadId: ThreadId.make("thread:blocked"),
        outcome: "incomplete",
        summary: "Chrome failed before sign-in; 0 of 14 courses checked",
      });
      yield* service.reportRunResult({
        threadId: ThreadId.make("thread:noop"),
        outcome: "completed",
        summary: "Nothing new in any course",
      });
      const later = yield* Effect.flip(
        service.reportRunResult({
          threadId: ThreadId.make("thread:blocked"),
          outcome: "completed",
          summary: "A later turn says all is well",
        }),
      );
      const stranger = yield* Effect.flip(
        service.reportRunResult({
          threadId: ThreadId.make("thread:unrelated"),
          outcome: "incomplete",
          summary: "Not a scheduled chat",
        }),
      );

      const { tasks } = yield* service.list({ resolveModels: false });
      const statusOf = (id: string) => tasks.find((task) => task.id === id)?.lastRunStatus;
      const runOf = (id: string) =>
        service.listRuns({ id: ScheduledTaskId.make(id) }).pipe(Effect.map(({ runs }) => runs[0]));
      const blockedRun = yield* runOf("task:blocked");
      assert.deepEqual(
        {
          blocked: statusOf("task:blocked"),
          noop: statusOf("task:noop"),
          blockedRun: [blockedRun?.outcome, blockedRun?.error],
          noopRun: (yield* runOf("task:noop"))?.outcome,
          later: later.message,
          stranger: stranger.message,
        },
        {
          blocked: "failed",
          noop: "succeeded",
          blockedRun: ["failed", "Chrome failed before sign-in; 0 of 14 courses checked"],
          noopRun: "succeeded",
          later: "This run already reported its result.",
          stranger: "This chat is not a scheduled task run.",
        },
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
