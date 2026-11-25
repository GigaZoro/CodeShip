import type {
  MonitoringMarkerKind,
  MonitoringSegmentStatus,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import { detailExtent, formatMonitoringTime } from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveHour12 } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  MARKER_PRESENTATION,
  SEGMENT_STATUS_LABEL,
  modelColor,
} from "@t3tools/client-runtime/monitoring-text";
import { MonitoringTruncated } from "./MonitoringSection";
import { t, tn } from "~/i18n";

const AXIS_TICKS = 4;
const HATCH = "repeating-linear-gradient(135deg, rgb(0 0 0 / 0.38) 0 3px, transparent 3px 7px)";
const LIGHT_HATCH =
  "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.55) 0 3px, transparent 3px 7px)";

/** Status reads from outline and fill pattern as well as the tooltip, never from color alone. */
function segmentStyle(status: MonitoringSegmentStatus, color: string) {
  switch (status) {
    case "failed":
      return { backgroundColor: color, backgroundImage: HATCH, outline: "2px solid #dc2626" };
    case "interrupted":
      return { backgroundColor: color, outline: "2px dashed currentColor" };
    case "cancelled":
      return { backgroundColor: color, opacity: 0.4 };
    case "running":
      return { backgroundColor: color, backgroundImage: LIGHT_HATCH };
    case "completed":
      return { backgroundColor: color };
  }
}

/** Pairs each item with a key that stays unique when two items share the same identity. */
function keyed<T>(items: ReadonlyArray<T>, identity: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = identity(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count === 0 ? base : `${base}#${count}`, item };
  });
}

const STATUS_ORDER: ReadonlyArray<MonitoringSegmentStatus> = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "running",
];

