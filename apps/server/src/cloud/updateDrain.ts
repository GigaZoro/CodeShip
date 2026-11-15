import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Set while an automatic update lets running turns finish before it installs. New scheduled
 * starts wait for it to clear, so the update has something to drain: a scheduled start that came
 * due meanwhile runs right after the install. A Reference so that a test provides its own.
 */
export class UpdateDrain extends Context.Reference<Ref.Ref<boolean>>("t3/cloud/UpdateDrain", {
  defaultValue: () => Ref.makeUnsafe(false),
}) {}

/** Holds scheduled starts for the life of `effect`, however it ends. */
export const whileDraining = Effect.fn("cloud.update_drain.while_draining")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const drain = yield* UpdateDrain;
  return yield* Effect.acquireUseRelease(
    Ref.set(drain, true),
    () => effect,
    () => Ref.set(drain, false),
  );
});

export const isDraining = Effect.fn("cloud.update_drain.is_draining")(function* () {
  return yield* Ref.get(yield* UpdateDrain);
});
