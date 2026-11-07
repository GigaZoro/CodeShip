import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { planPinnedReorder } from "./threadSort.ts";

/** The project fields the manual order reads. */
export interface OrderedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly orderKey?: string | null | undefined;
  readonly orderedAt?: string | null | undefined;
  readonly createdAt: string;
}

const projectRefKey = (project: Pick<OrderedProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/**
 * A group sits at its most recently written member key, so a move that reached only the machines
 * online at the time still places a project that is on several.
 */
function projectGroupOrderKey(projects: ReadonlyArray<OrderedProject>): string | null {
  let key: string | null = null;
  let at = "";
  for (const project of projects) {
    const candidate = project.orderKey ?? null;
    if (candidate === null) continue;
    const candidateAt = project.orderedAt ?? "";
    if (key === null || candidateAt > at || (candidateAt === at && candidate < key)) {
      key = candidate;
      at = candidateAt;
    }
  }
  return key;
}

function earliestMember(projects: ReadonlyArray<OrderedProject>): {
  readonly createdAt: string;
  readonly ref: string;
} {
  let createdAt = "";
  let ref = "";
  for (const project of projects) {
    const key = projectRefKey(project);
    if (
      ref === "" ||
      project.createdAt < createdAt ||
      (project.createdAt === createdAt && key < ref)
    ) {
      createdAt = project.createdAt;
      ref = key;
    }
  }
  return { createdAt, ref };
}

/**
 * The manual project order: groups moved by hand by their key, then the rest oldest first, so a
 * new project lands at the bottom. Web and mobile both sort with this, so they show one order.
 */
export function sortProjectGroupsManually<TGroup>(
  groups: ReadonlyArray<TGroup>,
  projectsOf: (group: TGroup) => ReadonlyArray<OrderedProject>,
): TGroup[] {
  return groups
    .map((group) => {
      const projects = projectsOf(group);
      return { group, key: projectGroupOrderKey(projects), ...earliestMember(projects) };
    })
    .sort((left, right) => {
      if (left.key !== right.key) {
        if (left.key === null) return 1;
        if (right.key === null) return -1;
        return left.key < right.key ? -1 : 1;
      }
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
      return left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;
    })
    .map(({ group }) => group);
}

export interface ProjectOrderAssignment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly orderKey: string;
}

/**
 * The keys that put `movedKey` where `orderedKeys`, one list of sibling groups, has it. When
 * `followsKeys` is false the list was in another order, so it is saved as shown. Groups outside
 * the list keep their keys and are never written; every member of a written group takes its key.
 */
export function planProjectGroupMove<TGroup>(input: {
  readonly groups: ReadonlyArray<TGroup>;
  readonly keyOf: (group: TGroup) => string;
  readonly projectsOf: (group: TGroup) => ReadonlyArray<OrderedProject>;
  readonly orderedKeys: readonly string[];
  readonly movedKey: string;
  readonly followsKeys: boolean;
}): ProjectOrderAssignment[] {
  const siblings = new Set(input.orderedKeys);
  const groupByKey = new Map(input.groups.map((group) => [input.keyOf(group), group]));
  const keysById = new Map(
    input.groups.map((group) => {
      const key = input.keyOf(group);
      const orderKey =
        siblings.has(key) && !input.followsKeys
          ? null
          : projectGroupOrderKey(input.projectsOf(group));
      return [key, orderKey] as const;
    }),
  );
  return planPinnedReorder({
    orderedIds: input.orderedKeys,
    keysById,
    movedId: input.movedKey,
  }).flatMap(({ id, orderKey }) => {
    const group = groupByKey.get(id);
    if (group === undefined) return [];
    return input
      .projectsOf(group)
      .filter((project) => (project.orderKey ?? null) !== orderKey)
      .map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        orderKey,
      }));
  });
}

interface HeldProjectOrderKey {
  readonly orderKey: string;
  readonly orderedAt: string;
  /** Server keys this client has written over; the held key shows while the server has one. */
  readonly replaces: ReadonlyArray<string | null>;
}

/** Keys this client sent, by project, shown until the server's projects catch up. */
export type HeldProjectOrder = ReadonlyMap<string, HeldProjectOrderKey>;

const isHeldKeyPending = (project: OrderedProject, hold: HeldProjectOrderKey) =>
  hold.replaces.includes(project.orderKey ?? null);

/** `held` without the keys the server has since replaced, plus these assignments sent at `sentAt`. */
export function holdProjectOrder(
  projects: ReadonlyArray<OrderedProject>,
  held: HeldProjectOrder,
  assignments: ReadonlyArray<ProjectOrderAssignment>,
  sentAt: string,
): HeldProjectOrder {
  const byKey = new Map(projects.map((project) => [projectRefKey(project), project]));
  const next = new Map<string, HeldProjectOrderKey>();
  for (const [key, hold] of held) {
    const project = byKey.get(key);
    if (project !== undefined && isHeldKeyPending(project, hold)) next.set(key, hold);
  }
  for (const assignment of assignments) {
    const key = projectRefKey({
      environmentId: assignment.environmentId,
      id: assignment.projectId,
    });
    const project = byKey.get(key);
    if (project === undefined) continue;
    const earlier = next.get(key);
    next.set(key, {
      orderKey: assignment.orderKey,
      orderedAt: sentAt,
      replaces:
        earlier === undefined
          ? [project.orderKey ?? null]
          : [...earlier.replaces, earlier.orderKey],
    });
  }
  return next;
}

/** `held` without these assignments, for a write the server refused. */
export function releaseProjectOrder(
  held: HeldProjectOrder,
  assignments: ReadonlyArray<ProjectOrderAssignment>,
): HeldProjectOrder {
  const next = new Map(held);
  for (const assignment of assignments) {
    const key = projectRefKey({
      environmentId: assignment.environmentId,
      id: assignment.projectId,
    });
    if (next.get(key)?.orderKey === assignment.orderKey) next.delete(key);
  }
  return next;
}

/** `projects` with the keys this client is still waiting on. */
export function applyHeldProjectOrder<TProject extends OrderedProject>(
  projects: ReadonlyArray<TProject>,
  held: HeldProjectOrder,
): ReadonlyArray<TProject> {
  if (held.size === 0) return projects;
  return projects.map((project) => {
    const hold = held.get(projectRefKey(project));
    return hold !== undefined && isHeldKeyPending(project, hold)
      ? { ...project, orderKey: hold.orderKey, orderedAt: hold.orderedAt }
      : project;
  });
}
