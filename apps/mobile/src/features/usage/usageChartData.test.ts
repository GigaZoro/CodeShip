import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { usageEmptyMessage } from "@t3tools/shared/usageFormat";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { expect, it } from "vite-plus/test";
import { buildChartDays, usageChartEmptyMessage, usageChartTotals } from "./usageChartData";

it("plots reported spend without tokens and distinguishes missing priced data", () => {
  const empty = mergeUsage([], USAGE_CONTRACT_VERSION);
  const day = "2026-11-21";
  const spend = {
    ...empty,
    records: 1,
    costUsd: 1,
    daily: [
      {
        day,
        costUsd: 1,
        totalTokens: 0,
        records: 1,
        unpricedRecords: 0,
        byProvider: new Map([
          ["codex" as const, { costUsd: 1, totalTokens: 0, records: 1, unpricedRecords: 0 }],
        ]),
      },
    ],
  };
  const periods = usageChartTotals(spend, false);
  expect(usageChartEmptyMessage(periods, spend, "cost")).toBeNull();
  expect(buildChartDays([day], periods, "cost")[0]?.total).toBe(1);
  const unknown = { costUsd: 0, totalTokens: 100, records: 1, unpricedRecords: 1 };
  const mixed = [
    { ...periods[0]!, byProvider: new Map(periods[0]!.byProvider).set("antigravity", unknown) },
  ];
  expect(
    buildChartDays([day], mixed, "cost")[0]?.values.map((entry) => entry.provider),
  ).not.toContain("antigravity");
  expect(buildChartDays([day], mixed, "tokens")[0]?.total).toBe(100);
  expect(usageChartEmptyMessage(periods, spend, "tokens")).toBe("No tokens recorded");
  const zeroCost = { ...empty, records: 1, totalTokens: 1 };
  const unpriced = { ...zeroCost, costQuality: { ...zeroCost.costQuality, unpricedShare: 1 } };
  expect(usageChartEmptyMessage([], zeroCost, "cost")).toBe("Priced usage costs $0");
  expect(usageChartEmptyMessage([], unpriced, "cost")).toBe("No priced usage");
  expect(usageEmptyMessage(spend, "cost")).toBe("No cost breakdown available");
});
