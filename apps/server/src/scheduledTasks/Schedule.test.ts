import { describe, expect, it } from "@effect/vitest";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  isSameSchedule,
  latestMissedFixedTimeRun,
  nextAlignedIntervalRunAt,
  nextScheduledRunAt,
} from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("catches up only the latest missed fixed time, and only when it is nearer than the next", () => {
    const kyiv = (day: number, hour: number, minute = 0) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 11, day, hour, minute, second: 0, millisecond: 0 },
        { timeZone: "Europe/Kyiv", adjustForTimeZone: true },
      );
    const daily: ScheduledTaskSchedule = { type: "fixed_time", timeOfDay: "07:00" };
    const check = (now: DateTime.DateTime, schedule = daily) => {
      const missed = latestMissedFixedTimeRun(schedule, now);
      return missed && { at: DateTime.formatIso(missed.at), catchUp: missed.catchUp };
    };
    // Off for three days: one run, for the latest time only.
    expect(check(kyiv(4, 9))).toEqual({ at: "2026-11-04T05:00:00.000Z", catchUp: true });
    // Back just before the next run: that run covers it.
    expect(check(kyiv(5, 6, 50))).toEqual({ at: "2026-11-04T05:00:00.000Z", catchUp: false });
    // A Monday-only run missed is caught up later that Monday, not on Sunday.
    const mondays: ScheduledTaskSchedule = {
      type: "fixed_time",
      timeOfDay: "09:00",
      weekdays: [1],
    };
    expect(check(kyiv(2, 15), mondays)).toEqual({ at: "2026-11-02T07:00:00.000Z", catchUp: true });
    expect(check(kyiv(8, 15), mondays)?.catchUp).toBe(false);
    expect(latestMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, kyiv(4, 9))).toBeNull();
  });

  it("counts aligned interval slots from the anchor, strictly after the reference time", () => {
    const hour = 3_600_000;
    const anchor = Date.UTC(2026, 8, 9, 12, 0, 0);
    const next = (offsetMs: number) =>
      DateTime.toEpochMillis(
        nextAlignedIntervalRunAt(hour, anchor, DateTime.makeUnsafe(anchor + offsetMs)),
      ) - anchor;
    expect(next(10 * 60_000)).toBe(hour);
    expect(next(hour)).toBe(2 * hour);
    expect(next(hour + 1)).toBe(2 * hour);
    expect(next(-5 * 60_000)).toBe(hour);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
