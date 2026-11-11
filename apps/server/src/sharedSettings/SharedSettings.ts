import {
  type EnvironmentId,
  isMachineSharedSettingKey,
  isNewerSharedSetting,
  MACHINE_SHARED_SETTING_KEYS,
  type MachineSharedSettingKey,
  type ProviderInstanceMutation,
  type ServerSettings,
  type ServerSettingsError,
  ServerSettingsPatch,
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

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";

/**
 * A version dated further ahead than this was stamped by a clock that runs fast. Kept as written, it
 * would outrank every later change until real time caught up, so it is dated now instead.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

/** Where a value is checked on its way in and out, so the stored JSON is always what a peer can decode. */
const valueCodecs = new Map<MachineSharedSettingKey, Schema.Codec<Record<string, unknown>>>();
const valueCodec = (key: MachineSharedSettingKey) => {
  let codec = valueCodecs.get(key);
  if (codec === undefined) {
    codec = Schema.Struct({
      [key]: ServerSettingsPatch.fields[key],
    }) as unknown as Schema.Codec<Record<string, unknown>>;
    valueCodecs.set(key, codec);
  }
  return codec;
};

const encodeValue = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.encodeUnknownEffect(valueCodec(key))({ [key]: value }).pipe(
    Effect.map((encoded) => JSON.stringify(encoded[key])),
  );

/** Fails when the value is not what the setting stores, or is missing. */
const decodeValue = (key: MachineSharedSettingKey, value: unknown) =>
  Schema.decodeEffect(valueCodec(key))({ [key]: value }).pipe(
    Effect.filterOrFail(
      (patch) => Object.hasOwn(patch, key) && patch[key] !== undefined,
      () =>
        new SharedSettingsError({
          operation: "decode",
          cause: new Error(`The value for ${key} is missing.`),
        }),
    ),
  );

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface VersionRow {
  readonly settingKey: string;
  readonly valueJson: string;
  readonly updatedAt: string;
  readonly origin: string;
  readonly pending: number;
}

/** The shared keys a write sets. A server that still reads the legacy flag sets the same mode. */
function sharedKeysInPatch(patch: ServerSettingsPatch): ReadonlyArray<MachineSharedSettingKey> {
  return MACHINE_SHARED_SETTING_KEYS.filter(
    (key) =>
      patch[key] !== undefined ||
      (key === "idleCompaction" && patch.compactIdleThreads !== undefined),
  );
}

/** Whether a model selection names an instance this machine has, so applying it cannot dangle. */
function namesMissingInstance(
  key: MachineSharedSettingKey,
  patch: Record<string, unknown>,
  instances: ReadonlySet<string>,
): boolean {
  if (!MODEL_SELECTION_KEYS.has(key)) return false;
  const selection = patch[key];
  if (typeof selection !== "object" || selection === null) return false;
  const instanceId = (selection as { readonly instanceId?: unknown }).instanceId;
  return typeof instanceId === "string" && !instances.has(instanceId);
}

/**
 * The versions of the settings this machine shares with the user's other machines, and the rules
 * for taking a newer one from a peer. Every change to a version happens under the settings write
 * lock, so a version never disagrees with the value a write left in settings.json.
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
     * A settings write. With a `share` stamp on a machine that follows shared settings, the write
     * becomes the shared version of the keys it sets. Any other write to a shared key is a local
     * override: it records nothing, and a version that was waiting to apply here is dropped.
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
    /** Takes what a peer knows that is newer than this machine's versions. */
    readonly applyPulled: (
      peer: EnvironmentId,
      versions: ReadonlyArray<SharedSettingVersion>,
    ) => Effect.Effect<void>;
    /** Applies versions that waited for a provider instance this machine did not have. */
    readonly retryPending: Effect.Effect<void>;
  }
