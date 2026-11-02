import { distinctEnvironmentLabels } from "@t3tools/client-runtime/connection";

import {
  useEnvironmentConnectionSummaries,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { isSidebarEnvironmentDisconnected, sortSidebarMachines } from "../Sidebar.logic";
import type { SidebarMachine } from "./SidebarFolderHeader";

/** Every connected machine, this one first, with names told apart when two match. */
export function useSidebarMachines(): readonly SidebarMachine[] {
  const environments = useEnvironmentConnectionSummaries();
  const machineById = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const labels = distinctEnvironmentLabels(
    environments.map((environment) => ({
      label: environment.environmentLabel,
      displayUrl: environment.displayUrl,
    })),
  );
  return sortSidebarMachines(
    environments.map((environment, index) => ({
      environmentId: environment.environmentId,
      label: labels[index] ?? environment.environmentLabel,
      machineKind: machineById.get(environment.environmentId) ?? "server",
      disconnected: isSidebarEnvironmentDisconnected(environment.connectionState),
    })),
    primaryEnvironmentId,
  );
}
