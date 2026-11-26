import { t } from "~/i18n";
import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  globalIdleCompaction,
  idleCompactionPatch,
  isNullableProjectSettingsOverride,
  readsIdleCompactionModes,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  ServerSettings,
  type T3ProjectFile,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  persistSharedSettingsWrites,
  plainSettingsWrites,
  planSharedSettingsWrites,
  type SharedSettingsGroupMember,
  type SharedSettingsMachine,
  type SettingsWriteResult,
  type SharedSettingsPersist,
  type SharedSettingsPlan,
  type SharedSettingsWriteOutcome,
} from "@t3tools/client-runtime/state/shared-settings";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
  resolveWorktreeCleanup,
  type ProjectSettingSource,
} from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Equal from "effect/Equal";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: SharedSettingsMachine["serverConfig"];
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));
const PROJECT_SCOPED_KEYS = new Set<string>(PROJECT_SCOPED_SERVER_SETTING_KEYS);

export function isProjectScopedSettingKey(key: string): key is ProjectScopedServerSettingKey {
  return PROJECT_SCOPED_KEYS.has(key);
}

/** Whether a project or checkout scope can store this key: client-side, or a per-project server override. */
export function isStorableInProjectScope(key: string): boolean {
  return isProjectScopedSettingKey(key) || (CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isConnectedWithConfig(
  environment: Pick<ScopedSettingsEnvironment, "connection" | "serverConfig">,
) {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/**
 * A server save shown before its environment pushes the new settings back. It applies while in
 * flight, and after success only until that environment's settings change from `settledOver`.
 */
export interface PendingScopedWrite {
  readonly save: object;
  readonly environmentId: EnvironmentId;
  readonly patch: ServerSettingsPatch;
  readonly settledOver?: ServerSettings;
}

export const pendingScopedWritesAtom = Atom.make<readonly PendingScopedWrite[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-settings:pending-scoped-writes"),
);

const pendingWriteApplies = (write: PendingScopedWrite, settings: ServerSettings | undefined) =>
  settings !== undefined && (write.settledOver === undefined || write.settledOver === settings);

/** Settles one environment's write: a failure or an already-pushed result drops it. */
export function settlePendingScopedWrites(
  writes: readonly PendingScopedWrite[],
  target: Pick<PendingScopedWrite, "save" | "environmentId">,
  readSettings: (environmentId: EnvironmentId) => ServerSettings | undefined,
  saved?: ServerSettings,
): readonly PendingScopedWrite[] {
  return writes.flatMap((write) => {
    const current = readSettings(write.environmentId);
    if (write.save !== target.save || write.environmentId !== target.environmentId) {
      return pendingWriteApplies(write, current) ? [write] : [];
    }
    if (saved === undefined || current === undefined || Equal.equals(current, saved)) return [];
    return [{ ...write, settledOver: current }];
  });
}

export function applyPendingScopedWrites<T extends ScopedSettingsEnvironment>(
  environments: readonly T[],
  writes: readonly PendingScopedWrite[],
): readonly T[] {
  if (writes.length === 0) return environments;
  return environments.map((environment) => {
    const config = environment.serverConfig;
    if (config === null) return environment;
    const settings = writes.reduce(
      (current, write) =>
        write.environmentId === environment.environmentId &&
        pendingWriteApplies(write, config.settings)
          ? applyServerSettingsPatch(current, write.patch)
          : current,
      config.settings,
    );
    if (settings === config.settings) return environment;
    // Legacy servers read `compactIdleThreads`, so project the mode back onto it.
    const { idleCompaction: _mode, ...legacy } = settings;
    const projected =
      config.settings.idleCompaction === undefined
        ? { ...legacy, ...idleCompactionPatch(config.settings, globalIdleCompaction(settings)) }
        : settings;
    return { ...environment, serverConfig: { ...config, settings: projected } };
  });
}

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(isConnectedWithConfig);
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<ProjectScopedServerSettingKey, ProjectSettingSource>>;
}

export function resolveScopedSettingsTargets(
  scope: ResolvedSettingsScope,
  connectedEnvironments: readonly ScopedSettingsEnvironment[],
  // A member absent here has no file tier yet; null is a missing or invalid file.
  projectFiles?: ReadonlyMap<string, T3ProjectFile | null>,
): readonly ScopedSettingsTarget[] {
  const byId = new Map(
    connectedEnvironments.map((environment) => [environment.environmentId, environment]),
  );
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.flatMap((member) => {
      const environment = byId.get(member.environmentId);
      if (!environment?.serverConfig) return [];
      const projectFile = projectFiles?.get(member.physicalProjectKey);
      const resolved =
        projectFile === undefined
          ? resolveProjectSettings(environment.serverConfig.settings, member.id)
          : resolveProjectSettings(environment.serverConfig.settings, member.id, null, projectFile);
      return [
        {
          environmentId: member.environmentId,
          label: environment.label,
          projectId: member.id,
          settings: resolved.settings,
          sources: resolved.sources,
        },
      ];
    });
  }
  return connectedEnvironments.flatMap((environment) =>
    environment.serverConfig
      ? [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            projectId: null,
            settings: environment.serverConfig.settings,
            sources: resolveProjectSettings(environment.serverConfig.settings, null).sources,
          },
        ]
      : [],
  );
}

