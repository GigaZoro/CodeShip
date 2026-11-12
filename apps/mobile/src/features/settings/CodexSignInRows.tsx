import {
  codexPrivateLoginApplies,
  readCodexPrivateLogin,
  readCodexSignInMode,
  withCodexPrivateLogin,
  withCodexSignInMode,
  type CodexSignInMode,
} from "@t3tools/client-runtime/codex-sign-in";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ManagedPolicySummary,
  ProviderInstanceConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { managedInstanceLocks } from "@t3tools/shared/managedPolicyMessages";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { t } from "../../lib/i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Where a Codex account signs in: CodeShip's ChatGPT sign-in, or the login Codex keeps for itself.
 * The write goes to the environment that owns the account, whichever machine this app is on.
 */
export function CodexSignInRows({
  environmentId,
  provider,
  instance,
  managedPolicy,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: Pick<ServerProvider, "driver" | "instanceId" | "displayName">;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly managedPolicy: ManagedPolicySummary | undefined;
}) {
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = instance ?? { driver: provider.driver };
  const config = instance?.config;
  const mode = readCodexSignInMode(config);
  const locks = managedInstanceLocks(managedPolicy, provider.driver);
  const lockReason = locks?.configKeys.has("setupMode") ? locks.reason : undefined;
  async function save(next: ProviderInstanceConfig) {
    setPending(true);
    setError(null);
    const result = await mutateProviderInstance({
      environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: provider.instanceId,
          instance: next,
        },
      },
    });
    setPending(false);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setError(cause instanceof Error ? cause.message : t("Could not update provider sign-in."));
  }
  // Choosing a sign-in also turns the account on, as it does on web.
  const choose = (next: CodexSignInMode) => {
    if (next !== mode)
      void save({ ...base, enabled: true, config: withCodexSignInMode(config, next) });
  };
  return (
    <View className="border-t border-border-subtle">
      <Text accessibilityRole="header" className="px-4 pt-3 text-sm text-foreground-muted">
        {t("Sign-in for {account}", { account: resolveProviderInstanceDisplayName(provider) })}
      </Text>
      {lockReason ? (
        <Text className="px-4 pt-1 text-sm text-foreground-muted">{lockReason}</Text>
      ) : null}
      <ListChoiceRow
        label={t("ChatGPT sign-in")}
        description={t("CodeShip signs this account in with ChatGPT.")}
        selected={mode === "managed"}
        disabled={pending || lockReason !== undefined}
        onPress={() => choose("managed")}
      />
      <ListChoiceRow
        separated
        label={t("Codex's own login")}
        description={t("This account uses the login Codex keeps for itself.")}
        selected={mode === "existing"}
        disabled={pending || lockReason !== undefined}
        onPress={() => choose("existing")}
      />
      {mode === "existing" && codexPrivateLoginApplies(provider.instanceId, config) ? (
        <View className="border-t border-border-subtle">
          <ListToggleRow
            label={t("Private login")}
            description={t("Signs this account in apart from the Codex CLI on this machine.")}
            value={readCodexPrivateLogin(config)}
            disabled={pending}
            onValueChange={(on) =>
              void save({ ...base, config: withCodexPrivateLogin(config, on) })
            }
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
