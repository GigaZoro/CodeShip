import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  isManagedSettingPath,
  isNewerSharedSetting,
  type MachineSharedSettingKey,
  MACHINE_SHARED_SETTING_KEYS,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  providerInstanceDriver,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsOperation,
  ServerSettingsPatch,
  SHARED_SETTING_SEED_UPDATED_AT,
  SHARED_SETTING_VALUE_MAX_BYTES,
  SHARED_SETTINGS_RESPONSE_MAX_BYTES,
  sharedProviderInstanceIdOf,
  sharedProviderInstanceKey,
  SharedProviderInstanceValue,
  sharedSelectionInstanceId,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingStamp,
  type SharedSettingsShare,
  type SharedSettingsWriteShare,
  type SharedSettingValue,
  type SharedSettingVersion,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import {
  type AccountSharingDrivers,
  accountSharingDrivers,
  canTakeSharedProviderInstance,
  changedSharedProviderInstances,
  withSharedProviderInstance,
} from "./sharedProviderInstances.ts";

/**
 * A version stamped further ahead than this came from a clock that runs fast. Taken as written it
 * would outrank every later change until real time caught up, so it waits until then instead.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * A stamp a client made by its own clock, as clients from before `server.shareSettings` do, gets far
 * less: a device's clock is the one that runs fast, and while it is ahead its change would outrank
 * the changes the group makes meanwhile.
 */
const MAX_CLIENT_STAMP_AHEAD_MS = 30 * 1000;

/**
 * Settings this build does not know are kept to pass on, up to this many, so a peer cannot fill the
 * store with made-up keys. A newer build shares a few more at most.
 */
const MAX_UNKNOWN_KEYS = 64;

/** Problems logged once each; past this many the record starts over, so it stays small. */
const MAX_LOGGED_ONCE = 1024;

/** Errors about versions name their store, since there is no settings file to point at. */
const VERSIONS_PATH = "shared setting versions";

export class SharedSettingsError extends Schema.TaggedError<SharedSettingsError>()(
  "SharedSettingsError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Shared settings ${this.operation} failed.`;
  }
}

/**
 * A shared value is the whole setting, never a part of one, so every machine that takes one version
 * ends up with one value. This machine's own values are stored in the form a settings write carries;
 * a value from another machine is stored as the JSON it came as, since this build may not know all of
 * it, and is decoded whole, with any part left out at its default, only to apply it here.
 */
const keyCodecs = (fields: Record<MachineSharedSettingKey, Schema.Top>) => {
  const codecs = new Map<MachineSharedSettingKey, Schema.Codec<Record<string, unknown>>>();
  return (key: MachineSharedSettingKey) => {
    let codec = codecs.get(key);
    if (codec === undefined) {
      codec = Schema.Struct({ [key]: fields[key] }) as unknown as Schema.Codec<
        Record<string, unknown>
      >;
      codecs.set(key, codec);
    }
    return codec;
  };
};
const patchCodec = keyCodecs(ServerSettingsPatch.fields);
const valueCodec = keyCodecs(ServerSettings.fields);

/** This machine's value of a setting, as JSON another machine can decode. */
const encodeValue = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.encodeUnknownEffect(patchCodec(key))({ [key]: value }).pipe(
    Effect.map((encoded) => encoded[key]),
    Effect.mapError((cause) => new SharedSettingsError({ operation: "encode", cause })),
  );

/** Fails when the value is not what the setting stores, or is missing. */
const decodeValue = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.decodeEffect(valueCodec(key))({ [key]: value }).pipe(
    Effect.mapError((cause) => new SharedSettingsError({ operation: "decode", cause })),
    Effect.flatMap((decoded) =>
      Object.hasOwn(decoded, key) && decoded[key] !== undefined
        ? Effect.succeed(decoded[key])
        : Effect.fail(
            new SharedSettingsError({
              operation: "decode",
              cause: new Error(`The value for ${key} is missing.`),
            }),
          ),
    ),
  );

/** An account's version, keeping only what this build reads of it; the rest is still passed on. */
const decodeInstanceValue = Schema.decodeUnknownOption(SharedProviderInstanceValue);

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownOption(UnknownJson);
const toJson = Schema.encodeSync(UnknownJson);

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** A setting this build keeps to one machine: never taken from another, nor passed on. */
const isMachineOnlySettingKey = (key: string) =>
  !isMachineSharedSettingKey(key) && Object.hasOwn(ServerSettings.fields, key);

/** A key this build knows: a setting machines share, or one provider instance, versioned on its own. */
const isSharedKey = (key: string) =>
  isMachineSharedSettingKey(key) || sharedProviderInstanceIdOf(key) !== undefined;

/**
 * Settings about the accounts themselves. Like an account, a machine that follows shares every
 * change to one, not only a change saved for all machines, so its accounts keep their order.
 */
const ACCOUNT_SHARED_SETTING_KEYS: ReadonlySet<MachineSharedSettingKey> = new Set([
  "providerInstanceFailoverOrder",
]);

/**
 * `shared` is the version this machine knows and passes on, `local` when it last changed the setting
 * on its own, and `deferred` a version from a fast clock that waits until its time. A `shared` row is
 * this machine's value unless it is `pending`, waiting to apply, or a change made here alone is newer.
 */
type VersionKind = "shared" | "local" | "deferred";

interface VersionRow {
  readonly settingKey: string;
  readonly kind: string;
  readonly valueJson: string | null;
  readonly instanceDriver: string | null;
  readonly updatedAt: string;
  readonly origin: string;
  readonly pending: number;
}

