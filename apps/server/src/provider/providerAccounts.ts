import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
} from "@t3tools/contracts";

/** An account is known by its email, or by its profile when the provider reports no email. */
const accountKeys = (provider: ServerProvider): ReadonlyArray<string> => {
  if (!provider.enabled || provider.auth.status !== "authenticated") return [];
  const email = provider.auth.email?.trim().toLowerCase();
  const profile = provider.auth.profileId?.trim();
  return [...(email ? [`email:${email}`] : []), ...(profile ? [`profile:${profile}`] : [])];
};

const isDefault = (provider: ServerProvider) =>
  provider.instanceId === defaultInstanceIdForDriver(provider.driver);

// Order-free so every caller picks the same owner: the default instance, then the lowest id.
const ownsBefore = (left: ServerProvider, right: ServerProvider) =>
  isDefault(left) !== isDefault(right)
    ? isDefault(left)
    : left.instanceId.localeCompare(right.instanceId) < 0;

/** The provider already using this provider's account; each account belongs to one provider. */
export function findAccountOwner(
  provider: ServerProvider,
  providers: ReadonlyArray<ServerProvider>,
): ServerProvider | undefined {
  const keys = accountKeys(provider);
  if (keys.length === 0) return undefined;
  let owner: ServerProvider | undefined;
  for (const other of providers) {
    if (
      other.instanceId !== provider.instanceId &&
      other.driver === provider.driver &&
      accountKeys(other).some((key) => keys.includes(key)) &&
      ownsBefore(other, provider) &&
      (owner === undefined || ownsBefore(other, owner))
    )
      owner = other;
  }
  return owner;
}

export const sameAccountMessage = (owner: ServerProvider) =>
  `Signed in to the same account as ${owner.displayName ?? PROVIDER_DISPLAY_NAMES[owner.driver] ?? owner.instanceId}. Sign in to a different account to use it.`;

/** Marks providers that share another provider's account as unavailable, and clears marks that no longer apply. */
export function withSameAccountMarks(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    // Only placeholders for unregistered drivers are otherwise unavailable, and those are disabled.
    if (!provider.enabled) return provider;
    const owner = findAccountOwner(provider, providers);
    if (owner !== undefined)
      return {
        ...provider,
        availability: "unavailable",
        unavailableReason: sameAccountMessage(owner),
      };
    if (provider.availability === undefined) return provider;
    const { availability: _availability, unavailableReason: _reason, ...available } = provider;
    return available;
  });
}
