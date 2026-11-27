import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectNeedsYouThreads } from "./threadInbox.ts";
import {
  collectFinishedNotSeen,
  countNeedsYouBadge,
  createPresenceTracker,
  summarizeWhileAway,
  WHILE_AWAY_MIN_MS,
} from "./needsYouTriage.ts";

const environmentId = EnvironmentId.make("environment-1");
const now = "2026-06-01T12:00:00.000Z";

function shell(
  id: string,
  options: {
    readonly createdBy?: "user" | "agent" | "system";
    readonly run?: "completed" | "failed";
    readonly completedAt?: string;
    readonly lastVisitedAt?: string | null;
    readonly runId?: string;
    readonly requestedAt?: string;
  } = {},
) {
  const completedAt = options.completedAt ?? "2026-06-01T10:00:00.000Z";
  const failed = options.run === "failed";
  return {
    id: ThreadId.make(id),
    environmentId,
    createdBy: options.createdBy ?? ("user" as "user" | "agent" | "system"),
    archivedAt: null as string | null,
    deletedAt: null as string | null,
    updatedAt: completedAt,
    settledOverride: null as "settled" | "active" | null,
    snoozedAt: null as string | null,
    snoozedUntil: null as string | null,
    laterAt: null as string | null,
    limitRecovery: null as {
      readonly runId: RunId;
      readonly resetAt: string;
      readonly autoResume: boolean;
    } | null,
    notificationLevel: undefined,
    lastVisitedAt:
      options.lastVisitedAt === undefined ? "2026-06-01T09:00:00.000Z" : options.lastVisitedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    blockedOnThreadWait: false,
    source: { pendingRuntimeRequest: null },
    latestRun: {
      runId: RunId.make(options.runId ?? `${id}-run`),
      status: failed ? ("failed" as const) : ("completed" as const),
      requestedAt: options.requestedAt ?? "2026-06-01T08:00:00.000Z",
      startedAt: options.requestedAt ?? "2026-06-01T08:00:00.000Z",
      completedAt,
      assistantMessageId: null,
    },
    runtime: failed
      ? {
          status: "failed" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: "boom",
          lastErrorClass: null,
          updatedAt: completedAt,
        }
      : null,
  };
}

describe("countNeedsYouBadge", () => {
  it("never counts failed scheduled or agent-started runs, nor finished results", () => {
    const threads = [
      shell("user-failed", { run: "failed" }),
      shell("scheduled-failed", { run: "failed", createdBy: "agent" }),
      shell("system-failed", { run: "failed", createdBy: "system" }),
      shell("finished-unseen"),
    ];
    const needsYou = collectNeedsYouThreads(threads, { now });
    expect(countNeedsYouBadge(needsYou.threads)).toBe(1);
    expect(needsYou.threads.map((thread) => thread.id)).toEqual(["user-failed"]);
    expect(collectFinishedNotSeen(threads, { now }).map((thread) => thread.id)).toEqual([
      "finished-unseen",
    ]);
  });
});

describe("collectFinishedNotSeen", () => {
  it("lists the user's threads that finished after their last visit, newest first", () => {
    const older = shell("older", { completedAt: "2026-06-01T10:00:00.000Z" });
    const newer = shell("newer", { completedAt: "2026-06-01T11:00:00.000Z" });
    const seen = shell("seen", { lastVisitedAt: "2026-06-01T11:30:00.000Z" });
    const agent = shell("agent", { createdBy: "agent" });
    const failed = shell("failed", { run: "failed" });
    const settled = { ...shell("settled"), settledOverride: "settled" as const };
    const archived = { ...shell("archived"), archivedAt: "2026-06-01T11:00:00.000Z" };
    const snoozed = {
      ...shell("snoozed"),
      snoozedAt: "2026-06-01T11:00:00.000Z",
      snoozedUntil: "2026-06-01T13:00:00.000Z",
    };
    expect(
      collectFinishedNotSeen([older, seen, agent, failed, settled, archived, snoozed, newer], {
        now,
      }).map((thread) => thread.id),
    ).toEqual(["newer", "older"]);
  });

  it("falls back to the client's own visits on servers that do not record them", () => {
    const legacy = { ...shell("legacy"), lastVisitedAt: undefined };
    expect(collectFinishedNotSeen([legacy], { now })).toEqual([]);
    expect(collectFinishedNotSeen([legacy], { now, locallyUnread: () => true })).toEqual([legacy]);
  });
});

describe("summarizeWhileAway", () => {
  it("counts what is blocked, what finished, and what recovered by itself since the user left", () => {
    const awaySince = Date.parse("2026-06-01T09:30:00.000Z");
    const blocked = shell("blocked", { run: "failed" });
    const finishedAway = shell("finished-away", { completedAt: "2026-06-01T10:00:00.000Z" });
    const finishedBefore = {
      ...shell("finished-before", { completedAt: "2026-06-01T09:15:00.000Z" }),
      lastVisitedAt: "2026-06-01T09:00:00.000Z",
    };
    // Hit a limit before the user left, then continued by itself and finished.
    const recovered = {
      ...shell("recovered", {
        runId: "continuation",
        requestedAt: "2026-06-01T10:30:00.000Z",
        completedAt: "2026-06-01T11:00:00.000Z",
      }),
      limitRecovery: {
        runId: RunId.make("limited"),
        resetAt: "2026-06-01T10:30:00.000Z",
        autoResume: true,
      },
    };
    const stillLimited = {
      ...shell("still-limited", { runId: "limited-2", lastVisitedAt: "2026-06-01T11:30:00.000Z" }),
      limitRecovery: {
        runId: RunId.make("limited-2"),
        resetAt: "2026-06-01T13:00:00.000Z",
        autoResume: true,
      },
    };
    const threads = [blocked, finishedAway, finishedBefore, recovered, stillLimited];
    const needsYou = collectNeedsYouThreads(threads, { now });
    expect(
      summarizeWhileAway({
        threads,
        needsYou: needsYou.threads,
        finishedNotSeen: collectFinishedNotSeen(threads, { now }),
        awaySince,
      }),
    ).toEqual({ blocked: 1, finished: 1, recovered: 1 });
  });
});

describe("createPresenceTracker", () => {
  function tracker(stored: number | null) {
    let clock = 0;
    const saved: number[] = [];
    const presence = createPresenceTracker({
      now: () => clock,
      load: () => stored,
      save: (at) => saved.push(at),
    });
    return {
      presence,
      saved,
      at: (ms: number) => {
        clock = ms;
      },
    };
  }

  it("starts the strip on the first presence after at least 15 minutes away", () => {
    const { presence, at } = tracker(null);
    at(1_000);
    presence.present();
    expect(presence.getAwaySince()).toBeNull();
    at(2_000);
    presence.left();
    at(2_000 + WHILE_AWAY_MIN_MS - 1);
    presence.present();
    expect(presence.getAwaySince()).toBeNull();
    at(2_000 + 2 * WHILE_AWAY_MIN_MS);
    presence.present();
    expect(presence.getAwaySince()).toBe(2_000 + WHILE_AWAY_MIN_MS - 1);
  });

  it("measures from the stored presence across restarts, and caught up clears it", () => {
    const { presence, at, saved } = tracker(5_000);
    let changes = 0;
    presence.subscribe(() => changes++);
    at(5_000 + WHILE_AWAY_MIN_MS);
    presence.present();
    expect(presence.getAwaySince()).toBe(5_000);
    presence.caughtUp();
    expect([presence.getAwaySince(), changes]).toEqual([null, 2]);
    expect(saved).toEqual([5_000 + WHILE_AWAY_MIN_MS]);
  });
});
