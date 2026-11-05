import { EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyHeldPinOrder,
  collectPinnedTasks,
  formatNextRunCountdown,
  holdPinOrder,
  intervalWaitProgress,
  pinnedTaskKey,
  resolvePinnedTaskStatus,
  scheduledTasksForThread,
  type HeldPinOrder,
} from "./scheduledTaskPins.ts";

describe("resolvePinnedTaskStatus", () => {
  it.each([
    {
      name: "a dispatch in flight beats the previous run's thread",
      task: { enabled: true, lastRunStatus: "running" as const },
      thread: { status: "failed" as const, runtimeStatus: "failed" },
      expected: "starting",
    },
    {
      name: "a run thread still working",
      task: { enabled: true, lastRunStatus: "succeeded" as const },
      thread: { status: "working" as const, runtimeStatus: "running" },
      expected: "working",
    },
    {
      name: "a run blocked on another thread is still working",
      task: { enabled: true, lastRunStatus: "succeeded" as const },
      thread: { status: "waiting" as const, runtimeStatus: "running" },
      expected: "working",
    },
    {
      name: "a finished turn whose session idles",
      task: { enabled: true, lastRunStatus: "succeeded" as const },
      thread: { status: "waiting" as const, runtimeStatus: "idle" },
      expected: "idle",
    },
    {
      name: "a run waiting on approval",
      task: { enabled: false, lastRunStatus: "succeeded" as const },
      thread: { status: "approval" as const, runtimeStatus: "running" },
      expected: "approval",
    },
    {
      name: "a failed dispatch with no thread",
      task: { enabled: true, lastRunStatus: "failed" as const },
      thread: null,
      expected: "failed",
    },
    {
      name: "a failed run thread",
      task: { enabled: true, lastRunStatus: "succeeded" as const },
      thread: { status: "failed" as const, runtimeStatus: "failed" },
      expected: "failed",
    },
    {
      name: "a paused task between runs",
      task: { enabled: false, lastRunStatus: "succeeded" as const },
      thread: null,
      expected: "paused",
    },
  ])("$name", ({ task, thread, expected }) => {
    expect(resolvePinnedTaskStatus(task, thread)).toBe(expected);
  });
});

describe("formatNextRunCountdown", () => {
  const now = Date.parse("2026-11-02T10:00:00.000Z");
  it.each([
    { at: "2026-11-02T09:59:00.000Z", expected: "due now" },
    { at: "2026-11-02T10:00:00.400Z", expected: "in 0:01" },
    { at: "2026-11-02T10:04:05.000Z", expected: "in 4:05" },
    { at: "2026-11-02T11:00:00.000Z", expected: "in 1h" },
    { at: "2026-11-02T12:30:00.000Z", expected: "in 2h 30m" },
    { at: "2026-11-05T10:00:00.000Z", expected: "in 3d" },
  ])("$at reads $expected", ({ at, expected }) => {
    expect(formatNextRunCountdown(at, now)).toBe(expected);
  });
});

describe("intervalWaitProgress", () => {
  const now = Date.parse("2026-11-02T10:00:00.000Z");
  const every5Min = { type: "interval" as const, everyMs: 300_000 };
  it.each([
    { nextRunAt: "2026-11-02T10:05:00.000Z", expected: 0 },
    { nextRunAt: "2026-11-02T10:01:00.000Z", expected: 0.8 },
    { nextRunAt: "2026-11-02T09:59:00.000Z", expected: 1 },
    // A client clock behind the server's must not draw a negative bar.
    { nextRunAt: "2026-11-02T10:20:00.000Z", expected: 0 },
  ])("is $expected when the next run is at $nextRunAt", ({ nextRunAt, expected }) => {
    expect(intervalWaitProgress({ schedule: every5Min, nextRunAt }, now)).toBeCloseTo(expected);
  });

  it("has no bar for schedules without a fixed interval", () => {
    expect(
      intervalWaitProgress(
        {
          schedule: { type: "fixed_time", timeOfDay: "09:00" },
          nextRunAt: "2026-11-03T09:00:00.000Z",
        },
        now,
      ),
    ).toBeNull();
  });
});

