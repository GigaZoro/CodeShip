import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskApplySharedInput,
  type ScheduledTaskId,
  type ScheduledTaskRunCheck,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
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
    readonly runConditionCheck?: Layer.Layer<RunConditionCheck.RunConditionCheck>;
    /** Registers no work, so moving the clock days ahead does not tick the poll every 5 seconds. */
    readonly idleScheduler?: boolean;
    readonly threadManagement?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sql = yield* SqlClient.SqlClient;
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          extras.idleScheduler === true
            ? Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })
            : Scheduler.layer,
          ServerSettings.layerTest(extras.settings),
          MemoryAdmission.layerTest(),
          ManagedPolicy.layerTest(),
          layerSharedTaskDependencies(projects, extras.peerCheck, extras.runConditionCheck),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)(
            extras.launch === undefined ? {} : { launch: extras.launch },
          ),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH),
            ensureScratchProject: Effect.succeed({ projectId: SCRATCH }),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)(
            extras.threadManagement ?? {},
          ),
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
        const scratch = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP))
          .task;
        expect(scratch.shared).toEqual({
          revision: { at: "2026-09-09T12:00:00.000Z", environmentId: HERE_ENVIRONMENT_ID },
          project: { type: "none" },
          excludedEnvironmentIds: [],
        });
        const repo = (yield* service.upsert(
          upsertInput({ id: "scheduled-task:repo", projectId: repoProject.id }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        expect(repo.shared?.project).toEqual({
          type: "repository",
          canonicalKey: "github.com/acme/repo",
          title: "Repo",
        });
        const noRemote = yield* service
          .upsert(
            upsertInput({ id: "scheduled-task:plain", projectId: plainProject.id }),
            ScheduledTaskService.CHANGED_IN_APP,
          )
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
      const bound = yield* service
        .upsert(upsertInput({ threadId: "thread-1" }), ScheduledTaskService.CHANGED_IN_APP)
        .pipe(Effect.flip);
      expect(bound.message).toBe(
        "A shared task starts a new thread on each machine, so it can't post to one thread.",
      );
      const webhook = yield* service
        .upsert(
          upsertInput({
            schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: null },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
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
        yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP);
        yield* sql`UPDATE scheduled_task_shared SET revision_at = '2030-01-01T00:00:00.000Z'`;
        const saved = (yield* service.upsert(
          upsertInput({ title: "Edited" }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
        expect(saved.shared?.revision.at).toBe("2030-01-01T00:00:00.001Z");

        // A task saved before authors were recorded reads as unknown, not as anyone's.
        yield* sql`DELETE FROM scheduled_task_changed_by`;
        expect((yield* taskOf(service))?.changedBy).toBeNull();

        yield* sql`UPDATE scheduled_task_shared SET revision_at = '2031-01-01T00:00:00.000Z'`;
        yield* service.setEnabled(
          { id: saved.id, enabled: false },
          ScheduledTaskService.CHANGED_IN_APP,
        );
        const toggled = yield* taskOf(service);
        expect([toggled?.shared?.revision.at, toggled?.changedBy]).toEqual([
          "2031-01-01T00:00:00.001Z",
          { kind: "ui", threadId: null, at: "2026-09-09T12:00:00.000Z" },
        ]);

        const agent = { kind: "mcp", threadId: ThreadId.make("thread-agent") } as const;
        yield* service.setFollowsDefaultModel(
          { ids: [saved.id], followsDefaultModel: true },
          agent,
        );
        expect((yield* taskOf(service))?.shared?.revision.at).toBe("2031-01-01T00:00:00.002Z");

        yield* service.setGroup({ id: saved.id, group: "Autopilot" }, agent);
        expect((yield* taskOf(service))?.shared?.revision.at).toBe("2031-01-01T00:00:00.003Z");

        // Where a task sits is this machine's own business: no revision, and the author stays.
        yield* service.setPlacement({ ids: [saved.id], placement: "pinned" });
        const placed = yield* taskOf(service);
        expect([placed?.shared?.revision.at, placed?.changedBy]).toEqual([
          "2031-01-01T00:00:00.003Z",
          { ...agent, at: "2026-09-09T12:00:00.000Z" },
        ]);
      }),
    ),
);

it.effect(
  "deleting a shared task leaves a deletion; unsharing keeps the task and leaves one too",
  () =>
    withService((service) =>
      Effect.gen(function* () {
        const id = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP)).task
          .id;
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
        const reshared = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP))
          .task;
        expect(reshared.shared?.revision.at).toBe("2026-09-09T12:00:00.002Z");
        expect((yield* service.list()).sharedDeletions).toEqual([]);

        const unshared = (yield* service.upsert(
          upsertInput({ shared: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        )).task;
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
        const id = (yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP)).task
          .id;
        yield* sql`UPDATE scheduled_tasks SET run_count = 5, last_run_status = 'succeeded'`;
        const at = "2026-09-10T00:00:00.000Z";
        expect(yield* service.applyShared(copy(at))).toEqual({ outcome: "applied" });
        const task = yield* taskOf(service);
        expect(task?.title).toBe("From elsewhere");
        expect(task?.runCount).toBe(5);
        expect(task?.lastRunStatus).toBe("succeeded");
        expect(task?.shared?.revision).toEqual({ at, environmentId: OTHER });
        expect(task?.id).toBe(id);
        // A copy that does not say who made it leaves the author unknown, not this machine's.
        expect(task?.changedBy).toBeNull();
        const author = {
          kind: "mcp",
          threadId: "thread-there",
          at: "2026-09-10T00:00:30.000Z",
        } as const;
        yield* service.applyShared(copy("2026-09-10T00:00:30.000Z", { changedBy: author }));
        expect((yield* taskOf(service))?.changedBy).toEqual(author);

        // A copy without the field keeps this machine's run condition; null clears it.
        const condition = { command: "node ~/check.mjs", timeoutSeconds: 30 };
        yield* service.applyShared(copy("2026-09-11T00:00:00.000Z", { runCondition: condition }));
        expect((yield* taskOf(service))?.runCondition).toEqual(condition);
        yield* service.applyShared(copy("2026-09-12T00:00:00.000Z"));
        expect((yield* taskOf(service))?.runCondition).toEqual(condition);
        yield* service.applyShared(copy("2026-09-13T00:00:00.000Z", { runCondition: null }));
        expect((yield* taskOf(service))?.runCondition).toBeNull();
      }),
    ),
);

it.effect("applying an older or equal revision changes nothing", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP);
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

