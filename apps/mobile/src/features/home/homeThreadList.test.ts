import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeProjectScopes,
  buildHomeThreadListGrouping,
  findHomeProjectScope,
  homeFolderNewThreadTargets,
  type HomeProjectScope,
} from "./homeThreadList";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items } from "../threads/threadListV2";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  });
}

describe("home project scopes", () => {
  it("filters threads across both scratch hosts while retaining the selected environment boundary", () => {
    const localEnvironmentId = EnvironmentId.make("local");
    const remoteEnvironmentId = EnvironmentId.make("remote");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("scratch-local"),
        title: "No project",
        workspaceRoot: "/local/scratch",
        isScratch: true,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("scratch-remote"),
        title: "No project",
        workspaceRoot: "/remote/scratch",
        isScratch: true,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("ordinary"),
        title: "No project",
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId: project.environmentId,
        projectId: project.id,
        id: ThreadId.make(`thread-${project.id}`),
        title: project.id,
      }),
    );
    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "separate",
    });
    expect(scopes).toHaveLength(2);
    const scratchScope = scopes.find((scope) => scope.representative.isScratch)!;
    const filtered = buildThreadListV2Items({
      threads,
      environmentId: null,
      projectRefs: scratchScope.projectRefs,
      searchQuery: "",
      now: "2026-06-01T00:00:00.000Z",
    });
    expect(filtered.items.map((item) => item.thread.id).sort()).toEqual(
      threads
        .slice(0, 2)
        .map((thread) => thread.id)
        .sort(),
    );
    const remoteScopes = buildHomeProjectScopes({
      projects,
      environmentId: remoteEnvironmentId,
      projectGroupingMode: "separate",
    });
    const remoteScratch = remoteScopes.find((scope) => scope.representative.isScratch)!;
    expect(remoteScratch.key).toBe(scratchScope.key);
    expect(remoteScratch.projectRefs).toEqual([
      { environmentId: remoteEnvironmentId, projectId: projects[1]!.id },
    ]);
    expect(
      buildThreadListV2Items({
        threads,
        environmentId: remoteEnvironmentId,
        projectRefs: remoteScratch.projectRefs,
        searchQuery: "",
        now: "2026-06-01T00:00:00.000Z",
      }).items.map((item) => item.thread.id),
    ).toEqual([threads[1]!.id]);
  });

  it("keeps repository identity from an older duplicate when the freshness winner lacks it", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-with-identity"),
        title: "t3code",
        workspaceRoot: "/remote/t3code",
        repositoryIdentity,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-fresh"),
        title: "t3code",
        workspaceRoot: "/remote/t3code/",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.representative.id).toBe(ProjectId.make("project-local"));
    expect(scopes[0]?.projects.map((project) => project.id)).toContain(
      ProjectId.make("project-remote-fresh"),
    );
    expect(scopes[0]?.projectRefs).toHaveLength(3);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });

  it("prefers an exact scope key over a project ID that collides with it", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const collidingProject = makeProject({
      environmentId,
      id: ProjectId.make("/workspaces/target"),
      title: "Colliding",
      workspaceRoot: "/workspaces/colliding",
    });
    const targetProject = makeProject({
      environmentId,
      id: ProjectId.make("project-target"),
      title: "Target",
      workspaceRoot: "/workspaces/target",
    });
    const scopes = buildHomeProjectScopes({
      projects: [collidingProject, targetProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });
    const targetScope = scopes.find((scope) => scope.title === "Target");
    expect(scopes.map((scope) => scope.title)).toEqual(["Colliding", "Target"]);
    expect(targetScope?.key).toBe("environment-local:/workspaces/target");

    expect(findHomeProjectScope(scopes, "environment-local:/workspaces/target")).toBe(targetScope);
    expect(findHomeProjectScope(scopes, "environment-local:project-target")).toBe(targetScope);
    expect(findHomeProjectScope(scopes, "environment-local:missing")).toBeNull();
    expect(findHomeProjectScope(scopes, null)).toBeNull();
  });
});

