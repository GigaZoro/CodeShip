import { msg, t } from "~/i18n";
import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
  resolve: typeof t = t,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: resolve(msg("Connected")),
        statusText: connectionStatusText(connection, resolve),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: resolve(msg("Connecting…")),
        statusText: connectionStatusText(connection, resolve),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: connection.awaitingApproval
          ? resolve(msg("Waiting for approval…"))
          : resolve(msg("Reconnecting…")),
        statusText: connectionStatusText(connection, resolve),
        tone: "connecting",
      };
    case "unsupported":
      return {
        buttonLabel: resolve(msg("Client not supported")),
        statusText: connectionStatusText(connection, resolve),
        tone: "idle",
      };
    case "error":
      return {
        buttonLabel: resolve(msg("Connection failed")),
        statusText: connectionStatusText(connection, resolve),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: resolve(msg("Offline")),
        statusText: connectionStatusText(connection, resolve),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: resolve(msg("Not connected")),
        statusText: connectionStatusText(connection, resolve),
        tone: "idle",
      };
  }
}
