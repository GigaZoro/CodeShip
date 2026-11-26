import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { msg, t } from "../../lib/i18n";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | {
      readonly kind: "goal";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly actions: ReadonlyArray<FloatingStatusAction>;
    }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly reconnecting?: true;
      readonly label: string;
      readonly onPress: () => void;
    };

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(
  input: {
    readonly connectionError: string | null;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly connectionAwaitingApproval?: boolean;
  },
  resolve: typeof t = t,
): string | null {
  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return resolve(msg("Awaiting device approval"));
  }
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting") {
    return null;
  }
  return input.connectionError === null
    ? resolve(msg("Reconnecting…"))
    : resolve(msg("Retrying connection…"));
}

export function connectionFloatingStatus(
  input: {
    readonly connectionError: string | null;
    readonly connectionState: EnvironmentConnectionPhase;
    readonly connectionAwaitingApproval?: boolean;
    readonly environmentLabel: string | null;
    readonly onReconnect: () => void;
  },
  resolve: typeof t = t,
): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? resolve(msg("Environment"));
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    label,
    onPress: input.onReconnect,
  });

  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return {
      kind: "connection",
      reconnecting: true,
      label: t("Waiting for {environment} to approve this device", {
        environment: environmentLabel,
      }),
      onPress: input.onReconnect,
    };
  }
  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        reconnecting: true,
        label:
          input.connectionError === null
            ? t("Reconnecting to {environment}...", { environment: environmentLabel })
            : t("Failed to connect. Retrying {environment}...", { environment: environmentLabel }),
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable(t("You are offline"));
    case "unsupported":
      return unavailable(t("Client not supported"));
    case "error":
      return unavailable(
        input.connectionError
          ? t("Failed to connect to {environment}: {error}", {
              environment: environmentLabel,
              error: input.connectionError,
            })
          : t("Failed to connect to {environment}", { environment: environmentLabel }),
      );
    case "available":
      return unavailable(t("{environment} is not connected", { environment: environmentLabel }));
    case "connected":
      return null;
  }
}
