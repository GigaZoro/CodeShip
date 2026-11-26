import { msg, t } from "./i18n.ts";

export function formatDuration(durationMs: number, resolve: typeof t = t): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    return resolve(msg("{count}ms"), { count: 0 });
  if (durationMs < 1_000)
    return resolve(msg("{count}ms"), { count: Math.max(1, Math.round(durationMs)) });
  if (durationMs < 10_000)
    return resolve(msg("{count}s"), { count: Math.round(durationMs / 100) / 10 });
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return resolve(msg("{count}s"), { count: totalSeconds });
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(resolve(msg("{count}h"), { count: hours }));
  if (minutes > 0) parts.push(resolve(msg("{count}m"), { count: minutes }));
  if (seconds > 0 || minutes > 0) parts.push(resolve(msg("{count}s"), { count: seconds }));
  return parts.join(" ");
}
