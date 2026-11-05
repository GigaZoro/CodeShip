import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ScheduledTaskApplySharedInput,
  type ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as SharedTaskPeerCheck from "./SharedTaskPeerCheck.ts";
import {
  HERE_ENVIRONMENT_ID,
  layerSharedTaskDependencies,
  type TestSharedProject,
} from "./sharedTaskTestLayers.ts";

const SCRATCH = ProjectId.make("project-scratch");
const repoProject: TestSharedProject = {
  id: "project-repo",
  title: "Repo",
  workspaceRoot: "/work/repo",
  canonicalKey: "github.com/acme/repo",
};
const plainProject: TestSharedProject = {
  id: "project-plain",
  title: "Plain",
  workspaceRoot: "/work/plain",
  canonicalKey: null,
};
const NOW = Date.parse("2026-09-09T12:00:00.000Z");
const OTHER = "environment-other";

const decodeUpsert = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const decodeApply = Schema.decodeUnknownSync(ScheduledTaskApplySharedInput);

const upsertInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsert({
    id: "scheduled-task:shared",
    title: "Review",
    prompt: "Review the open pull requests.",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: String(SCRATCH),
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    shared: { excludedEnvironmentIds: [] },
    ...overrides,
  });

const copy = (at: string, overrides: Record<string, unknown> = {}, excluded: string[] = []) =>
  decodeApply({
    type: "upsert",
    task: {
      id: "scheduled-task:shared",
      title: "From elsewhere",
      prompt: "Review the open pull requests.",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      followsDefaultModel: false,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-09-01T00:00:00.000Z",
      shared: {
        revision: { at, environmentId: OTHER },
        project: { type: "none" },
        excludedEnvironmentIds: excluded,
      },
      ...overrides,
    },
  });

const deletion = (at: string) =>
  decodeApply({
    type: "delete",
    deletion: { id: "scheduled-task:shared", revision: { at, environmentId: OTHER } },
  });

const withService = <A, E>(
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E>,
  projects: ReadonlyArray<TestSharedProject> = [repoProject, plainProject],
  extras: {
    readonly peerCheck?: Layer.Layer<SharedTaskPeerCheck.SharedTaskPeerCheck>;
    readonly launch?: ThreadLaunchService.ThreadLaunchService["Service"]["launch"];
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sql = yield* SqlClient.SqlClient;
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          ServerSettings.layerTest(extras.settings),
          ManagedPolicy.layerTest(),
          layerSharedTaskDependencies(projects, extras.peerCheck),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)(
            extras.launch === undefined ? {} : { launch: extras.launch },
          ),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH),
            ensureScratchProject: Effect.succeed({ projectId: SCRATCH }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService, sql);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const taskOf = (
  service: ScheduledTaskService.ScheduledTaskService["Service"],
  id = "scheduled-task:shared",
) =>
  service
    .list()
    .pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === (id as ScheduledTaskId))));

it.effect(
  "sharing stamps a revision and the project: none for scratch, the repository otherwise",
  () =>
    withService((service) =>
      Effect.gen(function* () {
        const scratch = (yield* service.upsert(upsertInput())).task;
        expect(scratch.shared).toEqual({
          revision: { at: "2026-09-09T12:00:00.000Z", environmentId: HERE_ENVIRONMENT_ID },
          project: { type: "none" },
          excludedEnvironmentIds: [],
        });
        const repo = (yield* service.upsert(
          upsertInput({ id: "scheduled-task:repo", projectId: repoProject.id }),
        )).task;
        expect(repo.shared?.project).toEqual({
          type: "repository",
          canonicalKey: "github.com/acme/repo",
          title: "Repo",
        });
        const noRemote = yield* service
          .upsert(upsertInput({ id: "scheduled-task:plain", projectId: plainProject.id }))
          .pipe(Effect.flip);
        expect(noRemote.message).toBe(
          "To share a task, pick No project or a project with a git remote, so each machine can find its copy.",
        );
      }),
    ),
);

