import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { sleepAwake, timeoutAwakeOrElse } from "./AwakeTime.ts";

// A macOS clock that sleeps from `sleepAt` for `sleepMs`: timers due while it sleeps fire on wake.
const sleepingMacClock = (sleepAt: number, sleepMs: number): Clock.Clock => {
  let now = 0;
  const nanos = () => BigInt(now) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.sync(() => {
        const end = now + Duration.toMillis(duration);
        const wake = sleepAt + sleepMs;
        now = end > sleepAt && end < wake ? wake : end;
      }),
  };
};

const sleepAt = 16_000;
const sleepMs = 15 * 60_000;
const wake = sleepAt + sleepMs;

describe("AwakeTime", () => {
  it.effect("a plain timeout expires during a sleep and fires on wake", () =>
    Effect.gen(function* () {
      const firedAt = yield* Effect.never.pipe(
        Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Clock.currentTimeMillis }),
      );
      expect(firedAt).toBe(wake);
    }).pipe(Effect.provideService(Clock.Clock, sleepingMacClock(sleepAt, sleepMs))),
  );

  it.effect("an awake deadline counts only the time the machine was awake", () =>
    Effect.gen(function* () {
      const fired = yield* Effect.never.pipe(
        timeoutAwakeOrElse({
          duration: "90 seconds",
          orElse: (wait) => Effect.map(Clock.currentTimeMillis, (at) => ({ at, ...wait })),
        }),
      );
      // 15 awake seconds before the sleep; the tick it interrupted does not count.
      expect(fired).toEqual({ at: wake + 75_000, slept: true });
    }).pipe(Effect.provideService(Clock.Clock, sleepingMacClock(sleepAt, sleepMs))),
  );

  it.effect("an awake wait without a sleep says so", () =>
    sleepAwake("90 seconds").pipe(
      Effect.flatMap((wait) =>
        Effect.map(Clock.currentTimeMillis, (at) =>
          expect({ at, ...wait }).toEqual({ at: 90_000, slept: false }),
        ),
      ),
      Effect.provideService(Clock.Clock, sleepingMacClock(Number.POSITIVE_INFINITY, 0)),
    ),
  );

  it.effect("an awake deadline returns the effect's result when it finishes in time", () =>
    Effect.succeed("done").pipe(
      timeoutAwakeOrElse({ duration: "90 seconds", orElse: () => Effect.succeed("timed out") }),
      Effect.map((result) => expect(result).toBe("done")),
      Effect.provideService(Clock.Clock, sleepingMacClock(sleepAt, sleepMs)),
    ),
  );
});
