import { Platform } from "react-native";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader";

import { useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";
import { t } from "../../lib/i18n";

export function AndroidWorkspaceSidebarButton() {
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  if (Platform.OS !== "android" || !layout.usesSplitView) return null;

  return (
    <AndroidHeaderIconButton
      accessibilityLabel={panes.primarySidebarVisible ? t("Maximize content") : t("Show sidebar")}
      icon={panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"}
      onPress={togglePrimarySidebar}
    />
  );
}
