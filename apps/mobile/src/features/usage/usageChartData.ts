import type { UsageProviderKind } from "@t3tools/contracts";
import type { DailyTotals, MergedUsage } from "@t3tools/shared/usageMerge";
import { usageEmptyMessage } from "@t3tools/shared/usageFormat";

export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
];

export type UsageChartMetric = "cost" | "tokens";

export function usageChartTotals(
  merged: Pick<MergedUsage, "daily" | "hourly">,
  hourly: boolean,
): readonly DailyTotals[] {
  return hourly
    ? merged.hourly.map((period) => ({ ...period, day: period.hourStart }))
    : merged.daily;
}

export function usageChartEmptyMessage(
  periods: readonly DailyTotals[],
  usage: MergedUsage,
  metric: UsageChartMetric,
): string | null {
  return periods.some((period) => (metric === "cost" ? period.costUsd : period.totalTokens) > 0)
    ? null
    : usageEmptyMessage(usage, metric);
}

export interface UsageChartDay {
  readonly day: string;
  readonly values: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  readonly total: number;
}

export function buildChartDays(
  days: readonly string[],
  daily: readonly DailyTotals[],
  metric: UsageChartMetric,
): readonly UsageChartDay[] {
  const byDay = new Map(daily.map((totals) => [totals.day, totals]));
  return days.map((day) => {
    const totals = byDay.get(day);
    const values = PROVIDER_ORDER.map((provider) => {
      const entry = totals?.byProvider.get(provider);
      const value = entry === undefined ? 0 : metric === "cost" ? entry.costUsd : entry.totalTokens;
      return { provider, value };
    });
    return {
      day,
      values,
      total: values.reduce((sum, entry) => sum + entry.value, 0),
    };
  });
}