describe("home thread list grouping", () => {
  it("offers a machine's projects, every checkout of each, and none while it is offline", () => {
    const studio = EnvironmentId.make("studio");
    const laptop = EnvironmentId.make("laptop");
    const scope = (key: string, projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope => ({
      key,
      title: key,
      representative: projects[0]!,
      projects,
      projectRefs: projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    });
    const api = makeProject({ environmentId: studio, id: ProjectId.make("api"), title: "api" });
    const apiCopy = makeProject({
      environmentId: studio,
      id: ProjectId.make("api-copy"),
      title: "api",
    });
    const web = makeProject({ environmentId: laptop, id: ProjectId.make("web"), title: "web" });
    const scopes = [scope("api", [api, apiCopy]), scope("web", [web])];
    const machine = (offline: boolean) => ({
      kind: "machine" as const,
      key: `machine:${studio}`,
      label: "Studio",
      environmentId: studio,
      offline,
      expanded: true,
      expandedByDefault: true,
    });

    expect(homeFolderNewThreadTargets(machine(false), scopes)).toEqual([
      { title: "api", subtitle: api.workspaceRoot, project: api },
      { title: "api", subtitle: apiCopy.workspaceRoot, project: apiCopy },
    ]);
    expect(homeFolderNewThreadTargets(machine(true), scopes)).toEqual([]);
    const nestedProject = {
      kind: "project" as const,
      key: `machine:${studio}:project:api`,
      label: "api",
      projectKey: `${studio}:${apiCopy.id}`,
      nested: true,
      expanded: true,
      expandedByDefault: true,
    };
    expect(homeFolderNewThreadTargets(nestedProject, scopes)).toEqual([
      { title: "api", subtitle: null, project: apiCopy },
    ]);
  });

  it("orders machines by name with offline ones last, closed until the user opens one", () => {
    const machine = (id: string, label: string, offline: boolean) => ({
      environmentId: EnvironmentId.make(id),
      label,
      offline,
    });
    const grouping = buildHomeThreadListGrouping({
      grouping: { project: false, machine: true },
      folderExpanded: { "machine:studio": true },
      projectScopes: [],
      environments: [
        machine("laptop", "Laptop", true),
        machine("vps", "VPS", false),
        machine("studio", "Studio", true),
        machine("desk", "Desk", false),
      ],
    });

    expect(
      grouping?.folders.map((folder) => [folder.label, folder.expanded, folder.expandedByDefault]),
    ).toEqual([
      ["Desk", true, true],
      ["VPS", true, true],
      ["Laptop", false, false],
      ["Studio", true, false],
    ]);
  });

  it("gives each machine a folder for each of its projects, favicon from that machine", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const project = (environmentId: EnvironmentId, id: string, title: string) =>
      makeProject({
        environmentId,
        id: ProjectId.make(id),
        title,
        workspaceRoot: `/workspaces/${title}`,
        repositoryIdentity: {
          canonicalKey: `github.com/acme/${title}`,
          locator: { source: "git-remote", remoteName: "origin", remoteUrl: title },
        },
      });
    const scopes = buildHomeProjectScopes({
      projects: [project(laptop, "app-laptop", "app"), project(vps, "app-vps", "app")],
      environmentId: null,
      projectGroupingMode: "repository",
    });
    const grouping = buildHomeThreadListGrouping({
      grouping: { project: true, machine: true },
      folderExpanded: undefined,
      projectScopes: scopes,
      environments: [
        { environmentId: vps, label: "VPS", offline: false },
        { environmentId: laptop, label: "Laptop", offline: false },
      ],
    });
    const inner = (environmentId: EnvironmentId) =>
      grouping?.inner?.foldersByKey
        .get(`machine:${environmentId}`)
        ?.map((folder) => [folder.label, folder.kind === "project" && folder.projectKey]);

    expect(scopes).toHaveLength(1);
    expect(grouping?.folders.map((folder) => folder.label)).toEqual(["Laptop", "VPS"]);
    expect([inner(laptop), inner(vps)]).toEqual([
      [["app", "laptop:app-laptop"]],
      [["app", "vps:app-vps"]],
    ]);
    expect(
      grouping?.inner?.folderKeyOf(
        makeThread({
          environmentId: vps,
          projectId: ProjectId.make("app-vps"),
          id: ThreadId.make("thread"),
          title: "Thread",
        }),
      ),
    ).toBe(grouping?.inner?.foldersByKey.get("machine:vps")?.[0]?.key);
  });
});
