import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;

/** Control characters could collide with client cache-key delimiters and select another partition. */
export const BrowserProfileId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
export type BrowserProfileId = typeof BrowserProfileId.Type;

export const BrowserProfileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);

export const BrowserProfileKind = Schema.Literals(["persistent", "incognito"]);
export type BrowserProfileKind = typeof BrowserProfileKind.Type;

export const BrowserProfile = Schema.Struct({
  id: BrowserProfileId,
  name: BrowserProfileName,
  kind: BrowserProfileKind,
});
export type BrowserProfile = typeof BrowserProfile.Type;

export const DEFAULT_BROWSER_PROFILE_ID: BrowserProfileId = "default";
export const INCOGNITO_BROWSER_PROFILE_ID: BrowserProfileId = "incognito";

export const BUILT_IN_BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export function isBuiltInBrowserProfileId(id: string): boolean {
  return BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);
}

/** Deduplicates ids sharing a partition; only the built-in incognito id is actually ephemeral. */
export function resolveBrowserProfiles(
  userProfiles: ReadonlyArray<BrowserProfile>,
): ReadonlyArray<BrowserProfile> {
  const seen = new Set(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id));
  const resolved = [...BUILT_IN_BROWSER_PROFILES];
  for (const profile of userProfiles) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    resolved.push(profile.kind === "persistent" ? profile : { ...profile, kind: "persistent" });
  }
  return resolved;
}

export function findBrowserProfile(
  profiles: ReadonlyArray<BrowserProfile>,
  id: string | undefined,
): BrowserProfile | undefined {
  return id === undefined ? undefined : profiles.find((profile) => profile.id === id);
}

/** Always-on assistants that only have a web UI: a ChatGPT dot or a Claude Duet. */
export const BrowserAssistantKind = Schema.Literals(["dot", "duet"]);
export type BrowserAssistantKind = typeof BrowserAssistantKind.Type;

/** The profile carries the account: it holds that account's ChatGPT or Claude sign-in. */
export const BrowserAssistant = Schema.Struct({
  kind: BrowserAssistantKind,
  profileId: BrowserProfileId,
});
export type BrowserAssistant = typeof BrowserAssistant.Type;

export const browserAssistantKey = (assistant: BrowserAssistant) =>
  `${assistant.kind}:${assistant.profileId}`;

export interface ResolvedBrowserAssistant extends BrowserAssistant {
  readonly profile: BrowserProfile;
}

/** Drops duplicates and assistants whose profile is gone or incognito, which keeps no sign-in. */
export function resolveBrowserAssistants(
  assistants: ReadonlyArray<BrowserAssistant>,
  profiles: ReadonlyArray<BrowserProfile>,
): ReadonlyArray<ResolvedBrowserAssistant> {
  const seen = new Set<string>();
  const resolved: Array<ResolvedBrowserAssistant> = [];
  for (const assistant of assistants) {
    const profile = findBrowserProfile(profiles, assistant.profileId);
    const key = browserAssistantKey(assistant);
    if (!profile || profile.kind === "incognito" || seen.has(key)) continue;
    seen.add(key);
    resolved.push({ ...assistant, profile });
  }
  return resolved;
}
