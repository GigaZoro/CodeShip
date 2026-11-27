import {
  providerDriverDisplayName,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ProviderLimitAlternative,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { describeLimitStand } from "@t3tools/client-runtime/usage-holds";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { t } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatHoldEnd } from "../usage/RetryAccountButton";

/**
 * Shown when every account of the chat's provider is out of usage and the chat will not move by
 * itself: names the first reset and offers a one-tap switch to an account that can run now.
 */
export function ProviderLimitStandCard({
  environmentId,
  threadId,
  serverConfig,
  onContinueOn,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly serverConfig: ServerConfig | null;
  readonly onContinueOn: (alternative: ProviderLimitAlternative) => Promise<void>;
}) {
  const offered = serverConfig?.environment.capabilities.threadLimitStand === true;
  const stand = useEnvironmentQuery(
    offered ? serverEnvironment.threadLimitStand({ environmentId, input: { threadId } }) : null,
  );
  const [pendingInstanceId, setPendingInstanceId] = useState<string | null>(null);
  const limited = stand.data?.limited;
  if (!limited) return null;
  const { title, description } = describeLimitStand(
    limited,
    providerDriverDisplayName(limited.driver),
    formatHoldEnd,
  );
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text accessibilityRole="header" className="text-sm font-t3-medium text-foreground">
        {title}
      </Text>
      <Text className="text-sm text-warning-foreground">{description}</Text>
      {limited.alternatives.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {limited.alternatives.map((alternative) => {
            const account = serverConfig?.providers.find(
              (entry) => entry.instanceId === alternative.instanceId,
            );
            const name = account
              ? resolveProviderInstanceDisplayName(account)
              : alternative.instanceId;
            const pending = pendingInstanceId === alternative.instanceId;
            return (
              <Button
                key={alternative.instanceId}
                label={pending ? t("Switching...") : t("Continue on {account}", { account: name })}
                tone="secondary"
                disabled={pendingInstanceId !== null}
                onPress={() => {
                  setPendingInstanceId(alternative.instanceId);
                  onContinueOn(alternative)
                    .then(() => stand.refresh())
                    .finally(() => setPendingInstanceId(null));
                }}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
