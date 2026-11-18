import * as Effect from "effect/Effect";
import { lock, type LockOptions } from "proper-lockfile";

export interface FileLockOptions extends Omit<LockOptions, "onCompromised"> {
  readonly onCompromised: (error: Error) => Effect.Effect<void>;
}

/**
 * Holds a proper-lockfile lock until the scope closes. Effect calls a `try` function with an
 * AbortSignal and proper-lockfile's `release` takes a callback as its first argument, so passing
 * `release` straight through throws on every unlock and leaves the lock held; this is the one place
 * that releases with no arguments.
 */
export const acquireFileLock = Effect.fn("acquireFileLock")(function* (
  target: string,
  options: FileLockOptions,
) {
  const services = yield* Effect.context<never>();
  const { onCompromised, ...lockOptions } = options;
  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(target, {
        ...lockOptions,
        onCompromised: (error) => Effect.runSyncWith(services)(onCompromised(error)),
      }),
    ),
    (release) => Effect.tryPromise(() => release()).pipe(Effect.ignoreCause({ log: true })),
  );
});
