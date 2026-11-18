import { describe, expect, it } from "@effect/vitest";
import type { MonitoringOverviewInput, MonitoringThreadSummary } from "@t3tools/contracts";
import { durationQuantile } from "@t3tools/shared/monitoring";

import { makeOverviewFold, type OverviewRow } from "./overviewAggregation.ts";

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

const row = (
  id: string,
  overrides: Partial<MonitoringThreadSummary> = {},
  dayKey = "2026-11-10",
): OverviewRow => ({
  dayKey,
  summary: {
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
  } as unknown as MonitoringThreadSummary,
});

const input = (overrides: Partial<MonitoringOverviewInput> = {}): MonitoringOverviewInput =>
  ({
    sinceDay: "2026-11-09",
    untilDay: "2026-11-11",
    timeZone: "UTC",
    sort: { key: "settledAt", direction: "desc" },
    chatLimit: 50,
    ...overrides,
  }) as MonitoringOverviewInput;

const fold = (
  rows: ReadonlyArray<OverviewRow>,
  overrides: Partial<MonitoringOverviewInput> = {},
) => {
  const state = makeOverviewFold(input(overrides));
  for (const entry of rows) state.add(entry);
  return state.finish();
};

const finding = (code: string, severity = "medium", wastedMs = 100, count = 1) => ({
  code,
  severity,
  wastedMs,
  count,
  detail: null,
});

describe("makeOverviewFold", () => {
  const rows = [
    row("a", { findings: [finding("retries") as never], costUsd: 3 }),
    row("b", { kind: "scheduled", projectId: "p2" as never, models: [], lifetimeMs: 5000 }),
    row("c", {
      models: ["sonnet"],
      lifetimeMs: 200,
      runs: { ...row("x").summary.runs, failed: 0 },
    }),
  ];

  it("narrows every figure by project, kind and main model but keeps the filter options whole", () => {
    const result = fold(rows, { kind: "interactive" });
    expect(result.totals.chats).toBe(2);
    expect(result.listedChats).toBe(2);
    expect(result.breakdowns.kinds.map((group) => group.key)).toEqual(["interactive"]);
    expect(result.options).toEqual({
      projectIds: ["p1", "p2"],
      kinds: ["interactive", "scheduled"],
      models: ["", "opus", "sonnet"],
    });
    expect(fold(rows, { model: "" }).chats.map((chat) => chat.threadId)).toEqual(["b"]);
    expect(fold(rows, { projectId: "p2" as never }).totals.chats).toBe(1);
  });

  it("narrows only the chat list by finding code", () => {
    const result = fold(rows, { findingCode: "retries" });
    expect(result.totals.chats).toBe(3);
    expect(result.findings).toEqual([
      { code: "retries", chats: 1, occurrences: 1, wastedMs: 100, severity: "medium" },
    ]);
    expect(result.chats.map((chat) => chat.threadId)).toEqual(["a"]);
    expect(result.listedChats).toBe(1);
  });

  it("returns every day of the window, zero days included, and ignores rows outside it", () => {
    const result = fold([...rows, row("late", {}, "2026-11-20")]);
    expect(result.days.map((day) => [day.day, day.chats])).toEqual([
      ["2026-11-09", 0],
      ["2026-11-10", 3],
      ["2026-11-11", 0],
    ]);
    expect(result.totals.chats).toBe(3);
    expect(durationQuantile(result.days[1]!.lifetime, 1)).toBeGreaterThan(4900);
  });

  it("limits the sorted list, counts all listed chats and breaks ties the same way each time", () => {
    const tied = [row("b", { costUsd: 2 }), row("a", { costUsd: 2 }), row("c", { costUsd: 9 })];
    const result = fold(tied, { sort: { key: "costUsd", direction: "desc" }, chatLimit: 2 });
    expect(result.chats.map((chat) => chat.threadId)).toEqual(["c", "a"]);
    expect(result.listedChats).toBe(3);
  });

  it("reports the slowest, costliest and most failing chats with a score above zero", () => {
    const result = fold(rows);
    expect(result.outliers.slowest.map((chat) => chat.threadId)).toEqual(["b", "a", "c"]);
    expect(result.outliers.mostExpensive).toHaveLength(3);
    expect(result.outliers.mostFailures.map((chat) => chat.threadId)).toEqual(["a", "b"]);
  });

  it("keys breakdowns by project id, kind and main model, empty when none", () => {
    const result = fold(rows);
    expect(result.breakdowns.projects.map((group) => group.key)).toEqual(["p1", "p2"]);
    expect(result.breakdowns.models.map((group) => group.key).toSorted()).toEqual([
      "",
      "opus",
      "sonnet",
    ]);
    expect(result.totals.helpers).toBe(6);
    expect(result.totals.tokens.inputTokens).toBe(300);
  });
});
