import { msg, t } from "./i18n";

// Host timestamps may carry UTC offsets or mixed fractions, so text order is not time order.
export function compareTimestamps(left: string, right: string): number {
  return (Date.parse(left) || 0) - (Date.parse(right) || 0);
}

export function byTimestamp(newestFirst: boolean) {
  return (left: { readonly date: string }, right: { readonly date: string }) =>
    newestFirst
      ? compareTimestamps(right.date, left.date)
      : compareTimestamps(left.date, right.date);
}

export function relativeTime(
  input: string,
  nowMs: number = Date.now(),
  resolve: typeof t = t,
): string {
  const underAMinute = () => resolve(msg("<1m"));
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return underAMinute();
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return underAMinute();

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return resolve(msg("{count}m"), { count: String(deltaMinutes) });
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return resolve(msg("{count}h"), { count: String(deltaHours) });
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return resolve(msg("{count}d"), { count: String(deltaDays) });
}

/** Milliseconds until the relative-time label next changes. */
export function msUntilRelativeTimeChange(
  input: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = elapsedMs < 3_600_000 ? 60_000 : elapsedMs < 86_400_000 ? 3_600_000 : 86_400_000;
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Far-future timestamps must not overflow setTimeout's signed 32-bit delay.
  return Math.min(nextChangeMs - nowMs, 86_400_000);
}