it.effect("a copy at the same revision fills in the settings an older app's copy left out", () =>
  withService((service) =>
    Effect.gen(function* () {
      const condition = { command: "node ~/check.mjs", timeoutSeconds: 30 };
      yield* service.applyShared(
        copy("2026-09-10T00:00:00.000Z", {
          runCondition: condition,
          delegateProviders: ["codex"],
          maxLiveRuns: 3,
        }),
      );
      // An app without run conditions saves the next revision: this machine keeps its own.
      const at = "2026-09-11T00:00:00.000Z";
      expect(yield* service.applyShared(copy(at, { title: "From an older app" }))).toEqual({
        outcome: "applied",
      });
      const kept = yield* taskOf(service);
      expect([kept?.runCondition, kept?.delegateProviders, kept?.maxLiveRuns]).toEqual([
        condition,
        ["codex"],
        3,
      ]);
      // The fuller copy of that revision, from the link pull, completes it.
      const author = { kind: "ui", threadId: null, at } as const;
      const full = copy(at, {
        title: "From an older app",
        runCondition: null,
        delegateProviders: [],
        maxLiveRuns: 1,
        changedBy: author,
      });
      expect(yield* service.applyShared(full)).toEqual({ outcome: "applied" });
      const completed = yield* taskOf(service);
      expect([
        completed?.runCondition,
        completed?.delegateProviders,
        completed?.maxLiveRuns,
        completed?.changedBy,
      ]).toEqual([null, [], 1, author]);
      expect(yield* service.applyShared(full)).toEqual({ outcome: "stale" });
      expect(
        yield* service.applyShared(copy("2026-09-10T12:00:00.000Z", { runCondition: condition })),
      ).toEqual({ outcome: "stale" });
      const task = yield* taskOf(service);
      expect([task?.runCondition, task?.shared?.revision.at]).toEqual([null, at]);
    }),
  ),
);

it.effect("a machine in the exclusion list drops its copy without leaving a deletion", () =>
  withService((service) =>
    Effect.gen(function* () {
      yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP);
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
      yield* service.upsert(upsertInput(), ScheduledTaskService.CHANGED_IN_APP);
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
      yield* service.upsert(upsertInput({ shared: null }), ScheduledTaskService.CHANGED_IN_APP);
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
      const first = (yield* service.upsert(
        upsertInput({ shared }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task;
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
        ScheduledTaskService.CHANGED_IN_APP,
      );
      const second = (yield* service.list()).projectMachineOrders?.[0];
      expect(second?.revision.at).toBe("2026-09-09T12:00:00.001Z");
      expect((yield* taskOf(service))?.shared?.runOn).toBe("one");
    }),
  ),
);

it.effect(
  "machines a task reaches without a link: the project's order and those that pulled, not this one",
  () =>
    withService((service) =>
      Effect.gen(function* () {
        expect(yield* service.knownMachineIds(SCRATCH)).toEqual([]);
        yield* service.applyShared(
          order("2026-09-10T00:00:00.000Z", [OTHER, HERE_ENVIRONMENT_ID, "environment-third"]),
        );
        // A machine that links here and pulls, with no link from here and no place in the order.
        yield* service.sharedCopies("environment-puller" as never, { recordPuller: true });
        yield* service.sharedCopies(HERE_ENVIRONMENT_ID as never, { recordPuller: true });
        // A caller not proven to be the machine it names reads copies but is not recorded.
        yield* service.sharedCopies("environment-claimed" as never, { recordPuller: false });

        expect(yield* service.knownMachineIds(SCRATCH)).toEqual([
          OTHER,
          "environment-third",
          "environment-puller",
        ]);
        // Another project has no machine order; the machines that pull still get its copies.
        expect(yield* service.knownMachineIds(ProjectId.make(repoProject.id))).toEqual([
          "environment-puller",
        ]);
      }),
    ),
);

it.effect("a machine that stops pulling for 30 days is no longer one copies reach", () =>
  withService(
    (service, sql) =>
      Effect.gen(function* () {
        const repo = ProjectId.make(repoProject.id);
        yield* service.sharedCopies("environment-gone" as never, { recordPuller: true });
        yield* TestClock.adjust("29 days");
        yield* service.sharedCopies("environment-active" as never, { recordPuller: true });
        expect(yield* service.knownMachineIds(repo)).toEqual([
          "environment-active",
          "environment-gone",
        ]);

        yield* TestClock.adjust("2 days");
        expect(yield* service.knownMachineIds(repo)).toEqual(["environment-active"]);
        // The next pull drops the stale row.
        yield* service.sharedCopies("environment-active" as never, { recordPuller: true });
        const rows = yield* sql<{ readonly environment_id: string }>`
        SELECT environment_id FROM scheduled_task_shared_pullers ORDER BY environment_id
      `;
        expect(rows.map((row) => row.environment_id)).toEqual(["environment-active"]);
      }),
    [repoProject, plainProject],
    { idleScheduler: true },
  ),
);

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** A null order stores none for the project. */
const oneMachineShared = (machineOrder: string[] | null) => ({
  excludedEnvironmentIds: [],
  runOn: "one",
  ...(machineOrder === null ? {} : { machineOrder }),
});

const FINISHED_THERE: SharedTaskPeerCheck.PeerCheckResult = {
  ranOn: OTHER as never,
  working: false,
  noWork: null,
  liveRunsElsewhere: [],
  unchecked: [],
};
const NO_WORK_THERE: SharedTaskPeerCheck.PeerCheckResult = {
  ...FINISHED_THERE,
  noWork: { reason: "No open pull requests" },
};
const WORKING_THERE: SharedTaskPeerCheck.PeerCheckResult = { ...FINISHED_THERE, working: true };
/** The asked machines have no run of the occurrence; a failed one counts as none. */
const NO_RUN_THERE: SharedTaskPeerCheck.PeerCheckResult = {
  ranOn: null,
  working: false,
  noWork: null,
  liveRunsElsewhere: [],
  unchecked: [],
};
const SILENT_THERE: SharedTaskPeerCheck.PeerCheckResult = {
  ranOn: null,
  working: false,
  noWork: null,
  liveRunsElsewhere: [],
  unchecked: [{ environmentId: OTHER as never, reason: "It did not answer in time." }],
};

const UNREACHABLE = "unreachable";
/** A peer's copy of the occurrence claims, by peer: who holds it there, or that it can't be reached. */
type PeerCopies = ReadonlyMap<string, string | typeof UNREACHABLE>;

// The task is due one hour after NOW. Each tick fires at `atMs`, and `settled` waits for the
// change the tick published, so nothing polls. A list of answers is given out in turn, the last
// one repeating. Peers record claims as a real copy would: one gives its own claim away only
// when it is in `failed`, its run of the occurrence having failed.
const runScenario = <A, E>(
  machineOrder: string[] | null,
  peers: SharedTaskPeerCheck.PeerCheckResult | ReadonlyArray<SharedTaskPeerCheck.PeerCheckResult>,
  body: (scenario: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly launches: Queue.Queue<unknown>;
    readonly peerCalls: Ref.Ref<
      ReadonlyArray<{ peers: ReadonlyArray<string>; occurrence: string; since: string }>
    >;
    readonly peerCopies: Ref.Ref<PeerCopies>;
    readonly failed: Ref.Ref<ReadonlySet<string>>;
    /** The occurrence each claim sent to peers named. */
    readonly peerClaims: Ref.Ref<ReadonlyArray<string>>;
    readonly linked: Ref.Ref<ReadonlyArray<string>>;
    readonly tick: (atMs: number) => Effect.Effect<void>;
    readonly settled: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
  schedule: Record<string, unknown> = { type: "interval", everyMs: HOUR_MS },
  /** Gives the task a run condition, counting the checks run here. */
  checks?: Ref.Ref<number>,
  checkAnswer: ScheduledTaskRunCheck = { outcome: "run", failure: null, exitCode: 0, detail: null },
  threadManagement?: Partial<ThreadManagementService.ThreadManagementService["Service"]>,
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<unknown>();
    const peerCalls = yield* Ref.make<
      ReadonlyArray<{ peers: ReadonlyArray<string>; occurrence: string; since: string }>
    >([]);
    const peerCopies = yield* Ref.make<PeerCopies>(new Map());
    const failed = yield* Ref.make<ReadonlySet<string>>(new Set());
    const peerClaims = yield* Ref.make<ReadonlyArray<string>>([]);
    const linked = yield* Ref.make<ReadonlyArray<string>>([]);
    const peerCheck = Layer.mock(SharedTaskPeerCheck.SharedTaskPeerCheck)({
      linkedEnvironmentIds: Ref.get(linked) as Effect.Effect<ReadonlyArray<never>>,
      linkStatus: Effect.succeed({ enabled: false, links: [] }),
      check: (input) =>
        Ref.updateAndGet(peerCalls, (calls) => [
          ...calls,
          { peers: input.peers, occurrence: input.occurrence, since: input.since },
        ]).pipe(
          Effect.map((calls) =>
            "ranOn" in peers ? peers : peers[Math.min(calls.length, peers.length) - 1]!,
          ),
        ),
      claim: (input) =>
        Ref.update(peerClaims, (claims) => [...claims, input.occurrence]).pipe(
          Effect.andThen(Ref.get(failed)),
          Effect.flatMap((failedThere) =>
            Ref.modify(peerCopies, (copies) => {
              const next = new Map(copies);
              const answer: {
                answered: SharedTaskPeerCheck.PeerClaimResult["answered"][number][];
                unchecked: SharedTaskPeerCheck.PeerClaimResult["unchecked"][number][];
              } = { answered: [], unchecked: [] };
              for (const environmentId of input.peers) {
                const held = copies.get(environmentId);
                if (held === UNREACHABLE) {
                  answer.unchecked.push({ environmentId, reason: "It did not answer in time." });
                  continue;
                }
                const takesOver =
                  held === input.replaces &&
                  (held !== environmentId || failedThere.has(environmentId));
                const holder = held === undefined || takesOver ? input.holder : held;
                next.set(environmentId, holder);
                answer.answered.push({ environmentId, holder: holder as never });
              }
              return [answer, next];
            }),
          ),
        ),
    });
    return yield* withService(
      (service, sql) =>
        Effect.gen(function* () {
          yield* service.upsert(
            upsertInput({
              shared: oneMachineShared(machineOrder),
              schedule,
              ...(checks === undefined
                ? {}
                : { projectId: repoProject.id, runCondition: { command: "node ~/check.mjs" } }),
            }),
            ScheduledTaskService.CHANGED_IN_APP,
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
            peerCopies,
            failed,
            peerClaims,
            linked,
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
        ...(checks === undefined
          ? {}
          : {
              runConditionCheck: Layer.mock(RunConditionCheck.RunConditionCheck)({
                run: () => Ref.update(checks, (n) => n + 1).pipe(Effect.as(checkAnswer)),
              }),
            }),
        ...(threadManagement === undefined ? {} : { threadManagement }),
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
  runScenario([OTHER, HERE_ENVIRONMENT_ID], FINISHED_THERE, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.tick(DUE + 1_000);
      yield* scenario.settled;
      // Rank 1 waits one grace (5 minutes) and asks no one yet.
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + 5 * MINUTE_MS));
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([]);

      yield* scenario.tick(DUE + 5 * MINUTE_MS + 1_000);
      yield* scenario.settled;
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([
        { peers: [OTHER], occurrence: iso(DUE), since: iso(DUE - 30 * MINUTE_MS) },
      ]);
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
      expect(yield* Queue.size(scenario.launches)).toBe(0);
      const decision = (yield* taskOf(scenario.service))?.lastOneMachineDecision;
      expect(decision?.ranOn).toBe(OTHER);
    }),
  ),
);

it.effect.each([
  { name: "has it", peers: FINISHED_THERE, checks: 0, check: null },
  {
    name: "skipped it for no work",
    peers: NO_WORK_THERE,
    checks: 0,
    check: { outcome: "skip", failure: null, exitCode: null, detail: "No open pull requests" },
  },
  { name: "does not have it", peers: NO_RUN_THERE, checks: 1, check: null },
])(
  "a later machine runs its own check only when an earlier machine $name",
  ({ peers, checks, check }) =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0);
      yield* runScenario(
        [OTHER, HERE_ENVIRONMENT_ID],
        peers,
        (scenario) =>
          Effect.gen(function* () {
            yield* scenario.tick(DUE + 1_000);
            yield* scenario.settled;
            yield* scenario.tick(DUE + 5 * MINUTE_MS + 1_000);
            if (checks === 0) {
              yield* scenario.settled;
              const runs = yield* scenario.service.listRuns({
                id: "scheduled-task:shared" as ScheduledTaskId,
              });
              expect(runs.runs[0]).toMatchObject({
                skipReason: "ran_elsewhere",
                ranOn: OTHER,
                check,
              });
            } else {
              yield* Queue.take(scenario.launches);
            }
            expect(yield* Ref.get(ran)).toBe(checks);
          }),
        { type: "interval", everyMs: HOUR_MS },
        ran,
      );
    }),
);

