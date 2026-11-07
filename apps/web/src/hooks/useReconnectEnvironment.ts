import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { readEnvironment } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { t } from "~/i18n";

/**
 * Reconnects a machine now, skipping the retry backoff. A connection the user switched off is
 * switched back on instead, since a retry does nothing while it is off.
 */
export function useReconnectEnvironment(): (environmentId: EnvironmentId) => Promise<void> {
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  return async (environmentId) => {
    const result =
      readEnvironment(environmentId)?.entry.enabled === false
        ? await setEnvironmentEnabled({ environmentId, enabled: true })
        : await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Could not reconnect environment"),
          description: error instanceof Error ? error.message : t("Failed to reconnect."),
        }),
      );
    }
  };
}