it.effect("a shared task cannot post to a thread or use a webhook", () =>
  withService((service) =>
    Effect.gen(function* () {
      const bound = yield* service.upsert(upsertInput({ threadId: "thread-1" })).pipe(Effect.flip);
      expect(bound.message).toBe(
        "A shared task starts a new thread on each machine, so it can't post to one thread.",
      );
      const webhook = yield* service
        .upsert(
          upsertInput({
            schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
          }),
        )
        .pipe(Effect.flip);
      expect(webhook.message).toBe(
        "A shared task can't use a webhook: each machine has its own webhook address.",
      );
    }),
  ),
);

it.effect(
  "every edit of a shared task bumps its revision past the old one, even with a slow clock",
  () =>
    withService((service, sql) =>
      Effect.gen(function* () {
        yield* service.upsert(upsertInput());
        yield* sql`UPDATE scheduled_task_shared SET revision_at = '2030-01-01T00:00:00.000Z'`;
        const saved = (yield* service.upsert(upsertInput({ title: "Edited" }))).task;
        expect(saved.shared?.revision.at).toBe("2030-01-01T00:00:00.001Z");

        yield* sql`UPDATE scheduled_task_shared SET revision_at = '2031-01-01T00:00:00.000Z'`;
        yield* service.setEnabled({ id: saved.id, enabled: false });
        expect((yield* taskOf(service))?.shared?.revision.at).toBe("2031-01-01T00:00:00.001Z");

        yield* service.setFollowsDefaultModel({ ids: [saved.id], followsDefaultModel: true });
        expect((yield* taskOf(service))?.shared?.revision.at).toBe("2031-01-01T00:00:00.002Z");

        yield* service.setPinned({ id: saved.id, pinned: true });
        expect((yield* taskOf(service))?.shared?.revision.at).toBe("2031-01-01T00:00:00.002Z");
      }),
    ),
);

it.effect(
  "deleting a shared task leaves a deletion; unsharing keeps the task and leaves one too",
  () =>
    withService((service) =>
      Effect.gen(function* () {
        const id = (yield* service.upsert(upsertInput())).task.id;
        yield* service.delete({ id });
        const afterDelete = yield* service.list();
        expect(afterDelete.tasks).toEqual([]);
        expect(afterDelete.sharedDeletions).toEqual([
          {
            id,
            revision: { at: "2026-09-09T12:00:00.001Z", environmentId: HERE_ENVIRONMENT_ID },
          },
        ]);

        // Sharing again takes the deletion back, and the new revision beats it.
        const reshared = (yield* service.upsert(upsertInput())).task;
        expect(reshared.shared?.revision.at).toBe("2026-09-09T12:00:00.002Z");
        expect((yield* service.list()).sharedDeletions).toEqual([]);

        const unshared = (yield* service.upsert(upsertInput({ shared: null }))).task;
        expect(unshared.shared).toBeNull();
        expect((yield* service.list()).sharedDeletions?.map((entry) => entry.id)).toEqual([id]);
      }),
    ),
);

it.effect(
  "applying a newer copy saves it, keeps this machine's run state, and stores its revision",
  () =>
    withService((service, sql) =>
      Effect.gen(function* () {
        const id = (yield* service.upsert(upsertInput())).task.id;
        yield* sql`UPDATE scheduled_tasks SET run_count = 5, last_run_status = 'succeeded'`;
        const at = "2026-09-10T00:00:00.000Z";
        expect(yield* service.applyShared(copy(at))).toEqual({ outcome: "applied" });
        const task = yield* taskOf(service);
        expect(task?.title).toBe("From elsewhere");
        expect(task?.runCount).toBe(5);
        expect(task?.lastRunStatus).toBe("succeeded");
        expect(task?.shared?.revision).toEqual({ at, environmentId: OTHER });
        expect(task?.id).toBe(id);
      }),
    ),
);

it.effect("applying an older or equal revision changes nothing", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput());
      expect(yield* service.applyShared(copy("2026-09-09T11:59:59.999Z"))).toEqual({
        outcome: "stale",
      });
      expect(yield* service.applyShared(deletion("2026-09-09T11:00:00.000Z"))).toEqual({
        outcome: "stale",
      });
      expect((yield* taskOf(service))?.title).toBe("Review");
      const at = "2026-09-10T00:00:00.000Z";
      expect(yield* service.applyShared(copy(at))).toEqual({ outcome: "applied" });
      expect(yield* service.applyShared(copy(at, { title: "Same revision" }))).toEqual({
        outcome: "stale",
      });
      expect((yield* taskOf(service))?.title).toBe("From elsewhere");
    }),
  ),
);

