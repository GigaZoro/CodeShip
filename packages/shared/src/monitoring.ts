import {
  MONITORING_OUTLIER_LIMIT,
  type MonitoringChatRow,
  type MonitoringChatSort,
  type MonitoringDurationSketch,
  type MonitoringFindingRollup,
  type MonitoringFindingSeverity,
  type MonitoringTimeBuckets,
} from "@t3tools/contracts";

/** Working first, then the waits, in the order a chat's lifetime usually unfolds. */
export const TIME_BUCKET_KEYS = [
  "agentMs",
  "commandMs",
  "toolMs",
  "approvalMs",
  "queuedMs",
  "usageLimitMs",
  "delegateWaitMs",
  "userResponseMs",
  "idleMs",
  "settleTailMs",
] as const satisfies ReadonlyArray<keyof MonitoringTimeBuckets>;
export type TimeBucketKey = (typeof TIME_BUCKET_KEYS)[number];

const SEVERITY_RANK: Record<MonitoringFindingSeverity, number> = { high: 3, medium: 2, low: 1 };

export const moreSevere = (a: MonitoringFindingSeverity, b: MonitoringFindingSeverity) =>
  SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;

/** Most time wasted first, then the most chats hit, then the most severe. */
export const compareFindingRollups = (
  a: Pick<MonitoringFindingRollup, "wastedMs" | "chats" | "severity">,
  b: Pick<MonitoringFindingRollup, "wastedMs" | "chats" | "severity">,
) =>
  b.wastedMs - a.wastedMs ||
  b.chats - a.chats ||
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

/** Each bucket spans a 2% step, so a quantile reads back within about 1%. */
const GROWTH = 1.02;
const LOG_GROWTH = Math.log(GROWTH);

const bucketIndex = (ms: number) => Math.floor(Math.log(ms) / LOG_GROWTH);
const bucketValue = (index: number) => Math.round(GROWTH ** (index + 0.5));

const toSketch = (
  zeros: number,
  counts: ReadonlyMap<number, number>,
): MonitoringDurationSketch => ({
  zeros,
  buckets: [...counts].sort(([a], [b]) => a - b),
});

export function sketchDurations(values: Iterable<number>): MonitoringDurationSketch {
  let zeros = 0;
  const counts = new Map<number, number>();
  for (const value of values) {
    if (!(value >= 1)) {
      zeros += 1;
      continue;
    }
    const index = bucketIndex(value);
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return toSketch(zeros, counts);
}

export function mergeDurationSketches(
  sketches: Iterable<MonitoringDurationSketch>,
): MonitoringDurationSketch {
  let zeros = 0;
  const counts = new Map<number, number>();
  for (const sketch of sketches) {
    zeros += sketch.zeros;
    for (const [index, count] of sketch.buckets)
      counts.set(index, (counts.get(index) ?? 0) + count);
  }
  return toSketch(zeros, counts);
}

export const durationSketchCount = (sketch: MonitoringDurationSketch) =>
  sketch.buckets.reduce((total, [, count]) => total + count, sketch.zeros);

/** Linear-interpolated quantile like sorting the values; 0 for none. `fraction` is 0 to 1. */
export function durationQuantile(sketch: MonitoringDurationSketch, fraction: number): number {
  const count = durationSketchCount(sketch);
  if (count === 0) return 0;
  const position = Math.min(1, Math.max(0, fraction)) * (count - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  let low = 0;
  let high = 0;
  let seen = sketch.zeros;
  for (const [index, bucketCount] of sketch.buckets) {
    const value = bucketValue(index);
    if (lower >= seen && lower < seen + bucketCount) low = value;
    if (upper >= seen && upper < seen + bucketCount) high = value;
    seen += bucketCount;
  }
  return low + (high - low) * (position - lower);
}

const sortValue = (key: MonitoringChatSort["key"], row: MonitoringChatRow): number =>
  key === "settledAt" ? Date.parse(row.settledAt) : row[key];

/** Ties go newest settle first, then by thread id, so every merge of the same rows agrees. */
export function compareMonitoringChatRows(sort: MonitoringChatSort) {
  const sign = sort.direction === "asc" ? 1 : -1;
  return (a: MonitoringChatRow, b: MonitoringChatRow): number =>
    sign * (sortValue(sort.key, a) - sortValue(sort.key, b)) ||
    Date.parse(b.settledAt) - Date.parse(a.settledAt) ||
    (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);
}

const OUTLIER_SCORES = {
  slowest: (row) => row.lifetimeMs,
  mostExpensive: (row) => row.costUsd,
  mostFailures: (row) => row.failures,
} as const satisfies Record<string, (row: MonitoringChatRow) => number>;

export interface MonitoringOutlierRows {
  readonly slowest: ReadonlyArray<MonitoringChatRow>;
  readonly mostExpensive: ReadonlyArray<MonitoringChatRow>;
  readonly mostFailures: ReadonlyArray<MonitoringChatRow>;
}

/** The top rows by each outlier score, score above zero only; ties go to the newest settle. */
export function topMonitoringOutliers(
  rows: ReadonlyArray<MonitoringChatRow>,
): MonitoringOutlierRows {
  const byNewest = compareMonitoringChatRows({ key: "settledAt", direction: "desc" });
  const top = (score: (row: MonitoringChatRow) => number) =>
    rows
      .filter((row) => score(row) > 0)
      .sort((a, b) => score(b) - score(a) || byNewest(a, b))
      .slice(0, MONITORING_OUTLIER_LIMIT);
  return {
    slowest: top(OUTLIER_SCORES.slowest),
    mostExpensive: top(OUTLIER_SCORES.mostExpensive),
    mostFailures: top(OUTLIER_SCORES.mostFailures),
  };
}
