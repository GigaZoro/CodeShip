import { type Message, t } from "~/i18n";
import { formatPercent, usageEmptyMessage } from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

import type { ReactNode } from "react";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export interface ShareSegment {
  readonly label: Message;
  readonly value: number;
  readonly color: string;
}

export function UsageShareBar({
  label,
  segments,
  format,
  aside,
  recordedUsage,
  metric,
}: {
  readonly label: string;
  readonly segments: readonly ShareSegment[];
  readonly format: (value: number) => string;
  readonly aside?: ReactNode;
  readonly recordedUsage: Pick<MergedUsage, "records" | "costQuality" | "totalTokens" | "costUsd">;
  readonly metric: "tokens" | "cost";
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {aside}
      </div>
      {total <= 0 ? (
        <>
          {" "}
          <div aria-hidden className="h-2 rounded-full bg-muted" />
          <p className="text-xs text-muted-foreground">
            {usageEmptyMessage(recordedUsage, metric)}
          </p>
        </>
      ) : (
        <>
          {/* The legend below carries every figure; the bar's tooltips are pointer-only. */}
          <div aria-hidden className="flex h-2 gap-0.5">
            {visible.map((segment) => (
              <SharedTooltipTrigger
                key={segment.label}
                render={
                  <div
                    className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
                    style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
                  />
                }
                label={
                  <>
                    {t(segment.label)} · {format(segment.value)} ·{" "}
                    {formatPercent(segment.value / total)}
                  </>
                }
              />
            ))}
          </div>
          <ul aria-label={label} className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {visible.map((segment) => (
              <li key={segment.label} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 rounded-xs"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="text-muted-foreground">{t(segment.label)}</span>{" "}
                <span className="text-foreground tabular-nums">{format(segment.value)}</span>
                <span className="sr-only">, {formatPercent(segment.value / total)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
