import { createFileRoute, useLocation } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProjectDefaultsSettings } from "../components/settings/ProjectDefaultsSettings";
import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import {
  PROVIDERS_SETTINGS_TABS,
  resolveProvidersSettingsTab,
  type ProvidersSettingsTab,
} from "../components/settings/providersSettingsTab";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { TextGenerationSettingsSection } from "../components/settings/SettingsPanels";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SourceControlWritingSettingsSection } from "../components/settings/SourceControlWritingSettings";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";

const MACHINE_SECTION_TARGETS: ReadonlySet<string> = new Set([
  "account-failover",
  "delegated-task-models",
  "final-review",
]);

const TAB_LABELS: Record<ProvidersSettingsTab, string> = {
  providers: "Providers",
  models: "Models",
};

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const navigate = Route.useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const tab = resolveProvidersSettingsTab(target.tab, hash);
  const { environment, connectedEnvironments, scope } = useSettingsScope();
  const projectIds = (machineId: EnvironmentId) =>
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members
          .filter((member) => member.environmentId === machineId)
          .map((member) => member.id)
      : [];
  const tabs = (
    <ToggleGroup
      aria-label="Providers or models"
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
          {TAB_LABELS[candidate]}
        </Toggle>
      ))}
    </ToggleGroup>
  );

  if (tab === "models") {
    // Auto mode, delegated tasks, and final review depend on one machine's providers and accounts.
    const machine = connectedEnvironments.length === 1 ? (connectedEnvironments[0] ?? null) : null;
    const targetId = hash.replace(/^#/, "");
    const machineNoticeFirst = machine === null && MACHINE_SECTION_TARGETS.has(targetId);
    const machineNotice = (
      <SettingsScopeNotice
        inline
        target="environment"
        {...(MACHINE_SECTION_TARGETS.has(targetId) ? { targetId } : {})}
      >
        {connectedEnvironments.length === 0
          ? "Connect an environment to set Auto mode, delegated tasks, and final review models."
          : "Auto mode, delegated tasks, and final review use one machine's providers and accounts. Choose a machine to set them."}
      </SettingsScopeNotice>
    );
    return (
      <ProviderSettingsPanel
        view="models"
        machineSections={machine !== null}
        {...(machine ? { environmentId: machine.environmentId } : {})}
        projectIds={machine ? projectIds(machine.environmentId) : []}
      >
        {tabs}
        {machineNoticeFirst ? machineNotice : null}
        <ProjectDefaultsSettings category="models" />
        <TextGenerationSettingsSection />
        <SourceControlWritingSettingsSection part="models" />
        {machine === null && !machineNoticeFirst ? machineNotice : null}
      </ProviderSettingsPanel>
    );
  }

  if (!environment) {
    return (
      <SettingsPageContainer>
        {tabs}
        <p className="text-sm text-muted-foreground">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to set up its providers.`
            : "Connect an environment to set up its providers."}
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
