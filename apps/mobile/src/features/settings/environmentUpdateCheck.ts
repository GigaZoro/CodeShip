import { t } from "../../lib/i18n";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { findEnvironmentUpdate } from "./environment-maintenance";

export interface EnvironmentReleaseCheck {
  readonly fromVersion: string;
  readonly targetVersion: string | null;
}

const asError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(t("Could not check for updates."));

/**
 * Looks up the newest T3.CodeShip release for one environment. The atom is not
 * kept alive, so leaving the screen interrupts the lookup and aborts its fetch.
 * The argument reads the server's description, which an outdated server only
 * reports through a separate description request.
 */
export const environmentReleaseCheckAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.fn(
    (
      readServer: () => Promise<
        Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "releaseRepository">
      >,
    ) =>
      Effect.gen(function* () {
        const server = yield* Effect.tryPromise({ try: readServer, catch: asError });
        const fromVersion = server.serverVersion;
        const targetVersion = yield* Effect.tryPromise({
          try: (signal) => findEnvironmentUpdate(fromVersion, server.releaseRepository, signal),
          catch: asError,
        }).pipe(
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.fail(new Error(t("Checking for updates timed out. Try again."))),
          }),
        );
        return { fromVersion, targetVersion } satisfies EnvironmentReleaseCheck;
      }),
  ).pipe(Atom.withLabel(`mobile:environment-release-check:${environmentId}`)),
);

export function releaseCheckValue(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): EnvironmentReleaseCheck | null {
  return AsyncResult.getOrElse(result, () => null);
}

export function releaseCheckError(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): string | null {
  if (!AsyncResult.isFailure(result) || result.waiting) return null;
  return Option.getOrNull(AsyncResult.error(result))?.message ?? null;
}
