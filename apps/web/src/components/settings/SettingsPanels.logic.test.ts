import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
  pageRestorePlan,
  projectScopedRestorePlan,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("getChangedBrowserSettingLabels", () => {
  it("counts a retained custom search URL so restore clears it", () => {
    expect(
      getChangedBrowserSettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        browserCustomSearchUrl: "https://search.example/?q=%s",
      }),
    ).toEqual(["Search engine"]);
  });
});

describe("page reset", () => {
  const changed = {
    ...DEFAULT_UNIFIED_SETTINGS,
    sendShortcut: "mod-enter",
    diffLayout: "split",
    skillAvailability: "shared",
  } as const;

  const onOneMachine = (settings: typeof DEFAULT_UNIFIED_SETTINGS, page: string | null) => {
    const plan = pageRestorePlan([{ environmentId: "laptop", settings }], page);
    return { labels: plan.labels, patch: plan.patches.get("laptop") ?? {} };
  };

  it("lists and restores only the settings its page shows", () => {
    expect(onOneMachine(changed, "/settings/keybindings")).toEqual({
      labels: ["Send shortcut"],
      patch: { sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut },
    });
    const chat = onOneMachine(changed, "/settings/chat");
    expect(chat.labels).toEqual(["Diff layout", "Skill availability"]);
    expect(chat.patch.skillAvailability).toBe("provider");
    expect(onOneMachine(DEFAULT_UNIFIED_SETTINGS, "/settings/keybindings").patch).toEqual({});
    expect(
      Object.keys(
        onOneMachine(
          { ...changed, confirmQuit: "direct", closeWindowToTray: false },
          "/settings/keybindings",
        ).patch,
      ).toSorted(),
    ).toEqual(["closeWindowToTray", "confirmQuit", "sendShortcut"]);
  });

  it("under a project scope clears that project's overrides instead of pinning defaults", () => {
    const changedMachineWide = {
      ...DEFAULT_UNIFIED_SETTINGS,
      snoozeLimitedThreads: !DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
    };
    const plan = projectScopedRestorePlan(
      changedMachineWide,
      "/settings/threads",
      new Set(["sidebarAutoSettleAfterDays", "pullRequestMergeMethod"]),
    );
    // Machine-wide rows can't be reset from a project; only the project's own overrides clear.
    expect(plan.clearKeys).toEqual(["sidebarAutoSettleAfterDays"]);
    expect(plan.labels).toEqual(["Auto-settle inactive threads"]);
    expect(plan.devicePatch).toEqual({});

    const chat = projectScopedRestorePlan(
      changed,
      "/settings/chat",
      new Set(["skillAvailability"]),
    );
    expect(chat.clearKeys).toEqual(["skillAvailability"]);
    expect(chat.labels).toContain("Skill availability");
    expect(chat.devicePatch).not.toHaveProperty("skillAvailability");

    const keybindings = projectScopedRestorePlan(changed, "/settings/keybindings", new Set());
    expect(keybindings.clearKeys).toEqual([]);
    expect(keybindings.labels).toEqual(["Send shortcut"]);
    expect(Object.keys(keybindings.devicePatch).toSorted()).toEqual([
      "closeWindowToTray",
      "confirmQuit",
      "sendShortcut",
    ]);
  });

  it("resets background policy and both intervals only from Maintenance", () => {
    const custom = {
      ...DEFAULT_UNIFIED_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(42),
          providerHealthRefreshInterval: Duration.seconds(91),
          pauseWhenOnBattery: true,
        },
      },
    } as typeof DEFAULT_UNIFIED_SETTINGS;
    for (const page of ["/settings/source-control", "/settings/providers"]) {
      expect(onOneMachine(custom, page)).toEqual({ labels: [], patch: {} });
    }
    const maintenance = onOneMachine(custom, "/settings/maintenance");
    expect(maintenance.labels).toEqual(["Background activity"]);
    expect(maintenance.patch.backgroundActivity).toEqual(
      DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
    );
    expect(maintenance.patch.automaticGitFetchInterval).toEqual(
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    );
    expect(maintenance.patch.providerHealthRefreshInterval).toEqual(
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    );
  });

  it("lists a setting changed on any machine and restores each machine from its own values", () => {
    const plan = pageRestorePlan(
      [
        { environmentId: "laptop", settings: DEFAULT_UNIFIED_SETTINGS },
        { environmentId: "server", settings: changed },
      ],
      "/settings/chat",
    );
    expect(plan.labels).toEqual(["Diff layout", "Skill availability"]);
    expect(plan.patches.get("laptop")).toEqual({});
    expect(plan.patches.get("server")).toEqual({
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      skillAvailability: DEFAULT_UNIFIED_SETTINGS.skillAvailability,
    });
  });

  it("resets restart and network recovery from Threads, not Maintenance", () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      continueThreadsAfterServerUpdate: false,
      retryThreadsAfterNetworkErrors: false,
    };
    expect(onOneMachine(settings, "/settings/maintenance")).toEqual({ labels: [], patch: {} });
    expect(onOneMachine(settings, "/settings/threads")).toEqual({
      labels: ["Continue threads after restarts", "Retry threads after network errors"],
      patch: { continueThreadsAfterServerUpdate: true, retryThreadsAfterNetworkErrors: true },
    });
  });

  it("covers every page when resetting everything", () => {
    expect(onOneMachine(changed, null).labels).toEqual(
      expect.arrayContaining(["Send shortcut", "Diff layout"]),
    );
  });
});
