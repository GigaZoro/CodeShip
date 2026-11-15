import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeDiskSpaceReader, parseDarwinSwapUsage, parseLinuxMeminfo } from "./HostResources.ts";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe("parseDarwinSwapUsage", () => {
  it("reads total and free in the units sysctl prints", () => {
    assert.deepStrictEqual(
      parseDarwinSwapUsage("total = 2048.00M  used = 1081.25M  free = 966.75M  (encrypted)\n"),
      { totalBytes: 2048 * MIB, availableBytes: Math.round(966.75 * MIB) },
    );
    assert.deepStrictEqual(
      parseDarwinSwapUsage("total = 3.00G  used = 2.50G  free = 0.50G  (encrypted)"),
      { totalBytes: 3 * GIB, availableBytes: 0.5 * GIB },
    );
  });

  it("reports a Mac that has not swapped yet as empty swap", () => {
    assert.deepStrictEqual(
      parseDarwinSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"),
      { totalBytes: 0, availableBytes: 0 },
    );
  });

  it("returns null when the output is missing or unrecognized", () => {
    assert.strictEqual(parseDarwinSwapUsage(""), null);
    assert.strictEqual(parseDarwinSwapUsage("total = 2048.00X  free = 1.00X"), null);
  });
});

describe("parseLinuxMeminfo", () => {
  it("reads available memory and swap", () => {
    const meminfo = [
      "MemTotal:       16314328 kB",
      "MemFree:         1032004 kB",
      "MemAvailable:    9876543 kB",
      "SwapCached:        12345 kB",
      "SwapTotal:       2097148 kB",
      "SwapFree:        2000000 kB",
    ].join("\n");
    assert.deepStrictEqual(parseLinuxMeminfo(meminfo), {
      availableMemoryBytes: 9876543 * 1024,
      swap: { totalBytes: 2097148 * 1024, availableBytes: 2000000 * 1024 },
    });
  });

  it("leaves out what the kernel does not report", () => {
    assert.deepStrictEqual(parseLinuxMeminfo("MemTotal:       16314328 kB"), {
      availableMemoryBytes: null,
      swap: null,
    });
  });
});

describe("makeDiskSpaceReader", () => {
  it.effect("gives up on a stalled drive and reuses the stuck probe", () =>
    Effect.gen(function* () {
      let calls = 0;
      const readDisk = makeDiskSpaceReader(() => {
        calls += 1;
        return new Promise(() => {});
      }, "/t3");

      const first = yield* readDisk.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), null);

      const second = yield* readDisk.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(second), null);
      assert.strictEqual(calls, 1);
    }),
  );
});
