import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  sharedSettingKeysIn,
  sharedSettingValue,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  persistScopedSettingsPatch,
  planPerEnvironmentSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  planScopedSettingsUndo,
  scopedIdleCompaction,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
  sharedSaveSummary,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

/** Persistence for a plan that saves nothing for all machines, so it never asks one to stamp. */
const plainly = <U>(update: U) => ({
  update,
  share: vi.fn(async () => {
    throw new Error("Not saved for all machines");
  }),
});

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
    /** A server from before `server.shareSettings`. */
    older?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
            environment: { capabilities: { shareSettings: options.older !== true } },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
  pinned: false,
  archived: false,
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        defaultAutoPull: false,
        projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(targets.map((target) => [target.projectId, target.settings.defaultAutoPull])).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["defaultAutoPull"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["defaultAutoPull"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["defaultAutoPull"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("edits the effective machine policy without changing other machines' rules", () => {
    const custom = environment("Laptop", {
      settings: {
        worktreeCleanup: {
          mode: "custom",
          rules: {
            worktreeAfterDays: 12,
            worktreeSettledAfterDays: null,
            worktreeOnDelete: true,
            worktreeOnMerge: true,
            worktreeUnchanged: false,
            worktreeKeepWhen: "uncommitted-changes",
          },
        },
      },
    });
    const disabled = environment("Server", {
      settings: { worktreeCleanup: { mode: "off" } },
    });
    const targets = [custom, disabled];
    const plan = planScopedSettingsPatch(all, targets, {
      storageCleanup: { worktreeOnDelete: false },
    });
    const policies = plan.serverWrites.map((write, index) =>
      resolveWorktreeCleanup(
        applyServerSettingsPatch(targets[index]!.serverConfig!.settings, write.patch),
        null,
      ),
    );
    expect(policies).toEqual([
      {
        worktreeAfterDays: 12,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: true,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
      {
        worktreeAfterDays: null,
        worktreeSettledAfterDays: null,
        worktreeOnDelete: false,
        worktreeOnMerge: false,
        worktreeUnchanged: false,
        worktreeKeepWhen: "uncommitted-changes",
      },
    ]);
  });

  it("compares idle compaction by mode, and offers Never only where every server stores it", () => {
    const fixed = {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        compactIdleThreads: false,
        idleCompaction: "onReturn" as const,
      },
    };
    const modes = {
      settings: { ...DEFAULT_SERVER_SETTINGS, compactIdleThreads: "onReturn" as const },
    };
    const legacy = { settings: { ...DEFAULT_SERVER_SETTINGS, compactIdleThreads: false } };
    expect(scopedIdleCompaction([fixed, modes])).toEqual({ mixed: false, neverAvailable: true });
    expect(scopedIdleCompaction([fixed, legacy])).toEqual({ mixed: false, neverAvailable: false });
    expect(
      scopedIdleCompaction([fixed, { settings: { ...fixed.settings, idleCompaction: "off" } }])
        .mixed,
    ).toBe(true);
  });

  it("sends an idle compaction mode in the form each environment's server reads", () => {
    const targets = [
      environment("Fixed", { settings: { compactIdleThreads: false, idleCompaction: "onReturn" } }),
      environment("Modes", { settings: { compactIdleThreads: "onReturn" } }),
      environment("Switch", { settings: { compactIdleThreads: false } }),
    ];
    const plan = planScopedSettingsPatch(resolveSettingsScope({}, [], targets), targets, {
      idleCompaction: "beforeCacheExpires",
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { idleCompaction: "beforeCacheExpires" },
      { compactIdleThreads: "beforeCacheExpires" },
      { compactIdleThreads: true },
    ]);
  });

  it("writes an aggregate preference only to connected environments with loaded configuration", async () => {
    const persistServer = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, { enableProviderUpdateChecks: false }),
      plainly(persistServer),
      persistClient,
    );
    expect(persistServer.mock.calls.map(([input]) => input.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  describe("an environment that saves but drops keys it does not know", () => {
    const upgradedLaptop = (saved: Partial<ServerSettings>) =>
      vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          ...(environmentId === laptop.environmentId ? saved : {}),
        },
      }));
    const outcome = async (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      persistServer: ReturnType<typeof upgradedLaptop>,
    ) => {
      const result = await persistScopedSettingsPatch(plan, plainly(persistServer), vi.fn());
      return {
        saved: result.savedEnvironments.map(({ label }) => label),
        failed: result.failedEnvironments.map(({ label, message }) => ({ label, message })),
      };
    };
    const unsupported = [
      {
        label: server.label,
        message: "This environment does not support this setting. Update T3.CodeShip on it.",
      },
    ];

    it("reports a dropped toggle", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: true }),
          upgradedLaptop({ reviewGuidesEnabled: true }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports dropped text but accepts the server trimming it", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuideInstructions: " Read tests " }),
          upgradedLaptop({ reviewGuideInstructions: "Read tests" }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    // regression: #18334 an environment silently dropped a setting with no warning
    it("reports a dropped key inside a project override", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(project, environments, { defaultAutoPull: true }),
          upgradedLaptop({
            projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } },
          }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("accepts a write that matches what the environment already had", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { reviewGuidesEnabled: false }),
          upgradedLaptop({}),
        ),
      ).toEqual({ saved: [laptop.label, server.label], failed: [] });
    });
  });

  it("persists client keys locally at any scope alongside server keys", async () => {
    const persistServer = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
    });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, {
        diffIgnoreWhitespace: false,
        enableProviderUpdateChecks: false,
      }),
      plainly(persistServer),
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ diffIgnoreWhitespace: false });
    expect(persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: server.environmentId,
      input: { patch: { enableProviderUpdateChecks: false } },
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      defaultAutoPull: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [projectId]: { enableAgentBrowserAccess: false, defaultAutoPull: true },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [laptopProjectId]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("keeps each project's other cleanup rules when changing one rule across machines", () => {
    const machine = environment("Laptop", {
      settings: {
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeAfterDays: 30 },
      },
    });
    const customized = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: {
            defaultAutoPull: true,
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: 8,
                worktreeSettledAfterDays: null,
                worktreeOnDelete: false,
                worktreeOnMerge: true,
                worktreeUnchanged: false,
                worktreeKeepWhen: "uncommitted-changes",
              },
            },
          },
        },
      },
    });
    const plan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnDelete: true } },
    });
    const settledPlan = planScopedSettingsPatch(project, [machine, customized], {
      worktreeCleanup: { mode: "custom", rules: { worktreeSettledAfterDays: 0 } },
    });
    expect(
      settledPlan.serverWrites.map((write) => write.patch.projectSettingsOverrides),
    ).toMatchObject([
      { [projectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
      { [laptopProjectId]: { worktreeCleanup: { rules: { worktreeSettledAfterDays: 0 } } } },
    ]);
    expect(plan.serverWrites.map((write) => write.patch.projectSettingsOverrides)).toEqual([
      {
        [projectId]: {
          defaultAutoPull: true,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 8,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: true,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
      {
        [laptopProjectId]: {
          worktreeCleanup: {
            mode: "custom",
            rules: {
              worktreeAfterDays: 30,
              worktreeSettledAfterDays: null,
              worktreeOnDelete: true,
              worktreeOnMerge: false,
              worktreeUnchanged: false,
              worktreeKeepWhen: "uncommitted-changes",
            },
          },
        },
      },
    ]);
    expect(
      planScopedSettingsClear(checkout, [customized], ["worktreeCleanup"]).serverWrites[0]?.patch,
    ).toEqual({
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    expect(
      planScopedSettingsPatch(project, [machine, customized], {
        storageCleanup: { browserArtifactsAfterDays: 8 },
      }).serverWrites,
    ).toEqual([]);
  });

  // regression: #11541 device settings were written to the wrong scope
  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } } },
      { projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } } },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a project.",
    });
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { defaultAutoPull: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
      },
    ]);
    expect(
      planScopedSettingsClear(
        checkout,
        [laptop, withOverrides],
        ["defaultAutoPull", "enableAgentBrowserAccess"],
      ).serverWrites[0]?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: null } });
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const saved = {
      _tag: "Success",
      value: { ...DEFAULT_SERVER_SETTINGS, enableAgentBrowserAccess: false },
    };
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "settings:write",
            message: "This connection lacks permission to change settings.",
          }),
        ),
      })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce(saved);
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      plainly(persistServer),
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.savedEnvironments.map(({ label }) => label)).toEqual([
      laptop.label,
      fourth.label,
    ]);
    expect(result.failedEnvironments.map(({ message }) => message)).toEqual([
      "This connection lacks permission to change settings.",
      "Disconnected during save",
    ]);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });
});

