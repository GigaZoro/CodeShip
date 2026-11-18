import type { MonitoringTimeBuckets } from "@t3tools/contracts";
import { TIME_BUCKET_KEYS } from "@t3tools/client-runtime/monitoring";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TIME_BUCKET_PRESENTATION } from "@t3tools/client-runtime/monitoring-text";
import { t } from "~/i18n";

/** The ten buckets as one bar; the legend lists every bucket, so color is never the only cue. */
export function MonitoringTimeBar({ buckets }: { readonly buckets: MonitoringTimeBuckets }) {
  const rows = TIME_BUCKET_KEYS.map((key) => ({
    key,
    label: t(TIME_BUCKET_PRESENTATION[key].label),
    hint: t(TIME_BUCKET_PRESENTATION[key].hint),
    color: TIME_BUCKET_PRESENTATION[key].color,
    value: buckets[key],
  }));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) {
    return <p className="text-sm text-muted-foreground">{t("No time recorded yet.")}</p>;
  }
  const visible = rows.filter((row) => row.value > 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="img"
        aria-label={t("Where the time went: {segments}", {
          segments: visible
            .map((row) =>
              t("{label} {duration} ({percent})", {
                label: row.label,
                duration: formatDuration(row.value),
                percent: formatPercent(row.value / total, 0),
              }),
            )
            .join(", "),
        })}
        className="flex h-3 gap-0.5"
      >
        {visible.map((row) => (
          <Tooltip key={row.key}>
            <TooltipTrigger
              render={
                <div
                  className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
                  style={{ flex: `${row.value} 1 0`, backgroundColor: row.color }}
                />
              }
            />
            <TooltipPopup>
              <span className="block font-medium">{row.label}</span>
              <span className="block">
                {formatDuration(row.value)} · {formatPercent(row.value / total)}
              </span>
              <span className="block max-w-64 text-muted-foreground">{row.hint}</span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-xs"
              style={{ backgroundColor: row.color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
            <span className="tabular-nums text-foreground">{formatDuration(row.value)}</span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">
              {formatPercent(row.value / total, 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
