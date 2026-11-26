import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";

import { stableStringify } from "./relaySigning.ts";

/** What a usage reader sees of one provider instance; config and environment name its transcript home. */
export type UsageScanInstance = Pick<
  ProviderInstanceConfig,
  "driver" | "enabled" | "config" | "environment"
>;

/**
 * Every setting the usage pipeline reads. The server reads usage settings only through this,
 * so the key that tells clients a previous answer is still valid cannot leave one out.
 */
export interface UsageScanSettings extends Pick<
  ServerSettings,
  "usagePriceOverrides" | "usageModelAliases" | "usageModelFilter"
> {
  readonly providerInstances: Readonly<Record<ProviderInstanceId, UsageScanInstance>>;
}

export function usageScanSettings(settings: ServerSettings): UsageScanSettings {
  return {
    usagePriceOverrides: settings.usagePriceOverrides,
    usageModelAliases: settings.usageModelAliases,
    usageModelFilter: settings.usageModelFilter,
    providerInstances: Object.fromEntries(
      Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
        instanceId,
        {
          driver: instance.driver,
          ...(instance.enabled === undefined ? {} : { enabled: instance.enabled }),
          ...(instance.config === undefined ? {} : { config: instance.config }),
          ...(instance.environment === undefined ? {} : { environment: instance.environment }),
        } satisfies UsageScanInstance,
      ]),
    ),
  };
}

/** Changes only when a usage setting changes; property order in a settings snapshot does not count. */
export function usageScanSettingsKey(settings: ServerSettings | null): string {
  return stableStringify(settings === null ? null : usageScanSettings(settings));
}