interface KeyVersions {
  readonly shared: VersionRow | undefined;
  readonly local: VersionRow | undefined;
  readonly deferred: VersionRow | undefined;
}

const versionsOf = (rows: ReadonlyArray<VersionRow>, key: string) => {
  const find = (kind: VersionKind) =>
    rows.find((row) => row.settingKey === key && row.kind === kind);
  return { shared: find("shared"), local: find("local"), deferred: find("deferred") };
};

const rowStamp = (row: VersionRow): SharedSettingStamp => ({
  updatedAt: row.updatedAt,
  origin: row.origin as EnvironmentId,
});

const stampOf = (row: VersionRow | undefined) => (row === undefined ? undefined : rowStamp(row));

const sameStamp = (row: VersionRow | undefined, stamp: SharedSettingStamp) =>
  row !== undefined && row.updatedAt === stamp.updatedAt && row.origin === stamp.origin;

/** A shared setting's value as this build reads it, or one account's. */
type Readable =
  | { readonly kind: "setting"; readonly key: MachineSharedSettingKey; readonly value: unknown }
  | {
      readonly kind: "instance";
      readonly instanceId: ProviderInstanceId;
      readonly value: SharedProviderInstanceValue;
    };

/**
 * A version from another machine: the JSON it was sent as, and its value as this build reads it, or
 * none for a key this build does not know or a value it cannot decode.
 */
interface Candidate {
  readonly key: string;
  readonly raw: unknown;
  readonly readable: Readable | undefined;
  readonly instanceDriver: string | undefined;
  readonly stamp: SharedSettingStamp;
}

/**
 * What a machine does with a version: nothing when it knows one as new; pass it on without applying
 * it when a change made here alone is newer, or an administrator locks the setting here; keep it
 * waiting while this build cannot read it, or it names a model this machine cannot use yet;
 * otherwise apply it.
 */
type Disposition = "known" | "relay" | "wait" | "apply";

/** Each provider instance this machine lists, with its driver and whether it is turned on. */
type Instances = ReadonlyMap<string, { readonly driver: string; readonly enabled: boolean }>;

/**
 * A model selection waits while the instance it names is missing here, runs another driver here than
 * where it was saved, or is turned off here, so applying it can never leave a model that cannot run.
 * An instance in the settings is judged by them, as they stand under the lock.
 */
function selectionWaits(
  { readable, instanceDriver }: Candidate & { readonly readable: Readable },
  current: ServerSettings,
  instances: Instances,
) {
  if (readable.kind !== "setting") return false;
  const instanceId = sharedSelectionInstanceId(readable.key, readable.value);
  if (instanceId === undefined) return false;
  const here = Object.hasOwn(current.providerInstances, instanceId)
    ? {
        driver: providerInstanceDriver(current, instanceId),
        enabled: isModelSelectionProviderEnabled(current, readable.value as ModelSelection),
      }
    : instances.get(instanceId);
  if (here === undefined || !here.enabled) return true;
  return instanceDriver !== undefined && instanceDriver !== here.driver;
}

/**
 * What taking `candidates` replaces whole: each setting's value, and the provider instances with
 * each account's version taken. An account version that changes nothing here replaces nothing.
 */
function replacements(
  sharing: AccountSharingDrivers,
  current: ServerSettings,
  candidates: ReadonlyArray<Candidate>,
): Partial<ServerSettings> {
  const replace: Record<string, unknown> = {};
  let instances = current.providerInstances;
  for (const { readable, stamp } of candidates) {
    if (readable?.kind === "setting") {
      replace[readable.key] = readable.value;
    } else if (readable?.kind === "instance") {
      instances = withSharedProviderInstance(
        sharing,
        instances,
        readable.instanceId,
        readable.value,
        stamp.origin,
      );
    }
  }
  if (instances !== current.providerInstances) replace.providerInstances = instances;
  return replace as Partial<ServerSettings>;
}

/** Keys this build does not know, which it keeps only to pass on. */
const unknownKeysIn = (rows: ReadonlyArray<VersionRow>) =>
  new Set(rows.flatMap((row) => (isSharedKey(row.settingKey) ? [] : [row.settingKey])));

/** Whether there is room to keep `candidate`: a known key, or one already kept, always has it. */
const hasRoomFor = (rows: ReadonlyArray<VersionRow>, candidate: Candidate) => {
  if (candidate.readable !== undefined || isSharedKey(candidate.key)) return true;
  const unknown = unknownKeysIn(rows);
  return unknown.has(candidate.key) || unknown.size < MAX_UNKNOWN_KEYS;
};

/** A key and, for the idle compaction mode, the legacy flag that also sets it. */
const keyFields = (key: MachineSharedSettingKey) =>
  key === "idleCompaction" ? [key, "compactIdleThreads"] : [key];

const SHARED_FIELDS: ReadonlyArray<string> = MACHINE_SHARED_SETTING_KEYS.flatMap(keyFields);

const withoutKeys = (patch: ServerSettingsPatch, keys: ReadonlyArray<string>) =>
  Object.fromEntries(
    Object.entries(patch).filter(([key]) => !keys.includes(key)),
  ) as ServerSettingsPatch;

const isEmptyPlan = (plan: Settings.SettingsWritePlan) =>
  Object.keys(plan.patch).length === 0 && Object.keys(plan.replace ?? {}).length === 0;

const refuse = (operation: ServerSettingsOperation, cause?: unknown) =>
  new ServerSettingsError({ settingsPath: VERSIONS_PATH, operation, cause });

/**
 * How a write is saved: for this machine alone, as a version another machine stamped, or as a change
 * saved for all machines that this machine stamps, by its clock or as a seed.
 */
