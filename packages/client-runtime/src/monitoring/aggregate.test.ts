import {
  EnvironmentId,
  MONITORING_FIX_CHAT_MAX_CHATS,
  type MonitoringFinding,
  type MonitoringThreadSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  breakdownByModel,
  dailyTrend,
  dayKey,
  filterChats,
  fixChatInput,
  fixChatTarget,
  median,
  mergeMonitoringOverviews,
  monitoringWindowStart,
  monitoringChatKey,
  outliers,
  percentile,
  phaseTotals,
  rankFindings,
  settleFixChat,
  sortChats,
  sumTimeBuckets,
  totalsOf,
  TIME_BUCKET_KEYS,
  type MonitoringChat,
  type MonitoringEnvironmentReport,
} from "./aggregate.ts";

const zeroTime = {
  agentMs: 0,
  commandMs: 0,
  toolMs: 0,
  approvalMs: 0,
  queuedMs: 0,
  usageLimitMs: 0,
  delegateWaitMs: 0,
  userResponseMs: 0,
  idleMs: 0,
  settleTailMs: 0,
};

function chat(
  id: string,
  overrides: Partial<Omit<MonitoringThreadSummary, "threadId">> = {},
  environmentId = "env-a",
): MonitoringChat {
  const summary = {
    threadId: id,
    projectId: "p1",
    title: id,
    kind: "interactive",
    providerInstanceId: "claude",
    models: ["opus"],
    helperModels: [],
    createdAt: "2026-11-10T10:00:00.000Z",
    settledAt: "2026-11-10T12:00:00.000Z",
    lifetimeMs: 1000,
    activeMs: 400,
    time: { ...zeroTime, agentMs: 400, userResponseMs: 600 },
    runs: {
      total: 2,
      completed: 1,
      failed: 1,
      interrupted: 0,
      cancelled: 0,
      userPrompts: 1,
      automatic: 1,
      retries: 0,
      steeringRestarts: 0,
      providerRecoveries: 0,
    },
    errors: {},
    tokens: {
      inputTokens: 100,
      cachedInputTokens: 25,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    },
    costUsd: 1,
    unpricedTurns: 0,
    peakContextRatio: null,
    compactions: 0,
    handoffs: 0,
    helpers: { subagents: 1, delegates: 0, commands: 1, workflows: 0, failed: 0 },
    commands: { count: 0, failed: 0, durationMs: 0 },
    phases: [],
    filesChanged: 0,
    reopens: 0,
    findings: [],
    ...overrides,
  } as unknown as MonitoringThreadSummary;
  return { environmentId, summary };
}

describe("percentile", () => {
  it("interpolates between neighbours and handles empty and single inputs", () => {
    expect(median([])).toBe(0);
    expect(median([7])).toBe(7);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(percentile([1, 2], 2)).toBe(2);
  });
});

describe("totalsOf and sumTimeBuckets", () => {
  const chats = [
    chat("a", { lifetimeMs: 1000, activeMs: 400 }),
    chat("b", {
      lifetimeMs: 3000,
      activeMs: 1000,
      time: { ...zeroTime, commandMs: 1000, idleMs: 2000 },
      costUsd: 2,
    }),
  ];

  it("sums buckets so they still add up to the summed lifetime", () => {
    const buckets = sumTimeBuckets(chats);
    expect(buckets.agentMs).toBe(400);
    expect(buckets.commandMs).toBe(1000);
    expect(TIME_BUCKET_KEYS.reduce((total, key) => total + buckets[key], 0)).toBe(4000);
  });

  it("derives shares, cache reuse and counts", () => {
    const totals = totalsOf(chats);
    expect(totals.chats).toBe(2);
    expect(totals.medianLifetimeMs).toBe(2000);
    expect(totals.workingMs).toBe(1400);
    expect(totals.workingShare).toBeCloseTo(0.35);
    expect(totals.costUsd).toBe(3);
    expect(totals.cacheReuse).toBe(0.25);
    expect(totals.failedRuns).toBe(2);
    expect(totals.helpers).toBe(4);
  });

  it("has no cache reuse or share without data", () => {
    const totals = totalsOf([]);
    expect(totals.cacheReuse).toBeNull();
    expect(totals.workingShare).toBe(0);
  });
});

