import { t, msg } from "../lib/i18n";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);
const isEnvironmentRpcUnavailable = Schema.is(EnvironmentRpcUnavailableError);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly successResult: AsyncResult.Success<A, unknown> | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

/** What a request cut off by a dropped connection says; it carries no error of its own. */
export const ENVIRONMENT_REQUEST_INTERRUPTED = msg("The connection dropped before this finished.");

export function formatEnvironmentQueryError(
  cause: Cause.Cause<unknown>,
  resolve: typeof t = t,
): string {
  if (Cause.hasInterruptsOnly(cause)) return resolve(ENVIRONMENT_REQUEST_INTERRUPTED);
  const error = Cause.squash(cause);
  if (isEnvironmentRpcUnavailable(error) && error.reason === "timeout")
    return t("The request timed out.");
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : resolve(msg("The environment request failed."));
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);

  return {
    data: AsyncResult.getOrElse(result, () => null),
    // Data may be structurally shared; only a settled success proves a new response.
    successResult: result._tag === "Success" && !result.waiting ? result : null,
    failure: result._tag === "Failure" ? Cause.squash(result.cause) : null,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause, t) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}