describe("per-machine writes and their undo", () => {
  const changedLaptop = environment("Laptop", { settings: { enableProviderUpdateChecks: false } });
  const changedServer = environment("Server", { settings: { autoUpdateProviders: true } });
  const machines = [changedLaptop, changedServer, offline];

  it("writes each machine its own server patch and this device's keys once", () => {
    const plan = planPerEnvironmentSettingsPatch(
      all,
      machines,
      new Map([
        [changedLaptop.environmentId, { enableProviderUpdateChecks: true, diffLayout: "stacked" }],
        [changedServer.environmentId, { autoUpdateProviders: false, diffLayout: "stacked" }],
        [offline.environmentId, { autoUpdateProviders: false }],
      ]),
    );
    expect(plan.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: changedLaptop.label, patch: { enableProviderUpdateChecks: true } },
      { label: changedServer.label, patch: { autoUpdateProviders: false } },
    ]);
    expect(plan.clientPatch).toEqual({ diffLayout: "stacked" });
    expect(plan.unavailableReason).toBeNull();
  });

  it("skips a machine with nothing to write", () => {
    const plan = planPerEnvironmentSettingsPatch(
      all,
      machines,
      new Map([[changedLaptop.environmentId, { enableProviderUpdateChecks: true }]]),
    );
    expect(plan.serverWrites.map(({ label }) => label)).toEqual([changedLaptop.label]);
  });

  it("undoes exactly the keys each machine changed, back to that machine's own values", () => {
    const plan = planPerEnvironmentSettingsPatch(
      all,
      machines,
      new Map([
        [
          changedLaptop.environmentId,
          { enableProviderUpdateChecks: true, autoUpdateProviders: false, diffLayout: "stacked" },
        ],
        [changedServer.environmentId, { autoUpdateProviders: false }],
      ]),
    );
    const undo = planScopedSettingsUndo(plan, { diffLayout: "split" });
    expect(undo.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      {
        label: changedLaptop.label,
        patch: { enableProviderUpdateChecks: false, autoUpdateProviders: false },
      },
      { label: changedServer.label, patch: { autoUpdateProviders: true } },
    ]);
    expect(undo.clientPatch).toEqual({ diffLayout: "split" });
  });

  it("puts back a cleared project override, or removes one the plan created", () => {
    const withOverrides = environment("Server", {
      settings: { projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } },
    });
    const clear = planScopedSettingsClear(checkout, [laptop, withOverrides], ["defaultAutoPull"]);
    expect(planScopedSettingsUndo(clear, {}).serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
    });
    const created = planScopedSettingsPatch(checkout, [laptop, server], { defaultAutoPull: true });
    expect(planScopedSettingsUndo(created, {}).serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: { [projectId]: null },
    });
  });
});

