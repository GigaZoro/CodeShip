import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  deviceSettingsProfileOf,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  deviceSettingsProfileAvailability,
  makeDeviceSettingsProfilePublishes,
  planDeviceSettingsProfileSync,
} from "./deviceSettingsProfile.ts";

const device = (overrides: Partial<ClientSettings> = {}): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  followDeviceSettingsProfile: true,
  ...overrides,
});

/** A device that took the profile of `settings` the last time it synced. */
const synced = (overrides: Partial<ClientSettings> = {}, base: Partial<ClientSettings> = {}) =>
  device({ deviceSettingsProfileBase: deviceSettingsProfileOf(device(base)), ...overrides });

const profileOf = (overrides: Partial<ClientSettings>) =>
  deviceSettingsProfileOf({ ...DEFAULT_CLIENT_SETTINGS, ...overrides });

describe("planDeviceSettingsProfileSync", () => {
  it("never changes a device that does not follow its profile", () => {
    const profile = profileOf({ chatWidth: "full" });
    expect(
      planDeviceSettingsProfileSync({
        local: device({ followDeviceSettingsProfile: false, fontSizeCode: 18 }),
        source: { profile },
      }),
    ).toEqual({ kind: "idle" });
  });

  it("does nothing while no server can hold the profile", () => {
    expect(
      planDeviceSettingsProfileSync({ local: synced({ chatWidth: "full" }), source: null }),
    ).toEqual({ kind: "idle" });
  });

  it("seeds an empty profile with the whole of its own, synced before or not", () => {
    for (const local of [
      device({ chatWidth: "wide", language: "uk" }),
      synced({ chatWidth: "wide", language: "uk" }, { chatWidth: "full" }),
    ]) {
      expect(planDeviceSettingsProfileSync({ local, source: { profile: {} } })).toEqual({
        kind: "publish",
        profile: deviceSettingsProfileOf(local),
        base: deviceSettingsProfileOf(local),
        seed: true,
      });
    }
  });

  it("takes a profile that has values over a device that never synced", () => {
    const profile = profileOf({ chatWidth: "full", fontSizeCode: 18 });
    const plan = planDeviceSettingsProfileSync({
      local: device({ chatWidth: "wide" }),
      source: { profile },
    });
    expect(plan).toMatchObject({
      kind: "apply",
      values: { chatWidth: "full", fontSizeCode: 18 },
      conflict: false,
      base: profile,
    });
  });

  it("is idle once the device and the profile agree with the base", () => {
    const local = synced({ chatWidth: "wide" }, { chatWidth: "wide" });
    expect(
      planDeviceSettingsProfileSync({
        local,
        source: { profile: profileOf({ chatWidth: "wide" }) },
      }),
    ).toEqual({ kind: "idle" });
  });

  it("takes a changed profile when the device has no change of its own", () => {
    const profile = profileOf({ chatWidth: "full" });
    const plan = planDeviceSettingsProfileSync({ local: synced(), source: { profile } });
    expect(plan).toMatchObject({
      kind: "apply",
      values: { chatWidth: "full" },
      conflict: false,
    });
  });

  it("sends the device's changes on top of the profile, keeping keys this build does not know", () => {
    const profile = { ...profileOf({}), fromANewerBuild: { kept: true } };
    const plan = planDeviceSettingsProfileSync({
      local: synced({ fontSizeCode: 16 }),
      source: { profile },
    });
    expect(plan).toEqual({
      kind: "publish",
      profile: { ...profile, fontSizeCode: 16 },
      base: deviceSettingsProfileOf(synced({ fontSizeCode: 16 })),
      seed: false,
    });
  });

  it("lets a newer profile win over a change made while offline, and says so", () => {
    const plan = planDeviceSettingsProfileSync({
      local: synced({ chatWidth: "wide" }),
      source: { profile: profileOf({ chatWidth: "full", fontSizeCode: 18 }) },
    });
    expect(plan).toMatchObject({
      kind: "apply",
      values: { chatWidth: "full", fontSizeCode: 18 },
      conflict: true,
    });
  });

  it("does not call it a conflict when the newer profile holds what the device changed to", () => {
    const plan = planDeviceSettingsProfileSync({
      local: synced({ chatWidth: "wide" }),
      source: { profile: profileOf({ chatWidth: "wide", fontSizeCode: 18 }) },
    });
    expect(plan).toMatchObject({ kind: "apply", values: { fontSizeCode: 18 }, conflict: false });
  });

  it("neither takes nor overwrites a profile value this build cannot read", () => {
    const profile = { ...profileOf({}), chatWidth: "a-width-from-a-newer-build" };
    expect(planDeviceSettingsProfileSync({ local: synced(), source: { profile } })).toEqual({
      kind: "idle",
    });
  });

  it("counts a key the base lacks as unchanged from its default", () => {
    const { chatWidth: _chatWidth, ...withoutChatWidth } = deviceSettingsProfileOf(device());
    const unchanged = device({ deviceSettingsProfileBase: withoutChatWidth });
    expect(
      planDeviceSettingsProfileSync({ local: unchanged, source: { profile: profileOf({}) } }),
    ).toEqual({ kind: "idle" });
    const changed = device({
      chatWidth: "full",
      deviceSettingsProfileBase: withoutChatWidth,
    });
    expect(
      planDeviceSettingsProfileSync({ local: changed, source: { profile: profileOf({}) } }),
    ).toMatchObject({ kind: "publish", profile: { chatWidth: "full" }, seed: false });
  });
});

