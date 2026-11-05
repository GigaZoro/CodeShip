import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import { linkPath } from "./ClaudeAccountHome.ts";

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

function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/** Claude Code settings files, lowest precedence first. */
function claudeSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
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

const findPluginRepositoryRoot = Effect.fn("findPluginRepositoryRoot")(function* (cwd: string) {
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

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeSkillSettings = Schema.decodeUnknownEffect(SkillSettings);

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

const readSkillSettings = Effect.fn("readSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const overridesByName = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of claudeSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const parsed = yield* decodeSkillSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skill settings", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const [name, value] of Object.entries(parsed?.skillOverrides ?? {})) {
      overridesByName.set(name, parseSkillOverride(value));
    }
    for (const [key, enabled] of Object.entries(parsed?.enabledPlugins ?? {})) {
      if (typeof enabled === "boolean") {
        enabledPlugins.set(key, enabled);
      } else {
        // Extended formats replace lower-precedence values without enabling the plugin here.
        enabledPlugins.delete(key);
      }
    }
  }

  return { skillOverrides: overridesByName, enabledPlugins };
});

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
  }),
);

function isInsideDirectory(path: Path.Path, directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const discoverPluginSkillRoots = Effect.fn("discoverPluginSkillRoots")(function* (
  configDirPath: string,
  cwd: string | undefined,
  enabledPlugins: ReadonlyMap<string, boolean>,
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
  if (installed === undefined) return [];
  const roots: Array<ClaudeSkillRoot> = [];
  // The CLI's process.cwd() resolves symlinks; registry projectPath values remain lexical.
  const workspace =
    cwd === undefined
      ? undefined
      : yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  const repositoryRoot =
    workspace === undefined ? undefined : yield* findPluginRepositoryRoot(workspace);

  for (const [key, entries] of Object.entries(installed.plugins).sort()) {
    if (enabledPlugins.get(key) !== true) continue;
    const applicable = yield* Effect.filter(
      entries.flatMap((entry) => Option.toArray(decodeInstalledPlugin(entry))),
      (record) =>
        Effect.gen(function* () {
          if (record.scope === "user" || record.scope === "managed") return true;
          if (record.projectPath === undefined || workspace === undefined) return false;
          if (path.resolve(record.projectPath) === workspace) return true;
          return (
            repositoryRoot !== undefined &&
            (yield* findPluginRepositoryRoot(record.projectPath)) === repositoryRoot
          );
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
    const manifest = yield* fileSystem
      .readFileString(path.join(installPath, ".claude-plugin", "plugin.json"))
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
        Effect.orElseSucceed(() => undefined),
      );
    const prefix = manifest?.name ?? key.split("@")[0];
    if (!prefix) continue;

    const defaultDirectory = path.join(installPath, "skills");
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

    const canonicalInstallPath = yield* fileSystem
      .realPath(installPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    for (const relative of typeof declared === "string" ? [declared] : (declared ?? [])) {
      const directory = path.resolve(installPath, relative);
      if (!isInsideDirectory(path, installPath, directory) || canonicalInstallPath === undefined) {
        continue;
      }
      const canonicalDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => undefined));
      // The native loader rejects manifest roots that escape through a symlink, too.
      if (
        canonicalDirectory !== undefined &&
        isInsideDirectory(path, canonicalInstallPath, canonicalDirectory)
      ) {
        roots.push({ directory, scope, prefix });
      }
    }
  }
  return roots;
});

const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
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

const SettingsEnv = Schema.Struct({
  ANTHROPIC_BASE_URL: Schema.optional(Schema.String),
  CLAUDE_CODE_ENTRYPOINT: Schema.optional(Schema.String),
});
const decodeSettingsEnv = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Struct({ env: Schema.optional(SettingsEnv) })),
);

