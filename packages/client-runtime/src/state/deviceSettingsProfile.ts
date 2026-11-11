import {
  type ClientSettings,
  DEFAULT_DEVICE_SETTINGS_PROFILE,
  DEVICE_SETTINGS_PROFILE_KEYS,
  type DeviceSettingsProfile,
  type DeviceSettingsProfileKey,
  decodeDeviceSettingsProfileValue,
  deviceSettingsProfileOf,
  encodeDeviceSettingsProfileValue,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

/** Where a device reads and writes its profile: its primary server, once that server can hold it. */
export interface DeviceSettingsProfileSource {
  /** The profile the server holds, `{}` until a device publishes one. */
  readonly profile: DeviceSettingsProfile;
}

/** Why a device cannot use a profile now; the settings row says it, and nothing syncs meanwhile. */
export type DeviceSettingsProfileUnavailable =
  | "no-primary"
  | "offline"
  | "unsupported"
  | "not-following";

/**
 * The profile of a device's primary server. The server must follow shared settings, since the
 * profile reaches the other machines as a shared setting, and must know the setting: an older one
 * drops it without saying so.
 */
export function deviceSettingsProfileAvailability(
  primary: {
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly deviceSettingsProfile?: boolean } };
      readonly settings: {
        readonly followSharedSettings?: boolean | undefined;
        readonly deviceSettingsProfile?: DeviceSettingsProfile | undefined;
      };
    } | null;
  } | null,
):
  | { readonly status: "ready"; readonly source: DeviceSettingsProfileSource }
  | { readonly status: DeviceSettingsProfileUnavailable } {
  if (primary === null) return { status: "no-primary" };
  const config = primary.serverConfig;
  if (primary.connection.phase !== "connected" || config === null) return { status: "offline" };
  if (config.environment.capabilities.deviceSettingsProfile !== true) {
    return { status: "unsupported" };
  }
  if (config.settings.followSharedSettings !== true) return { status: "not-following" };
  return { status: "ready", source: { profile: config.settings.deviceSettingsProfile ?? {} } };
}

export interface DeviceSettingsProfileSyncInput {
  readonly local: ClientSettings;
  /** Null while the primary server is offline, does not follow shared settings, or cannot hold a profile. */
  readonly source: DeviceSettingsProfileSource | null;
}

/** What this device does about its profile now. */
export type DeviceSettingsProfileSyncPlan =
  | { readonly kind: "idle" }
  | {
      /** Takes the profile's values over its own. `conflict` is set when it drops a local change. */
      readonly kind: "apply";
      readonly values: Partial<Pick<ClientSettings, DeviceSettingsProfileKey>>;
      readonly base: DeviceSettingsProfile;
      readonly conflict: boolean;
    }
  | {
      /** Saves the whole profile for all machines; `base` is kept once it is saved. */
      readonly kind: "publish";
      readonly profile: DeviceSettingsProfile;
      readonly base: DeviceSettingsProfile;
    };

const IDLE: DeviceSettingsProfileSyncPlan = { kind: "idle" };

/** The profile's values this build can read, as this build writes them back. */
function readableProfileValues(profile: DeviceSettingsProfile): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
    const decoded = decodeDeviceSettingsProfileValue(key, profile);
    if (Option.isSome(decoded)) {
      values[key] = encodeDeviceSettingsProfileValue(key, decoded.value);
    }
  }
  return values;
}

/**
 * Compares the device and the server's profile with the profile this device last took or sent (its
 * base). Only the profile changed: take it. Only the device: send the whole profile with its changes
 * on top, keeping keys a newer build wrote. Both: the profile wins. No base: seed or take the profile.
 */
export function planDeviceSettingsProfileSync(
  input: DeviceSettingsProfileSyncInput,
): DeviceSettingsProfileSyncPlan {
  const { local, source } = input;
  if (!local.followDeviceSettingsProfile || source === null) return IDLE;
  const own = deviceSettingsProfileOf(local);
  const theirs = readableProfileValues(source.profile);
  const base = local.deviceSettingsProfileBase;

  /** Takes the profile; `changedHere` are the keys the device changed since its base. */
  const take = (
    changedHere: ReadonlyArray<DeviceSettingsProfileKey>,
  ): DeviceSettingsProfileSyncPlan => {
    const values: Record<string, unknown> = {};
    for (const key of DEVICE_SETTINGS_PROFILE_KEYS) {
      if (Object.hasOwn(theirs, key) && !Equal.equals(theirs[key], own[key])) {
        const decoded = decodeDeviceSettingsProfileValue(key, source.profile);
        if (Option.isSome(decoded)) values[key] = decoded.value;
      }
    }
    return {
      kind: "apply",
      values: values as Partial<Pick<ClientSettings, DeviceSettingsProfileKey>>,
      base: { ...own, ...theirs },
      conflict: changedHere.some((key) => Object.hasOwn(values, key)),
    };
  };

  if (base === null) {
    return Object.keys(source.profile).length === 0
      ? { kind: "publish", profile: own, base: own }
      : take([]);
  }

  // A key the base lacks was added by a newer build of this app: it counts as unchanged from its default.
  const baseValue = (key: DeviceSettingsProfileKey) =>
    Object.hasOwn(base, key) ? base[key] : DEFAULT_DEVICE_SETTINGS_PROFILE[key];
  const changedHere = DEVICE_SETTINGS_PROFILE_KEYS.filter(
    (key) => !Equal.equals(own[key], baseValue(key)),
  );
  const profileChanged = DEVICE_SETTINGS_PROFILE_KEYS.some(
    (key) => Object.hasOwn(theirs, key) && !Equal.equals(theirs[key], baseValue(key)),
  );
  if (profileChanged) return take(changedHere);
  if (changedHere.length === 0) return IDLE;
  return {
    kind: "publish",
    profile: {
      ...source.profile,
      ...Object.fromEntries(changedHere.map((key) => [key, own[key]])),
    },
    base: own,
  };
}
