import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { linkPath } from "./ClaudeAccountHome.ts";
import {
  claudeSettingsEnvironment,
  type ClaudeSettingsTier,
  readConfirmedClaudeSettings,
} from "./ClaudeSettingsCascade.ts";

import { claudeAccountConfigPath, readClaudeOauthAccount } from "../claudeResetCredits.ts";

type ClaudeSkillScope = "user" | "project";

type ClaudeSkillRoot = {
  readonly directory: string;
  readonly scope: ClaudeSkillScope;
  readonly prefix?: string;
};

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/** Claude accepts YAML 1.1 booleans that this YAML 1.2 parser leaves as strings or numbers. */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Repair Claude's accepted ': ' scalars without disturbing comments or YAML structure.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

// A caller-supplied environment is a plain object, without Windows' case-insensitive keys.
function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = name.toLowerCase();
  return Object.entries(environment)
    .find(([candidate]) => candidate.toLowerCase() === key)?.[1]
    ?.trim();
}

function claudeManagedDirectory(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode";
  }
  if (platform === "win32") {
    const programFiles = windowsEnvironmentValue(environment, "ProgramFiles");
    return programFiles ? path.join(programFiles, "ClaudeCode") : undefined;
  }
  return "/etc/claude-code";
}

// Untraced: skill discovery resolves every distinct plugin project path, too often for spans.
const findRepositoryRoot = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

