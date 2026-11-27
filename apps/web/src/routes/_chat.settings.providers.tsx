import { createFileRoute, useLocation } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ModelsSettingsSection } from "../components/settings/ModelsSettings";
import {
  ProviderSettingsPanel,
  ScopedAccountFailoverSettings,
} from "../components/settings/ProviderSettingsPanel";
import {
  PROVIDERS_SETTINGS_TABS,
  resolveProvidersSettingsTab,
  type ProvidersSettingsTab,
} from "../components/settings/providersSettingsTab";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";

import { msg, t, type Message } from "~/i18n";
const TAB_LABELS: Record<ProvidersSettingsTab, Message> = {
  providers: msg("Providers"),
  models: msg("Models"),
};

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const navigate = Route.useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const tab = resolveProvidersSettingsTab(target.tab, hash);
  const { environment, scope } = useSettingsScope();
  const projectIds = (machineId: EnvironmentId) =>
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members
          .filter((member) => member.environmentId === machineId)
          .map((member) => member.id)
      : [];
  const tabs = (
    <ToggleGroup
      aria-label={t("Providers or models")}
      className="self-start"
      value={[tab]}
      onValueChange={(next) => {
        const chosen = PROVIDERS_SETTINGS_TABS.find((candidate) => candidate === next[0]);
        // Pressing the open tab again reports no value; it stays open.
        if (chosen === undefined) return;
        void navigate({
          search: ({ tab: _previousTab, ...rest }) =>
            chosen === "models" ? { ...rest, tab: "models" as const } : rest,
          hash: "",
          replace: true,
          resetScroll: false,
        });
      }}
    >
      {PROVIDERS_SETTINGS_TABS.map((candidate) => (
        <Toggle key={candidate} value={candidate}>
          {t(TAB_LABELS[candidate])}
        </Toggle>
      ))}
    </ToggleGroup>
  );

  if (tab === "models") {
    return (
      <ProviderSettingsPanel view="models" machineSections={false}>
        {tabs}
        <ModelsSettingsSection />
        <ScopedAccountFailoverSettings />
      </ProviderSettingsPanel>
    );
  }

  if (!environment) {
    return (
      <SettingsPageContainer>
        {tabs}
        <p className="text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? t("Reconnect {label} to set up its providers.", { label: scope.label })
            : t("Connect an environment to set up its providers.")}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <ProviderSettingsPanel
      view="providers"
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      projectIds={projectIds(environment.environmentId)}
    >
      {tabs}
    </ProviderSettingsPanel>
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
    ...(raw.tab === "models" ? { tab: "models" as const } : {}),
  }),
  component: SettingsProvidersRoute,
});
