import type { EnvironmentStartup } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Which startup migration is running, so a starting server can say so before it serves. */
export class MigrationProgress extends Context.Service<
  MigrationProgress,
  {
    /** Undefined once no migration is running. */
    readonly report: (status: EnvironmentStartup | undefined) => Effect.Effect<void>;
    /** Read synchronously by the raw HTTP listener, which answers before Effect serves. */
    readonly current: () => EnvironmentStartup | undefined;
  }
>()("t3/persistence/MigrationProgress") {}

const wholePercent = (status: EnvironmentStartup | undefined) =>
  status?.progress === undefined ? undefined : Math.floor(status.progress * 100);

/** `onAdvance` runs when a migration starts or gains a whole percent, not on every batch. */
export const make = (onAdvance: Effect.Effect<void>) => {
  let status: EnvironmentStartup | undefined;
  return MigrationProgress.of({
    report: Effect.fn("MigrationProgress.report")(function* (next: EnvironmentStartup | undefined) {
      const previous = status;
      status = next;
      if (
        next !== undefined &&
        (next.migration !== previous?.migration || wholePercent(next) !== wholePercent(previous))
      ) {
        yield* onAdvance;
      }
    }),
    current: () => status,
  });
};

export const layer = Layer.sync(MigrationProgress, () => make(Effect.void));
