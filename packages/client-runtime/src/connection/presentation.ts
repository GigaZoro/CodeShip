import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionTarget, SupervisorConnectionState } from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
import { t } from "@t3tools/shared/i18n";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
  /**
   * When this client last had the machine connected, in epoch ms. Null while it is connected and
   * before this client reached it at all; it is not persisted across app restarts.
   */
  readonly lastSeenAt: number | null;
}

/** How a machine's threads can be trusted: live, on their way, or frozen at what was last seen. */
export type MachineAvailability = "live" | "connecting" | "reconnecting" | "offline" | "error";

export function machineAvailability(phase: EnvironmentConnectionPhase): MachineAvailability {
  switch (phase) {
    case "connected":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "available":
    case "offline":
      return "offline";
    case "error":
    case "unsupported":
      return "error";
  }
}

/**
 * Thread state from a machine in these states is only what was last seen. A first connection
 * attempt still counts as current, so cached rows do not flash offline on every launch.
 */
export function machineShowsLastKnownState(availability: MachineAvailability): boolean {
  return availability === "reconnecting" || availability === "offline" || availability === "error";
}

export function machineAvailabilityLabel(availability: MachineAvailability): string {
  switch (availability) {
    case "live":
      return t("Connected");
    case "connecting":
      return t("Connecting");
    case "reconnecting":
      return t("Reconnecting");
    case "offline":
      return t("Offline");
    case "error":
      return t("Can't connect");
  }
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return t("Available");
    case "offline":
      return t("Offline");
    case "connecting":
      return t("Connecting...");
    case "reconnecting":
      return connection.error
        ? t("Failed to connect. Reconnecting... Reason: {error}", { error: connection.error })
        : t("Reconnecting...");
    case "connected":
      return t("Connected");
    case "unsupported":
      return t("Client not supported");
    case "error":
      return connection.error
        ? t("Connection failed. Reason: {error}", { error: connection.error })
        : t("Connection failed");
  }
}

/** Up or on its way, so a server config missing now can still arrive and nothing is final yet. */
export function connectionMayStillAnswer(phase: EnvironmentConnectionPhase): boolean {
  return phase === "connecting" || phase === "reconnecting" || phase === "connected";
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return t("Failed to connect. Reconnecting...");
  }
  return connectionStatusText({ ...connection, error: null });
}

/**
 * SSH connections ride a local forward that disappears with the client, so they have no stable
 * address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl =
      route.target._tag === "RelayConnectionTarget"
        ? (input.relayHttpBaseUrl ?? null)
        : routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Each environment's label, with its address added where two share one. Servers on one
 * computer all take that computer's name, so the name alone cannot tell them apart.
 */
export function distinctEnvironmentLabels(
  environments: ReadonlyArray<{ readonly label: string; readonly displayUrl: string | null }>,
): string[] {
  const counts = new Map<string, number>();
  for (const { label } of environments) counts.set(label, (counts.get(label) ?? 0) + 1);
  return environments.map(({ label, displayUrl }) => {
    const address = displayUrl?.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
    return (counts.get(label) ?? 0) > 1 && address ? `${label} (${address})` : label;
  });
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
