import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateSettingsScopeSearch } from "../components/settings/settingsScope";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";

function ArchivedRoute() {
  const scopeSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset
      {...workspaceAreaProps("archived", 1, "Archived threads")}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <SettingsScopeProvider
        search={scopeSearch}
        onChange={(next) => {
          void navigate({
            to: "/archived",
            search: () => ({
              project: next.project,
              machine: next.machine,
              checkout: next.checkout,
            }),
            resetScroll: false,
          });
        }}
      >
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Archived threads breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1>Archived threads</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ArchivedThreadsPanel />
      </SettingsScopeProvider>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/archived")({
  validateSearch: validateSettingsScopeSearch,
  component: ArchivedRoute,
});
