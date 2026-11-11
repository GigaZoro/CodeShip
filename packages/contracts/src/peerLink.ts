import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * A link from this environment to another one (the peer). This environment
 * signed in to the peer's `/mcp` as an outside agent, with a pairing code from
 * the peer, so its agents can work there. The peer enforces the access chosen
 * at linking, and revokes the link from its own Connections.
 */
export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/**
 * What a link does not do. The app's machine list is the client's own saved connections, so a
 * link made for agents never adds to it; saying so keeps people from waiting for the machine
 * to appear in the sidebar.
 */
export const PEER_LINK_AGENTS_ONLY_NOTE =
  "Linked for agents only: this does not add the machine to the app's machine list (bottom-left of the sidebar). To see it there, open Settings → Machines & access → Linked environments and choose Add to this app, or use Add environment.";

/** Whether a link can be used now, as worked out when it is listed. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

/**
 * Also lets the linked environment reach this one. This environment mints the pairing code
 * itself and hands it over the new link, so the other machine can link back without anyone
 * typing a second code there.
 */
export const PeerLinkReverseRequest = Schema.Struct({
  /** What the other environment's agents may do here. */
  access: AuthMcpClientAccess,
  /**
   * Addresses the other environment can reach this one at, most preferred first. Hints only:
   * it uses those that answer as this environment. This environment's own direct addresses
   * follow.
   */
  urls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type PeerLinkReverseRequest = typeof PeerLinkReverseRequest.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: an https, Tailscale, LAN or loopback base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`t3 pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  /**
   * The environment the user means. Addresses that answer as another one are
   * skipped, and only those that answer as this one are kept.
   */
  expectedEnvironmentId: Schema.optionalKey(EnvironmentId),
  /** What the user calls that environment, to name it when it cannot be reached. */
  expectedLabel: Schema.optionalKey(TrimmedNonEmptyString),
  /** Link the other way too, in the same step. Linking this way stands even when that fails. */
  reverse: Schema.optionalKey(PeerLinkReverseRequest),
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

/**
 * Whether a link with this access may ask the environment it links to to link back. Only full
 * access: a full-access link can already run anything there through its agents, the `t3` CLI
 * included, so linking back gives it nothing new. Below that it would be a new power.
 */
export const peerLinkAccessAllowsLinkBack = (
  access: AuthMcpClientAccess,
): access is "full-access" => access === "full-access";

/** How linking back from the other environment went. */
export const PeerLinkBackOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("linked"), access: AuthMcpClientAccess }),
  Schema.Struct({
    status: Schema.Literal("not_linked"),
    /** Why, in words a user can act on. */
    message: Schema.String,
  }),
]);
export type PeerLinkBackOutcome = typeof PeerLinkBackOutcome.Type;

/** A new link, and when asked for, whether the other environment linked back. */
export const PeerLinkResult = Schema.Struct({
  ...PeerLink.fields,
  back: Schema.optionalKey(PeerLinkBackOutcome),
});
export type PeerLinkResult = typeof PeerLinkResult.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
    "disabled",
    /** Only from linking back over a link (`t3_link_back`), which never replaces a link. */
    "already_linked",
  ]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The user's answer to an agent asking to link an environment. The pairing
 * code is used once to link and is never recorded; the thread learns only the
 * outcome and the access the user chose.
 */
export const PeerLinkRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("link"),
      /** The machine the user picked, when they picked one rather than typing an address. */
      environmentId: Schema.optionalKey(EnvironmentId),
      /** What the client calls that machine. */
      label: Schema.optionalKey(TrimmedNonEmptyString),
      /** The addresses the client knows for that machine, most preferred first. */
      urls: Schema.NonEmptyArray(TrimmedNonEmptyString),
      access: AuthMcpClientAccess,
      pairingCode: TrimmedNonEmptyString,
      /** Link the other way too, as for `PeerLinkCreateInput`. */
      reverse: Schema.optionalKey(PeerLinkReverseRequest),
    }),
    /** Answers with a machine this environment is already linked to, as it is. */
    Schema.Struct({ type: Schema.Literal("use-existing"), environmentId: EnvironmentId }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type PeerLinkRequestAnswerInput = typeof PeerLinkRequestAnswerInput.Type;

/**
 * What an answer returns beyond its record on the card, when the user asked to link back: whether
 * the link was made at all, and how linking back went. It is nothing otherwise, which is also all
 * an older server returns and all an older client decodes, so only a client that asked can get an
 * object.
 */
export const PeerLinkRequestAnswerResult = Schema.UndefinedOr(
  Schema.Struct({
    linked: Schema.Boolean,
    back: Schema.optionalKey(PeerLinkBackOutcome),
  }),
);
export type PeerLinkRequestAnswerResult = typeof PeerLinkRequestAnswerResult.Type;

const PEER_LINK_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the link request.",
  not_found: "This link request no longer exists.",
  already_answered: "This link request was already answered.",
  record_failed: "Could not update the link request.",
} as const;

export const PeerLinkRequestFailureReason = Schema.Literals(
  Object.keys(PEER_LINK_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof PEER_LINK_REQUEST_FAILURE_MESSAGES
  >,
);
export type PeerLinkRequestFailureReason = typeof PeerLinkRequestFailureReason.Type;

/**
 * Answering a link request failed before anything was linked. A link the
 * other environment refused is not this error: the card records it as failed.
 */
export class PeerLinkRequestError extends Schema.TaggedError<PeerLinkRequestError>()(
  "PeerLinkRequestError",
  {
    reason: PeerLinkRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return PEER_LINK_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
