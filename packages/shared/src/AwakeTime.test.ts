import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { EventLoopActiveMs, sleepAwake, timeoutAwakeOrElse, watchWait } from "./AwakeTime.ts";

type Pause = "sleep" | "stall";

// A macOS clock that pauses from `pauseAt` for `pauseMs`: timers due meanwhile fire when it ends.
// A sleep leaves the event loop waiting in its poll; a stall keeps it running.
const onPausingMac =
  (pauseAt: number, pauseMs: number, pause: Pause = "sleep") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    let now = 0;
    let activeMs = 0;
    const nanos = () => BigInt(now) * 1_000_000n;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      monotonicTimeNanosUnsafe: nanos,
      monotonicTimeNanos: Effect.sync(nanos),
      sleep: (duration) =>
        Effect.sync(() => {
          const end = now + Duration.toMillis(duration);
          const resume = pauseAt + pauseMs;
          if (end <= pauseAt || end >= resume) {
            now = end;
            return;
          }
          if (pause === "stall") activeMs += resume - now;
          now = resume;
        }),
    };
    return effect.pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provideService(
        EventLoopActiveMs,
        Effect.sync(() => activeMs),
      ),
    );
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
    }).pipe(onPausingMac(sleepAt, sleepMs)),
  );

  it.effect.each<{ pause: Pause; wait: { slept: boolean; stalled: boolean } }>([
    { pause: "sleep", wait: { slept: true, stalled: false } },
    { pause: "stall", wait: { slept: false, stalled: true } },
  ])("an awake deadline counts only awake time, and names a $pause", ({ pause, wait }) =>
    Effect.gen(function* () {
      const fired = yield* Effect.never.pipe(
        timeoutAwakeOrElse({
          duration: "90 seconds",
          orElse: (wait) => Effect.map(Clock.currentTimeMillis, (at) => ({ at, ...wait })),
        }),
      );
      // 15 awake seconds before the pause; the tick it interrupted does not count.
      expect(fired).toEqual({ at: wake + 75_000, ...wait });
    }).pipe(onPausingMac(sleepAt, sleepMs, pause)),
  );

  it.effect("an awake wait without a sleep says so", () =>
    sleepAwake("90 seconds").pipe(
      Effect.flatMap((wait) =>
        Effect.map(Clock.currentTimeMillis, (at) =>
          expect({ at, ...wait }).toEqual({ at: 90_000, slept: false, stalled: false }),
        ),
      ),
      onPausingMac(Number.POSITIVE_INFINITY, 0),
    ),
  );

  it.effect("an awake deadline returns the effect's result when it finishes in time", () =>
    Effect.succeed("done").pipe(
      timeoutAwakeOrElse({ duration: "90 seconds", orElse: () => Effect.succeed("timed out") }),
      Effect.map((result) => expect(result).toBe("done")),
      onPausingMac(sleepAt, sleepMs),
    ),
  );

  it.effect.each<{ pause: Pause; wait: { slept: boolean; stalled: boolean } }>([
    { pause: "sleep", wait: { slept: true, stalled: false } },
    { pause: "stall", wait: { slept: false, stalled: true } },
  ])("a wait watch reports a $pause only once there was one", ({ pause, wait }) =>
    Effect.gen(function* () {
      // The TestClock fires timers; the wall clock also jumps ahead over a pause.
      const testClock = yield* Clock.Clock;
      let pausedMs = 0;
      let activeMs = 0;
      const millis = () => testClock.currentTimeMillisUnsafe() + pausedMs;
      const mac = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(Clock.Clock, {
            ...testClock,
            currentTimeMillisUnsafe: millis,
            currentTimeMillis: Effect.sync(millis),
          }),
          Effect.provideService(
            EventLoopActiveMs,
            Effect.sync(() => activeMs),
          ),
        );
      const check = mac(yield* mac(watchWait));

      yield* TestClock.adjust("10 minutes");
      const awake = yield* check;
      pausedMs = 8 * 60 * 60_000;
      if (pause === "stall") activeMs = pausedMs;
      const justEnded = yield* check;
      yield* TestClock.adjust("1 minute");

      expect([awake, justEnded, yield* check]).toEqual([
        { slept: false, stalled: false },
        wait,
        wait,
      ]);
    }).pipe(Effect.scoped),
  );
});
