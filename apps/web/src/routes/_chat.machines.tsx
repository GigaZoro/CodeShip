import { createFileRoute } from "@tanstack/react-router";

import { MachineResourcesCard } from "../components/machines/MachineResources";
import { useSidebarMachines } from "../components/sidebar/useSidebarMachines";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";

import { t } from "~/i18n";

function MachinesRoute() {
  const machines = useSidebarMachines();
  return (
    <SidebarInset
      {...workspaceAreaProps("machines-page", 1, t("Machines"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={t("Machines breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1>{t("Machines")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-5xl">
          {machines.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("No machines connected")}</EmptyTitle>
                <EmptyDescription>
                  {t("Add a machine in Settings → Machines & access to see its resources.")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
              {machines.map((machine) => (
                <MachineResourcesCard key={machine.environmentId} machine={machine} />
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/machines")({
  component: MachinesRoute,
});