/** Claude's user and managed settings files that `decode` accepts, lowest precedence first. */
const readClaudeUserSettingsFiles = Effect.fn("readClaudeUserSettingsFiles")(function* <A>(
  decode: (contents: string) => Effect.Effect<A, Schema.SchemaError>,
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
  const files: Array<A> = [];
  for (const settingsPath of claudeSettingsPaths(
    path,
    configDirPath,
    undefined,
    platform,
    environment,
  )) {
    const contents = yield* fileSystem.readFileString(settingsPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const parsed = yield* decode(contents.value).pipe(Effect.option);
    if (Option.isSome(parsed)) files.push(parsed.value);
  }
  return files;
});

/** The `env` values T3.CodeShip reads from Claude's user and managed settings; later files win. */
export const readClaudeSettingsEnv = Effect.fn("readClaudeSettingsEnv")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<typeof SettingsEnv.Type, never, FileSystem.FileSystem | Path.Path> {
  const files = yield* readClaudeUserSettingsFiles(decodeSettingsEnv, config, cwd, environment);
  const settingsEnv: typeof SettingsEnv.Type = {};
  for (const file of files) Object.assign(settingsEnv, file.env);
  return settingsEnv;
});

const decodeSettingsAutoUpdatesChannel = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.String) })),
);

/** The release channel `claude update` follows, from the user and managed settings; later files win. */
export const readClaudeAutoUpdatesChannel = Effect.fn("readClaudeAutoUpdatesChannel")(function* (
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const files = yield* readClaudeUserSettingsFiles(
    decodeSettingsAutoUpdatesChannel,
    { homePath: "" },
    undefined,
    environment,
  );
  return files.findLast((file) => file.autoUpdatesChannel !== undefined)?.autoUpdatesChannel;
});

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

/** Skills shared by every agent. Codex, Cursor and OpenCode read this folder themselves. */
const sharedSkillsDirectory = (path: Path.Path, home: string) =>
  path.join(home, ".agents", "skills");

/**
 * Claude reads no shared skills folder, but loads `.claude/skills` in an added directory.
 * Links `bridgeDirectory/.claude/skills` to the shared folder and returns the directory to add,
 * or undefined when there is no shared folder or it cannot be linked.
 */
export const linkClaudeSharedSkills = Effect.fn("linkClaudeSharedSkills")(function* (
  bridgeDirectory: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const target = sharedSkillsDirectory(path, yield* HostProcess.HomeDirectory);
  const link = path.join(bridgeDirectory, ".claude", "skills");
  const linked = Effect.all([fileSystem.realPath(link), fileSystem.realPath(target)]).pipe(
    Effect.map(([actual, expected]) => actual === expected),
    Effect.orElseSucceed(() => false),
  );
  return yield* Effect.gen(function* () {
    if (!(yield* fileSystem.exists(target))) return undefined;
    if (yield* linked) return bridgeDirectory;
    // Missing, dangling, or pointing elsewhere. A non-recursive remove never empties a real folder.
    yield* fileSystem
      .remove(link)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void));
    yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
    yield* linkPath(target, link, platform, true);
    return bridgeDirectory;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Shared skills are not linked for Claude.", { link, target, error }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
});

/** First name wins, matching Claude Code's precedence of user skills over project skills. */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const { skillOverrides, enabledPlugins } = yield* readSkillSettings(
    configDirPath,
    cwd,
    environment ?? process.env,
  );

  const roots: ReadonlyArray<ClaudeSkillRoot> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
    ...claudeLaunchArgDirectories(config.launchArgs)
      .filter((directory) => directory && (cwd || path.isAbsolute(directory)))
      .map((directory) => ({
        directory: path.join(path.resolve(cwd ?? ".", directory), ".claude", "skills"),
        scope: "project" as const,
      })),
    { directory: sharedSkillsDirectory(path, yield* HostProcess.HomeDirectory), scope: "user" },
    ...(yield* discoverPluginSkillRoots(
      configDirPath,
      cwd,
      enabledPlugins,
      environment ?? process.env,
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
