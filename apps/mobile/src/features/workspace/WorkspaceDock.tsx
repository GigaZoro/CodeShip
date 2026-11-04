import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WORKSPACE_DOCK } from "./workspace-tabs-state";
import { visibleNavigationTabs } from "./navigation-tab-order";
import {
  NAVIGATION_TAB_ICONS,
  NAVIGATION_TAB_LABELS,
  useHiddenNavigationTabs,
  useNavigationTabOrder,
} from "./navigation-tabs";

export function WorkspaceDock(props: { readonly onNewTask: () => void }) {
  const workspace = useWorkspaceTabs()!;
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const tabs = visibleNavigationTabs(order, hidden);
  return (
    <View
      className="w-full flex-row items-center justify-between"
      style={{ gap: WORKSPACE_DOCK.gap }}
    >
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.tabWidth * tabs.length,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <View className="flex-1 flex-row p-1" accessibilityRole="tablist">
          {tabs.map((tab) => {
            const selected = workspace.state.selectedTab === tab;
            return (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={NAVIGATION_TAB_LABELS[tab]}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (selected) return;
                  Keyboard.dismiss();
                  workspace.dispatch({ type: "select", tab });
                }}
                className={
                  selected
                    ? "flex-1 items-center justify-center rounded-full bg-subtle-strong"
                    : "flex-1 items-center justify-center rounded-full"
                }
              >
                <SymbolView
                  name={NAVIGATION_TAB_ICONS[tab]}
                  size={23}
                  tintColorClassName={selected ? "accent-focus" : "accent-icon"}
                />
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.height,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={props.onNewTask}
          className="flex-1 items-center justify-center"
        >
          <SymbolView name="square.and.pencil" size={23} tintColorClassName="accent-icon" />
        </Pressable>
      </GlassSurface>
    </View>
  );
}
