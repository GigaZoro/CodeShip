import {
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  isMachineSharedSettingKey,
  isSharedQuotaAwareSelection,
  type MachineSharedSettingKey,
  type ProjectId,
  type ServerSettings,
  type ServerSettingsPatch,
  type ServerShareSettingsResult,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingStamp,
  type SharedSettingsWriteShare,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Struct from "effect/Struct";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleScheduledThreads",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "retryThreadsAfterNetworkErrors",
  "snoozeLimitedThreads",
  "snoozePresets",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
  "textGenerationModelSelection",
  "deviceSettingsProfile",
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
    patch.textGenerationModelSelection.quotaAwareAuto !== true &&
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

function withoutQuotaAwareSelections<T extends Readonly<Record<string, unknown>>>(
  requested: T,
  previous?: Readonly<Record<string, unknown>>,
): T {
  const protectedKeys = Object.entries(requested).filter(([key, value]) =>
    isSharedQuotaAwareSelection(key, value),
  );
  if (protectedKeys.length === 0) return requested;
  const safe: Record<string, unknown> = { ...requested };
  for (const [key] of protectedKeys) {
    if (previous && Object.hasOwn(previous, key)) safe[key] = previous[key];
    else delete safe[key];
  }
  return safe as T;
}

const setsQuotaAwareSelection = (patch: ServerSettingsPatch) =>
  sharedSettingKeysIn(patch).some((key) => isSharedQuotaAwareSelection(key, patch[key]));

/** A machine as a client knows it: connected now or not, with the settings it last reported. */
export interface SharedSettingsMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: { readonly capabilities: Partial<ExecutionEnvironmentCapabilities> };
  } | null;
}

/** Whether a machine saves a change for all machines first and stamps it (`server.shareSettings`). */
function servesShareSettings(machine: SharedSettingsMachine): boolean {
  return machine.serverConfig?.environment?.capabilities.shareSettings === true;
}

const supportsQuotaAwareAuto = (config: SharedSettingsMachine["serverConfig"] | undefined) =>
  config?.environment?.capabilities.quotaAwareAuto === true;

/**
 * Each shared setting `patch` sets, as the whole value `base` holds once the patch is applied, for
 * a change this client stamps itself: every follower takes one value rather than merging a part.
 */
function wholeSharedSettingValues(
  base: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const applied = applyServerSettingsPatch(base, patch);
  return Object.fromEntries(
    sharedSettingKeysIn(patch).map((key) => [key, sharedSettingValue(applied, key)]),
  ) as ServerSettingsPatch;
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
  readonly quotaAwareAutoUnavailable?: true;
}

