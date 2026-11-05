import { useAtomValue } from "@effect/atom-react";
import {
  isManagedDriverAllowed,
  type ProviderMcpServer,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

/** Skill lists run to hundreds of entries; only the first few render until expanded. */
const MAX_SKILLS_SHOWN = 25;

const MCP_STATUS_LABELS = {
  connected: "Connected",
  needsAuth: "Needs sign-in",
  failed: "Failed",
  starting: "Starting",
  disabled: "Turned off",
  notConfigured: "Not set up",
} as const satisfies Record<ProviderMcpServer["status"], string>;

/** Read-only: what each agent on an environment can reach. Changes are made in web or desktop. */
export function SettingsCapabilitiesRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Capabilities" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.flatMap((environment) => {
              const providers = (
                providersByEnvironment.get(environment.environmentId) ?? []
              ).filter(
                (provider) =>
                  provider.enabled &&
                  provider.installed &&
                  isManagedDriverAllowed(environment.serverConfig.managedPolicy, provider.driver),
              );
              return providers.length === 0
                ? [
                    <SettingsSection key={environment.environmentId} title={environment.label}>
                      <Text className="p-4 text-foreground-muted">No agents are available.</Text>
                    </SettingsSection>,
                  ]
                : providers.map((provider) => (
                    <ProviderCapabilities
                      key={`${environment.environmentId}:${provider.instanceId}`}
                      environment={environment}
                      provider={provider}
                    />
                  ));
            })
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ProviderCapabilities(props: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const { environment, provider } = props;
  const name = provider.displayName ?? provider.driver;
  const skills = provider.skills.filter((skill) => skill.enabled);
  const [showAll, setShowAll] = useState(false);
  const visibleSkills = showAll ? skills : skills.slice(0, MAX_SKILLS_SHOWN);
  return (
    <SettingsSection title={`${environment.label} · ${name}`}>
      {provider.supportsMcpServers ? (
        <McpServerRows
          environment={environment}
          provider={provider}
          hasSkills={skills.length > 0}
        />
      ) : null}
      {visibleSkills.map((skill) => (
        <CapabilityRow
          key={`${skill.scope ?? ""}:${skill.path}`}
          icon="sparkles"
          label={skillLabel(skill)}
          description={skill.shortDescription ?? skill.description}
          detail="Skill"
        />
      ))}
      {skills.length > MAX_SKILLS_SHOWN ? (
        <ListActionRow
          label={showAll ? "Show fewer" : `Show all (${skills.length})`}
          onPress={() => setShowAll((value) => !value)}
        />
      ) : null}
      {!provider.supportsMcpServers && skills.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No servers or skills.</Text>
      ) : null}
    </SettingsSection>
  );
}

function McpServerRows(props: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly hasSkills: boolean;
}) {
  const servers = useEnvironmentQuery(
    serverEnvironment.providerMcpServers({
      environmentId: props.environment.environmentId,
      input: { instanceId: props.provider.instanceId },
    }),
  );
  if (servers.data === null) {
    return servers.error !== null ? (
      <Text accessibilityRole="alert" className="p-4 text-danger-foreground">
        {servers.error}
      </Text>
    ) : (
      <Text className="p-4 text-foreground-muted">Loading MCP servers…</Text>
    );
  }
  if (servers.data.servers.length === 0 && !props.hasSkills) {
    return <Text className="p-4 text-foreground-muted">No servers or skills.</Text>;
  }
  return (
    <>
      {servers.data.servers.map((server) => (
        <CapabilityRow
          key={server.name}
          icon="server.rack"
          label={server.displayName ?? server.name}
          description={server.message ?? server.plugin}
          detail={MCP_STATUS_LABELS[server.status]}
        />
      ))}
    </>
  );
}

const skillLabel = (skill: ServerProviderSkill) => skill.displayName ?? skill.name;

function CapabilityRow(props: {
  readonly icon: "server.rack" | "sparkles";
  readonly label: string;
  readonly description: string | undefined;
  readonly detail: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        {...(props.description ? { description: props.description } : {})}
        detail={props.detail}
      />
    </View>
  );
}