it.effect("the first machine's own no-work skip moves the task to its next aligned slot", () =>
  Effect.gen(function* () {
    const ran = yield* Ref.make(0);
    yield* runScenario(
      [HERE_ENVIRONMENT_ID, OTHER],
      NO_RUN_THERE,
      (scenario) =>
        Effect.gen(function* () {
          const skipped = yield* scenario.service.subscribeList().pipe(
            Stream.filter(({ tasks }) =>
              tasks.some((task) => task.lastNoWorkSkip != null && task.runCheckStartedAt == null),
            ),
            Stream.runHead,
            Effect.forkChild,
          );
          yield* scenario.tick(DUE + 1_000);
          yield* Fiber.join(skipped);
          expect(yield* Ref.get(ran)).toBe(1);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
        }),
      { type: "interval", everyMs: HOUR_MS },
      ran,
      { outcome: "skip", failure: null, exitCode: 10, detail: null },
    );
  }),
);

it.effect(
  "the first machine in the order runs on time once no other machine ran it and the copies agree",
  () =>
    runScenario([HERE_ENVIRONMENT_ID, OTHER], NO_RUN_THERE, (scenario) =>
      Effect.gen(function* () {
        yield* scenario.tick(DUE + 1_000);
        yield* Queue.take(scenario.launches);
        expect(yield* Ref.get(scenario.peerCalls)).toEqual([
          { peers: [OTHER], occurrence: iso(DUE), since: iso(DUE - 30 * MINUTE_MS) },
        ]);
        expect((yield* Ref.get(scenario.peerCopies)).get(OTHER)).toBe(HERE_ENVIRONMENT_ID);
      }),
    ),
);

const dueLocal = DateTime.toParts(
  DateTime.makeZonedUnsafe(DUE, { timeZone: DateTime.zoneMakeLocal() }),
);
const two = (value: number) => String(value).padStart(2, "0");
/** How a fixed time names its occurrence: the local wall-clock time, with no offset. */
const localSlot = (parts: ReturnType<typeof DateTime.toParts>) =>
  `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`;

