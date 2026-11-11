import { msg, t, tn, type Message } from "@t3tools/shared/i18n";

import type { SignInOutcome, SignInSkipReason } from "./manualStepsSignIn.logic.ts";

const SKIP_TEXT: Record<SignInSkipReason, Message> = {
  user: msg("Skipped"),
  unsupported: msg("Skipped: this device cannot run that sign-in"),
  "account-failed": msg("Skipped: the account's sign-in failed"),
  "account-skipped": msg("Skipped: the account is not signed in"),
};

/** How a step ended, in the words the guided sign-in shows beside it. */
export function signInOutcomeText(outcome: SignInOutcome): string {
  if (outcome.status === "signed-in") return t("Signed in");
  if (outcome.status === "skipped") return t(SKIP_TEXT[outcome.reason]);
  if (outcome.reason === "cancelled") return t("Cancelled");
  const reason = outcome.message?.trim();
  return reason ? t("Failed: {reason}", { reason }) : t("Failed");
}

export const signInPositionText = (position: number, total: number) =>
  t("{position} of {total}", { position, total });

export const signInPendingCountText = (count: number) =>
  tn(count, "{count} still needs a sign-in", "{count} still need a sign-in");
