import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function MonitoringKpi(props: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${props.label}: ${props.value}${props.hint ? `, ${props.hint}` : ""}`}
      className="min-w-[44%] flex-1 gap-0.5 rounded-2xl bg-grouped-card p-3"
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <Text textRole="title" className="font-t3-bold text-foreground">
        {props.value}
      </Text>
      {props.hint ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}
