import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export const CLAUDE_SIGNED_OUT_MESSAGE =
  "Claude rejected this account's login. Run `claude auth login` and try again.";

/**
 * A probe cannot see a refresh token Claude refused: it still reports the account as signed in.
 * The failed turn is the evidence, so the account reads as signed out until its login changes.
 */
const withClaudeSignedOut = (provider: ServerProvider): ServerProvider =>
  provider.auth.status !== "authenticated"
    ? provider
    : {
        ...provider,
        status: "error",
        auth: { ...provider.auth, status: "unauthenticated" },
        message: CLAUDE_SIGNED_OUT_MESSAGE,
      };

/**
 * Whether Claude rejected one account's login, kept in memory: a restart probes the login afresh,
 * and the next failed turn records it again. `readLoginExpiry` is when the saved login stops
 * renewing; a new sign-in replaces it, which is how a sign-in done in a terminal is noticed.
 */
export const makeClaudeAuthenticationFailure = Effect.fn("claudeSignedOut.make")(function* (
  readLoginExpiry: Effect.Effect<string | undefined>,
) {
  const failure = yield* Ref.make<{ readonly loginExpiresAt: string | undefined } | undefined>(
    undefined,
  );
  return {
    /** Records a failed turn against the login that failed it. */
    record: readLoginExpiry.pipe(
      Effect.flatMap((loginExpiresAt) => Ref.set(failure, { loginExpiresAt })),
    ),
    /** Forgets the failure; true when there was one. */
    clear: Ref.getAndSet(failure, undefined).pipe(Effect.map((previous) => previous !== undefined)),
    /** The provider snapshot with the failure applied, or untouched once the login has changed. */
    apply: (provider: ServerProvider): Effect.Effect<ServerProvider> =>
      Ref.get(failure).pipe(
        Effect.flatMap((recorded) =>
          recorded === undefined
            ? Effect.succeed(provider)
            : readLoginExpiry.pipe(
                Effect.flatMap((loginExpiresAt) =>
                  loginExpiresAt === recorded.loginExpiresAt
                    ? Effect.succeed(withClaudeSignedOut(provider))
                    : Ref.set(failure, undefined).pipe(Effect.as(provider)),
                ),
              ),
        ),
      ),
  };
});