// Each machine reaches a fixed time at its own local hour, so a claim names the hour, not the instant.
it.effect(
  "a fixed time is claimed from peers by its local wall-clock time, which names the same occurrence here",
  () =>
    runScenario(
      [HERE_ENVIRONMENT_ID, OTHER, MIDDLE],
      NO_RUN_THERE,
      (scenario) =>
        Effect.gen(function* () {
          yield* scenario.tick(DUE + 1_000);
          yield* Queue.take(scenario.launches);
          const slot = localSlot(dueLocal);
          expect(yield* Ref.get(scenario.peerClaims)).toEqual([slot]);
          expect((yield* Ref.get(scenario.peerCalls)).map((call) => call.occurrence)).toEqual([
            slot,
          ]);
          expect(
            yield* scenario.service.claimOccurrence({
              taskId: "scheduled-task:shared" as ScheduledTaskId,
              occurrence: slot,
              holder: OTHER as never,
              replaces: null,
              by: OTHER as never,
            }),
          ).toBe(HERE_ENVIRONMENT_ID);
        }),
      { type: "fixed_time", timeOfDay: `${two(dueLocal.hour)}:${two(dueLocal.minute)}` },
    ),
);

// A machine in another time zone reaches a fixed time first, so being first proves nothing.
it.effect("the first machine skips an occurrence another machine already ran", () =>
  runScenario([HERE_ENVIRONMENT_ID, OTHER], FINISHED_THERE, (scenario) =>
    Effect.gen(function* () {
      // The scheduler ticks every 5 seconds, so lateness needs a due time already in the past.
      const lateDue = iso(NOW - 2 * MINUTE_MS);
      yield* scenario.sql`UPDATE scheduled_tasks SET next_run_at = ${lateDue}`;
      yield* scenario.service.setPlacement({
        ids: ["scheduled-task:shared" as ScheduledTaskId],
        placement: "pinned",
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

// A daily time two hours before NOW, so a machine coming back at NOW has missed it.
const MISSED = NOW - 2 * HOUR_MS;
const missedLocal = DateTime.toParts(
  DateTime.makeZonedUnsafe(MISSED, { timeZone: DateTime.zoneMakeLocal() }),
);

it.effect(
  "a later machine catching up a missed daily run waits its turn from now, then skips one an earlier machine ran",
  () =>
    runScenario(
      [OTHER, HERE_ENVIRONMENT_ID],
      FINISHED_THERE,
      (scenario) =>
        Effect.gen(function* () {
          // This machine was asleep at the time; the earlier machine was on.
          yield* scenario.sql`UPDATE scheduled_tasks SET next_run_at = ${iso(MISSED)}`;
          yield* scenario.tick(NOW);
          yield* scenario.settled;
          const deferredTo = Date.parse((yield* nextRunAtOf(scenario.sql))!);
          expect(deferredTo).toBeGreaterThanOrEqual(NOW + 5 * MINUTE_MS);
          expect(yield* Ref.get(scenario.peerCalls)).toEqual([]);

          yield* scenario.tick(deferredTo + 1_000);
          yield* scenario.settled;
          // It asks about the missed time, not the hour it came back at.
          expect(yield* Ref.get(scenario.peerCalls)).toEqual([
            {
              peers: [OTHER],
              occurrence: localSlot(missedLocal),
              since: iso(MISSED - 12 * HOUR_MS),
            },
          ]);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(MISSED + 24 * HOUR_MS));
          const runs = (yield* scenario.service.listRuns({
            id: "scheduled-task:shared" as ScheduledTaskId,
          })).runs;
          expect(runs).toMatchObject([
            {
              trigger: "catch_up",
              outcome: "skipped",
              skipReason: "ran_elsewhere",
              ranOn: OTHER,
              scheduledFor: iso(MISSED),
            },
          ]);
        }),
      {
        type: "fixed_time",
        timeOfDay: `${missedLocal.hour}:${String(missedLocal.minute).padStart(2, "0")}`,
      },
    ),
);

// Fires the task when it is next due and waits for what that tick published.
const fireWhenDue = (scenario: {
  readonly sql: SqlClient.SqlClient;
  readonly tick: (atMs: number) => Effect.Effect<void>;
  readonly settled: Effect.Effect<void>;
}) =>
  nextRunAtOf(scenario.sql).pipe(
    Effect.flatMap((next) => scenario.tick(Date.parse(next!) + 1_000)),
    Effect.andThen(scenario.settled),
  );

const MIDDLE = "environment-middle";
const unreachable = (...environmentIds: string[]): SharedTaskPeerCheck.PeerCheckResult => ({
  ranOn: null,
  working: false,
  noWork: null,
  liveRunsElsewhere: [],
  unchecked: environmentIds.map((environmentId) => ({
    environmentId: environmentId as never,
    reason: "It did not answer in time.",
  })),
});
const claimsOf = (sql: SqlClient.SqlClient) =>
  sql<{ occurrence_at: string; holder_environment_id: string }>`
    SELECT occurrence_at, holder_environment_id FROM scheduled_task_occurrence_claims`;

// Each machine of three sees only its own copy, so none holds a majority: no one runs it rather
// than all three. Of two, the first machine's copy is the deciding half.
it.effect.each([
  { name: "first of three", order: [HERE_ENVIRONMENT_ID, OTHER, MIDDLE], runs: false },
  { name: "second of three", order: [OTHER, HERE_ENVIRONMENT_ID, MIDDLE], runs: false },
  { name: "third of three", order: [OTHER, MIDDLE, HERE_ENVIRONMENT_ID], runs: false },
  { name: "first of two", order: [HERE_ENVIRONMENT_ID, OTHER], runs: true },
  { name: "second of two", order: [OTHER, HERE_ENVIRONMENT_ID], runs: false },
])(
  "with every link down, the machine $name in the order runs the occurrence only if it is first of two",
  ({ order, runs }) =>
    runScenario(order, unreachable(OTHER, MIDDLE), (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(
          scenario.peerCopies,
          new Map([
            [OTHER, UNREACHABLE],
            [MIDDLE, UNREACHABLE],
          ]),
        );
        if (runs) {
          yield* scenario.tick(DUE + 1_000);
          yield* Queue.take(scenario.launches);
          expect(yield* claimsOf(scenario.sql)).toEqual([
            { occurrence_at: iso(DUE), holder_environment_id: HERE_ENVIRONMENT_ID },
          ]);
          return;
        }
        // Wait its turn, then find no machine to confirm the occurrence is free.
        if (order[0] !== HERE_ENVIRONMENT_ID) yield* fireWhenDue(scenario);
        yield* fireWhenDue(scenario);
        expect(yield* Queue.size(scenario.launches)).toBe(0);
        expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
        expect(yield* claimsOf(scenario.sql)).toEqual([]);
        const runRecords = (yield* scenario.service.listRuns({
          id: "scheduled-task:shared" as ScheduledTaskId,
        })).runs;
        expect(runRecords).toMatchObject([
          { outcome: "skipped", skipReason: "unconfirmed", ranOn: null, scheduledFor: iso(DUE) },
        ]);
        const decision = (yield* taskOf(scenario.service))?.lastOneMachineDecision;
        expect(decision).toMatchObject({ ranOn: null, unconfirmed: true });
      }),
    ),
);

// The other side of a split that cuts off the first machine, which runs nothing on its own.
it.effect(
  "with the first machine down, the next one runs once the third machine's copy makes a majority",
  () =>
    runScenario([OTHER, HERE_ENVIRONMENT_ID, MIDDLE], unreachable(OTHER), (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(scenario.peerCopies, new Map([[OTHER, UNREACHABLE]]));
        yield* fireWhenDue(scenario);
        yield* scenario.tick(Date.parse((yield* nextRunAtOf(scenario.sql))!) + 1_000);
        yield* Queue.take(scenario.launches);
        expect((yield* Ref.get(scenario.peerCopies)).get(MIDDLE)).toBe(HERE_ENVIRONMENT_ID);
        const decision = (yield* taskOf(scenario.service))?.lastOneMachineDecision;
        expect(decision).toMatchObject({
          ranOn: null,
          unchecked: [{ environmentId: OTHER, reason: "It did not answer in time." }],
        });
      }),
    ),
);

// With the first machine off, the third took the occurrence before over late and is still running
// it when this one comes due: its run started inside this occurrence's window, but is not this one's.
it.effect("a late takeover of the occurrence before does not count as this occurrence's run", () =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<unknown>();
    const off = Effect.fail(
      new OrchestratorMcpFailure({ code: "orchestration_error", message: "It is off." }),
    );
    const peerCheck = SharedTaskPeerCheck.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            listStored: Effect.succeed([]),
            get: (environmentId) =>
              Effect.succeedSome({
                environmentId,
                expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
              } as never),
          }),
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: ({ environmentId }) =>
              environmentId === OTHER
                ? off
                : (Effect.succeed({
                    tasks: [
                      {
                        scheduledTaskId: "scheduled-task:shared",
                        lastRun: {
                          at: iso(DUE - 10 * MINUTE_MS),
                          // Still working, it would hold this occurrence back instead.
                          outcome: "completed",
                          occurrence: iso(DUE - HOUR_MS),
                        },
                      },
                    ],
                  }) as never),
            callIfAvailable: ({ environmentId, arguments: args }) =>
              environmentId === OTHER
                ? off
                : (Effect.succeedSome({ holder: (args as { holder: string }).holder }) as never),
          }),
        ),
      ),
    );
    yield* withService(
      (service, sql) =>
        Effect.gen(function* () {
          yield* service.upsert(
            upsertInput({
              shared: oneMachineShared([OTHER, HERE_ENVIRONMENT_ID, MIDDLE]),
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          const changes = yield* Queue.unbounded<void>();
          yield* Effect.forkScoped(
            service.subscribeList().pipe(
              Stream.drop(1),
              Stream.runForEach(() => Queue.offer(changes, undefined)),
            ),
          );
          const scenario = {
            sql,
            tick: (atMs: number) =>
              TestClock.setTime(atMs).pipe(Effect.andThen(TestClock.adjust("6 seconds"))),
            settled: Queue.take(changes),
          };
          yield* fireWhenDue(scenario);
          yield* scenario.tick(Date.parse((yield* nextRunAtOf(sql))!) + 1_000);
          yield* Queue.take(launches);
          const decision = (yield* taskOf(service))?.lastOneMachineDecision;
          expect(decision).toMatchObject({
            ranOn: null,
            unchecked: [{ environmentId: OTHER, reason: "It is off." }],
          });
        }).pipe(Effect.scoped),
      [repoProject, plainProject],
      {
        peerCheck,
        launch: (input) =>
          Queue.offer(launches, input).pipe(Effect.as({ threadId: "thread-1" } as never)),
      },
    );
  }),
);

