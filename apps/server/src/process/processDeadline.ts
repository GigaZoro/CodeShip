import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as WorkerProcessSpawner from "./WorkerProcessSpawner.ts";

// libuv runs expired timers before the poll that delivers child exits and pipe reads, so a
// deadline timer that fires late, after the event loop was blocked, runs ahead of an exit that
// came first. A late deadline counts only once a settle window has ended on time.
const SETTLE_WINDOW_MS = 50;
const ON_TIME_MS = 5;
// Bounds the wait while the loop keeps stalling. The spawner worker's settle needs no bound: it
// waits out the process start in progress, which took up to 6 s on a loaded Windows machine.
const MAX_SETTLE_WINDOWS = 20;

// Runs inside the ProcessDeadline.expire span.
const elapsedMs = Effect.fnUntraced(function* (self: Effect.Effect<unknown>) {
  const startedAt = yield* Clock.monotonicTimeNanos;
  yield* self;
  return Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000;
});

const expire = Effect.fn("ProcessDeadline.expire")(function* (ms: number) {
  const lateMs = (yield* elapsedMs(Effect.sleep(ms))) - ms;
  const settleMs = yield* elapsedMs(WorkerProcessSpawner.settle);
  if (lateMs <= 0 && settleMs <= ON_TIME_MS) return;
  for (let window = 0; window < MAX_SETTLE_WINDOWS; window++) {
    if ((yield* elapsedMs(Effect.sleep(SETTLE_WINDOW_MS))) - SETTLE_WINDOW_MS <= ON_TIME_MS) return;
  }
});

/**
 * `Effect.timeoutOption` for work that waits on a child process. A process that exited before the
 * deadline returns its result even when the event loop, or the worker that started the process,
 * was blocked past the deadline.
 */
export const timeoutProcessOption =
  (duration: Duration.Input) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, R> =>
    Effect.raceFirst(
      Effect.asSome(self),
      Effect.as(expire(Duration.toMillis(Duration.fromInputUnsafe(duration))), Option.none<A>()),
    );