const findPluginRepositoryRoot = Effect.fnUntraced(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* findRepositoryRoot(cwd);
  if (root === undefined) return undefined;
  const gitFile = yield* fileSystem
    .readFileString(path.join(root, ".git"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!gitFile.trim().startsWith("gitdir:")) return root;
  const gitDirectory = path.resolve(root, gitFile.trim().slice(7).trim());
  const commonFile = yield* fileSystem
    .readFileString(path.join(gitDirectory, "commondir"))
    .pipe(Effect.orElseSucceed(() => ""));
  const worktreeFile = yield* fileSystem
    .readFileString(path.join(gitDirectory, "gitdir"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!commonFile.trim() || !worktreeFile.trim()) return root;
  const commonDirectory = path.resolve(gitDirectory, commonFile.trim());
  const backlinkPath = yield* fileSystem
    .realPath(path.resolve(gitDirectory, worktreeFile.trim()))
    .pipe(Effect.orElseSucceed(() => undefined));
  const worktreeGitPath = yield* fileSystem
    .realPath(path.join(root, ".git"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (
    path.dirname(gitDirectory) !== path.join(commonDirectory, "worktrees") ||
    backlinkPath === undefined ||
    backlinkPath !== worktreeGitPath
  ) {
    return root;
  }
  // Claude shares plugin install records across linked worktrees, using their common repository.
  return path.basename(commonDirectory) === ".git"
    ? path.dirname(commonDirectory)
    : commonDirectory;
});

/**
 * The CLI validates the whole map, not each entry: verified against it, one
 * entry with an unknown value (or a boolean) makes it drop every override in
 * that file, so this schema does the same rather than applying the valid
 * siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

const decodeSkillSettings = Schema.decodeUnknownOption(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    syncClaudeAiPlugins: Schema.optional(Schema.Unknown),
  }),
);

type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

function readSkillSettings(tiers: ReadonlyArray<ClaudeSettingsTier>) {
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();
  const managedPluginNames = new Set<string>();
  let syncedPluginsHidden = false;
  for (const { source, settings } of tiers) {
    const parsed = Option.getOrUndefined(decodeSkillSettings(settings));
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }
    for (const [key, enabled] of Object.entries(parsed?.enabledPlugins ?? {})) {
      if (typeof enabled === "boolean") {
        enabledPlugins.set(key, enabled);
        if (source === "policy" && key.includes("@")) {
          managedPluginNames.add(pluginNameKey(key.slice(0, key.indexOf("@"))));
        }
      } else {
        // Extended formats replace lower-precedence values without enabling the plugin here.
        enabledPlugins.delete(key);
      }
    }
    // Claude ignores this switch in shared project settings, and honors only false.
    if (parsed?.syncClaudeAiPlugins === false && source !== "project") {
      syncedPluginsHidden = true;
    }
  }

  return {
    skillOverrides: overridesByName,
    enabledPlugins,
    managedPluginNames,
    syncedPluginsHidden,
  };
}

const UserSettingsObject = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));
const decodeUserSettingsObject = Schema.decodeUnknownEffect(UserSettingsObject);
const encodeUserSettingsObject = Schema.encodeEffect(
  fromJsonStringPretty(Schema.Record(Schema.String, Schema.Unknown)),
);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// One read-modify-write at a time per settings file, so two toggles cannot drop each other's override.
const settingsWriteLocks = new Map<string, Semaphore.Semaphore>();
const settingsWriteLock = (settingsPath: string) => {
  const existing = settingsWriteLocks.get(settingsPath);
  if (existing !== undefined) return existing;
  const created = Semaphore.makeUnsafe(1);
  settingsWriteLocks.set(settingsPath, created);
  return created;
};

/**
 * Turns a skill off by writing `"off"` into the user settings' `skillOverrides`, and on by
 * removing that entry. Every other setting and override is kept. Comments in a hand-edited file
 * do not survive the rewrite, but a file that cannot be parsed is never overwritten.
 */
export const setClaudeSkillOverride = Effect.fn("setClaudeSkillOverride")(function* (input: {
  readonly configDir: string;
  readonly name: string;
  readonly enabled: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(input.configDir, "settings.json");
  // Added accounts link settings.json to a shared file, so the lock follows the link.
  const lockKey = yield* resolveSymlinkTarget(settingsPath).pipe(
    Effect.orElseSucceed(() => settingsPath),
  );
  yield* settingsWriteLock(lockKey).withPermits(1)(writeOverride(fileSystem, settingsPath, input));
});

const writeOverride = Effect.fn("writeClaudeSkillOverride")(function* (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
  input: { readonly name: string; readonly enabled: boolean },
) {
  const contents = yield* fileSystem
    .readFileString(settingsPath)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
  const settings = contents.trim() === "" ? {} : yield* decodeUserSettingsObject(contents);
  const overrides = isPlainRecord(settings.skillOverrides) ? settings.skillOverrides : {};
  const isOff = overrides[input.name] === "off";
  if (isOff === !input.enabled) return;

  // Entries rather than assignment, so a skill named like an Object.prototype key stays data.
  const entries = Object.entries(overrides);
  const next = input.enabled
    ? entries.filter(([name]) => name !== input.name)
    : entries.some(([name]) => name === input.name)
      ? entries.map(([name, value]) => [name, name === input.name ? "off" : value] as const)
      : [...entries, [input.name, "off"] as const];
  const nextOverrides = Object.fromEntries(next);
  const updated =
    next.length === 0
      ? Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "skillOverrides"))
      : "skillOverrides" in settings
        ? Object.fromEntries(
            Object.entries(settings).map(([key, value]) => [
              key,
              key === "skillOverrides" ? nextOverrides : value,
            ]),
          )
        : { ...settings, skillOverrides: nextOverrides };
  yield* writeFileStringAtomically({
    filePath: settingsPath,
    contents: `${yield* encodeUserSettingsObject(updated)}\n`,
    preserveMode: true,
  });
});

const InstalledPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) }),
);
const decodeInstalledPlugin = Schema.decodeUnknownOption(
  Schema.Struct({
    scope: Schema.Literals(["user", "project", "local", "managed"]),
    installPath: Schema.NonEmptyString,
    projectPath: Schema.optional(Schema.NonEmptyString),
  }),
);
const PluginManifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    defaultEnabled: Schema.optional(Schema.Unknown),
  }),
);
const KnownMarketplaces = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeKnownMarketplace = Schema.decodeUnknownOption(
  Schema.Struct({ installLocation: Schema.NonEmptyString }),
);
const MarketplaceManifest = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Array(Schema.Unknown) }),
);
const decodeMarketplaceEntry = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    source: Schema.Unknown,
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);