describe("scoped settings mixed values", () => {
  it("treats independently decoded equal nested settings as the same value", () => {
    const style = {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      mode: "custom" as const,
      customInstructions: "Use plain language",
    };
    const first = environment("First", { settings: { sourceControlWritingStyle: { ...style } } });
    const second = environment("Second", { settings: { sourceControlWritingStyle: { ...style } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["sourceControlWritingStyle"])).toBe(false);
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  });

  it("clears only those keys and drops entries that become empty", () => {
    const plan = planProjectOverridesClear(
      [
        environment(laptop, {
          [fleet]: { defaultAutoPull: true, defaultThreadEnvMode: "local" },
          [t3]: { defaultAutoPull: true },
        }),
      ],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["defaultAutoPull"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: laptop,
        label: laptop,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [fleet]: { defaultThreadEnvMode: "local" }, [t3]: null },
        },
      },
    ]);
  });
});

describe("null patches at project scope", () => {
  it("removes the override for keys that cannot store null and keeps it for keys that can", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const scope = {
      kind: "project" as const,
      group: {} as never,
      environmentId: null,
      label: "fleet",
      members: [{ id: projectId, environmentId } as never],
      environmentIds: [environmentId],
    };
    const environments = [
      {
        environmentId,
        label: "Laptop",
        connection: { phase: "connected" as const },
        serverConfig: {
          settings: {
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [projectId]: { defaultThreadEnvMode: "worktree" as const, defaultAutoPull: true },
            },
          },
          environment: { capabilities: { projectSettingsOverrides: true } },
        },
      },
    ];
    expect(
      planScopedSettingsPatch(scope, environments, { defaultThreadEnvMode: null }).serverWrites[0]
        ?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } } });
    expect(
      planScopedSettingsPatch(scope, environments, { defaultModelSelection: null }).serverWrites[0]
        ?.patch,
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          defaultThreadEnvMode: "worktree",
          defaultAutoPull: true,
          defaultModelSelection: null,
        },
      },
    });
  });
});

