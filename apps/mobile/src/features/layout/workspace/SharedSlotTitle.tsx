import { msg, t } from "../../../lib/i18n";
import { Platform, Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { isSharedSlotTab, type SharedSlotTab } from "./navigation-tab-order";
import { supportsIssuesTab } from "./native-tab-support";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

const TITLES = {
  pullRequests: msg("Pull requests"),
  issues: msg("Issues"),
} as const;

/** The header title of the tab pull requests and issues share: names the list and switches it. */
export function SharedSlotTitle(props: { readonly tab: SharedSlotTab }) {
  const selectTab = useSelectWorkspaceTab();
  const { scale } = useAndroidControlSizing();
  const title = (
    <Text
      allowFontScaling={Platform.OS === "ios"}
      maxFontSizeMultiplier={1.4}
      numberOfLines={1}
      className="font-t3-bold text-foreground"
      style={{ fontSize: 20 * scale, letterSpacing: -0.4 * scale }}
    >
      {t(TITLES[props.tab])}
    </Text>
  );
  if (!supportsIssuesTab) return title;
  return (
    <Menu
      actions={Object.entries(TITLES).map(([id, title]) => ({
        id,
        title: t(title),
        state: id === props.tab ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const id = nativeEvent.event;
        if (isSharedSlotTab(id) && id !== props.tab) selectTab(id);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("{list}, switch list", { list: t(TITLES[props.tab]) })}
        hitSlop={8}
        className="flex-row items-center gap-1.5"
      >
        {title}
        <SymbolView
          name="chevron.down"
          size={Math.round(12 * scale)}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </Menu>
  );
}