export function scopedSettingsAreMixed(
  targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const first = targets[0];
  return (
    first !== undefined &&
    targets.some((candidate) =>
      keys.some((key) => !Equal.equals(first.settings[key], candidate.settings[key])),
    )
  );
}

/**
 * Servers store the idle compaction mode differently by version, so selected
 * environments are compared by the mode each resolves to, and "Never" is offered
 * only when every one of them can store it.
 */
export function scopedIdleCompaction(targets: readonly Pick<ScopedSettingsTarget, "settings">[]) {
  const modes = targets.map((candidate) => globalIdleCompaction(candidate.settings));
  return {
    mixed: modes.some((mode) => mode !== modes[0]),
    neverAvailable: targets.every((candidate) => readsIdleCompactionModes(candidate.settings)),
  };
}

export type ScopedSettingSource = ProjectSettingSource | "mixed";

export function scopedSettingsSource(
  targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0 || targets.length === 0) return "environment";
  const sources = new Set(targets.flatMap((target) => scoped.map((key) => target.sources[key])));
  return sources.size > 1
    ? "mixed"
    : sources.has("project")
      ? "project"
      : sources.has("t3.json")
        ? "t3.json"
        : "environment";
}

interface ScopedServerWrite {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly patch: ServerSettingsPatch;
  readonly previous: ServerSettings;
}

function projectOverrideWrites(
  scope: Extract<ResolvedSettingsScope, { kind: "project" | "checkout" }>,
  environments: readonly ScopedSettingsEnvironment[],
  update: (
    current: ProjectSettingsOverrides,
    settings: ServerSettings,
    projectId: ProjectId,
  ) => ProjectSettingsOverrides | null,
): ScopedServerWrite[] {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const member of scope.members) {
    const environment = byId.get(member.environmentId);
    if (!environment?.serverConfig || environment.connection.phase !== "connected") {
      continue;
    }
    const settings = environment.serverConfig.settings;
    const entry = update(settings.projectSettingsOverrides[member.id] ?? {}, settings, member.id);
    const existing = writes.get(member.environmentId);
    writes.set(member.environmentId, {
      environmentId: member.environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [member.id]: entry,
        },
      },
    });
  }
  return [...writes.values()];
}

/** Puts an idle compaction mode in the form each destination server reads. */
function forDestination(previous: ServerSettings, patch: ServerSettingsPatch): ServerSettingsPatch {
  if (patch.idleCompaction === undefined) return patch;
  const { idleCompaction, compactIdleThreads: _legacy, ...rest } = patch;
  return { ...rest, ...idleCompactionPatch(previous, idleCompaction) };
}

/** The patch one machine gets: worktree cleanup rules edited through storage keys follow it. */
function machinePatch(previous: ServerSettings, serverPatch: ServerSettingsPatch) {
  return forDestination(
    previous,
    previous.worktreeCleanup != null &&
      serverPatch.storageCleanup &&
      Object.keys(serverPatch.storageCleanup).some((key) => key.startsWith("worktree"))
      ? {
          ...serverPatch,
          worktreeCleanup: {
            mode: "custom",
            rules: {
              ...resolveWorktreeCleanup(previous, null),
              ...Object.fromEntries(
                Object.entries(serverPatch.storageCleanup).filter(([key]) =>
                  key.startsWith("worktree"),
                ),
              ),
            },
          },
        }
      : serverPatch,
  );
}

