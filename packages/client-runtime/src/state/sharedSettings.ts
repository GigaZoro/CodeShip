import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  type MachineSharedSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
  type ServerShareSettingsResult,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingsShare,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
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

/** Whether a write sets a setting that machines share, so it is saved for the group. */
function patchSetsMachineSharedSetting(patch: ServerSettingsPatch): boolean {
  return sharedSettingKeysIn(patch).length > 0;
}

/** `patch` without the settings machines share, for a machine they must not reach. */
function withoutSharedSettings(patch: ServerSettingsPatch): ServerSettingsPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => key !== "compactIdleThreads" && !isMachineSharedSettingKey(key),
    ),
  ) as ServerSettingsPatch;
}

function onlySharedSettings(patch: ServerSettingsPatch): ServerSettingsPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => key === "compactIdleThreads" || isMachineSharedSettingKey(key),
    ),
  ) as ServerSettingsPatch;
}

/** A machine as a client knows it: connected now or not, with the settings it last reported. */
export interface SharedSettingsMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

export function followsSharedSettings(machine: {
  readonly serverConfig: {
    readonly settings: { readonly followSharedSettings?: boolean | undefined };
  } | null;
}): boolean {
  return machine.serverConfig?.settings.followSharedSettings === true;
}

/**
 * Whether the user's machines have a shared-settings group: any machine known to follow shared
 * settings, connected now or not. While one exists, a change saved for all machines reaches only
 * its members; one that is offline catches up from the others.
 */
export function hasSharedSettingsGroup(machines: ReadonlyArray<SharedSettingsMachine>): boolean {
  return machines.some(followsSharedSettings);
}

/** One machine's part of a settings change. */
export interface MachineSettingsWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
}

export interface SharedSettingsGroupMember {
  readonly environmentId: EnvironmentId;
  readonly previous: ServerSettings;
}

export interface SharedSettingsPlan<W extends MachineSettingsWrite> {
  /**
   * Each machine's write. With `share`, the authority's carries the shared settings, the other
   * connected followers' carry the rest and take the authority's stamped values, and the shared
   * settings never reach machines outside the group.
   */
  readonly writes: ReadonlyArray<W>;
  /**
   * Set when the change is saved for the group: the follower that saves it first and stamps it by
   * its clock, and the shared settings it sets.
   */
  readonly share: {
    readonly authority: EnvironmentId;
    readonly keys: ReadonlyArray<MachineSharedSettingKey>;
  } | null;
  /** Followers that are offline now, so they take the change from the others when back. */
  readonly offlineFollowers: ReadonlyArray<string>;
  /** Every connected follower and what it held before. */
  readonly sharedGroup: ReadonlyArray<SharedSettingsGroupMember>;
  /** The change sets a shared setting, but no follower is connected to save it for the group. */
  readonly noFollowerConnected: boolean;
}

function isConnected(machine: SharedSettingsMachine): machine is SharedSettingsMachine & {
  readonly serverConfig: { readonly settings: ServerSettings };
} {
  return supportsSharedSettingsSync(machine);
}

/** A plan that saves nothing for the group: each write as it is. */
export function plainSettingsWrites<W extends MachineSettingsWrite>(
  writes: ReadonlyArray<W>,
): SharedSettingsPlan<W> {
  return { writes, share: null, offlineFollowers: [], sharedGroup: [], noFollowerConnected: false };
}

/**
 * Who gets what when a change is saved for all of `machines`: a plain edit unless it sets a shared
 * setting and some machine follows. Then only followers get the shared settings, saved first by
 * `origin` if it is a connected follower, else by another, whose stamp and values the rest take.
 */
export function planSharedSettingsWrites<W extends MachineSettingsWrite>(input: {
  /** Every machine the change is for, connected now or not. */
  readonly machines: ReadonlyArray<SharedSettingsMachine>;
  /** What each connected machine gets as a plain edit. */
  readonly writes: ReadonlyArray<W>;
  readonly origin: EnvironmentId | null;
  /** The shared settings to save, from what the authority holds; only shared keys are kept. */
  readonly sharedPatch: (authority: ServerSettings) => ServerSettingsPatch;
  /** A write for a follower the change has none for, so it can carry the shared settings. */
  readonly writeFor: (machine: SharedSettingsGroupMember & { readonly label: string }) => W;
}): SharedSettingsPlan<W> {
  const plain = plainSettingsWrites(input.writes);
  if (
    !input.writes.some((write) => patchSetsMachineSharedSetting(write.patch)) ||
    !hasSharedSettingsGroup(input.machines)
  ) {
    return plain;
  }
  const followers = input.machines.filter(followsSharedSettings);
  const connectedFollowers = followers.filter(isConnected);
  const offlineFollowers = followers
    .filter((machine) => !isConnected(machine))
    .map(({ label }) => label);
  const authority =
    connectedFollowers.find((machine) => machine.environmentId === input.origin) ??
    connectedFollowers[0];
  if (authority === undefined) {
    return { ...plain, writes: [], offlineFollowers, noFollowerConnected: true };
  }
  const sharedPatch = onlySharedSettings(input.sharedPatch(authority.serverConfig.settings));
  const isFollower = new Set(connectedFollowers.map(({ environmentId }) => environmentId));
  const writeOf = (machine: (typeof connectedFollowers)[number]) =>
    input.writes.find((write) => write.environmentId === machine.environmentId) ??
    input.writeFor({
      environmentId: machine.environmentId,
      label: machine.label,
      previous: machine.serverConfig.settings,
    });
  const authorityWrite = writeOf(authority);
  return {
    writes: [
      {
        ...authorityWrite,
        patch: { ...withoutSharedSettings(authorityWrite.patch), ...sharedPatch },
      },
      ...connectedFollowers
        .filter((machine) => machine !== authority)
        .map((machine) => {
          const write = writeOf(machine);
          return { ...write, patch: withoutSharedSettings(write.patch) };
        }),
      ...input.writes.flatMap((write) => {
        if (isFollower.has(write.environmentId)) return [];
        const patch = withoutSharedSettings(write.patch);
        return Object.keys(patch).length === 0 ? [] : [{ ...write, patch }];
      }),
    ],
    share: { authority: authority.environmentId, keys: sharedSettingKeysIn(sharedPatch) },
    offlineFollowers,
    sharedGroup: connectedFollowers.map((machine) => ({
      environmentId: machine.environmentId,
      previous: machine.serverConfig.settings,
    })),
    noFollowerConnected: false,
  };
}

