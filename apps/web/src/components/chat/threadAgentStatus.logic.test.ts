import { describe, expect, it } from "vite-plus/test";

import { deriveThreadAgentStatus, type ThreadAgentStatusInput } from "./threadAgentStatus.logic";

const base: ThreadAgentStatusInput = {
  runtimeStatus: "idle",
  needsUser: false,
  lastErrorClass: null,
  usageLimitResetAt: null,
  activityStartedAt: null,
  latestRun: null,
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
