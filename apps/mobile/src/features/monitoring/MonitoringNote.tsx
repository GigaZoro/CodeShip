import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function MonitoringNote(props: { readonly text: string; readonly action?: ReactNode }) {
  return (
    <View className="gap-2 rounded-2xl bg-grouped-card p-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {props.text}
      </Text>
      {props.action}
    </View>
  );
}
