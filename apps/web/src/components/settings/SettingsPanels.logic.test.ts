import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  changedRestorableSettingLabels,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
  projectScopedRestorePlan,
  restorableSettingsPatch,
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

  it("lists and restores only the settings its page shows", () => {
    expect(changedRestorableSettingLabels(changed, "/settings/keybindings")).toEqual([
      "Send shortcut",
    ]);
    expect(changedRestorableSettingLabels(changed, "/settings/chat")).toEqual([
      "Diff layout",
      "Skill availability",
    ]);
    expect(restorableSettingsPatch(changed, "/settings/chat").skillAvailability).toBe("provider");
    expect(
      Object.keys(
        restorableSettingsPatch(DEFAULT_UNIFIED_SETTINGS, "/settings/keybindings"),
      ).toSorted(),
    ).toEqual(["confirmQuit", "sendShortcut"]);
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
      "confirmQuit",
      "sendShortcut",
    ]);
  });

  it("resets only the git fetch interval override on the source control page", () => {
    const custom = {
      ...DEFAULT_UNIFIED_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(42),
          pauseWhenOnBattery: true,
        },
      },
    } as const;
    expect(changedRestorableSettingLabels(custom, "/settings/source-control")).toEqual([
      "Git fetch interval",
    ]);
    expect(
      changedRestorableSettingLabels(DEFAULT_UNIFIED_SETTINGS, "/settings/source-control"),
    ).toEqual([]);
    const patch = restorableSettingsPatch(custom, "/settings/source-control");
    expect(Object.keys(patch)).toContain("backgroundActivity");
    expect(patch.backgroundActivity?.overrides?.pauseWhenOnBattery).toBe(true);
    expect(patch.backgroundActivity?.overrides?.automaticGitFetchInterval).toBeUndefined();
  });

  it("covers every page when resetting everything", () => {
    expect(changedRestorableSettingLabels(changed, null)).toEqual(
      expect.arrayContaining(["Send shortcut", "Diff layout"]),
    );
  });
});
