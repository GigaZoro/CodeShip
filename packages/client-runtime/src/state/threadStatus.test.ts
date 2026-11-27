import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isThreadWaitingOnWork,
  matchesThreadListStatus,
  resolveThreadStatus,
  THREAD_STATUS_DISPLAY,
  THREAD_STATUS_TONE_SALIENCE,
  type ThreadStatusDisplayKey,
  type ThreadStatusSalience,
} from "./threadStatus.ts";

describe("THREAD_STATUS_TONE_SALIENCE", () => {
  it("colours only what needs the user: amber for its asks, red for failures, grey for the rest", () => {
    const expected: Record<ThreadStatusDisplayKey, ThreadStatusSalience> = {
      approval: "attention",
      input: "attention",
      request: "attention",
      limited: "attention",
      woke: "attention",
      failed: "alarm",
      starting: "calm",
      working: "calm",
      goal: "calm",
      waiting: "calm",
      paused: "calm",
      plan: "calm",
      done: "calm",
    };
    const actual = Object.fromEntries(
      Object.entries(THREAD_STATUS_DISPLAY).map(([key, display]) => [
        key,
        THREAD_STATUS_TONE_SALIENCE[display.tone],
      ]),
    );
    expect(actual).toEqual(expected);
  });
});

describe("resolveThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    latestRun: null,
  };

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(
      resolveThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        runtime,
        blockedOnThreadWait: true,
      }),
    ).toBe("input");
    expect(
      resolveThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        blockedOnThreadWait: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("shows a waiting guest message as a Request, below the agent's own requests", () => {
    expect(resolveThreadStatus({ ...idle, pendingGuestMessageCount: 1, runtime })).toBe("request");
    expect(
      resolveThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        pendingGuestMessageCount: 1,
      }),
    ).toBe("input");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(resolveThreadStatus({ ...idle, runtime: { ...limited, status: "running" } })).toBe(
      "working",
    );
    expect(resolveThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } })).toBe(
      "ready",
    );
  });

  it("reports failed only while the latest run failed", () => {
    const agentStarted = {
      ...idle,
      createdBy: "agent",
      latestRun: { status: "failed" as const, completedAt: "2026-03-09T10:00:00.000Z" },
      lastVisitedAt: "2026-03-09T09:00:00.000Z",
    };
    expect(resolveThreadStatus(agentStarted)).toBe("failed");
    expect(matchesThreadListStatus(agentStarted, "failed")).toBe(true);
    expect(matchesThreadListStatus(agentStarted, "unread")).toBe(false);
    expect(
      resolveThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });
});

describe("isThreadWaitingOnWork", () => {
  const running = { status: "running" as const };

  it("waits on another thread only while the run is going", () => {
    expect(isThreadWaitingOnWork({ runtime: running, blockedOnThreadWait: true })).toBe(true);
    expect(isThreadWaitingOnWork({ runtime: running, blockedOnThreadWait: false })).toBe(false);
    expect(
      isThreadWaitingOnWork({ runtime: { status: "completed" }, blockedOnThreadWait: true }),
    ).toBe(false);
  });

  it("waits on background work that holds a run that has not failed, not on work left running", () => {
    expect(
      isThreadWaitingOnWork({
        runtime: { status: "idle" },
        pendingBackgroundTasks: [{ kind: "command", awaited: true }],
      }),
    ).toBe(true);
    expect(
      isThreadWaitingOnWork({
        runtime: { status: "idle" },
        pendingBackgroundTasks: [{ kind: "command" }],
      }),
    ).toBe(false);
    expect(
      isThreadWaitingOnWork({
        runtime: { status: "failed" },
        pendingBackgroundTasks: [{ kind: "monitor", awaited: true }],
      }),
    ).toBe(false);
    expect(isThreadWaitingOnWork({ runtime: null })).toBe(false);
  });
});
