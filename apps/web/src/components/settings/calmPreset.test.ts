import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "../../hooks/useSettings";
import { THREAD_DETAILS_PRESETS, threadDetailsItemsForPreset } from "../chat/threadDetailsItems";
import {
  __resetCalmPresetForTests,
  applyCalmPreset,
  CALM_PRESET_SETTINGS,
  formatCalmPresetChanges,
  planCalmPreset,
  undoCalmPreset,
} from "./calmPreset";

function setup(overrides: Partial<ClientSettings> = {}) {
  __resetCalmPresetForTests();
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...overrides });
  return {
    [Symbol.dispose]: () => {
      __resetCalmPresetForTests();
      __resetClientSettingsPersistenceForTests();
    },
  };
}

const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("CALM_PRESET_SETTINGS", () => {
  it("only sets keys that exist in ClientSettings and never touches notifications", () => {
    const validKeys = new Set(Object.keys(ClientSettingsSchema.fields));
    const presetKeys = Object.keys(CALM_PRESET_SETTINGS);

    expect(presetKeys.length).toBeGreaterThan(0);
    for (const key of presetKeys) {
      expect(validKeys.has(key), `Unknown ClientSettings key: ${key}`).toBe(true);
    }
    expect(decodeClientSettingsPatch(CALM_PRESET_SETTINGS)).toEqual(CALM_PRESET_SETTINGS);
    expect(presetKeys).not.toContain("notificationMode");
    expect(presetKeys).not.toContain("inAppNotificationsEnabled");
  });
});

describe("planCalmPreset", () => {
  it("lists every setting that differs from Calm and builds matching apply and undo patches", () => {
    const debugPreset = THREAD_DETAILS_PRESETS.find((preset) => preset.id === "debug")!;
    const debugItems = threadDetailsItemsForPreset(debugPreset);
    const current: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      interfaceDensity: "comfortable",
      threadDetailsItems: debugItems,
      foldFinishedWork: "never",
      statusColors: "vivid",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    };

    const plan = planCalmPreset(current);

    expect(plan.isActive).toBe(false);
    expect(plan.changes).toEqual([
      {
        key: "interfaceDensity",
        label: "Interface density",
        from: "Comfortable",
        to: "Compact spacing",
      },
      {
        key: "threadDetailsItems",
        label: "Thread details",
        from: "Debug",
        to: "Essentials",
      },
      {
        key: "foldFinishedWork",
        label: "Fold finished work",
        from: "Never",
        to: "Older turns",
      },
      {
        key: "statusColors",
        label: "Status colors",
        from: "Vivid",
        to: "Calm",
      },
    ]);
    expect(plan.patch).toEqual({
      interfaceDensity: "compact",
      threadDetailsItems: {},
      foldFinishedWork: "older",
      statusColors: "calm",
    });
    expect(plan.undoPatch).toEqual({
      interfaceDensity: "comfortable",
      threadDetailsItems: debugItems,
      foldFinishedWork: "never",
      statusColors: "vivid",
    });
    expect(formatCalmPresetChanges(plan.changes)).toBe(
      "Interface density: Comfortable → Compact spacing · Thread details: Debug → Essentials · Fold finished work: Never → Older turns · Status colors: Vivid → Calm",
    );
  });

  it("describes custom thread details counts and ignores redundant default overrides", () => {
    const customPlan = planCalmPreset({
      ...DEFAULT_CLIENT_SETTINGS,
      interfaceDensity: "compact",
      threadDetailsItems: { openIn: true },
      foldFinishedWork: "older",
      statusColors: "calm",
    });
    expect(customPlan.isActive).toBe(false);
    expect(customPlan.changes).toEqual([
      {
        key: "threadDetailsItems",
        label: "Thread details",
        from: "8 of 18 on",
        to: "Essentials",
      },
    ]);

    const redundantPlan = planCalmPreset({
      ...DEFAULT_CLIENT_SETTINGS,
      interfaceDensity: "compact",
      threadDetailsItems: { environment: true },
      foldFinishedWork: "older",
      statusColors: "calm",
    });
    expect(redundantPlan.isActive).toBe(true);
    expect(redundantPlan.changes).toEqual([]);
    expect(redundantPlan.patch).toEqual({});
    expect(redundantPlan.undoPatch).toEqual({});
  });
});

describe("applyCalmPreset and undoCalmPreset", () => {
  it("applies the preset without touching notifications and restores prior values on undo", () => {
    using _cleanup = setup({
      interfaceDensity: "comfortable",
      threadDetailsItems: { openIn: true, usage: true },
      foldFinishedWork: "always",
      statusColors: "vivid",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });
    const onUndone = vi.fn();

    const applied = applyCalmPreset({ onUndone });

    expect(applied).not.toBeNull();
    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "compact",
      threadDetailsItems: {},
      foldFinishedWork: "older",
      statusColors: "calm",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });

    expect(undoCalmPreset(applied!)).toBe(true);
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(getClientSettings()).toMatchObject({
      interfaceDensity: "comfortable",
      threadDetailsItems: { openIn: true, usage: true },
      foldFinishedWork: "always",
      statusColors: "vivid",
      notificationMode: "notifications-and-sound",
      inAppNotificationsEnabled: true,
    });

    // A second undo for the same record is a safe no-op.
    expect(undoCalmPreset(applied!)).toBe(false);
  });

  it("returns null when Calm is already active", () => {
    using _cleanup = setup({
      interfaceDensity: "compact",
      threadDetailsItems: {},
      foldFinishedWork: "older",
      statusColors: "calm",
    });

    expect(applyCalmPreset()).toBeNull();
  });
});