export interface SharedSettingsGroupMember {
  readonly environmentId: EnvironmentId;
  readonly previous: ServerSettings;
  /** It takes a server's stamped share; an older one takes the stamp, with the values in its patch. */
  readonly servesShareSettings: boolean;
  readonly quotaAwareAuto?: true;
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
   * its clock, and the shared settings it sets. With `stampedBy: "client"`, no connected follower
   * serves `server.shareSettings`, so this client stamps the change by its own clock and every
   * follower's write carries the whole values; the authority is only the stamp's origin.
   */
  readonly share: {
    readonly authority: EnvironmentId;
    readonly keys: ReadonlyArray<MachineSharedSettingKey>;
    readonly stampedBy: "server" | "client";
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

export function settingsWriteForDestination<W extends MachineSettingsWrite>(
  write: W,
  config: SharedSettingsMachine["serverConfig"] | undefined,
): W {
  if (supportsQuotaAwareAuto(config)) return write;
  const requested = write.patch;
  const singles = withoutQuotaAwareSelections(requested);
  const patch = { ...singles };
  let unavailable = singles !== requested;

  if (requested.finalReviewModelSelections?.some((pick) => pick.quotaAwareAuto === true)) {
    delete patch.finalReviewModelSelections;
    unavailable = true;
  }
  const roles = Object.entries(requested.delegatedTaskModelSelections ?? {});
  if (roles.some(([, pick]) => pick?.quotaAwareAuto === true)) {
    const manual = roles.filter(([, pick]) => pick?.quotaAwareAuto !== true);
    if (manual.length) patch.delegatedTaskModelSelections = Object.fromEntries(manual);
    else delete patch.delegatedTaskModelSelections;
    unavailable = true;
  }
  const overrides = { ...requested.projectSettingsOverrides };
  for (const [id, entry] of Object.entries(requested.projectSettingsOverrides ?? {})) {
    if (entry === null) continue;
    const projectId = id as ProjectId;
    // Project override entries replace the whole entry. Restore the previous selection or its absence.
    const safe = withoutQuotaAwareSelections(
      entry,
      config?.settings.projectSettingsOverrides[projectId],
    );
    if (safe === entry) continue;
    if (Object.entries(safe).some(([key, value]) => isSharedQuotaAwareSelection(key, value)))
      delete overrides[projectId];
    else overrides[projectId] = safe;
    patch.projectSettingsOverrides = overrides;
    unavailable = true;
  }
  return unavailable ? { ...write, patch, quotaAwareAutoUnavailable: true } : write;
}

/** A plan that saves nothing for the group: each write as it is. */
export function plainSettingsWrites<W extends MachineSettingsWrite>(
  writes: ReadonlyArray<W>,
  machines: ReadonlyArray<Pick<SharedSettingsMachine, "environmentId" | "serverConfig">>,
): SharedSettingsPlan<W> {
  return {
    writes: writes.map((write) =>
      settingsWriteForDestination(
        write,
        machines.find((machine) => machine.environmentId === write.environmentId)?.serverConfig,
      ),
    ),
    share: null,
    offlineFollowers: [],
    sharedGroup: [],
    noFollowerConnected: false,
  };
}

/**
 * Who gets what when a change is saved for all of `machines`: a plain edit unless it sets a shared
 * setting and some machine follows. Then only followers get it, saved first by `origin`, or another
 * connected follower, that serves `server.shareSettings`. While none does, this client stamps the
 * change and sends every follower the whole values.
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
  if (
    !input.writes.some((write) => patchSetsMachineSharedSetting(write.patch)) ||
    !hasSharedSettingsGroup(input.machines)
  ) {
    return plainSettingsWrites(input.writes, input.machines);
  }
  const followers = input.machines.filter(followsSharedSettings);
  const connectedFollowers = followers.filter(isConnected);
  const offlineFollowers = followers
    .filter((machine) => !isConnected(machine))
    .map(({ label }) => label);
  const stampers = connectedFollowers.filter(servesShareSettings);
  const candidates = stampers.length > 0 ? stampers : connectedFollowers;
  const preferred =
    candidates.find((machine) => machine.environmentId === input.origin) ?? candidates[0];
  if (preferred === undefined) {
    return {
      ...plainSettingsWrites([], input.machines),
      offlineFollowers,
      noFollowerConnected: true,
    };
  }
  const stampedBy = stampers.length > 0 ? "server" : "client";
  const preferredPatch = onlySharedSettings(input.sharedPatch(preferred.serverConfig.settings));
  const sharesAuto = setsQuotaAwareSelection(preferredPatch);
  const authority =
    sharesAuto && !supportsQuotaAwareAuto(preferred.serverConfig)
      ? (stampers.find((machine) => supportsQuotaAwareAuto(machine.serverConfig)) ?? preferred)
      : preferred;
  const requestedPatch =
    authority === preferred
      ? preferredPatch
      : onlySharedSettings(input.sharedPatch(authority.serverConfig.settings));
  const missingAuthority =
    sharesAuto &&
    !(supportsQuotaAwareAuto(authority.serverConfig) && servesShareSettings(authority));
  const sharedPatch = missingAuthority
    ? withoutQuotaAwareSelections(requestedPatch)
    : requestedPatch;
  const keys = sharedSettingKeysIn(sharedPatch);
  // Stamped here, every follower carries the whole values, which a server would complete itself.
  const followerShared =
    stampedBy === "client"
      ? wholeSharedSettingValues(authority.serverConfig.settings, sharedPatch)
      : {};
  const isFollower = new Set(connectedFollowers.map(({ environmentId }) => environmentId));
  const writeOf = (machine: (typeof connectedFollowers)[number]) =>
    input.writes.find((write) => write.environmentId === machine.environmentId) ??
    input.writeFor({
      environmentId: machine.environmentId,
      label: machine.label,
      previous: machine.serverConfig.settings,
      servesShareSettings: servesShareSettings(machine),
    });
  const authorityWrite = writeOf(authority);
  return {
    writes: [
      {
        ...authorityWrite,
        ...(missingAuthority ? { quotaAwareAutoUnavailable: true as const } : {}),
        patch: {
          ...withoutSharedSettings(authorityWrite.patch),
          ...(stampedBy === "client" ? followerShared : sharedPatch),
        },
      },
      ...connectedFollowers
        .filter((machine) => machine !== authority)
        .map((machine) => {
          const write = writeOf(machine);
          return { ...write, patch: { ...withoutSharedSettings(write.patch), ...followerShared } };
        }),
      ...input.writes.flatMap((write) => {
        if (isFollower.has(write.environmentId)) return [];
        const patch = withoutSharedSettings(write.patch);
        return Object.keys(patch).length === 0 ? [] : [{ ...write, patch }];
      }),
    ]
      .filter(
        (write) =>
          !missingAuthority ||
          keys.length > 0 ||
          write.environmentId === authority.environmentId ||
          Object.keys(write.patch).length > 0,
      )
      .map((write) =>
        settingsWriteForDestination(
          write,
          input.machines.find((machine) => machine.environmentId === write.environmentId)
            ?.serverConfig,
        ),
      ),
    share:
      missingAuthority && keys.length === 0
        ? null
        : {
            authority: authority.environmentId,
            keys,
            stampedBy,
          },
    offlineFollowers,
    sharedGroup: connectedFollowers.map((machine) => ({
      environmentId: machine.environmentId,
      ...(supportsQuotaAwareAuto(machine.serverConfig) ? { quotaAwareAuto: true as const } : {}),
      previous: machine.serverConfig.settings,
      servesShareSettings: servesShareSettings(machine),
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

class SharedSettingsUpdateRequiredError extends Error {
  constructor() {
    super(t("Update older servers to save this setting."));
    this.name = "SharedSettingsUpdateRequiredError";
  }
}

export interface SharedSettingsWriteOutcome<W extends MachineSettingsWrite> {
  readonly write: W;
  /** What the machine was asked to hold: its patch, and for a follower the stamped values. */
  readonly sent: ServerSettingsPatch;
  readonly result: SettingsWriteResult<ServerSettings>;
  /**
   * For the follower that saved the change first: the shared settings it kept its own value of,
   * because the version it already held was newer, so no machine took the change to them.
   */
  readonly superseded?: ReadonlyArray<MachineSharedSettingKey>;
}

/** How a client sends a settings write, and a change saved for all machines, to one machine. */
export interface SharedSettingsPersist {
  readonly update: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly patch: ServerSettingsPatch;
      readonly share?: SharedSettingsWriteShare;
    };
  }) => Promise<SettingsWriteResult<ServerSettings>>;
  readonly share: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly patch: ServerSettingsPatch; readonly seed?: boolean };
  }) => Promise<SettingsWriteResult<ServerShareSettingsResult>>;
}

