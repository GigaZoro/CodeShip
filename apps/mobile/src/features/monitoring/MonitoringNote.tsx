import { useEffect, type ReactNode } from "react";
import { AccessibilityInfo, Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function MonitoringNote(props: {
  readonly text: string;
  readonly action?: ReactNode;
  readonly announce?: boolean;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces changes through the native accessibility service
  useEffect(() => {
    if (props.announce && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibilityWithOptions(props.text, { queue: true });
    }
  }, [props.announce, props.text]);
  return (
    <View className="gap-2 rounded-2xl bg-grouped-card p-3">
      <Text
        textRole="footnote"
        className="text-foreground-muted"
        accessibilityLiveRegion={props.announce ? "polite" : "none"}
      >
        {props.text}
      </Text>
      {props.action}
    </View>
  );
}
