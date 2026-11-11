import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  isManagedSettingPath,
  isNewerSharedSetting,
  type MachineSharedSettingKey,
  MACHINE_SHARED_SETTING_KEYS,
  type ModelSelection,
  type ProviderInstanceMutation,
  providerInstanceDriver,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsOperation,
  ServerSettingsPatch,
  sharedSelectionInstanceId,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingStamp,
  type SharedSettingsShare,
  type SharedSettingValue,
  type SharedSettingVersion,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";

/**
 * A version stamped further ahead than this came from a clock that runs fast. Taken as written it
 * would outrank every later change until real time caught up, so it waits until then instead.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const parseJson = Schema.decodeUnknownOption(UnknownJson);
const toJson = Schema.encodeSync(UnknownJson);

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

const versionsOf = (rows: ReadonlyArray<VersionRow>, key: MachineSharedSettingKey) => {
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

/** A version from another machine: the JSON it was sent as, and its value as this build reads it. */
interface Candidate {
  readonly key: MachineSharedSettingKey;
  readonly raw: unknown;
  readonly value: unknown;
  readonly instanceDriver: string | undefined;
  readonly stamp: SharedSettingStamp;
}

/**
 * What a machine does with a version: nothing when it knows one as new; pass it on without applying
 * it when a change made here alone is newer, or an administrator locks the setting here; keep it
 * waiting while it names a model this machine cannot use yet; otherwise apply it.
 */
type Disposition = "known" | "relay" | "wait" | "apply";

/** Each provider instance this machine lists, with its driver and whether it is turned on. */
type Instances = ReadonlyMap<string, { readonly driver: string; readonly enabled: boolean }>;

/**
 * A model selection waits while the instance it names is missing here, runs another driver here than
 * where it was saved, or is turned off here, so applying it can never leave a model that cannot run.
 * An instance in the settings is judged by them, as they stand under the lock.
 */
function selectionWaits(candidate: Candidate, current: ServerSettings, instances: Instances) {
  const instanceId = sharedSelectionInstanceId(candidate.key, candidate.value);
  if (instanceId === undefined) return false;
  const here = Object.hasOwn(current.providerInstances, instanceId)
    ? {
        driver: providerInstanceDriver(current, instanceId),
        enabled: isModelSelectionProviderEnabled(current, candidate.value as ModelSelection),
      }
    : instances.get(instanceId);
  if (here === undefined || !here.enabled) return true;
  return candidate.instanceDriver !== undefined && candidate.instanceDriver !== here.driver;
}

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
 * saved for all machines that this machine stamps.
 */