it.effect("a machine in the exclusion list drops its copy without leaving a deletion", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput());
      const result = yield* service.applyShared(
        copy("2026-09-10T00:00:00.000Z", {}, [HERE_ENVIRONMENT_ID]),
      );
      expect(result).toEqual({ outcome: "removed" });
      const listed = yield* service.list();
      expect(listed.tasks).toEqual([]);
      expect(listed.sharedDeletions).toEqual([]);
      expect(
        yield* service.applyShared(copy("2026-09-11T00:00:00.000Z", {}, [HERE_ENVIRONMENT_ID])),
      ).toEqual({ outcome: "removed" });
    }),
  ),
);

it.effect("a deletion removes the copy and blocks an older copy from coming back", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput());
      expect(yield* service.applyShared(deletion("2026-09-10T00:00:00.000Z"))).toEqual({
        outcome: "applied",
      });
      expect((yield* service.list()).tasks).toEqual([]);
      expect(yield* service.applyShared(copy("2026-09-09T00:00:00.000Z"))).toEqual({
        outcome: "stale",
      });
      expect(yield* service.applyShared(copy("2026-09-11T00:00:00.000Z"))).toEqual({
        outcome: "applied",
      });
      expect((yield* service.list()).sharedDeletions).toEqual([]);
    }),
  ),
);

it.effect("a task here that is not shared keeps its id", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput({ shared: null }));
      expect(yield* service.applyShared(copy("2026-09-10T00:00:00.000Z"))).toEqual({
        outcome: "local",
      });
      expect(yield* service.applyShared(deletion("2026-09-10T00:00:00.000Z"))).toEqual({
        outcome: "local",
      });
      expect((yield* taskOf(service))?.title).toBe("Review");
    }),
  ),
);

it.effect("a copy for a repository finds the project here, or fails naming the repository", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const project = {
          type: "repository",
          canonicalKey: "github.com/acme/repo",
          title: "Repo",
        };
        const at = "2026-09-10T00:00:00.000Z";
        const missing = yield* service
          .applyShared(copy(at, { shared: sharedWith(at, project) }))
          .pipe(Effect.flip);
        expect(missing.message).toBe(
          "No project on this machine has the repository Repo (github.com/acme/repo). Add it here, or leave this machine out of the task.",
        );
        expect((yield* service.list()).tasks).toEqual([]);
      }),
    [plainProject],
  ),
);

it.effect("a copy for a repository lands in the matching project", () =>
  withService((service) =>
    Effect.gen(function* () {
      const at = "2026-09-10T00:00:00.000Z";
      const project = { type: "repository", canonicalKey: "github.com/acme/repo", title: "Repo" };
      yield* service.applyShared(copy(at, { shared: sharedWith(at, project) }));
      expect((yield* taskOf(service))?.projectId).toBe(repoProject.id);
    }),
  ),
);

const sharedWith = (at: string, project: Record<string, unknown>) => ({
  revision: { at, environmentId: OTHER },
  project,
  excludedEnvironmentIds: [],
});

const order = (at: string, ids: string[]) =>
  decodeApply({
    type: "projectMachineOrder",
    order: {
      project: { type: "none" },
      order: ids,
      revision: { at, environmentId: OTHER },
    },
  });

it.effect("a project's machine order keeps the newest revision", () =>
  withService((service) =>
    Effect.gen(function* () {
      const at = "2026-09-10T00:00:00.000Z";
      expect(yield* service.applyShared(order(at, [OTHER]))).toEqual({ outcome: "applied" });
      expect(yield* service.applyShared(order("2026-09-09T00:00:00.000Z", []))).toEqual({
        outcome: "stale",
      });
      expect(yield* service.applyShared(order(at, []))).toEqual({ outcome: "stale" });
      expect(
        yield* service.applyShared(order("2026-09-11T00:00:00.000Z", [HERE_ENVIRONMENT_ID])),
      ).toEqual({ outcome: "applied" });
      const stored = (yield* service.list()).projectMachineOrders;
      expect(stored?.map((entry) => entry.order)).toEqual([[HERE_ENVIRONMENT_ID]]);
    }),
  ),
);

