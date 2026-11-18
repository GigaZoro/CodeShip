import type {
  MonitoringLane,
  MonitoringMarkerKind,
  MonitoringSegmentStatus,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  LANE_KIND_LABEL,
  MARKER_PRESENTATION,
  SEGMENT_STATUS_LABEL,
  modelColor,
} from "@t3tools/client-runtime/monitoring-text";
import { detailExtent } from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { t, tn } from "../../lib/i18n";

const STATUS_ORDER: ReadonlyArray<MonitoringSegmentStatus> = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "running",
];
const FAILED_COLOR = "#dc2626";

/** Status shows as border style and opacity as well as in the legend, never from color alone. */
function segmentStyle(status: MonitoringSegmentStatus, color: string) {
  switch (status) {
    case "failed":
      return { backgroundColor: color, borderWidth: 2, borderColor: FAILED_COLOR };
    case "interrupted":
      return {
        backgroundColor: color,
        borderWidth: 2,
        borderColor: "#71717a",
        borderStyle: "dashed" as const,
      };
    case "cancelled":
      return { backgroundColor: color, opacity: 0.4 };
    case "running":
      return { backgroundColor: color, borderWidth: 2, borderColor: "#ffffff", opacity: 0.75 };
    case "completed":
      return { backgroundColor: color };
  }
}

function laneLabel(lane: MonitoringLane) {
  let activeMs = 0;
  let failed = 0;
  for (const segment of lane.segments) {
    activeMs += Math.max(0, Date.parse(segment.completedAt) - Date.parse(segment.startedAt));
    if (segment.status === "failed") failed += 1;
  }
  const heading = [lane.label, t(LANE_KIND_LABEL[lane.kind]), lane.model]
    .filter(Boolean)
    .join(", ");
  const facts = [
    tn(lane.segments.length + lane.omittedSegments, "{count} run", "{count} runs"),
    t("{duration} active", { duration: formatDuration(activeMs) }),
    failed > 0 ? t("{failed} failed", { failed }) : null,
    lane.omittedSegments > 0 ? omittedRuns(lane.omittedSegments) : null,
  ];
  return `${heading}: ${facts.filter(Boolean).join(", ")}`;
}

const omittedRuns = (count: number) =>
  tn(count, "{count} shorter run not shown", "{count} shorter runs not shown");

function markerSummary(markers: MonitoringThreadDetail["markers"]) {
  const counts = new Map<MonitoringMarkerKind, number>();
  for (const marker of markers) counts.set(marker.kind, (counts.get(marker.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => `${t(MARKER_PRESENTATION[kind].label)} ${count}`)
    .join(", ");
}

/** Compact lanes: one row per run lane or helper, segments placed by percentage of the chat's span. */
export function MonitoringTimeline(props: { readonly detail: MonitoringThreadDetail }) {
  const { lanes, markers, omitted } = props.detail;
  if (lanes.length === 0) {
    return <Text className="text-foreground-muted">{t("No runs recorded for this chat.")}</Text>;
  }
  const { start, span } = detailExtent(props.detail);
  const percent = (instant: string) =>
    Math.min(100, Math.max(0, ((Date.parse(instant) - start) / span) * 100));

  const models = [...new Set(lanes.flatMap((lane) => (lane.model ? [lane.model] : [])))];
  const markerKinds = [...new Set(markers.map((marker) => marker.kind))];
  const statuses = STATUS_ORDER.filter((status) =>
    lanes.some((lane) => lane.segments.some((segment) => segment.status === status)),
  );

  return (
    <View className="gap-3">
      <View className="gap-1.5">
        <View
          accessible={markers.length > 0}
          accessibilityLabel={`${t("Markers")}: ${markerSummary(markers)}`}
          className="h-3"
        >
          {markers.map((marker) => (
            <View
              key={`${marker.at}-${marker.kind}`}
              className="absolute top-0 h-3 w-1 rounded-sm"
              style={{
                left: `${percent(marker.at)}%`,
                backgroundColor: MARKER_PRESENTATION[marker.kind].color,
              }}
            />
          ))}
        </View>
        {lanes.map((lane) => {
          const color = modelColor(lane.model);
          return (
            <View key={lane.id} accessible accessibilityLabel={laneLabel(lane)} className="gap-0.5">
              <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                {lane.label}
              </Text>
              <View className="h-4 rounded-sm bg-secondary">
                {lane.segments.map((segment) => {
                  const left = percent(segment.startedAt);
                  const right = percent(segment.completedAt);
                  return (
                    <View
                      key={`${segment.startedAt}-${segment.completedAt}`}
                      className="absolute top-0 h-4 rounded-sm"
                      style={[
                        { left: `${left}%`, width: `${Math.max(right - left, 1)}%`, minWidth: 3 },
                        segmentStyle(segment.status, color),
                      ]}
                    />
                  );
                })}
              </View>
              {lane.omittedSegments > 0 ? (
                <Text textRole="footnote" className="text-foreground-muted">
                  {omittedRuns(lane.omittedSegments)}
                </Text>
              ) : null}
            </View>
          );
        })}
        <View
          accessible
          accessibilityLabel={t("Timeline of runs and helpers, {duration} in total", {
            duration: formatDuration(span),
          })}
          className="flex-row justify-between"
        >
          <Text textRole="footnote" className="text-foreground-muted">
            0
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {`+${formatDuration(span)}`}
          </Text>
        </View>
      </View>
      <View className="gap-1.5">
        {omitted.lanes > 0 ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {tn(omitted.lanes, "{count} helper not shown", "{count} helpers not shown")}
          </Text>
        ) : null}
        {omitted.markers > 0 ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {tn(omitted.markers, "{count} marker not shown", "{count} markers not shown")}
          </Text>
        ) : null}
        {models.map((model) => (
          <View key={model} className="flex-row items-center gap-2">
            <View className="size-2.5 rounded-sm" style={{ backgroundColor: modelColor(model) }} />
            <Text
              textRole="footnote"
              className="min-w-0 flex-1 text-foreground-muted"
              numberOfLines={1}
            >
              {model}
            </Text>
          </View>
        ))}
        {statuses.map((status) => (
          <Text key={status} textRole="footnote" className="text-foreground-muted">
            {statusGlyph(status)} {t(SEGMENT_STATUS_LABEL[status])}
          </Text>
        ))}
        {markerKinds.map((kind) => (
          <View key={kind} className="flex-row items-center gap-2">
            <View
              className="h-3 w-1 rounded-sm"
              style={{ backgroundColor: MARKER_PRESENTATION[kind].color }}
            />
            <Text textRole="footnote" className="text-foreground-muted">
              {t(MARKER_PRESENTATION[kind].label)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function statusGlyph(status: MonitoringSegmentStatus) {
  switch (status) {
    case "completed":
      return "■";
    case "failed":
      return "▣";
    case "interrupted":
      return "▫";
    case "cancelled":
      return "▒";
    case "running":
      return "▷";
  }
}
