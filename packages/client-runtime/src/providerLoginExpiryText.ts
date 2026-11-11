import { tn, t } from "@t3tools/shared/i18n";
import type { ProviderLoginExpiry } from "@t3tools/shared/providerLoginExpiry";

export interface ProviderLoginExpiryText {
  /** Quiet while the login is far off, a warning inside the last week, an error once it lapsed. */
  readonly tone: "quiet" | "warning" | "error";
  readonly text: string;
  /** The sign-in action's name; absent while the login is far off and nothing needs doing. */
  readonly actionLabel?: string;
}

/** The words clients put beside a provider account's sign-in for its login's end date. */
export function providerLoginExpiryText(
  expiry: ProviderLoginExpiry,
  formatDate: (iso: string) => string,
): ProviderLoginExpiryText {
  const date = formatDate(expiry.expiresAt);
  switch (expiry.state) {
    case "valid":
      return { tone: "quiet", text: t("Signed in until {date}", { date }) };
    case "expiring":
      return {
        tone: "warning",
        text: tn(
          expiry.daysLeft,
          "Login ends in {count} day ({date}). Sign in again before then.",
          "Login ends in {count} days ({date}). Sign in again before then.",
          { date },
        ),
        actionLabel: t("Sign in again"),
      };
    case "expired":
      return {
        tone: "error",
        text: t("Login expired. Sign in again to keep using this account."),
        actionLabel: t("Sign in again"),
      };
  }
}
