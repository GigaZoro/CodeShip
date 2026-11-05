import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, redirect, useLocation } from "@tanstack/react-router";
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
import { useEnvironments } from "../state/environments";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
} from "../components/settings/settingsSearch";

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

/** Providers lists one machine's instances; its Models tab can span machines. */
function useSingleEnvironmentSettingsPage(pathname: string) {
  const providersTab = useLocation({
    select: (location) =>
      resolveProvidersSettingsTab((location.search as { tab?: unknown }).tab, location.hash),
  });
  return (
    (pathname === "/settings/providers" && providersTab === "providers") ||
    pathname === "/settings/secrets"
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? t("{title} requires a supporting environment. Choose one to continue.", {
              title: searchTarget.title,
            })
          : t(
              "{title} requires a supporting environment. Connect or update an environment to continue.",
              { title: searchTarget.title },
            )}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {t(
          "{title} is not available for the selected target. Choose its owning scope to continue.",
          { title: searchTarget.title },
        )}
      </SettingsScopeNotice>
    );
  }
  // Maintenance mixes server sections with device ones, so it shows its own unavailable message.
  if (
    SETTINGS_DEVICE_ONLY_PATHS.has(pathname) ||
    pathname === "/settings/projects" ||
    pathname === "/settings/maintenance"
  ) {
    return children;
  }
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
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" || singleEnvironmentPage
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
          <SettingsScopeBoundary pathname={location.pathname}>
            <Outlet />
          </SettingsScopeBoundary>
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const hash = useLocation({ select: (location) => location.hash });
  const singleEnvironment = useSingleEnvironmentSettingsPage(pathname);
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={singleEnvironment}
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
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});