it.effect("saving with a machine order stamps the project's order and keeps run-on", () =>
  withService((service) =>
    Effect.gen(function* () {
      const shared = { excludedEnvironmentIds: [], runOn: "one", machineOrder: [OTHER] };
      const first = (yield* service.upsert(upsertInput({ shared }))).task;
      expect(first.shared?.runOn).toBe("one");
      const orders = (yield* service.list()).projectMachineOrders;
      expect(orders).toEqual([
        {
          project: { type: "none" },
          order: [OTHER],
          revision: { at: "2026-09-09T12:00:00.000Z", environmentId: HERE_ENVIRONMENT_ID },
        },
      ]);
      yield* service.upsert(
        upsertInput({ shared: { excludedEnvironmentIds: [], machineOrder: [] } }),
      );
      const second = (yield* service.list()).projectMachineOrders?.[0];
      expect(second?.revision.at).toBe("2026-09-09T12:00:00.001Z");
      expect((yield* taskOf(service))?.shared?.runOn).toBe("one");
    }),
  ),
);

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const oneMachineShared = (machineOrder: string[]) => ({
  excludedEnvironmentIds: [],
  runOn: "one",
  machineOrder,
});

// The task is due one hour after NOW. Each tick fires at `atMs`, and `settled` waits for the
// change the tick published, so nothing polls.
const runScenario = <A, E>(
  machineOrder: string[],
  peers: SharedTaskPeerCheck.PeerCheckResult,
  body: (scenario: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly launches: Queue.Queue<unknown>;
    readonly peerCalls: Ref.Ref<ReadonlyArray<{ peers: ReadonlyArray<string>; since: string }>>;
    readonly tick: (atMs: number) => Effect.Effect<void>;
    readonly settled: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<unknown>();
    const peerCalls = yield* Ref.make<
      ReadonlyArray<{ peers: ReadonlyArray<string>; since: string }>
    >([]);
    const peerCheck = Layer.mock(SharedTaskPeerCheck.SharedTaskPeerCheck)({
      linkedEnvironmentIds: Effect.succeed([]),
      linkStatus: Effect.succeed({ enabled: false, links: [] }),
      check: (input) =>
        Ref.update(peerCalls, (calls) => [
          ...calls,
          { peers: input.peers, since: input.since },
        ]).pipe(Effect.as(peers)),
    });
    return yield* withService(
      (service, sql) =>
        Effect.gen(function* () {
          yield* service.upsert(
            upsertInput({
              shared: oneMachineShared(machineOrder),
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
          );
          const changes = yield* Queue.unbounded<void>();
          yield* Effect.forkScoped(
            service.subscribeList().pipe(
              Stream.drop(1),
              Stream.runForEach(() => Queue.offer(changes, undefined)),
            ),
          );
          return yield* body({
            service,
            sql,
            launches,
            peerCalls,
            tick: (atMs) =>
              TestClock.setTime(atMs).pipe(Effect.andThen(TestClock.adjust("6 seconds"))),
            settled: Queue.take(changes),
          });
        }).pipe(Effect.scoped),
      [repoProject, plainProject],
      {
        peerCheck,
        launch: (input) =>
          Queue.offer(launches, input).pipe(Effect.as({ threadId: "thread-1" } as never)),
      },
    );
  });

const DUE = NOW + HOUR_MS;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const nextRunAtOf = (sql: SqlClient.SqlClient) =>
  sql<{ next_run_at: string | null }>`SELECT next_run_at FROM scheduled_tasks`.pipe(
    Effect.map((rows) => rows[0]?.next_run_at),
  );

it.effect("a later machine waits its turn, then skips an occurrence an earlier machine has", () =>
  runScenario([OTHER, HERE_ENVIRONMENT_ID], { ranOn: OTHER as never, unchecked: [] }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.tick(DUE + 1_000);
      yield* scenario.settled;
      // Rank 1 waits one grace (5 minutes) and asks no one yet.
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + 5 * MINUTE_MS));
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([]);

      yield* scenario.tick(DUE + 5 * MINUTE_MS + 1_000);
      yield* scenario.settled;
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([
        { peers: [OTHER], since: iso(DUE - 30 * MINUTE_MS) },
      ]);
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
      expect(yield* Queue.size(scenario.launches)).toBe(0);
      const decision = (yield* taskOf(scenario.service))?.lastOneMachineDecision;
      expect(decision?.ranOn).toBe(OTHER);
    }),
  ),
);

