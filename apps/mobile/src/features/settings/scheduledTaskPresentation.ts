import type { ScheduledTask } from "@t3tools/contracts";

import { getFormattingLocale, msg, t, tn } from "../../lib/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatIntervalUnit(unit: IntervalUnit, count: number): string {
  switch (unit) {
    case "week":
      return tn(count, "{count} week", "{count} weeks");
    case "day":
      return tn(count, "{count} day", "{count} days");
    case "hour":
      return tn(count, "{count} hour", "{count} hours");
    case "minute":
      return tn(count, "{count} minute", "{count} minutes");
    case "second":
      return tn(count, "{count} second", "{count} seconds");
    case "millisecond":
      return tn(count, "{count} millisecond", "{count} milliseconds");
  }
}

function formatSingleIntervalUnit(unit: IntervalUnit): string {
  switch (unit) {
    case "week":
      return t("Every week");
    case "day":
      return t("Every day");
    case "hour":
      return t("Every hour");
    case "minute":
      return t("Every minute");
    case "second":
      return t("Every second");
    case "millisecond":
      return t("Every millisecond");
  }
}

type IntervalUnit = "week" | "day" | "hour" | "minute" | "second" | "millisecond";

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) {
      return formatSingleIntervalUnit(unit);
    }
    parts.push(formatIntervalUnit(unit, count));
    remaining %= size;
  }
  return t("Every {interval}", { interval: parts.join(" ") });
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return t("Next run unavailable");
  if (remaining <= 0) return t("Next run due");

  const days = localCalendarDay(next) - localCalendarDay(current);
  const locale = getFormattingLocale();
  const time = next.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (days === 0) {
    if (remaining < MINUTE) return t("Next run in less than a minute");
    const when =
      remaining < HOUR
        ? tn(
            Math.round(remaining / MINUTE),
            "Next run in {count} minute",
            "Next run in {count} minutes",
          )
        : tn(Math.round(remaining / HOUR), "Next run in {count} hour", "Next run in {count} hours");
    return t("{when}, at {time}", { when, time });
  }

  if (days === 1) return t("Next run tomorrow at {time}", { time });
  if (days <= 7) {
    return t("Next run next {weekday} at {time}", {
      weekday: next.toLocaleDateString(locale, { weekday: "long" }),
      time,
    });
  }
  const date = next.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return t("Next run {date} at {time}", { date, time });
}

export const SCHEDULED_TASK_WEEKDAYS = [
  { index: 1, label: msg("Mon") },
  { index: 2, label: msg("Tue") },
  { index: 3, label: msg("Wed") },
  { index: 4, label: msg("Thu") },
  { index: 5, label: msg("Fri") },
  { index: 6, label: msg("Sat") },
  { index: 0, label: msg("Sun") },
] as const;

export function formatRunAtDate(value: Date): string {
  return value.toLocaleDateString(getFormattingLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** A run's start, with the year only when it is not this year's. */
export function formatScheduledTaskRunTime(iso: string): string {
  const value = new Date(iso);
  return value.toLocaleString(getFormattingLocale(), {
    month: "short",
    day: "numeric",
    ...(value.getFullYear() !== new Date().getFullYear() ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatRunAtTime(value: Date): string {
  return value.toLocaleTimeString(getFormattingLocale(), { hour: "numeric", minute: "2-digit" });
}

export function describeSchedule(task: Pick<ScheduledTask, "schedule">): string {
  if (task.schedule.type === "webhook") return t("On webhook");
  if (task.schedule.type === "once") {
    const runAt = new Date(task.schedule.runAt);
    return t("Once, {date} at {time}", {
      date: formatRunAtDate(runAt),
      time: formatRunAtTime(runAt),
    });
  }
  if (task.schedule.type === "interval") return formatScheduledTaskInterval(task.schedule.everyMs);
  const days = task.schedule.weekdays?.length
    ? repeatLabel(task.schedule.weekdays)
    : t("Every day");
  return t("{days} at {time}", {
    days,
    time: formatScheduledTaskTime(task.schedule.timeOfDay),
  });
}

export function formatScheduledTaskTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString(getFormattingLocale(), { hour: "numeric", minute: "2-digit" });
}

export function isWeekdaysRepeat(weekdays: ReadonlyArray<number>): boolean {
  const days = new Set(weekdays);
  return days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day));
}

export function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return t("Every day");
  if (isWeekdaysRepeat(weekdays)) return t("Weekdays");
  return (
    SCHEDULED_TASK_WEEKDAYS.filter((day) => days.has(day.index))
      .map((day) => t(day.label))
      .join(", ") || t("Choose days")
  );
}
