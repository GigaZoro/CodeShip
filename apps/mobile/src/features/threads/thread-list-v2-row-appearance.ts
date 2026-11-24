import type { InterfaceDensity } from "@t3tools/contracts/settings";
import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";
import { t } from "../../lib/i18n";

export const THREAD_LIST_V2_MONO_FONT = "Menlo";

/**
 * Compact tightens only the padding. The minimum is in points, not rem (Uniwind's rem is 14),
 * so every row clears 44pt (iOS) / 48dp (Android) whatever its content.
 */
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAMES = {
  comfortable: { ios: "min-h-[44px] px-5 py-2.5", android: "min-h-[48px] px-5 py-2.5" },
  compact: { ios: "min-h-[44px] px-5 py-1.5", android: "min-h-[48px] px-5 py-1.5" },
} as const satisfies Record<InterfaceDensity, Record<"ios" | "android", string>>;
export const THREAD_LIST_V2_SLIM_ROW_CLASS_NAMES = {
  comfortable: "py-2",
  compact: "py-1",
} as const satisfies Record<InterfaceDensity, string>;
export const THREAD_LIST_V2_ESTIMATED_ROW_HEIGHTS = {
  comfortable: 72,
  compact: 64,
} as const satisfies Record<InterfaceDensity, number>;
export const THREAD_LIST_V2_ROW_DIVIDERS = true;
export const THREAD_LIST_V2_SIDEBAR_ROW_STYLE = {
  borderRadius: 12,
  paddingHorizontal: 12,
  paddingVertical: 10,
} satisfies ViewStyle;
export const THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE = {
  borderRadius: 12,
  overflow: "hidden",
} satisfies ViewStyle;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(_branch: string) {
  return t("New thread on branch");
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const style: ViewStyle | undefined = sidebarPane
    ? {
        backgroundColor: selected ? selectedBackgroundColor : theme["--color-drawer"],
        borderRadius: THREAD_LIST_V2_SIDEBAR_ROW_STYLE.borderRadius,
      }
    : undefined;
  const swipeContainerStyle: ViewStyle | undefined = sidebarPane
    ? THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE
    : undefined;

  return {
    className: sidebarPane ? undefined : "bg-screen",
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: sidebarPane ? { ...style, ...THREAD_LIST_V2_SIDEBAR_ROW_STYLE } : undefined,
    swipeContainerStyle,
    swipeBackgroundColor: theme[sidebarPane ? "--color-drawer" : "--color-screen"],
    providerIconSurfaceColor: sidebarPane
      ? selected
        ? selectedBackgroundColor
        : theme["--color-drawer"]
      : theme["--color-screen"],
  };
}
