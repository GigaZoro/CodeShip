import {
  buildProjectGroups,
  tierProjectGroups,
} from "@t3tools/client-runtime/state/project-grouping";
import { sortProjectGroupsManually } from "@t3tools/client-runtime/state/project-order";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import type { SidebarGrouping } from "@t3tools/contracts/settings";

import { t } from "../../lib/i18n";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { WorkspaceState } from "../../state/workspaceModel";
import type { ThreadListV2Folder, ThreadListV2Grouping } from "../threads/threadListV2";

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly pinned: boolean;
  readonly archived: boolean;
}

export function buildHomeProjectScopes(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}): ReadonlyArray<HomeProjectScope> {
  const projects = input.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  return buildProjectGroups({
    projects,
    groupScratchProjects: true,
    settings: {
      sidebarProjectGroupingMode: input.projectGroupingMode,
      sidebarProjectGroupingOverrides: {},
    },
  }).map((group) => {
    return {
      key: group.key,
      title: group.label,
      representative: group.representative,
      projects: group.members.map((member) => member.project),
      projectRefs: group.memberProjectRefs,
      pinned: group.pinned,
      archived: group.archived,
    };
  });
}

export function findHomeProjectScope(
  scopes: ReadonlyArray<HomeProjectScope>,
  key: string | null,
): HomeProjectScope | null {
  if (key === null) {
    return null;
  }
  return (
    scopes.find((scope) => scope.key === key) ??
    scopes.find((scope) =>
      scope.projectRefs.some(
        (projectRef) => scopedProjectKey(projectRef.environmentId, projectRef.projectId) === key,
      ),
    ) ??
    null
  );
}

/** Folder order, as on web: the saved project order, pinned projects first and archived ones last. */
export function sortHomeProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
): ReadonlyArray<HomeProjectScope> {
  return tierProjectGroups(sortProjectGroupsManually(scopes, (scope) => scope.projects));
}

/**
 * Folders for the thread list: project scopes in the order given, or machines by name, holding
 * a folder for each of their projects when both are on. Going offline never moves a machine;
 * an offline machine starts closed, since its threads cannot change.
 */
export function buildHomeThreadListGrouping(input: {
  readonly grouping: SidebarGrouping;
  readonly folderExpanded: Readonly<Record<string, boolean>> | undefined;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly offline: boolean;
  }>;
}): ThreadListV2Grouping | null {
  const expanded = (key: string, byDefault: boolean) => input.folderExpanded?.[key] ?? byDefault;
  const scopeKeyByProjectKey = new Map(
    input.projectScopes.flatMap((scope) =>
      scope.projectRefs.map(
        (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope.key] as const,
      ),
    ),
  );
  const scopeKeyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    scopeKeyByProjectKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? "";
  // A nested folder shows `project`, the scope's project on its machine.
  const projectFolder = (
    scope: HomeProjectScope,
    project: EnvironmentProject,
    nested: boolean,
  ): ThreadListV2Folder => {
    const key = nested ? homeMachineProjectFolderKey(project.environmentId, scope.key) : scope.key;
    return {
      kind: "project",
      key,
      label: scope.title,
      projectKey: scopedProjectKey(project.environmentId, project.id),
      nested,
      expandedByDefault: true,
      expanded: expanded(key, true),
    };
  };
  if (!input.grouping.machine) {
    return input.grouping.project
      ? {
          folders: input.projectScopes.map((scope) =>
            projectFolder(scope, scope.representative, false),
          ),
          folderKeyOf: scopeKeyOf,
          inner: null,
        }
      : null;
  }
  const environments = [...input.environments].sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.environmentId.localeCompare(right.environmentId),
  );
  return {
    folders: environments.map((environment): ThreadListV2Folder => {
      const key = homeMachineFolderKey(environment.environmentId);
      return {
        kind: "machine",
        key,
        label: environment.label,
        environmentId: environment.environmentId,
        offline: environment.offline,
        expandedByDefault: !environment.offline,
        expanded: expanded(key, !environment.offline),
      };
    }),
    folderKeyOf: (thread) => homeMachineFolderKey(thread.environmentId),
    inner: input.grouping.project
      ? {
          foldersByKey: new Map(
            environments.map((environment) => [
              homeMachineFolderKey(environment.environmentId),
              input.projectScopes.flatMap((scope) => {
                const project =
                  scope.representative.environmentId === environment.environmentId
                    ? scope.representative
                    : scope.projects.find(
                        (candidate) => candidate.environmentId === environment.environmentId,
                      );
                return project ? [projectFolder(scope, project, true)] : [];
              }),
            ]),
          ),
          folderKeyOf: (thread) =>
            homeMachineProjectFolderKey(thread.environmentId, scopeKeyOf(thread)),
        }
      : null,
  };
}

