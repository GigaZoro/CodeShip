import { msg, t } from "../../lib/i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isManagedDriverAllowed,
  type ProviderMcpServer,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
  connected: msg("Connected"),
  needsAuth: msg("Needs sign-in"),
  failed: msg("Failed"),
  starting: msg("Starting"),
  disabled: msg("Turned off"),
  notConfigured: msg("Not set up"),
} as const satisfies Record<ProviderMcpServer["status"], string>;

/**
 * What each agent on an environment can reach. MCP servers can be turned off and on here; other
 * changes are made in web or desktop.
 */
export function SettingsCapabilitiesRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title={t("Capabilities")} trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">{t("Select a connected environment.")}</Text>
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
                      <Text className="p-4 text-foreground-muted">
                        {t("No agents are available.")}
                      </Text>
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
    <SettingsSection
      title={t("{environment} · {provider}", { environment: environment.label, provider: name })}
    >
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
          detail={t("Skill")}
        />
      ))}
      {skills.length > MAX_SKILLS_SHOWN ? (
        <ListActionRow
          label={showAll ? t("Show fewer") : t("Show all ({count})", { count: skills.length })}
          onPress={() => setShowAll((value) => !value)}
        />
      ) : null}
      {!provider.supportsMcpServers && skills.length === 0 ? (
        <Text className="p-4 text-foreground-muted">{t("No servers or skills.")}</Text>
      ) : null}
    </SettingsSection>
  );
}

function McpServerRows(props: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
  readonly hasSkills: boolean;
}) {
  const { environmentId } = props.environment;
  const instanceId = props.provider.instanceId;
  const servers = useEnvironmentQuery(
    serverEnvironment.providerMcpServers({ environmentId, input: { instanceId } }),
  );
  const canManage = useAtomValue(
    serverEnvironment.setProviderMcpServerEnabled.permissionAtom(environmentId),
  );
  const setServerEnabled = useAtomCommand(serverEnvironment.setProviderMcpServerEnabled, {
    reportFailure: false,
  });
  // What was asked for shows until a list fetched after the change arrives.
  const [wanted, setWanted] = useState<
    ReadonlyMap<string, { readonly enabled: boolean; readonly listAt: number | null }>
  >(new Map());
  const setWantedFor = (
    name: string,
    next: { readonly enabled: boolean; readonly listAt: number | null } | null,
  ) =>
    setWanted((current) => {
      const updated = new Map(current);
      if (next === null) updated.delete(name);
      else updated.set(name, next);
      return updated;
    });
  const latestList = servers.successResult?.timestamp ?? null;
  const isOn = (server: ProviderMcpServer) => {
    const asked = wanted.get(server.name);
    const answered =
      asked !== undefined &&
      asked.listAt !== null &&
      latestList !== null &&
      latestList > asked.listAt;
    return asked !== undefined && !answered ? asked.enabled : server.status !== "disabled";
  };
  const toggle = async (server: ProviderMcpServer, enabled: boolean) => {
    const listAt = latestList ?? 0;
    setWantedFor(server.name, { enabled, listAt: null });
    const result = await setServerEnabled({
      environmentId,
      input: { instanceId, name: server.name, enabled },
    });
    if (result._tag === "Success") {
      setWantedFor(server.name, { enabled, listAt });
      servers.refresh();
      return;
    }
    setWantedFor(server.name, null);
    if (!isAtomCommandInterrupted(result)) {
      const label = server.displayName ?? server.name;
      Dialog.alert(
        enabled
          ? t("Could not turn on {server}", { server: label })
          : t("Could not turn off {server}", { server: label }),
        String(squashAtomCommandFailure(result)),
      );
    }
  };
  if (servers.data === null) {
    return servers.error !== null ? (
      <Text accessibilityRole="alert" className="p-4 text-danger-foreground">
        {servers.error}
      </Text>
    ) : (
      <Text className="p-4 text-foreground-muted">{t("Loading MCP servers…")}</Text>
    );
  }
  if (servers.data.servers.length === 0 && !props.hasSkills) {
    return <Text className="p-4 text-foreground-muted">{t("No servers or skills.")}</Text>;
  }
  return (
    <>
      {servers.data.servers.map((server) => {
        const label = server.displayName ?? server.name;
        const pending = wanted.get(server.name)?.listAt === null;
        // Servers from older environments, plugins and policies have no switch.
        return (
          <CapabilityRow
            key={server.name}
            icon="server.rack"
            label={label}
            description={server.message ?? server.plugin}
            detail={t(MCP_STATUS_LABELS[server.status])}
            accessory={
              server.canToggle === true ? (
                <ThemedSwitch
                  accessibilityLabel={t("Enable {name}", { name: label })}
                  accessibilityHint={t("Turning it off keeps its settings.")}
                  disabled={!canManage || pending}
                  value={isOn(server)}
                  onValueChange={(enabled) => void toggle(server, enabled)}
                />
              ) : undefined
            }
          />
        );
      })}
    </>
  );
}

const skillLabel = (skill: ServerProviderSkill) => skill.displayName ?? skill.name;

function CapabilityRow(props: {
  readonly icon: "server.rack" | "sparkles";
  readonly label: string;
  readonly description: string | undefined;
  readonly detail: string;
  readonly accessory?: ReactNode;
}) {
  return (
    <View
      // A row with a switch stays unmerged so the switch can be reached on its own.
      accessible={props.accessory === undefined}
      accessibilityLabel={[props.label, props.description, props.detail].filter(Boolean).join(", ")}
      className="bg-grouped-card"
    >
      <ListRowLayout
        icon={props.icon}
        label={props.label}
        {...(props.description ? { description: props.description } : {})}
        detail={props.detail}
        accessory={props.accessory}
      />
    </View>
  );
}
