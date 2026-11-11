import {
  type EnvironmentId,
  isBuiltInProviderInstance,
  isManagedSettingPath,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type SharedProviderInstanceValue,
} from "@t3tools/contracts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

type ProviderInstances = ServerSettings["providerInstances"];

/**
 * The config fields an account shares, per driver; a new field stays on its machine until listed.
 * Paths, binaries, homes, launch arguments, server addresses, credentials and their metadata never
 * are, nor are local choices such as how an account signs in or which cloud project and region
 * its requests go to.
 */
const SHARED_CONFIG_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["customModels", "autoCompactWindow", "idleCompaction"],
  codex: ["customModels"],
  antigravity: ["customModels"],
  cursor: ["customModels"],
};

/** A driver whose accounts machines share. */
export interface AccountSharingDriver {
  readonly sharedFields: ReadonlyArray<string>;
  /** Its default config as stored, so a field left at its default is not this machine's own. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

/** The drivers whose accounts this build shares: those with `privateAccountHomes`. */
export type AccountSharingDrivers = ReadonlyMap<string, AccountSharingDriver>;

type DriverDescription = Pick<
  AnyProviderDriver,
  "driverKind" | "metadata" | "configSchema" | "defaultConfig"
>;

export const accountSharingDrivers = Effect.fn("sharedProviderInstances.accountSharingDrivers")(
  function* (drivers: ReadonlyArray<DriverDescription>) {
    const sharing = new Map<string, AccountSharingDriver>();
    for (const { driverKind, metadata, configSchema, defaultConfig } of drivers) {
      if (metadata.privateAccountHomes !== true) continue;
      // Once per driver as the service starts; each driver has its own schema.
      const defaults = yield* Schema.encodeUnknownEffect(configSchema)(defaultConfig()).pipe(
        Effect.orDie,
      );
      sharing.set(driverKind, {
        sharedFields: SHARED_CONFIG_FIELDS[driverKind] ?? [],
        defaults: configRecord(defaults),
      });
    }
    return sharing as AccountSharingDrivers;
  },
);

const configRecord = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

const withoutFields = (record: Record<string, unknown>, fields: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));

/** Only the fields of `config` that `driver` shares, from a config of unknown shape. */
function sharedConfig(driver: AccountSharingDriver, config: unknown): Record<string, unknown> {
  const record = configRecord(config);
  return Object.fromEntries(
    driver.sharedFields.flatMap((field) =>
      Object.hasOwn(record, field) && record[field] !== undefined ? [[field, record[field]]] : [],
    ),
  );
}

/**
 * What a machine shares of one provider instance, or nothing for a driver it does not share. A
 * missing built-in instance still runs with its defaults; a missing added account is a removal.
 */
function sharedProviderInstanceValue(
  sharing: AccountSharingDrivers,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig | undefined,
): SharedProviderInstanceValue | undefined {
  if (instance === undefined) {
    if (!sharing.has(instanceId)) return { removed: true };
    const driver = ProviderDriverKind.make(instanceId);
    return { driver, enabled: resolveProviderInstanceEnabled({ driver }) };
  }
  const driver = sharing.get(instance.driver);
  if (driver === undefined) return undefined;
  const named = instance.displayName === undefined ? {} : { displayName: instance.displayName };
  const enabled = resolveProviderInstanceEnabled(instance);
  if (isBuiltInProviderInstance(instanceId, instance.driver)) {
    return { driver: instance.driver, ...named, enabled };
  }
  const config = sharedConfig(driver, instance.config);
  return {
    driver: instance.driver,
    ...named,
    ...(instance.accentColor === undefined ? {} : { accentColor: instance.accentColor }),
    enabled,
    ...(Object.keys(config).length === 0 ? {} : { config }),
  };
}

/**
 * Whether an account holds something only this machine has: environment variables, or a config
 * field it does not share set away from its default, such as a key in the secret store, a home or
 * shadow home, a binary, launch arguments or a local mode.
 */
function holdsLocalState(driver: AccountSharingDriver, instance: ProviderInstanceConfig): boolean {
  if ((instance.environment?.length ?? 0) > 0) return true;
  return Object.entries(configRecord(instance.config)).some(
    ([field, value]) =>
      field !== "enabled" &&
      !driver.sharedFields.includes(field) &&
      value !== undefined &&
      !Equal.equals(value, driver.defaults[field]),
  );
}

/**
 * Whether taking `value` would change a field an administrator locks for its driver here. The
 * settings write would refuse it on every pull, so the version is only passed on.
 */
function changesLockedField(
  driver: AccountSharingDriver,
  local: ProviderInstanceConfig | undefined,
  value: Exclude<SharedProviderInstanceValue, { readonly removed: true }>,
  policy: ManagedPolicySummary | undefined,
): boolean {
  const locked = policy?.limits?.providers?.lockedInstanceFields?.[value.driver] ?? [];
  const localConfig = configRecord(local?.config);
  const taken = configRecord(value.config);
  return driver.sharedFields.some(
    (field) =>
      locked.includes(`config.${field}`) && !Equal.equals(taken[field], localConfig[field]),
  );
}

/**
 * Whether this machine may take a version of an account rather than only pass it on: never for a
 * driver this build does not share, an instance here that runs another driver under the same id, a
 * built-in instance claimed by another driver or removed, or one an administrator locks or forbids.
 */
