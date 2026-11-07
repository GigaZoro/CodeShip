import { machineAccent } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "./ui/AppText";

/** A machine's initial on its own colour, so machines with the same name and icon look apart. */
export function MachineBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly size: number;
}) {
  const accent = machineAccent(props.environmentId, props.label);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: "center",
        backgroundColor: accent.color,
        borderRadius: Math.round(props.size / 4),
        height: props.size,
        justifyContent: "center",
        width: props.size,
      }}
    >
      <Text
        allowFontScaling={false}
        className="font-t3-bold"
        style={{
          color: "#ffffff",
          fontSize: Math.round(props.size * 0.62),
          lineHeight: props.size,
        }}
      >
        {accent.initial}
      </Text>
    </View>
  );
}
