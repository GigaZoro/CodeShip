import { getFormattingLocale, t } from "~/i18n";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { UsageProviderKind } from "@t3tools/contracts";

import { useLayoutEffect, useRef, useState } from "react";
import { updatingProvidersLabel } from "@t3tools/client-runtime/state/usage-progress";

import { usageChartValue, type DailyTotals, type HourlyTotals } from "@t3tools/shared/usageMerge";
import {
  formatDayShort,
  formatDateTimeShort,
  formatHourShort,
  formatTokens,
  formatUsageCost,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import { formatRelativeHourShort } from "@t3tools/shared/usageFormatCopy";
import { cn } from "~/lib/utils";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import { observeResize } from "~/lib/observeResize";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();

export type UsageChartMetric = "tokens" | "cost";

interface UsageProviderChartProps {
  readonly chartType: "area" | "bar";
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly hours: readonly string[];
  readonly hourly: readonly HourlyTotals[];
  readonly metric: UsageChartMetric;
  readonly referenceTime: string | undefined;
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly hour12: boolean;
}

export interface DayColumn {
  readonly bands: readonly {
    readonly provider: UsageProviderKind;
    readonly value: number | null;
  }[];
  readonly total: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

export function buildPeriodColumns(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
): readonly DayColumn[] {
  return periods.map((period) => {
    const entry = byPeriod.get(period);
    const bands = PROVIDER_ORDER.map((provider) => ({
      provider,
      value: usageChartValue(entry?.byProvider.get(provider), metric),
    }));
    return { bands, total: bands.reduce((sum, band) => sum + (band.value ?? 0), 0) };
  });
}

function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

interface CurveSegment {
  readonly from: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
}

function smoothCurve(points: readonly Point[]): readonly CurveSegment[] {
  if (points.length < 2) return [];
  const tangents = monotoneTangents(points);
  const segments: CurveSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    segments.push({
      from,
      c1: { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 },
      c2: { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 },
      to,
    });
  }
  return segments;
}

function curvePath(points: readonly Point[]): string {
  const first = points[0]!;
  let path = `M${first.x.toFixed(2)},${first.y.toFixed(2)}`;
  if (points.length === 1) return `${path} l0,0`;
  for (const segment of smoothCurve(points)) {
    path += ` C${segment.c1.x.toFixed(2)},${segment.c1.y.toFixed(2)} ${segment.c2.x.toFixed(2)},${segment.c2.y.toFixed(2)} ${segment.to.x.toFixed(2)},${segment.to.y.toFixed(2)}`;
  }
  return path;
}

function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

function chartScale(
  columns: readonly DayColumn[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
  chartType: "area" | "bar",
) {
  // Area series measure from zero; stacked bars need room for the combined total.
  const peak = columns.reduce(
    (max, column) =>
      chartType === "bar"
        ? Math.max(max, column.total)
        : column.bands.reduce((inner, band) => Math.max(inner, band.value ?? 0), max),
    0,
  );
  return peak === 0 && loadingProviders.size > 0
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

function valueToY(value: number, max: number) {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

export function buildChart(
  periods: readonly string[],
  byPeriod: ReadonlyMap<string, DailyTotals | HourlyTotals>,
  metric: UsageChartMetric,
  providers: readonly UsageProviderKind[],
  loadingProviders: ReadonlySet<UsageProviderKind>,
  chartType: "area" | "bar",
) {
  const columns = buildPeriodColumns(periods, byPeriod, metric).map((column) => {
    const bands = column.bands.filter((band) => providers.includes(band.provider));
    return { bands, total: bands.reduce((sum, band) => sum + (band.value ?? 0), 0) };
  });
  const scale = chartScale(columns, loadingProviders, chartType);
  const stepX =
    chartType === "bar"
      ? VIEW_WIDTH / Math.max(1, periods.length)
      : periods.length < 2
        ? 0
        : VIEW_WIDTH / (periods.length - 1);
  const offsetX = chartType === "bar" ? stepX / 2 : 0;
  const bars =
    chartType === "bar"
      ? columns.flatMap((column, index) => {
          let base = 0;
          return column.bands.flatMap(({ provider, value }) => {
            if (value === null || value <= 0) return [];
            const y = valueToY(base + value, scale.max);
            const height = valueToY(base, scale.max) - y;
            base += value;
            return [
              {
                provider,
                period: periods[index],
                x: index * stepX + stepX * 0.1,
                y,
                width: stepX * 0.8,
                height,
              },
            ];
          });
        })
      : [];
  const paths = (chartType === "area" ? providers : []).map((provider) => {
    const slot = columns[0]?.bands.findIndex((band) => band.provider === provider) ?? -1;
    const runs: Point[][] = [];
    let run: Point[] | null = null;
    let total = 0;
    for (const [index, column] of columns.entries()) {
      const value = column.bands[slot]?.value;
      if (value == null) {
        run = null;
      } else {
        if (run === null) {
          run = [];
          runs.push(run);
        }
        run.push({ x: index * stepX, y: valueToY(value, scale.max) });
        total += value;
      }
    }
    const lines = runs.map(curvePath);
    const areas = runs.map(
      (points, index) =>
        `${lines[index]} L${points.at(-1)!.x},${VIEW_HEIGHT} L${points[0]!.x},${VIEW_HEIGHT} Z`,
    );
    return {
      provider,
      loading: loadingProviders.has(provider),
      total,
      line: lines.join(" "),
      area: areas.join(" "),
    };
  });

  return {
    columns,
    scale,
    stepX,
    offsetX,
    bars,
    paths: paths.toSorted((a, b) => b.total - a.total),
  };
}

function UsageChartTooltip({
  tooltipRef,
  label,
  period,
  providers,
  loadingProviders,
  metric,
}: {
  readonly tooltipRef: React.Ref<HTMLDivElement>;
  readonly label: string;
  readonly period: DailyTotals | undefined;
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly metric: UsageChartMetric;
}) {
  const total = { records: 0, unpricedRecords: 0, costUsd: 0, totalTokens: 0 };
  const format = (entry: typeof total | undefined) =>
    metric === "cost" ? formatUsageCost(entry) : formatTokens(entry?.totalTokens ?? 0);
  for (const provider of providers) {
    const entry = period?.byProvider.get(provider);
    if (entry) {
      total.records += entry.records;
      total.unpricedRecords += entry.unpricedRecords;
      total.costUsd += entry.costUsd;
      total.totalTokens += entry.totalTokens;
    }
  }
  const partial = providers.some((provider) => loadingProviders.has(provider));
  return (
    <div
      ref={tooltipRef}
      className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
      style={{
        left: "var(--usage-tooltip-left, 0px)",
        top: "var(--usage-tooltip-top, 0px)",
      }}
    >
      <div className="mb-1 text-muted-foreground">{label}</div>
      {providers.map((provider) => {
        const { label: providerLabel, driverKind } = PROVIDER_PRESENTATION[provider];
        return (
          <div key={provider} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={providerLabel}
                iconClassName="size-3"
              />
              {providerLabel}
            </span>
            <span
              className={cn(
                "tabular-nums",
                loadingProviders.has(provider) ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {format(period?.byProvider.get(provider))}
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
        <span className="text-muted-foreground">{t("Total")}</span>
        <span className={cn("tabular-nums", partial ? "text-muted-foreground" : "text-foreground")}>
          {format(total)}
        </span>
      </div>
    </div>
  );
}

function UsageChartPlot({
  periods,
  byPeriod,
  stepX,
  offsetX,
  providers,
  loadingProviders,
  metric,
  formatTooltipPeriod,
  children,
}: {
  readonly periods: readonly string[];
  readonly byPeriod: ReadonlyMap<string, DailyTotals>;
  readonly stepX: number;
  readonly offsetX: number;
  readonly providers: readonly UsageProviderKind[];
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly metric: UsageChartMetric;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly children: React.ReactNode;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the hover tooltip through plot CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    const fraction = localX / bounds.width;
    const index = stepX === 0 ? 0 : Math.round((fraction * VIEW_WIDTH - offsetX) / stepX);
    hoverPositionRef.current = { x: localX, y: localY };
    positionTooltip();
    setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
  };

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];

  return (
    <div
      ref={plotRef}
      // pan-y keeps page scrolling while a sideways drag scrubs the periods on touch screens.
      className="relative h-56 flex-1 touch-pan-y"
      onPointerMove={handleMove}
      onPointerDown={handleMove}
      onPointerLeave={(event) => {
        // A lifted finger also leaves, which would hide the period it just tapped.
        if (event.pointerType === "touch") return;
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
      onPointerCancel={() => {
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {children}
        {hoverIndex === null ? null : (
          <line
            x1={hoverIndex * stepX + offsetX}
            x2={hoverIndex * stepX + offsetX}
            y1={PLOT_TOP}
            y2={VIEW_HEIGHT}
            stroke="currentColor"
            strokeWidth={1}
            className="text-muted-foreground"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {hoverIndex === null || hoveredPeriod === undefined ? null : (
        <UsageChartTooltip
          tooltipRef={tooltipRef}
          label={formatTooltipPeriod(hoveredPeriod)}
          period={byPeriod.get(hoveredPeriod)}
          providers={providers}
          loadingProviders={loadingProviders}
          metric={metric}
        />
      )}
    </div>
  );
}

export function UsageProviderChart({
  chartType,
  providers,
  loadingProviders = NONE_LOADING,
  days,
  daily,
  hours,
  hourly,
  metric,
  referenceTime,
  resolution,
  timeZone,
  hour12,
}: UsageProviderChartProps) {
  const locale = getFormattingLocale();

  const periods = resolution === "hour" ? hours : days;
  const byPeriod = usageChartPeriodIndex(daily, hourly, resolution);
  const { scale, paths, stepX, offsetX, bars } = buildChart(
    periods,
    byPeriod,
    metric,
    providers,
    loadingProviders,
    chartType,
  );

  const toY = (value: number) => valueToY(value, scale.max);
  const refreshing = providers.filter((provider) => loadingProviders.has(provider));
  const format = metric === "tokens" ? formatTokens : (value: number) => formatUsd(value, locale);
  const formatPeriod = (period: string) =>
    resolution === "hour"
      ? periods.length > 24
        ? formatDateTimeShort(period, timeZone, hour12, locale)
        : formatHourShort(period, timeZone, hour12, locale)
      : formatDayShort(period, locale);
  const formatTooltipPeriod = (period: string) =>
    resolution === "hour" && referenceTime !== undefined
      ? formatRelativeHourShort(period, referenceTime, timeZone, hour12, t, locale)
      : formatPeriod(period);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div aria-hidden className="relative h-56 w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>

        <UsageChartPlot
          periods={periods}
          byPeriod={byPeriod}
          stepX={stepX}
          offsetX={offsetX}
          providers={providers}
          loadingProviders={loadingProviders}
          metric={metric}
          formatTooltipPeriod={formatTooltipPeriod}
        >
          {scale.ticks.map((tick) => {
            const y = toY(tick);
            return (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {bars.map(({ provider, period, ...rect }) => (
            <rect
              key={`${period}:${provider}`}
              {...rect}
              fill={PROVIDER_PRESENTATION[provider].color}
            />
          ))}
          {paths.map(({ provider, area }) => (
            <path
              key={provider}
              d={area}
              fill={PROVIDER_PRESENTATION[provider].color}
              fillOpacity={0.12}
            />
          ))}
          {paths.map(({ provider, loading, line }) => (
            <path
              key={provider}
              d={line}
              fill="none"
              stroke={PROVIDER_PRESENTATION[provider].color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={loading ? "4 3" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </UsageChartPlot>
      </div>

      {refreshing.length > 0 ? (
        <p className="pl-16 text-xs text-muted-foreground">
          {updatingProvidersLabel(refreshing, (provider) => PROVIDER_PRESENTATION[provider].label)}
        </p>
      ) : null}
      <div
        aria-hidden
        className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase"
      >
        <span>{periods[0] === undefined ? "" : formatPeriod(periods[0])}</span>
        <span>
          {periods[Math.floor(periods.length / 2)] === undefined
            ? ""
            : formatPeriod(periods[Math.floor(periods.length / 2)] ?? "")}
        </span>
        <span>
          {periods[periods.length - 1] === undefined
            ? ""
            : formatPeriod(periods[periods.length - 1] ?? "")}
        </span>
      </div>

      {/* The plot and its axes are hover-only; this carries the same figures for screen readers.
          sr-only sits on a wrapper: Firefox does not clip a table's caption by the table's own box. */}
      <div className="sr-only">
        <table>
          <caption>
            {resolution === "hour"
              ? metric === "tokens"
                ? t("Hourly processed tokens by provider")
                : t("Hourly cost by provider")
              : metric === "tokens"
                ? t("Daily processed tokens by provider")
                : t("Daily cost by provider")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{resolution === "hour" ? t("Hour") : t("Day")}</th>
              {providers.map((provider) => (
                <th key={provider} scope="col">
                  {PROVIDER_PRESENTATION[provider].label}
                </th>
              ))}
              {providers.length > 1 ? <th scope="col">{t("Total")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {periods.map((period, index) => {
              const column = columns[index];
              return (
                <tr key={period}>
                  <th scope="row">{formatTooltipPeriod(period)}</th>
                  {providers.map((provider) => (
                    <td key={provider}>
                      {format(column?.bands.find((band) => band.provider === provider)?.value ?? 0)}
                    </td>
                  ))}
                  {providers.length > 1 ? <td>{format(column?.total ?? 0)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function usageChartPeriodIndex(
  daily: readonly DailyTotals[],
  hourly: readonly HourlyTotals[],
  resolution: UsageProviderChartProps["resolution"],
): ReadonlyMap<string, DailyTotals | HourlyTotals> {
  const totals: readonly (DailyTotals | HourlyTotals)[] = resolution === "hour" ? hourly : daily;
  return new Map(
    totals.map((entry) => ["hourStart" in entry ? entry.hourStart : entry.day, entry]),
  );
}
