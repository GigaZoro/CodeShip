import { useNavigation } from "@react-navigation/native";

import { openSettings } from "../settings/settings-navigation";
import { useHiddenNavigationTabs } from "./navigation-tabs";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";

/** Opens scheduled tasks: the Tasks tab, or its Settings page while that tab is hidden. */
export function useOpenScheduledTasks() {
  const navigation = useNavigation();
  const hidden = useHiddenNavigationTabs();
  const selectTab = useSelectWorkspaceTab();
  return () =>
    hidden.includes("scheduledTasks")
      ? openSettings(navigation, "SettingsScheduledTasks")
      : selectTab("scheduledTasks");
}
