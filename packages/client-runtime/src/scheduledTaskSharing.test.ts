import {
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskRunRecord,
  type ScheduledTaskProjectMachineOrder,
  type ScheduledTaskSharedRevision,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createSharedScheduledTaskSync,
  groupSharedScheduledTasks,
  mergeScheduledTaskRuns,
  planSharedScheduledTaskSync,
  sharedProjectReference,
  sharedSyncFailureKey,
  sharedUpsertField,
  describeOneMachineLinkWarning,
  effectiveOneMachineOrder,
  oneMachineLinkWarnings,
  mergeMachineOrder,
  moveMachine,
  visibleMachineOrder,
  toggleSharedExclusion,
  type SharedScheduledTaskOp,
  type SharedScheduledTaskSnapshot,
} from "./scheduledTaskSharing.ts";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");
const C = EnvironmentId.make("env-c");
const ID = ScheduledTaskId.make("task-1");

const rev = (at: string, environmentId = A): ScheduledTaskSharedRevision => ({
  at: `2026-11-0${at}T00:00:00.000Z`,
  environmentId,
});

const shared = (
  at: string,
  options: { title?: string; excluded?: ReadonlyArray<EnvironmentId>; by?: EnvironmentId } = {},
) =>
  ({
    id: ID,
    title: options.title ?? "t",
    shared: {
      revision: rev(at, options.by),
      project: { type: "none" },
      excludedEnvironmentIds: options.excluded ?? [],
    },
  }) as unknown as ScheduledTask;

const local = () => ({ id: ID, title: "local", shared: null }) as unknown as ScheduledTask;

const snap = (
  environmentId: EnvironmentId,
  tasks: ReadonlyArray<ScheduledTask> = [],
  deletedAt: ReadonlyArray<string> = [],
  orders: ReadonlyArray<ScheduledTaskProjectMachineOrder> = [],
): SharedScheduledTaskSnapshot => ({
  environmentId,
  tasks,
  projectMachineOrders: orders,
  sharedDeletions: deletedAt.map((at) => ({ id: ID, revision: rev(at) })),
});

const summary = (ops: ReadonlyArray<SharedScheduledTaskOp>) =>
  ops.map((op) => `${op.environmentId}:${op.input.type}`);

describe("planSharedScheduledTaskSync", () => {
  it.each([
    {
      name: "a new shared task is created on machines without it",
      snapshots: [snap(A, [shared("1")]), snap(B), snap(C)],
      expected: ["env-b:upsert", "env-c:upsert"],
    },
    {
      name: "a newer edit wins over older copies",
      snapshots: [snap(A, [shared("1")]), snap(B, [shared("2", { title: "new" })])],
      expected: ["env-a:upsert"],
    },
    {
      name: "equal revisions change nothing",
      snapshots: [snap(A, [shared("1")]), snap(B, [shared("1")])],
      expected: [],
    },
    {
      name: "a deletion spreads, including to machines that never had the task",
      snapshots: [snap(A, [], ["2"]), snap(B, [shared("1")]), snap(C)],
      expected: ["env-b:delete", "env-c:delete"],
    },
    {
      name: "a newer deletion beats an older copy",
      snapshots: [snap(A, [shared("1")]), snap(B, [], ["2"])],
      expected: ["env-a:delete"],
    },
    {
      name: "a newer copy beats an older deletion",
      snapshots: [snap(A, [shared("3")]), snap(B, [], ["2"])],
      expected: ["env-b:upsert"],
    },
    {
      name: "an excluded machine with a copy gets an upsert so it drops it",
      snapshots: [snap(A, [shared("2", { excluded: [B] })]), snap(B, [shared("1")])],
      expected: ["env-b:upsert"],
    },
    {
      name: "an excluded machine without a copy gets nothing",
      snapshots: [snap(A, [shared("2", { excluded: [B] })]), snap(B)],
      expected: [],
    },
    {
      name: "a local task that is not shared owns the id",
      snapshots: [snap(A, [shared("1")]), snap(B, [local()])],
      expected: [],
    },
    {
      name: "a single snapshot plans nothing",
      snapshots: [snap(A, [shared("1")])],
      expected: [],
    },
  ])("$name", ({ snapshots, expected }) => {
    expect(summary(planSharedScheduledTaskSync(snapshots))).toEqual(expected);
  });

  it("keys an op by environment, task and winning revision", () => {
    const [op] = planSharedScheduledTaskSync([snap(A, [shared("1")]), snap(B)]);
    expect(op?.key).toBe(`env-b:task-1:${rev("1").at}:env-a`);
  });
});

