import { describe, expect, it, vi } from "vite-plus/test";

import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "./timestampFormat";

// Node re-resolves the default zone when TZ is assigned, like a renderer after the OS zone changes.
function useTimeZone(timeZone: string): Disposable {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  return {
    [Symbol.dispose]: () => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    },
  };
}

it("localizes the day period while honoring the system clock and explicit 24-hour mode", async () => {
  using _zone = useTimeZone("UTC");
  vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "en-US" } });
  vi.resetModules();
  try {
    const { formatShortTimestamp } = await import("./timestampFormat");
    const date = "2026-11-19T18:05:00.000Z";
    expect(formatShortTimestamp(date, "locale", "zh")).toBe("下午6:05");
    expect(formatShortTimestamp(date, "24-hour", "zh")).toBe("18:05");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("uses Ukrainian time labels with the desktop clock preference", async () => {
  using _zone = useTimeZone("UTC");
  vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => "en-US" } });
  vi.resetModules();
  try {
    const { activateLanguage } = await import("@t3tools/shared/i18n");
    activateLanguage({ language: "uk", formattingLocale: "uk-UA", catalog: {} });
    const { formatShortTimestamp } = await import("./timestampFormat");
    const iso = "2026-11-19T18:05:00.000Z";
    const expected = new Intl.DateTimeFormat("uk-UA", {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12",
      timeZone: "UTC",
    }).format(new Date(iso));
    expect(formatShortTimestamp(iso, "locale")).toBe(expected);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

describe("timestamps in an explicit time zone", () => {
  // 23:00 UTC on July 1 is 7 PM on July 1 in New York, whatever the host zone.
  const now = Date.parse("2026-07-01T23:00:00.000Z");
  const zone = "America/New_York";

  it("picks relative days from the calendar in that zone", () => {
    expect(formatUpcomingTimestamp("2026-07-02T00:30:00.000Z", "12-hour", now, zone)).not.toMatch(
      /tomorrow/,
    );
    expect(formatUpcomingTimestamp("2026-07-02T05:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^tomorrow at /,
    );
    expect(formatDayAwareTimestamp("2026-07-01T03:30:00.000Z", "12-hour", now, zone)).toMatch(
      /^yesterday at /,
    );
  });
});

describe("timestamps after the system time zone changes", () => {
  // Pin the desktop setting independently of the machine's language and rebuild each expected zone.
  const locale = "en-US";
  async function loadDesktopTimestamps() {
    vi.resetModules();
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale: () => locale } });
    try {
      return await import("./timestampFormat");
    } finally {
      vi.unstubAllGlobals();
    }
  }
  const timeIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(new Date(iso));
  const dayIn = (iso: string, timeZone: string) =>
    new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone }).format(
      new Date(iso),
    );

  it("renders the gutter label in the new zone", async () => {
    const { formatDayAwareTimestamp } = await loadDesktopTimestamps();
    const sameDay = "2026-11-07T04:45:43.877Z";
    const earlierInWeek = "2026-11-04T20:00:00.000Z";
    const now = Date.parse(sameDay);
    using _zone = useTimeZone("America/New_York");
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "America/New_York"),
      `${dayIn(earlierInWeek, "America/New_York")} ${timeIn(earlierInWeek, "America/New_York")}`,
    ]);

    process.env.TZ = "Asia/Bangkok";
    expect([
      formatDayAwareTimestamp(sameDay, "12-hour", now),
      formatDayAwareTimestamp(earlierInWeek, "12-hour", now),
    ]).toEqual([
      timeIn(sameDay, "Asia/Bangkok"),
      `${dayIn(earlierInWeek, "Asia/Bangkok")} ${timeIn(earlierInWeek, "Asia/Bangkok")}`,
    ]);
  });

  it("updates the scheduled time when the system zone changes", async () => {
    const { formatDateTimeTimestamp } = await loadDesktopTimestamps();
    const iso = "2026-10-31T20:00:00.000Z";
    using _zone = useTimeZone("America/New_York");
    for (const timeZone of ["America/New_York", "Asia/Bangkok"]) {
      process.env.TZ = timeZone;
      const expected = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: true,
        timeZone,
      }).format(new Date(iso));
      expect(formatDateTimeTimestamp(iso, "12-hour")).toBe(expected);
    }
  });

  it("renders the tooltip in the new zone", async () => {
    const { formatChatTimestampTooltip } = await loadDesktopTimestamps();
    const monthEnd = "2026-10-31T20:00:00.000Z";
    using _zone = useTimeZone("America/New_York");
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "America/New_York")}, 31st October 2026`,
    );

    process.env.TZ = "Asia/Bangkok";
    expect(formatChatTimestampTooltip(monthEnd, "12-hour")).toBe(
      `${timeIn(monthEnd, "Asia/Bangkok")}, 1st November 2026`,
    );
  });
});