>()("t3/sharedSettings/SharedSettings") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;

  const storeError = (operation: string) => (cause: unknown) =>
    new SharedSettingsError({ operation, cause });

  const readRows = sql<VersionRow>`
    SELECT
      setting_key AS "settingKey",
      value_json AS "valueJson",
      updated_at AS "updatedAt",
      origin,
      pending
    FROM shared_setting_versions
  `.pipe(Effect.mapError(storeError("read")));

  // One row per shared key, so a lookup reads the whole small table rather than repeat the query.
  const readRow = (key: MachineSharedSettingKey) =>
    readRows.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows.find((row) => row.settingKey === key))),
    );

  const putRow = (
    key: MachineSharedSettingKey,
    valueJson: string,
    stamp: SharedSettingStamp,
    pending: boolean,
  ) =>
    sql`
      INSERT INTO shared_setting_versions (setting_key, value_json, updated_at, origin, pending)
      VALUES (${key}, ${valueJson}, ${stamp.updatedAt}, ${stamp.origin}, ${pending ? 1 : 0})
      ON CONFLICT (setting_key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at,
        origin = excluded.origin,
        pending = excluded.pending
    `.pipe(Effect.asVoid, Effect.mapError(storeError("write")));

  const clearPending = (keys: ReadonlyArray<MachineSharedSettingKey>) =>
    Effect.forEach(
      keys,
      (key) =>
        sql`UPDATE shared_setting_versions SET pending = 0 WHERE setting_key = ${key}`.pipe(
          Effect.mapError(storeError("write")),
        ),
      { discard: true },
    );

  const clampStamp = Effect.fn("SharedSettings.clampStamp")(function* (stamp: SharedSettingStamp) {
    const now = yield* DateTime.now;
    const latest = DateTime.formatIso(DateTime.add(now, { milliseconds: MAX_CLOCK_SKEW_MS }));
    return stamp.updatedAt > latest ? { ...stamp, updatedAt: DateTime.formatIso(now) } : stamp;
  });

  const stampOf = (row: VersionRow): SharedSettingStamp => ({
    updatedAt: row.updatedAt,
    origin: row.origin as EnvironmentId,
  });

  const knownStamp = (key: MachineSharedSettingKey) =>
    readRow(key).pipe(Effect.map(Option.map(stampOf)), Effect.map(Option.getOrUndefined));

  // The settings are already stored when these run, so a failure here is logged, not returned.
  const recordShared = Effect.fn("SharedSettings.recordShared")(function* (
    keys: ReadonlyArray<MachineSharedSettingKey>,
    stored: ServerSettings,
    share: SharedSettingStamp,
  ) {
    const stamp = yield* clampStamp(share);
    yield* Effect.forEach(
      keys,
      (key) =>
        Effect.gen(function* () {
          if (!isNewerSharedSetting(stamp, yield* knownStamp(key))) return;
          const valueJson = yield* encodeValue(key, stored[key]).pipe(
            Effect.mapError(storeError("encode")),
          );
          yield* putRow(key, valueJson, stamp, false);
        }),
      { discard: true },
    );
  });

  const afterWrite = (patch: ServerSettingsPatch, share: SharedSettingStamp | undefined) =>
    Effect.fn("SharedSettings.afterWrite")(function* (stored: ServerSettings) {
      const keys = sharedKeysInPatch(patch);
      if (keys.length === 0) return;
      yield* (
        share !== undefined && stored.followSharedSettings
          ? recordShared(keys, stored, share)
          : clearPending(keys)
      ).pipe(
        Effect.catch((error: SharedSettingsError) =>
          Effect.logError("Could not record a settings change for the user's other machines", {
            keys,
            cause: error,
          }),
        ),
      );
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

  /**
   * Stores one version, applying its value first unless it names a provider instance this machine
   * lacks. The guard runs under the write lock, so a change saved here a moment ago is not undone.
   */
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
    const stamp = yield* clampStamp({ updatedAt: version.updatedAt, origin: version.origin });
    if (!isNewerSharedSetting(stamp, yield* knownStamp(key))) return;
    const patch = yield* decodeValue(key, version.value);
    const valueJson = yield* encodeValue(key, patch[key]).pipe(
      Effect.mapError(storeError("encode")),
    );
    if (namesMissingInstance(key, patch, instances)) {
      // Waits for the instance. The write lock keeps a newer change saved here from being replaced.
      return yield* settings.withSettingsSnapshot(() =>
        knownStamp(key).pipe(
          Effect.flatMap((known) =>
            isNewerSharedSetting(stamp, known) ? putRow(key, valueJson, stamp, true) : Effect.void,
          ),
        ),
      );
    }
    yield* settings.updateSettings(patch as ServerSettingsPatch, {
      when: knownStamp(key).pipe(
        Effect.map((known) => isNewerSharedSetting(stamp, known)),
        Effect.orElseSucceed(() => false),
      ),
      persisted: () => recordTaken(key, putRow(key, valueJson, stamp, false)),
    });
  });

  const applyPulled: SharedSettings["Service"]["applyPulled"] = Effect.fn(
    "SharedSettings.applyPulled",
  )(
    function* (peer, versions) {
      const current = yield* settings.getSettings;
      if (!current.followSharedSettings) return;
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

  const retryPending: SharedSettings["Service"]["retryPending"] = Effect.gen(function* () {
    const rows = (yield* readRows).filter((row) => row.pending === 1);
    if (rows.length === 0) return;
    const instances = yield* knownInstances;
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          if (!isMachineSharedSettingKey(row.settingKey)) return;
          const key = row.settingKey;
          const stamp = stampOf(row);
          const value = parseJson(row.valueJson);
          if (Option.isNone(value)) return;
          const patch = yield* decodeValue(key, value.value);
          if (namesMissingInstance(key, patch, instances)) return;
          yield* settings.updateSettings(patch as ServerSettingsPatch, {
            when: readRow(key).pipe(
              Effect.map(
                (latest) =>
                  Option.isSome(latest) &&
                  latest.value.pending === 1 &&
                  latest.value.updatedAt === stamp.updatedAt &&
                  latest.value.origin === stamp.origin,
              ),
              Effect.orElseSucceed(() => false),
            ),
            persisted: () => recordTaken(key, clearPending([key])),
          });
        }).pipe(
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
  );

  const servedVersions = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.mapError(storeError("read-settings")));
    if (!current.followSharedSettings) return [];
    const rows = yield* readRows;
    return rows.flatMap((row): SharedSettingVersion[] => {
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
    update: Effect.fn("SharedSettings.update")((patch, share) =>
      settings.updateSettings(patch, { persisted: afterWrite(patch, share) }),
    ),
    updateProviderInstance: Effect.fn("SharedSettings.updateProviderInstance")(
      (mutation, patch, share) =>
        settings.updateProviderInstance(mutation, patch, { persisted: afterWrite(patch, share) }),
    ),
    applyPulled,
    retryPending,
  });
});

export const layer = Layer.effect(SharedSettings, make);