export function MonitoringGantt({ detail }: { readonly detail: MonitoringThreadDetail }) {
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const { lanes, markers, omitted } = detail;
  const { start, span } = detailExtent(detail);
  const percent = (instant: string) => ((Date.parse(instant) - start) / span) * 100;

  const models = [...new Set(lanes.flatMap((lane) => (lane.model ? [lane.model] : [])))];
  const markerKinds = [...new Set(markers.map((marker) => marker.kind))];
  const statuses = STATUS_ORDER.filter((status) =>
    lanes.some((lane) => lane.segments.some((segment) => segment.status === status)),
  );

  if (lanes.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No runs recorded for this chat.")}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="group"
        aria-label={t("Timeline of runs and helpers, {duration} in total", {
          duration: formatDuration(span),
        })}
        className="grid min-w-0 grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1"
      >
        <div />
        <div className="relative h-4" role="group" aria-label={t("Markers")}>
          {keyed(markers, (marker) => `${marker.at}-${marker.kind}`).map(
            ({ key, item: marker }) => (
              <MarkerTick
                key={key}
                kind={marker.kind}
                left={percent(marker.at)}
                label={t(MARKER_PRESENTATION[marker.kind].label)}
                at={marker.at}
                offsetMs={Date.parse(marker.at) - start}
                detail={marker.detail}
                hour12={hour12}
              />
            ),
          )}
        </div>
        {lanes.map((lane) => (
          <LaneRow key={lane.id} lane={lane} start={start} span={span} hour12={hour12} />
        ))}
        <div />
        <div className="relative h-4 text-xs text-muted-foreground" aria-hidden>
          {Array.from({ length: AXIS_TICKS + 1 }, (_, index) => (
            <span
              key={index}
              className={cn(
                "absolute whitespace-nowrap tabular-nums",
                index === AXIS_TICKS ? "-translate-x-full" : index > 0 && "-translate-x-1/2",
              )}
              style={{ left: `${(index / AXIS_TICKS) * 100}%` }}
            >
              {index === 0 ? "0" : `+${formatDuration((span / AXIS_TICKS) * index)}`}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        {omitted.lanes > 0 ? (
          <p>{tn(omitted.lanes, "{count} helper not shown", "{count} helpers not shown")}</p>
        ) : null}
        {omitted.markers > 0 ? (
          <p>{tn(omitted.markers, "{count} marker not shown", "{count} markers not shown")}</p>
        ) : null}
        {models.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t("Models")}>
            {models.map((model) => (
              <li key={model} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-xs"
                  style={{ backgroundColor: modelColor(model) }}
                />
                {model}
              </li>
            ))}
          </ul>
        ) : null}
        {statuses.length > 1 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t("Segment status")}>
            {statuses.map((status) => (
              <li key={status} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-2.5 w-5 rounded-xs text-foreground"
                  style={segmentStyle(status, "#8b8b8b")}
                />
                {t(SEGMENT_STATUS_LABEL[status])}
              </li>
            ))}
          </ul>
        ) : null}
        {markerKinds.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t("Marker kinds")}>
            {markerKinds.map((kind) => (
              <li key={kind} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-3 w-1 rounded-full"
                  style={{ backgroundColor: MARKER_PRESENTATION[kind].color }}
                />
                {t(MARKER_PRESENTATION[kind].label)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function MarkerTick({
  kind,
  left,
  label,
  at,
  offsetMs,
  detail,
  hour12,
}: {
  readonly kind: MonitoringMarkerKind;
  readonly left: number;
  readonly label: string;
  readonly at: string;
  readonly offsetMs: number;
  readonly detail: string | null;
  readonly hour12: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={t("{label} at +{offset}", { label, offset: formatDuration(offsetMs) })}
            className="absolute inset-y-0 w-2 -translate-x-1/2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ left: `${left}%` }}
          >
            <span
              aria-hidden
              className="mx-auto block h-full w-0.5 rounded-full"
              style={{ backgroundColor: MARKER_PRESENTATION[kind].color }}
            />
          </button>
        }
      />
      <TooltipPopup>
        <span className="block font-medium">{label}</span>
        <span className="block">
          +{formatDuration(offsetMs)} · {formatMonitoringTime(at, hour12)}
        </span>
        {detail ? <span className="block max-w-64 break-words">{detail}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function LaneRow({
  lane,
  start,
  span,
  hour12,
}: {
  readonly lane: MonitoringThreadDetail["lanes"][number];
  readonly start: number;
  readonly span: number;
  readonly hour12: boolean;
}) {
  const color = modelColor(lane.model);
  return (
    <>
      <div className="flex min-w-0 flex-col justify-center text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-xs"
            style={{ backgroundColor: color }}
          />
          <MonitoringTruncated text={lane.label} className="text-foreground" />
        </div>
        {lane.omittedSegments > 0 ? (
          <span className="text-muted-foreground">
            {tn(
              lane.omittedSegments,
              "{count} shorter run not shown",
              "{count} shorter runs not shown",
            )}
          </span>
        ) : null}
      </div>
      <div className="relative h-6 rounded-sm bg-muted/50 text-foreground">
        {keyed(lane.segments, (segment) => `${segment.startedAt}-${segment.completedAt}`).map(
          ({ key, item: segment }) => {
            const from = Date.parse(segment.startedAt);
            const duration = Math.max(0, Date.parse(segment.completedAt) - from);
            const status = t(SEGMENT_STATUS_LABEL[segment.status]);
            return (
              <Tooltip key={key}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("{lane}: {status}, {duration}, started at +{offset}", {
                        lane: lane.label,
                        status,
                        duration: formatDuration(duration),
                        offset: formatDuration(from - start),
                      })}
                      className="absolute inset-y-1 min-w-[3px] rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      style={{
                        left: `${((from - start) / span) * 100}%`,
                        width: `${(duration / span) * 100}%`,
                        ...segmentStyle(segment.status, color),
                      }}
                    />
                  }
                />
                <TooltipPopup>
                  <span className="block font-medium">{lane.label}</span>
                  {lane.model ? <span className="block">{lane.model}</span> : null}
                  <span className="block">
                    {status} · {formatDuration(duration)}
                  </span>
                  <span className="block text-muted-foreground">
                    +{formatDuration(from - start)} ·{" "}
                    {formatMonitoringTime(segment.startedAt, hour12)}
                  </span>
                  {lane.tokens !== null ? (
                    <span className="block text-muted-foreground">
                      {t("{count} tokens", { count: formatTokens(lane.tokens) })}
                    </span>
                  ) : null}
                </TooltipPopup>
              </Tooltip>
            );
          },
        )}
      </div>
    </>
  );
}