export interface ScopedSettingsPlan {
  readonly clientPatch: ClientSettingsPatch;
  readonly hasClientWrite: boolean;
  readonly serverWrites: ScopedServerWrite[];
  readonly unavailableReason: string | null;
  /** Set when the write is saved for all machines that follow shared settings. */
  readonly share: SharedSettingsPlan<ScopedServerWrite>["share"];
  /** Machines that are offline now and follow shared settings, so they take the write when back. */
  readonly offlineFollowers: readonly string[];
  /** For a shared write, every connected machine that follows shared settings and what it held. */
  readonly sharedGroup: readonly SharedSettingsGroupMember[];
}

const NOT_SHARED = { share: null, offlineFollowers: [], sharedGroup: [] } as const;

/**
 * An "All environments" write of a shared setting is saved for the machines that follow shared
 * settings, never on the ones that do not, once any machine is known to follow, connected now or
 * not. `sharedPatch` is the change as the machine that saves it first holds it.
 */
function shareWrites(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  origin: EnvironmentId | null,
  writes: ScopedServerWrite[],
  sharedPatch: (authority: ServerSettings) => ServerSettingsPatch,
): Pick<ScopedSettingsPlan, "serverWrites" | "share" | "offlineFollowers" | "sharedGroup"> & {
  readonly noFollowerConnected: boolean;
} {
  if (scope.kind !== "all") {
    return {
      serverWrites: [...plainSettingsWrites(writes, environments).writes],
      ...NOT_SHARED,
      noFollowerConnected: false,
    };
  }
  const planned = planSharedSettingsWrites({
    machines: selectScopedSettingsEnvironments(scope, environments, null).environments,
    writes,
    origin,
    sharedPatch,
    writeFor: (machine) => ({ ...machine, patch: {} }),
  });
  return {
    serverWrites: [...planned.writes],
    share: planned.share,
    offlineFollowers: planned.offlineFollowers,
    sharedGroup: planned.sharedGroup,
    noFollowerConnected: planned.noFollowerConnected,
  };
}

/** Why nothing was saved when the change sets a shared setting no connected follower can take. */
const noFollowerConnectedReason = () =>
  t("Connect a machine that follows shared settings to save this for all machines.");

