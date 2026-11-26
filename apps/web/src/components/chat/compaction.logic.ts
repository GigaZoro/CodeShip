import { t, getFormattingLocale, msg } from "~/i18n";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function formatContextWindowCompactionMessage(
  autoCompactThreshold?: number | null,
  resolve: typeof t = t,
  locale = getFormattingLocale(),
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return resolve(msg("Compacts automatically at about {tokens} tokens."), {
      tokens: autoCompactThreshold.toLocaleString(locale),
    });
  }
  return resolve(msg("Context compacts automatically when needed."));
}
