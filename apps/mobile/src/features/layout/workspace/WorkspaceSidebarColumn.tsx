import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { StandaloneStack } from "../nested-stacks";
import { pageRoute } from "../route-options";
import { getCompactBrandHeaderOptions } from "./brand-header-options";

/** The iOS sidebar column hosts its own stack so it gets a native bar with the brand title. */
export function WorkspaceSidebarColumn(props: {
  readonly width: number;
  readonly children: ReactNode;
}) {
  const options = {
    ...pageRoute(),
    ...getCompactBrandHeaderOptions({ fontSize: 18, fontWeight: "800" }),
  };
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <StandaloneStack surface="sidebar" options={options}>
        {props.children}
      </StandaloneStack>
    </View>
  );
}