const SyncedPlugins = Schema.fromJsonString(
  Schema.Struct({ plugins: Schema.Array(Schema.Unknown) }),
);
const decodeSyncedPlugin = Schema.decodeUnknownOption(
  Schema.Struct({
    pluginId: Schema.String,
    name: Schema.String,
    generation: Schema.optional(Schema.Number),
  }),
);
const ACCOUNT_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Claude compares plugin names case-insensitively. */
function pluginNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Claude's folder for a synced row: reserved characters become `_`, trailing dots and spaces go. */
function syncedPluginDirectoryName(name: string): string {
  const replaced = name.replace(/[<>:"|?*\\/]/g, "_");
  let end = replaced.length;
  while (end > 0 && (replaced[end - 1] === "." || replaced[end - 1] === " ")) end--;
  return replaced.slice(0, end);
}

function isInsideDirectory(path: Path.Path, directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const readPluginManifest = Effect.fn("readPluginManifest")(function* (pluginPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem
    .readFileString(path.join(pluginPath, ".claude-plugin", "plugin.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
      Effect.orElseSucceed(() => undefined),
    );
});

/** Declared skill folders that exist inside the install, through symlinks too, as the native loader requires. */
const containedSkillDirectories = Effect.fn("containedSkillDirectories")(function* (
  installPath: string,
  declared: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalInstallPath = yield* fileSystem
    .realPath(installPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  const directories: Array<string> = [];
  for (const relative of declared) {
    const directory = path.resolve(installPath, relative);
    if (!isInsideDirectory(path, installPath, directory) || canonicalInstallPath === undefined) {
      continue;
    }
    const canonicalDirectory = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (
      canonicalDirectory !== undefined &&
      isInsideDirectory(path, canonicalInstallPath, canonicalDirectory)
    ) {
      directories.push(directory);
    }
  }
  return directories;
});

const pluginSkillRoots = Effect.fn("pluginSkillRoots")(function* (
  installPath: string,
  scope: ClaudeSkillScope,
  prefix: string,
  manifest: typeof PluginManifest.Type | undefined,
  entrySkills?: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultDirectory = path.join(installPath, "skills");
  // A root-sourced marketplace entry's skills list replaces the plugin's skills; `./` means skills/.
  const entryDirectories =
    entrySkills === undefined ? [] : yield* containedSkillDirectories(installPath, entrySkills);
  if (entryDirectories.length > 0) {
    return entryDirectories.map((directory) => ({
      directory: directory === installPath ? defaultDirectory : directory,
      scope,
      prefix,
    }));
  }
  const roots: Array<ClaudeSkillRoot> = [];
  const hasDefaultDirectory = yield* fileSystem
    .exists(defaultDirectory)
    .pipe(Effect.orElseSucceed(() => false));
  if (hasDefaultDirectory) roots.push({ directory: defaultDirectory, scope, prefix });
  const declared = manifest?.skills;
  if (declared === undefined && !hasDefaultDirectory) {
    const hasRootSkill = yield* fileSystem
      .exists(path.join(installPath, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => false));
    if (hasRootSkill) roots.push({ directory: installPath, scope, prefix });
  }
  const declaredDirectories = yield* containedSkillDirectories(
    installPath,
    typeof declared === "string" ? [declared] : (declared ?? []),
  );
  for (const directory of declaredDirectories) roots.push({ directory, scope, prefix });
  return roots;
});

/** The `<org>_<account>` folder Claude syncs the signed-in account's claude.ai plugins into. */
const resolveSyncedPluginBucket = Effect.fn("resolveSyncedPluginBucket")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  configDirPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const accountConfigPath = yield* claudeAccountConfigPath(
    config.homePath.trim() || environment.CLAUDE_CONFIG_DIR?.trim() ? configDirPath : undefined,
  );
  const account = yield* readClaudeOauthAccount(accountConfigPath);
  const organizationId = environment.CLAUDE_CODE_ORGANIZATION_UUID ?? account?.organizationUuid;
  // A stored claude.ai login names its own account; an injected token uses the env account.
  const environmentAccountId = environment.CLAUDE_CODE_ACCOUNT_UUID;
  const accountId =
    account !== undefined && !environment.CLAUDE_CODE_OAUTH_TOKEN
      ? typeof account.accountUuid === "string"
        ? account.accountUuid
        : undefined
      : environmentAccountId && ACCOUNT_UUID_PATTERN.test(environmentAccountId)
        ? environmentAccountId
        : "unbound";
  if (
    !organizationId ||
    !accountId ||
    !ACCOUNT_UUID_PATTERN.test(organizationId) ||
    (accountId !== "unbound" && !ACCOUNT_UUID_PATTERN.test(accountId))
  ) {
    return undefined;
  }
  return `${organizationId.toLowerCase()}_${accountId.toLowerCase()}`;
});

/** A plugin folder itself, or else the manifest-bearing plugins directly inside it. */
const expandInlinePluginDirectory = Effect.fn("expandInlinePluginDirectory")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (candidate: string) =>
    fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  for (const component of [path.join(".claude-plugin", "plugin.json"), "skills", "SKILL.md"]) {
    if (yield* exists(path.join(directory, component))) return [directory];
  }
  const children = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  return yield* Effect.filter(
    [...children].sort().map((child) => path.join(directory, child)),
    (child) => exists(path.join(child, ".claude-plugin", "plugin.json")),
  );
});

/**
 * Plugin folders Claude Code loads inline, from --plugin-dir launch arguments and then
 * CLAUDE_CODE_PLUGIN_DIRS, and their plugin names.
 */
const discoverInlinePluginSkillRoots = Effect.fn("discoverInlinePluginSkillRoots")(function* (
  launchArgPluginDirectories: ReadonlyArray<string>,
  environmentPluginDirectories: string | undefined,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
  managedPluginNames: ReadonlySet<string>,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const roots: Array<ClaudeSkillRoot> = [];
  const names = new Set<string>();
  const seen = new Set<string>();
  const directories = [
    // Claude resolves a relative --plugin-dir against its cwd and expands no `~` in it.
    ...launchArgPluginDirectories
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => path.resolve(cwd ?? ".", directory)),
    // Claude skips relative CLAUDE_CODE_PLUGIN_DIRS entries rather than resolving them.
    ...(environmentPluginDirectories ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((entry) => expandHomePath(entry.trim(), home))
      .filter((directory) => directory && path.isAbsolute(directory))
      .map((directory) => path.resolve(directory)),
  ];
  for (const directory of directories) {
    for (const installPath of yield* expandInlinePluginDirectory(directory)) {
      if (seen.has(installPath)) continue;
      seen.add(installPath);
      const manifest = yield* readPluginManifest(installPath);
      const prefix = manifest?.name ?? path.basename(installPath);
      // A `<name>@inline` setting wins; otherwise the manifest's `defaultEnabled` decides.
      const setting = enabledPlugins.get(`${prefix}@inline`);
      if (setting === false || (setting === undefined && manifest?.defaultEnabled === false)) {
        continue;
      }
      // Managed enabledPlugins entries, true or false, lock the name against inline copies.
      if (managedPluginNames.has(pluginNameKey(prefix))) continue;
      names.add(pluginNameKey(prefix));
      roots.push(...(yield* pluginSkillRoots(installPath, "user", prefix, manifest)));
    }
  }
  return { roots, names };
});

const discoverPluginSkillRoots = Effect.fn("discoverPluginSkillRoots")(function* (
  configDirPath: string,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
  inlinePluginNames: ReadonlySet<string>,
  syncedBucket: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const pluginDirectory = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const pluginsPath = pluginDirectory
    ? path.resolve(cwd ?? ".", expandHomePath(pluginDirectory, home))
    : path.join(configDirPath, "plugins");
  const installed = yield* fileSystem
    .readFileString(path.join(pluginsPath, "installed_plugins.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(InstalledPlugins)),
      Effect.orElseSucceed(() => undefined),
    );
  const roots: Array<ClaudeSkillRoot> = [];
  // An enabled inline plugin replaces installed and synced plugins of the same name.
  const claimedPluginNames = new Set(inlinePluginNames);
  // The CLI's process.cwd() resolves symlinks; registry projectPath values remain lexical.
  const workspace =
    cwd === undefined
      ? undefined
      : yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  // Install records repeat project paths, often hundreds of times per discovery.
  const projectRepositoryRoots = new Map<string, string | undefined>();
  const repositoryRoot =
    workspace === undefined ? undefined : yield* findPluginRepositoryRoot(workspace);
  const knownMarketplaces = yield* fileSystem
    .readFileString(path.join(pluginsPath, "known_marketplaces.json"))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(KnownMarketplaces)),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
  const marketplaceEntries = new Map<string, ReadonlyArray<unknown>>();
  // Claude applies an entry's skills list only when the entry's source is the marketplace root.
  const readRootEntrySkills = Effect.fnUntraced(function* (marketplace: string, plugin: string) {
    if (!marketplaceEntries.has(marketplace)) {
      const location = Option.getOrUndefined(
        decodeKnownMarketplace(knownMarketplaces[marketplace]),
      )?.installLocation;
      const manifest =
        location === undefined
          ? undefined
          : yield* fileSystem
              .readFileString(path.join(location, ".claude-plugin", "marketplace.json"))
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(MarketplaceManifest)),
                Effect.orElseSucceed(() => undefined),
              );
      marketplaceEntries.set(marketplace, manifest?.plugins ?? []);
    }
    const entry = (marketplaceEntries.get(marketplace) ?? [])
      .flatMap((candidate) => Option.toArray(decodeMarketplaceEntry(candidate)))
      .find((candidate) => candidate.name === plugin);
    if (
      entry?.skills === undefined ||
      typeof entry.source !== "string" ||
      !entry.source.split(/[\\/]/).every((segment) => segment === "" || segment === ".")
    ) {
      return undefined;
    }
    return typeof entry.skills === "string" ? [entry.skills] : entry.skills;
  });

  for (const [key, entries] of Object.entries(installed?.plugins ?? {}).sort()) {
    if (enabledPlugins.get(key) !== true) continue;
    const applicable = yield* Effect.filter(
      entries.flatMap((entry) => Option.toArray(decodeInstalledPlugin(entry))),
      (record) =>
        Effect.gen(function* () {
          if (record.scope === "user" || record.scope === "managed") return true;
          if (record.projectPath === undefined || workspace === undefined) return false;
          const projectPath = path.resolve(record.projectPath);
          if (projectPath === workspace) return true;
          if (repositoryRoot === undefined) return false;
          if (!projectRepositoryRoots.has(projectPath)) {
            projectRepositoryRoots.set(projectPath, yield* findPluginRepositoryRoot(projectPath));
          }
          return projectRepositoryRoots.get(projectPath) === repositoryRoot;
        }),
    );
    // The native loader keeps registry order, preferring the first install that exists.
    const existing = yield* Effect.findFirst(applicable, (record) =>
      fileSystem
        .exists(path.resolve(cwd ?? ".", record.installPath))
        .pipe(Effect.orElseSucceed(() => false)),
    );
    const install = Option.getOrElse(existing, () => applicable[0]);
    if (!install) continue;
    const scope = install.scope === "user" || install.scope === "managed" ? "user" : "project";
    const installPath = path.resolve(cwd ?? ".", install.installPath);
    const manifest = yield* readPluginManifest(installPath);
    const prefix = manifest?.name ?? key.split("@")[0];
    if (!prefix || inlinePluginNames.has(pluginNameKey(prefix))) continue;
    // A registry record whose install is gone loads nothing and claims no namespace.
    if (Option.isSome(existing)) claimedPluginNames.add(pluginNameKey(prefix));
    const separator = key.lastIndexOf("@");
    const entrySkills =
      separator > 0
        ? yield* readRootEntrySkills(key.slice(separator + 1), key.slice(0, separator))
        : undefined;
    roots.push(...(yield* pluginSkillRoots(installPath, scope, prefix, manifest, entrySkills)));
  }
  if (syncedBucket === undefined) return roots;

  const syncedPath = path.join(configDirPath, "plugins", "synced");
  const bucketPath = path.join(syncedPath, syncedBucket);
  const disabledSyncedPlugins = new Set(
    [...enabledPlugins].flatMap(([pluginKey, enabled]) =>
      !enabled && pluginKey.endsWith("@synced") ? [pluginNameKey(pluginKey.slice(0, -7))] : [],
    ),
  );
  const hasBucketMarker = yield* fileSystem
    .exists(path.join(syncedPath, `.bucket-${syncedBucket}`))
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasBucketMarker) return roots;
  const synced = yield* fileSystem.readFileString(path.join(bucketPath, "manifest.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SyncedPlugins)),
    Effect.orElseSucceed(() => undefined),
  );
  for (const row of synced?.plugins ?? []) {
    const plugin = Option.getOrUndefined(decodeSyncedPlugin(row));
    const directoryName = plugin === undefined ? "" : syncedPluginDirectoryName(plugin.name);
    if (!plugin || !directoryName || directoryName.startsWith(".")) continue;
    const generation = plugin.generation;
    const pluginPath = path.join(
      bucketPath,
      generation !== undefined && Number.isInteger(generation) && generation >= 2
        ? `${directoryName}~g${generation}`
        : directoryName,
    );
    const manifest = yield* readPluginManifest(pluginPath);
    const prefix = manifest?.name ?? directoryName;
    // An installed plugin of the same name, then the first synced row, holds the namespace.
    const key = pluginNameKey(prefix);
    if (claimedPluginNames.has(key) || disabledSyncedPlugins.has(key)) continue;
    claimedPluginNames.add(key);
    roots.push(...(yield* pluginSkillRoots(pluginPath, "user", prefix, manifest)));
  }
  return roots;
});

