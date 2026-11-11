/**
 * Linking both ways in one step. After this environment links another, it can ask that one to
 * link back over the new link, so the other machine's agents can reach this one without a second
 * pairing code typed there. This environment mints the code itself, so it is this environment's
 * own grant; the code travels only over the authenticated link, once.
 */
import {
  type AuthEnvironmentScope,
  type EnvironmentAuthorizationError,
  mcpClientScopes,
  OrchestratorMcpFailure,
  type OrchestratorMcpLinkBackInput,
  OrchestratorMcpLinkBackResult,
  type PeerLink,
  peerLinkAccessAllowsLinkBack,
  type PeerLinkBackOutcome,
  type PeerLinkCreateInput,
  type PeerLinkError,
  type PeerLinkResult,
  type PeerLinkReverseRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** Long enough for one call over the new link; a code nobody redeems is revoked at once. */
const LINK_BACK_CODE_TTL = Duration.minutes(2);
const LINK_BACK_CODE_LABEL = "T3.CodeShip link";

export class PeerLinkBack extends Context.Service<
  PeerLinkBack,
  {
    /**
     * Links the environment at `input.url`, and when `input.reverse` is set asks it to link
     * back. The link made here stands whatever the other side answers; `back` says how that
     * went. The code for linking back grants `input.reverse.access` here, so the caller must
     * hold every scope it carries, as for any pairing code it makes.
     */
    readonly link: (
      input: PeerLinkCreateInput,
      caller: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
    ) => Effect.Effect<PeerLinkResult, PeerLinkError | EnvironmentAuthorizationError>;
    /**
     * Links back to the environment that asked, with the pairing code it made for this one.
     * The caller's access to ask is checked before this runs (`McpToolAccess.linksBack`), and
     * it only ever adds a link: one this environment already has is never replaced.
     */
    readonly accept: (
      input: OrchestratorMcpLinkBackInput,
    ) => Effect.Effect<OrchestratorMcpLinkBackResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerLinkBack") {}

const notLinked = (message: string): PeerLinkBackOutcome => ({ status: "not_linked", message });

/** A refusal to link back, as the machine that asked hears it. */
const toFailure = (error: PeerLinkError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "disabled" ||
      error.reason === "incompatible" ||
      error.reason === "pairing_rejected" ||
      error.reason === "already_linked"
        ? "capability_denied"
        : "orchestration_error",
    message: error.message,
  });

const make = Effect.gen(function* () {
  const peerLinks = yield* PeerLinks.PeerLinks;
  const peerMcp = yield* PeerMcpClient.PeerMcpClient;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;

  /** Where the other environment may try to reach this one: the caller's hints, then this machine's own. */
  const ownUrls = (reverse: PeerLinkReverseRequest) =>
    directEndpoints
      .resolve()
      .pipe(
        Effect.map((endpoints) => [
          ...new Set([
            ...(reverse.urls ?? []),
            ...endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ]),
        ]),
      );

  const askToLinkBack = Effect.fn("PeerLinkBack.askToLinkBack")(function* (
    forward: PeerLink,
    reverse: PeerLinkReverseRequest,
  ) {
    if (!peerLinkAccessAllowsLinkBack(forward.access)) {
      return notLinked(`${forward.label} can link back only when it is linked with full access.`);
    }
    const urls = yield* ownUrls(reverse);
    if (urls.length === 0) {
      return notLinked(
        `This machine has no address that ${forward.label} could reach it at, such as a Tailscale or https address.`,
      );
    }
    const self = yield* environment.getDescriptor;
    const code = yield* environmentAuth
      .createPairingLink({
        scopes: mcpClientScopes(reverse.access),
        subject: "one-time-token",
        label: LINK_BACK_CODE_LABEL,
        ttl: LINK_BACK_CODE_TTL,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not make a pairing code to link back", cause),
        ),
        Effect.option,
      );
    if (code._tag === "None") {
      return notLinked("This machine could not make a pairing code for it.");
    }
    return yield* peerMcp
      .call({
        environmentId: forward.environmentId,
        tool: "t3_link_back",
        arguments: {
          environmentId: self.environmentId,
          label: self.label,
          urls,
          pairingCode: code.value.credential,
          access: reverse.access,
        },
        // The user's own choice made here, so the call carries the link's full access.
        limits: { runtimeMode: forward.access, interactionMode: "default" },
        success: OrchestratorMcpLinkBackResult,
      })
      .pipe(
        Effect.map((): PeerLinkBackOutcome => ({ status: "linked", access: reverse.access })),
        // A code nobody redeemed must not stay valid, also when the call is interrupted.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : environmentAuth.revokePairingLink(code.value.id).pipe(Effect.ignore),
        ),
        Effect.catch((error) =>
          Effect.succeed(notLinked(`${forward.label} did not link back: ${error.message}`)),
        ),
      );
  });

  const link: PeerLinkBack["Service"]["link"] = Effect.fn("PeerLinkBack.link")(
    function* (input, caller) {
      const { reverse, ...forwardInput } = input;
      // Refused before linking anything, as `/api/auth/pairing-token` refuses such a code.
      const missing =
        reverse === undefined
          ? undefined
          : mcpClientScopes(reverse.access).find((scope) => !caller.scopes.includes(scope));
      if (missing !== undefined) return yield* rpcAuthorizationError(missing);
      const forward = yield* peerLinks.link(forwardInput);
      if (reverse === undefined) return forward;
      return { ...forward, back: yield* askToLinkBack(forward, reverse) };
    },
  );

  const accept: PeerLinkBack["Service"]["accept"] = Effect.fn("PeerLinkBack.accept")(
    function* (input) {
      const [url, ...alternateUrls] = input.urls;
      const linked = yield* peerLinks
        .link(
          {
            url,
            ...(alternateUrls.length === 0 ? {} : { alternateUrls }),
            pairingCode: input.pairingCode,
            access: input.access,
            expectedEnvironmentId: input.environmentId,
            ...(input.label === undefined ? {} : { expectedLabel: input.label }),
          },
          { onlyNew: true },
        )
        .pipe(Effect.mapError(toFailure));
      return {
        environmentId: linked.environmentId,
        label: linked.label,
        access: linked.access,
      };
    },
  );

  return PeerLinkBack.of({ link, accept });
});

export const layer = Layer.effect(PeerLinkBack, make);
