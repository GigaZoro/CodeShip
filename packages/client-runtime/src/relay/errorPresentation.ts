import type { DpopFailureReason } from "@t3tools/contracts";
import {
  T3CHAT_PLAN_TUNNEL_LIMITS,
  type RelayEnvironmentStatusResponse,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { msg, t } from "@t3tools/shared/i18n";

export const DPOP_CLOCK_HINT = msg(
  "Hint: Check that automatic date and time is enabled on both devices, then try again.",
);

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT = msg(
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.",
);

export const DPOP_RETRY_HINT = msg("Hint: Try again. If the problem continues, copy the trace ID.");

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return t(DPOP_CLOCK_HINT);
  if (reason === undefined) return t(DPOP_UNKNOWN_HINT);
  return t(DPOP_RETRY_HINT);
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return t("Relay rejected the cloud session token.");
        case "invalid_dpop":
          return dpopFailureMessage(t("Relay rejected the DPoP proof."), error.dpopFailureReason);
        case "not_authorized":
          return t("Relay rejected the authenticated request.");
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return t("Relay rejected an expired environment link proof.");
    case "RelayEnvironmentLinkProofInvalidError":
      return t("Relay rejected the environment link proof ({reason}).", { reason: error.reason });
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return t(
          "Relay has no active link for this environment. If it was deregistered from T3 Connect, link it again on that machine.",
        );
      }
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return t("The environment's T3 Connect tunnel is still being set up.");
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return t(
          "This environment is linked only to publish agent activity, so it cannot accept connections. On that computer, open Settings > Sharing & access and turn T3 Connect on.",
        );
      }
      return error.reason
        ? t("Relay rejected the environment connection request ({reason}).", {
            reason: error.reason,
          })
        : t("Relay rejected the environment connection request.");
    case "RelayEnvironmentEndpointUnavailableError":
      return t("Relay could not reach the environment endpoint ({reason}).", {
        reason: error.reason,
      });
    case "RelayEnvironmentEndpointTimedOutError":
      return t("Relay timed out while contacting the environment endpoint.");
    case "RelayEnvironmentLinkFailedError":
      return t("Relay could not link the environment ({reason}).", { reason: error.reason });
    case "RelayEnvironmentLinkUnavailableError":
      return error.provisioningStage
        ? t("Relay cannot provision the managed endpoint ({reason}). Failed stage: {stage}.", {
            reason: error.reason,
            stage: error.provisioningStage,
          })
        : t("Relay cannot provision the managed endpoint ({reason}).", { reason: error.reason });
    case "RelayEnvironmentLinkLimitExceededError":
      return error.maxTunnels < T3CHAT_PLAN_TUNNEL_LIMITS.premier
        ? t(
            "Relay refused the link: this account already has its maximum of {max} managed tunnels. Unlink an environment, or link a paid T3 Chat account in your T3 Connect account settings on web or desktop. Pro raises the default limit to {pro} and Premier to {premier}.",
            {
              max: error.maxTunnels,
              pro: T3CHAT_PLAN_TUNNEL_LIMITS.pro,
              premier: T3CHAT_PLAN_TUNNEL_LIMITS.premier,
            },
          )
        : t(
            "Relay refused the link: this account already has its maximum of {max} managed tunnels. Unlink an environment to free one up.",
            { max: error.maxTunnels },
          );
    case "RelayAgentActivityPublishProofExpiredError":
      return t("Relay rejected an expired agent activity publish proof.");
    case "RelayAgentActivityPublishProofInvalidError":
      return t("Relay rejected the agent activity publish proof ({reason}).", {
        reason: error.reason,
      });
    case "RelayInternalError":
      return t("Relay encountered an internal error ({reason}).", { reason: error.reason });
  }
}

// The relay cuts off a request it cannot finish in time with a 504 that no
// endpoint declares, so the client sees only the status.
export const RELAY_GATEWAY_TIMEOUT_MESSAGE = msg(
  "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it.",
);

export function relayRequestFailureDetail(error: {
  readonly relayError?: RelayProtectedError | undefined;
  readonly status?: number | undefined;
}): string | null {
  if (error.relayError) return relayProtectedErrorMessage(error.relayError);
  if (error.status === 504) return t(RELAY_GATEWAY_TIMEOUT_MESSAGE);
  if (error.status !== undefined)
    return t("Relay returned an unexpected HTTP {status}.", { status: error.status });
  return null;
}

const RELAY_TUNNEL_RELEASED_MESSAGE = msg(
  "Offline for a while, so its T3 Connect tunnel was removed. Start T3.CodeShip on that computer and update it to the latest version to reconnect.",
);

export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return t(RELAY_TUNNEL_RELEASED_MESSAGE);
    case undefined:
      return null;
  }
}
