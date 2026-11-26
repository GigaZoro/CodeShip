import type * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { YieldingNiceTimeUnreadable } from "./YieldingNiceTime.ts";
import {
  CPU_BUSY_SHARE_LIMIT,
  cpuShares,
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

describe("cpuShares", () => {
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
    assert.strictEqual(cpuShares(before, after)?.busyShare, 1 - 50 / 200);
  });

  it("counts only the time since the first sample, however much the cores had idled before", () => {
    const before = cpuTimesOf([core({ idle: 1_000_000 })]);
    const after = cpuTimesOf([core({ idle: 1_000_000, user: 100 })]);
    assert.strictEqual(cpuShares(before, after)?.busyShare, 1);
  });

  it("caps observed lower-priority CPU time at the host's niced user time", () => {
    const before = cpuTimesOf([core({})]);
    const after = cpuTimesOf([core({ sys: 50, nice: 50 })]);
    assert.deepStrictEqual(cpuShares(before, after, 70), {
      busyShare: 0.5,
      nicedShare: 0.5,
      excludedShare: 0.5,
    });
  });

  it("cannot compare samples of no cores, of other core counts or of no elapsed time", () => {
    const one = cpuTimesOf([core({ idle: 1 })]);
    assert.isNull(cpuShares([], []));
    assert.isNull(cpuShares(one, [...one, ...one]));
    assert.isNull(cpuShares(one, one));
  });
});

const sampler = (samples: ReadonlyArray<ReadonlyArray<CpuTimes>>) => {
  let next = 0;
  return {
    reads: () => next,
    sample: Effect.sync(() => samples[Math.min(next++, samples.length - 1)]!),
  };
};

const BUSY = [{ idle: 0, nice: 0, total: 100 }];
const AFTER_BUSY = [{ idle: 2, nice: 0, total: 200 }];
const AFTER_IDLE = [{ idle: 60, nice: 0, total: 200 }];

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
        nicedShare: 0,
        excludedShare: 0,
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

  describe("niced time", () => {
    const reading = (
      times: Partial<NodeOS.CpuInfo["times"]>,
      elapsed: Effect.Effect<number, YieldingNiceTimeUnreadable>,
    ) =>
      Effect.gen(function* () {
        let sampleIndex = 0;
        const cpu = cpuTimesOf([core(times)])[0]!;
        const sample = Effect.sync(() => {
          const i = sampleIndex++;
          return Array.from({ length: 4 }, () => ({
            idle: cpu.idle * i,
            nice: cpu.nice * i,
            total: cpu.total * i,
          }));
        });
        const admission = yield* make(sample, {
          startYieldingNiceSample: Effect.succeed({ elapsed }),
        });
        const read = yield* admission.saturation.pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(read);
      });

    it.effect("admits a command while low-priority work fills the CPUs", () =>
      Effect.gen(function* () {
        const saturation = yield* reading({ user: 10, nice: 490 }, Effect.succeed(1960));
        assert.isNull(saturation);
      }),
    );

    it.effect("holds a command while normal-priority work fills the CPUs", () =>
      Effect.gen(function* () {
        const saturation = yield* reading({ user: 400, sys: 75, nice: 25 }, Effect.succeed(100));
        assert.strictEqual(saturation?.busyShare, CPU_BUSY_SHARE_LIMIT);
        assert.notMatch(describeCpuSaturation(saturation!), /niced/);
      }),
    );

    it.effect("reports how much niced work counted toward a hold", () =>
      Effect.gen(function* () {
        // Across four cores, only 60 of 1960 niced milliseconds ran below the command's priority.
        const saturation = yield* reading({ user: 10, nice: 490 }, Effect.succeed(60));
        assert.strictEqual(saturation?.busyShare, 0.97);
        assert.match(describeCpuSaturation(saturation!), /0\.98 niced.*0\.03 excluded/);
      }),
    );

    it.effect("counts all niced time as busy when thread CPU time cannot be read", () =>
      Effect.gen(function* () {
        const saturation = yield* reading(
          { user: 10, nice: 490 },
          Effect.fail(new YieldingNiceTimeUnreadable({ cause: "no /proc" })),
        );
        assert.strictEqual(saturation?.busyShare, 1);
        assert.match(describeCpuSaturation(saturation!), /0\.98 niced.*0\.00 excluded/);
      }),
    );
  });
});
