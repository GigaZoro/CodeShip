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
 * profile reaches the other machines as a shared setting; must know the setting, since an older one
 * drops it without saying so; and must stamp changes itself (`server.shareSettings`), since a device
 * seeds an empty profile, and only a server's stamp keeps two devices' seeds apart.
 */
export function deviceSettingsProfileAvailability(
  primary: {
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
    readonly serverConfig: {
      readonly environment: {
        readonly capabilities: {
          readonly deviceSettingsProfile?: boolean;
          readonly shareSettings?: boolean;
        };
      };
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
  const { capabilities } = config.environment;
  if (capabilities.deviceSettingsProfile !== true || capabilities.shareSettings !== true) {
    return { status: "unsupported" };
  }
  if (config.settings.followSharedSettings !== true) return { status: "not-following" };
  return { status: "ready", source: { profile: config.settings.deviceSettingsProfile ?? {} } };
}

/** The client settings the profile sync reads: the portable ones, the switch and the base. */
export type DeviceSettingsProfileLocal = Pick<
  ClientSettings,
  DeviceSettingsProfileKey | "followDeviceSettingsProfile" | "deviceSettingsProfileBase"
>;

export function selectDeviceSettingsProfileLocal(
  settings: ClientSettings,
): DeviceSettingsProfileLocal {
  return {
    ...(Object.fromEntries(DEVICE_SETTINGS_PROFILE_KEYS.map((key) => [key, settings[key]])) as Pick<
      ClientSettings,
      DeviceSettingsProfileKey
    >),
    followDeviceSettingsProfile: settings.followDeviceSettingsProfile,
    deviceSettingsProfileBase: settings.deviceSettingsProfileBase,
  };
}

export interface DeviceSettingsProfileSyncInput {
  readonly local: DeviceSettingsProfileLocal;
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
      /**
       * Saves the whole profile for all machines; `base` is kept once it is saved. A `seed` goes to
       * a server that holds no profile: it is saved only where no machine holds one yet.
       */
      readonly kind: "publish";
      readonly profile: DeviceSettingsProfile;
      readonly base: DeviceSettingsProfile;
      readonly seed: boolean;
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
 * Compares the device and the server's profile with the one this device last took or sent (its
 * base). Only the profile changed: take it. Only the device: send the profile with its changes on
 * top. Both: the profile wins. No base: take it. Empty: the server may not have pulled the group's
 * yet, so the device sends its own as a seed, which the server stamps older than any profile held.
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

  if (Object.keys(source.profile).length === 0) {
    return { kind: "publish", profile: own, base: own, seed: true };
  }
  if (base === null) return take([]);

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
    seed: false,
  };
}

/** One publish of a device's profile, from the switch's generation it was sent in. */
export interface DeviceSettingsProfilePublish {
  readonly generation: number;
  /** The profile the server held when it was sent. */
  readonly replaced: DeviceSettingsProfile;
}

/**
 * A device's publishes of its profile. One is in flight at a time. Once saved, the server still
 * reports the profile it replaced until the saved one reaches it, so planning against that would
 * undo the change just sent. Turning the switch off or on starts a new generation: a publish that
 * settles after that must not write its base over the fresh start.
 */
export function makeDeviceSettingsProfilePublishes() {
  let generation = 0;
  let inFlight: DeviceSettingsProfilePublish | null = null;
  let replaced: DeviceSettingsProfile | null = null;
  return {
    restart: () => {
      generation += 1;
      inFlight = null;
      replaced = null;
    },
    /** Whether to plan against `profile` now. */
    canPlan: (profile: DeviceSettingsProfile | null): boolean => {
      if (inFlight !== null) return false;
      if (profile !== null && replaced !== null && Equal.equals(profile, replaced)) return false;
      replaced = null;
      return true;
    },
    begin: (profile: DeviceSettingsProfile): DeviceSettingsProfilePublish => {
      inFlight = { generation, replaced: profile };
      return inFlight;
    },
    /** Ends a publish; false when the switch was turned off or on since it was sent. */
    settle: (publish: DeviceSettingsProfilePublish, saved: boolean): boolean => {
      if (publish.generation !== generation) return false;
      inFlight = null;
      if (saved) replaced = publish.replaced;
      return true;
    },
  };
}
