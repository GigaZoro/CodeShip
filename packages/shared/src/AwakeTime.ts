import * as NodePerfHooks from "node:perf_hooks";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

// libuv timers keep running while macOS or Windows sleeps and all fire on wake, so a plain
// deadline can expire while the machine sleeps. Awake time is counted in ticks instead. A stall
// that ends before a tick is due goes unseen, so it costs a deadline at most one tick.
const AWAKE_TICK_MS = 1_000;
// A tick that ends this much later than it should did not run awake.
const LATE_TICK_MS = 5_000;
// A watch only reports a sleep or a stall, so it can look less often.
const WATCH_TICK_MS = 5_000;

/** How long the event loop has run, rather than waited in its poll, in ms. */
export const EventLoopActiveMs = Context.Reference<Effect.Effect<number>>(
  "@t3tools/shared/AwakeTime/EventLoopActiveMs",
  {
    defaultValue: () => Effect.sync(() => NodePerfHooks.performance.eventLoopUtilization().active),
  },
);

/**
 * libuv's clock runs during a macOS or Windows sleep, which the loop spends waiting in its poll.
 * A loop that stayed busy for as long as it was late was blocked on an awake machine.
 */
export const eventLoopBlocked = (lateMs: number, activeMs: number) => activeMs >= lateMs;

export interface AwakeWait {
  /** The machine slept, or the process was stopped, during the wait. */
  readonly slept: boolean;
  /** The event loop was blocked, so the wait's timers fired late, on an awake machine. */
  readonly stalled: boolean;
}

interface Tick {
  readonly startedAt: number;
  readonly activeMs: number;
}

const startTick = Effect.all({
  startedAt: Clock.currentTimeMillis,
  activeMs: Effect.flatten(EventLoopActiveMs),
});

const lateKind = (tick: Tick, now: Tick, tickMs: number): keyof AwakeWait | undefined => {
  const lateMs = now.startedAt - tick.startedAt - tickMs;
  if (lateMs <= LATE_TICK_MS) return undefined;
  return eventLoopBlocked(lateMs, now.activeMs - tick.activeMs) ? "stalled" : "slept";
};

const lateTick = (tick: Tick, tickMs: number) =>
  Effect.map(startTick, (now) => lateKind(tick, now, tickMs));

/**
 * Waits until `duration` of awake time has passed. Time the machine spends asleep, and time the
 * event loop spends blocked, does not count.
 */
export const sleepAwake = Effect.fn("AwakeTime.sleepAwake")(function* (
  duration: Duration.Input,
): Effect.fn.Return<AwakeWait> {
  let remainingMs = Duration.toMillis(Duration.fromInputUnsafe(duration));
  const wait = { slept: false, stalled: false };
  while (remainingMs > 0) {
    const tickMs = Math.min(remainingMs, AWAKE_TICK_MS);
    const tick = yield* startTick;
    yield* Effect.sleep(tickMs);
    const late = yield* lateTick(tick, tickMs);
    if (late === undefined) remainingMs -= tickMs;
    else wait[late] = true;
  }
  return wait;
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
 * Watches for a sleep or a stall until the scope closes and returns the check. The check also sees
 * one that has just ended, before the watch's own timer has fired.
 */
export const watchWait: Effect.Effect<Effect.Effect<AwakeWait>, never, Scope.Scope> = Effect.gen(
  function* () {
    const wait = { slept: false, stalled: false };
    let tick = yield* startTick;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (!wait.slept || !wait.stalled) {
          yield* Effect.sleep(WATCH_TICK_MS);
          const late = yield* lateTick(tick, WATCH_TICK_MS);
          if (late !== undefined) wait[late] = true;
          tick = yield* startTick;
        }
      }),
    );
    return Effect.map(
      Effect.suspend(() => lateTick(tick, WATCH_TICK_MS)),
      (late) => ({
        slept: wait.slept || late === "slept",
        stalled: wait.stalled || late === "stalled",
      }),
    );
  },
);

/**
 * Awake time since the machine last woke, in ms; undefined while this process has not seen it
 * sleep. Without `layerAwakeSinceWake` it never has.
 */
export const AwakeSinceWake = Context.Reference<Effect.Effect<number | undefined>>(
  "@t3tools/shared/AwakeTime/AwakeSinceWake",
  { defaultValue: () => Effect.undefined },
);

/**
 * Watches for wakes until the scope closes and returns the check. Like `watchWait`'s, the check
 * also sees a wake whose tick has not fired yet. A stall is not a wake.
 */
export const watchWakes: Effect.Effect<
  Effect.Effect<number | undefined>,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  let wokeAt: number | undefined;
  let tick = yield* startTick;
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(WATCH_TICK_MS);
        const now = yield* startTick;
        if (lateKind(tick, now, WATCH_TICK_MS) === "slept") wokeAt = now.startedAt;
        tick = now;
      }),
    ),
  );
  return Effect.map(startTick, (now) => {
    const at = lateKind(tick, now, WATCH_TICK_MS) === "slept" ? now.startedAt : wokeAt;
    return at === undefined ? undefined : now.startedAt - at;
  });
});

export const layerAwakeSinceWake = Layer.effect(AwakeSinceWake, watchWakes);
