import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import {
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  type NavigationTab,
} from "./navigation-tab-order";

interface NativeTabCapabilities {
  readonly supportsTasksTab?: boolean;
}

// Over-the-air JS can reach a binary built before the Tasks tab existed. Its native tab bar
// maps an unknown tab to Settings (Android) or drops it (iOS), so only binaries that report
// this constant get the tab.
function tasksTabSupported() {
  const moduleName =
    Platform.OS === "ios"
      ? "T3NativeControls"
      : Platform.OS === "android"
        ? "T3WorkspaceNavigation"
        : null;
  if (moduleName === null) return true;
  return requireOptionalNativeModule<NativeTabCapabilities>(moduleName)?.supportsTasksTab === true;
}

const UNSUPPORTED_NATIVE_TABS: readonly NavigationTab[] = tasksTabSupported()
  ? []
  : ["scheduledTasks"];

/** Tabs the installed native binary cannot draw; treated as hidden whatever the preference. */
export function unsupportedNavigationTabs(): readonly NavigationTab[] {
  return UNSUPPORTED_NATIVE_TABS;
}

/** The user's hidden tabs plus any the installed native binary cannot draw. */
export function effectiveHiddenNavigationTabs(saved: readonly unknown[] | undefined) {
  return navigationCustomizationAvailable()
    ? [...new Set([...resolveHiddenNavigationTabs(saved), ...unsupportedNavigationTabs()])]
    : [...unsupportedNavigationTabs()];
}
