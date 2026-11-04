import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import {
  backgroundActivitySharedPolicySettings,
  changedRestorableSettingLabels,
  getChangedBrowserSettingLabels,
  hasChangedBackgroundActivitySettings,
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
  } as const;

  it("lists and restores only the settings its page shows", () => {
    expect(changedRestorableSettingLabels(changed, "/settings/keybindings")).toEqual([
      "Send shortcut",
    ]);
    expect(changedRestorableSettingLabels(changed, "/settings/chat")).toEqual(["Diff layout"]);
    expect(Object.keys(restorableSettingsPatch("/settings/keybindings")).toSorted()).toEqual([
      "confirmQuit",
      "sendShortcut",
    ]);
  });

  it("limits a project-scoped reset to settings that scope can store", () => {
    expect(Object.keys(restorableSettingsPatch("/settings/threads", true))).not.toContain(
      "snoozeLimitedThreads",
    );
    expect(Object.keys(restorableSettingsPatch("/settings/threads", true))).toContain(
      "sidebarAutoSettleAfterDays",
    );
    expect(Object.keys(restorableSettingsPatch("/settings/maintenance", true))).toEqual([
      "continueThreadsAfterServerUpdate",
    ]);
    expect(Object.keys(restorableSettingsPatch("/settings/keybindings", true)).toSorted()).toEqual([
      "confirmQuit",
      "sendShortcut",
    ]);
    const changedMachineWide = {
      ...DEFAULT_UNIFIED_SETTINGS,
      snoozeLimitedThreads: !DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
    };
    expect(changedRestorableSettingLabels(changedMachineWide, "/settings/threads", true)).toEqual(
      [],
    );
    expect(changedRestorableSettingLabels(changedMachineWide, "/settings/threads")).toEqual([
      "Snooze until limits reset",
    ]);
  });

  it("covers every page when resetting everything", () => {
    expect(changedRestorableSettingLabels(changed, null)).toEqual(
      expect.arrayContaining(["Send shortcut", "Diff layout"]),
    );
  });
});
