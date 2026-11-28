import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Shared drain state for automatic and manual updates. `holders` counts active drains so
 * overlapping waits stay draining until all finish; `admitting` counts starts mid-dispatch so
 * drains wait until any admitted start has registered.
 */
export interface DrainState {
  readonly holders: number;
  readonly admitting: number;
}

export class UpdateDrain extends Context.Reference<SubscriptionRef.SubscriptionRef<DrainState>>(
  "t3/cloud/UpdateDrain",
  { defaultValue: () => Effect.runSync(SubscriptionRef.make({ holders: 0, admitting: 0 })) },
) {}

export const layer = Layer.effect(
  UpdateDrain,
  SubscriptionRef.make<DrainState>({ holders: 0, admitting: 0 }),
);

const take = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.update(drain, (state) => ({ ...state, holders: state.holders + 1 }));
const give = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.update(drain, (state) => ({ ...state, holders: Math.max(0, state.holders - 1) }));

const awaitAdmissions = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.changes(drain).pipe(
    Stream.filter((state) => state.admitting === 0),
    Stream.runHead,
  );

// Registration and the final drain check must agree even if a holder arrives during dispatch.
export const tryAdmitStartRef = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  Effect.acquireRelease(
    SubscriptionRef.modify(drain, (state) =>
      state.holders > 0
        ? ([false, state] as const)
        : ([true, { ...state, admitting: state.admitting + 1 }] as const),
    ),
    (admitted) =>
      admitted
        ? SubscriptionRef.update(drain, (state) => ({
            ...state,
            admitting: Math.max(0, state.admitting - 1),
          }))
        : Effect.void,
  );

export const tryAdmitStart = Effect.flatMap(UpdateDrain, tryAdmitStartRef);

/**
 * Acquires a drain holder immediately in the calling fiber and releases it once `duration`
 * elapses or `scope` closes. Used after an accepted update handoff so closing a client drain
 * stream cannot briefly drop `holders` to 0 before the process receives SIGTERM.
 */
export const holdInBackgroundRef = (
  drain: SubscriptionRef.SubscriptionRef<DrainState>,
  scope: Scope.Scope,
  duration: Duration.Input,
  onExpired: Effect.Effect<void> = Effect.void,
): Effect.Effect<Effect.Effect<void>> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      let released = false;
      const releaseOnce = Effect.uninterruptible(
        Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          return give(drain);
        }),
      );
      yield* take(drain);
      yield* Scope.addFinalizer(scope, releaseOnce).pipe(Effect.onError(() => releaseOnce));
      const fiber = yield* Effect.sleep(duration).pipe(
        Effect.andThen(onExpired),
        Effect.ensuring(releaseOnce),
        Effect.forkIn(scope),
        Effect.onError(() => releaseOnce),
      );
      return Effect.uninterruptible(Fiber.interrupt(fiber).pipe(Effect.andThen(releaseOnce)));
    }),
  );

/** Holds new turns, idle wakes, and scheduled starts for the life of `effect`, however it ends. */
export const whileDraining = Effect.fn("cloud.update_drain.while_draining")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const drain = yield* UpdateDrain;
  return yield* Effect.acquireUseRelease(
    take(drain),
    () => awaitAdmissions(drain).pipe(Effect.andThen(effect)),
    () => give(drain),
  );
});

/** Holds new turns, idle wakes, and scheduled starts until the scope closes. */
export const drainUntilClosed = Effect.gen(function* () {
  const drain = yield* UpdateDrain;
  yield* Effect.acquireRelease(take(drain), () => give(drain));
  yield* awaitAdmissions(drain);
});

export const isDrainingRef = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.get(drain).pipe(Effect.map((state) => state.holders > 0));

export const isDraining = Effect.fn("cloud.update_drain.is_draining")(function* () {
  return yield* isDrainingRef(yield* UpdateDrain);
});

export const watchDrainingRef = (
  drain: SubscriptionRef.SubscriptionRef<DrainState>,
): Stream.Stream<boolean> =>
  SubscriptionRef.changes(drain).pipe(
    Stream.map((state) => state.holders > 0),
    Stream.changes,
  );

export const watchDraining: Stream.Stream<boolean> = Stream.unwrap(
  Effect.map(UpdateDrain, watchDrainingRef),
);