describe("rankFindings", () => {
  it("merges per code across chats and ranks by time lost, keeping the worst severity", () => {
    const ranks = rankFindings([
      chat("a", {
        findings: [
          { code: "retries", severity: "low", wastedMs: 100, count: 1, detail: null },
          { code: "usage_limit", severity: "medium", wastedMs: 5000, count: 1, detail: null },
        ],
      }),
      chat("b", {
        findings: [{ code: "retries", severity: "high", wastedMs: 200, count: 2, detail: null }],
      }),
      chat("c", {
        findings: [{ code: "many_prompts", severity: "low", wastedMs: 0, count: 7, detail: null }],
      }),
    ]);
    expect(ranks.map((rank) => rank.code)).toEqual(["usage_limit", "retries", "many_prompts"]);
    const retries = ranks[1]!;
    expect(retries).toMatchObject({ chats: 2, occurrences: 3, wastedMs: 300, severity: "high" });
    expect(retries.chatKeys).toEqual(["env-a:a", "env-a:b"]);
  });

  it("keeps the same thread id in two environments apart", () => {
    const finding = {
      code: "retries",
      severity: "low",
      wastedMs: 1,
      count: 1,
      detail: null,
    } as const;
    const [rank] = rankFindings([
      chat("a", { findings: [finding] }, "env-a"),
      chat("a", { findings: [finding] }, "env-b"),
    ]);
    expect(rank!.chats).toBe(2);
  });
});

describe("fixChatTarget", () => {
  const slow = (wastedMs: number): MonitoringFinding => ({
    code: "slow_command",
    severity: "high",
    wastedMs,
    count: 1,
    detail: null,
  });

  it("picks the environment and project that lost the most time and lists chats worst first", () => {
    const target = fixChatTarget(
      [
        chat("a", { findings: [slow(100)] }, "env-a"),
        chat("b", { projectId: "p2", findings: [slow(300)] }, "env-b"),
        chat("c", { projectId: "p2", findings: [slow(150)] }, "env-b"),
        chat("d", { findings: [slow(400)] }, "env-b"),
        chat("e", { projectId: "p3", findings: [] }, "env-b"),
      ],
      "slow_command",
    );
    expect(target).toEqual({ environmentId: "env-b", projectId: "p2", threadIds: ["d", "b", "c"] });
  });

  it("caps the chats a fix chat reads", () => {
    const chats = Array.from({ length: MONITORING_FIX_CHAT_MAX_CHATS + 5 }, (_, index) =>
      chat(`t${index}`, { findings: [slow(index)] }),
    );
    const target = fixChatTarget(chats, "slow_command");
    expect(target?.threadIds).toHaveLength(MONITORING_FIX_CHAT_MAX_CHATS);
    expect(target?.threadIds[0]).toBe(`t${MONITORING_FIX_CHAT_MAX_CHATS + 4}`);
  });

  it("picks the project over every chat with the weak point, not only the chats it reads", () => {
    const worst = Array.from({ length: MONITORING_FIX_CHAT_MAX_CHATS }, (_, index) =>
      chat(`w${index}`, { projectId: "p2", findings: [slow(100)] }),
    );
    const rest = Array.from({ length: MONITORING_FIX_CHAT_MAX_CHATS + 1 }, (_, index) =>
      chat(`r${index}`, { findings: [slow(99)] }),
    );
    expect(fixChatTarget([...worst, ...rest], "slow_command")?.projectId).toBe("p1");
  });

  it("is null when no chat has the weak point", () => {
    expect(fixChatTarget([chat("a", { findings: [slow(1)] })], "retries")).toBeNull();
  });
});

describe("fixChatInput", () => {
  const target = {
    environmentId: EnvironmentId.make("env-retry"),
    projectId: ProjectId.make("p1"),
    threadIds: [ThreadId.make("a")],
  };
  it("sends a retry under the unsettled start's id and a start after success under a new one", () => {
    let ids = 0;
    const newId = () => `id-${(ids += 1)}`;
    const first = fixChatInput(target, "slow_command", "web", newId);
    expect(fixChatInput(target, "slow_command", "web", newId).commandId).toBe(first.commandId);
    expect(fixChatInput(target, "retries", "web", newId).commandId).not.toBe(first.commandId);
    settleFixChat(target, "slow_command");
    expect(fixChatInput(target, "slow_command", "web", newId).commandId).not.toBe(first.commandId);
  });
});

describe("dailyTrend", () => {
  it("groups by day in the given zone and fills listed empty days", () => {
    // 23:30 UTC on the 10th is already the 11th in Auckland (UTC+13 in November).
    const late = chat("a", { settledAt: "2026-11-10T23:30:00.000Z", lifetimeMs: 100 });
    const next = chat("b", { settledAt: "2026-11-11T01:00:00.000Z", lifetimeMs: 300 });
    expect(dayKey(late.summary.settledAt, "UTC")).toBe("2026-11-10");
    expect(dayKey(late.summary.settledAt, "Pacific/Auckland")).toBe("2026-11-11");

    const utc = dailyTrend([late, next], {
      timeZone: "UTC",
      days: ["2026-11-09", "2026-11-10", "2026-11-11"],
    });
    expect(utc.map((point) => [point.day, point.chats])).toEqual([
      ["2026-11-09", 0],
      ["2026-11-10", 1],
      ["2026-11-11", 1],
    ]);
    const nz = dailyTrend([late, next], { timeZone: "Pacific/Auckland" });
    expect(nz).toHaveLength(1);
    expect(nz[0]).toMatchObject({ chats: 2, medianLifetimeMs: 200, p90LifetimeMs: 280 });
  });
});