it.effect(
  "a later machine runs the occurrence when no earlier machine has it, noting who it could not ask",
  () =>
    runScenario(
      [OTHER, HERE_ENVIRONMENT_ID],
      {
        ranOn: null,
        unchecked: [{ environmentId: OTHER as never, reason: "This machine is not linked." }],
      },
      (scenario) =>
        Effect.gen(function* () {
          yield* scenario.tick(DUE + 1_000);
          yield* scenario.settled;
          yield* scenario.tick(DUE + 5 * MINUTE_MS + 1_000);
          yield* Queue.take(scenario.launches);
          const decision = (yield* taskOf(scenario.service))?.lastOneMachineDecision;
          expect(decision?.ranOn).toBeNull();
          expect(decision?.unchecked).toEqual([
            { environmentId: OTHER, reason: "This machine is not linked." },
          ]);
        }),
    ),
);

it.effect("the first machine in the order runs on time without asking anyone", () =>
  runScenario([HERE_ENVIRONMENT_ID, OTHER], { ranOn: OTHER as never, unchecked: [] }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.tick(DUE + 1_000);
      yield* Queue.take(scenario.launches);
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([]);
    }),
  ),
);

it.effect("the first machine asks first when it is late", () =>
  runScenario([HERE_ENVIRONMENT_ID, OTHER], { ranOn: OTHER as never, unchecked: [] }, (scenario) =>
    Effect.gen(function* () {
      // The scheduler ticks every 5 seconds, so lateness needs a due time already in the past.
      const lateDue = iso(NOW - 2 * MINUTE_MS);
      yield* scenario.sql`UPDATE scheduled_tasks SET next_run_at = ${lateDue}`;
      yield* scenario.service.setPinned({
        id: "scheduled-task:shared" as ScheduledTaskId,
        pinned: true,
      });
      yield* scenario.tick(NOW);
      yield* scenario.settled;
      expect(yield* Ref.get(scenario.peerCalls)).toHaveLength(1);
      expect(yield* Queue.size(scenario.launches)).toBe(0);
      // The skip lands on the next slot counted from creation, not one interval after the due time.
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(NOW + HOUR_MS));
    }),
  ),
);

const copyOf = (id: string, overrides: Record<string, unknown> = {}) => {
  const base = copy("2026-09-10T00:00:00.000Z", {
    id,
    createdAt: "2026-09-09T12:00:00.000Z",
    schedule: { type: "interval", everyMs: HOUR_MS },
    shared: {
      revision: { at: "2026-09-10T00:00:00.000Z", environmentId: OTHER },
      project: { type: "none" },
      excludedEnvironmentIds: [],
      runOn: "one",
    },
    ...overrides,
  });
  return base;
};

