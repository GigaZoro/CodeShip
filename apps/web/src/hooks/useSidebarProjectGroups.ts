import { useAtomValue } from "@effect/atom-react";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { sortProjectGroupsManually } from "@t3tools/client-runtime/state/project-order";
import { resolveSidebarChosenScope } from "../components/Sidebar.logic";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { useAllEnvironmentProjectSnapshotsReady } from "../state/entities";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../state/environments";
import { environmentSummaries } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { useUiStateStore } from "../uiStateStore";
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

/** The `environmentId:projectId` keys the sidebar's scope pickers chose, or null for all. */
export function useSidebarScopedProjectKeys(): ReadonlySet<string> | null {
  const projectGroups = useSidebarProjectGroups();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const projectScopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const machineScopeIds = useUiStateStore((store) => store.sidebarMachineScopeIds);
  // Membership only, so connection and label changes do not re-resolve the scope.
  const environmentIds = useAtomValue(environmentSummaries.environmentIdsAtom);
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  return resolveSidebarChosenScope({
    projectGroups,
    projectScopeKeys,
    machineScopeIds,
    machines: environmentIds.map((environmentId) => ({ environmentId })),
    settings,
    canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
  }).scopedProjectKeys;
}
