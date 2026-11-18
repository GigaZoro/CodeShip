import type { MonitoringTimeBuckets } from "@t3tools/contracts";
import { TIME_BUCKET_KEYS } from "@t3tools/client-runtime/monitoring";
import { TIME_BUCKET_PRESENTATION } from "@t3tools/client-runtime/monitoring-text";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { t } from "../../lib/i18n";

/** The ten buckets as one bar; the legend lists every bucket, so color is never the only cue. */
export function MonitoringTimeBar(props: { readonly buckets: MonitoringTimeBuckets }) {
  const rows = TIME_BUCKET_KEYS.map((key) => ({
    key,
    label: t(TIME_BUCKET_PRESENTATION[key].label),
    color: TIME_BUCKET_PRESENTATION[key].color,
    value: props.buckets[key],
  }));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) {
    return <Text className="text-foreground-muted">{t("No time recorded yet.")}</Text>;
  }
  const visible = rows.filter((row) => row.value > 0);
  const summary = t("Where the time went: {segments}", {
    segments: visible
      .map((row) =>
        t("{label} {duration} ({percent})", {
          label: row.label,
          duration: formatDuration(row.value),
          percent: formatPercent(row.value / total, 0),
        }),
      )
      .join(", "),
  });
  return (
    <View className="gap-3">
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={summary}
        className="h-3 flex-row gap-0.5"
      >
        {visible.map((row) => (
          <View
            key={row.key}
            className="h-full rounded-sm"
            style={{
              flexGrow: row.value,
              flexShrink: 1,
              flexBasis: 0,
              minWidth: 3,
              backgroundColor: row.color,
            }}
          />
        ))}
      </View>
      <View className="gap-1.5" accessibilityElementsHidden={false}>
        {rows.map((row) => (
          <View key={row.key} className="min-h-6 flex-row items-center gap-2">
            <View className="size-2.5 rounded-sm" style={{ backgroundColor: row.color }} />
            <Text
              textRole="footnote"
              className="min-w-0 flex-1 text-foreground-muted"
              numberOfLines={1}
            >
              {row.label}
            </Text>
            <Text textRole="footnote" className="text-foreground">
              {formatDuration(row.value)}
            </Text>
            <Text textRole="footnote" className="w-10 text-right text-foreground-muted">
              {formatPercent(row.value / total, 0)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
