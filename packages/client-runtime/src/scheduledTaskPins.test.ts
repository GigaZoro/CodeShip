import { EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectPinnedTasks,
  formatNextRunCountdown,
  intervalWaitProgress,
  resolvePinnedTaskStatus,
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
});
