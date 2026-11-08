import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { orderProviderInstancesForFailover } from "@t3tools/shared/serverSettings";
import { providerConstraints } from "../provider/providerConstraints.ts";

export function autoCoordinatorAccount(input: {
  readonly driver: ProviderDriverKind;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstanceFailoverOrder">;
  readonly orchestrationCapableInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly limitedAccounts: ReadonlyMap<ProviderInstanceId, string>;
}): ServerProvider | undefined {
  const other =
    input.driver === "claudeAgent" ? "codex" : input.driver === "codex" ? "claudeAgent" : undefined;
  if (other === undefined) return undefined;
  return orderProviderInstancesForFailover(
    input.settings.providerInstanceFailoverOrder,
    input.providers,
  ).find(
    (provider) =>
      provider.driver === other &&
      !input.limitedAccounts.has(provider.instanceId) &&
      providerConstraints(provider, input.orchestrationCapableInstanceIds.has(provider.instanceId))
        .length === 0,
  );
}