describe("collectPinnedTasks", () => {
  it("lists only pinned tasks across environments, oldest pin first", () => {
    const task = (id: string, pinnedAt: string | null | undefined) =>
      ({ id, pinnedAt }) as unknown as ScheduledTask;
    const laptop = EnvironmentId.make("laptop");
    const server = EnvironmentId.make("server");
    const tasks = new Map([
      [laptop, [task("deploy", "2026-11-02T10:05:00.000Z"), task("lint", null)]],
      [server, [task("ci", "2026-11-02T10:00:00.000Z"), task("legacy", undefined)]],
    ]);

    const pinned = collectPinnedTasks([laptop, server], (id) => tasks.get(id) ?? []);

    expect(pinned.map(({ environmentId, task }) => `${environmentId}:${task.id}`)).toEqual([
      "server:ci",
      "laptop:deploy",
    ]);
  });

  it("puts tasks moved by hand first, in their order, then the rest by pin time", () => {
    const task = (id: string, pinnedAt: string, pinOrderKey: string | null) =>
      ({ id, pinnedAt, pinOrderKey }) as unknown as ScheduledTask;
    const laptop = EnvironmentId.make("laptop");
    const server = EnvironmentId.make("server");
    const tasks = new Map([
      [
        laptop,
        [
          task("deploy", "2026-11-02T10:00:00.000Z", "t"),
          task("new", "2026-11-02T09:00:00.000Z", null),
        ],
      ],
      [
        server,
        [
          task("ci", "2026-11-02T11:00:00.000Z", "m"),
          task("old", "2026-11-02T08:00:00.000Z", null),
        ],
      ],
    ]);

    const pinned = collectPinnedTasks([laptop, server], (id) => tasks.get(id) ?? []);

    expect(pinned.map(pinnedTaskKey)).toEqual([
      "server:ci",
      "laptop:deploy",
      "server:old",
      "laptop:new",
    ]);
  });
});

describe("applyHeldPinOrder", () => {
  const environmentId = EnvironmentId.make("laptop");
  const entry = (
    id: string,
    pinOrderKey: string | null,
    pinnedAt = "2026-11-02T10:00:00.000Z",
  ) => ({
    environmentId,
    task: { id, pinnedAt, pinOrderKey } as unknown as ScheduledTask,
  });
  const order = (pinned: ReadonlyArray<ReturnType<typeof entry>>, held: HeldPinOrder) =>
    applyHeldPinOrder(pinned, held).map(({ task }) => task.id);
  const sent = [entry("a", "c"), entry("b", "m")];
  // The client moved b above a.
  const held = holdPinOrder(sent, null, [{ environmentId, id: sent[1]!.task.id, orderKey: "b" }]);

  it.each([
    { name: "before the server answers", server: sent, expected: ["b", "a"] },
    {
      name: "once the server has the key",
      server: [entry("a", "c"), entry("b", "b")],
      expected: ["b", "a"],
    },
    {
      name: "after another client moves it",
      server: [entry("a", "c"), entry("b", "x")],
      expected: ["a", "b"],
    },
    {
      name: "after it is unpinned and pinned again",
      server: [entry("a", "c"), entry("b", null, "2026-11-03T10:00:00.000Z")],
      expected: ["a", "b"],
    },
  ])("$name", ({ server, expected }) => {
    expect(order(server, held)).toEqual(expected);
  });

  it("keeps an earlier move while a second one is in flight", () => {
    const again = holdPinOrder(sent, held, [
      { environmentId, id: sent[0]!.task.id, orderKey: "an" },
    ]);
    expect(order(sent, again)).toEqual(["a", "b"]);
    // The first move lands before the second.
    expect(order([entry("a", "c"), entry("b", "b")], again)).toEqual(["a", "b"]);
  });
});

describe("scheduledTasksForThread", () => {
  const every = { type: "interval" as const, everyMs: 3_600_000 };
  const once = { type: "once" as const, runAt: "2026-11-03T09:00:00.000Z" };
  it.each([
    {
      name: "a task bound to the thread",
      task: { threadId: "t1", lastRunThreadId: null, schedule: every, nextRunAt: null },
      expected: true,
    },
    {
      name: "a fresh-thread task's latest run",
      task: { threadId: null, lastRunThreadId: "t1", schedule: every, nextRunAt: null },
      expected: true,
    },
    {
      name: "a task rebound elsewhere after running here",
      task: { threadId: "t2", lastRunThreadId: "t1", schedule: every, nextRunAt: null },
      expected: false,
    },
    {
      name: "a one-time task still to run",
      task: { threadId: "t1", schedule: once, nextRunAt: "2026-11-03T09:00:00.000Z" },
      expected: true,
    },
    {
      name: "a one-time task that already ran",
      task: { threadId: null, lastRunThreadId: "t1", schedule: once, nextRunAt: null },
      expected: false,
    },
  ])("$name", ({ task, expected }) => {
    expect(scheduledTasksForThread([task as unknown as ScheduledTask], "t1")).toHaveLength(
      expected ? 1 : 0,
    );
  });
});
