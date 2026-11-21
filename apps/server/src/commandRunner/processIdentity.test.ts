import { assert, describe, it } from "@effect/vitest";

import {
  compareIdentity,
  identityTime,
  identityWindow,
  launchIdentity,
  linuxIdentity,
  recordedIdentity,
  timeIdentity,
  windowIdentity,
} from "./processIdentity.ts";

describe("processIdentity", () => {
  it("reads the start ticks after a command name holding spaces and parentheses", () => {
    const stat = "42 (a) b (c) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1 2";
    assert.strictEqual(linuxIdentity(stat, "boot-1\n"), "boot:boot-1:987654");
  });

  it("reads no identity from a stat or boot id that is malformed", () => {
    assert.deepEqual(
      [
        linuxIdentity("42 (a) S 1", "boot"),
        linuxIdentity("42 (a) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 x", "boot"),
      ],
      [undefined, undefined],
    );
  });

  it.each([
    ["boot:a:5", "boot:a:5", "same"],
    ["boot:a:5", "boot:a:6", "other"],
    ["boot:a:5", "boot:b:5", "other"],
    ["boot:a:5", undefined, "unknown"],
    ["boot:a:5", "time:5", "unknown"],
    [timeIdentity(10_000), timeIdentity(10_900), "same"],
    [timeIdentity(10_000), timeIdentity(12_000), "other"],
    [windowIdentity(10_000, 12_000), timeIdentity(9_100), "same"],
    [windowIdentity(10_000, 12_000), timeIdentity(12_900), "same"],
    [windowIdentity(10_000, 12_000), timeIdentity(13_500), "other"],
    [windowIdentity(10_000, 12_000), timeIdentity(8_500), "other"],
    [windowIdentity(10_000, 12_000), "boot:a:5", "unknown"],
  ] as const)("compares %s with %s as %s", (stored, current, verdict) => {
    assert.strictEqual(compareIdentity(stored, current), verdict);
  });

  it("reads a start time only from a time identity", () => {
    assert.deepEqual(
      [identityTime(timeIdentity(7)), identityTime("boot:a:5"), identityTime(null)],
      [7, undefined, undefined],
    );
  });

  it("reads when a process started, as closely as its identity tells", () => {
    assert.deepEqual(
      [
        identityWindow(timeIdentity(7)),
        identityWindow(windowIdentity(-5, 9)),
        identityWindow("window:5"),
        identityWindow("boot:a:5"),
        identityWindow(null),
      ],
      [{ from: 7, to: 7 }, { from: -5, to: 9 }, undefined, undefined, undefined],
    );
  });

  it.each([
    ["no read", "win32", undefined, windowIdentity(10_000, 12_000)],
    ["a Windows start inside the window", "win32", timeIdentity(12_000), timeIdentity(12_000)],
    [
      "a Windows start after the window",
      "win32",
      timeIdentity(12_001),
      windowIdentity(10_000, 12_000),
    ],
    [
      "a Windows start before the window",
      "win32",
      timeIdentity(9_999),
      windowIdentity(10_000, 12_000),
    ],
    ["a macOS start after the window", "darwin", timeIdentity(70_000), timeIdentity(70_000)],
    ["no macOS read", "darwin", undefined, null],
    ["a Linux start", "linux", "boot:a:5", "boot:a:5"],
    ["no Linux read", "linux", undefined, null],
  ] as const)("records a launched wrapper from %s", (_, platform, read, identity) => {
    assert.strictEqual(launchIdentity(read, { from: 10_000, to: 12_000 }, platform), identity);
  });

  it("reads the identity a wrapper recorded, and none from an empty or malformed file", () => {
    const stat = "42 (a) S 1 42 42 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1 2";
    assert.deepStrictEqual(
      [
        recordedIdentity("linux", `${stat}\nboot-1\n`),
        recordedIdentity("linux", ""),
        recordedIdentity("darwin", "Sat Jan  1 00:00:00 2000\n"),
        recordedIdentity("darwin", "\n"),
        recordedIdentity("darwin", "not a date\n"),
      ],
      ["boot:boot-1:987654", undefined, timeIdentity(946_684_800_000), undefined, undefined],
    );
  });
});
