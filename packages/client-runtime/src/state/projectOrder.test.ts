import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { buildProjectGroups, type ProjectGroup } from "./projectGrouping.ts";
import {
  applyHeldProjectOrder,
  holdProjectOrder,
  planProjectGroupMove,
  releaseProjectOrder,
  sortProjectGroupsManually,
  type ProjectOrderAssignment,
} from "./projectOrder.ts";

const mac = EnvironmentId.make("mac");
const vps = EnvironmentId.make("vps");

const project = (
  id: string,
  environmentId: EnvironmentId,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/work/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

// One checkout of each project per machine, combined into one group per repository.
const checkouts = (names: readonly string[]) =>
  names.flatMap((name, index) =>
    [mac, vps].map((environmentId) =>
      project(`${name}-${environmentId}`, environmentId, {
        title: name,
        workspaceRoot: `/work/${name}`,
        repositoryIdentity: {
          canonicalKey: `github.com/me/${name}`,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: name },
        },
        createdAt: `2026-07-0${index + 1}T00:00:00.000Z`,
      }),
    ),
  );

const group = (projects: ReadonlyArray<EnvironmentProject>) =>
  buildProjectGroups({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  });
const membersOf = (entry: ProjectGroup) => entry.members.map((member) => member.project);
const labels = (groups: ReadonlyArray<ProjectGroup>) => groups.map((entry) => entry.label);

// What the servers hold once they took the assignments, written at `orderedAt`.
const apply = (
  projects: ReadonlyArray<EnvironmentProject>,
  assignments: ReadonlyArray<ProjectOrderAssignment>,
  orderedAt: string,
) =>
  projects.map((entry) => {
    const assignment = assignments.find(
      (candidate) =>
        candidate.environmentId === entry.environmentId && candidate.projectId === entry.id,
    );
    return assignment ? { ...entry, orderKey: assignment.orderKey, orderedAt } : entry;
  });

const move = (
  projects: ReadonlyArray<EnvironmentProject>,
  shown: readonly string[],
  moved: string,
  followsKeys: boolean,
) => {
  const groups = group(projects);
  const keyByLabel = new Map(groups.map((entry) => [entry.label, entry.key]));
  return planProjectGroupMove({
    groups,
    keyOf: (entry) => entry.key,
    projectsOf: membersOf,
    orderedKeys: shown.map((label) => keyByLabel.get(label)!),
    movedKey: keyByLabel.get(moved)!,
    followsKeys,
  });
};

describe("sortProjectGroupsManually", () => {
  it("puts moved groups by their latest written key, then the rest oldest first", () => {
    const earlier = "2026-07-03T00:00:00.000Z";
    const later = "2026-07-04T00:00:00.000Z";
    const projects = [
      project("new", mac, { createdAt: "2026-07-09T00:00:00.000Z" }),
      project("old", mac, { createdAt: "2026-07-02T00:00:00.000Z" }),
      project("second", mac, { orderKey: "m", orderedAt: earlier }),
      // Moved to the top while its other machine was offline, which kept the older key.
      project("first", vps, { orderKey: "t", orderedAt: earlier }),
      project("first-elsewhere", mac, { orderKey: "c", orderedAt: later }),
    ];
    const sorted = sortProjectGroupsManually(
      [["new"], ["old"], ["second"], ["first", "first-elsewhere"]].map((ids) =>
        projects.filter((entry) => ids.includes(entry.id)),
      ),
      (members) => members,
    );
    expect(sorted.map((members) => members[0]!.id)).toEqual(["first", "second", "old", "new"]);
  });
});

describe("planProjectGroupMove", () => {
  it("saves the shown order with the move, then writes only the moved group", () => {
    const initial = checkouts(["api", "web", "docs"]);
    const first = apply(
      initial,
      move(initial, ["docs", "api", "web"], "docs", false),
      "2026-07-10T00:00:00.000Z",
    );
    expect(labels(sortProjectGroupsManually(group(first), membersOf))).toEqual([
      "docs",
      "api",
      "web",
    ]);

    const second = move(first, ["docs", "web", "api"], "web", true);
    expect(new Set(second.map((assignment) => assignment.projectId))).toEqual(
      new Set([ProjectId.make("web-mac"), ProjectId.make("web-vps")]),
    );
    expect(
      labels(
        sortProjectGroupsManually(
          group(apply(first, second, "2026-07-11T00:00:00.000Z")),
          membersOf,
        ),
      ),
    ).toEqual(["docs", "web", "api"]);

    // The VPS was offline for the next move, so only the Mac took it.
    const third = move(first, ["web", "docs", "api"], "web", true).filter(
      (assignment) => assignment.environmentId === mac,
    );
    expect(
      labels(
        sortProjectGroupsManually(
          group(apply(first, third, "2026-07-12T00:00:00.000Z")),
          membersOf,
        ),
      ),
    ).toEqual(["web", "docs", "api"]);
  });

  it("gives every client that groups the same way the order the mover saw", () => {
    const initial = checkouts(["api", "web", "docs", "infra"]);
    const saved = apply(
      initial,
      move(initial, ["infra", "api", "web", "docs"], "infra", false),
      "2026-07-10T00:00:00.000Z",
    );
    // Another client lists the machines' projects in its own order before sorting.
    const elsewhere = [...saved].reverse();
    expect(labels(sortProjectGroupsManually(group(elsewhere), membersOf))).toEqual([
      "infra",
      "api",
      "web",
      "docs",
    ]);
  });

  it("does not reuse a key held by a group outside the list", () => {
    const projects = [
      project("pinned", mac, { orderKey: "an", pinnedAt: "2026-07-01T00:00:00.000Z" }),
      project("a", mac),
      project("b", mac),
    ];
    const groups = group(projects);
    const keyOf = (id: string) => groups.find((entry) => entry.representative.id === id)!.key;
    const assignments = planProjectGroupMove({
      groups,
      keyOf: (entry) => entry.key,
      projectsOf: membersOf,
      orderedKeys: [keyOf("b"), keyOf("a")],
      movedKey: keyOf("b"),
      followsKeys: false,
    });
    expect(assignments.map((assignment) => assignment.orderKey)).not.toContain("an");
    expect(assignments).toHaveLength(2);
  });
});

describe("held project order", () => {
  it("shows a sent key until the server replaces it, and drops one the server refused", () => {
    const projects = [project("a", mac, { orderKey: "m" }), project("b", vps)];
    const assignments = [
      { environmentId: mac, projectId: ProjectId.make("a"), orderKey: "t" },
      { environmentId: vps, projectId: ProjectId.make("b"), orderKey: "g" },
    ];
    const held = holdProjectOrder(projects, new Map(), assignments, "2026-07-05T00:00:00.000Z");
    expect(applyHeldProjectOrder(projects, held).map((entry) => entry.orderKey)).toEqual([
      "t",
      "g",
    ]);

    const caughtUp = [{ ...projects[0]!, orderKey: "t" }, projects[1]!];
    const refused = releaseProjectOrder(
      holdProjectOrder(caughtUp, held, [], "2026-07-05T00:00:01.000Z"),
      [assignments[1]!],
    );
    expect(refused.size).toBe(0);
    expect(applyHeldProjectOrder(caughtUp, refused)).toBe(caughtUp);
  });
});