describe("makeDeviceSettingsProfilePublishes", () => {
  const before = profileOf({ chatWidth: "wide" });

  it("waits for a publish, then for the profile it replaced to be replaced", () => {
    const publishes = makeDeviceSettingsProfilePublishes();
    const publish = publishes.begin(before);
    expect(publishes.canPlan(before)).toBe(false);
    expect(publishes.settle(publish, true)).toBe(true);
    expect(publishes.canPlan(before)).toBe(false);
    expect(publishes.canPlan(profileOf({ chatWidth: "full" }))).toBe(true);
  });

  it("ignores a publish that settles after the switch was turned off and on", () => {
    const publishes = makeDeviceSettingsProfilePublishes();
    const late = publishes.begin(before);
    publishes.restart();
    // Its base would undo the fresh start, and it no longer holds back the next publish.
    expect(publishes.settle(late, true)).toBe(false);
    expect(publishes.canPlan(before)).toBe(true);
    const next = publishes.begin(before);
    expect(publishes.settle(next, false)).toBe(true);
    expect(publishes.canPlan(before)).toBe(true);
  });
});

describe("deviceSettingsProfileAvailability", () => {
  const primary = (
    overrides: {
      phase?: "connected" | "connecting";
      capable?: boolean;
      follows?: boolean;
    } = {},
  ) => ({
    connection: { phase: overrides.phase ?? ("connected" as const) },
    serverConfig: {
      environment: { capabilities: { deviceSettingsProfile: overrides.capable ?? true } },
      settings: {
        followSharedSettings: overrides.follows ?? true,
        deviceSettingsProfile: { chatWidth: "full" },
      },
    },
  });

  it("reads the profile of a primary server that follows shared settings", () => {
    expect(deviceSettingsProfileAvailability(primary())).toEqual({
      status: "ready",
      source: { profile: { chatWidth: "full" } },
    });
  });

  it.each([
    ["has no primary server", null, "no-primary"],
    ["is offline", primary({ phase: "connecting" }), "offline"],
    ["is a server that predates the profile", primary({ capable: false }), "unsupported"],
    [
      "is a server that does not follow shared settings",
      primary({ follows: false }),
      "not-following",
    ],
  ] as const)("says why when the primary %s", (_name, environment, status) => {
    expect(deviceSettingsProfileAvailability(environment)).toEqual({ status });
  });
});