describe("partial object patches at project scope", () => {
  it("completes a writing style field patch from the target's effective value", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const member = {
      id: projectId,
      environmentId,
      physicalProjectKey: "laptop:/repo",
      environmentLabel: "Laptop",
      title: "fleet",
      workspaceRoot: "/repo",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Keep it short.",
            followChangeRequestTemplates: false,
          },
        },
      },
    };
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [member as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings,
          },
        },
      ],
      { sourceControlWritingStyle: { customInstructions: "Be terse." } },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: {
          sourceControlWritingStyle: {
            mode: "custom",
            customInstructions: "Be terse.",
            followChangeRequestTemplates: false,
          },
        },
      },
    });
  });
});

it("routes legacy model preference keys exclusively to the selected environment", () => {
  const patch = {
    favorites: [{ provider: ProviderInstanceId.make("codex"), model: "sol" }],
    providerModelPreferences: {},
  };
  const plan = planScopedSettingsPatch(named, environments, patch);
  expect(plan.clientPatch).toEqual({});
  expect(plan.hasClientWrite).toBe(false);
  expect(plan.serverWrites).toEqual([
    {
      environmentId: server.environmentId,
      label: server.label,
      previous: expect.anything(),
      patch,
    },
  ]);
});

describe("model selection patches at project scope", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const saved = {
    instanceId: codex,
    model: "gpt-5.6",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  const customized = environment("Server", {
    settings: {
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: saved,
          sourceControlWriterModelSelection: saved,
          reviewGuideModelSelection: saved,
          textGenerationModelSelection: saved,
        },
      },
    },
  });

  // regression: #16581 changing a project's model kept the old model's options
  it("replaces old options when changing model selections", () => {
    const plan = planScopedSettingsPatch(checkout, [customized], {
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
    expect(plan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]).toEqual({
      defaultModelSelection: { instanceId: claude, model: "claude-opus-4-8" },
      sourceControlWriterModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      reviewGuideModelSelection: { instanceId: codex, model: "gpt-5.6-mini" },
      textGenerationModelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
  });

  it("completes partial text-generation selections without retaining old options", () => {
    const modelPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { model: "gpt-5.6-mini" },
    });
    expect(
      modelPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ instanceId: codex, model: "gpt-5.6-mini" });

    const options = [{ id: "reasoningEffort", value: "low" }];
    const optionsPlan = planScopedSettingsPatch(checkout, [customized], {
      textGenerationModelSelection: { options },
    });
    expect(
      optionsPlan.serverWrites[0]?.patch.projectSettingsOverrides?.[projectId]
        ?.textGenerationModelSelection,
    ).toEqual({ ...saved, options });
  });
});

