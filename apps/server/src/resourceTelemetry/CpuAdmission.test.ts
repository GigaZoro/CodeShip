import type * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  CPU_BUSY_SHARE_LIMIT,
  cpuBusyShare,
  cpuTimesOf,
  describeCpuSaturation,
  make,
  type CpuTimes,
} from "./CpuAdmission.ts";

const core = (times: Partial<NodeOS.CpuInfo["times"]>): NodeOS.CpuInfo => ({
  model: "test",
  speed: 0,
  times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times },
});

describe("cpuBusyShare", () => {
  it("is the busy share of the time that passed between two os.cpus() samples", () => {
    const before = cpuTimesOf([
      core({ user: 100, sys: 50, idle: 850 }),
      core({ user: 200, nice: 10, idle: 790, irq: 0 }),
    ]);
    // Per core 100 ticks pass: the first spends 10 idle, the second 40.
    const after = cpuTimesOf([
      core({ user: 150, sys: 90, idle: 860 }),
      core({ user: 230, nice: 10, sys: 30, idle: 830, irq: 0 }),
    ]);
    assert.strictEqual(cpuBusyShare(before, after), 1 - 50 / 200);
  });

  it("counts only the time since the first sample, however much the cores had idled before", () => {
    const before = cpuTimesOf([core({ idle: 1_000_000 })]);
    const after = cpuTimesOf([core({ idle: 1_000_000, user: 100 })]);
    assert.strictEqual(cpuBusyShare(before, after), 1);
  });

  it("cannot compare samples of no cores, of other core counts or of no elapsed time", () => {
    const one = cpuTimesOf([core({ idle: 1 })]);
    assert.isNull(cpuBusyShare([], []));
    assert.isNull(cpuBusyShare(one, [...one, ...one]));
    assert.isNull(cpuBusyShare(one, one));
  });
});

const sampler = (samples: ReadonlyArray<ReadonlyArray<CpuTimes>>) => {
  let next = 0;
  return {
    reads: () => next,
    sample: Effect.sync(() => samples[Math.min(next++, samples.length - 1)]!),
  };
};

const BUSY = [{ idle: 0, total: 100 }];
const AFTER_BUSY = [{ idle: 2, total: 200 }];
const AFTER_IDLE = [{ idle: 60, total: 200 }];

describe("CpuAdmission", () => {
  it.effect("reports a saturation at the limit over its sample window, and none below it", () =>
    Effect.gen(function* () {
      const saturated = sampler([BUSY, AFTER_BUSY]);
      const admission = yield* make(saturated.sample);
      const read = yield* admission.saturation.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      const saturation = yield* Fiber.join(read);
      assert.deepStrictEqual(saturation, {
        busyShare: 0.98,
        limit: CPU_BUSY_SHARE_LIMIT,
        cores: 1,
      });
      assert.match(
        describeCpuSaturation(saturation!),
        /CPUs are 0\.98 busy across 1 core, at or over the 0\.95 limit/,
      );

      const room = sampler([BUSY, AFTER_IDLE]);
      const roomy = yield* make(room.sample);
      const second = yield* roomy.saturation.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      assert.isNull(yield* Fiber.join(second));
    }),
  );

  it.effect("takes one reading for the callers of a burst, and a new one once it is stale", () =>
    Effect.gen(function* () {
      const samples = sampler([BUSY, AFTER_BUSY, BUSY, AFTER_IDLE]);
      const admission = yield* make(samples.sample);
      const burst = yield* Effect.all([admission.saturation, admission.saturation], {
        concurrency: 2,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      const [first, second] = yield* Fiber.join(burst);
      assert.strictEqual(first, second);
      assert.strictEqual(samples.reads(), 2);
      yield* TestClock.adjust("2 seconds");
      const later = yield* admission.saturation.pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      assert.isNull(yield* Fiber.join(later));
      assert.strictEqual(samples.reads(), 4);
    }),
  );
});
