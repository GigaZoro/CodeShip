import type { ProviderUsageHold, ServerProvider } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export interface HeldAccount {
  readonly provider: ServerProvider;
  readonly hold: ProviderUsageHold;
}

/** The holds of one driver's accounts; a hold of an account the server no longer lists is dropped. */
export function heldAccountsForDriver(
  providers: ReadonlyArray<ServerProvider>,
  holds: ReadonlyArray<ProviderUsageHold>,
  driver: ServerProvider["driver"],
): ReadonlyArray<HeldAccount> {
  return holds.flatMap((hold) => {
    const provider = providers.find(
      (candidate) => candidate.instanceId === hold.instanceId && candidate.driver === driver,
    );
    return provider ? [{ provider, hold }] : [];
  });
}

/** What a held account shows: the app cap by name, otherwise when the hold ends. */
export function describeUsageHold(
  hold: ProviderUsageHold,
  formatTime: (isoDate: string) => string,
): string {
  if (hold.appCap) return t("ChatGPT's app limit stopped it");
  if (hold.heldUntil === undefined) return t("Held until its next turn");
  const time = formatTime(hold.heldUntil);
  return hold.estimated ? t("Held until about {time}", { time }) : t("Held until {time}", { time });
}
