import { type NavigationPageTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ScheduledTasksScreen } from "../settings/SettingsScheduledTasksRouteScreen";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: { tab: NavigationPageTab }) {
  return props.tab === "scheduledTasks" ? (
    <ScheduledTasksScreen workspace />
  ) : (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <UsageRouteScreen workspace />
    </>
  );
}
