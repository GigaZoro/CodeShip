import type { MonitoringChatRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compareMonitoringChatRows,
  durationQuantile,
  durationSketchCount,
  mergeDurationSketches,
  sketchDurations,
  topMonitoringOutliers,
} from "./monitoring.ts";

const exactPercentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
};

const SPREAD = Array.from({ length: 500 }, (_, i) => Math.round(1.03 ** i * 40 + i * 7));

describe("duration sketch", () => {
  it("reads quantiles within 1% of the exact percentile", () => {
    const sketch = sketchDurations(SPREAD);
    for (const fraction of [0, 0.25, 0.5, 0.9, 0.99, 1]) {
      const exact = exactPercentile(SPREAD, fraction);
      expect(Math.abs(durationQuantile(sketch, fraction) - exact) / exact).toBeLessThan(0.011);
    }
  });

  it("merges to the sketch of the union", () => {
    const left = SPREAD.filter((_, i) => i % 3 === 0);
    const right = SPREAD.filter((_, i) => i % 3 !== 0);
    expect(mergeDurationSketches([sketchDurations(left), sketchDurations(right)])).toEqual(
      sketchDurations(SPREAD),
    );
  });

  it("counts zeros and reads them back as 0", () => {
    const sketch = sketchDurations([0, 0, 0, 5_000]);
    expect(sketch.zeros).toBe(3);
    expect(durationSketchCount(sketch)).toBe(4);
    expect(durationQuantile(sketch, 0.5)).toBe(0);
    expect(durationQuantile(sketch, 1)).toBeGreaterThan(4_900);
  });

  it("reads 0 for an empty sketch and the value back for a single one", () => {
    expect(durationQuantile(sketchDurations([]), 0.5)).toBe(0);
    const single = durationQuantile(sketchDurations([123_456]), 0.9);
    expect(Math.abs(single - 123_456) / 123_456).toBeLessThan(0.011);
  });

  it("keeps buckets sorted and non-empty", () => {
    const { buckets } = sketchDurations([900, 5, 50_000, 5]);
    expect(buckets.map(([index]) => index)).toEqual(
      buckets.map(([index]) => index).toSorted((a, b) => a - b),
    );
    expect(buckets.every(([, count]) => count > 0)).toBe(true);
  });
});

const row = (id: string, overrides: Partial<MonitoringChatRow> = {}): MonitoringChatRow =>
  ({
    threadId: id,
    projectId: "p",
    title: id,
    kind: "interactive",
    model: "m",
    settledAt: "2026-11-10T12:00:00.000Z",
    lifetimeMs: 0,
    activeMs: 0,
    costUsd: 0,
    failures: 0,
    findings: 0,
    ...overrides,
  }) as MonitoringChatRow;

describe("chat rows", () => {
  it("orders by the key and breaks ties by newest settle, then thread id", () => {
    const rows = [
      row("b", { lifetimeMs: 5 }),
      row("a", { lifetimeMs: 5 }),
      row("c", { lifetimeMs: 5, settledAt: "2026-11-11T12:00:00.000Z" }),
      row("d", { lifetimeMs: 9 }),
    ];
    expect(
      rows
        .toSorted(compareMonitoringChatRows({ key: "lifetimeMs", direction: "desc" }))
        .map((r) => r.threadId),
    ).toEqual(["d", "c", "a", "b"]);
    expect(
      rows
        .toSorted(compareMonitoringChatRows({ key: "lifetimeMs", direction: "asc" }))
        .map((r) => r.threadId),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("picks the top outliers with a score above zero", () => {
    const rows = [
      row("a", { lifetimeMs: 10, costUsd: 1 }),
      row("b", { lifetimeMs: 30 }),
      row("c", { lifetimeMs: 20, failures: 2 }),
      row("d", { lifetimeMs: 5 }),
      row("e", { lifetimeMs: 30, settledAt: "2026-11-11T12:00:00.000Z" }),
    ];
    const top = topMonitoringOutliers(rows);
    expect(top.slowest.map((r) => r.threadId)).toEqual(["e", "b", "c"]);
    expect(top.mostExpensive.map((r) => r.threadId)).toEqual(["a"]);
    expect(top.mostFailures.map((r) => r.threadId)).toEqual(["c"]);
  });
});