export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
  options?: {
    /** The machine a change for all machines is attributed to. */
    readonly origin?: EnvironmentId | null;
    /** A device-only page stores client settings even inside a project scope. */
    readonly deviceOnly?: boolean;
  },
): ScopedSettingsPlan {
  const origin = options?.origin ?? null;
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const refusesClientKeys = isProjectScope && options?.deviceOnly !== true;
  const clientKeys = Object.keys(patch).filter(
    (key) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key),
  );
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const serverKeys = Object.keys(serverPatch);
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  // Client settings are stored per device, so a project has nowhere to keep an override.
  const unscopableKeys = isProjectScope
    ? [
        ...(refusesClientKeys ? clientKeys : []),
        ...serverKeys.filter((key) => !isProjectScopedSettingKey(key)),
      ]
    : [];
  const clientPatch = Object.fromEntries(
    refusesClientKeys ? [] : Object.entries(patch).filter(([key]) => clientKeys.includes(key)),
  ) as ClientSettingsPatch;
  const serverWrites: ScopedServerWrite[] =
    serverKeys.length === 0
      ? []
      : isProjectScope
        ? unscopableKeys.length > 0
          ? []
          : projectOverrideWrites(scope, environments, (current, settings, projectId) => {
              // Override entries store whole objects; complete partial patches from each target's effective
              // value.
              const effective = resolveProjectSettings(settings, projectId).settings;
              const next: Record<string, unknown> = { ...current };
              for (const [key, value] of Object.entries<unknown>(serverPatch)) {
                if (key === "worktreeCleanup" && serverPatch.worktreeCleanup?.mode === "custom") {
                  next[key] = {
                    mode: "custom",
                    rules: {
                      ...resolveWorktreeCleanup(settings, projectId),
                      ...serverPatch.worktreeCleanup.rules,
                    },
                  };
                  continue;
                }
                // Inherit sends null; remove overrides whose keys cannot store null.
                if (
                  value === null &&
                  !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
                ) {
                  delete next[key];
                  continue;
                }
                const base: unknown = effective[key as keyof ServerSettings];
                // A new model must not inherit the previous model's options.
                if (
                  isPlainObject(value) &&
                  isPlainObject(base) &&
                  (key === "defaultModelSelection" ||
                    key === "sourceControlWriterModelSelection" ||
                    key === "reviewGuideModelSelection" ||
                    key === "textGenerationModelSelection") &&
                  (value.instanceId !== undefined || value.model !== undefined)
                ) {
                  next[key] = { instanceId: base.instanceId, model: base.model, ...value };
                  continue;
                }
                next[key] =
                  isPlainObject(value) && isPlainObject(base) ? { ...base, ...value } : value;
              }
              return next as ProjectSettingsOverrides;
            })
        : scope.kind === "all" || scope.kind === "environment"
          ? connectedEnvironments.flatMap((environment) => {
              const previous = environment.serverConfig?.settings;
              if (!previous) return [];
              return [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  previous,
                  patch: machinePatch(previous, serverPatch),
                },
              ];
            })
          : [];
  const { noFollowerConnected, ...sharing } = shareWrites(
    scope,
    environments,
    origin,
    serverWrites,
    (base) => machinePatch(base, serverPatch),
  );
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || sharing.serverWrites.length > 0;
  const unavailableReason = noFollowerConnected
    ? noFollowerConnectedReason()
    : hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : unscopableKeys.length > 0
          ? t("This setting is environment-wide and cannot be overridden by a project.")
          : isProjectScope
            ? t(
                "Connect the selected checkouts, or update their environments, to save a project override.",
              )
            : scope.kind === "environment"
              ? t("Connect {environment} to save this setting.", { environment: scope.label })
              : t("Connect an environment to save this setting.");
  return { clientPatch, hasClientWrite, unavailableReason, ...sharing };
}

function clientOnlyPatch(patch: ScopedSettingsPatch): ClientSettingsPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => CLIENT_KEYS.has(key) && !SERVER_KEYS.has(key)),
  ) as ClientSettingsPatch;
}

/**
 * Writes each machine its own patch, for writes such as a reset whose values depend on what each
 * machine has. Client keys are this device's, so they are written once; a null key carries only them.
 */
export function planPerEnvironmentSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patches: ReadonlyMap<EnvironmentId | null, ScopedSettingsPatch>,
  origin: EnvironmentId | null = null,
): ScopedSettingsPlan {
  const clientPatch = Object.assign(
    {},
    ...[...patches.values()].map(clientOnlyPatch),
  ) as ClientSettingsPatch;
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const serverWrites: ScopedServerWrite[] =
    scope.kind === "all" || scope.kind === "environment"
      ? connectedEnvironments.flatMap((environment) => {
          const previous = environment.serverConfig?.settings;
          const patch = patches.get(environment.environmentId);
          if (!previous || !patch) return [];
          const serverPatch = Object.fromEntries(
            Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
          ) as ServerSettingsPatch;
          if (Object.keys(serverPatch).length === 0) return [];
          return [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              previous,
              patch: forDestination(previous, serverPatch),
            },
          ];
        })
      : [];
  // Each machine's values come from its own state, but a key one machine resets is reset to the
  // same value on the rest, so the reset is still one shared change with one value.
  const { noFollowerConnected, ...sharing } = shareWrites(
    scope,
    environments,
    origin,
    serverWrites,
    () => Object.assign({}, ...serverWrites.map(({ patch }) => patch)),
  );
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  return {
    clientPatch,
    hasClientWrite,
    unavailableReason: noFollowerConnected
      ? noFollowerConnectedReason()
      : hasClientWrite ||
          sharing.serverWrites.length > 0 ||
          [...patches.values()].every(isEmptyPatch)
        ? null
        : t("Connect an environment to save this setting."),
    ...sharing,
  };
}

function isEmptyPatch(patch: ScopedSettingsPatch) {
  return Object.keys(patch).length === 0;
}

