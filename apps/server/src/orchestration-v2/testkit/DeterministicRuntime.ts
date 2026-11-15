import { EventLoopActiveMs } from "@t3tools/shared/AwakeTime";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { TestClock } from "effect/testing";

export function provideDeterministicTestRuntime<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly randomSeed?: number } = {},
) {
  return effect.pipe(
    Effect.provide(TestClock.layer()),
    Random.withSeed(options.randomSeed ?? 0x1234_5678),
  );
}

/**
 * The TestClock with a wall clock that `sleep` moves ahead, the way a Mac's moves over a sleep.
 * Timers still fire on the TestClock, so one that is running during `sleep` ends late. `stall`
 * moves it the same way while the event loop runs, as when the server blocks on an awake machine.
 */
export const sleepingTestClock = Effect.gen(function* () {
  const testClock = yield* Clock.Clock;
  let skippedMs = 0;
  let activeMs = 0;
  const millis = () => testClock.currentTimeMillisUnsafe() + skippedMs;
  const nanos = () => BigInt(millis()) * 1_000_000n;
  const clock: Clock.Clock = {
    ...testClock,
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
  };
  const skip = (duration: Duration.Input) => {
    const ms = Duration.toMillis(Duration.fromInputUnsafe(duration));
    skippedMs += ms;
    return ms;
  };
  return {
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(
          EventLoopActiveMs,
          Effect.sync(() => activeMs),
        ),
      ),
    sleep: (duration: Duration.Input) => {
      skip(duration);
    },
    stall: (duration: Duration.Input) => {
      activeMs += skip(duration);
    },
  };
});