// A claim held by a machine that skips its run would keep every other machine from taking it.
it.effect(
  "a machine whose accounts are all out of usage claims nothing, so the next machine may run it",
  () =>
    runScenario([HERE_ENVIRONMENT_ID, OTHER], NO_RUN_THERE, (scenario) =>
      Effect.gen(function* () {
        yield* scenario.tick(DUE + 1_000);
        yield* scenario.settled;
        expect(yield* Queue.size(scenario.launches)).toBe(0);
        expect(yield* Ref.get(scenario.peerClaims)).toEqual([]);
        expect(yield* claimsOf(scenario.sql)).toEqual([]);
        const { runs } = yield* scenario.service.listRuns({
          id: "scheduled-task:shared" as ScheduledTaskId,
        });
        expect(runs).toEqual([
          expect.objectContaining({ outcome: "skipped", skipReason: "usage_limited" }),
        ]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mock(AccountRouting.AccountRouting)({
          scheduledRunBlock: () =>
            Effect.succeed({
              driver: ProviderDriverKind.make("codex"),
              until: iso(DUE + 5 * HOUR_MS),
              accounts: [ProviderInstanceId.make("codex_main")],
            }),
        }),
      ),
    ),
);

it.effect("a machine waiting its turn stops its own last-run chat once it stalled", () =>
  Effect.gen(function* () {
    const stops = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const threadManagement = {
      getThreadRecords: () =>
        Effect.succeed({
          thread: {
            id: "thread-1",
            deletedAt: null,
            updatedAt: DateTime.makeUnsafe(NOW - HOUR_MS),
          },
          runs: [{ id: "run-1", ordinal: 1, status: "running", providerThreadId: "provider-1" }],
          providerThreads: [{ id: "provider-1", driver: "claudeAgent" }],
          subagents: [],
        } as never),
      dispatch: (command: { readonly type: string; readonly threadId?: unknown }) =>
        Ref.update(stops, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 } as never)),
    } as Partial<ThreadManagementService.ThreadManagementService["Service"]>;
    yield* runScenario(
      [OTHER, HERE_ENVIRONMENT_ID],
      NO_RUN_THERE,
      (scenario) =>
        Effect.gen(function* () {
          const id = "scheduled-task:shared" as ScheduledTaskId;
          yield* scenario.service.runNow({ id });
          yield* Queue.take(scenario.launches);
          // Quiet for two hours on Claude when it first looks, so it stops the chat as it waits.
          yield* scenario.tick(DUE + 1_000);
          yield* scenario.settled;
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + 5 * MINUTE_MS));
          const reason =
            "Stopped: nothing happened in this chat for 2 hours, so it no longer holds back the runs of this scheduled task.";
          expect(yield* Ref.get(stops)).toEqual([
            expect.objectContaining({ type: "thread.stop", threadId: "thread-1", reason }),
          ]);
          const { runs } = yield* scenario.service.listRuns({ id });
          expect(runs).toEqual([expect.objectContaining({ outcome: "failed", error: reason })]);
        }),
      undefined,
      undefined,
      undefined,
      threadManagement,
    );
  }),
);

it.effect(
  "a machine skips an occurrence while the task's live-run limit is reached on another machine",
  () =>
    runScenario(
      [OTHER, HERE_ENVIRONMENT_ID],
      { ...NO_RUN_THERE, liveRunsElsewhere: [{ environmentId: OTHER as never, liveRuns: 1 }] },
      (scenario) =>
        Effect.gen(function* () {
          // The machine ahead skipped it for its own live run; this one asks after its grace.
          yield* scenario.tick(DUE + 1_000);
          yield* scenario.settled;
          yield* scenario.tick(DUE + 5 * MINUTE_MS + 1_000);
          yield* scenario.settled;
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* Ref.get(scenario.peerClaims)).toEqual([]);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
          const { runs } = yield* scenario.service.listRuns({
            id: "scheduled-task:shared" as ScheduledTaskId,
          });
          expect(runs).toEqual([
            expect.objectContaining({
              outcome: "skipped",
              skipReason: "live_run_limit",
              scheduledFor: iso(DUE),
              ranOn: OTHER,
            }),
          ]);
        }),
    ),
);

