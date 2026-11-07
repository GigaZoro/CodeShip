import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Pull-to-refresh on a thread list: retries every enabled machine that is not connected now,
 * skipping its backoff. A connected machine is left alone, so a refresh never drops a live one.
 */
export function useReconnectMachines(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: EnvironmentConnectionPhase;
  }>,
) {
  const retry = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const [refreshing, setRefreshing] = useState(false);
  const reconnect = async () => {
    const targets = environments.filter(
      (environment) =>
        environment.connectionState !== "connected" &&
        environment.connectionState !== "available" &&
        environment.connectionState !== "unsupported",
    );
    if (targets.length === 0) return;
    setRefreshing(true);
    // Atom commands settle into results instead of throwing, so this always clears the spinner.
    await Promise.all(targets.map((environment) => retry(environment.environmentId)));
    setRefreshing(false);
  };
  return { refreshing, reconnect };
}
