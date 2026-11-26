import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FiberSet from "effect/FiberSet";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface KeyedLock<Key> {
  readonly withLock: <A, E, R>(key: Key, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Holds every key while `effect` runs. It never holds one key while it waits for another, so it
   * cannot deadlock with holders that nest the same keys in any order.
   */
  readonly withLocks: <A, E, R>(
    keys: ReadonlyArray<Key>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly activeKeys: Effect.Effect<ReadonlyArray<Key>>;
}

interface LockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

/**
 * Not reentrant: taking a key while already holding it deadlocks.
 */
export const make = Effect.fn("KeyedLock.make")(function* <Key>(): Effect.fn.Return<
  KeyedLock<Key>
> {
  const locks = yield* Ref.make<ReadonlyMap<Key, LockEntry>>(new Map());

  const acquire = (key: Key) =>
    Effect.flatMap(Semaphore.make(1), (candidate) =>
      Ref.modify(locks, (current) => {
        const existing = current.get(key);
        const semaphore = existing?.semaphore ?? candidate;
        const next = new Map(current);
        next.set(key, { semaphore, users: (existing?.users ?? 0) + 1 });
        return [semaphore, next] as const;
      }),
    );

  const release = (key: Key) =>
    Ref.update(locks, (current) => {
      const existing = current.get(key);
      if (existing === undefined) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  // Waits only for a key it found busy, holding no other, then tries the rest without waiting.
  const holdAll = <A, E, R>(
    semaphores: ReadonlyArray<Semaphore.Semaphore>,
    effect: Effect.Effect<A, E, R>,
    busy?: Semaphore.Semaphore,
  ): Effect.Effect<A, E, R> => {
    const rest = semaphores.reduceRight<Effect.Effect<Result.Result<A, Semaphore.Semaphore>, E, R>>(
      (inner, semaphore) =>
        semaphore === busy
          ? inner
          : semaphore
              .withPermitsIfAvailable(1)(inner)
              .pipe(Effect.map(Option.getOrElse(() => Result.fail(semaphore)))),
      Effect.map(effect, Result.succeed),
    );
    return (busy === undefined ? rest : busy.withPermit(rest)).pipe(
      Effect.flatMap(
        Result.match({
          onSuccess: Effect.succeed,
          onFailure: (next) => holdAll(semaphores, effect, next),
        }),
      ),
    );
  };

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        acquire(key),
        (semaphore) => semaphore.withPermit(effect),
        () => release(key),
      ),
    withLocks: (keys, effect) => {
      const unique = Array.from(new Set(keys));
      return Effect.acquireUseRelease(
        Effect.forEach(unique, acquire),
        (semaphores) => holdAll(semaphores, effect),
        () => Effect.forEach(unique, release, { discard: true }),
      );
    },
    activeKeys: Effect.map(Ref.get(locks), (current) => Array.from(current.keys())),
  } satisfies KeyedLock<Key>;
});

export interface KeyedRunner<Key> {
  /** Forks `effect` to run once every effect passed earlier for `key` has finished. */
  readonly run: <R>(
    key: Key,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, R>;
}

/**
 * For a stream consumer whose handler waits on a per-key lock: a busy key delays only its own
 * later effects. The forked fiber starts immediately, so it queues on the key's FIFO semaphore
 * before `run` returns; that keeps each key's effects in `run` order.
 */
export const makeRunner = Effect.fn("KeyedLock.makeRunner")(function* <Key>(): Effect.fn.Return<
  KeyedRunner<Key>,
  never,
  Scope.Scope
> {
  const lock = yield* make<Key>();
  const fibers = yield* FiberSet.make<void, never>();
  return {
    run: (key, effect) =>
      FiberSet.run(fibers, lock.withLock(key, effect), { startImmediately: true }).pipe(
        Effect.asVoid,
      ),
  } satisfies KeyedRunner<Key>;
});
