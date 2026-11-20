import { assert, describe, it } from "@effect/vitest";

import {
  compareIdentity,
  ENDED_IDENTITY,
  identityTime,
  linuxIdentity,
  timeIdentity,
  windowsTreeRoot,
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
    [ENDED_IDENTITY, timeIdentity(10_000), "other"],
  ] as const)("compares %s with %s as %s", (stored, current, verdict) => {
    assert.strictEqual(compareIdentity(stored, current), verdict);
  });

  it("walks a Windows stop from the recorded start, and never from a later holder of an ended wrapper's pid", () => {
    assert.deepEqual(
      [
        windowsTreeRoot(7, "1970-01-01T00:00:02.000Z", timeIdentity(1_000), 5_000),
        windowsTreeRoot(7, "1970-01-01T00:00:02.000Z", ENDED_IDENTITY, 5_000),
        windowsTreeRoot(7, "1970-01-01T00:00:02.000Z", null, 5_000),
      ],
      [
        { pid: 7, since: 1_000, created: { from: 1_000, to: 1_000 } },
        { pid: 7, since: 2_000, ended: 5_000 },
        { pid: 7, since: 2_000 },
      ],
    );
  });

  it("reads a start time only from a time identity", () => {
    assert.deepEqual(
      [identityTime(timeIdentity(7)), identityTime("boot:a:5"), identityTime(null)],
      [7, undefined, undefined],
    );
  });
});
