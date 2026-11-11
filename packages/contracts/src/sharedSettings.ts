import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime } from "./baseSchemas.ts";
import { globalIdleCompaction, type ServerSettings, type ServerSettingsPatch } from "./settings.ts";

/**
 * Settings kept the same on every machine. Out: one machine's paths, accounts, instances, devices,
 * secrets and project maps; `linkedEnvironmentsEnabled` (sharing could cut the channel);
 * `guestSharingEnabled`; and `defaultProjectScripts`, saved through its own call and shortcuts.
 */
export const MACHINE_SHARED_SETTING_KEYS = [
  "defaultModelSelection",
  "newThreadsUseLastModel",
  "scheduledTaskModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "finalReviewByDefault",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "responseStreamingMode",
  "idleCompaction",
  "snoozePresets",
  "snoozeLimitedThreads",
  "autoResumeLimitedThreads",
  "failoverLimitedThreads",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleKeepPullRequests",
  "sidebarAutoSettleOpensPullRequests",
  "scheduledTaskDefaultPlacement",
  "skillAvailability",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "agentTerminalAccess",
  "worktreeSubmodules",
  "newWorktreesStartFromOrigin",
  "defaultAutoPull",
  "worktreeCleanup",
  "branchNamingMode",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "pullRequestMergeMethod",
  "reviewGuidesEnabled",
  "reviewGuideInstructions",
  "importAgentConversations",
  "ghqCloneLayout",
  "enableProviderUpdateChecks",
  "autoUpdateProviders",
  "continueThreadsAfterServerUpdate",
  "backgroundActivity",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

export type MachineSharedSettingKey = (typeof MACHINE_SHARED_SETTING_KEYS)[number];

const MACHINE_SHARED_SETTING_KEY_SET: ReadonlySet<string> = new Set(MACHINE_SHARED_SETTING_KEYS);

export const isMachineSharedSettingKey = (key: string): key is MachineSharedSettingKey =>
  MACHINE_SHARED_SETTING_KEY_SET.has(key);

/** The shared settings a write changes; the legacy idle compaction flag sets the mode. */
export const sharedSettingKeysIn = (
  patch: ServerSettingsPatch,
): ReadonlyArray<MachineSharedSettingKey> =>
  MACHINE_SHARED_SETTING_KEYS.filter(
    (key) =>
      patch[key] !== undefined ||
      (key === "idleCompaction" && patch.compactIdleThreads !== undefined),
  );

/** What a machine holds for a shared setting; older settings files keep the idle mode elsewhere. */
export const sharedSettingValue = (settings: ServerSettings, key: MachineSharedSettingKey) =>
  key === "idleCompaction" ? globalIdleCompaction(settings) : settings[key];

/**
 * `Date.prototype.toISOString` output only, so that comparing two timestamps as text orders them in
 * time.
 */
export const SharedSettingTimestamp = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
export type SharedSettingTimestamp = typeof SharedSettingTimestamp.Type;

/**
 * Sent with a settings write saved for all machines, only to machines that follow shared settings.
 * Every one of them gets the same stamp and the complete value of each shared key, so they all
 * record one version with one value. `origin` is the machine the change is attributed to, which
 * breaks a tie between two changes made in the same millisecond.
 */
export const SharedSettingStamp = Schema.Struct({
  updatedAt: SharedSettingTimestamp,
  origin: EnvironmentId,
});
export type SharedSettingStamp = typeof SharedSettingStamp.Type;

/**
 * A shared setting as a machine knows it. `key` and `value` stay loose on the wire: a newer machine
 * may share a key this build does not know, and the receiver checks both before it applies either.
 */
export const SharedSettingVersion = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(128)),
  value: Schema.Unknown,
  updatedAt: SharedSettingTimestamp,
  origin: EnvironmentId,
});
export type SharedSettingVersion = typeof SharedSettingVersion.Type;

/** Whether `candidate` replaces `known`: newest first, then the larger origin id. */
export const isNewerSharedSetting = (
  candidate: SharedSettingStamp,
  known: SharedSettingStamp | undefined,
): boolean =>
  known === undefined ||
  candidate.updatedAt > known.updatedAt ||
  (candidate.updatedAt === known.updatedAt && candidate.origin > known.origin);