// Handing on only toward the front keeps two machines from handing their copies to each other.
it.effect.each([
  { name: "ahead of it", order: [OTHER, MIDDLE, HERE_ENVIRONMENT_ID], kept: MIDDLE },
  { name: "behind it", order: [HERE_ENVIRONMENT_ID, OTHER, MIDDLE], kept: HERE_ENVIRONMENT_ID },
])(
  "a machine without a majority hands its copy only to a holder $name, and watches that one",
  ({ order, kept }) =>
    runScenario(order, NO_RUN_THERE, (scenario) =>
      Effect.gen(function* () {
        // The middle machine claimed two copies, but its run is not in its list yet.
        yield* Ref.set(
          scenario.peerCopies,
          new Map([
            [OTHER, MIDDLE],
            [MIDDLE, MIDDLE],
          ]),
        );
        if (order[0] !== HERE_ENVIRONMENT_ID) yield* fireWhenDue(scenario);
        const askedAt = Date.parse((yield* nextRunAtOf(scenario.sql))!);
        yield* fireWhenDue(scenario);
        expect(yield* Queue.size(scenario.launches)).toBe(0);
        expect(yield* claimsOf(scenario.sql)).toEqual([
          { occurrence_at: iso(DUE), holder_environment_id: kept },
        ]);
        expect((yield* taskOf(scenario.service))?.lastOneMachineDecision?.ranOn).toBe(MIDDLE);
        // It asks the holder again a grace later.
        expect(Date.parse((yield* nextRunAtOf(scenario.sql))!)).toBeGreaterThanOrEqual(
          askedAt + 5 * MINUTE_MS,
        );
      }),
    ),
);

it.effect(
  "a claim recorded here keeps a later machine off the occurrence when it reaches no one",
  () =>
    runScenario([OTHER, HERE_ENVIRONMENT_ID, MIDDLE], unreachable(OTHER, MIDDLE), (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(
          scenario.peerCopies,
          new Map([
            [OTHER, UNREACHABLE],
            [MIDDLE, UNREACHABLE],
          ]),
        );
        // The first machine's claim reached this one before the links failed.
        yield* scenario.service.claimOccurrence({
          taskId: "scheduled-task:shared" as ScheduledTaskId,
          occurrence: iso(DUE),
          holder: OTHER as never,
          replaces: null,
          by: OTHER as never,
        });
        yield* fireWhenDue(scenario);
        yield* fireWhenDue(scenario);
        expect(yield* Queue.size(scenario.launches)).toBe(0);
        expect((yield* taskOf(scenario.service))?.lastOneMachineDecision?.ranOn).toBe(OTHER);
      }),
    ),
);

// Every machine must count the same members, so the order is stored and shared like an edit.
it.effect.each([
  { name: "first", linked: ["environment-zulu"], runs: true },
  { name: "second", linked: ["environment-alpha"], runs: false },
])(
  "with no machine order stored, a machine stores the sorted one and takes its place ($name here)",
  ({ linked, runs }) =>
    runScenario(null, NO_RUN_THERE, (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(scenario.linked, linked);
        yield* scenario.tick(DUE + 1_000);
        if (runs) {
          yield* Queue.take(scenario.launches);
        } else {
          yield* scenario.settled;
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + 5 * MINUTE_MS));
        }
        const [stored] = yield* scenario.sql<{ order_json: string }>`
          SELECT order_json FROM scheduled_task_project_machine_orders`;
        expect(JSON.parse(stored!.order_json)).toEqual([HERE_ENVIRONMENT_ID, ...linked].toSorted());
      }),
    ),
);