describe("settings saved for all machines", () => {
  const follower = environment("Follower", { settings: { followSharedSettings: true } });
  const sleepingFollower = environment("Sleeper", {
    connected: false,
    settings: { followSharedSettings: true },
  });
  const sleepingLoner = environment("Loner", { connected: false });
  const everyone = [laptop, follower, sleepingFollower, sleepingLoner, loading];
  const scopeAll = resolveSettingsScope({}, [], everyone);
  const STAMP = { updatedAt: "2026-11-11T12:00:00.000Z", origin: follower.environmentId };
  /** The follower that saves first stores the patch over `base` and stamps it. */
  const stampedOver =
    (base: ServerSettings = DEFAULT_SERVER_SETTINGS) =>
    async ({ input }: { environmentId: EnvironmentId; input: { patch: ServerSettingsPatch } }) => {
      const settings = applyServerSettingsPatch(base, input.patch);
      return {
        _tag: "Success" as const,
        value: {
          settings,
          share: {
            stamp: STAMP,
            values: sharedSettingKeysIn(input.patch).map((key) => ({
              key,
              value: sharedSettingValue(settings, key),
            })),
          },
        },
      };
    };
  const savedAs =
    (settings: (input: { patch: ServerSettingsPatch }) => ServerSettings) =>
    async ({ input }: { environmentId: EnvironmentId; input: unknown }) => ({
      _tag: "Success" as const,
      value: settings(input as { patch: ServerSettingsPatch }),
    });

  it("is saved first by the edited machine when it follows, and says who catches up", () => {
    const plan = planScopedSettingsPatch(
      scopeAll,
      everyone,
      { finalReviewByDefault: true },
      follower.environmentId,
    );
    expect(plan.share).toEqual({
      authority: follower.environmentId,
      keys: ["finalReviewByDefault"],
      stampedBy: "server",
    });
    // Only offline machines that are known to follow are told they will catch up.
    expect(plan.offlineFollowers).toEqual(["Sleeper"]);
  });

  it("saves a shared setting only on the machines that follow", () => {
    const plan = planScopedSettingsPatch(
      scopeAll,
      everyone,
      { finalReviewByDefault: true, linkedEnvironmentsEnabled: true },
      laptop.environmentId,
    );
    // A machine outside the group still gets the rest of the change.
    expect(plan.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: "Follower", patch: { finalReviewByDefault: true, linkedEnvironmentsEnabled: true } },
      { label: "Laptop", patch: { linkedEnvironmentsEnabled: true } },
    ]);
    expect(plan.share?.authority).toBe(follower.environmentId);

    const noFollower = [laptop, server];
    const bulk = planScopedSettingsPatch(
      resolveSettingsScope({}, [], noFollower),
      noFollower,
      { finalReviewByDefault: true },
      laptop.environmentId,
    );
    expect(bulk.share).toBeNull();
    expect(bulk.serverWrites.map(({ label }) => label)).toEqual(["Laptop", "Server"]);
  });

  it("keeps a machine that does not follow out while the only follower is reconnecting", () => {
    const cpc = environment("CPC");
    const mac = environment("Mac", {
      connected: false,
      settings: { followSharedSettings: true },
    });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [cpc, mac]),
      [cpc, mac],
      { finalReviewByDefault: true },
      cpc.environmentId,
    );
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toBe(
      "Connect a machine that follows shared settings to save this for all machines.",
    );
  });

  it.each([
    ["a setting that belongs to one machine", scopeAll, { linkedEnvironmentsEnabled: true }],
    ["a write for one machine", named, { finalReviewByDefault: true }],
  ])("does not share %s", (_name, scope, patch) => {
    expect(planScopedSettingsPatch(scope, everyone, patch, laptop.environmentId).share).toBeNull();
  });

  it("has a connected follower save a change no machine is attributed to", () => {
    expect(
      planScopedSettingsPatch(scopeAll, everyone, { finalReviewByDefault: true }).share?.authority,
    ).toBe(follower.environmentId);
  });

  it("sends the other followers the stamp and whole values the first one saved", async () => {
    const edited = environment("Edited", {
      settings: {
        followSharedSettings: true,
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "Edited machine's words.",
          followChangeRequestTemplates: false,
        },
      },
    });
    const other = environment("Other", { settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [edited, other]),
      [edited, other],
      { sourceControlWritingStyle: { mode: "custom" } },
      edited.environmentId,
    );
    const share = vi.fn(stampedOver(edited.serverConfig!.settings));
    const update = vi.fn(savedAs(() => DEFAULT_SERVER_SETTINGS));
    await persistScopedSettingsPatch(plan, { update, share }, vi.fn());
    expect(share.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId: edited.environmentId,
        input: { patch: { sourceControlWritingStyle: { mode: "custom" } } },
      },
    ]);
    expect(update.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId: other.environmentId,
        input: {
          patch: {},
          share: {
            stamp: STAMP,
            values: [
              {
                key: "sourceControlWritingStyle",
                value: {
                  mode: "custom",
                  customInstructions: "Edited machine's words.",
                  followChangeRequestTemplates: false,
                },
              },
            ],
          },
        },
      },
    ]);
  });

  it("is saved first by a follower that stamps changes, past an older edited one", () => {
    const older = environment("Older", { older: true, settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [older, follower]),
      [older, follower],
      { finalReviewByDefault: true },
      older.environmentId,
    );
    expect(plan.share).toMatchObject({ authority: follower.environmentId, stampedBy: "server" });
  });

  it("sends an older follower the first one's stamp with the values in its patch", async () => {
    const older = environment("Older", { older: true, settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [follower, older]),
      [follower, older],
      { finalReviewByDefault: true },
      follower.environmentId,
    );
    const update = vi.fn(
      savedAs(({ patch }) => applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch)),
    );
    const { failedEnvironments } = await persistScopedSettingsPatch(
      plan,
      { update, share: vi.fn(stampedOver()) },
      vi.fn(),
    );
    expect(update.mock.calls.map(([request]) => request)).toEqual([
      {
        environmentId: older.environmentId,
        input: { patch: { finalReviewByDefault: true }, share: STAMP },
      },
    ]);
    expect(failedEnvironments).toEqual([]);
  });

  it("stamps the change itself, whole values to every follower, while none can", async () => {
    const edited = environment("Edited", {
      older: true,
      settings: {
        followSharedSettings: true,
        sourceControlWritingStyle: {
          mode: "repo_conventions",
          customInstructions: "Edited machine's words.",
          followChangeRequestTemplates: false,
        },
      },
    });
    const other = environment("Other", { older: true, settings: { followSharedSettings: true } });
    const loner = environment("Loner", { older: true });
    const machines = [edited, other, loner];
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], machines),
      machines,
      { sourceControlWritingStyle: { mode: "custom" }, worktreesDirectory: "/work" },
      edited.environmentId,
    );
    expect(plan.share).toMatchObject({ authority: edited.environmentId, stampedBy: "client" });
    const share = vi.fn(stampedOver());
    const update = vi.fn(
      savedAs(({ patch }) => applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch)),
    );
    await persistScopedSettingsPatch(plan, { update, share }, vi.fn());
    expect(share).not.toHaveBeenCalled();
    const whole = {
      mode: "custom",
      customInstructions: "Edited machine's words.",
      followChangeRequestTemplates: false,
    };
    const requests = update.mock.calls.map(([request]) => request);
    const stamp = (requests[0]?.input as { share?: unknown } | undefined)?.share;
    expect(stamp).toEqual({ updatedAt: expect.any(String), origin: edited.environmentId });
    expect(requests).toEqual([
      {
        environmentId: edited.environmentId,
        input: {
          patch: { worktreesDirectory: "/work", sourceControlWritingStyle: whole },
          share: stamp,
        },
      },
      {
        environmentId: other.environmentId,
        input: {
          patch: { worktreesDirectory: "/work", sourceControlWritingStyle: whole },
          share: stamp,
        },
      },
      { environmentId: loner.environmentId, input: { patch: { worktreesDirectory: "/work" } } },
    ]);
  });

  it("undoes a change it stamped itself on every follower", () => {
    const first = environment("First", { older: true, settings: { followSharedSettings: true } });
    const second = environment("Second", { older: true, settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [first, second]),
      [first, second],
      { finalReviewByDefault: true },
      first.environmentId,
    );
    const undo = planScopedSettingsUndo(plan, {});
    expect(undo.share).toMatchObject({ authority: first.environmentId, stampedBy: "client" });
    expect(undo.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: "First", patch: { finalReviewByDefault: false } },
      { label: "Second", patch: { finalReviewByDefault: false } },
    ]);
  });

  it("sends no stamp for a write that is not shared", async () => {
    const plan = planScopedSettingsPatch(named, [laptop, server], { finalReviewByDefault: true });
    const persistServer = vi.fn(
      async (_request: { environmentId: EnvironmentId; input: unknown }) => ({
        _tag: "Success" as const,
        value: { ...DEFAULT_SERVER_SETTINGS, finalReviewByDefault: true },
      }),
    );
    await persistScopedSettingsPatch(plan, plainly(persistServer), vi.fn());
    expect(persistServer.mock.calls[0]?.[0]).toEqual({
      environmentId: server.environmentId,
      input: { patch: { finalReviewByDefault: true } },
    });
  });

  it("says a follower that kept a newer change did not take this one", async () => {
    const otherFollower = environment("Other", { settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [follower, otherFollower]),
      [follower, otherFollower],
      { finalReviewByDefault: true },
      follower.environmentId,
    );
    const kept = { ...DEFAULT_SERVER_SETTINGS, followSharedSettings: true };
    const { failedEnvironments } = await persistScopedSettingsPatch(
      plan,
      {
        update: vi.fn(savedAs(() => kept)),
        share: vi.fn(stampedOver({ ...kept, finalReviewByDefault: false })),
      },
      vi.fn(),
    );
    expect(failedEnvironments.map(({ label, message }) => ({ label, message }))).toEqual([
      {
        label: "Other",
        message: "It already has a newer change to this setting, so it kept that one.",
      },
    ]);
  });

  it("sends the other followers nothing when the first one could not save it", async () => {
    const otherFollower = environment("Other", { settings: { followSharedSettings: true } });
    const plan = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [follower, otherFollower]),
      [follower, otherFollower],
      { finalReviewByDefault: true },
      follower.environmentId,
    );
    const update = vi.fn(savedAs(() => DEFAULT_SERVER_SETTINGS));
    const { failedEnvironments } = await persistScopedSettingsPatch(
      plan,
      {
        update,
        share: vi.fn(async () => ({
          _tag: "Failure" as const,
          cause: Cause.fail(new Error("Its disk is full.")),
        })),
      },
      vi.fn(),
    );
    expect(update).not.toHaveBeenCalled();
    expect(failedEnvironments.map(({ label, message }) => ({ label, message }))).toEqual([
      { label: "Follower", message: "Its disk is full." },
      {
        label: "Other",
        message: "Follower could not save this change first, so it was not sent here.",
      },
    ]);
  });

  it("undoes a shared change as a shared change only when every follower held the same value", () => {
    const otherFollower = environment("Other", { settings: { followSharedSettings: true } });
    const same = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [follower, otherFollower]),
      [follower, otherFollower],
      { finalReviewByDefault: true },
      follower.environmentId,
    );
    const sharedUndo = planScopedSettingsUndo(same, {});
    expect(sharedUndo.share).toMatchObject({ authority: follower.environmentId });
    expect(sharedUndo.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: "Follower", patch: { finalReviewByDefault: false } },
      { label: "Other", patch: {} },
    ]);

    const mixed = environment("Mixed", {
      settings: { followSharedSettings: true, finalReviewByDefault: true },
    });
    const different = planScopedSettingsPatch(
      resolveSettingsScope({}, [], [follower, mixed]),
      [follower, mixed],
      { finalReviewByDefault: false },
      follower.environmentId,
    );
    const ownUndo = planScopedSettingsUndo(different, {});
    expect(ownUndo.share).toBeNull();
    // Each follower gets back what it held, including the shared key it took from the stamp.
    expect(ownUndo.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: "Follower", patch: { finalReviewByDefault: false } },
      { label: "Mixed", patch: { finalReviewByDefault: true } },
    ]);
  });

  it("sends a reset to every follower, and undoes it per machine when they held different values", () => {
    const changed = environment("Changed", {
      settings: { followSharedSettings: true, finalReviewByDefault: true },
    });
    // Already at the default, so the reset has nothing of its own for it.
    const atDefault = environment("At default", { settings: { followSharedSettings: true } });
    const reset = planPerEnvironmentSettingsPatch(
      resolveSettingsScope({}, [], [changed, atDefault]),
      [changed, atDefault],
      new Map([[changed.environmentId, { finalReviewByDefault: false }]]),
      changed.environmentId,
    );
    expect(reset.share).not.toBeNull();
    expect(reset.serverWrites.map(({ label }) => label)).toEqual(["Changed", "At default"]);
    const undo = planScopedSettingsUndo(reset, {});
    expect(undo.share).toBeNull();
    expect(undo.serverWrites.map(({ label, patch }) => ({ label, patch }))).toEqual([
      { label: "Changed", patch: { finalReviewByDefault: true } },
      { label: "At default", patch: { finalReviewByDefault: false } },
    ]);
  });

  it("promises catch-up only when a machine that follows shared settings stored the change", () => {
    const saved = (label: string, followSharedSettings: boolean) =>
      ({ label, settings: { ...DEFAULT_SERVER_SETTINGS, followSharedSettings } }) as never;
    expect(sharedSaveSummary([saved("A", false)], { offlineFollowers: [] })).toBeNull();
    expect(sharedSaveSummary([saved("A", false)], { offlineFollowers: ["Sleeper"] })).toBeNull();
    expect(
      sharedSaveSummary([saved("A", true), saved("B", false)], { offlineFollowers: ["Sleeper"] }),
    ).toEqual({
      reached: ["A", "B"],
      catchingUp: ["Sleeper"],
    });
  });
});
