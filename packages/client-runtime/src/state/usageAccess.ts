import {
  AuthDiagnosticsReadScope,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPresentation } from "../connection/presentation.ts";
import { msg, t, type Message } from "@t3tools/shared/i18n";

type UsageAccessInput = {
  readonly connection: Pick<EnvironmentConnectionPresentation, "phase" | "error">;
  readonly session: SessionGrantInput | null;
  readonly hasSessionError: boolean;
};

export function usageAccessMessage(input: UsageAccessInput) {
  if (input.hasSessionError) {
    return {
      canReadDiagnostics: false,
      isPending: false,
      error: msg("Could not check this connection's access to diagnostics and usage."),
    };
  }
  if (input.session === null) {
    // An attempt that already failed cannot block totals while it retries.
    const { phase, error } = input.connection;
    const isPending =
      error === null &&
      (phase === "connected" || phase === "connecting" || phase === "reconnecting");
    return {
      canReadDiagnostics: false,
      isPending,
      error: isPending ? null : msg("This environment is not connected."),
    };
  }
  const canReadDiagnostics = sessionGrantsScope(input.session, AuthDiagnosticsReadScope);
  return {
    canReadDiagnostics,
    isPending: false,
    error: canReadDiagnostics
      ? null
      : msg("This connection does not have access to diagnostics and usage."),
  };
}

export function resolveUsageAccess(
  input: UsageAccessInput,
  resolve: (message: Message) => string = t,
) {
  const access = usageAccessMessage(input);
  return { ...access, error: access.error === null ? null : resolve(access.error) };
}
