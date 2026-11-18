import type {
  ProviderCreditGrant,
  ProviderRetryUsageLimitResult,
  ProviderUsageHold,
  ServerProvider,
} from "@t3tools/contracts";
import { getFormattingLocale, t } from "@t3tools/shared/i18n";

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
  if (hold.apiCredit)
    return t("API credit spent; waits for the next billing cycle or a successful credit check");
  if (hold.appCap) return t("ChatGPT's app limit stopped it");
  if (hold.heldUntil === undefined) return t("Held until its next turn");
  const time = formatTime(hold.heldUntil);
  return hold.estimated ? t("Held until about {time}", { time }) : t("Held until {time}", { time });
}

/** What is left of the prepaid credits the user allowed an account, never more than is left. */
export function creditGrantLeftText(
  grant: Pick<ProviderCreditGrant, "capCredits" | "remainingCredits">,
): string {
  const format = new Intl.NumberFormat(getFormattingLocale());
  return t("Prepaid credits left: {remaining} of {cap}", {
    remaining: format.format(Math.floor(grant.remainingCredits)),
    cap: format.format(grant.capCredits),
  });
}

/**
 * What Try again reports: whether new work can start on the account now, as the server's admission
 * decides it. Lifting a hold does not help an account whose plan usage is still used up.
 */
export function describeRetryOutcome(
  result: ProviderRetryUsageLimitResult,
  resumes: boolean,
  formatTime: (isoDate: string) => string,
): { readonly limited: boolean; readonly title: string; readonly description: string } {
  if (result.limitedUntil === undefined) {
    const onCredits = result.credits === "spending";
    const description = resumes
      ? onCredits
        ? t("The chat continues on it within a minute, on its prepaid credits.")
        : t("The chat continues on it within a minute.")
      : onCredits
        ? t("Send a message to try the account again. It runs on its prepaid credits.")
        : t("Send a message to try the account again.");
    return { limited: false, title: t("Account released"), description };
  }
  if (result.limitedUntil === null)
    return {
      limited: true,
      title: t("Account still limited"),
      description: t("The account is waiting for available usage."),
    };
  const time = formatTime(result.limitedUntil);
  const held = result.estimated
    ? t("Its usage limit still holds it until about {time}.", { time })
    : t("Its usage limit still holds it until {time}.", { time });
  const credits =
    result.credits === "not_enabled"
      ? t(
          "Its prepaid credits are not used: Spend prepaid credits is off in Settings → Providers & models.",
        )
      : result.credits === "out_of_scope"
        ? t("Its prepaid credits are allowed only for other threads' work.")
        : result.credits === "cap_reached"
          ? t("The prepaid credits you allowed it are spent.")
          : result.credits === "used_up"
            ? t("Its prepaid credits are used up too.")
            : null;
  return {
    limited: true,
    title: t("Account still limited"),
    description: credits === null ? held : `${held} ${credits}`,
  };
}
export const apiCreditCheckDescription = () =>
  t(
    "Runs a tiny billable check when API credits are next in expiry order. The account stays blocked until the next cycle or the API confirms available credit.",
  );
