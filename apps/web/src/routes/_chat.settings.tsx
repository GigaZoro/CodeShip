import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { hasRestorableSettings } from "../components/settings/SettingsPanels.logic";
import { resolveProvidersSettingsTab } from "../components/settings/providersSettingsTab";

import { isElectron } from "../env";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { useSidebarPanel } from "../components/sidebar/mainAppLocation";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  redirectMovedSettingsLocation,
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import type { SettingsScopeSearch } from "../components/settings/settingsScope";

import { t } from "~/i18n";
function ResetPageButton({ page, onRestored }: { page: string; onRestored: () => void }) {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(page, onRestored);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">{t("Reset page")}</span>
    </Button>
  );
}

function useProvidersTab() {
  return useLocation({
    select: (location) =>
      resolveProvidersSettingsTab((location.search as { tab?: unknown }).tab, location.hash),
  });
}

/** Providers lists one machine's instances (its Models tab can span machines); Secrets and Diagnostics also act on one. */
function useSingleEnvironmentSettingsPage(pathname: string) {
  const providersTab = useProvidersTab();
  return (
    (pathname === "/settings/providers" && providersTab === "providers") ||
    pathname === "/settings/secrets" ||
    pathname === "/settings/diagnostics"
  );
}

/** Pages that show things for a machine or project; every other page's rows pick their own scope. */
function useSettingsViewFilter(pathname: string, project: string | undefined) {
  const providersTab = useProvidersTab();
  if (pathname === "/settings/keybindings" || pathname === "/settings/diagnostics") {
    return "machine";
  }
  if (
    pathname === "/settings/secrets" ||
    (pathname === "/settings/providers" && providersTab === "providers") ||
    (pathname === "/settings/projects" && project !== undefined)
  ) {
    return "project-and-machine";
  }
  return null;
}

function SettingsScopeBoundary({ children }: { children: ReactNode }) {
  const { scope, connectedEnvironments, viewFilter } = useSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  // The projects page explains its own unavailable project.
  if (viewFilter === null || pathname === "/settings/projects") return children;
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {t("Reconnect {label} to change its settings.", { label: scope.label })}
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const contentArea = workspaceAreaProps("settings", 1, t("Settings content"));
  const location = useLocation();
  const { search, environment } = useSettingsScope();
  const singleEnvironmentPage = useSingleEnvironmentSettingsPage(location.pathname);
  const contentScopeKey = singleEnvironmentPage
    ? environment?.environmentId
    : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);
  // The providers reset covers Models-tab rows only.
  const showReset =
    hasRestorableSettings(location.pathname) &&
    (location.pathname !== "/settings/providers" ||
      resolveProvidersSettingsTab((location.search as { tab?: unknown }).tab, location.hash) ===
        "models");
  const settingsNavInSidebar = useSidebarPanel() === "settings";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <SettingsBreadcrumb pathname={location.pathname} />
        {showReset ? (
          <div className="ms-auto flex shrink-0 items-center">
            <ResetPageButton
              page={location.pathname}
              onRestored={() => setRestoreSignal((value) => value + 1)}
            />
          </div>
        ) : null}
      </WorkspacePageHeader>
      <div className="relative flex min-h-0 flex-1">
        {settingsNavInSidebar ? null : <SettingsSidebarNav pathname={location.pathname} />}
        <div
          {...contentArea}
          key={`${contentScopeKey}:${restoreSignal}`}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <SettingsScopeBoundary>
            <Outlet />
          </SettingsScopeBoundary>
        </div>
      </div>
    </SidebarInset>
  );
}

const EVERY_MACHINE_SEARCH: SettingsScopeSearch = {};

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const singleEnvironment = useSingleEnvironmentSettingsPage(pathname);
  const viewFilter = useSettingsViewFilter(pathname, rawSearch.project);
  return (
    <SettingsScopeProvider
      search={
        viewFilter !== null || pathname === "/settings/projects" ? rawSearch : EVERY_MACHINE_SEARCH
      }
      singleEnvironment={singleEnvironment}
      viewFilter={viewFilter}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: (previous) => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
            // The Models tab is part of the page, not of the scope; resolve it like the page does.
            ...(pathname === "/settings/providers" &&
            resolveProvidersSettingsTab((previous as { tab?: unknown }).tab, hash) === "models"
              ? { tab: "models" as const }
              : {}),
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: ({ location }) => redirectMovedSettingsLocation(location),
  component: SettingsRouteLayout,
});
