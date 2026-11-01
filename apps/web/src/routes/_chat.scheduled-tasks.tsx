import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { SidebarInset } from "../components/ui/sidebar";

function ScheduledTasksRoute() {
  const { environmentId, taskId, ...scopeSearch } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <SettingsScopeProvider
        search={scopeSearch}
        onChange={(next) => {
          // Replacing the whole search also drops a task link's environmentId and taskId.
          void navigate({
            to: "/scheduled-tasks",
            search: () => ({
              project: next.project,
              machine: next.machine,
              checkout: next.checkout,
            }),
            resetScroll: false,
          });
        }}
      >
        <ScheduledTasksSettings environmentId={environmentId} taskId={taskId} />
      </SettingsScopeProvider>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: ScheduledTasksRoute,
});
