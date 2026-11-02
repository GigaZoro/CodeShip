import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countProjectThreads,
  resolveProjectThreadState,
  validateProjectsSearch,
} from "./projectsOverview.logic";

describe("resolveProjectThreadState", () => {
  it("sorts threads into what each asks of the user", () => {
    const idle = {
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      interactionMode: "default" as const,
      latestRun: {
        runId: "turn-1" as never,
        status: "completed" as const,
        assistantMessageId: null,
        requestedAt: "2026-03-09T10:00:00.000Z",
        startedAt: "2026-03-09T10:00:00.000Z",
        completedAt: "2026-03-09T10:05:00.000Z",
      },
      lastVisitedAt: "2026-03-09T10:06:00.000Z",
      runtime: null,
    };
    const runtime = {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    };
    const threads = {
      seen: idle,
      unread: { ...idle, lastVisitedAt: "2026-03-09T10:04:00.000Z" },
      working: { ...idle, runtime },
      // Waiting on its own background work, so nothing is asked of the user yet.
      waiting: { ...idle, runtime: { ...runtime, status: "idle" as const } },
      approval: { ...idle, hasPendingApprovals: true },
      failed: { ...idle, runtime: { ...runtime, status: "failed" as const } },
    };

    expect(
      Object.fromEntries(
        Object.entries(threads).map(([name, thread]) => [name, resolveProjectThreadState(thread)]),
      ),
    ).toEqual({
      seen: "quiet",
      unread: "done",
      working: "working",
      waiting: "quiet",
      approval: "attention",
      failed: "attention",
    });
    expect(countProjectThreads(Object.values(threads), resolveProjectThreadState)).toEqual({
      attention: 2,
      working: 1,
      done: 1,
      open: 6,
    });
  });
});

describe("validateProjectsSearch", () => {
  it("keeps a known filter and a real search, and drops anything else", () => {
    expect(validateProjectsSearch({ show: "attention", q: "deploy" })).toEqual({
      show: "attention",
      q: "deploy",
    });
    expect(validateProjectsSearch({ show: "all", q: "   " })).toEqual({});
    expect(validateProjectsSearch({ show: "everything", q: 42 })).toEqual({});
    expect(validateProjectsSearch({ q: "x".repeat(500) }).q).toHaveLength(200);
  });
});