const order = (
  at: string,
  ids: ReadonlyArray<EnvironmentId>,
): ScheduledTaskProjectMachineOrder => ({
  project: { type: "none" },
  order: ids,
  revision: rev(at),
});

describe("project machine orders", () => {
  it.each([
    {
      name: "a newer order reaches a machine holding a task of the project",
      snapshots: [snap(A, [shared("1")], [], [order("2", [B, A])]), snap(B, [shared("1")])],
      expected: ["env-b:projectMachineOrder"],
    },
    {
      name: "an older order on another machine is replaced",
      snapshots: [snap(A, [], [], [order("2", [B, A])]), snap(B, [], [], [order("1", [A, B])])],
      expected: ["env-b:projectMachineOrder"],
    },
    {
      name: "a machine with no task of the project and no order is left out",
      snapshots: [snap(A, [], [], [order("2", [B, A])]), snap(B)],
      expected: [],
    },
    {
      name: "equal orders change nothing",
      snapshots: [snap(A, [], [], [order("2", [A])]), snap(B, [], [], [order("2", [A])])],
      expected: [],
    },
  ])("$name", ({ snapshots, expected }) => {
    const ops = planSharedScheduledTaskSync(snapshots).filter(
      (op) => op.input.type === "projectMachineOrder",
    );
    expect(summary(ops)).toEqual(expected);
  });

  it("keys an order op by environment, project and revision", () => {
    const [op] = planSharedScheduledTaskSync([
      snap(A, [], [], [order("2", [A])]),
      snap(B, [], [], [order("1", [B])]),
    ]);
    expect(op?.key).toBe(`env-b:order:none:${rev("2").at}:env-a`);
  });
});

describe("createSharedScheduledTaskSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const snapshots = [snap(A, [shared("1")]), snap(B)];
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("records a failure and does not retry it before retryAfterMs", async () => {
    const apply = vi.fn(async (_op: SharedScheduledTaskOp) => ({
      ok: false as const,
      error: "no project",
    }));
    const sync = createSharedScheduledTaskSync({ apply, retryAfterMs: 1000 });
    sync.update(snapshots);
    await flush();
    expect(sync.failures().get(sharedSyncFailureKey(B, ID))?.error).toBe("no project");

    sync.update(snapshots);
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(apply).toHaveBeenCalledTimes(2);
    sync.dispose();
  });

  it("clears the failure once the op succeeds", async () => {
    let ok = false;
    const apply = vi.fn(async (_op: SharedScheduledTaskOp) =>
      ok ? { ok: true as const } : { ok: false as const, error: "down" },
    );
    const sync = createSharedScheduledTaskSync({ apply, retryAfterMs: 1000 });
    sync.update(snapshots);
    await flush();
    ok = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.failures().size).toBe(0);
    sync.dispose();
  });

  it("does not start an op that is already in flight", async () => {
    const apply = vi.fn((_op: SharedScheduledTaskOp) => new Promise<{ ok: true }>(() => {}));
    const sync = createSharedScheduledTaskSync({ apply });
    sync.update(snapshots);
    sync.update(snapshots);
    expect(apply).toHaveBeenCalledTimes(1);
    sync.dispose();
  });
});

