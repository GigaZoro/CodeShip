import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
} from "./providerInstance.ts";
import {
  globalIdleCompaction,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsPatch,
} from "./settings.ts";

/**
 * Settings kept the same on every machine. Out: one machine's paths, devices, secrets and project
 * maps, `linkedEnvironmentsEnabled`, `guestSharingEnabled` and `defaultProjectScripts`. Each
 * provider instance has its own key (`sharedProviderInstanceKey`); the device profile is one whole.
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
  "installUpdatesAutomatically",
  "continueThreadsAfterServerUpdate",
  "backgroundActivity",
  "providerInstanceFailoverOrder",
  "deviceSettingsProfile",
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
 * When a change saved for all machines was made, by the clock of the server that saved it first.
 * `origin` is that server, which breaks a tie between two changes made in the same millisecond.
 */
export const SharedSettingStamp = Schema.Struct({
  updatedAt: SharedSettingTimestamp,
  origin: EnvironmentId,
});
export type SharedSettingStamp = typeof SharedSettingStamp.Type;

/** Keys whose value names a provider instance, which another machine may lack or run differently. */
const SHARED_MODEL_SELECTION_KEYS: ReadonlySet<MachineSharedSettingKey> = new Set([
  "defaultModelSelection",
  "scheduledTaskModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
]);

/** The provider instance a shared model selection names, if `value` is one. */
export function sharedSelectionInstanceId(key: string, value: unknown): string | undefined {
  if (!SHARED_MODEL_SELECTION_KEYS.has(key as MachineSharedSettingKey)) return undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const instanceId = (value as { readonly instanceId?: unknown }).instanceId;
  return typeof instanceId === "string" ? instanceId : undefined;
}

/** The driver an instance runs on a machine; an unconfigured built-in instance is its own driver. */
export const providerInstanceDriver = (settings: ServerSettings, instanceId: string): string =>
  settings.providerInstances[instanceId as keyof ServerSettings["providerInstances"]]?.driver ??
  instanceId;

const SHARED_PROVIDER_INSTANCE_KEY_PREFIX = "providerInstance:";

export type SharedProviderInstanceKey = `${typeof SHARED_PROVIDER_INSTANCE_KEY_PREFIX}${string}`;

/** The shared key of one provider instance: each account is versioned on its own. */
export const sharedProviderInstanceKey = (
  instanceId: ProviderInstanceId,
): SharedProviderInstanceKey => `${SHARED_PROVIDER_INSTANCE_KEY_PREFIX}${instanceId}`;

const isProviderInstanceId = Schema.is(ProviderInstanceId);

/** The provider instance a shared key names, if it names one. */
export function sharedProviderInstanceIdOf(key: string): ProviderInstanceId | undefined {
  if (!key.startsWith(SHARED_PROVIDER_INSTANCE_KEY_PREFIX)) return undefined;
  const instanceId = key.slice(SHARED_PROVIDER_INSTANCE_KEY_PREFIX.length);
  return isProviderInstanceId(instanceId) ? instanceId : undefined;
}

/**
 * The config fields an account shares, per driver; a new field stays on its machine until listed.
 * Paths, binaries, homes, launch arguments, server addresses, credentials and their metadata never
 * are, nor is `environment`. A driver missing here, such as a registry agent, is not shared at all.
 */
export const SHARED_PROVIDER_CONFIG_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["customModels", "autoCompactWindow", "idleCompaction"],
  codex: ["setupMode", "customModels"],
  antigravity: ["authMethod", "gcpProject", "gcpLocation", "customModels"],
  cursor: ["customModels"],
  grok: ["customModels"],
  opencode: ["customModels"],
  pi: ["customModels"],
  fx: ["customModels"],
  muse: ["customModels"],
};

/** Only the fields of `config` that `driver` shares, from a config of unknown shape. */
export function sharedProviderConfig(driver: string, config: unknown): Record<string, unknown> {
  const fields = SHARED_PROVIDER_CONFIG_FIELDS[driver] ?? [];
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  return Object.fromEntries(
    fields.flatMap((field) =>
      Object.hasOwn(config, field) && (config as Record<string, unknown>)[field] !== undefined
        ? [[field, (config as Record<string, unknown>)[field]]]
        : [],
    ),
  );
}

