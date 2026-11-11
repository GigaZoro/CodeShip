/** A login that ends within this many days is worth signing in again before it fails a run. */
const LOGIN_EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ProviderLoginExpiry =
  | { readonly state: "valid"; readonly expiresAt: string; readonly daysLeft: number }
  | { readonly state: "expiring"; readonly expiresAt: string; readonly daysLeft: number }
  | { readonly state: "expired"; readonly expiresAt: string };

/** Reads a provider's `auth.loginExpiresAt` against the clock; undefined when it has none. */
export function providerLoginExpiry(
  loginExpiresAt: string | undefined,
  nowMs: number,
): ProviderLoginExpiry | undefined {
  if (loginExpiresAt === undefined) return undefined;
  const expiresMs = Date.parse(loginExpiresAt);
  if (!Number.isFinite(expiresMs)) return undefined;
  if (expiresMs <= nowMs) return { state: "expired", expiresAt: loginExpiresAt };
  const daysLeft = Math.ceil((expiresMs - nowMs) / DAY_MS);
  return {
    state: daysLeft <= LOGIN_EXPIRY_WARNING_DAYS ? "expiring" : "valid",
    expiresAt: loginExpiresAt,
    daysLeft,
  };
}