/** What a machine held for a key; servers keep the idle compaction mode in different fields. */
function heldValue(settings: ServerSettings, key: string): unknown {
  return key === "idleCompaction" || key === "compactIdleThreads"
    ? globalIdleCompaction(settings)
    : settings[key as keyof ServerSettings];
}

/**
 * Writes back each machine's values from before `plan`, for exactly the keys it changed, which for a
 * machine that follows shared settings includes the shared ones. The undo is a shared change too only
 * when every follower held one value for each shared key; otherwise each machine gets its own value
 * back and offline machines keep what `plan` shared.
 */
export function planScopedSettingsUndo(
  plan: ScopedSettingsPlan,
  previousClient: Partial<Record<string, unknown>>,
  environments: readonly ScopedSettingsEnvironment[] = [],
): ScopedSettingsPlan {
  const clientPatch = Object.fromEntries(
    Object.keys(plan.clientPatch).map((key) => [key, previousClient[key]]),
  ) as ClientSettingsPatch;
  const sharedKeys = plan.share?.keys ?? [];
  const followers = new Set(plan.sharedGroup.map(({ environmentId }) => environmentId));
  const [first, ...rest] = plan.sharedGroup;
  const sameEverywhere =
    first !== undefined &&
    rest.every((member) =>
      sharedKeys.every((key) =>
        Equal.equals(heldValue(member.previous, key), heldValue(first.previous, key)),
      ),
    );
  const share = plan.share !== null && sameEverywhere ? plan.share : null;
  const serverWrites = plan.serverWrites.map((write) => {
    const keys = [
      ...Object.keys(write.patch),
      // Followers took the shared keys from the stamp; under a server's shared undo, only the first
      // saves them, and under a client's every follower carries them.
      ...(followers.has(write.environmentId) &&
      (share === null || share.stampedBy === "client" || write.environmentId === share.authority)
        ? sharedKeys
        : []),
    ];
    return {
      ...write,
      patch: Object.fromEntries(
        [...new Set(keys)].map((key) => {
          const value = write.patch[key as keyof ServerSettingsPatch];
          return [
            key,
            key === "projectSettingsOverrides" && isPlainObject(value)
              ? Object.fromEntries(
                  Object.keys(value).map((projectId) => [
                    projectId,
                    write.previous.projectSettingsOverrides[projectId as ProjectId] ?? null,
                  ]),
                )
              : heldValue(write.previous, key),
          ];
        }),
      ) as ServerSettingsPatch,
    };
  });
  return {
    clientPatch,
    hasClientWrite: plan.hasClientWrite,
    serverWrites: [...plainSettingsWrites(serverWrites, environments).writes],
    unavailableReason: null,
    share,
    offlineFollowers: share === null ? [] : plan.offlineFollowers,
    sharedGroup: share === null ? [] : plan.sharedGroup,
  };
}

export function planScopedSettingsClear(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const serverWrites =
    scope.kind === "project" || scope.kind === "checkout"
      ? projectOverrideWrites(scope, environments, (_current, settings, projectId) =>
          clearProjectSettingsOverrides(settings, projectId, keys),
        )
      : [];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites: [...plainSettingsWrites(serverWrites, environments).writes],
    unavailableReason:
      serverWrites.length > 0
        ? null
        : t(
            "Connect the selected checkouts, or update their environments, to reset this override.",
          ),
    ...NOT_SHARED,
  };
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function listProjectOverrides(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  const scoped = keys.filter(isProjectScopedSettingKey);
  if (scoped.length === 0) return [];
  return environments.flatMap((environment) => {
    const overrides = environment.serverConfig?.settings.projectSettingsOverrides;
    if (!overrides) return [];
    return Object.entries(overrides).flatMap(([projectId, entry]) =>
      scoped.some((key) => Object.hasOwn(entry, key))
        ? [{ environmentId: environment.environmentId, projectId: projectId as ProjectId }]
        : [],
    );
  });
}

