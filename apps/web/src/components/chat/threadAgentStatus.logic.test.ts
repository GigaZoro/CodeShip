import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadAgentStatus,
  waitingOnWorkLabel,
  type ThreadAgentStatusInput,
} from "./threadAgentStatus.logic";

const base: ThreadAgentStatusInput = {
  runtimeStatus: "idle",
  needsUser: false,
  waitingOnWork: false,
  lastErrorClass: null,
  usageLimitResetAt: null,
  activityStartedAt: null,
  latestRun: null,
  providerSubagent: null,
};
const run = { startedAt: "2026-01-01T10:00:00.000Z", completedAt: "2026-01-01T10:12:00.000Z" };

describe("deriveThreadAgentStatus", () => {
  it.each([
    {
      name: "working keeps the activity clock",
      input: { runtimeStatus: "running", activityStartedAt: "2026-01-01T10:05:00.000Z" },
      expected: { kind: "working", activeSince: "2026-01-01T10:05:00.000Z", tookMs: null },
    },
    {
      name: "a pending request means waiting for the user",
      input: { runtimeStatus: "running", needsUser: true, latestRun: run },
      expected: { kind: "waiting", activeSince: run.startedAt, tookMs: null },
    },
    {
      name: "a subagent request holds an idle parent without a clock",
      input: { runtimeStatus: "completed", needsUser: true, latestRun: run },
      expected: { kind: "waiting", activeSince: null, finishedAt: null, tookMs: null },
    },
    {
      name: "a run blocked on another thread waits on it, with the run's clock",
      input: { runtimeStatus: "running", waitingOnWork: true, activityStartedAt: run.startedAt },
      expected: { kind: "waitingOnWork", activeSince: run.startedAt, tookMs: null },
    },
    {
      name: "background work holding a run parked at idle waits on it, not finished",
      input: { runtimeStatus: "idle", waitingOnWork: true, latestRun: run },
      expected: { kind: "waitingOnWork", activeSince: null, finishedAt: null, tookMs: null },
    },
    {
      name: "the user's request outranks the work the agent waits on",
      input: { runtimeStatus: "running", needsUser: true, waitingOnWork: true, latestRun: run },
      expected: { kind: "waiting", activeSince: run.startedAt },
    },
    {
      name: "a waiting run without a request is still working",
      input: { runtimeStatus: "waiting" },
      expected: { kind: "working", activeSince: null },
    },
    {
      name: "preparing reads as starting",
      input: { runtimeStatus: "preparing" },
      expected: { kind: "starting", activeSince: null },
    },
    {
      name: "queued has no clock",
      input: { runtimeStatus: "queued", latestRun: run },
      expected: { kind: "queued", activeSince: null, finishedAt: null, tookMs: null },
    },
    {
      name: "idle reports when the last run ended and how long it took",
      input: { runtimeStatus: "completed", latestRun: run },
      expected: { kind: "idle", finishedAt: run.completedAt, tookMs: 12 * 60_000 },
    },
    {
      name: "idle without a run",
      input: { runtimeStatus: "idle" },
      expected: { kind: "idle", finishedAt: null, tookMs: null },
    },
    {
      name: "interrupted is stopped",
      input: { runtimeStatus: "interrupted", latestRun: run },
      expected: { kind: "stopped", tookMs: 12 * 60_000 },
    },
    {
      name: "a rolled back run is reverted, since its end is when it was undone",
      input: { runtimeStatus: "rolled_back", latestRun: run },
      expected: { kind: "reverted", finishedAt: null, tookMs: null },
    },
    {
      name: "a native subagent working has the clock of its turn",
      input: {
        runtimeStatus: null,
        providerSubagent: { status: "running", startedAt: run.startedAt, completedAt: null },
      },
      expected: { kind: "working", activeSince: run.startedAt },
    },
    {
      name: "a native subagent that finished reports how long its turn took",
      input: { runtimeStatus: null, providerSubagent: { status: "completed", ...run } },
      expected: { kind: "idle", finishedAt: run.completedAt, tookMs: 12 * 60_000 },
    },
    {
      name: "a native subagent that stopped",
      input: { runtimeStatus: null, providerSubagent: { status: "interrupted", ...run } },
      expected: { kind: "stopped", tookMs: 12 * 60_000 },
    },
    {
      name: "failed",
      input: { runtimeStatus: "failed", lastErrorClass: "provider_error", latestRun: run },
      expected: { kind: "failed", resetAt: null },
    },
    {
      name: "usage limit carries the reset time",
      input: {
        runtimeStatus: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: "2026-01-01T15:00:00.000Z",
      },
      expected: { kind: "usageLimit", resetAt: "2026-01-01T15:00:00.000Z" },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    input: Partial<ThreadAgentStatusInput>;
    expected: Record<string, unknown>;
  }>)("$name", ({ input, expected }) => {
    expect(deriveThreadAgentStatus({ ...base, ...input })).toMatchObject(expected);
  });
});

describe("waitingOnWorkLabel", () => {
  const review = { taskId: "review", kind: "subagent" as const, description: "Review the diff" };
  const devServer = { taskId: "dev", kind: "command" as const, description: "pnpm dev" };

  it("names the one task the run waits on, not the dev server it left running", () => {
    expect(waitingOnWorkLabel([devServer, review])).toBe("Review the diff");
  });

  it("counts the tasks when the run waits on several", () => {
    expect(
      waitingOnWorkLabel([devServer, review, { ...review, taskId: "tests", description: "Tests" }]),
    ).toBe("Waiting on 2 subagents");
  });

  it("names nothing when the run waits on none of them", () => {
    expect(waitingOnWorkLabel([devServer])).toBeNull();
  });
});
