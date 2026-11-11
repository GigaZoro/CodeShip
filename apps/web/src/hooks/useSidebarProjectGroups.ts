import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { sortProjectGroupsManually } from "@t3tools/client-runtime/state/project-order";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { useOrderedProjects } from "./useProjectOrder";
import { useClientSettings } from "./useSettings";

export function useSidebarProjectGroups() {
  const projects = useOrderedProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const unsortedGroups = buildSidebarProjectSnapshots({
    projects,
    groupScratchProjects: true,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
  });
  return sortProjectGroupsManually(unsortedGroups, (group) => group.memberProjects);
}
