import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ServerConfig, ServerProvider } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { getFormattingLocale, t } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { openSettings } from "../settings/settings-navigation";
import { RetryAccountButton } from "./RetryAccountButton";
import { describeUsageHold, heldAccountsForDriver } from "@t3tools/client-runtime/usage-holds";

const formatHoldEnd = (isoDate: string) =>
  new Date(isoDate).toLocaleString(getFormattingLocale(), {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/** The accounts of one driver that CodeShip skips after a usage refusal, on one machine. */
function EnvironmentHolds({
  environmentId,
  environmentLabel,
  showEnvironment,
  driver,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironment: boolean;
  readonly driver: ServerProvider["driver"];
  readonly serverConfig: ServerConfig | null;
}) {
  const navigation = useNavigation();
  // Older servers lack the RPC.
  const holdsOffered = serverConfig?.environment.capabilities.usageHolds === true;
  const holds = useEnvironmentQuery(
    holdsOffered ? serverEnvironment.usageHolds({ environmentId, input: {} }) : null,
  );
  const held = heldAccountsForDriver(
    serverConfig?.providers ?? [],
    holds.data?.holds ?? [],
    driver,
  );
  if (held.length === 0) return null;
  return (
    <View className="gap-2">
      {held.map(({ provider, hold }) => {
        const name = resolveProviderInstanceDisplayName(provider);
        return (
          <View key={hold.instanceId} className="gap-2 rounded-xl border border-border-subtle p-3">
            <View accessible>
              <Text className="text-sm font-t3-medium text-foreground">
                {showEnvironment ? `${environmentLabel}: ${name}` : name}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {describeUsageHold(hold, formatHoldEnd)}
              </Text>
            </View>
            <View className="flex-row flex-wrap gap-2">
              <RetryAccountButton environmentId={environmentId} instanceId={hold.instanceId} />
              {hold.appCap ? (
                <Button
                  label={t("Switch sign-in")}
                  accessibilityLabel={t("Switch sign-in for {name}", { name })}
                  tone="secondary"
                  onPress={() =>
                    openSettings(navigation, "SettingsProviderAccounts", {
                      environmentId,
                      instanceId: hold.instanceId,
                    })
                  }
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function ProviderHolds({
  driver,
  environments,
}: {
  readonly driver: ServerProvider["driver"];
  readonly environments: ReadonlyMap<
    EnvironmentId,
    { readonly label: string; readonly serverConfig: ServerConfig | null }
  >;
}) {
  return [...environments].map(([environmentId, { label, serverConfig }]) => (
    <EnvironmentHolds
      key={environmentId}
      environmentId={environmentId}
      environmentLabel={label}
      showEnvironment={environments.size > 1}
      driver={driver}
      serverConfig={serverConfig}
    />
  ));
}