describe("breakdowns, filters, sorting and outliers", () => {
  const chats = [
    chat("a", { models: ["opus"], lifetimeMs: 100, costUsd: 5 }),
    chat("b", { models: ["haiku"], kind: "scheduled", lifetimeMs: 900, costUsd: 0.5 }, "env-b"),
    chat("c", {
      models: [],
      lifetimeMs: 500,
      costUsd: 0,
      runs: { ...chat("x").summary.runs, failed: 0 },
    }),
  ];

  it("breaks down by main model with an empty key for chats without one", () => {
    const rows = breakdownByModel(chats);
    expect(rows.map((row) => row.key).toSorted()).toEqual(["", "haiku", "opus"]);
  });

  it("filters by project, kind and model across environments", () => {
    expect(filterChats(chats, { kind: "scheduled" }).map(monitoringChatKey)).toEqual(["env-b:b"]);
    expect(filterChats(chats, { projectKey: "env-b:p1" }).map(monitoringChatKey)).toEqual([
      "env-b:b",
    ]);
    expect(filterChats(chats, { model: "" }).map(monitoringChatKey)).toEqual(["env-a:c"]);
    expect(filterChats(chats, {})).toBe(chats);
  });

  it("sorts and picks outliers, leaving out zero scores", () => {
    expect(sortChats(chats, "lifetimeMs", "desc").map((c) => c.summary.threadId)).toEqual([
      "b",
      "c",
      "a",
    ]);
    const top = outliers(chats, 2);
    expect(top.slowest.map((c) => c.summary.threadId)).toEqual(["b", "c"]);
    expect(top.mostExpensive.map((c) => c.summary.threadId)).toEqual(["a", "b"]);
    expect(top.mostFailures.map((c) => c.summary.threadId)).toEqual(["a", "b"]);
  });
});

describe("phaseTotals", () => {
  it("sums phases across chats, computes rates, and drops phases that never ran", () => {
    const totals = phaseTotals([
      chat("a", {
        phases: [
          { phase: "test", count: 2, failed: 1, durationMs: 4000 },
          { phase: "build", count: 0, failed: 0, durationMs: 0 },
        ],
      }),
      chat("b", { phases: [{ phase: "test", count: 2, failed: 1, durationMs: 2000 }] }),
    ]);
    expect(totals).toEqual([
      { phase: "test", count: 4, failed: 2, failureRate: 0.5, durationMs: 6000, averageMs: 1500 },
    ]);
  });
});

describe("monitoringWindowStart", () => {
  it("starts at local midnight, days - 1 days back", () => {
    // @effect-diagnostics-next-line globalDate:off - The helper does local calendar math, so the test reads local fields.
    const now = new Date(2026, 10, 18, 15, 30).getTime();
    // @effect-diagnostics-next-line globalDate:off - The helper does local calendar math, so the test reads local fields.
    const start = new Date(monitoringWindowStart(7, now));
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      2026, 10, 12, 0,
    ]);
    // @effect-diagnostics-next-line globalDate:off - The helper does local calendar math, so the test reads local fields.
    expect(new Date(monitoringWindowStart(1, now)).getDate()).toBe(18);
  });
});

describe("mergeMonitoringOverviews", () => {
  const report = (
    environmentId: string,
    overrides: Partial<MonitoringEnvironmentReport> = {},
  ): MonitoringEnvironmentReport => ({
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    isPending: false,
    error: null,
    result: {
      threads: [chat("t1", {}, environmentId).summary],
      truncated: false,
      pendingAnalysis: 1,
      failedAnalysis: 2,
    },
    ...overrides,
  });

  it("sums the answers, keeps chats apart by environment and is failed only when all failed", () => {
    const merged = mergeMonitoringOverviews([
      report("env-a"),
      report("env-b", { error: "offline", result: null }),
      report("env-c", { isPending: true }),
    ]);
    expect(merged.chats.map((entry) => monitoringChatKey(entry))).toEqual(["env-a:t1", "env-c:t1"]);
    expect([merged.pendingAnalysis, merged.failedAnalysis]).toEqual([2, 4]);
    expect([merged.isLoading, merged.failed]).toEqual([false, false]);
  });

  it("loads until some environment answers and fails when every one failed", () => {
    const waiting = mergeMonitoringOverviews([report("env-a", { isPending: true, result: null })]);
    const failed = mergeMonitoringOverviews([report("env-a", { error: "offline", result: null })]);
    expect([waiting.isLoading, waiting.failed]).toEqual([true, false]);
    expect([failed.isLoading, failed.failed]).toEqual([false, true]);
  });
});
