import {
  EnvironmentId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskRunStats,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupScheduledTaskItems,
  scheduledTaskGroupAction,
  scheduledTaskGroupCopy,
  scheduledTaskGroupPausePlan,
  scheduledTaskGroupUpsertField,
  scheduledTaskGroupUsage,
  scheduledTaskStatsRange,
  summarizeScheduledTaskGroup,
} from "./scheduledTaskGroups.ts";
import { groupSharedScheduledTasks } from "./scheduledTaskSharing.ts";

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");

const task = (
  id: string,
  fields: Partial<Pick<ScheduledTask, "group" | "enabled" | "pausedWithGroup" | "nextRunAt">> = {},
) =>
  ({
    id: ScheduledTaskId.make(id),
    group: null,
    enabled: true,
    nextRunAt: null,
    ...fields,
  }) as unknown as ScheduledTask;

const stats = (id: string, group: string | null, runs: number, costUsd: number) =>
  ({
    id: ScheduledTaskId.make(id),
    title: id,
    group,
    runs,
    failed: 1,
    usageLimited: 0,
    costUsd,
    unpricedRuns: 0,
  }) satisfies ScheduledTaskRunStats;

describe("groupScheduledTaskItems", () => {
  it("orders groups by label, matches labels ignoring case and spaces, and lists ungrouped last", () => {
    const sections = groupScheduledTaskItems(
      [
        task("1", { group: "PolyBot delivery" }),
        task("2"),
        task("3", { group: "machine  care" }),
        task("4", { group: "Machine care" }),
      ],
      (item) => item.group,
    );
    expect(
      sections.map((section) => [section.label, section.items.map((item) => item.id)]),
    ).toEqual([
      ["machine  care", ["3", "4"]],
      ["PolyBot delivery", ["1"]],
      [null, ["2"]],
    ]);
  });
});

describe("scheduledTaskGroupAction and scheduledTaskGroupPausePlan", () => {
  it.each([
    {
      name: "a group with a task on pauses the tasks that are on",
      tasks: [task("on"), task("off", { enabled: false })],
      action: "pause",
      plan: [{ environmentId: A, ids: ["on"] }],
    },
    {
      name: "a group its pause turned off resumes only the tasks it marked",
      tasks: [
        task("marked", { enabled: false, pausedWithGroup: true }),
        task("off", { enabled: false }),
        task("on"),
      ],
      action: "resume",
      plan: [{ environmentId: A, ids: ["marked"] }],
    },
    {
      name: "a group of tasks the user turned off has no action",
      tasks: [task("off", { enabled: false })],
      action: null,
      plan: [],
    },
  ])("$name", ({ tasks, action, plan }) => {
    expect(scheduledTaskGroupAction(tasks)).toBe(action);
    expect(
      scheduledTaskGroupPausePlan(
        tasks.map((entry) => ({ environmentId: A, task: entry })),
        action === "pause",
      ),
    ).toEqual(plan);
  });
});

describe("scheduledTaskGroupCopy", () => {
  const copy = (environmentId: EnvironmentId, at: string, group?: string) => ({
    environmentId,
    task: {
      ...task("shared"),
      group,
      shared: { revision: { at, environmentId } },
    } as unknown as ScheduledTask,
  });
  const groupCopyOf = (copies: ReadonlyArray<ReturnType<typeof copy>>) => {
    const [shared] = groupSharedScheduledTasks(
      copies.map(({ environmentId, task }) => ({ environmentId, tasks: [task] })),
    ).shared;
    if (shared === undefined) throw new Error("expected one shared task");
    return scheduledTaskGroupCopy(shared);
  };

  it.each([
    {
      name: "a newest copy from a server without groups",
      copies: [copy(A, "2026-11-12T10:00:00.000Z"), copy(B, "2026-11-12T09:00:00.000Z", "Care")],
    },
    {
      name: "copies at one revision, the one without groups listed first",
      copies: [copy(A, "2026-11-12T09:00:00.000Z"), copy(B, "2026-11-12T09:00:00.000Z", "Care")],
    },
  ])("reads the group from the copy that has it: $name, in either order", ({ copies }) => {
    for (const order of [copies, [...copies].reverse()]) {
      expect(groupCopyOf(order)).toMatchObject({ environmentId: B, task: { group: "Care" } });
    }
  });

  it("keeps the newest copy when its server has groups", () => {
    expect(
      groupCopyOf([
        copy(A, "2026-11-12T08:00:00.000Z", "Old"),
        copy(B, "2026-11-12T09:00:00.000Z", "New"),
      ]),
    ).toMatchObject({ environmentId: B, task: { group: "New" } });
  });
});