type WriteShare = SharedSettingsShare | "fromThisMachine" | "seedFromThisMachine" | undefined;

const isFromThisMachine = (share: WriteShare): share is "fromThisMachine" | "seedFromThisMachine" =>
  share === "fromThisMachine" || share === "seedFromThisMachine";

interface WriteOutcome {
  readonly stamp: SharedSettingStamp | undefined;
  /** Versions from another machine that this write applies. */
  readonly applied: ReadonlyArray<Candidate>;
  /** Keys this machine shares from its own values, stamped by it. */
  readonly ownShared: ReadonlyArray<MachineSharedSettingKey>;
  /** Keys this machine changed on its own, recorded as its local change. */
  readonly local: ReadonlyArray<MachineSharedSettingKey>;
}

const NO_OUTCOME: WriteOutcome = { stamp: undefined, applied: [], ownShared: [], local: [] };

interface Planned {
  readonly plan: Settings.SettingsWritePlan;
  readonly outcome: WriteOutcome;
}

/** What a change saved for all machines here hands back: its stamp and the values it shared. */
interface ShareSink {
  stamp: SharedSettingStamp | undefined;
  values: ReadonlyArray<SharedSettingValue>;
}

/**
 * The versions of the settings this machine shares with the user's other machines, and the rules
 * for taking a newer one. Every check and change to a version happens under the settings write lock,
 * so a version never disagrees with the value a write left in settings.json.
 */
