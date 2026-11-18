import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId> & {
    /**
     * One thread deletion plans and commits at a time: each decides what its deleted fork
     * sources keep for the forks still alive. Take it before any thread lock.
     */
    readonly withDeletionLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

interface LockOrderThread {
  readonly id: ThreadId;
  readonly createdAt: DateTime.DateTime;
}

/** Threads with as many ancestors, such as one parent's side chats, lock oldest first. */
export const compareSiblingLockOrder = (left: LockOrderThread, right: LockOrderThread): number =>
  DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
  (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/**
 * The order to take several thread locks in. Commands nest a thread's lock around its side
 * chats', forks' and delegated tasks', each with one more lineage ancestor, so fewer ancestors
 * lock first; creation times can tie or run backwards, since a fork may carry its own.
 */
export const compareLockOrder = (
  left: LockOrderThread & { readonly ancestors: number },
  right: LockOrderThread & { readonly ancestors: number },
): number => left.ancestors - right.ancestors || compareSiblingLockOrder(left, right);

export const make = Effect.gen(function* () {
  const deletion = yield* Semaphore.make(1);
  return ThreadCommandExecutor.of({
    ...(yield* KeyedLock.make<ThreadId>()),
    withDeletionLock: Effect.fn("ThreadCommandExecutor.withDeletionLock")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* deletion.withPermit(effect);
    }),
  });
});

export const layer = Layer.effect(ThreadCommandExecutor, make);