describe("scheduledTaskGroupUpsertField", () => {
  it.each([
    {
      name: "sends the trimmed label",
      group: "  Machine care ",
      hadGroup: false,
      expected: { group: "Machine care" },
    },
    {
      name: "clears a stored group with null",
      group: "  ",
      hadGroup: true,
      expected: { group: null },
    },
    { name: "leaves a task that never had one alone", group: "", hadGroup: false, expected: {} },
  ])("$name", ({ group, hadGroup, expected }) => {
    expect(scheduledTaskGroupUpsertField({ supported: true, group, hadGroup })).toEqual(expected);
  });

  it("sends nothing to a server without groups", () => {
    expect(
      scheduledTaskGroupUpsertField({ supported: false, group: "Machine care", hadGroup: true }),
    ).toEqual({});
  });
});

describe("summarizeScheduledTaskGroup", () => {
  it("counts a shared task once, sums every copy's runs and takes the soonest next run of a task that is on", () => {
    const shared = task("shared", { nextRunAt: "2026-11-12T10:00:00.000Z" });
    const summary = summarizeScheduledTaskGroup(
      [
        { environmentId: A, task: shared },
        { environmentId: B, task: shared },
        {
          environmentId: A,
          task: task("off", { enabled: false, nextRunAt: "2026-11-12T09:00:00.000Z" }),
        },
      ],
      (environmentId, id) =>
        id === "shared"
          ? { runs: environmentId === A ? 3 : 2, failed: 1, usageLimited: 1 }
          : undefined,
    );
    expect(summary).toEqual({
      count: 2,
      nextRunAt: "2026-11-12T10:00:00.000Z",
      health: { runs: 5, failed: 2, usageLimited: 2 },
    });
  });
});

describe("scheduledTaskGroupUsage", () => {
  it("sums each group over machines, most spent first, with ungrouped last, counting tasks that ran", () => {
    const rows = scheduledTaskGroupUsage([
      [
        stats("a", "Care", 2, 1),
        { ...stats("idle", "Care", 0, 0), failed: 0 },
        stats("b", null, 9, 9),
        stats("c", "PolyBot", 1, 4),
      ],
      [stats("a", "care", 3, 0.5)],
    ]);
    expect(rows.map((row) => [row.label, row.tasks, row.runs, row.failed, row.costUsd])).toEqual([
      ["PolyBot", 1, 1, 1, 4],
      ["Care", 1, 5, 2, 1.5],
      [null, 1, 9, 1, 9],
    ]);
  });
});

describe("scheduledTaskStatsRange", () => {
  it("passes an hourly window's exact times through", () => {
    expect(
      scheduledTaskStatsRange({
        sinceDay: "2026-11-11",
        untilDay: "2026-11-12",
        timeZone: "Asia/Tokyo",
        sinceTime: "2026-11-11T10:00:00.000Z",
        untilTime: "2026-11-12T10:00:00.000Z",
      }),
    ).toEqual({ since: "2026-11-11T10:00:00.000Z", until: "2026-11-12T10:00:00.000Z" });
  });

  it("spans a day window from midnight of its first day to midnight after its last, in its zone", () => {
    expect(
      scheduledTaskStatsRange({
        sinceDay: "2026-11-10",
        untilDay: "2026-11-12",
        timeZone: "Asia/Tokyo",
      }),
    ).toEqual({ since: "2026-11-09T15:00:00.000Z", until: "2026-11-12T15:00:00.000Z" });
  });

  it("uses each day's own offset across a daylight saving change", () => {
    expect(
      scheduledTaskStatsRange({
        sinceDay: "2026-11-01",
        untilDay: "2026-11-01",
        timeZone: "America/New_York",
      }),
    ).toEqual({ since: "2026-11-01T04:00:00.000Z", until: "2026-11-02T05:00:00.000Z" });
  });
});