describe("shared editor helpers", () => {
  it.each([
    { supported: false, shared: true, wasShared: true, expected: {} },
    {
      supported: true,
      shared: true,
      wasShared: false,
      expected: { shared: { excludedEnvironmentIds: [C] } },
    },
    { supported: true, shared: false, wasShared: true, expected: { shared: null } },
    { supported: true, shared: false, wasShared: false, expected: {} },
  ])("sharedUpsertField %#", ({ expected, ...options }) => {
    expect(sharedUpsertField({ ...options, excludedEnvironmentIds: [C] })).toEqual(expected);
  });

  it("toggleSharedExclusion keeps exclusions of other machines", () => {
    expect(toggleSharedExclusion([C], B, false)).toEqual([C, B]);
    expect(toggleSharedExclusion([C, B], B, true)).toEqual([C]);
  });
});

describe("machine order helpers", () => {
  it("lists machines in order, then those the order lacks", () => {
    expect(visibleMachineOrder([C, A], [A, B, C])).toEqual([C, A, B]);
  });

  it("moves a machine and stops at the ends", () => {
    expect(moveMachine([A, B, C], B, -1)).toEqual([B, A, C]);
    expect(moveMachine([A, B, C], A, -1)).toEqual([A, B, C]);
  });

  it("keeps stored machines that are not shown", () => {
    expect(mergeMachineOrder([B, A], [A, C])).toEqual([B, A, C]);
  });
});

describe("sharedProjectReference", () => {
  const repo = {
    id: "p1",
    title: "PolyBot",
    repositoryIdentity: { canonicalKey: "github.com/acme/app" },
  };
  it.each([
    {
      name: "No project",
      project: { id: "s", title: "No project", isScratch: true },
      expected: { type: "none" },
    },
    {
      name: "a project with a repository",
      project: repo,
      expected: { type: "repository", canonicalKey: "github.com/acme/app", title: "PolyBot" },
    },
    // A project whose identity has not loaded must not read or seed another project's order.
    {
      name: "an unloaded repository identity",
      project: { id: "p2", title: "App" },
      expected: null,
    },
  ])("resolves $name", ({ project, expected }) => {
    expect(
      sharedProjectReference({ editedShared: undefined, editedProjectId: undefined, project }),
    ).toEqual(expected);
  });

  it("keeps the stored reference while the edited task stays in its project", () => {
    const editedShared = shared("1").shared;
    expect(
      sharedProjectReference({
        editedShared,
        editedProjectId: "p2",
        project: { id: "p2", title: "App" },
      }),
    ).toEqual(editedShared?.project);
  });
});

describe("one-machine link warnings", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z");
  const links = (
    enabled: boolean,
    entries: ReadonlyArray<[EnvironmentId, string]> = [],
  ): NonNullable<SharedScheduledTaskSnapshot["peerLinks"]> => ({
    enabled,
    links: entries.map(([environmentId, expiresAt]) => ({ environmentId, expiresAt })),
  });
  const FUTURE = "2026-12-01T00:00:00.000Z";
  const withLinks = (
    environmentId: EnvironmentId,
    peerLinks: NonNullable<SharedScheduledTaskSnapshot["peerLinks"]>,
  ): SharedScheduledTaskSnapshot => ({ ...snap(environmentId), peerLinks });

  it.each([
    {
      name: "a linked pair has no warning",
      snapshots: [withLinks(A, links(true)), withLinks(B, links(true, [[A, FUTURE]]))],
      expected: [],
    },
    {
      name: "the fallback machine has links off",
      snapshots: [withLinks(A, links(true)), withLinks(B, links(false, [[A, FUTURE]]))],
      expected: ["checkerLinksOff:env-b:env-a"],
    },
    {
      name: "the fallback machine has no link",
      snapshots: [withLinks(A, links(true)), withLinks(B, links(true))],
      expected: ["noLink:env-b:env-a"],
    },
    {
      name: "the link has expired",
      snapshots: [
        withLinks(A, links(true)),
        withLinks(B, links(true, [[A, "2026-11-01T00:00:00.000Z"]])),
      ],
      expected: ["expired:env-b:env-a"],
    },
    {
      name: "the machine ahead has links off",
      snapshots: [withLinks(A, links(false)), withLinks(B, links(true, [[A, FUTURE]]))],
      expected: ["targetLinksOff:env-b:env-a"],
    },
    {
      name: "an unloaded fallback machine gives no warning",
      snapshots: [withLinks(A, links(true))],
      expected: [],
    },
    {
      name: "a server without link data gives no warning",
      snapshots: [snap(A), snap(B)],
      expected: [],
    },
  ])("$name", ({ snapshots, expected }) => {
    const warnings = oneMachineLinkWarnings(snapshots, [A, B], NOW);
    expect(warnings.map((w) => `${w.kind}:${w.checker}:${w.target}`)).toEqual(expected);
  });

  it("checks every machine ahead of a later fallback", () => {
    const warnings = oneMachineLinkWarnings(
      [withLinks(A, links(true)), withLinks(B, links(true)), withLinks(C, links(true))],
      [A, B, C],
      NOW,
    );
    expect(warnings).toHaveLength(3);
  });

  it("drops exclusions and appends machines the order lacks", () => {
    expect(effectiveOneMachineOrder([C, A], [A], [A, B, C])).toEqual([C, B]);
  });

  it("words a warning with the machine labels", () => {
    expect(
      describeOneMachineLinkWarning({ kind: "noLink", checker: B, target: A }, (id) => id),
    ).toBe("env-b has no link to env-a. Link it in Settings → Machines & access on env-b.");
  });
});

