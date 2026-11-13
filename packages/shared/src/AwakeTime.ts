import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// libuv timers keep running while macOS or Windows sleeps and all fire on wake, so a plain
// deadline can expire while the machine sleeps. Awake time is counted in ticks instead.
const AWAKE_TICK_MS = 5_000;
// A tick that ends this much later than it should did not run awake.
const SLEEP_GAP_MS = 5_000;

const overran = (startedAt: number, now: number, tickMs: number) =>
  now - startedAt > tickMs + SLEEP_GAP_MS;

export interface AwakeWait {
  /** The machine slept, or the process was stopped, during the wait. */
  readonly slept: boolean;
}

/** Waits until `duration` of awake time has passed; time the machine spends asleep does not count. */
export const sleepAwake = Effect.fn("AwakeTime.sleepAwake")(function* (
  duration: Duration.Input,
): Effect.fn.Return<AwakeWait> {
  let remainingMs = Duration.toMillis(Duration.fromInputUnsafe(duration));
  let slept = false;
  while (remainingMs > 0) {
    const tickMs = Math.min(remainingMs, AWAKE_TICK_MS);
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(tickMs);
    if (overran(startedAt, yield* Clock.currentTimeMillis, tickMs)) {
      slept = true;
    } else {
      remainingMs -= tickMs;
    }
  }
  return { slept };
});

/** `Effect.timeoutOrElse` with a deadline that counts awake time only. */
export const timeoutAwakeOrElse =
  <A2, E2, R2>(options: {
    readonly duration: Duration.Input;
    readonly orElse: (wait: AwakeWait) => Effect.Effect<A2, E2, R2>;
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> =>
    Effect.raceFirst(
      Effect.map(self, (value): Effect.Effect<A | A2, E2, R2> => Effect.succeed(value)),
      Effect.map(sleepAwake(options.duration), (wait): Effect.Effect<A | A2, E2, R2> =>
        options.orElse(wait),
      ),
    ).pipe(Effect.flatten);

/**
 * Watches for a sleep until the scope closes and returns the check. The check also sees a sleep
 * the machine has just woken from, before the watch's own timer has fired.
 */
export const watchSleep: Effect.Effect<Effect.Effect<boolean>, never, Scope.Scope> = Effect.gen(
  function* () {
    let slept = false;
    let tickStartedAt = yield* Clock.currentTimeMillis;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (!slept) {
          yield* Effect.sleep(AWAKE_TICK_MS);
          const now = yield* Clock.currentTimeMillis;
          slept = overran(tickStartedAt, now, AWAKE_TICK_MS);
          tickStartedAt = now;
        }
      }),
    );
    return Effect.map(
      Clock.currentTimeMillis,
      (now) => slept || overran(tickStartedAt, now, AWAKE_TICK_MS),
    );
  },
);