/** An account as every machine that follows shared settings holds it. */
export const SharedProviderInstanceDefinition = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  accentColor: Schema.optionalKey(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type SharedProviderInstanceDefinition = typeof SharedProviderInstanceDefinition.Type;

/** An account removed from the machines that follow; each keeps its own login and folders. */
export const SharedProviderInstanceRemoval = Schema.Struct({ removed: Schema.Literal(true) });

export const SharedProviderInstanceValue = Schema.Union([
  SharedProviderInstanceRemoval,
  SharedProviderInstanceDefinition,
]);
export type SharedProviderInstanceValue = typeof SharedProviderInstanceValue.Type;

/** A built-in instance is named after its driver; only its name and whether it is on are shared. */
export const isBuiltInProviderInstance = (instanceId: string, driver: string) =>
  instanceId === driver;

/**
 * What a machine shares of one provider instance, or nothing for a driver that is not shared. A
 * missing built-in instance still runs with its defaults; a missing added account is a removal.
 */
export function sharedProviderInstanceValue(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig | undefined,
): SharedProviderInstanceValue | undefined {
  if (instance === undefined) {
    if (!Object.hasOwn(SHARED_PROVIDER_CONFIG_FIELDS, instanceId)) return { removed: true };
    const driver = ProviderDriverKind.make(instanceId);
    return { driver, enabled: resolveProviderInstanceEnabled({ driver }) };
  }
  if (!Object.hasOwn(SHARED_PROVIDER_CONFIG_FIELDS, instance.driver)) return undefined;
  const named = instance.displayName === undefined ? {} : { displayName: instance.displayName };
  const enabled = resolveProviderInstanceEnabled(instance);
  if (isBuiltInProviderInstance(instanceId, instance.driver)) {
    return { driver: instance.driver, ...named, enabled };
  }
  const config = sharedProviderConfig(instance.driver, instance.config);
  return {
    driver: instance.driver,
    ...named,
    ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
    enabled,
    ...(Object.keys(config).length === 0 ? {} : { config }),
  };
}

/**
 * The most one shared value may take as JSON. A larger one is refused where it is served, pulled or
 * shared, so one bad value cannot crowd out the rest. Not a schema check, which would refuse the
 * whole answer with it.
 */
export const SHARED_SETTING_VALUE_MAX_BYTES = 64 * 1024;

/** The most a machine serves of its shared settings in one `t3_shared_settings` answer, or takes. */
export const SHARED_SETTINGS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * One shared setting's whole value, loose on the wire: a newer machine may share a key, field or
 * value this build does not know. The JSON is stored and passed on as sent, and decoded only to
 * apply it; a version this build cannot read waits, and applies once an update here can read it.
 * For a model selection, `instanceDriver` is its instance's driver where it was saved.
 */
export const SharedSettingValue = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(128)),
  value: Schema.Unknown,
  instanceDriver: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type SharedSettingValue = typeof SharedSettingValue.Type;

/** A shared setting as a machine knows it and passes it on. */
export const SharedSettingVersion = Schema.Struct({
  ...SharedSettingValue.fields,
  updatedAt: SharedSettingTimestamp,
  origin: EnvironmentId,
});
export type SharedSettingVersion = typeof SharedSettingVersion.Type;

/**
 * A change saved for all machines, as sent to each machine that follows shared settings after the
 * first one saved and stamped it: one stamp, and the whole value of each shared setting it set.
 * Every machine records the same version with the same value.
 */
export const SharedSettingsShare = Schema.Struct({
  stamp: SharedSettingStamp,
  values: Schema.Array(SharedSettingValue).check(Schema.isMaxLength(256)),
});
export type SharedSettingsShare = typeof SharedSettingsShare.Type;

/**
 * What a settings write carries when it is saved for all machines: a change a server saved first and
 * stamped (`server.shareSettings`), or a stamp the client made by its own clock, with the whole
 * values in the write's patch. Clients from before `server.shareSettings`, and clients writing to
 * machines without it, send the second; a server allows it much less time ahead of its clock.
 */
export const SharedSettingsWriteShare = Schema.Union([SharedSettingsShare, SharedSettingStamp]);
export type SharedSettingsWriteShare = typeof SharedSettingsWriteShare.Type;

/** Whether `candidate` replaces `known`: newest first, then the larger origin id. */
export const isNewerSharedSetting = (
  candidate: SharedSettingStamp,
  known: SharedSettingStamp | undefined,
): boolean =>
  known === undefined ||
  candidate.updatedAt > known.updatedAt ||
  (candidate.updatedAt === known.updatedAt && candidate.origin > known.origin);