/** A project folder inside a machine folder keeps its own open state. */
function homeMachineProjectFolderKey(environmentId: EnvironmentId, scopeKey: string): string {
  return `${homeMachineFolderKey(environmentId)}:project:${scopeKey}`;
}

export interface HomeFolderNewThreadTarget {
  readonly title: string;
  /** Tells two checkouts of one project on a machine apart. */
  readonly subtitle: string | null;
  readonly project: EnvironmentProject;
}

/**
 * Where a folder's new-thread button starts a thread: its project, or any project on the
 * machine. An offline machine offers none, since it cannot start one until it is back.
 */
export function homeFolderNewThreadTargets(
  folder: ThreadListV2Folder,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): ReadonlyArray<HomeFolderNewThreadTarget> {
  if (folder.kind === "project") {
    for (const scope of projectScopes) {
      const project = scope.projects.find(
        (candidate) =>
          scopedProjectKey(candidate.environmentId, candidate.id) === folder.projectKey,
      );
      if (project) return [{ title: scope.title, subtitle: null, project }];
    }
    return [];
  }
  if (folder.offline) return [];
  return projectScopes.flatMap((scope) => {
    const onMachine = scope.projects.filter(
      (project) => project.environmentId === folder.environmentId,
    );
    return onMachine.map((project) => ({
      title: scope.title,
      subtitle: onMachine.length > 1 ? project.workspaceRoot : null,
      project,
    }));
  });
}

/** Shares the folder state map with project folders, outside their key space. */
function homeMachineFolderKey(environmentId: EnvironmentId): string {
  return `machine:${environmentId}`;
}

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly action: "add-environment" | "retry" | null;
}

/** What Home shows while no machine has an active thread or pending task to list. */
export function deriveHomeEmptyState(input: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): HomeEmptyState {
  const state = input.catalogState;
  if (state.isLoadingConnections) {
    return {
      title: t("Loading environments"),
      detail: t("Checking saved environments on this device."),
      loading: true,
      action: null,
    };
  }
  if (!state.hasConnections) {
    return {
      title: t("No environments connected"),
      detail: t("Add an environment to load projects and start coding sessions."),
      loading: false,
      action: "add-environment",
    };
  }
  // Pull-to-refresh and Retry reach only these machines; see useReconnectMachines.
  const retryable = state.connectionState === "offline" || state.connectionState === "error";
  if (!state.hasLoadedShellSnapshot) {
    const offlineDetail = t(
      "The saved environment is offline. Check the URL or start the environment, then retry.",
    );
    switch (state.connectionState) {
      case "connected":
        // The shell stream retries a failed sync by itself.
        return {
          title: t("Loading threads"),
          detail:
            state.shellSnapshotError ??
            t("Loading projects and threads from the saved environment."),
          loading: true,
          action: null,
        };
      case "connecting":
      case "reconnecting":
        return {
          title: t("Connecting to environment"),
          detail:
            state.connectionError ?? t("Loading projects and threads from the saved environment."),
          loading: true,
          action: null,
        };
      case "unsupported":
        return {
          title: t("Client not supported"),
          detail: state.connectionError ?? offlineDetail,
          loading: false,
          action: "add-environment",
        };
      case "available":
      case "offline":
      case "error":
        return {
          title: t("Environment unavailable"),
          detail: state.connectionError ?? state.shellSnapshotError ?? offlineDetail,
          loading: false,
          action: retryable ? "retry" : "add-environment",
        };
    }
  }
  const action = retryable ? "retry" : null;
  if (input.projectCount === 0) {
    return {
      title: t("No projects found"),
      detail: t("The connected environment did not report any projects."),
      loading: false,
      action,
    };
  }
  return {
    title: t("No threads yet"),
    detail: t("Create a task to start a new coding session."),
    loading: false,
    action,
  };
}
