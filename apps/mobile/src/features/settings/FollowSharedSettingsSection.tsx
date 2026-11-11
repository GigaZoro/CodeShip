import { AuthSettingsWriteScope, isManagedSettingPath } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { t } from "../../lib/i18n";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Per machine, since each machine decides for itself whether it takes shared settings. */
export function FollowSharedSettingsSection() {
  const { environments } = useEnvironments();
  const supported = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.sharedSettings === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "follow shared settings update",
    reportFailure: true,
  });
  if (supported.length === 0) return null;
  return (
    <View className="gap-3">
      <SettingsSection title={t("Follow shared settings")}>
        {supported.map((environment) => {
          const policy = environment.serverConfig?.managedPolicy;
          const managed = isManagedSettingPath(policy, "followSharedSettings");
          return (
            <SettingsSwitchRow
              key={environment.environmentId}
              icon="arrow.clockwise"
              label={environment.label}
              {...(managed
                ? {
                    subtitle: t("Managed by {organization}.", {
                      organization: policy?.organization ?? "",
                    }),
                  }
                : {})}
              value={environment.serverConfig?.settings.followSharedSettings === true}
              disabled={managed || !writable.has(environment.environmentId)}
              onValueChange={(value) =>
                void updateSettings({
                  environmentId: environment.environmentId,
                  input: { patch: { followSharedSettings: value } },
                })
              }
            />
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {t(
          "Settings you save for all machines also reach a machine that follows them, even if it was off at the time. Turn it on for each machine.",
        )}
      </Text>
    </View>
  );
}
