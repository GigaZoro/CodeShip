import { AUTHENTICATION_FAILED_FAILURE_CODE } from "@t3tools/contracts/orchestrationV2";
import type { ServerProvider } from "@t3tools/contracts/server";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

const LOGIN_REJECTED_MESSAGE =
  "Muse Code rejected this account's login. Run `muse login` on this T3.CodeShip server host.";
const API_KEY_REJECTED_MESSAGE =
  "Muse Code rejected the META_API_KEY set for this provider instance. Replace it in the instance's environment variables in Settings → Providers & models.";

/** The turn error kind of Muse's own login check; an MCP server refusing its credentials is `mcpLinkError`. */
export const MUSE_LOGIN_REJECTED_KIND = "authRequired";

/**
 * An instance's own META_API_KEY outranks the saved login, so `muse login` cannot fix its rejection.
 * Takes the merged instance environment, which spells the name in upper case on Windows; elsewhere
 * names are case-sensitive and Muse reads only this spelling.
 */
export const museSignedOutMessage = (environment: NodeJS.ProcessEnv) => {
  const apiKey = environment.META_API_KEY;
  return apiKey !== undefined && apiKey !== "" ? API_KEY_REJECTED_MESSAGE : LOGIN_REJECTED_MESSAGE;
};

/** The account failover moves a run that stopped here before doing any work to another account. */
export const museSignedOutFailure = (message: string) =>
  makeProviderFailure({
    message,
    code: AUTHENTICATION_FAILED_FAILURE_CODE,
    class: "provider_error",
  });

/** What one Muse process learned about the login it read when it started. */
export interface MuseLoginReport {
  /** Muse refused a turn for its login. */
  readonly rejected: Effect.Effect<unknown>;
  /** The login works: a turn completed, or Muse served its live model catalog. */
  readonly accepted: Effect.Effect<unknown>;
}

/**
 * Whether Muse rejected this account's login, kept in memory because MSP reports no login state.
 * Any rejection signs the account out, since a login can stop working while a process runs. Muse
 * reads its login once, when a process starts, so only a process started after the latest
 * rejection can show that the login works again.
 */
export const makeMuseSignedOut = Effect.fn("museSignedOut.make")(function* (message: string) {
  // `signedOutBefore` is the first launch that started after the latest rejection.
  const state = yield* Ref.make<{
    readonly launches: number;
    readonly signedOutBefore?: number;
  }>({ launches: 0 });
  // True when the status should be probed again: the mark changed, or moved past running processes.
  const rejected = Ref.modify(state, (current) => [
    current.signedOutBefore !== current.launches,
    { ...current, signedOutBefore: current.launches },
  ]);
  const accepted = (launch: number) =>
    Ref.modify(state, (current) =>
      current.signedOutBefore !== undefined && launch >= current.signedOutBefore
        ? [true, { launches: current.launches }]
        : [false, current],
    );
  return {
    /** Take this as each Muse process starts. */
    launch: Ref.modify(
      state,
      (current) =>
        [
          { rejected, accepted: accepted(current.launches) },
          { ...current, launches: current.launches + 1 },
        ] as const,
    ),
    apply: (provider: ServerProvider): Effect.Effect<ServerProvider> =>
      Ref.get(state).pipe(
        Effect.map(({ signedOutBefore }) =>
          signedOutBefore !== undefined && provider.enabled && provider.installed
            ? {
                ...provider,
                status: "error",
                auth: { ...provider.auth, status: "unauthenticated" },
                message,
              }
            : provider,
        ),
      ),
  };
});
