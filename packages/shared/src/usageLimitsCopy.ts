import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { msg, t } from "./i18n.ts";
import { formatDuration, resetCountdown } from "./usageLimits.ts";

export {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatDuration,
  limitsNotice,
  resetCreditChoices,
} from "./usageLimits.ts";

/** Full sentence, inline countdown, or refill marker for a usage window. */
export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: typeof t = t,
  style: "full" | "in" | "refill" = "full",
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null) return null;
  if (countdown.kind === "now") return resolve(msg("resets now"));
  if (countdown.kind === "momentarily") return resolve(msg("Resets momentarily"));
  const duration = formatDuration(countdown.ms, resolve);
  if (style === "in") {
    return resolve(msg("in {duration}"), { duration });
  }
  if (style === "refill") return resolve(msg("↻ {duration}"), { duration });
  return resolve(msg("resets in {duration}"), { duration });
}