export function canTakeSharedProviderInstance(
  sharing: AccountSharingDrivers,
  current: ServerSettings,
  instanceId: ProviderInstanceId,
  value: SharedProviderInstanceValue,
  policy: ManagedPolicySummary | undefined,
): boolean {
  if (isManagedSettingPath(policy, `providerInstances.${instanceId}`)) return false;
  const local = Object.hasOwn(current.providerInstances, instanceId)
    ? current.providerInstances[instanceId]
    : undefined;
  if ("removed" in value) {
    return !sharing.has(instanceId) && (local === undefined || sharing.has(local.driver));
  }
  const driver = sharing.get(value.driver);
  if (driver === undefined) return false;
  if (local !== undefined && local.driver !== value.driver) return false;
  if (sharing.has(instanceId) && !isBuiltInProviderInstance(instanceId, value.driver)) {
    return false;
  }
  if (changesLockedField(driver, local, value, policy)) return false;
  const allowed = policy?.limits?.providers?.allowedDrivers;
  return allowed === undefined || allowed.includes(value.driver);
}

/**
 * The provider instances once an account's version is taken: what it shares, and everything else as
 * this machine had it. A new account gets no home, so it signs in to its own folder here. A removal
 * deletes an account only when nothing in it is this machine's own; otherwise it is turned off and
 * kept with its keys, variables and paths. The login and folders stay either way.
 */
export function withSharedProviderInstance(
  sharing: AccountSharingDrivers,
  instances: ProviderInstances,
  instanceId: ProviderInstanceId,
  value: SharedProviderInstanceValue,
  origin: EnvironmentId,
): ProviderInstances {
  const next: Record<string, ProviderInstanceConfig> = { ...instances };
  const local = Object.hasOwn(instances, instanceId) ? instances[instanceId] : undefined;
  if ("removed" in value) {
    if (local === undefined) return instances;
    const driver = sharing.get(local.driver);
    if (driver !== undefined && holdsLocalState(driver, local)) {
      const config = local.config === undefined ? {} : { config: withoutLegacyEnabled(local) };
      next[instanceId] = { ...local, enabled: false, ...config };
    } else {
      delete next[instanceId];
    }
    return next as ProviderInstances;
  }
  // A built-in instance that matches its defaults needs no settings of its own.
  if (
    local === undefined &&
    Equal.equals(sharedProviderInstanceValue(sharing, instanceId, undefined), value)
  ) {
    return instances;
  }
  // The version's `enabled` replaces the legacy flag a config may still carry.
  const localConfig = withoutLegacyEnabled(local);
  const named = value.displayName === undefined ? {} : { displayName: value.displayName };
  if (isBuiltInProviderInstance(instanceId, value.driver)) {
    const {
      displayName: _displayName,
      enabled: _enabled,
      ...kept
    } = local ?? {
      driver: value.driver,
    };
    next[instanceId] = {
      ...kept,
      ...named,
      enabled: value.enabled,
      ...(local?.config === undefined ? {} : { config: localConfig }),
    };
    return next as ProviderInstances;
  }
  const driver = sharing.get(value.driver);
  const sharedFields = driver?.sharedFields ?? [];
  const sharedFrom = local === undefined ? origin : local.sharedFrom;
  next[instanceId] = {
    driver: value.driver,
    ...named,
    ...(value.accentColor === undefined ? {} : { accentColor: value.accentColor }),
    ...(local?.environment === undefined ? {} : { environment: local.environment }),
    enabled: value.enabled,
    // Only the fields this build shares, so a peer cannot set a path, binary or credential here.
    config: {
      ...withoutFields(localConfig, sharedFields),
      ...(driver === undefined ? {} : sharedConfig(driver, value.config)),
    },
    ...(sharedFrom === undefined ? {} : { sharedFrom }),
  };
  return next as ProviderInstances;
}

const withoutLegacyEnabled = (instance: ProviderInstanceConfig | undefined) =>
  withoutFields(configRecord(instance?.config), ["enabled"]);

/**
 * The accounts a write changed as machines share them, with what each now shares. A change only to
 * what stays on this machine, such as a home or binary path, is none. Removing an instance this
 * build does not share is none either, so it never removes another machine's instance of that id.
 */
export function changedSharedProviderInstances(
  sharing: AccountSharingDrivers,
  before: ServerSettings,
  after: ServerSettings,
): ReadonlyArray<readonly [ProviderInstanceId, SharedProviderInstanceValue]> {
  const ids = new Set([
    ...Object.keys(before.providerInstances),
    ...Object.keys(after.providerInstances),
  ]);
  return [...ids].flatMap((id) => {
    const instanceId = ProviderInstanceId.make(id);
    const was = sharedProviderInstanceValue(
      sharing,
      instanceId,
      Object.hasOwn(before.providerInstances, id)
        ? before.providerInstances[instanceId]
        : undefined,
    );
    const now = sharedProviderInstanceValue(
      sharing,
      instanceId,
      Object.hasOwn(after.providerInstances, id) ? after.providerInstances[instanceId] : undefined,
    );
    if (now === undefined || Equal.equals(was, now)) return [];
    if ("removed" in now && was === undefined) return [];
    return [[instanceId, now] as const];
  });
}
