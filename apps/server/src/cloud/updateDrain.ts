import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

interface DrainState {
  readonly holders: number;
  readonly admitting: number;
}

export class UpdateDrain extends Context.Reference<SubscriptionRef.SubscriptionRef<DrainState>>(
  "t3/cloud/UpdateDrain",
  { defaultValue: () => Effect.runSync(SubscriptionRef.make({ holders: 0, admitting: 0 })) },
) {}

const take = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.update(drain, (state) => ({ ...state, holders: state.holders + 1 }));
const give = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.update(drain, (state) => ({ ...state, holders: state.holders - 1 }));

const awaitAdmissions = (drain: SubscriptionRef.SubscriptionRef<DrainState>) =>
  SubscriptionRef.changes(drain).pipe(
    Stream.filter((state) => state.admitting === 0),
    Stream.runHead,
  );

// Registration and the final drain check must agree even if a holder arrives during dispatch.
export const tryAdmitStart = Effect.gen(function* () {
  const drain = yield* UpdateDrain;
  return yield* Effect.acquireRelease(
    SubscriptionRef.modify(drain, (state) =>
      state.holders > 0
        ? ([false, state] as const)
        : ([true, { ...state, admitting: state.admitting + 1 }] as const),
    ),
    (admitted) =>
      admitted
        ? SubscriptionRef.update(drain, (state) => ({ ...state, admitting: state.admitting - 1 }))
        : Effect.void,
  );
});

/** Holds scheduled starts for the life of `effect`, however it ends. */
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

/** Holds scheduled starts until the scope closes. */
export const drainUntilClosed = Effect.gen(function* () {
  const drain = yield* UpdateDrain;
  yield* Effect.acquireRelease(take(drain), () => give(drain));
  yield* awaitAdmissions(drain);
});

export const isDraining = Effect.fn("cloud.update_drain.is_draining")(function* () {
  return (yield* SubscriptionRef.get(yield* UpdateDrain)).holders > 0;
});