export type SettingsWriteResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

/** A follower's write that was not sent, because the authority could not save the change first. */
class SharedSettingsNotSavedError extends Error {
  constructor(authority: string) {
    super(
      t("{machine} could not save this change first, so it was not sent here.", {
        machine: authority,
      }),
    );
    this.name = "SharedSettingsNotSavedError";
  }
}

export interface SharedSettingsWriteOutcome<W extends MachineSettingsWrite> {
  readonly write: W;
  /** What the machine was asked to hold: its patch, and for a follower the stamped values. */
  readonly sent: ServerSettingsPatch;
  readonly result: SettingsWriteResult<ServerSettings>;
}

/** How a client sends a settings write, and a change saved for all machines, to one machine. */
export interface SharedSettingsPersist {
  readonly update: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly patch: ServerSettingsPatch; readonly share?: SharedSettingsShare };
  }) => Promise<SettingsWriteResult<ServerSettings>>;
  readonly share: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly patch: ServerSettingsPatch };
  }) => Promise<SettingsWriteResult<ServerShareSettingsResult>>;
}

/**
 * Sends each write of `plan`, one outcome per write in order. With `share`, the authority saves its
 * write first and stamps it; the other followers then take its stamp and values, which carry any
 * part of a setting this client does not know. Machines outside the group are written meanwhile.
 */
export async function persistSharedSettingsWrites<W extends MachineSettingsWrite>(
  plan: Pick<SharedSettingsPlan<W>, "writes" | "share" | "sharedGroup">,
  persist: SharedSettingsPersist,
): Promise<ReadonlyArray<SharedSettingsWriteOutcome<W>>> {
  // A request that throws fails its own machine, never the others.
  const settle = <A>(request: Promise<SettingsWriteResult<A>>) =>
    request.catch((error: unknown): SettingsWriteResult<A> => ({
      _tag: "Failure",
      cause: Cause.die(error),
    }));
  const update: typeof persist.update = (request) => settle(persist.update(request));
  const share = plan.share;
  if (share === null) {
    return Promise.all(
      plan.writes.map(async (write) => ({
        write,
        sent: write.patch,
        result: await update({
          environmentId: write.environmentId,
          input: { patch: write.patch },
        }),
      })),
    );
  }
  const authorityWrite = plan.writes.find((write) => write.environmentId === share.authority);
  const followers = new Set(plan.sharedGroup.map(({ environmentId }) => environmentId));
  const saved = authorityWrite
    ? settle(
        persist.share({
          environmentId: authorityWrite.environmentId,
          input: { patch: authorityWrite.patch },
        }),
      )
    : undefined;
  return Promise.all(
    plan.writes.map(async (write): Promise<SharedSettingsWriteOutcome<W>> => {
      if (write === authorityWrite && saved !== undefined) {
        const result = await saved;
        return {
          write,
          sent: write.patch,
          result:
            result._tag === "Success" ? { _tag: "Success", value: result.value.settings } : result,
        };
      }
      if (!followers.has(write.environmentId)) {
        return {
          write,
          sent: write.patch,
          result: await update({
            environmentId: write.environmentId,
            input: { patch: write.patch },
          }),
        };
      }
      const authority = await saved;
      if (authority?._tag !== "Success") {
        return {
          write,
          sent: write.patch,
          result: {
            _tag: "Failure",
            cause: Cause.fail(
              new SharedSettingsNotSavedError(authorityWrite?.label ?? share.authority),
            ),
          },
        };
      }
      const stamped = authority.value;
      return {
        write,
        // The values as the authority stored them, for keys this client knows.
        sent: {
          ...write.patch,
          ...Object.fromEntries(
            stamped.share.values.flatMap((value) =>
              isMachineSharedSettingKey(value.key)
                ? [[value.key, sharedSettingValue(stamped.settings, value.key)]]
                : [],
            ),
          ),
        },
        result: await update({
          environmentId: write.environmentId,
          input: { patch: write.patch, share: stamped.share },
        }),
      };
    }),
  );
}
