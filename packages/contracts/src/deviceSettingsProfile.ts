import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type ClientSettings,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type DeviceSettingsProfile,
} from "./settings.ts";

/**
 * The client settings a user's devices keep the same: looks, layout, confirmations and writing
 * habits. A new client setting stays on its device until listed. Never listed: window bounds,
 * browser settings, onboarding stamps, model preferences, per-project overrides, SnapShot and
 * anything one device decides for itself.
 */
export const DEVICE_SETTINGS_PROFILE_KEYS = [
  "fontFamilyCode",
  "fontFamilyComposer",
  "fontFamilySans",
  "fontFamilyTerminal",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
  "fontSmoothing",
  "wordWrap",
  "sidebarGroupByProject",
  "sidebarGroupByMachine",
  "sidebarProjectGroupingMode",
  "sidebarThreadSortOrder",
  "sidebarWorkingShelfEnabled",
  "sidebarManualStepsEnabled",
  "confirmQuit",
  "confirmThreadArchive",
  "confirmThreadDelete",
  "confirmThreadUnpin",
  "diffLayout",
  "diffColorScheme",
  "diffIgnoreWhitespace",
  "diffFilesCollapsed",
  "chatWidth",
  "effortDisplay",
  "glassOpacity",
  "appearanceContrast",
  "panelAnimationDurationMs",
  "timestampFormat",
  "language",
  "composerRichTextEnabled",
  "sendShortcut",
  "followUpBehavior",
  "showSkillsInSlashMenu",
  "mathRenderingEnabled",
  "notificationMode",
  "inAppNotificationsEnabled",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

export type DeviceSettingsProfileKey = (typeof DEVICE_SETTINGS_PROFILE_KEYS)[number];

const DEVICE_SETTINGS_PROFILE_KEY_SET: ReadonlySet<string> = new Set(DEVICE_SETTINGS_PROFILE_KEYS);

export const isDeviceSettingsProfileKey = (key: string): key is DeviceSettingsProfileKey =>
  DEVICE_SETTINGS_PROFILE_KEY_SET.has(key);

/** One key's own codec, built on first use and kept. */
const codecs = new Map<DeviceSettingsProfileKey, Schema.Codec<Record<string, unknown>>>();
const codecOf = (key: DeviceSettingsProfileKey) => {
  let codec = codecs.get(key);
  if (codec === undefined) {
    codec = Schema.Struct({ [key]: ClientSettingsSchema.fields[key] }) as unknown as Schema.Codec<
      Record<string, unknown>
    >;
    codecs.set(key, codec);
  }
  return codec;
};

/**
 * What this build makes of a profile's value for `key`: the setting, or nothing when the value is
 * missing or is one this build does not know, such as a choice a newer client added.
 */
export function decodeDeviceSettingsProfileValue(
  key: DeviceSettingsProfileKey,
  profile: DeviceSettingsProfile,
): Option.Option<ClientSettings[DeviceSettingsProfileKey]> {
  if (!Object.hasOwn(profile, key) || profile[key] === undefined) return Option.none();
  return Option.map(
    Schema.decodeOption(codecOf(key))({ [key]: profile[key] }),
    (decoded) => decoded[key] as ClientSettings[DeviceSettingsProfileKey],
  );
}

/** A setting's value as it is written to a profile. */
export function encodeDeviceSettingsProfileValue(
  key: DeviceSettingsProfileKey,
  value: ClientSettings[DeviceSettingsProfileKey],
): unknown {
  return Schema.encodeUnknownSync(codecOf(key))({ [key]: value })[key];
}

/** Every portable setting of `settings`, as a profile holds them. */
export function deviceSettingsProfileOf(
  settings: Pick<ClientSettings, DeviceSettingsProfileKey>,
): DeviceSettingsProfile {
  return Object.fromEntries(
    DEVICE_SETTINGS_PROFILE_KEYS.map((key) => [
      key,
      encodeDeviceSettingsProfileValue(key, settings[key]),
    ]),
  );
}

/** The profile of a device that has changed nothing. */
export const DEFAULT_DEVICE_SETTINGS_PROFILE: DeviceSettingsProfile =
  deviceSettingsProfileOf(DEFAULT_CLIENT_SETTINGS);
