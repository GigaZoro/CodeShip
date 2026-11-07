import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadStatus.ts";

describe("resolveThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

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
