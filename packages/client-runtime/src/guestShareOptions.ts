import type { GuestShareAccess, GuestShareLifetime, ThreadGuestShare } from "@t3tools/contracts";
import { getFormattingLocale, msg, t, type Message } from "@t3tools/shared/i18n";

const GUEST_SHARE_ACCESS_OPTIONS = [
  {
    value: "approve",
    label: msg("Wait for me"),
    description: msg("You send or dismiss each message the guest writes."),
  },
  {
    value: "read-only",
    label: msg("Read-only"),
    description: msg(
      "The guest's messages run right away, and the agent cannot change files. Every turn on this thread stays read-only until you stop sharing.",
    ),
  },
] as const satisfies ReadonlyArray<{
  readonly value: GuestShareAccess;
  readonly label: Message;
  readonly description: Message;
}>;

const GUEST_SHARE_LIFETIME_OPTIONS = [
  { value: "1h", label: msg("1 hour") },
  { value: "1d", label: msg("1 day") },
  { value: "7d", label: msg("7 days") },
  { value: "30d", label: msg("30 days") },
] as const satisfies ReadonlyArray<{
  readonly value: GuestShareLifetime;
  readonly label: Message;
}>;

/** What a guest's messages can do, labelled in the active language. */
export function guestShareAccessOptions(): ReadonlyArray<{
  readonly value: GuestShareAccess;
  readonly label: string;
  readonly description: string;
}> {
  return GUEST_SHARE_ACCESS_OPTIONS.map(({ value, label, description }) => ({
    value,
    label: t(label),
    description: t(description),
  }));
}

/** How long a new guest link works, labelled in the active language. */
export function guestShareLifetimeOptions(): ReadonlyArray<{
  readonly value: GuestShareLifetime;
  readonly label: string;
}> {
  return GUEST_SHARE_LIFETIME_OPTIONS.map(({ value, label }) => ({ value, label: t(label) }));
}

/**
 * The line under a new link: what the guest's messages can do and when the link stops working,
 * as the server made it, so a server that ignored the requested access shows what it applied.
 */
export function guestShareCreatedText(share: Pick<ThreadGuestShare, "access" | "expiresAt">) {
  // @effect-diagnostics-next-line globalDate:off - Clients format during render, outside an Effect runtime.
  const date = new Date(share.expiresAt).toLocaleString(getFormattingLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return share.access === "read-only"
    ? t("Read-only: the agent cannot change files. It works once and expires {date}.", { date })
    : t("Each message the guest sends waits for you. It works once and expires {date}.", {
        date,
      });
}