describe("groupSharedScheduledTasks", () => {
  it("lists a shared task once with every copy, led by the newest, and keeps local tasks", () => {
    const onlyA = { id: ScheduledTaskId.make("only-a"), shared: null } as unknown as ScheduledTask;
    const { shared: groups, local: lists } = groupSharedScheduledTasks([
      { environmentId: A, tasks: [shared("1"), onlyA] },
      { environmentId: B, tasks: [shared("2", { title: "new", by: B })] },
      { environmentId: C, tasks: [local()] },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.primary).toMatchObject({ environmentId: B, task: { title: "new" } });
    expect(groups[0]?.copies.map((copy) => copy.environmentId)).toEqual([A, B]);
    expect(lists.map((list) => [list.environmentId, list.tasks.map((task) => task.title)])).toEqual(
      [
        [A, [undefined]],
        [B, []],
        [C, ["local"]],
      ],
    );
  });
});

describe("mergeScheduledTaskRuns", () => {
  const run = (
    id: string,
    startedAt: string,
    fields: Partial<ScheduledTaskRunRecord> = {},
  ): ScheduledTaskRunRecord => ({
    id,
    trigger: "scheduled",
    scheduledFor: null,
    startedAt: `2026-11-07T${startedAt}:00.000Z`,
    completedAt: null,
    outcome: "succeeded",
    threadId: null,
    error: null,
    skipReason: null,
    ranOn: null,
    failover: null,
    ...fields,
  });

  it("orders every machine's runs newest first and drops skips another machine's run covers", () => {
    const nine = "2026-11-07T09:00:00.000Z";
    const ten = "2026-11-07T10:00:00.000Z";
    const merged = mergeScheduledTaskRuns([
      {
        environmentId: A,
        runs: [run("a-10", "10:00", { scheduledFor: ten }), run("a-manual", "08:30")],
      },
      {
        environmentId: B,
        runs: [
          run("b-10", "10:00", {
            scheduledFor: ten,
            outcome: "skipped",
            skipReason: "ran_elsewhere",
            ranOn: A,
          }),
          run("b-9", "09:00", {
            scheduledFor: nine,
            outcome: "skipped",
            skipReason: "ran_elsewhere",
            ranOn: C,
          }),
          run("b-missed", "09:30", {
            scheduledFor: nine,
            outcome: "skipped",
            skipReason: "missed",
          }),
        ],
      },
    ]);

    expect(merged.map(({ environmentId, run }) => `${environmentId}:${run.id}`)).toEqual([
      "env-a:a-10",
      "env-b:b-missed",
      "env-b:b-9",
      "env-a:a-manual",
    ]);
  });
});
