import { createFileRoute } from "@tanstack/react-router";

import { ManualStepsPageContent } from "../components/manualSteps/ManualSteps";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { workspaceAreaProps } from "../lib/workspaceFocus";

import { t } from "~/i18n";

function ManualStepsRoute() {
  return (
    <SidebarInset
      {...workspaceAreaProps("manual-steps-page", 1, t("Manual steps"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={t("Manual steps breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1>{t("Manual steps")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          <ManualStepsPageContent />
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/manual-steps")({
  validateSearch: (raw: Record<string, unknown>): { step?: string } =>
    typeof raw.step === "string" && raw.step ? { step: raw.step.slice(0, 200) } : {},
  component: ManualStepsRoute,
});
