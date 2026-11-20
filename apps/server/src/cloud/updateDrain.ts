import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Holds an automatic update keeps on scheduled starts while running turns finish and the install
 * hands off; a start that came due meanwhile runs after the install. A count, so a hold that ends
 * inside another leaves the outer one in place.
 */
export class UpdateDrain extends Context.Reference<Ref.Ref<number>>("t3/cloud/UpdateDrain", {
  defaultValue: () => Ref.makeUnsafe(0),
}) {}

/** Holds scheduled starts for the life of `effect`, however it ends. */
export const whileDraining = Effect.fn("cloud.update_drain.while_draining")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const drain = yield* UpdateDrain;
  return yield* Effect.acquireUseRelease(
    Ref.update(drain, (holds) => holds + 1),
    () => effect,
    () => Ref.update(drain, (holds) => holds - 1),
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
  yield* Ref.update(drain, (holds) => holds + 1);
  return yield* effect.pipe(
    Effect.ensuring(Ref.update(drain, (holds) => holds - 1)),
    Effect.forkDetach,
  );
});

export const isDraining = Effect.fn("cloud.update_drain.is_draining")(function* () {
  return (yield* Ref.get(yield* UpdateDrain)) > 0;
});
