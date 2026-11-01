import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserAssistants,
  resolveBrowserProfiles,
  type BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };

describe("resolveBrowserProfiles", () => {
  it("drops stored entries that collide with a built-in id", () => {
    const resolved = resolveBrowserProfiles([
      { id: DEFAULT_BROWSER_PROFILE_ID, name: "Hijacked", kind: "persistent" },
      { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Not incognito", kind: "persistent" },
      work,
    ]);

    expect(resolved).toEqual([...BUILT_IN_BROWSER_PROFILES, work]);
  });
});

describe("resolveBrowserAssistants", () => {
  it("keeps one entry per assistant and signed-in profile", () => {
    const profiles = resolveBrowserProfiles([work]);
    const resolved = resolveBrowserAssistants(
      [
        { kind: "duet", profileId: work.id },
        { kind: "dot", profileId: "removed-profile" },
        { kind: "dot", profileId: INCOGNITO_BROWSER_PROFILE_ID },
        { kind: "duet", profileId: work.id },
        { kind: "dot", profileId: work.id },
      ],
      profiles,
    );

    expect(resolved).toEqual([
      { kind: "duet", profileId: work.id, profile: work },
      { kind: "dot", profileId: work.id, profile: work },
    ]);
  });
});

describe("resolveBrowserProfiles normalization", () => {
  it("reports a custom incognito profile as persistent", () => {
    const resolved = resolveBrowserProfiles([
      { id: "throwaway", name: "Throwaway", kind: "incognito" },
    ]);

    expect(resolved.find((profile) => profile.id === "throwaway")).toEqual({
      id: "throwaway",
      name: "Throwaway",
      kind: "persistent",
    });
  });
});
