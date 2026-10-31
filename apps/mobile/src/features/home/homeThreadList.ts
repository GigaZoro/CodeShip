import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  getThreadSortTimestamp,
  toSortableTimestamp,
} from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts";
import type { SidebarGroupBy } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { ThreadListV2Folder, ThreadListV2Grouping } from "../threads/threadListV2";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

export interface HomeProjectScope {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

function getProjectSortTimestamp(
  project: EnvironmentProject,
  sortOrder: HomeProjectSortOrder,
): number {
  return sortOrder === "created_at"
    ? (toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY)
    : (toSortableTimestamp(project.updatedAt) ??
        toSortableTimestamp(project.createdAt) ??
        Number.NEGATIVE_INFINITY);
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

export function sortHomeProjectScopes(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly projectSortOrder: HomeProjectSortOrder;
}): ReadonlyArray<HomeProjectScope> {
  const scopeKeyByProjectRef = new Map(
    input.scopes.flatMap((scope) =>
      scope.projectRefs.map(
        (projectRef) =>
          [scopedProjectKey(projectRef.environmentId, projectRef.projectId), scope.key] as const,
      ),
    ),
  );
  const latestActivityByScope = new Map<string, number>();
  const recordActivity = (scopeKey: string | undefined, timestamp: number) => {
    if (!scopeKey || !Number.isFinite(timestamp)) return;
    latestActivityByScope.set(
      scopeKey,
      Math.max(latestActivityByScope.get(scopeKey) ?? Number.NEGATIVE_INFINITY, timestamp),
    );
  };

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(thread.environmentId, thread.projectId)),
      getThreadSortTimestamp(thread, input.projectSortOrder),
    );
  }
  for (const pendingTask of input.pendingTasks) {
    recordActivity(
      scopeKeyByProjectRef.get(scopedProjectKey(pendingTask.environmentId, pendingTask.projectId)),
      Date.parse(pendingTask.createdAt),
    );
  }

  return Arr.sort(
    input.scopes,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (scope: HomeProjectScope) => ({
        timestamp:
          latestActivityByScope.get(scope.key) ??
          Math.max(
            ...scope.projects.map((project) =>
              getProjectSortTimestamp(project, input.projectSortOrder),
            ),
          ),
        title: scope.title,
        key: scope.key,
      }),
    ),
  );
}

/**
 * Folders for the thread list: project scopes in the order given, or machines by name with
 * offline ones last. An offline machine starts closed, since its threads cannot change.
 */
export function buildHomeThreadListGrouping(input: {
  readonly groupBy: SidebarGroupBy;
  readonly folderExpanded: Readonly<Record<string, boolean>> | undefined;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly offline: boolean;
  }>;
}): ThreadListV2Grouping | null {
  const expanded = (key: string, byDefault: boolean) => input.folderExpanded?.[key] ?? byDefault;
  switch (input.groupBy) {
    case "none":
      return null;
    case "project": {
      const scopeKeyByProjectKey = new Map(
        input.projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (ref) => [scopedProjectKey(ref.environmentId, ref.projectId), scope.key] as const,
          ),
        ),
      );
      return {
        folders: input.projectScopes.map((scope): ThreadListV2Folder => ({
          kind: "project",
          key: scope.key,
          label: scope.title,
          projectKey: scopedProjectKey(scope.representative.environmentId, scope.representative.id),
          expandedByDefault: true,
          expanded: expanded(scope.key, true),
        })),
        folderKeyOf: (thread) =>
          scopeKeyByProjectKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? "",
      };
    }
    case "machine":
      return {
        folders: [...input.environments]
          .sort(
            (left, right) =>
              Number(left.offline) - Number(right.offline) || left.label.localeCompare(right.label),
          )
          .map((environment): ThreadListV2Folder => {
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
      };
  }
}

/** Shares the folder state map with project folders, outside their key space. */
function homeMachineFolderKey(environmentId: EnvironmentId): string {
  return `machine:${environmentId}`;
}
