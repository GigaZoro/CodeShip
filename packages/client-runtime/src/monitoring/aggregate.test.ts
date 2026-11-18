import {
  EnvironmentId,
  type MonitoringChatRow,
  type MonitoringOverviewInput,
  type MonitoringOverviewResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { sketchDurations, TIME_BUCKET_KEYS } from "@t3tools/shared/monitoring";

import {
  mergeMonitoringOverviews,
  monitoringChatKey,
  monitoringEnvironmentInput,
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

const row = (id: string, overrides: Partial<MonitoringChatRow> = {}): MonitoringChatRow =>
  ({
    threadId: id,
    projectId: "p1",
    title: id,
    kind: "interactive",
    model: "opus",
    settledAt: "2026-11-10T12:00:00.000Z",
    lifetimeMs: 1000,
    activeMs: 400,
    costUsd: 1,
    failures: 0,
    findings: 0,
    ...overrides,
  }) as MonitoringChatRow;

const group = (key: string, chats: number, lifetimes: number[], costUsd = 1, findings = 0) => ({
  key,
  chats,
  lifetime: sketchDurations(lifetimes),
  active: sketchDurations(lifetimes.map((value) => value / 2)),
  costUsd,
  findings,
});

function result(overrides: Partial<MonitoringOverviewResult> = {}): MonitoringOverviewResult {
  return {
    totals: {
      chats: 2,
      lifetimeMs: 4000,
      activeMs: 1400,
      lifetime: sketchDurations([1000, 3000]),
      active: sketchDurations([400, 1000]),
      time: { ...zeroTime, agentMs: 1000, commandMs: 400, idleMs: 2600 },
      costUsd: 3,
      unpricedTurns: 1,
      tokens: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10 },
      runs: 4,
      failedRuns: 1,
      userPrompts: 2,
      helpers: 3,
      findings: 2,
    },
    phases: [{ phase: "test", count: 2, failed: 1, durationMs: 4000 }],
    findings: [
      { code: "retries", chats: 1, occurrences: 1, wastedMs: 100, severity: "low" },
      { code: "usage_limit", chats: 1, occurrences: 1, wastedMs: 5000, severity: "medium" },
    ],
    days: [
      { day: "2026-11-09", chats: 0, lifetime: sketchDurations([]), activeMs: 0, costUsd: 0 },
      {
        day: "2026-11-10",
        chats: 2,
        lifetime: sketchDurations([1000, 3000]),
        activeMs: 1400,
        costUsd: 3,
      },
    ],
    breakdowns: {
      projects: [group("p1", 2, [1000, 3000], 3)],
      kinds: [group("interactive", 2, [1000, 3000], 3)],
      models: [group("opus", 2, [1000, 3000], 3)],
    },
    outliers: {
      slowest: [row("a", { lifetimeMs: 3000 })],
      mostExpensive: [row("a", { lifetimeMs: 3000 })],
      mostFailures: [],
    },
    chats: [row("a", { lifetimeMs: 3000 }), row("b")],
    listedChats: 2,
    options: { projectIds: ["p1"], kinds: ["interactive"], models: ["opus"] },
    pendingAnalysis: 1,
    failedAnalysis: 2,
    ...overrides,
  } as MonitoringOverviewResult;
}

const report = (
  environmentId: string,
  overrides: Partial<MonitoringEnvironmentReport> = {},
): MonitoringEnvironmentReport => ({
  environmentId: EnvironmentId.make(environmentId),
  label: environmentId,
  isPending: false,
  error: null,
  result: result(),
  optionsOnly: false,
  ...overrides,
});

const LIST = { sort: { key: "settledAt", direction: "desc" }, chatLimit: 3 } as const;

describe("mergeMonitoringOverviews", () => {
  it("sums the answers and is failed only when every environment failed", () => {
    const merged = mergeMonitoringOverviews(
      [
        report("env-a"),
        report("env-b", { error: "offline", result: null }),
        report("env-c", { isPending: true }),
      ],
      LIST,
    );
    expect([merged.pendingAnalysis, merged.failedAnalysis]).toEqual([2, 4]);
    expect([merged.isLoading, merged.failed]).toEqual([false, false]);
    expect(merged.totals).toMatchObject({
      chats: 4,
      costUsd: 6,
      failedRuns: 2,
      helpers: 6,
      workingShare: 0.35,
      cacheReuse: 0.25,
    });
    expect(TIME_BUCKET_KEYS.reduce((total, key) => total + merged.time[key], 0)).toBe(8000);
  });

  it("loads until some environment answers and fails when every one failed", () => {
    const waiting = mergeMonitoringOverviews(
      [report("env-a", { isPending: true, result: null })],
      LIST,
    );
    const failed = mergeMonitoringOverviews(
      [report("env-a", { error: "offline", result: null })],
      LIST,
    );
    expect([waiting.isLoading, waiting.failed]).toEqual([true, false]);
    expect([failed.isLoading, failed.failed]).toEqual([false, true]);
    expect(failed.totals.chats).toBe(0);
    expect(failed.days).toEqual([]);
  });

  it("merges days, kinds, models and findings and keeps projects apart per environment", () => {
    const merged = mergeMonitoringOverviews(
      [
        report("env-a"),
        report("env-b", {
          result: result({
            days: [
              {
                day: "2026-11-10",
                chats: 1,
                lifetime: sketchDurations([5000]),
                activeMs: 1,
                costUsd: 1,
              },
              {
                day: "2026-11-11",
                chats: 0,
                lifetime: sketchDurations([]),
                activeMs: 0,
                costUsd: 0,
              },
            ] as unknown as MonitoringOverviewResult["days"],
            breakdowns: {
              projects: [group("p1", 1, [5000])],
              kinds: [group("interactive", 1, [5000]), group("scheduled", 4, [10], 9)],
              models: [group("", 1, [5000])],
            } as MonitoringOverviewResult["breakdowns"],
            options: { projectIds: ["p9"], kinds: ["scheduled"], models: [""] } as never,
          }),
        }),
      ],
      LIST,
    );
    expect(merged.days.map((day) => [day.day, day.chats])).toEqual([
      ["2026-11-09", 0],
      ["2026-11-10", 3],
      ["2026-11-11", 0],
    ]);
    expect(merged.days[1]!.p90LifetimeMs).toBeGreaterThan(merged.days[1]!.medianLifetimeMs);
    expect(merged.breakdowns.projects.map((row) => row.key).toSorted()).toEqual([
      "env-a:p1",
      "env-b:p1",
    ]);
    expect(merged.breakdowns.kinds.map((row) => [row.key, row.chats])).toEqual(
      [
        ["interactive", 3],
        ["scheduled", 4],
      ].toSorted((a, b) => (b[1] as number) - (a[1] as number)),
    );
    expect(merged.breakdowns.models.map((row) => row.key).toSorted()).toEqual(["", "opus"]);
    expect(merged.findings.map((rank) => [rank.code, rank.chats])).toEqual([
      ["usage_limit", 2],
      ["retries", 2],
    ]);
    expect(merged.phases).toEqual([
      { phase: "test", count: 4, failed: 2, failureRate: 0.5, durationMs: 8000, averageMs: 2000 },
    ]);
    expect(merged.options).toEqual({
      projects: [
        { key: "env-a:p1", environmentId: "env-a", projectId: "p1" },
        { key: "env-b:p9", environmentId: "env-b", projectId: "p9" },
      ],
      kinds: ["interactive", "scheduled"],
      models: ["opus", ""],
    });
  });

  it("merges the chat lists in the requested order up to the limit, keeping environments apart", () => {
    const merged = mergeMonitoringOverviews(
      [
        report("env-a"),
        report("env-b", {
          result: result({
            chats: [
              row("a", { settledAt: "2026-11-12T00:00:00.000Z" }),
              row("z", { settledAt: "2026-11-01T00:00:00.000Z" }),
            ],
            listedChats: 7,
          }),
        }),
      ],
      LIST,
    );
    expect(merged.chats.map(monitoringChatKey)).toEqual(["env-b:a", "env-a:a", "env-a:b"]);
    expect(merged.listedChats).toBe(9);

    const byCost = mergeMonitoringOverviews(
      [
        report("env-a", { result: result({ chats: [row("c", { costUsd: 1 })] }) }),
        report("env-b", { result: result({ chats: [row("d", { costUsd: 8 })] }) }),
      ],
      { sort: { key: "costUsd", direction: "asc" }, chatLimit: 1 },
    );
    expect(byCost.chats.map(monitoringChatKey)).toEqual(["env-a:c"]);
  });

  it("merges outliers across environments without listing a chat twice", () => {
    const merged = mergeMonitoringOverviews(
      [
        report("env-a"),
        report("env-b", {
          result: result({
            outliers: {
              slowest: [
                row("a", { lifetimeMs: 9000, costUsd: 0 }),
                row("x", { lifetimeMs: 10, costUsd: 0 }),
              ],
              mostExpensive: [],
              mostFailures: [row("a", { lifetimeMs: 9000, failures: 3, costUsd: 0 })],
            },
          }),
        }),
      ],
      LIST,
    );
    expect(merged.outliers.slowest.map(monitoringChatKey)).toEqual([
      "env-b:a",
      "env-a:a",
      "env-b:x",
    ]);
    expect(merged.outliers.mostExpensive.map(monitoringChatKey)).toEqual(["env-a:a"]);
    expect(merged.outliers.mostFailures.map(monitoringChatKey)).toEqual(["env-b:a"]);
  });
});

describe("a project filter", () => {
  it("counts only the project's environment and keeps every environment's filter options", () => {
    const input = {
      sinceDay: "2026-11-01",
      untilDay: "2026-11-10",
      timeZone: "UTC",
      projectId: "p1",
      sort: LIST.sort,
      chatLimit: 3,
    } as unknown as MonitoringOverviewInput;
    const other = monitoringEnvironmentInput(
      input,
      EnvironmentId.make("env-a"),
      EnvironmentId.make("env-b"),
    );
    expect(other.optionsOnly).toBe(true);
    expect("projectId" in other.input).toBe(false);
    expect(
      monitoringEnvironmentInput(input, EnvironmentId.make("env-a"), EnvironmentId.make("env-a")),
    ).toEqual({
      input,
      optionsOnly: false,
    });

    const merged = mergeMonitoringOverviews(
      [
        report("env-a"),
        report("env-b", {
          optionsOnly: true,
          error: "offline",
          result: result({
            options: { projectIds: ["p9"], kinds: ["scheduled"], models: [] } as never,
          }),
        }),
      ],
      LIST,
    );
    expect(merged.totals.chats).toBe(2);
    expect(merged.environments.map((environment) => environment.environmentId)).toEqual(["env-a"]);
    expect(merged.options.projects.map((project) => project.key)).toEqual(["env-a:p1", "env-b:p9"]);
    expect(merged.options.kinds).toEqual(["interactive", "scheduled"]);
  });

  it("still shows the filters when the project's environment is gone", () => {
    const merged = mergeMonitoringOverviews([report("env-b", { optionsOnly: true })], LIST);
    expect([merged.connected, merged.isLoading, merged.failed]).toEqual([true, false, false]);
    expect(merged.environments).toEqual([]);
    expect(merged.totals.chats).toBe(0);
    expect(merged.options.projects.map((project) => project.key)).toEqual(["env-b:p1"]);
  });
});
