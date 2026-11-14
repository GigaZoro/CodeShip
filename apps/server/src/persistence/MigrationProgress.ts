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

export const layer = Layer.sync(MigrationProgress, () => {
  let status: EnvironmentStartup | undefined;
  return MigrationProgress.of({
    report: Effect.fn("MigrationProgress.report")((next: EnvironmentStartup | undefined) =>
      Effect.sync(() => {
        status = next;
      }),
    ),
    current: () => status,
  });
});