// Age never frees a claim: a run still being claimed or started looks idle to the machines
// watching it, and only the holder's own copy knows that it gave the occurrence up or its run failed.
it.effect(
  "a claim takes a free occurrence, and this machine's own claim goes only once it gave the occurrence up or its run of it failed in a chat",
  () =>
    withService(
      (service, sql) =>
        Effect.gen(function* () {
          const taskId = "scheduled-task:shared" as ScheduledTaskId;
          yield* service.upsert(
            upsertInput({
              shared: oneMachineShared([OTHER, MIDDLE, HERE_ENVIRONMENT_ID]),
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
            ScheduledTaskService.CHANGED_IN_APP,
          );
          const claimAt =
            (occurrence: number) =>
            (holder: string, replaces: string | null, by: string, lastRunFailed?: boolean) =>
              service.claimOccurrence({
                taskId,
                occurrence: iso(occurrence),
                holder: holder as never,
                replaces: replaces as never,
                by: by as never,
                ...(lastRunFailed === undefined ? {} : { lastRunFailed }),
              });
          const claim = claimAt(DUE);
          const claimNext = claimAt(DUE + HOUR_MS);
          const recordRun = (
            scheduledFor: number,
            startedAt: number,
            outcome: "failed" | "skipped",
            threadId: string | null,
            skipReason: string | null = null,
          ) =>
            sql`
              INSERT INTO scheduled_task_runs
                (run_id, task_id, trigger, scheduled_for, started_at, completed_at, outcome,
                  thread_id, skip_reason)
              VALUES (${`run-${startedAt}`}, ${taskId}, 'scheduled', ${iso(scheduledFor)},
                ${iso(startedAt)}, ${iso(startedAt)}, ${outcome}, ${threadId}, ${skipReason})
            `;
          expect(yield* claim(OTHER, null, OTHER)).toBe(OTHER);
          expect(yield* claim(MIDDLE, null, MIDDLE)).toBe(OTHER);
          // Another machine's copy agreed first; two machines taking it over can't both win.
          expect(yield* claim(MIDDLE, OTHER, MIDDLE)).toBe(MIDDLE);
          expect(yield* claim(HERE_ENVIRONMENT_ID, OTHER, HERE_ENVIRONMENT_ID)).toBe(MIDDLE);
          // A holder hands it on, but nothing it doesn't hold: a free occurrence stays free.
          expect(yield* claim(HERE_ENVIRONMENT_ID, MIDDLE, MIDDLE)).toBe(HERE_ENVIRONMENT_ID);
          const claimLater = claimAt(DUE + 2 * HOUR_MS);
          yield* claimLater(MIDDLE, OTHER, OTHER).pipe(Effect.flip);
          yield* claimLater(MIDDLE, HERE_ENVIRONMENT_ID, OTHER).pipe(Effect.flip);
          expect(yield* claimLater(HERE_ENVIRONMENT_ID, null, HERE_ENVIRONMENT_ID)).toBe(
            HERE_ENVIRONMENT_ID,
          );
          yield* TestClock.adjust("1 day");
          expect(yield* claim(OTHER, HERE_ENVIRONMENT_ID, OTHER)).toBe(HERE_ENVIRONMENT_ID);
          // A failed run of an earlier occurrence doesn't free this one.
          yield* recordRun(DUE - HOUR_MS, DUE - HOUR_MS, "failed", "thread-0");
          expect(yield* claim(OTHER, HERE_ENVIRONMENT_ID, OTHER, true)).toBe(HERE_ENVIRONMENT_ID);
          // A run cut off before its chat was recorded may have started one.
          yield* recordRun(DUE, DUE, "failed", null);
          expect(yield* claim(OTHER, HERE_ENVIRONMENT_ID, OTHER, true)).toBe(HERE_ENVIRONMENT_ID);
          yield* recordRun(DUE, DUE + MINUTE_MS, "failed", "thread-1");
          expect(yield* claim(OTHER, HERE_ENVIRONMENT_ID, OTHER, false)).toBe(HERE_ENVIRONMENT_ID);
          expect(yield* claim(OTHER, HERE_ENVIRONMENT_ID, OTHER, true)).toBe(OTHER);

          // A newer occurrence's claim leaves this one's in place for a machine still asking.
          expect(yield* claimNext(HERE_ENVIRONMENT_ID, null, HERE_ENVIRONMENT_ID)).toBe(
            HERE_ENVIRONMENT_ID,
          );
          expect(yield* claim(MIDDLE, null, MIDDLE)).toBe(OTHER);
          // Skipping it for no work settled it; skipping it unconfirmed gave it up.
          yield* recordRun(DUE + HOUR_MS, DUE + HOUR_MS, "skipped", null, "no_work");
          expect(yield* claimNext(OTHER, HERE_ENVIRONMENT_ID, OTHER)).toBe(HERE_ENVIRONMENT_ID);
          yield* recordRun(
            DUE + HOUR_MS,
            DUE + HOUR_MS + MINUTE_MS,
            "skipped",
            null,
            "unconfirmed",
          );
          expect(yield* claimNext(OTHER, HERE_ENVIRONMENT_ID, OTHER)).toBe(OTHER);
        }),
      [repoProject, plainProject],
      { idleScheduler: true },
    ),
);

it.effect.each([
  { name: "fails", answers: [WORKING_THERE, NO_RUN_THERE], runsHere: true },
  { name: "finishes", answers: [WORKING_THERE, FINISHED_THERE], runsHere: false },
  {
    name: "misses one check, then finishes",
    answers: [WORKING_THERE, SILENT_THERE, FINISHED_THERE],
    runsHere: false,
  },
])(
  "a later machine keeps asking about a run still going on an earlier one, which $name",
  ({ answers, runsHere }) =>
    runScenario([OTHER, HERE_ENVIRONMENT_ID], answers, (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(scenario.peerCopies, new Map([[OTHER, OTHER]]));
        if (runsHere) yield* Ref.set(scenario.failed, new Set([OTHER]));
        // Wait its turn, then ask once per answer, five minutes apart.
        yield* fireWhenDue(scenario);
        for (const _ of answers.slice(0, -1)) {
          yield* fireWhenDue(scenario);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
        }
        const lastAskedAt = Date.parse((yield* nextRunAtOf(scenario.sql))!);
        expect(lastAskedAt).toBeGreaterThanOrEqual(DUE + 5 * answers.length * MINUTE_MS);
        if (runsHere) {
          yield* scenario.tick(lastAskedAt + 1_000);
          yield* Queue.take(scenario.launches);
        } else {
          yield* fireWhenDue(scenario);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
        }
        expect(yield* Ref.get(scenario.peerCalls)).toHaveLength(answers.length);
      }),
    ),
);

// A holder still claiming or starting its run has none in its list yet, like one whose run failed.
it.effect(
  "a later machine takes over a run that ended only once the holder's own copy agrees",
  () =>
    runScenario([OTHER, HERE_ENVIRONMENT_ID], [WORKING_THERE, NO_RUN_THERE], (scenario) =>
      Effect.gen(function* () {
        yield* Ref.set(scenario.peerCopies, new Map([[OTHER, OTHER]]));
        // Wait its turn, see the run going, then see it gone while the holder keeps its claim.
        for (let step = 0; step < 3; step++) yield* fireWhenDue(scenario);
        expect(yield* Queue.size(scenario.launches)).toBe(0);
        expect((yield* Ref.get(scenario.peerCopies)).get(OTHER)).toBe(OTHER);
        expect(yield* claimsOf(scenario.sql)).toEqual([]);
        expect((yield* taskOf(scenario.service))?.lastOneMachineDecision?.ranOn).toBe(OTHER);

        yield* Ref.set(scenario.failed, new Set([OTHER]));
        yield* scenario.tick(Date.parse((yield* nextRunAtOf(scenario.sql))!) + 1_000);
        yield* Queue.take(scenario.launches);
        expect((yield* Ref.get(scenario.peerCopies)).get(OTHER)).toBe(HERE_ENVIRONMENT_ID);
        expect(yield* claimsOf(scenario.sql)).toEqual([
          { occurrence_at: iso(DUE), holder_environment_id: HERE_ENVIRONMENT_ID },
        ]);
      }),
    ),
);

// Silence is not an ended run: a busy machine misses calls, so taking over then would run it twice.
it.effect.each([
  { name: "still going", answers: [WORKING_THERE] },
  { name: "that stopped answering", answers: [WORKING_THERE, SILENT_THERE] },
])(
  "a later machine leaves a run $name when the next occurrence is due, and judges that one on its own",
  ({ answers }) =>
    runScenario(
      [OTHER, HERE_ENVIRONMENT_ID],
      answers,
      (scenario) =>
        Effect.gen(function* () {
          const due = NOW + 10 * MINUTE_MS;
          // Ten-minute slots: the turn and each check are 2.5 minutes apart, so the third check
          // lands on the next slot.
          for (let step = 0; step < 4; step++) yield* fireWhenDue(scenario);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(due + 10 * MINUTE_MS));
          yield* fireWhenDue(scenario);
          expect(yield* Ref.get(scenario.peerCalls)).toHaveLength(3);
          const runs = (yield* scenario.service.listRuns({
            id: "scheduled-task:shared" as ScheduledTaskId,
          })).runs;
          expect(runs).toMatchObject([
            {
              outcome: "skipped",
              skipReason: "ran_elsewhere",
              ranOn: OTHER,
              scheduledFor: iso(due),
            },
          ]);
          // The next slot waits its own turn before asking.
          yield* scenario.tick(due + 10 * MINUTE_MS + 6_000);
          yield* scenario.settled;
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(due + 12.5 * MINUTE_MS));
          expect(yield* Queue.size(scenario.launches)).toBe(0);
        }),
      { type: "interval", everyMs: 10 * MINUTE_MS },
    ),
);

it.effect.each([
  { name: "takes over itself when it did not", middleTookIt: false },
  { name: "watches it when it did", middleTookIt: true },
])(
  "a machine further back lets the nearest one take over a run that failed, then $name",
  ({ middleTookIt }) =>
    runScenario(
      [OTHER, MIDDLE, HERE_ENVIRONMENT_ID],
      [WORKING_THERE, NO_RUN_THERE, NO_RUN_THERE],
      (scenario) =>
        Effect.gen(function* () {
          yield* Ref.set(
            scenario.peerCopies,
            new Map(
              middleTookIt
                ? [
                    [OTHER, MIDDLE],
                    [MIDDLE, MIDDLE],
                  ]
                : [[OTHER, OTHER]],
            ),
          );
          yield* Ref.set(scenario.failed, new Set([OTHER]));
          // Two places back: wait its turn, then watch the first machine's run.
          yield* fireWhenDue(scenario);
          yield* fireWhenDue(scenario);
          // That run failed. The middle machine may take over; this one waits a place, then asks.
          yield* fireWhenDue(scenario);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          if (middleTookIt) {
            yield* fireWhenDue(scenario);
            expect(yield* Queue.size(scenario.launches)).toBe(0);
            expect((yield* taskOf(scenario.service))?.lastOneMachineDecision?.ranOn).toBe(MIDDLE);
          } else {
            yield* scenario.tick(Date.parse((yield* nextRunAtOf(scenario.sql))!) + 1_000);
            yield* Queue.take(scenario.launches);
          }
          expect(yield* Ref.get(scenario.peerCalls)).toHaveLength(3);
        }),
    ),
);

