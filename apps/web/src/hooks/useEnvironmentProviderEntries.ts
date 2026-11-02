import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { primaryServerProvidersAtom } from "../state/server";

export interface EnvironmentProviderEntries {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}

/** Each environment's provider instances, with that machine's settings applied. */
export function useEnvironmentProviderEntries(): ReadonlyArray<EnvironmentProviderEntries> {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providersByEnvironment = useEnvironmentProviders();
  return environments.map((environment) => {
    const derived = deriveProviderInstanceEntries(
      providersByEnvironment.get(environment.environmentId) ??
        (environment.environmentId === primaryEnvironmentId ? providers : []),
    );
    const serverConfig = environment.serverConfig;
    return {
      environmentId: environment.environmentId,
      entries: serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived,
    };
  });
}

/** Keyed `${environmentId}:${instanceId}` because instance ids repeat across environments. */
export function useProviderEntryByEnvironmentAndInstanceId(): ReadonlyMap<
  string,
  ProviderInstanceEntry
> {
  return new Map(
    useEnvironmentProviderEntries().flatMap(({ environmentId, entries }) =>
      entries.map((entry) => [`${environmentId}:${entry.instanceId}`, entry] as const),
    ),
  );
}
