import { getFormattingLocale } from "../../lib/i18n";

/** Time only for today's messages; older ones lead with the day and month. */
export function formatMessageTimestamp(input: string, nowMs: number = Date.now()): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return "";
  const date = new Date(timestamp);
  const now = new Date(nowMs);
  const locale = getFormattingLocale();
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
  return `${day} ${time}`;
}