it.effect(
  "a machine waiting for a nearer one to take over still gives the occurrence up when the next is due",
  () =>
    runScenario(
      [OTHER, "environment-middle", HERE_ENVIRONMENT_ID],
      [WORKING_THERE, NO_RUN_THERE],
      (scenario) =>
        Effect.gen(function* () {
          const due = NOW + 10 * MINUTE_MS;
          // Ten-minute slots, 2.5 minutes a place: wait two places, watch, see the run fail, then
          // wait one place for the middle machine, which reaches the next slot.
          for (let step = 0; step < 3; step++) yield* fireWhenDue(scenario);
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(due + 10 * MINUTE_MS));
          yield* fireWhenDue(scenario);
          expect(yield* Queue.size(scenario.launches)).toBe(0);
          expect(yield* Ref.get(scenario.peerCalls)).toHaveLength(2);
          const runs = (yield* scenario.service.listRuns({
            id: "scheduled-task:shared" as ScheduledTaskId,
          })).runs;
          expect(runs).toMatchObject([{ outcome: "skipped", scheduledFor: iso(due) }]);
          // The next slot waits its own two places.
          yield* scenario.tick(due + 10 * MINUTE_MS + 6_000);
          yield* scenario.settled;
          expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(due + 15 * MINUTE_MS));
        }),
      { type: "interval", everyMs: 10 * MINUTE_MS },
    ),
);

it.effect("a machine that lost its wait to a restart still asks about the occurrence", () =>
  runScenario([OTHER, HERE_ENVIRONMENT_ID], FINISHED_THERE, (scenario) =>
    Effect.gen(function* () {
      // It was watching, so next_run_at holds a check time 40 minutes after the occurrence.
      const checkAt = DUE + 40 * MINUTE_MS;
      yield* scenario.sql`UPDATE scheduled_tasks SET next_run_at = ${iso(checkAt)}`;
      yield* scenario.tick(checkAt);
      yield* scenario.settled;
      yield* fireWhenDue(scenario);
      expect(yield* Ref.get(scenario.peerCalls)).toEqual([
        { peers: [OTHER], occurrence: iso(DUE), since: iso(DUE - 30 * MINUTE_MS) },
      ]);
      expect(yield* nextRunAtOf(scenario.sql)).toBe(iso(DUE + HOUR_MS));
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
            ScheduledTaskService.CHANGED_IN_APP,
          )).task;
          yield* service.applyShared(copyOf("scheduled-task:copy"));
          yield* service.upsert(
            upsertInput({
              id: "scheduled-task:plain",
              shared: null,
              schedule: { type: "interval", everyMs: HOUR_MS },
            }),
            ScheduledTaskService.CHANGED_IN_APP,
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
            const id = (yield* service.upsert(
              upsertInput({ modelSelection: own }),
              ScheduledTaskService.CHANGED_IN_APP,
            )).task.id;
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
              ScheduledTaskService.CHANGED_IN_APP,
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
            runCondition: { command: "node ~/check.mjs" },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.upsert(
          upsertInput({
            id: "scheduled-task:work-private",
            projectId: repoProject.id,
            shared: { excludedEnvironmentIds: [OTHER], machineOrder: [HERE_ENVIRONMENT_ID] },
          }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.upsert(
          upsertInput({ id: "scheduled-task:local-only", shared: null }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.upsert(
          upsertInput({ id: "scheduled-task:gone" }),
          ScheduledTaskService.CHANGED_IN_APP,
        );
        yield* service.delete({ id: "scheduled-task:gone" as ScheduledTaskId });

        const pulled = yield* service.sharedCopies(OTHER as never, { recordPuller: true });
        expect(pulled.tasks.map((task) => task.id)).toEqual(["scheduled-task:kept"]);
        // The copy's own model, not the scheduled tasks default shown here.
        expect(pulled.tasks[0]?.modelSelection).toEqual(own);
        expect(pulled.tasks[0]?.runCondition).toEqual({
          command: "node ~/check.mjs",
          timeoutSeconds: 60,
        });
        expect(pulled.deletions.map((deletion) => deletion.id)).toEqual(["scheduled-task:gone"]);
        expect(pulled.projectMachineOrders.map((order) => order.project.type)).toEqual(["none"]);
      }),
    [repoProject, plainProject],
    { settings: { scheduledTaskModelSelection: { instanceId: "codex", model: "gpt-5.5" } } },
  ),
);

it.effect("a shared task's group and its group pause travel with its copies", () =>
  withService((service) =>
    Effect.gen(function* () {
      const id = (yield* service.upsert(
        upsertInput({ group: "Machine care" }),
        ScheduledTaskService.CHANGED_IN_APP,
      )).task.id;
      expect(
        yield* service.setGroupPaused(
          { ids: [id], paused: true },
          ScheduledTaskService.CHANGED_IN_APP,
        ),
      ).toEqual({
        ids: [id],
        refused: [],
      });
      expect((yield* taskOf(service))?.shared?.revision.at).toBe("2026-09-09T12:00:00.001Z");
      const [pulled] = (yield* service.sharedCopies(OTHER as never, { recordPuller: false })).tasks;
      expect(pulled).toMatchObject({
        enabled: false,
        group: "Machine care",
        pausedWithGroup: true,
        changedBy: { kind: "ui", threadId: null, at: "2026-09-09T12:00:00.000Z" },
      });

      const applied = (at: string, overrides: Record<string, unknown>) =>
        service.applyShared(copy(at, overrides)).pipe(
          Effect.andThen(taskOf(service)),
          Effect.map((task) => [task?.enabled, task?.group, task?.pausedWithGroup === true]),
        );
      expect(
        yield* applied("2026-09-10T00:00:00.000Z", { enabled: false, group: "Nightly" }),
      ).toEqual([false, "Nightly", false]);
      expect(
        yield* applied("2026-09-10T00:00:01.000Z", {
          enabled: false,
          group: "Nightly",
          pausedWithGroup: true,
        }),
      ).toEqual([false, "Nightly", true]);
      // A copy from a machine without groups keeps the group and pause here.
      expect(yield* applied("2026-09-10T00:00:02.000Z", { enabled: false })).toEqual([
        false,
        "Nightly",
        true,
      ]);
      expect(yield* applied("2026-09-10T00:00:03.000Z", { enabled: true })).toEqual([
        true,
        "Nightly",
        false,
      ]);
      expect(yield* applied("2026-09-10T00:00:04.000Z", { group: null })).toEqual([
        true,
        null,
        false,
      ]);
    }),
  ),
);
