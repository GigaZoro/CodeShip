import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * How many holds keep this server's scheduled starts waiting: its own update's, and each drain
 * link the primary holds open to it. A count, so a hold that ends inside another leaves the outer
 * one in place. A start that came due meanwhile runs after the install.
 */
export class UpdateDrain extends Context.Reference<SubscriptionRef.SubscriptionRef<number>>(
  "t3/cloud/UpdateDrain",
  { defaultValue: () => Effect.runSync(SubscriptionRef.make(0)) },
) {}

const take = (drain: SubscriptionRef.SubscriptionRef<number>) =>
  SubscriptionRef.update(drain, (holders) => holders + 1);
const give = (drain: SubscriptionRef.SubscriptionRef<number>) =>
  SubscriptionRef.update(drain, (holders) => holders - 1);

/** Holds scheduled starts for the life of `effect`, however it ends. */
export const whileDraining = Effect.fn("cloud.update_drain.while_draining")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const drain = yield* UpdateDrain;
  return yield* Effect.acquireUseRelease(
    take(drain),
    () => effect,
    () => give(drain),
  );
});

/**
 * Holds scheduled starts from now until `effect`, run in the background, ends. The hold starts
 * before this returns, so it outlasts a `whileDraining` the caller is about to leave.
 */
export const drainInBackground = Effect.fn("cloud.update_drain.drain_in_background")(function* <
  A,
  E,
>(effect: Effect.Effect<A, E>) {
  const drain = yield* UpdateDrain;
  return yield* Effect.uninterruptibleMask((restore) =>
    take(drain).pipe(
      Effect.andThen(restore(effect).pipe(Effect.ensuring(give(drain)), Effect.forkDetach)),
    ),
  );
});

/** Holds scheduled starts until the scope closes. */
export const drainUntilClosed = Effect.gen(function* () {
  const drain = yield* UpdateDrain;
  yield* Effect.acquireRelease(take(drain), () => give(drain));
});

export const isDraining = Effect.fn("cloud.update_drain.is_draining")(function* () {
  return (yield* SubscriptionRef.get(yield* UpdateDrain)) > 0;
});
