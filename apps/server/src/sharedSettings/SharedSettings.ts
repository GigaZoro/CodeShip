import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  isNewerSharedSetting,
  MACHINE_SHARED_SETTING_KEYS,
  type MachineSharedSettingKey,
  type ProviderInstanceMutation,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsOperation,
  ServerSettingsPatch,
  sharedSettingKeysIn,
  sharedSettingValue,
  type SharedSettingStamp,
  type SharedSettingVersion,
} from "@t3tools/contracts";
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

/** Keys that name a provider instance, which another machine may not have. */
const MODEL_SELECTION_KEYS: ReadonlySet<MachineSharedSettingKey> = new Set([
  "defaultModelSelection",
  "scheduledTaskModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
]);

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
 * ends up with one value. It is stored and sent in the form a settings write carries, and decoded
 * whole, with any part left out at its default, so the stored JSON is always what a peer can decode.
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

const encodeValue = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.encodeUnknownEffect(patchCodec(key))({ [key]: value }).pipe(
    Effect.map((encoded) => JSON.stringify(encoded[key])),
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

/** The whole value a write's decoded patch value stands for, as a peer decodes it. */
const wholeValueOfPatch = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.encodeUnknownEffect(patchCodec(key))({ [key]: value }).pipe(
    Effect.mapError((cause) => new SharedSettingsError({ operation: "encode", cause })),
    Effect.flatMap((encoded) => decodeValue(key, encoded[key])),
  );

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * `shared` is the version this machine took and passes on, `local` when it last changed the setting
 * on its own, and `deferred` a version from a fast clock that waits until its time.
 */
type VersionKind = "shared" | "local" | "deferred";

interface VersionRow {
  readonly settingKey: string;
  readonly kind: string;
  readonly valueJson: string | null;
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

/** A shared version applies only over both the last one taken and the last change made here alone. */
const isFresh = (stamp: SharedSettingStamp, versions: KeyVersions) =>
  isNewerSharedSetting(stamp, stampOf(versions.shared)) &&
  isNewerSharedSetting(stamp, stampOf(versions.local));

/** The shared keys a write sets by name. */
const namedSharedKeys = (patch: ServerSettingsPatch): ReadonlyArray<MachineSharedSettingKey> =>
  MACHINE_SHARED_SETTING_KEYS.filter((key) => patch[key] !== undefined);

const withoutKeys = (patch: ServerSettingsPatch, keys: ReadonlyArray<string>) =>
  Object.fromEntries(
    Object.entries(patch).filter(([key]) => !keys.includes(key)),
  ) as ServerSettingsPatch;

const isEmptyPlan = (plan: Settings.SettingsWritePlan) =>
  Object.keys(plan.patch).length === 0 && Object.keys(plan.replace ?? {}).length === 0;

/** Whether a model selection names an instance this machine has, so applying it cannot dangle. */
function namesMissingInstance(
  key: MachineSharedSettingKey,
  value: unknown,
  instances: ReadonlySet<string>,
): boolean {
  if (!MODEL_SELECTION_KEYS.has(key)) return false;
  if (typeof value !== "object" || value === null) return false;
  const instanceId = (value as { readonly instanceId?: unknown }).instanceId;
  return typeof instanceId === "string" && !instances.has(instanceId);
}

const refuse = (operation: ServerSettingsOperation, cause?: unknown) =>
  new ServerSettingsError({ settingsPath: VERSIONS_PATH, operation, cause });

/**
 * How a write is saved: for this machine alone, as the shared version with a client's stamp and
 * whole values, or as a change an agent here saves for all machines.
 */
type WriteShare = SharedSettingStamp | "fromThisMachine" | undefined;

interface WriteOutcome {
  readonly stamp: SharedSettingStamp | undefined;
  /** Keys that became the shared version, recorded with `stamp`. */
  readonly shared: ReadonlyArray<MachineSharedSettingKey>;
  /** Keys this machine changed on its own, recorded as its local change. */
  readonly local: ReadonlyArray<MachineSharedSettingKey>;
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
     * A settings write. Without `share` it is this machine's own change: each shared key it sets
     * records when, so an older shared version cannot undo it. With `share` it is a change saved for
     * all machines, carrying each shared key's whole value: a machine that does not follow shared
     * settings refuses it, and a key whose version or local change here is newer keeps its value.
     */
    readonly update: (
      patch: ServerSettingsPatch,
      share: SharedSettingStamp | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /** `update` for a write that also adds, changes or removes a provider instance. */
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch: ServerSettingsPatch,
      share: SharedSettingStamp | undefined,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /**
     * A change an agent on this machine saves for all machines: completed from this machine's own
     * values and stamped now, both under the write lock.
     */
    readonly updateForAllMachines: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;
    /** Takes what a peer knows that is newer than this machine's versions. */
    readonly applyPulled: (
      peer: EnvironmentId,
      versions: ReadonlyArray<SharedSettingVersion>,
    ) => Effect.Effect<void>;
    /**
     * Applies versions that waited for a provider instance this machine did not have, or for this
     * machine's clock to reach the time they were stamped with.
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
    valueJson: string | null,
    stamp: SharedSettingStamp,
    pending = false,
  ) =>
    sql`
      INSERT INTO shared_setting_versions
        (setting_key, kind, value_json, updated_at, origin, pending)
      VALUES (${key}, ${kind}, ${valueJson}, ${stamp.updatedAt}, ${stamp.origin}, ${pending ? 1 : 0})
      ON CONFLICT (setting_key, kind) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at,
        origin = excluded.origin,
        pending = excluded.pending
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

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

  // The settings are already stored when these run, so a failure is logged, not returned.
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
    const stamp = outcome.stamp;
    if (stamp === undefined) return;
    yield* Effect.forEach(
      outcome.shared,
      (key) =>
        encodeValue(key, sharedSettingValue(stored, key)).pipe(
          Effect.flatMap((valueJson) => putRow(key, "shared", valueJson, stamp)),
        ),
      { discard: true },
    );
  });

  const recordAfterWrite = (outcome: () => WriteOutcome) => (stored: ServerSettings) =>
    recordOutcome(outcome(), stored).pipe(
      Effect.catch((error: SharedSettingsError) =>
        Effect.logError("Could not record a settings change for the user's other machines", {
          keys: [...outcome().shared, ...outcome().local],
          cause: error,
        }),
      ),
    );

  /**
   * Decides a shared write under the lock: which shared keys take it, and with what whole value. A
   * key whose stored version or local change is newer is left out, so value and version agree.
   */
  const planShared = Effect.fn("SharedSettings.planShared")(function* (
    patch: ServerSettingsPatch,
    share: SharedSettingStamp | "fromThisMachine",
    current: ServerSettings,
  ) {
    if (!current.followSharedSettings) {
      return yield* refuse("take-shared-setting-unfollowed");
    }
    const stamp = share === "fromThisMachine" ? yield* nowStamp : share;
    const rows = yield* readRowsForWrite;
    const named = namedSharedKeys(patch);
    const fresh = named.filter((key) => isFresh(stamp, versionsOf(rows, key)));
    const stale = named.filter((key) => !fresh.includes(key));
    // The legacy flag carries no whole value to share, so it stays this machine's own change.
    const legacyOnly = sharedSettingKeysIn(patch).filter((key) => !named.includes(key));
    const outcome: WriteOutcome = { stamp, shared: fresh, local: legacyOnly };
    if (share === "fromThisMachine") {
      // Completed from this machine's values, merging the patch is the whole value it shares.
      return { plan: { patch: withoutKeys(patch, stale) }, outcome };
    }
    const replace: Record<string, unknown> = {};
    for (const key of fresh) {
      replace[key] = yield* wholeValueOfPatch(key, patch[key]).pipe(
        Effect.mapError((error) => refuse("normalize", error)),
      );
    }
    return {
      plan: { patch: withoutKeys(patch, named), replace: replace as Partial<ServerSettings> },
      outcome,
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
  ) {
    if (share === undefined) {
      const outcome: WriteOutcome = {
        stamp: undefined,
        shared: [],
        local: sharedSettingKeysIn(patch),
      };
      return { persisted: recordAfterWrite(() => outcome) } satisfies Settings.SettingsWriteHooks;
    }
    if (share !== "fromThisMachine" && (yield* isAhead(share))) {
      return yield* refuse("take-shared-setting-clock-ahead");
    }
    let outcome: WriteOutcome = { stamp: undefined, shared: [], local: [] };
    return {
      prepare: (current) =>
        planShared(patch, share, current).pipe(
          Effect.map((planned) => {
            outcome = planned.outcome;
            return !keepEmpty && isEmptyPlan(planned.plan) ? undefined : planned.plan;
          }),
        ),
      persisted: recordAfterWrite(() => outcome),
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

  const knownInstances = Effect.gen(function* () {
    const [listed, current] = yield* Effect.all([providers.getProviders, settings.getSettings]);
    return new Set<string>([
      ...listed.flatMap((provider) =>
        provider.instanceId === undefined ? [] : [provider.instanceId],
      ),
      ...Object.keys(current.providerInstances),
    ]);
  });

  /** Replaces the setting with a version's whole value, if it is still fresh under the lock. */
  const takeValue = (key: MachineSharedSettingKey, value: unknown, stamp: SharedSettingStamp) =>
    settings.updateSettings(
      {},
      {
        prepare: Effect.fn("SharedSettings.takeValue.prepare")(function* (current) {
          if (!current.followSharedSettings) return undefined;
          if (!isFresh(stamp, yield* readVersionsForWrite(key))) return undefined;
          return { patch: {}, replace: { [key]: value } as Partial<ServerSettings> };
        }),
        persisted: (stored) =>
          recordTaken(
            key,
            encodeValue(key, sharedSettingValue(stored, key)).pipe(
              Effect.flatMap((valueJson) => putRow(key, "shared", valueJson, stamp)),
            ),
          ),
      },
    );

  /** Keeps a version that names a missing provider instance; it is still passed on. */
  const keepPending = (key: MachineSharedSettingKey, value: unknown, stamp: SharedSettingStamp) =>
    settings.withSettingsSnapshot((current) =>
      Effect.gen(function* () {
        if (!current.followSharedSettings) return;
        if (!isFresh(stamp, yield* readVersions(key))) return;
        yield* putRow(key, "shared", yield* encodeValue(key, value), stamp, true);
      }),
    );

  /** Keeps a version from a fast clock until its time; logs it once, when it first arrives. */
  const defer = (
    peer: EnvironmentId,
    key: MachineSharedSettingKey,
    value: unknown,
    stamp: SharedSettingStamp,
  ) =>
    settings.withSettingsSnapshot((current) =>
      Effect.gen(function* () {
        if (!current.followSharedSettings) return;
        const versions = yield* readVersions(key);
        if (!isFresh(stamp, versions)) return;
        if (!isNewerSharedSetting(stamp, stampOf(versions.deferred))) return;
        yield* putRow(key, "deferred", yield* encodeValue(key, value), stamp);
        yield* Effect.logWarning(
          "A linked machine shared a setting dated more than 5 minutes ahead of this machine's clock; it waits until then",
          { peer, key, updatedAt: stamp.updatedAt, origin: stamp.origin },
        );
      }),
    );

  /** A version whose time has come: applied now, or kept while it names a missing instance. */
  const takeDue = (
    key: MachineSharedSettingKey,
    value: unknown,
    stamp: SharedSettingStamp,
    instances: ReadonlySet<string>,
  ) =>
    namesMissingInstance(key, value, instances)
      ? keepPending(key, value, stamp)
      : takeValue(key, value, stamp).pipe(Effect.asVoid);

  const takeVersion = Effect.fn("SharedSettings.takeVersion")(function* (
    peer: EnvironmentId,
    version: SharedSettingVersion,
    instances: ReadonlySet<string>,
  ) {
    if (!isMachineSharedSettingKey(version.key)) {
      return yield* Effect.logDebug("Ignored a setting this machine does not share", {
        peer,
        key: version.key,
      });
    }
    const key = version.key;
    // Never re-dated: a version keeps the stamp it was made with on every machine.
    const stamp: SharedSettingStamp = { updatedAt: version.updatedAt, origin: version.origin };
    const value = yield* decodeValue(key, version.value);
    if (yield* isAhead(stamp)) return yield* defer(peer, key, value, stamp);
    yield* takeDue(key, value, stamp, instances);
  });

  const applyPulled: SharedSettings["Service"]["applyPulled"] = Effect.fn(
    "SharedSettings.applyPulled",
  )(
    function* (peer, versions) {
      // Checked again under the lock for each version, in case following is turned off meanwhile.
      if (!(yield* settings.getSettings).followSharedSettings) return;
      const instances = yield* knownInstances;
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

  const decodeRow = Effect.fn("SharedSettings.decodeRow")(function* (row: VersionRow) {
    if (!isMachineSharedSettingKey(row.settingKey) || row.valueJson === null) {
      return Option.none();
    }
    const key = row.settingKey;
    const json = parseJson(row.valueJson);
    if (Option.isNone(json)) return Option.none();
    const value = yield* decodeValue(key, json.value);
    return Option.some({ key, value, stamp: rowStamp(row) });
  });

  /** A pending version applies once its instance exists, unless a change made here since is newer. */
  const retryPendingRow = Effect.fn("SharedSettings.retryPendingRow")(function* (
    row: VersionRow,
    instances: ReadonlySet<string>,
  ) {
    const decoded = yield* decodeRow(row);
    if (Option.isNone(decoded)) return;
    const { key, value, stamp } = decoded.value;
    if (namesMissingInstance(key, value, instances)) return;
    yield* settings.updateSettings(
      {},
      {
        prepare: Effect.fn("SharedSettings.retryPendingRow.prepare")(function* (current) {
          if (!current.followSharedSettings) return undefined;
          const versions = yield* readVersionsForWrite(key);
          if (!sameStamp(versions.shared, stamp) || versions.shared?.pending !== 1) {
            return undefined;
          }
          if (!isNewerSharedSetting(stamp, stampOf(versions.local))) {
            // A change made here since then outranks it for good.
            yield* clearPending(key, stamp).pipe(
              Effect.mapError((error) => refuse("write-file", error)),
            );
            return undefined;
          }
          return { patch: {}, replace: { [key]: value } as Partial<ServerSettings> };
        }),
        persisted: () => recordTaken(key, clearPending(key, stamp)),
      },
    );
  });

  const retryDeferredRow = Effect.fn("SharedSettings.retryDeferredRow")(function* (
    row: VersionRow,
    instances: ReadonlySet<string>,
  ) {
    if (!isMachineSharedSettingKey(row.settingKey)) return;
    const key = row.settingKey;
    const stamp = rowStamp(row);
    if (yield* isAhead(stamp)) return;
    // Taken or not, it has had its turn; a peer that still has it serves it again.
    yield* decodeRow(row).pipe(
      Effect.flatMap((decoded) =>
        Option.isSome(decoded) ? takeDue(key, decoded.value.value, stamp, instances) : Effect.void,
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
    const instances = yield* knownInstances;
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
      return yield* settings.updateSettings(
        patch,
        yield* writeHooks(patch, "fromThisMachine", false),
      );
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
        settings.updateSettings(patch),
      ),
      applyPulled: Effect.fn("SharedSettings.test.applyPulled")(() => Effect.void),
      retryWaiting: Effect.void,
    });
  }),
);
