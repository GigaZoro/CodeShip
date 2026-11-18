import type { MonitoringDayPoint } from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatDayShort, formatUsd } from "@t3tools/shared/usageFormat";
import { useState } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { msg, t } from "~/i18n";

export type TrendMetric = "chats" | "lifetime" | "active" | "cost";

const METRICS = [
  { value: "chats", label: msg("Chats settled") },
  { value: "lifetime", label: msg("Lifetime") },
  { value: "active", label: msg("Active time") },
  { value: "cost", label: msg("Cost") },
] as const satisfies ReadonlyArray<{ value: TrendMetric; label: ReturnType<typeof msg> }>;

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { left: 52, right: 8, top: 10, bottom: 22 };
const MEDIAN_COLOR = "#3b82f6";
const P90_COLOR = "#f59e0b";

const formatterFor = (metric: TrendMetric) =>
  metric === "chats" ? formatCount : metric === "cost" ? formatUsd : formatDuration;

function valuesFor(metric: TrendMetric, point: MonitoringDayPoint): ReadonlyArray<number> {
  switch (metric) {
    case "chats":
      return [point.chats];
    case "lifetime":
      return [point.medianLifetimeMs, point.p90LifetimeMs];
    case "active":
      return [point.activeMs];
    case "cost":
      return [point.costUsd];
  }
}

/** A round axis maximum: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * power;
}

const TICKS = 4;

export function MonitoringTrendChart({
  points,
}: {
  readonly points: ReadonlyArray<MonitoringDayPoint>;
}) {
  const [metric, setMetric] = useState<TrendMetric>("chats");
  const [hovered, setHovered] = useState<number | null>(null);
  const format = formatterFor(metric);
  const metricLabel = t(METRICS.find((option) => option.value === metric)!.label);
  const lines = metric === "lifetime";

  const max = niceMax(Math.max(0, ...points.flatMap((point) => valuesFor(metric, point))));
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const slot = points.length > 0 ? innerWidth / points.length : innerWidth;
  const centerX = (index: number) => PAD.left + slot * (index + 0.5);
  const y = (value: number) => PAD.top + innerHeight * (1 - value / max);
  const path = (pick: (point: MonitoringDayPoint) => number) =>
    points
      .map((point, index) => `${index === 0 ? "M" : "L"}${centerX(index)},${y(pick(point))}`)
      .join(" ");
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const hover = hovered === null ? null : points[hovered];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label={t("Trend metric")}
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (METRICS.some((option) => option.value === value)) setMetric(value as TrendMetric);
          }}
        >
          {METRICS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {t(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>
        {lines ? (
          <ul className="flex gap-4 text-xs text-muted-foreground">
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="h-0.5 w-4" style={{ backgroundColor: MEDIAN_COLOR }} />
              {t("Median")}
            </li>
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-0 w-4 border-t-2 border-dashed"
                style={{ borderColor: P90_COLOR }}
              />
              {t("90th percentile")}
            </li>
          </ul>
        ) : null}
      </div>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No chats settled in this period.")}</p>
      ) : (
        <div className="relative" onPointerLeave={() => setHovered(null)}>
          <svg
            role="img"
            aria-label={t(
              "{metric} per day, {from} to {to}. The data table below has every value.",
              {
                metric: metricLabel,
                from: formatDayShort(points[0]!.day),
                to: formatDayShort(points[points.length - 1]!.day),
              },
            )}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full text-muted-foreground"
          >
            {Array.from({ length: TICKS + 1 }, (_, index) => {
              const value = (max / TICKS) * index;
              return (
                <g key={index}>
                  <line
                    x1={PAD.left}
                    x2={WIDTH - PAD.right}
                    y1={y(value)}
                    y2={y(value)}
                    stroke="currentColor"
                    strokeOpacity={index === 0 ? 0.5 : 0.18}
                  />
                  <text
                    x={PAD.left - 6}
                    y={y(value)}
                    textAnchor="end"
                    dominantBaseline="central"
                    fontSize={11}
                    fill="currentColor"
                  >
                    {format(value)}
                  </text>
                </g>
              );
            })}
            {points.map((point, index) =>
              index % labelEvery === 0 ? (
                <text
                  key={point.day}
                  x={centerX(index)}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  fontSize={11}
                  fill="currentColor"
                >
                  {formatDayShort(point.day)}
                </text>
              ) : null,
            )}
            {lines ? (
              <>
                <path
                  d={path((p) => p.medianLifetimeMs)}
                  fill="none"
                  stroke={MEDIAN_COLOR}
                  strokeWidth={2}
                />
                <path
                  d={path((p) => p.p90LifetimeMs)}
                  fill="none"
                  stroke={P90_COLOR}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                />
                {points.map((point, index) => (
                  <circle
                    key={point.day}
                    cx={centerX(index)}
                    cy={y(point.medianLifetimeMs)}
                    r={3}
                    fill={MEDIAN_COLOR}
                  />
                ))}
              </>
            ) : (
              points.map((point, index) => {
                const height = innerHeight - (y(valuesFor(metric, point)[0]!) - PAD.top);
                const barWidth = Math.max(2, Math.min(24, slot * 0.6));
                return (
                  <rect
                    key={point.day}
                    x={centerX(index) - barWidth / 2}
                    y={PAD.top + innerHeight - height}
                    width={barWidth}
                    height={height}
                    rx={2}
                    fill={MEDIAN_COLOR}
                  />
                );
              })
            )}
            {points.map((point, index) => (
              <rect
                key={point.day}
                x={PAD.left + slot * index}
                y={PAD.top}
                width={slot}
                height={innerHeight}
                fill="transparent"
                onPointerEnter={() => setHovered(index)}
              />
            ))}
          </svg>
          {hover && hovered !== null ? (
            <div
              className="surface-glass pointer-events-none absolute top-1 z-10 min-w-32 rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: `clamp(0%, ${(centerX(hovered) / WIDTH) * 100}%, calc(100% - 9rem))`,
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatDayShort(hover.day)}</div>
              {lines ? (
                <>
                  <TooltipRow label={t("Median")} value={format(hover.medianLifetimeMs)} />
                  <TooltipRow label={t("90th percentile")} value={format(hover.p90LifetimeMs)} />
                </>
              ) : (
                <TooltipRow label={metricLabel} value={format(valuesFor(metric, hover)[0]!)} />
              )}
              <TooltipRow label={t("Chats settled")} value={formatCount(hover.chats)} />
            </div>
          ) : null}
          <table className="sr-only">
            <caption>{t("{metric} per day", { metric: metricLabel })}</caption>
            <thead>
              <tr>
                <th>{t("Day")}</th>
                <th>{t("Chats settled")}</th>
                <th>{t("Median lifetime")}</th>
                <th>{t("90th percentile")}</th>
                <th>{t("Active time")}</th>
                <th>{t("Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.day}>
                  <th scope="row">{formatDayShort(point.day)}</th>
                  <td>{formatCount(point.chats)}</td>
                  <td>{formatDuration(point.medianLifetimeMs)}</td>
                  <td>{formatDuration(point.p90LifetimeMs)}</td>
                  <td>{formatDuration(point.activeMs)}</td>
                  <td>{formatUsd(point.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TooltipRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}