export const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Match the spawned CLI: preserve a literal ~ and resolve relative config against workspace cwd.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(home, ".claude");
});

const decodeAutoUpdatesChannel = Schema.decodeUnknownOption(Schema.String);

/** The `env` Claude Code applies from its settings in `cwd`, or none when they cannot be confirmed. */
export const readClaudeSettingsEnv = Effect.fn("readClaudeSettingsEnv")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  Readonly<Record<string, string>>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const settings = yield* readConfirmedClaudeSettings({
    settings: config,
    homePath: yield* resolveClaudeConfigDirPath(config, environment, cwd),
    environment,
    cwd: cwd ?? null,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
  });
  return Option.match(settings, { onNone: () => ({}), onSome: claudeSettingsEnvironment });
});

/**
 * The release channel `claude update` follows, from the user and policy settings, or None when
 * policy T3.CodeShip cannot read may choose another one or the settings cannot be read.
 */
export const readClaudeAutoUpdatesChannel = Effect.fn("readClaudeAutoUpdatesChannel")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* readConfirmedClaudeSettings({
    settings: undefined,
    homePath: yield* resolveClaudeConfigDirPath({ homePath: "" }, environment),
    environment,
    cwd: null,
    fileSystem,
    path,
  });
  return Option.map(
    settings,
    (tiers) =>
      tiers
        .map(({ settings }) =>
          Option.getOrUndefined(decodeAutoUpdatesChannel(settings.autoUpdatesChannel)),
        )
        .findLast((channel) => channel !== undefined)
        ?.trim() || "latest",
  );
});