it.effect("copies of a one-machine interval task run the same slots whenever they last ran", () =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<unknown>();
    yield* withService(
      (service, sql) =>
        Effect.gen(function* () {
          const local = (yield* service.upsert(
            upsertInput({
              id: "scheduled-task:local",
              shared: oneMachineShared([]),
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
          )).task;
          yield* service.applyShared(copyOf("scheduled-task:copy"));
          yield* service.upsert(
            upsertInput({
              id: "scheduled-task:plain",
              shared: null,
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
          );
          yield* TestClock.setTime(NOW + 10 * MINUTE_MS);
          yield* service.runNow({ id: local.id });
          yield* TestClock.setTime(NOW + 25 * MINUTE_MS);
          yield* service.runNow({ id: "scheduled-task:copy" as ScheduledTaskId });
          yield* service.runNow({ id: "scheduled-task:plain" as ScheduledTaskId });
          const next = yield* sql<{ task_id: string; next_run_at: string }>`
            SELECT task_id, next_run_at FROM scheduled_tasks ORDER BY task_id`;
          expect(next.map((row) => [row.task_id, row.next_run_at])).toEqual([
            ["scheduled-task:copy", iso(NOW + HOUR_MS)],
            ["scheduled-task:local", iso(NOW + HOUR_MS)],
            ["scheduled-task:plain", iso(NOW + 25 * MINUTE_MS + HOUR_MS)],
          ]);
        }),
      [repoProject, plainProject],
      {
        launch: (input) =>
          Queue.offer(launches, input).pipe(Effect.as({ threadId: "thread-1" } as never)),
      },
    );
  }),
);

it.effect(
  "a shared task whose model is not set up here runs the default model and keeps its own",
  () =>
    Effect.gen(function* () {
      const launches = yield* Queue.unbounded<{ modelSelection: unknown }>();
      yield* withService(
        (service) =>
          Effect.gen(function* () {
            const own = { instanceId: "codex_elsewhere", model: "gpt-5.4" };
            const id = (yield* service.upsert(upsertInput({ modelSelection: own }))).task.id;
            const listed = yield* taskOf(service);
            expect(listed?.modelUnavailableHere).toBe(true);
            expect(listed?.modelSelection).toEqual(own);
            yield* service.runNow({ id });
            const launched = yield* Queue.take(launches);
            expect(launched.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.5" });
            expect((yield* taskOf(service))?.modelSelection).toEqual(own);

            const here = yield* service.upsert(
              upsertInput({
                id: "scheduled-task:here",
                modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              }),
            );
            expect(here.task.modelUnavailableHere).toBeUndefined();
          }),
        [repoProject, plainProject],
        {
          settings: { scheduledTaskModelSelection: { instanceId: "codex", model: "gpt-5.5" } },
          launch: (input) =>
            Queue.offer(launches, input).pipe(Effect.as({ threadId: "thread-1" } as never)),
        },
      );
    }),
);

it.effect("the list reports the links stored here", () =>
  withService(
    (service) =>
      service.list().pipe(
        Effect.map((listed) =>
          expect(listed.peerLinks).toEqual({
            enabled: true,
            links: [{ environmentId: OTHER, expiresAt: "2027-01-01T00:00:00.000Z" }],
          }),
        ),
      ),
    [repoProject, plainProject],
    {
      peerCheck: Layer.mock(SharedTaskPeerCheck.SharedTaskPeerCheck)({
        linkedEnvironmentIds: Effect.succeed([]),
        linkStatus: Effect.succeed({
          enabled: true,
          links: [{ environmentId: OTHER as never, expiresAt: "2027-01-01T00:00:00.000Z" }],
        }),
      }),
    },
  ),
);

it.effect("a linked machine gets this machine's stored copies, minus those that leave it out", () =>
  withService(
    (service) =>
      Effect.gen(function* () {
        const own = { instanceId: "codex", model: "gpt-5.4" };
        yield* service.upsert(
          upsertInput({
            id: "scheduled-task:kept",
            modelSelection: own,
            followsDefaultModel: true,
            shared: { excludedEnvironmentIds: [], machineOrder: [OTHER] },
          }),
        );
        yield* service.upsert(
          upsertInput({
            id: "scheduled-task:work-private",
            projectId: repoProject.id,
            shared: { excludedEnvironmentIds: [OTHER], machineOrder: [HERE_ENVIRONMENT_ID] },
          }),
        );
        yield* service.upsert(upsertInput({ id: "scheduled-task:local-only", shared: null }));
        yield* service.upsert(upsertInput({ id: "scheduled-task:gone" }));
        yield* service.delete({ id: "scheduled-task:gone" as ScheduledTaskId });

        const pulled = yield* service.sharedCopies(OTHER as never);
        expect(pulled.tasks.map((task) => task.id)).toEqual(["scheduled-task:kept"]);
        // The copy's own model, not the scheduled tasks default shown here.
        expect(pulled.tasks[0]?.modelSelection).toEqual(own);
        expect(pulled.deletions.map((deletion) => deletion.id)).toEqual(["scheduled-task:gone"]);
        expect(pulled.projectMachineOrders.map((order) => order.project.type)).toEqual(["none"]);
      }),
    [repoProject, plainProject],
    { settings: { scheduledTaskModelSelection: { instanceId: "codex", model: "gpt-5.5" } } },
  ),
);