export function planProjectOverridesClear(
  environments: readonly ScopedSettingsEnvironment[],
  entries: readonly ProjectOverrideEntry[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  const writes = new Map<EnvironmentId, ScopedServerWrite>();
  for (const { environmentId, projectId } of entries) {
    const environment = byId.get(environmentId);
    if (!environment?.serverConfig || environment.connection.phase !== "connected") continue;
    const settings = environment.serverConfig.settings;
    const existing = writes.get(environmentId);
    writes.set(environmentId, {
      environmentId,
      label: environment.label,
      previous: settings,
      patch: {
        projectSettingsOverrides: {
          ...existing?.patch.projectSettingsOverrides,
          [projectId]: clearProjectSettingsOverrides(settings, projectId, keys),
        },
      },
    });
  }
  const serverWrites = [...writes.values()];
  return {
    clientPatch: {} as ClientSettingsPatch,
    hasClientWrite: false,
    serverWrites: [...plainSettingsWrites(serverWrites, environments).writes],
    unavailableReason:
      serverWrites.length > 0 ? null : t("Connect the environments to reset these overrides."),
    ...NOT_SHARED,
  };
}

function writeWasDropped(value: unknown, before: unknown, saved: unknown): boolean {
  if (value === null) return before != null && Equal.equals(saved, before);
  if (isPlainObject(value) && !Array.isArray(before) && !Array.isArray(saved)) {
    const field = (source: unknown, key: string) =>
      isPlainObject(source) ? source[key] : undefined;
    return Object.entries(value).some(([key, next]) =>
      writeWasDropped(next, field(before, key), field(saved, key)),
    );
  }
  const unchanged =
    typeof value === "string" && typeof before === "string"
      ? value.trim() === before
      : Equal.equals(value, before);
  return !unchanged && Equal.equals(saved, before);
}

/** Older servers silently drop unknown keys; report them so rows cannot stay mixed forever. */
function droppedSettingKeys(write: ScopedServerWrite, saved: ServerSettings) {
  return Object.entries(write.patch).flatMap(([key, value]) =>
    writeWasDropped(
      value,
      write.previous[key as keyof ServerSettings],
      saved[key as keyof ServerSettings],
    )
      ? [key]
      : [],
  );
}

export type SavedScopedServerWrite = ScopedServerWrite & { readonly settings: ServerSettings };

/**
 * What to tell the user after a write saved for all machines: where it landed, and which offline
 * machines will catch up. Null unless a machine that follows shared settings stored it, since only
 * such a machine passes the change on to the ones that were offline.
 */
export function sharedSaveSummary(
  saved: readonly SavedScopedServerWrite[],
  plan: Pick<ScopedSettingsPlan, "offlineFollowers">,
): { readonly reached: string[]; readonly catchingUp: readonly string[] } | null {
  return saved.some(({ settings }) => settings.followSharedSettings)
    ? { reached: saved.map(({ label }) => label), catchingUp: plan.offlineFollowers }
    : null;
}

export async function persistScopedSettingsPatch(
  plan: ScopedSettingsPlan,
  persist: SharedSettingsPersist,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  return persistScopedSettingsPlan(
    plan,
    (writes) =>
      persistSharedSettingsWrites(
        { writes, share: plan.share, sharedGroup: plan.sharedGroup },
        persist,
      ),
    persistClient,
  );
}

const OWN_ECHO_LIMIT = 8;

/**
 * Project overrides are whole entries built from this client's copy of the settings, which hears
 * of a save only when the server pushes it back. So saves to one environment run one at a time,
 * each planned from the newest settings held: the previous save's response, unless a newer copy
 * arrived. A change for all machines carries absolute values, so it goes out as planned.
 */
export function createScopedSettingsWriter(
  readSettings: (environmentId: EnvironmentId) => ServerSettings | null,
) {
  const queues = new Map<EnvironmentId, Promise<unknown>>();
  const responses = new Map<
    EnvironmentId,
    {
      readonly settings: ServerSettings;
      readonly copy: ServerSettings;
      readonly saved: readonly ServerSettings[];
    }
  >();
  return (
    environments: readonly ScopedSettingsEnvironment[],
    plan: (environments: readonly ScopedSettingsEnvironment[]) => ScopedSettingsPlan,
    persist: SharedSettingsPersist,
    persistClient: (patch: ClientSettingsPatch) => void,
  ) => {
    const planned = plan(environments);
    return persistScopedSettingsPlan(
      planned,
      (writes) => {
        if (planned.share !== null) {
          return persistSharedSettingsWrites(
            { writes, share: planned.share, sharedGroup: planned.sharedGroup },
            persist,
          );
        }
        return Promise.all(
          writes.map((initial) => {
            const { environmentId } = initial;
            const save = (queues.get(environmentId) ?? Promise.resolve()).then(
              async (): Promise<SharedSettingsWriteOutcome<ScopedServerWrite>> => {
                const copy = readSettings(environmentId);
                const response = responses.get(environmentId);
                // A copy equal to one of our earlier responses is a delayed echo, older than the latest.
                const isOwnEcho = (settings: ServerSettings) =>
                  response?.saved.some((saved) => Equal.equals(saved, settings)) === true;
                const continues =
                  copy !== null &&
                  response !== undefined &&
                  (response.copy === copy || isOwnEcho(copy));
                const settings = continues ? response.settings : copy;
                const replanned =
                  settings === null
                    ? null
                    : plan(withSettings(environments, environmentId, settings));
                const write =
                  replanned?.serverWrites.find((next) => next.environmentId === environmentId) ??
                  initial;
                const result = await persist
                  .update({ environmentId, input: { patch: write.patch } })
                  .catch((error: unknown): SettingsWriteResult<ServerSettings> => ({
                    _tag: "Failure",
                    cause: Cause.die(error),
                  }));
                const savedCopy = readSettings(environmentId);
                if (result._tag === "Success" && savedCopy !== null) {
                  // A changed copy may be a newer remote push or the delayed echo of our previous save.
                  if (
                    savedCopy === copy ||
                    Equal.equals(savedCopy, settings) ||
                    Equal.equals(savedCopy, result.value) ||
                    isOwnEcho(savedCopy)
                  ) {
                    responses.set(environmentId, {
                      settings: result.value,
                      copy: savedCopy,
                      saved: [...(continues ? response.saved : []), result.value].slice(
                        -OWN_ECHO_LIMIT,
                      ),
                    });
                  } else {
                    responses.delete(environmentId);
                  }
                }
                return { write, sent: write.patch, result };
              },
            );
            queues.set(
              environmentId,
              save.catch(() => undefined),
            );
            return save;
          }),
        );
      },
      persistClient,
    );
  };
}

function withSettings(
  environments: readonly ScopedSettingsEnvironment[],
  environmentId: EnvironmentId,
  settings: ServerSettings,
) {
  return environments.map((environment) =>
    environment.environmentId === environmentId && environment.serverConfig
      ? { ...environment, serverConfig: { ...environment.serverConfig, settings } }
      : environment,
  );
}

async function persistScopedSettingsPlan(
  plan: ScopedSettingsPlan,
  persistWrites: (
    writes: readonly ScopedServerWrite[],
  ) => Promise<ReadonlyArray<SharedSettingsWriteOutcome<ScopedServerWrite>>>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const outcomes = await persistWrites(plan.serverWrites);
  // Compared with what each machine was asked to hold, so a value it kept instead is reported.
  const savedSettings = ({ write, sent, result }: (typeof outcomes)[number]) =>
    result._tag === "Success" &&
    droppedSettingKeys({ ...write, patch: sent }, result.value).length === 0
      ? result.value
      : null;
  const failedEnvironments = outcomes.flatMap((outcome) => {
    const { write, result } = outcome;
    if (savedSettings(outcome) !== null) return [];
    if (result._tag === "Success") {
      return [
        {
          ...write,
          // A machine that takes shared versions keeps a newer change rather than this one.
          message:
            plan.share !== null && result.value.followSharedSettings
              ? t("It already has a newer change to this setting, so it kept that one.")
              : t("This environment does not support this setting. Update T3.CodeShip on it."),
        },
      ];
    }
    const error = Cause.squash(result.cause);
    return [
      {
        ...write,
        message:
          error instanceof Error
            ? error.message
            : t("The save failed. Try reconnecting and saving again."),
      },
    ];
  });
  const savedEnvironments = outcomes.flatMap((outcome) => {
    const settings = savedSettings(outcome);
    return settings === null ? [] : [{ ...outcome.write, settings }];
  });
  return {
    failedEnvironments,
    savedEnvironments,
    savedEnvironmentCount: savedEnvironments.length,
  };
}
