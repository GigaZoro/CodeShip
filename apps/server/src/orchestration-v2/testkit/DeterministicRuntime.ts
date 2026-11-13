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
 * Timers still fire on the TestClock, so one that is running during `sleep` ends late.
 */
export const sleepingTestClock = Effect.gen(function* () {
  const testClock = yield* Clock.Clock;
  let sleptMs = 0;
  const millis = () => testClock.currentTimeMillisUnsafe() + sleptMs;
  const nanos = () => BigInt(millis()) * 1_000_000n;
  const clock: Clock.Clock = {
    ...testClock,
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
  };
  return {
    clock,
    sleep: (duration: Duration.Input) => {
      sleptMs += Duration.toMillis(Duration.fromInputUnsafe(duration));
    },
  };
});
