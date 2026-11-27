import { t } from "~/i18n";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, useLocation, useRouter } from "@tanstack/react-router";
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
import { useRenderedSettingsPathname } from "../components/settings/useRenderedSettingsPathname";
import {
  redirectMovedSettingsLocation,
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
} from "../components/settings/settingsSearch";

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

/** Providers lists one machine's instances (its Models tab can span machines); Secrets and Diagnostics also act on one. */
function useSingleEnvironmentSettingsPage(pathname: string) {
  const providersTab = useLocation({
    select: (location) =>
      resolveProvidersSettingsTab((location.search as { tab?: unknown }).tab, location.hash),
  });
  return (
    (pathname === "/settings/providers" && providersTab === "providers") ||
    pathname === "/settings/secrets" ||
    pathname === "/settings/diagnostics"
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();

  // A pending navigation's hash targets the page still loading, not the one on screen.
  const hash = useLocation({
    select: (location) => (location.pathname === pathname ? location.hash : ""),
  });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const agentFeedbackAvailability = searchTarget?.agentFeedbackOnly
    ? {
        eligibleEnvironmentIds: environments
          .filter(
            (environment) =>
              environment.connection.phase === "connected" &&
              environment.serverConfig?.environment.capabilities.agentFeedback === true,
          )
          .map((environment) => environment.environmentId),
        isTargetAvailable:
          connectedEnvironments.length > 0 &&
          connectedEnvironments.every(
            (environment) =>
              environment.serverConfig?.environment.capabilities.agentFeedback === true,
          ),
      }
    : null;
  const targetAvailability =
    agentFeedbackAvailability ??
    (searchTarget?.requiresThreadAutoSettlement
      ? getThreadAutoSettlementSearchAvailability(environments, scope)
      : null);
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    targetAvailability &&
    !targetAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={targetAvailability.eligibleEnvironmentIds}
      >
        {targetAvailability.eligibleEnvironmentIds.length > 0
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
  const pathname = useRenderedSettingsPathname();
  const { search, environment } = useSettingsScope();
  const singleEnvironmentPage = useSingleEnvironmentSettingsPage(pathname);
  const contentScopeKey = singleEnvironmentPage
    ? environment?.environmentId
    : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);
  // The providers reset covers Models-tab rows only.
  const showReset =
    hasRestorableSettings(pathname) &&
    (pathname !== "/settings/providers" ||
      resolveProvidersSettingsTab((location.search as { tab?: unknown }).tab, location.hash) ===
        "models");
  const settingsNavInSidebar = useSidebarPanel() === "settings";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <SettingsBreadcrumb pathname={pathname} />
        {showReset ? (
          <div className="ms-auto flex shrink-0 items-center">
            <ResetPageButton
              page={pathname}
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
          <SettingsScopeBoundary pathname={pathname}>
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
  const pathname = useRenderedSettingsPathname();
  const hash = useLocation({ select: (location) => location.hash });
  const singleEnvironment = useSingleEnvironmentSettingsPage(pathname);
  const router = useRouter();
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={singleEnvironment}
      deviceOnly={SETTINGS_DEVICE_ONLY_PATHS.has(pathname)}
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: router.state.location.pathname,
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
