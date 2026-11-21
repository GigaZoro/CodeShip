import { expect, it } from "vite-plus/test";

import { buildChartDays, usageChartTotals } from "../apps/mobile/src/features/usage/usageChartData";
import { UsageAggregator } from "../apps/server/src/usage/usageAggregation";
import {
  buildChart,
  usageChartPeriodIndex,
} from "../apps/web/src/components/usage/UsageProviderChart";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "../packages/contracts/src/index";
import { enumerateHourStarts, makeWindow } from "../packages/shared/src/usageFormat";
import { mergeUsage } from "../packages/shared/src/usageMerge";

it("plots the server's unaligned hourly bucket keys on web and mobile", () => {
  const window = makeWindow(1, new Date("2026-11-21T18:56:30.000Z"), "hour");
  const untilTime = window.untilTime!;
  const sinceTime = window.sinceTime!;
  const aggregator = new UsageAggregator({
    ...window,
    sinceTimeMs: Date.parse(sinceTime),
    untilTimeMs: Date.parse(untilTime),
    rates: new Map(),
  });
  for (const [index, timestamp] of [
    "2026-11-20T18:56:00.000Z",
    "2026-11-21T12:20:00.000Z",
    "2026-11-21T18:55:59.999Z",
  ].entries()) {
    aggregator.add({
      timestampMs: Date.parse(timestamp),
      provider: "codex",
      model: "test-model",
      sessionId: String(index),
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: null,
    });
  }
  const { buckets } = aggregator.finish();
  const merged = mergeUsage(
    [
      {
        environmentId: EnvironmentId.make("desk"),
        label: "Desk",
        summary: {
          ...window,
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: untilTime,
          buckets,
          sources: [
            {
              fingerprint: {
                hostId: "desk",
                provider: "codex",
                resolvedHomePath: "/transcripts",
                volumeId: "1",
              },
              status: "ok",
              scannedFiles: 3,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 3,
              message: null,
            },
          ],
          pricing: { status: "cached", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 0,
        },
      },
    ],
    USAGE_CONTRACT_VERSION,
  );
  expect(merged.totalTokens).toBe(300);
  const hours = enumerateHourStarts(sinceTime, untilTime);
  const web = buildChart(
    hours,
    usageChartPeriodIndex(merged.daily, merged.hourly, "hour"),
    "tokens",
    ["codex"],
    new Set(),
    "bar",
  );
  const mobile = buildChartDays(hours, usageChartTotals(merged, true), "tokens");
  expect(hours).toHaveLength(24);
  expect(web.bars.map(({ period }) => period)).toEqual(buckets.map(({ hourStart }) => hourStart));
  expect(mobile.filter(({ total }) => total > 0).map(({ day }) => day)).toEqual(
    buckets.map(({ hourStart }) => hourStart),
  );
  expect(web.columns.map(({ total }) => total)).toEqual(mobile.map(({ total }) => total));
  expect(web.columns.reduce((tokens, column) => tokens + column.total, 0)).toBe(300);
});