export class SharedSettings extends Context.Service<
  SharedSettings,
  {
    /** What this machine tells a linked machine; nothing unless this machine follows shared settings. */
    readonly servedVersions: Effect.Effect<
      ReadonlyArray<SharedSettingVersion>,
      SharedSettingsError
    >;
    /**
     * A settings write. Without `share`, this machine's own change, which an older shared version
     * cannot undo. With `share`, a change saved for all machines, refused unless this machine
     * follows and taken by the rules for a pulled version; a client's own stamp may run less ahead.
     * Either way, a machine that follows shares what the write changes about its accounts.
     */
    readonly update: (
      patch: ServerSettingsPatch,
      share: SharedSettingsWriteShare | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /** `update` for a write that also adds, changes or removes a provider instance. */
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch: ServerSettingsPatch,
      share: SharedSettingsWriteShare | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /**
     * A change saved for all machines, made here and stamped by its clock under the write lock.
     * Returns what to send the other followers; a key whose version here is newer keeps its value
     * and is not in it. A `seed` is stamped older than any version, so it is saved only for a key
     * no machine holds a version of yet.
     */
    readonly updateForAllMachines: (
      patch: ServerSettingsPatch,
      options?: { readonly seed?: boolean },
    ) => Effect.Effect<
      {
        readonly settings: ServerSettings;
        readonly share: SharedSettingsShare;
      },
      ServerSettingsError
    >;
    /** Takes what a peer knows that is newer than this machine's versions. */
    readonly applyPulled: (
      peer: EnvironmentId,
      versions: ReadonlyArray<SharedSettingVersion>,
    ) => Effect.Effect<void>;
    /**
     * Applies versions that waited for a model this machine could not use, or for this machine's
     * clock to reach the time they were stamped with.
     */
    readonly retryWaiting: Effect.Effect<void>;
  }
>()("t3/sharedSettings/SharedSettings") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sharing = yield* accountSharingDrivers(BUILT_IN_DRIVERS);

  const storeError = (operation: string) => (cause: unknown) =>
    new SharedSettingsError({ operation, cause });

  const readRows = sql<VersionRow>`
    SELECT
      setting_key AS "settingKey",
      kind,
      value_json AS "valueJson",
      instance_driver AS "instanceDriver",
      updated_at AS "updatedAt",
      origin,
      pending
    FROM shared_setting_versions
    ORDER BY setting_key, kind
  `.pipe(Effect.mapError(storeError("read")));

  /** For a write hook, which can only fail the way a settings write fails. */
  const readRowsForWrite = readRows.pipe(Effect.mapError((cause) => refuse("read-file", cause)));
  const readVersionsForWrite = (key: string) =>
    readRowsForWrite.pipe(Effect.map((rows) => versionsOf(rows, key)));

  // Each problem with a version is logged once, not on every pull that brings it again.
  const loggedOnce = yield* Ref.make<ReadonlySet<string>>(new Set());
  const logOnce = (
    problem: string,
    entry: { readonly key: string; readonly updatedAt: string; readonly origin: string },
    message: string,
    fields: Record<string, unknown> = {},
  ) =>
    Ref.modify(loggedOnce, (logged) => {
      const id = `${problem}\u0000${entry.key}\u0000${entry.updatedAt}\u0000${entry.origin}`;
      if (logged.has(id)) return [false, logged] as const;
      const next = new Set(logged.size >= MAX_LOGGED_ONCE ? [] : logged);
      next.add(id);
      return [true, next] as const;
    }).pipe(
      Effect.flatMap((first) =>
        first
          ? Effect.logWarning(message, {
              key: entry.key,
              updatedAt: entry.updatedAt,
              origin: entry.origin,
              ...fields,
            })
          : Effect.void,
      ),
    );

  /** Refuses a value too large to share, and says so once. */
  const fitsSize = (
    entry: SharedSettingValue & { readonly updatedAt: string; readonly origin: string },
    peer?: EnvironmentId,
  ) => {
    const bytes = jsonBytes(entry.value);
    return bytes <= SHARED_SETTING_VALUE_MAX_BYTES
      ? Effect.succeed(true)
      : logOnce(
          "too-large",
          entry,
          "A shared setting is too large to share between machines, so it was left out",
          {
            bytes,
            maxBytes: SHARED_SETTING_VALUE_MAX_BYTES,
            ...(peer === undefined ? {} : { peer }),
          },
        ).pipe(Effect.as(false));
  };

  const putRow = (
    key: string,
    kind: VersionKind,
    value: { readonly json: string; readonly instanceDriver: string | undefined } | null,
    stamp: SharedSettingStamp,
    pending = false,
  ) =>
    sql`
      INSERT INTO shared_setting_versions
        (setting_key, kind, value_json, instance_driver, updated_at, origin, pending)
      VALUES (
        ${key}, ${kind}, ${value?.json ?? null}, ${value?.instanceDriver ?? null},
        ${stamp.updatedAt}, ${stamp.origin}, ${pending ? 1 : 0}
      )
      ON CONFLICT (setting_key, kind) DO UPDATE SET
        value_json = excluded.value_json,
        instance_driver = excluded.instance_driver,
        updated_at = excluded.updated_at,
        origin = excluded.origin,
        pending = excluded.pending
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

  /** Stores a version from another machine as it came, to pass on; `pending` while it waits here. */
  const putCandidate = (candidate: Candidate, kind: "shared" | "deferred", pending = false) =>
    putRow(
      candidate.key,
      kind,
      { json: toJson(candidate.raw), instanceDriver: candidate.instanceDriver },
      candidate.stamp,
      pending,
    );

  /** Only the row with this stamp, so a newer one written meanwhile is left alone. */
  const deleteRow = (key: string, kind: VersionKind, stamp: SharedSettingStamp) =>
    sql`
      DELETE FROM shared_setting_versions
      WHERE setting_key = ${key} AND kind = ${kind}
        AND updated_at = ${stamp.updatedAt} AND origin = ${stamp.origin}
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

  const clearPending = (key: string, stamp: SharedSettingStamp) =>
    sql`
      UPDATE shared_setting_versions SET pending = 0
      WHERE setting_key = ${key} AND kind = 'shared'
        AND updated_at = ${stamp.updatedAt} AND origin = ${stamp.origin}
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

  const nowStamp = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      updatedAt: DateTime.formatIso(now),
      origin: yield* environment.getEnvironmentId,
    } satisfies SharedSettingStamp;
  });

  /**
   * A stamp for this machine's own version of `key`, newer than any it knows of the key: now, or
   * just after a version stamped by a clock running a little ahead, so this change is not undone.
   */
  const ownStamp = (rows: ReadonlyArray<VersionRow>, key: string, now: SharedSettingStamp) => {
    const versions = versionsOf(rows, key);
    const known = [versions.shared, versions.local].flatMap((row) =>
      row === undefined ? [] : [rowStamp(row)],
    );
    const newest = known.reduce<SharedSettingStamp | undefined>(
      (newer, stamp) => (isNewerSharedSetting(stamp, newer) ? stamp : newer),
      undefined,
    );
    if (newest === undefined || isNewerSharedSetting(now, newest)) return now;
    return {
      updatedAt: DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(newest.updatedAt), { milliseconds: 1 }),
      ),
      origin: now.origin,
    } satisfies SharedSettingStamp;
  };

  const isAhead = (stamp: SharedSettingStamp, allowedMs = MAX_CLOCK_SKEW_MS) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          stamp.updatedAt > DateTime.formatIso(DateTime.add(now, { milliseconds: allowedMs })),
      ),
    );

  const instancesHere: Effect.Effect<Instances> = providers.getProviders.pipe(
    Effect.map(
      (listed) =>
        new Map(
          listed.flatMap((provider) =>
            provider.instanceId === undefined
              ? []
              : [[provider.instanceId, { driver: provider.driver, enabled: provider.enabled }]],
          ),
        ),
    ),
  );

  /**
   * What a version this machine has no newer one of does here. An account's version applies when
   * this machine may take it. One on a driver this build does not share came from a newer build: it
   * waits, and applies once this machine is updated. Anything else that keeps an account out here,
   * such as a lock or another driver under the same id, only passes it on.
   */
  const dispositionHere = (
    candidate: Candidate,
    current: ServerSettings,
    instances: Instances,
  ): Exclude<Disposition, "known"> => {
    const readable = candidate.readable;
    if (readable?.kind === "instance") {
      if (
        canTakeSharedProviderInstance(
          sharing,
          current,
          readable.instanceId,
          readable.value,
          settings.managedPolicy,
        )
      ) {
        return "apply";
      }
      return "removed" in readable.value || sharing.has(readable.value.driver) ? "relay" : "wait";
    }
    if (isManagedSettingPath(settings.managedPolicy, candidate.key)) return "relay";
    if (readable === undefined) return "wait";
    return selectionWaits({ ...candidate, readable }, current, instances) ? "wait" : "apply";
  };

  const dispose = (
    candidate: Candidate,
    versions: KeyVersions,
    current: ServerSettings,
    instances: Instances,
  ): Disposition => {
    if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.shared))) return "known";
    if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.local))) return "relay";
    return dispositionHere(candidate, current, instances);
  };

  /**
   * A version from another machine, or none for a setting this build keeps to one machine. A key
   * this build does not know, or a value it cannot decode, is kept unread, to pass on.
   */
  const toCandidate = Effect.fn("SharedSettings.toCandidate")(function* (
    entry: SharedSettingValue,
    stamp: SharedSettingStamp,
  ) {
    const key = entry.key;
    if (isMachineOnlySettingKey(key)) return Option.none<Candidate>();
    let readable: Readable | undefined;
    if (isMachineSharedSettingKey(key)) {
      const value = yield* decodeValue(key, entry.value).pipe(Effect.option);
      if (Option.isSome(value)) readable = { kind: "setting", key, value: value.value };
    } else {
      const instanceId = sharedProviderInstanceIdOf(key);
      const value = decodeInstanceValue(entry.value);
      if (instanceId !== undefined && Option.isSome(value)) {
        readable = { kind: "instance", instanceId, value: value.value };
      }
    }
    return Option.some<Candidate>({
      key,
      raw: entry.value,
      readable,
      instanceDriver: entry.instanceDriver,
      stamp,
    });
  });

  /**
   * Keeps a version that does not apply here, to pass on: `pending` while it waits. One this build
   * cannot read is said once, when it is first kept; past the room for unknown keys it is dropped.
   */
  const keepCandidate = Effect.fn("SharedSettings.keepCandidate")(function* (
    candidate: Candidate,
    kind: "shared" | "deferred",
    pending: boolean,
  ) {
    const entry = { key: candidate.key, ...candidate.stamp };
    if (!hasRoomFor(yield* readRows, candidate)) {
      yield* logOnce(
        "no-room",
        entry,
        "A linked machine shared more settings this build does not know than it keeps, so one was dropped",
        { maxUnknownKeys: MAX_UNKNOWN_KEYS },
      );
      return false;
    }
    yield* putCandidate(candidate, kind, pending);
    if (candidate.readable === undefined && kind === "shared") {
      yield* logOnce(
        "unreadable",
        entry,
        "A linked machine shared a setting this build cannot read; it is passed on, and applies once this machine is updated",
      );
    }
    return true;
  });

  /** The versions that fit: each value within its limit, and all of them within one answer's. */
  const withinSizeLimits = Effect.fn("SharedSettings.withinSizeLimits")(function* (
    versions: ReadonlyArray<SharedSettingVersion>,
    peer?: EnvironmentId,
  ) {
    const kept: SharedSettingVersion[] = [];
    let total = 0;
    for (const entry of versions) {
      if (!(yield* fitsSize(entry, peer))) continue;
      const bytes = jsonBytes(entry);
      if (total + bytes > SHARED_SETTINGS_RESPONSE_MAX_BYTES) {
        yield* logOnce(
          "over-answer",
          entry,
          "Shared settings are too large for one answer between machines, so one was left out",
          { maxBytes: SHARED_SETTINGS_RESPONSE_MAX_BYTES, ...(peer === undefined ? {} : { peer }) },
        );
        continue;
      }
      total += bytes;
      kept.push(entry);
    }
    return kept;
  });

  /** This machine's whole value of a shared setting, as it shares it. */
  const ownValue = Effect.fn("SharedSettings.ownValue")(function* (
    key: MachineSharedSettingKey,
    stored: ServerSettings,
  ) {
    const value = sharedSettingValue(stored, key);
    const instanceId = sharedSelectionInstanceId(key, value);
    return {
      key,
      value: yield* encodeValue(key, value),
      ...(instanceId === undefined
        ? {}
        : { instanceDriver: providerInstanceDriver(stored, instanceId) }),
    } satisfies SharedSettingValue;
  });

  /**
   * What a machine records of its own change to its accounts or their order. One that follows shares
   * each as its own version, as it would a change saved for all machines; one that does not records
   * it as a change made here alone, which an older version from the group cannot undo once it follows.
   */
  const recordAccounts = Effect.fn("SharedSettings.recordAccounts")(function* (
    keys: ReadonlyArray<MachineSharedSettingKey>,
    accounts: ReturnType<typeof changedSharedProviderInstances>,
    stored: ServerSettings,
  ) {
    const now = yield* nowStamp;
    const follows = stored.followSharedSettings;
    const rows = yield* readRows;
    const put = (key: string, value: SharedSettingValue["value"], instanceDriver?: string) =>
      follows
        ? putRow(key, "shared", { json: toJson(value), instanceDriver }, ownStamp(rows, key, now))
        : putRow(key, "local", null, now);
    for (const key of keys) {
      const value = yield* ownValue(key, stored);
      yield* put(key, value.value, value.instanceDriver);
    }
    for (const [instanceId, value] of accounts) {
      yield* put(sharedProviderInstanceKey(instanceId), value);
    }
  });

  // The settings are already stored when this runs, so a failure is logged, not returned.
  const recordOutcome = Effect.fn("SharedSettings.recordOutcome")(function* (
    outcome: WriteOutcome,
    before: ServerSettings | undefined,
    stored: ServerSettings,
  ) {
    const accountKeys = outcome.local.filter((key) => ACCOUNT_SHARED_SETTING_KEYS.has(key));
    const local = outcome.local.filter((key) => !ACCOUNT_SHARED_SETTING_KEYS.has(key));
    if (local.length > 0) {
      const stamp = yield* nowStamp;
      yield* Effect.forEach(local, (key) => putRow(key, "local", null, stamp), {
        discard: true,
      });
    }
    yield* Effect.forEach(outcome.applied, (candidate) => putCandidate(candidate, "shared"), {
      discard: true,
    });
    const accounts =
      before === undefined ? [] : changedSharedProviderInstances(sharing, before, stored);
    if (accountKeys.length > 0 || accounts.length > 0) {
      yield* recordAccounts(accountKeys, accounts, stored);
    }
    const stamp = outcome.stamp;
    const values: SharedSettingValue[] = [];
    if (stamp === undefined) return values;
    for (const key of outcome.ownShared) {
      const value = yield* ownValue(key, stored);
      values.push(value);
      yield* putRow(
        key,
        "shared",
        { json: toJson(value.value), instanceDriver: value.instanceDriver },
        stamp,
      );
    }
    return values;
  });

  const recordAfterWrite =
    (
      outcome: () => WriteOutcome,
      before: () => ServerSettings | undefined,
      sink: ShareSink | undefined,
    ) =>
    (stored: ServerSettings) =>
      recordOutcome(outcome(), before(), stored).pipe(
        Effect.map((values) => {
          if (sink !== undefined) sink.values = values;
        }),
        Effect.catch((error: SharedSettingsError) =>
          Effect.logError("Could not record a settings change for the user's other machines", {
            keys: [
              ...outcome().applied.map((candidate) => candidate.key),
              ...outcome().ownShared,
              ...outcome().local,
            ],
            cause: error,
          }),
        ),
      );

  /**
   * Decides a write another machine stamped, under the lock: each shared setting it carries is
   * applied, kept waiting or only passed on. Versions that do not apply are stored here, since the
   * settings write that follows may store nothing.
   */
  const planStamped = Effect.fn("SharedSettings.planStamped")(function* (
    patch: ServerSettingsPatch,
    share: SharedSettingsShare,
    current: ServerSettings,
  ) {
    if (!current.followSharedSettings) {
      return yield* refuse("take-shared-setting-unfollowed");
    }
    const candidates = new Map<string, Candidate>();
    for (const entry of share.values) {
      // An account is stamped by the machine that changed it and reaches others only by pulls.
      if (sharedProviderInstanceIdOf(entry.key) !== undefined) continue;
      if (!(yield* fitsSize({ ...entry, ...share.stamp }))) continue;
      const candidate = yield* toCandidate(entry, share.stamp);
      if (Option.isSome(candidate)) candidates.set(candidate.value.key, candidate.value);
    }
    const rows = yield* readRowsForWrite;
    const instances = yield* instancesHere;
    const applied: Candidate[] = [];
    for (const candidate of candidates.values()) {
      const disposition = dispose(candidate, versionsOf(rows, candidate.key), current, instances);
      if (disposition === "apply") {
        applied.push(candidate);
      } else if (disposition !== "known") {
        yield* keepCandidate(candidate, "shared", disposition === "wait").pipe(
          Effect.mapError((error) => refuse("write-file", error)),
        );
      }
    }
    // Shared settings travel only in the share, with their stamp.
    return {
      plan: {
        patch: withoutKeys(patch, SHARED_FIELDS),
        replace: replacements(sharing, current, applied),
      },
      outcome: { ...NO_OUTCOME, applied },
    };
  });

  /**
   * Decides a change saved for all machines here, under the lock: stamped now, merged into this
   * machine's values, and shared for each key it sets unless a version here is newer.
   */
  const planFromThisMachine = Effect.fn("SharedSettings.planFromThisMachine")(function* (
    patch: ServerSettingsPatch,
    current: ServerSettings,
    seed: boolean,
  ) {
    if (!current.followSharedSettings) {
      return yield* refuse("take-shared-setting-unfollowed");
    }
    const now = yield* nowStamp;
    const stamp: SharedSettingStamp = seed
      ? { updatedAt: SHARED_SETTING_SEED_UPDATED_AT, origin: now.origin }
      : now;
    const rows = yield* readRowsForWrite;
    const keys = sharedSettingKeysIn(patch);
    const isFresh = (key: MachineSharedSettingKey) => {
      const versions = versionsOf(rows, key);
      return (
        isNewerSharedSetting(stamp, stampOf(versions.shared)) &&
        isNewerSharedSetting(stamp, stampOf(versions.local))
      );
    };
    const fresh = keys.filter(isFresh);
    const stale = keys.filter((key) => !fresh.includes(key)).flatMap(keyFields);
    return {
      plan: { patch: withoutKeys(patch, stale) },
      outcome: { ...NO_OUTCOME, stamp, ownShared: fresh },
    };
  });

  /**
   * The hooks for one write. `keepEmpty` keeps a write that ends up setting nothing, for a write that
   * also changes a provider instance.
   */
  const writeHooks = Effect.fn("SharedSettings.writeHooks")(function* (
    patch: ServerSettingsPatch,
    share: WriteShare,
    keepEmpty: boolean,
    sink?: ShareSink,
    allowedAheadMs = MAX_CLOCK_SKEW_MS,
  ) {
    // A stamp made by another clock, further ahead of this one's than it may be.
    if (
      share !== undefined &&
      !isFromThisMachine(share) &&
      (yield* isAhead(share.stamp, allowedAheadMs))
    ) {
      return yield* refuse("take-shared-setting-clock-ahead");
    }
    let outcome: WriteOutcome =
      share === undefined ? { ...NO_OUTCOME, local: sharedSettingKeysIn(patch) } : NO_OUTCOME;
    // The settings as they stood under the lock, to tell which accounts the write changed.
    let before: ServerSettings | undefined;
    return {
      prepare: (current) => {
        before = current;
        if (share === undefined) return Effect.succeed({ patch });
        const planning: Effect.Effect<Planned, ServerSettingsError> = isFromThisMachine(share)
          ? planFromThisMachine(patch, current, share === "seedFromThisMachine")
          : planStamped(patch, share, current);
        return planning.pipe(
          Effect.map((planned) => {
            outcome = planned.outcome;
            if (sink !== undefined) sink.stamp = planned.outcome.stamp;
            return !keepEmpty && isEmptyPlan(planned.plan) ? undefined : planned.plan;
          }),
        );
      },
      persisted: recordAfterWrite(
        () => outcome,
        () => before,
        sink,
      ),
    } satisfies Settings.SettingsWriteHooks;
  });

  // Runs once the value is stored, so a failed record is logged rather than failing the save.
  const recordTaken = (key: string, record: Effect.Effect<unknown, SharedSettingsError>) =>
    record.pipe(
      Effect.catch((error) =>
        Effect.logError("Could not record a shared setting this machine took", {
          key,
          cause: error,
        }),
      ),
    );

  /**
   * Takes a version under the lock: applies it, keeps it waiting, or only passes it on, as `dispose`
   * decides against the versions and settings as they stand then.
   */
  const take = (candidate: Candidate, instances: Instances) =>
    settings.updateSettings(
      {},
      {
        prepare: Effect.fn("SharedSettings.take.prepare")(function* (current) {
          if (!current.followSharedSettings) return undefined;
          const rows = yield* readRowsForWrite;
          const disposition = dispose(
            candidate,
            versionsOf(rows, candidate.key),
            current,
            instances,
          );
          if (disposition === "known") return undefined;
          if (disposition === "apply") {
            return { patch: {}, replace: replacements(sharing, current, [candidate]) };
          }
          yield* keepCandidate(candidate, "shared", disposition === "wait").pipe(
            Effect.mapError((error) => refuse("write-file", error)),
          );
          return undefined;
        }),
        persisted: () => recordTaken(candidate.key, putCandidate(candidate, "shared")),
      },
    );

  /** Keeps a version from a fast clock until its time; logs it once, when it first arrives. */
  const defer = (peer: EnvironmentId, candidate: Candidate) =>
    settings.withSettingsSnapshot((current) =>
      Effect.gen(function* () {
        if (!current.followSharedSettings) return;
        const versions = versionsOf(yield* readRows, candidate.key);
        if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.shared))) return;
        if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.deferred))) return;
        if (!(yield* keepCandidate(candidate, "deferred", false))) return;
        yield* Effect.logWarning(
          "A linked machine shared a setting dated more than 5 minutes ahead of this machine's clock; it waits until then",
          {
            peer,
            key: candidate.key,
            updatedAt: candidate.stamp.updatedAt,
            origin: candidate.stamp.origin,
          },
        );
      }),
    );

  const takeVersion = Effect.fn("SharedSettings.takeVersion")(function* (
    peer: EnvironmentId,
    version: SharedSettingVersion,
    instances: Instances,
  ) {
    // Never re-dated: a version keeps the stamp it was made with on every machine.
    const stamp: SharedSettingStamp = { updatedAt: version.updatedAt, origin: version.origin };
    const candidate = yield* toCandidate(version, stamp);
    if (Option.isNone(candidate)) {
      return yield* Effect.logDebug("Ignored a setting this build keeps to one machine", {
        peer,
        key: version.key,
      });
    }
    if (yield* isAhead(stamp)) return yield* defer(peer, candidate.value);
    yield* take(candidate.value, instances);
  });

  const applyPulled: SharedSettings["Service"]["applyPulled"] = Effect.fn(
    "SharedSettings.applyPulled",
  )(
    function* (peer, versions) {
      // Checked again under the lock for each version, in case following is turned off meanwhile.
      if (!(yield* settings.getSettings).followSharedSettings) return;
      const instances = yield* instancesHere;
      yield* Effect.forEach(
        yield* withinSizeLimits(versions, peer),
        (version) =>
          takeVersion(peer, version, instances).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not take a shared setting from a linked machine", {
                peer,
                key: version.key,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not take shared settings", { cause })),
  );

  const candidateOfRow = Effect.fn("SharedSettings.candidateOfRow")(function* (row: VersionRow) {
    if (row.valueJson === null) return Option.none<Candidate>();
    const raw = parseJson(row.valueJson);
    if (Option.isNone(raw)) return Option.none<Candidate>();
    return yield* toCandidate(
      {
        key: row.settingKey,
        value: raw.value,
        ...(row.instanceDriver === null ? {} : { instanceDriver: row.instanceDriver }),
      },
      rowStamp(row),
    );
  });

  /** A waiting version applies once this machine can use its model, unless a change made here since is newer. */
  const retryPendingRow = Effect.fn("SharedSettings.retryPendingRow")(function* (
    row: VersionRow,
    instances: Instances,
  ) {
    const candidate = yield* candidateOfRow(row);
    if (Option.isNone(candidate)) return;
    const { key, readable, stamp } = candidate.value;
    // This build cannot read it yet; it is passed on until an update here can.
    if (readable === undefined) return;
    yield* settings.updateSettings(
      {},
      {
        prepare: Effect.fn("SharedSettings.retryPendingRow.prepare")(function* (current) {
          if (!current.followSharedSettings) return undefined;
          const versions = yield* readVersionsForWrite(key);
          if (!sameStamp(versions.shared, stamp) || versions.shared?.pending !== 1) {
            return undefined;
          }
          const disposition = isNewerSharedSetting(stamp, stampOf(versions.local))
            ? dispositionHere(candidate.value, current, instances)
            : "relay";
          if (disposition === "relay") {
            // It is passed on, but never applied here.
            yield* clearPending(key, stamp).pipe(
              Effect.mapError((error) => refuse("write-file", error)),
            );
            return undefined;
          }
          if (disposition === "wait") return undefined;
          return { patch: {}, replace: replacements(sharing, current, [candidate.value]) };
        }),
        persisted: () => recordTaken(key, clearPending(key, stamp)),
      },
    );
  });

  const retryDeferredRow = Effect.fn("SharedSettings.retryDeferredRow")(function* (
    row: VersionRow,
    instances: Instances,
  ) {
    const key = row.settingKey;
    const stamp = rowStamp(row);
    if (yield* isAhead(stamp)) return;
    // Taken or not, it has had its turn; a peer that still has it serves it again.
    yield* candidateOfRow(row).pipe(
      Effect.flatMap((candidate) =>
        Option.isSome(candidate) ? take(candidate.value, instances) : Effect.void,
      ),
      Effect.ensuring(
        deleteRow(key, "deferred", stamp).pipe(
          Effect.catch((error) =>
            Effect.logError("Could not drop a shared setting that had waited", {
              key,
              cause: error,
            }),
          ),
        ),
      ),
    );
  });

  const retryWaiting: SharedSettings["Service"]["retryWaiting"] = Effect.gen(function* () {
    if (!(yield* settings.getSettings).followSharedSettings) return;
    const rows = yield* readRows;
    const waiting = rows.filter(
      (row) => (row.kind === "shared" && row.pending === 1) || row.kind === "deferred",
    );
    if (waiting.length === 0) return;
    const instances = yield* instancesHere;
    yield* Effect.forEach(
      waiting,
      (row) =>
        (row.kind === "deferred"
          ? retryDeferredRow(row, instances)
          : retryPendingRow(row, instances)
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not apply a shared setting that was waiting", {
              key: row.settingKey,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not retry shared settings that were waiting", { cause }),
    ),
    Effect.withSpan("SharedSettings.retryWaiting"),
  );

  const servedVersions = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.mapError(storeError("read-settings")));
    if (!current.followSharedSettings) return [];
    const rows = yield* readRows;
    const versions = rows.flatMap((row): SharedSettingVersion[] => {
      if (row.kind !== "shared" || row.valueJson === null) return [];
      if (isMachineOnlySettingKey(row.settingKey)) return [];
      const value = parseJson(row.valueJson);
      return Option.isNone(value)
        ? []
        : [
            {
              key: row.settingKey,
              value: value.value,
              ...(row.instanceDriver === null ? {} : { instanceDriver: row.instanceDriver }),
              updatedAt: row.updatedAt,
              origin: row.origin as EnvironmentId,
            },
          ];
    });
    return yield* withinSizeLimits(versions);
  });

  /**
   * A write's share as this machine takes it. A client's own stamp, from a client before
   * `server.shareSettings` or one writing to a machine without it, carries the whole values in the
   * patch, and may be far less ahead of this machine's clock than a server's.
   */
  const delivered = Effect.fn("SharedSettings.delivered")(function* (
    patch: ServerSettingsPatch,
    share: SharedSettingsWriteShare | undefined,
  ) {
    if (share === undefined || "stamp" in share) {
      return { share, allowedAheadMs: MAX_CLOCK_SKEW_MS };
    }
    const values = yield* Effect.forEach(
      MACHINE_SHARED_SETTING_KEYS.filter((key) => patch[key] !== undefined),
      (key) => encodeValue(key, patch[key]).pipe(Effect.map((value) => ({ key, value }))),
    ).pipe(Effect.mapError((error) => refuse("normalize", error)));
    return {
      share: { stamp: share, values } satisfies SharedSettingsShare,
      allowedAheadMs: MAX_CLIENT_STAMP_AHEAD_MS,
    };
  });

  return SharedSettings.of({
    servedVersions,
    update: Effect.fn("SharedSettings.update")(function* (patch, share) {
      const taken = yield* delivered(patch, share);
      return yield* settings.updateSettings(
        patch,
        yield* writeHooks(patch, taken.share, false, undefined, taken.allowedAheadMs),
      );
    }),
    updateProviderInstance: Effect.fn("SharedSettings.updateProviderInstance")(
      function* (mutation, patch, share) {
        const taken = yield* delivered(patch, share);
        return yield* settings.updateProviderInstance(
          mutation,
          patch,
          yield* writeHooks(patch, taken.share, true, undefined, taken.allowedAheadMs),
        );
      },
    ),
    updateForAllMachines: Effect.fn("SharedSettings.updateForAllMachines")(
      function* (patch, options) {
        const sink: ShareSink = { stamp: undefined, values: [] };
        const stored = yield* settings.updateSettings(
          patch,
          yield* writeHooks(
            patch,
            options?.seed === true ? "seedFromThisMachine" : "fromThisMachine",
            false,
            sink,
          ),
        );
        // `prepare` stamps the change under the lock; it refuses the write when it cannot.
        if (sink.stamp === undefined) return yield* refuse("take-shared-setting-unfollowed");
        return { settings: stored, share: { stamp: sink.stamp, values: sink.values } };
      },
    ),
    applyPulled,
    retryWaiting,
  });
});

export const layer = Layer.effect(SharedSettings, make);

/** For tests of services that save settings: every write is this machine's own, with no versions. */
export const layerTest = Layer.effect(
  SharedSettings,
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    return SharedSettings.of({
      servedVersions: Effect.succeed([]),
      update: Effect.fn("SharedSettings.test.update")((patch) => settings.updateSettings(patch)),
      updateProviderInstance: Effect.fn("SharedSettings.test.updateProviderInstance")(
        (mutation, patch) => settings.updateProviderInstance(mutation, patch),
      ),
      updateForAllMachines: Effect.fn("SharedSettings.test.updateForAllMachines")((patch) =>
        settings.updateSettings(patch).pipe(
          Effect.flatMap((stored) =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                settings: stored,
                share: {
                  stamp: { updatedAt: DateTime.formatIso(now), origin: "test" as EnvironmentId },
                  values: [],
                },
              })),
            ),
          ),
        ),
      ),
      applyPulled: Effect.fn("SharedSettings.test.applyPulled")(() => Effect.void),
      retryWaiting: Effect.void,
    });
  }),
);