type WriteShare = SharedSettingsShare | "fromThisMachine" | undefined;

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
     * cannot undo. With `share`, a change another machine saved for all: refused unless this machine
     * follows, and each shared setting in it is taken by the rules for a pulled version.
     */
    readonly update: (
      patch: ServerSettingsPatch,
      share: SharedSettingsShare | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /** `update` for a write that also adds, changes or removes a provider instance. */
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch: ServerSettingsPatch,
      share: SharedSettingsShare | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /**
     * A change saved for all machines, made here: completed from this machine's own values and
     * stamped by its clock, both under the write lock. Returns what to send the other machines that
     * follow shared settings; a key whose version here is newer keeps its value and is not in it.
     */
    readonly updateForAllMachines: (patch: ServerSettingsPatch) => Effect.Effect<
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
  `.pipe(Effect.mapError(storeError("read")));

  // At most three rows per shared key, so a lookup reads the whole small table.
  const readVersions = (key: MachineSharedSettingKey) =>
    readRows.pipe(Effect.map((rows) => versionsOf(rows, key)));

  /** For a write hook, which can only fail the way a settings write fails. */
  const readRowsForWrite = readRows.pipe(Effect.mapError((cause) => refuse("read-file", cause)));
  const readVersionsForWrite = (key: MachineSharedSettingKey) =>
    readRowsForWrite.pipe(Effect.map((rows) => versionsOf(rows, key)));

  const putRow = (
    key: MachineSharedSettingKey,
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
  const deleteRow = (key: MachineSharedSettingKey, kind: VersionKind, stamp: SharedSettingStamp) =>
    sql`
      DELETE FROM shared_setting_versions
      WHERE setting_key = ${key} AND kind = ${kind}
        AND updated_at = ${stamp.updatedAt} AND origin = ${stamp.origin}
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

  const clearPending = (key: MachineSharedSettingKey, stamp: SharedSettingStamp) =>
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

  const isAhead = (stamp: SharedSettingStamp) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          stamp.updatedAt >
          DateTime.formatIso(DateTime.add(now, { milliseconds: MAX_CLOCK_SKEW_MS })),
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

  const dispose = (
    candidate: Candidate,
    versions: KeyVersions,
    current: ServerSettings,
    instances: Instances,
  ): Disposition => {
    if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.shared))) return "known";
    if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.local))) return "relay";
    if (isManagedSettingPath(settings.managedPolicy, candidate.key)) return "relay";
    return selectionWaits(candidate, current, instances) ? "wait" : "apply";
  };

  /** A version from another machine, or none for a setting this build does not share. */
  const toCandidate = Effect.fn("SharedSettings.toCandidate")(function* (
    entry: SharedSettingValue,
    stamp: SharedSettingStamp,
  ) {
    if (!isMachineSharedSettingKey(entry.key)) return Option.none<Candidate>();
    const value = yield* decodeValue(entry.key, entry.value);
    return Option.some<Candidate>({
      key: entry.key,
      raw: entry.value,
      value,
      instanceDriver: entry.instanceDriver,
      stamp,
    });
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

  // The settings are already stored when this runs, so a failure is logged, not returned.
  const recordOutcome = Effect.fn("SharedSettings.recordOutcome")(function* (
    outcome: WriteOutcome,
    stored: ServerSettings,
  ) {
    if (outcome.local.length > 0) {
      const local = yield* nowStamp;
      yield* Effect.forEach(outcome.local, (key) => putRow(key, "local", null, local), {
        discard: true,
      });
    }
    yield* Effect.forEach(outcome.applied, (candidate) => putCandidate(candidate, "shared"), {
      discard: true,
    });
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
    (outcome: () => WriteOutcome, sink: ShareSink | undefined) => (stored: ServerSettings) =>
      recordOutcome(outcome(), stored).pipe(
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
    const candidates = new Map<MachineSharedSettingKey, Candidate>();
    for (const entry of share.values) {
      const candidate = yield* toCandidate(entry, share.stamp).pipe(
        Effect.mapError((error) => refuse("normalize", error)),
      );
      if (Option.isSome(candidate)) candidates.set(candidate.value.key, candidate.value);
    }
    const rows = yield* readRowsForWrite;
    const instances = yield* instancesHere;
    const replace: Record<string, unknown> = {};
    const applied: Candidate[] = [];
    for (const candidate of candidates.values()) {
      const disposition = dispose(candidate, versionsOf(rows, candidate.key), current, instances);
      if (disposition === "apply") {
        replace[candidate.key] = candidate.value;
        applied.push(candidate);
      } else if (disposition !== "known") {
        yield* putCandidate(candidate, "shared", disposition === "wait").pipe(
          Effect.mapError((error) => refuse("write-file", error)),
        );
      }
    }
    // Shared settings travel only in the share, with their stamp.
    return {
      plan: {
        patch: withoutKeys(patch, SHARED_FIELDS),
        replace: replace as Partial<ServerSettings>,
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
  ) {
    if (!current.followSharedSettings) {
      return yield* refuse("take-shared-setting-unfollowed");
    }
    const stamp = yield* nowStamp;
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
  ) {
    if (share === undefined) {
      const outcome: WriteOutcome = { ...NO_OUTCOME, local: sharedSettingKeysIn(patch) };
      return {
        persisted: recordAfterWrite(() => outcome, sink),
      } satisfies Settings.SettingsWriteHooks;
    }
    // A stamp made by another machine's clock, more than a few minutes ahead of this one's.
    if (share !== "fromThisMachine" && (yield* isAhead(share.stamp))) {
      return yield* refuse("take-shared-setting-clock-ahead");
    }
    let outcome = NO_OUTCOME;
    return {
      prepare: (current) => {
        const planning: Effect.Effect<Planned, ServerSettingsError> =
          share === "fromThisMachine"
            ? planFromThisMachine(patch, current)
            : planStamped(patch, share, current);
        return planning.pipe(
          Effect.map((planned) => {
            outcome = planned.outcome;
            if (sink !== undefined) sink.stamp = planned.outcome.stamp;
            return !keepEmpty && isEmptyPlan(planned.plan) ? undefined : planned.plan;
          }),
        );
      },
      persisted: recordAfterWrite(() => outcome, sink),
    } satisfies Settings.SettingsWriteHooks;
  });

  // Runs once the value is stored, so a failed record is logged rather than failing the save.
  const recordTaken = (
    key: MachineSharedSettingKey,
    record: Effect.Effect<unknown, SharedSettingsError>,
  ) =>
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
          const versions = yield* readVersionsForWrite(candidate.key);
          const disposition = dispose(candidate, versions, current, instances);
          if (disposition === "known") return undefined;
          if (disposition !== "apply") {
            yield* putCandidate(candidate, "shared", disposition === "wait").pipe(
              Effect.mapError((error) => refuse("write-file", error)),
            );
            return undefined;
          }
          return {
            patch: {},
            replace: { [candidate.key]: candidate.value } as Partial<ServerSettings>,
          };
        }),
        persisted: () => recordTaken(candidate.key, putCandidate(candidate, "shared")),
      },
    );

  /** Keeps a version from a fast clock until its time; logs it once, when it first arrives. */
  const defer = (peer: EnvironmentId, candidate: Candidate) =>
    settings.withSettingsSnapshot((current) =>
      Effect.gen(function* () {
        if (!current.followSharedSettings) return;
        const versions = yield* readVersions(candidate.key);
        if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.shared))) return;
        if (!isNewerSharedSetting(candidate.stamp, stampOf(versions.deferred))) return;
        yield* putCandidate(candidate, "deferred");
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
      return yield* Effect.logDebug("Ignored a setting this machine does not share", {
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
        versions,
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
    const { key, stamp, value } = candidate.value;
    yield* settings.updateSettings(
      {},
      {
        prepare: Effect.fn("SharedSettings.retryPendingRow.prepare")(function* (current) {
          if (!current.followSharedSettings) return undefined;
          const versions = yield* readVersionsForWrite(key);
          if (!sameStamp(versions.shared, stamp) || versions.shared?.pending !== 1) {
            return undefined;
          }
          if (
            !isNewerSharedSetting(stamp, stampOf(versions.local)) ||
            isManagedSettingPath(settings.managedPolicy, key)
          ) {
            // It is passed on, but never applied here.
            yield* clearPending(key, stamp).pipe(
              Effect.mapError((error) => refuse("write-file", error)),
            );
            return undefined;
          }
          if (selectionWaits(candidate.value, current, instances)) return undefined;
          return { patch: {}, replace: { [key]: value } as Partial<ServerSettings> };
        }),
        persisted: () => recordTaken(key, clearPending(key, stamp)),
      },
    );
  });

  const retryDeferredRow = Effect.fn("SharedSettings.retryDeferredRow")(function* (
    row: VersionRow,
    instances: Instances,
  ) {
    if (!isMachineSharedSettingKey(row.settingKey)) return;
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
    return rows.flatMap((row): SharedSettingVersion[] => {
      if (row.kind !== "shared" || row.valueJson === null) return [];
      if (!isMachineSharedSettingKey(row.settingKey)) return [];
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
  });

  return SharedSettings.of({
    servedVersions,
    update: Effect.fn("SharedSettings.update")(function* (patch, share) {
      return yield* settings.updateSettings(patch, yield* writeHooks(patch, share, false));
    }),
    updateProviderInstance: Effect.fn("SharedSettings.updateProviderInstance")(
      function* (mutation, patch, share) {
        return yield* settings.updateProviderInstance(
          mutation,
          patch,
          yield* writeHooks(patch, share, true),
        );
      },
    ),
    updateForAllMachines: Effect.fn("SharedSettings.updateForAllMachines")(function* (patch) {
      const sink: ShareSink = { stamp: undefined, values: [] };
      const stored = yield* settings.updateSettings(
        patch,
        yield* writeHooks(patch, "fromThisMachine", false, sink),
      );
      // `prepare` stamps the change under the lock; it refuses the write when it cannot.
      if (sink.stamp === undefined) return yield* refuse("take-shared-setting-unfollowed");
      return { settings: stored, share: { stamp: sink.stamp, values: sink.values } };
    }),
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
