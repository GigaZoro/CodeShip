import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// libuv runs expired timers before the poll that delivers child exits and pipe reads, so a
// deadline timer that fires late, after the event loop was blocked, runs ahead of an exit that
// came first. A late deadline counts only once a settle window has ended on time.
const SETTLE_WINDOW_MS = 50;
const ON_TIME_MS = 5;
// Bounds the wait while the loop keeps stalling.
const MAX_SETTLE_WINDOWS = 20;

const sleepLateMs = Effect.fnUntraced(function* (ms: number) {
  const startedAt = yield* Clock.monotonicTimeNanos;
  yield* Effect.sleep(ms);
  return Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000 - ms;
});

const expire = Effect.fn("ProcessDeadline.expire")(function* (ms: number) {
  if ((yield* sleepLateMs(ms)) <= 0) return;
  for (let window = 0; window < MAX_SETTLE_WINDOWS; window++) {
    if ((yield* sleepLateMs(SETTLE_WINDOW_MS)) <= ON_TIME_MS) return;
  }
});

/**
 * `Effect.timeoutOption` for work that waits on a child process. A process that exited before the
 * deadline returns its result even when the event loop was blocked past the deadline.
 */
export const timeoutProcessOption =
  (duration: Duration.Input) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.raceFirst(
      Effect.asSome(self),
      Effect.as(expire(Duration.toMillis(Duration.fromInputUnsafe(duration))), Option.none<A>()),
    );