const decodeSettingsRecord = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Claude's user settings file as written; undefined when it is missing or not a JSON object. */
export const readClaudeUserSettings = Effect.fn("readClaudeUserSettings")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
  return yield* fileSystem.readFileString(path.join(configDirPath, "settings.json")).pipe(
    Effect.flatMap(decodeSettingsRecord),
    Effect.orElseSucceed(() => undefined),
  );
});

/** The host of an `ANTHROPIC_BASE_URL` that is not Anthropic's own API. */
export function customClaudeApiEndpointHost(baseUrl: string | undefined): string | undefined {
  const endpoint = URL.parse(baseUrl?.trim() ?? "");
  return endpoint !== null &&
    (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
    endpoint.hostname !== "" &&
    endpoint.hostname !== "api.anthropic.com"
    ? endpoint.hostname
    : undefined;
}

// Claude's --add-dir is repeatable and variadic; parseCliArgs keeps only one value.
export function claudeLaunchArgDirectories(launchArgs?: string): ReadonlyArray<string> {
  const directories: string[] = [];
  let collecting = false;
  for (const token of tokenizeCliArgs(launchArgs)) {
    if (token === "--") break;
    if (token === "--add-dir") {
      collecting = true;
    } else if (token.startsWith("--add-dir=")) {
      directories.push(token.slice("--add-dir=".length));
      collecting = false;
    } else if (token.startsWith("-")) {
      collecting = false;
    } else if (collecting) {
      directories.push(token);
    }
  }
  return directories;
}

/**
 * `~/.agents/skills`, unless Claude's own `skills` folder links skills from it: then that folder
 * picks the shared skills (a machine setup links only those it switches on), and adding the whole
 * folder would bring back the rest. Codex, Cursor and OpenCode read it themselves.
 */
const sharedSkillsForClaude = Effect.fn("sharedSkillsForClaude")(function* (
  configDirPath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shared = path.join(yield* HostProcess.HomeDirectory, ".agents", "skills");
  const sharedTarget = yield* fileSystem.realPath(shared).pipe(Effect.option);
  if (Option.isNone(sharedTarget)) return undefined;
  const platform = yield* HostProcess.Platform;
  // Windows paths are case-insensitive, and a junction's target need not match the home folder's case.
  const foldCase = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const ownSkills = path.join(configDirPath, "skills");
  const entries = yield* fileSystem
    .readDirectory(ownSkills)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const linkedSharedSkill = yield* Effect.findFirst(entries, (entry) =>
    fileSystem.realPath(path.join(ownSkills, entry)).pipe(
      Effect.map((target) => foldCase(path.dirname(target)) === foldCase(sharedTarget.value)),
      Effect.orElseSucceed(() => false),
    ),
  );
  return Option.isSome(linkedSharedSkill) ? undefined : shared;
});

/**
 * Claude reads no shared skills folder, but loads `.claude/skills` in an added directory.
 * Links `bridgeDirectory/.claude/skills` to the shared folder and returns the directory to add,
 * or undefined when Claude's own skills folder decides the shared skills, there is no shared
 * folder, or it cannot be linked.
 */
export const linkClaudeSharedSkills = Effect.fn("linkClaudeSharedSkills")(function* (
  bridgeDirectory: string,
  configDirPath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const link = path.join(bridgeDirectory, ".claude", "skills");
  return yield* Effect.gen(function* () {
    const target = yield* sharedSkillsForClaude(configDirPath);
    if (target === undefined) {
      // Sessions started with an earlier turn's link would keep seeing every shared skill.
      const isLink = yield* fileSystem.readLink(link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink) yield* fileSystem.remove(link);
      return undefined;
    }
    const linked = yield* Effect.all([fileSystem.realPath(link), fileSystem.realPath(target)]).pipe(
      Effect.map(([actual, expected]) => actual === expected),
      Effect.orElseSucceed(() => false),
    );
    if (linked) return bridgeDirectory;
    // Missing, dangling, or pointing elsewhere. A non-recursive remove never empties a real folder.
    yield* fileSystem
      .remove(link)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
    yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
    yield* linkPath(target, link, platform, true);
    return bridgeDirectory;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Shared skills are not linked for Claude.", { link, error }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
});

// The Claude CLI takes the next token as this flag's value even when it starts with `--`.
const claudeLaunchArgParseOptions = { valueFlags: ["append-system-prompt"] };

// Claude's --plugin-dir is repeatable; parseCliArgs keeps only the last one.
export function claudeLaunchArgPluginDirectories(launchArgs?: string): ReadonlyArray<string> {
  const tokens = tokenizeCliArgs(launchArgs);
  const directories: string[] = [];
  for (let index = 0; index < tokens.length && tokens[index] !== "--"; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--") || token.includes("=")) {
      if (token.startsWith("--plugin-dir=")) directories.push(token.slice("--plugin-dir=".length));
      continue;
    }
    const next = tokens[index + 1];
    const takesNext =
      next !== undefined &&
      (!next.startsWith("--") || claudeLaunchArgParseOptions.valueFlags.includes(token.slice(2)));
    if (!takesNext) continue;
    if (token === "--plugin-dir") directories.push(next);
    index++;
  }
  return directories;
}

/** First name wins: managed skills, then user skills, then project skills. */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = environment ?? process.env;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, env, cwd);
  const settings = yield* readConfirmedClaudeSettings({
    settings: config,
    homePath: configDirPath,
    environment: env,
    cwd: cwd ?? null,
    fileSystem,
    path,
  });
  // Settings T3.CodeShip cannot confirm may turn skills off, and offering one anyway would bypass
  // that: dispatch points at the file. Claude Code still lists its skills as slash commands.
  if (Option.isNone(settings)) return [];
  const { skillOverrides, enabledPlugins, managedPluginNames, syncedPluginsHidden } =
    readSkillSettings(settings.value);
  const managedDirectory = claudeManagedDirectory(path, yield* HostProcess.Platform, env);
  // Most installs have no synced folder; skip reading `.claude.json` for them.
  const hasSyncedPlugins =
    !syncedPluginsHidden &&
    (yield* fileSystem
      .exists(path.join(configDirPath, "plugins", "synced"))
      .pipe(Effect.orElseSucceed(() => false)));
  const syncedBucket = hasSyncedPlugins
    ? yield* resolveSyncedPluginBucket(config, configDirPath, env)
    : undefined;
  // Claude applies its settings `env` over the inherited environment.
  const inlinePluginDirectories =
    claudeSettingsEnvironment(settings.value).CLAUDE_CODE_PLUGIN_DIRS ??
    env.CLAUDE_CODE_PLUGIN_DIRS;
  const inlinePlugins = yield* discoverInlinePluginSkillRoots(
    claudeLaunchArgPluginDirectories(config.launchArgs),
    inlinePluginDirectories,
    cwd,
    enabledPlugins,
    managedPluginNames,
  );
  const sharedSkills = yield* sharedSkillsForClaude(configDirPath);

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    ...(managedDirectory
      ? [{ directory: path.join(managedDirectory, ".claude", "skills"), scope: "user" as const }]
      : []),
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
    ...claudeLaunchArgDirectories(config.launchArgs)
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => ({
        directory: path.join(path.resolve(cwd ?? ".", directory), ".claude", "skills"),
        scope: "project" as const,
      })),
    ...(sharedSkills === undefined ? [] : [{ directory: sharedSkills, scope: "user" as const }]),
    ...inlinePlugins.roots,
    ...(yield* discoverPluginSkillRoots(
      configDirPath,
      cwd,
      enabledPlugins,
      inlinePlugins.names,
      syncedBucket,
      env,
    )),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const singleSkill =
      root.prefix !== undefined &&
      (yield* fileSystem
        .exists(path.join(root.directory, "SKILL.md"))
        .pipe(Effect.orElseSucceed(() => false)));
    const entries = singleSkill
      ? [path.basename(root.directory)]
      : yield* fileSystem
          .readDirectory(root.directory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = singleSkill
        ? path.join(root.directory, "SKILL.md")
        : path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const directoryName = entry.trim();
      if (!directoryName) continue;
      let name = directoryName;
      if (root.prefix) {
        // Native folder skills use their folder; only a single SKILL.md uses its name field.
        const declaredName = singleSkill && frontmatter.kind === "parsed" ? frontmatter.name : "";
        const unprefixedName = declaredName?.startsWith(`${root.prefix}:`)
          ? declaredName.slice(root.prefix.length + 1)
          : declaredName;
        name = `${root.prefix}:${(unprefixedName || entry).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        // Advertise only exact native names the shared composer grammar can invoke.
        const [mention] = `$${name}`.matchAll(SKILL_MENTION_PATTERN);
        if (mention?.[2] !== name) continue;
      }

      if (skillsByName.has(name)) {
        continue;
      }

      const override = root.prefix ? undefined : skillOverrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
