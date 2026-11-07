import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) &&
      DateTime.toEpochMillis(runAt.value) > DateTime.toEpochMillis(from)
      ? runAt.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

/**
 * The first `anchor + k × everyMs` after `from`. Machines that share a task and anchor compute
 * the same slots, whatever their last runs were.
 */
export function nextAlignedIntervalRunAt(
  everyMs: number,
  anchorMs: number,
  from: DateTime.DateTime,
): DateTime.DateTime {
  const step = Math.max(everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
  const k = Math.max(1, Math.floor((DateTime.toEpochMillis(from) - anchorMs) / step) + 1);
  return DateTime.makeUnsafe(anchorMs + k * step);
}

/** The latest aligned slot at or before `at`, or null before the first one. */
export function latestAlignedIntervalRunAt(
  everyMs: number,
  anchorMs: number,
  at: DateTime.DateTime,
): DateTime.DateTime | null {
  const step = Math.max(everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS);
  const k = Math.floor((DateTime.toEpochMillis(at) - anchorMs) / step);
  return k >= 1 ? DateTime.makeUnsafe(anchorMs + k * step) : null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}

/**
 * The latest fixed-time occurrence at or before `now`, and whether to catch it up: only when
 * `now` is nearer to it than to the next one, so a late start never runs a task twice in a row.
 */
export function latestMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  now: DateTime.DateTime,
): { readonly at: DateTime.DateTime; readonly catchUp: boolean } | null {
  if (schedule.type !== "fixed_time") return null;
  const nowMs = DateTime.toEpochMillis(now);
  let latest: DateTime.DateTime | null = null;
  // A fixed-time schedule fires at least weekly and at most daily, so this finds the latest one.
  let cursor = DateTime.subtract(now, { days: 8 });
  for (let step = 0; step < 10; step += 1) {
    const next = nextScheduledRunAt(schedule, cursor);
    if (next === null || DateTime.toEpochMillis(next) > nowMs) break;
    latest = next;
    cursor = next;
  }
  if (latest === null) return null;
  const following = nextScheduledRunAt(schedule, now);
  return {
    at: latest,
    catchUp:
      following === null ||
      nowMs - DateTime.toEpochMillis(latest) < DateTime.toEpochMillis(following) - nowMs,
  };
}
