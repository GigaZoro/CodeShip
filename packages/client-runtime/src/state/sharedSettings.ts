import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingStamp,
} from "@t3tools/contracts";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Struct from "effect/Struct";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "retryThreadsAfterNetworkErrors",
  "snoozeLimitedThreads",
  "snoozePresets",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
  "textGenerationModelSelection",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

const SHARED_KEY_SET = new Set<string>(SHARED_SERVER_SETTING_KEYS);

export function splitSharedServerPatch(patch: ServerSettingsPatch): {
  sharedPatch: ServerSettingsPatch;
  localPatch: ServerSettingsPatch;
} {
  const sharedPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SHARED_KEY_SET.has(key)) {
      sharedPatch[key] = value;
    } else {
      localPatch[key] = value;
    }
  }
  return {
    sharedPatch: sharedPatch as ServerSettingsPatch,
    localPatch: localPatch as ServerSettingsPatch,
  };
}

export function filterSharedServerPatch(
  patch: ServerSettingsPatch,
  settings?: ServerSettings,
  sourceSettings = settings,
  targetIsSource = false,
): ServerSettingsPatch {
  const instanceId =
    patch.textGenerationModelSelection?.instanceId ??
    sourceSettings?.textGenerationModelSelection.instanceId;
  if (
    !targetIsSource &&
    patch.textGenerationModelSelection &&
    (!settings ||
      (instanceId !== undefined &&
        (sourceSettings?.providerInstances[instanceId]?.driver ?? instanceId) !==
          (settings.providerInstances[instanceId]?.driver ?? instanceId)) ||
      !isModelSelectionProviderEnabled(settings, {
        ...settings.textGenerationModelSelection,
        ...patch.textGenerationModelSelection,
      }))
  ) {
    patch = Struct.omit(patch, ["textGenerationModelSelection"]);
  }
  return settings ? patch : Struct.omit(patch, ["continueThreadsAfterServerUpdate"]);
}

export function supportsSharedSettingsSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/**
 * The stamp for a write saved for all machines, sent to each machine so they all record one
 * version. `origin` is the machine the change is attributed to.
 */
export function sharedSettingStamp(
  origin: EnvironmentId,
  now: DateTime.Utc = DateTime.nowUnsafe(),
): SharedSettingStamp {
  return { updatedAt: DateTime.formatIso(now), origin };
}

/** Whether a write sets a setting that machines share, so it is worth stamping. */
export function patchSetsMachineSharedSetting(patch: ServerSettingsPatch): boolean {
  return sharedSettingKeysIn(patch).length > 0;
}

/**
 * Each shared setting `patch` sets, as the whole value `base` stores once the patch is applied. A
 * write saved for all machines carries these, computed once from the machine being edited, so every
 * machine that takes it records one value rather than merging a part into what it had.
 */
export function wholeSharedSettingValues(
  base: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const keys = sharedSettingKeysIn(patch);
  if (keys.length === 0) return {};
  const applied = applyServerSettingsPatch(base, patch);
  return Object.fromEntries(
    keys.map((key) => [key, sharedSettingValue(applied, key)]),
  ) as ServerSettingsPatch;
}

/**
 * `patch` with each shared setting it sets replaced by its value in `whole`. One `whole` leaves
 * out is not part of the edited machine's change, so it is not sent under the shared stamp.
 */
export function withWholeSharedSettingValues(
  patch: ServerSettingsPatch,
  whole: ServerSettingsPatch,
): ServerSettingsPatch {
  const keys = sharedSettingKeysIn(patch);
  if (keys.length === 0) return patch;
  const own = Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => key !== "compactIdleThreads" && !isMachineSharedSettingKey(key),
    ),
  );
  return {
    ...own,
    ...Object.fromEntries(
      keys.flatMap((key) => (whole[key] === undefined ? [] : [[key, whole[key]]])),
    ),
  } as ServerSettingsPatch;
}
