import {
  type EnvironmentId,
  isBuiltInProviderInstance,
  isManagedSettingPath,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  SHARED_PROVIDER_CONFIG_FIELDS,
  sharedProviderConfig,
  type SharedProviderInstanceValue,
  sharedProviderInstanceValue,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

type ProviderInstances = ServerSettings["providerInstances"];

const isSharedDriver = (driver: string) => Object.hasOwn(SHARED_PROVIDER_CONFIG_FIELDS, driver);

const configRecord = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};

const withoutFields = (record: Record<string, unknown>, fields: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));

/**
 * Whether this machine may take a version of an account rather than only pass it on: never for a
 * driver this build does not share, an instance here that runs another driver under the same id, a
 * built-in instance claimed by another driver or removed, or one an administrator locks or forbids.
 */
export function canTakeSharedProviderInstance(
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
    return !isSharedDriver(instanceId) && (local === undefined || isSharedDriver(local.driver));
  }
  if (!isSharedDriver(value.driver)) return false;
  if (local !== undefined && local.driver !== value.driver) return false;
  if (isSharedDriver(instanceId) && !isBuiltInProviderInstance(instanceId, value.driver)) {
    return false;
  }
  const allowed = policy?.limits?.providers?.allowedDrivers;
  return allowed === undefined || allowed.includes(value.driver);
}

/**
 * The provider instances once an account's version is taken: what the version shares, from it alone,
 * and everything else (its home, binary, launch arguments, environment and sign-in) as this machine
 * had it. An account new here gets no home, so it signs in to its own folder on this machine, as one
 * added here would. A removal drops only the definition; the account's login and folders stay.
 */
export function withSharedProviderInstance(
  instances: ProviderInstances,
  instanceId: ProviderInstanceId,
  value: SharedProviderInstanceValue,
  origin: EnvironmentId,
): ProviderInstances {
  const next: Record<string, ProviderInstanceConfig> = { ...instances };
  const local = Object.hasOwn(instances, instanceId) ? instances[instanceId] : undefined;
  if ("removed" in value) {
    delete next[instanceId];
    return next as ProviderInstances;
  }
  // A built-in instance that matches its defaults needs no settings of its own.
  if (
    local === undefined &&
    Equal.equals(sharedProviderInstanceValue(instanceId, undefined), value)
  ) {
    return instances;
  }
  // The version's `enabled` replaces the legacy flag a config may still carry.
  const localConfig = withoutFields(configRecord(local?.config), ["enabled"]);
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
  const sharedFields = SHARED_PROVIDER_CONFIG_FIELDS[value.driver] ?? [];
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
      ...sharedProviderConfig(value.driver, value.config),
    },
    ...(sharedFrom === undefined ? {} : { sharedFrom }),
  };
  return next as ProviderInstances;
}

/**
 * The accounts a write changed as machines share them, with what each now shares. A change only to
 * what stays on this machine, such as a home or binary path, is none. Removing an instance this
 * build does not share is none either, so it never removes another machine's instance of that id.
 */
export function changedSharedProviderInstances(
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
      instanceId,
      Object.hasOwn(before.providerInstances, id)
        ? before.providerInstances[instanceId]
        : undefined,
    );
    const now = sharedProviderInstanceValue(
      instanceId,
      Object.hasOwn(after.providerInstances, id) ? after.providerInstances[instanceId] : undefined,
    );
    if (now === undefined || Equal.equals(was, now)) return [];
    if ("removed" in now && was === undefined) return [];
    return [[instanceId, now] as const];
  });
}