/**
 * Sends each write of `plan`, one outcome per write in order. A server's share is saved by the
 * authority first; the others take its stamp and values, an older follower with the values in its
 * patch. Machines outside the group are written meanwhile. A change this client stamps goes to
 * every follower at once, except a seed, which only a server stamps: no follower gets it.
 */
export async function persistSharedSettingsWrites<W extends MachineSettingsWrite>(
  plan: Pick<SharedSettingsPlan<W>, "writes" | "share" | "sharedGroup">,
  persist: SharedSettingsPersist,
  options: {
    readonly now?: () => DateTime.Utc;
    /** Stamped older than any version by the server that saves it first, so any version held wins. */
    readonly seed?: boolean;
  } = {},
): Promise<ReadonlyArray<SharedSettingsWriteOutcome<W>>> {
  const seed = options.seed === true;
  // A request that throws fails its own machine, never the others.
  const settle = <A>(request: Promise<SettingsWriteResult<A>>) =>
    request.catch((error: unknown): SettingsWriteResult<A> => ({
      _tag: "Failure",
      cause: Cause.die(error),
    }));
  const incomplete = new Set(
    plan.writes
      .filter((write) => write.quotaAwareAutoUnavailable)
      .map((write) => write.environmentId),
  );
  const requiresUpdate = (): SettingsWriteResult<ServerSettings> => ({
    _tag: "Failure",
    cause: Cause.fail(new SharedSettingsUpdateRequiredError()),
  });
  const update: typeof persist.update = async (request) => {
    if (!incomplete.has(request.environmentId)) return settle(persist.update(request));
    if (Object.keys(request.input.patch).length === 0) return requiresUpdate();
    const result = await settle(persist.update(request));
    return result._tag === "Failure" ? result : requiresUpdate();
  };
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
  const followers = new Set(plan.sharedGroup.map(({ environmentId }) => environmentId));
  if (share.stampedBy === "client") {
    const stamp: SharedSettingStamp = {
      updatedAt: DateTime.formatIso((options.now ?? DateTime.nowUnsafe)()),
      origin: share.authority,
    };
    return Promise.all(
      plan.writes.map(async (write) => {
        const follower = followers.has(write.environmentId);
        return {
          write,
          sent: write.patch,
          result:
            seed && follower
              ? { _tag: "Failure", cause: Cause.fail(new SharedSettingsUpdateRequiredError()) }
              : await update({
                  environmentId: write.environmentId,
                  input: follower ? { patch: write.patch, share: stamp } : { patch: write.patch },
                }),
        };
      }),
    );
  }
  const takesServerShare = new Set(
    plan.sharedGroup.flatMap(({ environmentId, servesShareSettings }) =>
      servesShareSettings ? [environmentId] : [],
    ),
  );
  const authorityWrite = plan.writes.find((write) => write.environmentId === share.authority);
  const saved = authorityWrite
    ? settle(
        persist.share({
          environmentId: authorityWrite.environmentId,
          input: { patch: authorityWrite.patch, ...(seed ? { seed } : {}) },
        }),
      )
    : undefined;
  return Promise.all(
    plan.writes.map(async (write): Promise<SharedSettingsWriteOutcome<W>> => {
      if (write === authorityWrite && saved !== undefined) {
        const result = await saved;
        if (result._tag !== "Success") return { write, sent: write.patch, result };
        const taken = new Set(result.value.share.values.map(({ key }) => key));
        const superseded = sharedSettingKeysIn(write.patch).filter((key) => !taken.has(key));
        return {
          write,
          sent: write.patch,
          result: write.quotaAwareAutoUnavailable
            ? requiresUpdate()
            : { _tag: "Success", value: result.value.settings },
          ...(superseded.length === 0 ? {} : { superseded }),
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
      // The values as the authority stored them, for keys this client knows.
      const stampedPatch = {
        ...write.patch,
        ...Object.fromEntries(
          stamped.share.values.flatMap((value) =>
            isMachineSharedSettingKey(value.key)
              ? [[value.key, sharedSettingValue(stamped.settings, value.key)]]
              : [],
          ),
        ),
      } as ServerSettingsPatch;
      const takesShare = takesServerShare.has(write.environmentId);
      // A stamp-only server can pick up the protected version later by pulling from a follower.
      const takesAuto =
        takesShare &&
        plan.sharedGroup.some(
          (member) => member.environmentId === write.environmentId && member.quotaAwareAuto,
        );
      const sent = takesAuto ? stampedPatch : withoutQuotaAwareSelections(stampedPatch);
      return {
        write,
        sent,
        result: await update({
          environmentId: write.environmentId,
          input: takesShare
            ? { patch: write.patch, share: stamped.share }
            : { patch: sent, share: stamped.share.stamp },
        }),
      };
    }),
  );
}

/**
 * How a settings write ended for the one who sent it: saved by every machine it went to; kept off
 * because the machine that saves first already held a newer version of a shared setting it set,
 * with that machine's settings; or not saved somewhere, including a write that was interrupted and
 * a machine that refused it.
 */
export type SharedSettingsWriteSettlement =
  | { readonly _tag: "saved" }
  | {
      readonly _tag: "superseded";
      readonly keys: ReadonlyArray<MachineSharedSettingKey>;
      readonly settings: ServerSettings;
    }
  | { readonly _tag: "notSaved" };

export function settleSharedSettingsWrite(
  outcomes: ReadonlyArray<SharedSettingsWriteOutcome<MachineSettingsWrite>>,
  refused: number,
): SharedSettingsWriteSettlement {
  if (refused > 0 || outcomes.some(({ result }) => result._tag !== "Success")) {
    return { _tag: "notSaved" };
  }
  for (const { result, superseded } of outcomes) {
    if (superseded !== undefined && result._tag === "Success") {
      return { _tag: "superseded", keys: superseded, settings: result.value };
    }
  }
  return { _tag: "saved" };
}
