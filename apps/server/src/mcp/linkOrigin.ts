import {
  type EnvironmentId,
  linkOriginIsFenced,
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
  peerLinkAccessAllowsLinkBack,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { clientModeCeiling, type McpInvocationScope } from "./McpInvocationContext.ts";

import type { Caller } from "./threadAccess.ts";

/**
 * Below full access, work a link starts here (all of it carries that session in `linkOrigin`)
 * may change only work from the same link: not the user's threads, projects or settings, nor
 * this environment's links. Reads are not fenced. It is a routing rule for T3's tools; agents
 * still run as this environment's user, so a full-access link is not fenced at all.
 */

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.linked === true
    ? {
        sessionId: caller.scope.client.sessionId,
        label: caller.scope.client.label,
        access: caller.scope.client.access,
      }
    : undefined);

/** The link that fences a caller, if any: one paired below full access. */
const fencingLinkOrigin = (caller: Pick<Caller, "scope" | "caller">) => {
  const origin = callerLinkOrigin(caller);
  return origin !== undefined && linkOriginIsFenced(origin) ? origin : undefined;
};

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message} A link paired with full access is not limited this way.`,
  });

/** A thread a fenced caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Fenced work never changes what the environment already has: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};

const linkBackDenied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * The one change to this environment's links a fenced link may make: linking back to the
 * environment it signed in from. It names that environment itself at sign-in, so it can only
 * link back to the machine whose pairing code it holds, and its access must already let it
 * work here without approval at every step.
 */
export const assertMayLinkBack = (
  scope: McpInvocationScope,
  target: EnvironmentId,
): Effect.Effect<void, OrchestratorMcpFailure> => {
  const client = scope.client;
  if (client?.linked !== true) {
    return Effect.fail(
      linkBackDenied("Only an environment linked to this one may ask it to link back."),
    );
  }
  if (client.linkedFrom !== target) {
    return Effect.fail(
      linkBackDenied(
        client.linkedFrom === undefined
          ? `${client.label} linked this environment before linking back was possible. Link it again from there to let this environment reach it.`
          : `${client.label} may only ask this environment to link back to itself.`,
      ),
    );
  }
  if (!peerLinkAccessAllowsLinkBack(clientModeCeiling(client).runtimeMode)) {
    return Effect.fail(
      linkBackDenied(
        `${client.label} is linked with less than auto access, which is not enough to ask this environment to link back. Link it with auto or full access, or link it from here.`,
      ),
    );
  }
  return Effect.void;
};
