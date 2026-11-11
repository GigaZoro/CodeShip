import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import { ProviderInstanceMutation } from "./providerInstance.ts";
import {
  isMachineSharedSettingKey,
  isNewerSharedSetting,
  MACHINE_SHARED_SETTING_KEYS,
  SharedSettingStamp,
} from "./sharedSettings.ts";
import { ServerSettingsPatch } from "./settings.ts";

const decodeStamp = Schema.decodeUnknownSync(SharedSettingStamp);

const HERE = EnvironmentId.make("environment-here");
const OTHER = EnvironmentId.make("environment-zeta");

describe("MACHINE_SHARED_SETTING_KEYS", () => {
  it.each([
    "followSharedSettings",
    "linkedEnvironmentsEnabled",
    "guestSharingEnabled",
    "worktreesDirectory",
    "addProjectBaseDirectory",
    "providerInstances",
    "secretProviders",
    "sourceControlHosts",
    "deviceHosts",
    "threadPage",
    "projectSettingsOverrides",
    "environmentIcon",
  ])("never shares %s", (key) => {
    expect(isMachineSharedSettingKey(key)).toBe(false);
  });

  it("holds only keys a settings write can set, each once", () => {
    expect(new Set(MACHINE_SHARED_SETTING_KEYS).size).toBe(MACHINE_SHARED_SETTING_KEYS.length);
    for (const key of MACHINE_SHARED_SETTING_KEYS) {
      expect(Object.keys(ServerSettingsPatch.fields)).toContain(key);
    }
  });
});

describe("SharedSettingStamp", () => {
  it("accepts the text Date#toISOString writes and nothing that would sort differently", () => {
    const updatedAt = "2026-11-11T12:00:00.000Z";
    expect(decodeStamp({ updatedAt, origin: HERE }).origin).toBe(HERE);
    expect(() => decodeStamp({ updatedAt: "2026-11-11T12:00:00Z", origin: HERE })).toThrow();
    expect(() => decodeStamp({ updatedAt: "yesterday", origin: HERE })).toThrow();
  });
});

describe("isNewerSharedSetting", () => {
  const known = { updatedAt: "2026-11-11T12:00:00.000Z", origin: HERE };

  it.each([
    [
      "any version over none",
      { updatedAt: "2020-01-01T00:00:00.000Z", origin: HERE },
      undefined,
      true,
    ],
    ["a later time", { updatedAt: "2026-11-11T12:00:00.001Z", origin: HERE }, known, true],
    ["an earlier time", { updatedAt: "2026-11-11T11:59:59.999Z", origin: OTHER }, known, false],
    ["the same time and a larger origin", { ...known, origin: OTHER }, known, true],
    ["the same time and a smaller origin", known, { ...known, origin: OTHER }, false],
    ["the same stamp again", known, known, false],
  ])("ranks %s", (_name, candidate, existing, expected) => {
    expect(isNewerSharedSetting(candidate, existing)).toBe(expected);
  });
});

describe("the settings update payload", () => {
  // The payload as servers from before shared settings declare it.
  const OlderPayload = Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  });

  const decodeOlderPayload = Schema.decodeUnknownSync(OlderPayload);

  it("is still read by a server that does not know the share field", () => {
    const decoded = decodeOlderPayload({
      patch: { finalReviewByDefault: true },
      share: { updatedAt: "2026-11-11T12:00:00.000Z", origin: HERE },
    });
    expect(decoded).toEqual({ patch: { finalReviewByDefault: true } });
  });
});
