import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEVICE_SETTINGS_PROFILE_KEYS,
  decodeDeviceSettingsProfileValue,
  deviceSettingsProfileOf,
  isDeviceSettingsProfileKey,
} from "./deviceSettingsProfile.ts";
import { isMachineSharedSettingKey } from "./sharedSettings.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerPatch = Schema.decodeSync(ServerSettingsPatch);

describe("DEVICE_SETTINGS_PROFILE_KEYS", () => {
  it.each([
    "onboardingCompletedAt",
    "browserProfiles",
    "browserAssistants",
    "favorites",
    "providerModelPreferences",
    "pullRequestMergeMethodOverrides",
    "sidebarProjectGroupingOverrides",
    "snapShotShortcut",
    "closeWindowToTray",
    "followDeviceSettingsProfile",
    "deviceSettingsProfileBase",
  ])("never shares %s", (key) => {
    expect(isDeviceSettingsProfileKey(key)).toBe(false);
  });

  it("holds only client settings that a write can set, each once", () => {
    expect(new Set(DEVICE_SETTINGS_PROFILE_KEYS).size).toBe(DEVICE_SETTINGS_PROFILE_KEYS.length);
    for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
      expect(Object.keys(ClientSettingsSchema.fields)).toContain(key);
      expect(Object.keys(ClientSettingsPatch.fields)).toContain(key);
    }
  });

  it("is not a machine setting list: a machine shares only the whole profile", () => {
    for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
      expect(isMachineSharedSettingKey(key)).toBe(false);
    }
    expect(isMachineSharedSettingKey("deviceSettingsProfile")).toBe(true);
  });
});

describe("deviceSettingsProfileOf", () => {
  it("writes every portable setting and reads each back as it was", () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      chatWidth: "full",
      fontSizeCode: 16,
      language: "uk",
      sidebarGroupByProject: true,
      confirmThreadArchive: true,
    } as const;
    const profile = deviceSettingsProfileOf(settings);
    expect(Object.keys(profile).toSorted()).toEqual([...DEVICE_SETTINGS_PROFILE_KEYS].toSorted());
    for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
      expect(decodeDeviceSettingsProfileValue(key, profile)).toEqual(Option.some(settings[key]));
    }
  });

  it("survives the JSON a server stores", () => {
    const profile = deviceSettingsProfileOf(DEFAULT_CLIENT_SETTINGS);
    const stored = JSON.parse(JSON.stringify(profile));
    for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
      expect(decodeDeviceSettingsProfileValue(key, stored)).toEqual(
        Option.some(DEFAULT_CLIENT_SETTINGS[key]),
      );
    }
  });

  it.each([
    ["a value this build does not know", { chatWidth: "wider-than-full" }],
    ["a value of the wrong type", { chatWidth: 3 }],
    ["a missing key", {}],
    ["a key set to undefined", { chatWidth: undefined }],
  ])("reads nothing from %s", (_name, profile) => {
    expect(Option.isNone(decodeDeviceSettingsProfileValue("chatWidth", profile))).toBe(true);
  });
});

describe("deviceSettingsProfile on a server", () => {
  it("is empty until a device publishes it, and a write replaces it whole", () => {
    expect(DEFAULT_SERVER_SETTINGS.deviceSettingsProfile).toEqual({});
    expect(
      decodeServerPatch({
        deviceSettingsProfile: { chatWidth: "full", fromANewerBuild: { kept: true } },
      }),
    ).toEqual({ deviceSettingsProfile: { chatWidth: "full", fromANewerBuild: { kept: true } } });
  });
});
