import {
  resolveSettings as resolveClaudeSettings,
  type Settings as ClaudeSdkSettings,
  type SettingSource as ClaudeSettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Claude Code's ownership and real-path checks need lstat and the native realpath, which FileSystem lacks.
import * as NodeFSP from "node:fs/promises";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import {
  type ClaudeSettingsRead,
  resolveClaudeSettingsSources,
} from "../../claudeHistoryWorker.ts";
import { claudeConfigDirOf, runClaudeWorker } from "./ClaudeWorker.ts";

type ClaudeLaunchArgs = Partial<Pick<ClaudeSettings, "launchArgs">> | undefined;

export class ClaudeSettingsLaunchArgError extends Schema.TaggedError<ClaudeSettingsLaunchArgError>()(
  "ClaudeSettingsLaunchArgError",
  {
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude could not read the --settings launch argument${this.path === undefined ? "" : ` at ${this.path}`} as a JSON object. Fix it in the Claude launch arguments, then send the message again.`;
  }
}

const CLAUDE_SETTINGS_FAILURE_PHASES = [
  "user-project-local-files",
  "account-worker",
  "flag-validation",
  "policy-resolution",
] as const;
const CLAUDE_SETTINGS_FAILURE_KINDS = [
  "timeout",
  "spawn",
  "nonzero-exit",
  "invalid-output",
  "sdk-error",
] as const;

/**
 * Both fields are fixed literals, so the message that reaches the persisted run failure says where
 * and how resolution failed without carrying settings, arguments, stderr or exception text.
 */
export class ClaudeSettingsResolveError extends Schema.TaggedError<ClaudeSettingsResolveError>()(
  "ClaudeSettingsResolveError",
  {
    phase: Schema.Literals(CLAUDE_SETTINGS_FAILURE_PHASES),
    kind: Schema.Literals(CLAUDE_SETTINGS_FAILURE_KINDS),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude's settings could not be resolved (${this.phase}: ${this.kind}).`;
  }
}

/** The safe kind of a failure from the account worker, by the tag of its error. */
export const claudeSettingsWorkerFailureKind = (
  error: unknown,
): (typeof CLAUDE_SETTINGS_FAILURE_KINDS)[number] => {
  const tag = Predicate.isTagged(error, "TimeoutError")
    ? "TimeoutError"
    : Predicate.hasProperty(error, "_tag")
      ? error._tag
      : undefined;
  switch (tag) {
    case "TimeoutError":
      return "timeout";
    case "ClaudeWorkerError":
      return "nonzero-exit";
    case "SchemaError":
      return "invalid-output";
    case "PlatformError":
    case "ProviderCommandNotFoundError":
      return "spawn";
    default:
      return "sdk-error";
  }
};

/**
 * A busy machine can hold the account worker's start past its deadline. The read changes nothing,
 * so a timed-out one is read once more, sparing the turn a restart; every other failure is the
 * worker's real answer.
 */
export const retryTimedOutClaudeWorker = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.tapError((error) =>
      claudeSettingsWorkerFailureKind(error) === "timeout"
        ? Effect.logWarning("Claude's account settings worker timed out.")
        : Effect.void,
    ),
    Effect.retry({
      times: 1,
      while: (error) => claudeSettingsWorkerFailureKind(error) === "timeout",
    }),
  );

export class ClaudeProjectConfigRootError extends Schema.TaggedError<ClaudeProjectConfigRootError>()(
  "ClaudeProjectConfigRootError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Claude's --project-config-root launch argument must be the absolute path of an existing folder you can list, not "${this.path}". Fix it in the Claude launch arguments, then send the message again.`;
  }
}

const encodeClaudeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettingsObject = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Reads the --settings launch argument: a value starting with a brace is inline
 * JSON, anything else is a file path relative to the cwd. makeClaudeQueryOptions
 * merges the result beneath T3's own settings.
 */
export const readClaudeLaunchArgSettings = Effect.fn("ClaudeAdapterV2.readLaunchArgSettings")(
  function* (input: {
    readonly settings: ClaudeLaunchArgs;
    readonly cwd: string | null;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    if (input.settings === undefined) return undefined;
    const value = parseCliArgs(input.settings.launchArgs ?? "").flags.settings;
    if (value === undefined) return undefined;
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) return yield* new ClaudeSettingsLaunchArgError({});
    // The CLI also wants a closing brace, but then malformed JSON, secrets included, would
    // become the file path in the error message.
    if (trimmed.startsWith("{")) {
      return (yield* decodeClaudeSettingsObject(trimmed).pipe(
        Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ cause })),
      )) as ClaudeSdkSettings;
    }
    const filePath = input.path.resolve(input.cwd ?? ".", trimmed);
    return (yield* input.fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeClaudeSettingsObject),
      Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ path: filePath, cause })),
    )) as ClaudeSdkSettings;
  },
);

const CLAUDE_SETTING_SOURCES: ReadonlyArray<ClaudeSettingSource> = ["user", "project", "local"];

/** The settings files Claude Code loads, as its --setting-sources launch argument limits them. */
export const claudeSettingSources = (
  settings: ClaudeLaunchArgs,
): ReadonlyArray<ClaudeSettingSource> => {
  const value = parseCliArgs(settings?.launchArgs ?? "").flags["setting-sources"];
  if (value === undefined) return CLAUDE_SETTING_SOURCES;
  const named = new Set((value ?? "").split(",").map((source) => source.trim()));
  return CLAUDE_SETTING_SOURCES.filter((source) => named.has(source));
};

/** Where --project-config-root moves Claude Code's project and local settings; empty when given bare. */
export const claudeProjectConfigRoot = (settings: ClaudeLaunchArgs) => {
  const value = parseCliArgs(settings?.launchArgs ?? "").flags["project-config-root"];
  return value === undefined ? undefined : (value ?? "");
};

const ClaudeBypassSettings = Schema.StructWithRest(
  Schema.Struct({
    disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
    permissions: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          disableBypassPermissionsMode: Schema.optionalKey(Schema.Literals(["disable", false])),
          disableAutoMode: Schema.optionalKey(Schema.Literals(["disable", false])),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

function claudeSdkBypassSettings(settings: typeof ClaudeBypassSettings.Type) {
  const { disableAutoMode, permissions, ...rest } = settings;
  const {
    disableBypassPermissionsMode,
    disableAutoMode: nestedAutoMode,
    ...permissionRest
  } = permissions ?? {};
  return {
    ...rest,
    ...(disableAutoMode === "disable" ? { disableAutoMode } : {}),
    ...(permissions
      ? {
          permissions: {
            ...permissionRest,
            ...(disableBypassPermissionsMode === "disable" ? { disableBypassPermissionsMode } : {}),
            ...(nestedAutoMode === "disable" ? { disableAutoMode: nestedAutoMode } : {}),
          },
        }
      : {}),
  };
}

// The SDK's settings type only allows "disable" for these switches, where false means unset.
// Shapes the schema rejects pass through unchanged, so Claude Code's validation drops them.
const decodeClaudeBypassSettingsOption = Schema.decodeUnknownOption(ClaudeBypassSettings);
export function claudeSdkShapedSettings(settings: ClaudeSdkSettings): ClaudeSdkSettings {
  const decoded = decodeClaudeBypassSettingsOption(settings);
  return Option.isNone(decoded)
    ? settings
    : (claudeSdkBypassSettings(decoded.value) as ClaudeSdkSettings);
}

// A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
// <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
const claudeMainCheckoutRoot = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkout: string,
) =>
  fileSystem.readFileString(path.join(checkout, ".git")).pipe(
    Effect.flatMap((pointer) => {
      const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      if (gitDir === undefined) return Effect.succeed(checkout);
      const worktreeGitDir = path.resolve(checkout, gitDir);
      return fileSystem.readFileString(path.join(worktreeGitDir, "commondir")).pipe(
        Effect.map((commonDir) => {
          const common = path.resolve(worktreeGitDir, commonDir.trim());
          return path.basename(common) === ".git" ? path.dirname(common) : checkout;
        }),
      );
    }),
    Effect.orElseSucceed(() => checkout),
  );

// Claude Code's own check: it lstat's .git and .claude.
const claudeUserOwnsRoot = Effect.fn("ClaudeAdapterV2.userOwnsRoot")(function* (
  path: Path.Path,
  root: string,
) {
  const uid = yield* HostProcess.EffectiveUserId;
  if (uid === undefined) return false;
  return yield* Effect.tryPromise(async () => {
    const [rootInfo, gitInfo, claudeUid] = await Promise.all([
      NodeFSP.stat(root),
      NodeFSP.lstat(path.join(root, ".git")),
      NodeFSP.lstat(path.join(root, ".claude")).then(
        (info) => info.uid,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return uid;
          throw error;
        },
      ),
    ]);
    return rootInfo.uid === uid && gitInfo.uid === uid && claudeUid === uid;
  }).pipe(Effect.orElseSucceed(() => false));
});

// Claude Code keeps .claude/settings.local.json at the repository root when this user owns the
// root, its .git and any .claude there, and in cwd otherwise, outside a repository, on Windows,
// or when the root is home.
const claudeLocalSettingsDirectory = Effect.fn("ClaudeAdapterV2.localSettingsDirectory")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
) {
  if ((yield* HostProcess.Platform) === "win32") return cwd;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const isCheckout = yield* fileSystem
      .exists(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isCheckout) {
      const root = yield* claudeMainCheckoutRoot(fileSystem, path, directory);
      if (root === cwd || root === (yield* HostProcess.HomeDirectory)) return cwd;
      return (yield* claudeUserOwnsRoot(path, root)) ? root : cwd;
    }
    if (path.dirname(directory) === directory) return cwd;
  }
});

const CLAUDE_SETTINGS_FILE_SOURCES: ReadonlySet<string> = new Set(CLAUDE_SETTING_SOURCES);
const decodeClaudeSettingsReadSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Array(
        Schema.Struct({
          source: Schema.String,
          settings: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    ),
  ),
);

/**
 * The user, project and local settings files of each read in order, as Claude Code's own engine
 * validates them: it drops a whole file when any field is invalid. resolveSettings takes user
 * settings from CLAUDE_CONFIG_DIR, so another account's folder is read in the worker.
 */
const resolveClaudeSettingsFiles = Effect.fn("ClaudeAdapterV2.resolveSettingsFiles")(function* (
  homePath: string,
  environment: NodeJS.ProcessEnv,
  reads: ReadonlyArray<ClaudeSettingsRead>,
) {
  if (reads.length === 0) return [];
  const path = yield* Path.Path;
  const usesHostConfig =
    !reads.some((read) => read.settingSources.includes("user")) ||
    path.resolve(homePath) ===
      claudeConfigDirOf(path, yield* HostProcess.Environment, yield* HostProcess.HomeDirectory);
  const sources: ReadonlyArray<
    ReadonlyArray<{ readonly source: string; readonly settings: Readonly<Record<string, unknown>> }>
  > = usesHostConfig
    ? yield* Effect.tryPromise({
        try: () => resolveClaudeSettingsSources(reads),
        catch: (cause) =>
          new ClaudeSettingsResolveError({
            phase: "user-project-local-files",
            kind: "sdk-error",
            cause,
          }),
      })
    : yield* runClaudeWorker({
        method: "resolveSettings",
        input: encodeClaudeJson(reads),
        environment: { ...environment, CLAUDE_CONFIG_DIR: homePath },
      }).pipe(
        retryTimedOutClaudeWorker,
        Effect.flatMap(decodeClaudeSettingsReadSources),
        Effect.mapError(
          (cause) =>
            new ClaudeSettingsResolveError({
              phase: "account-worker",
              kind: claudeSettingsWorkerFailureKind(cause),
              cause,
            }),
        ),
      );
  return sources
    .flat()
    .filter((entry) => CLAUDE_SETTINGS_FILE_SOURCES.has(entry.source))
    .map((entry) => entry.settings as ClaudeSdkSettings);
});

// Claude Code's own check: it refuses to start unless the folder lists, and reads it at its native
// real path, where `..` after a symlink leaves the link's target. FileSystem.realPath is Node's JS
// one, which resolves `..` before any link.
const checkClaudeProjectConfigRoot = Effect.fn("ClaudeAdapterV2.checkProjectConfigRoot")(function* (
  path: Path.Path,
  root: string,
) {
  if (!path.isAbsolute(root)) return yield* new ClaudeProjectConfigRootError({ path: root });
  return yield* Effect.tryPromise(async () => {
    const realRoot = await NodeFSP.realpath(root);
    await (await NodeFSP.opendir(realRoot)).close();
    return realRoot;
  }).pipe(Effect.mapError(() => new ClaudeProjectConfigRootError({ path: root })));
});

/**
 * The reads that give Claude Code's settings files in order: user, project, local (beneath it one
 * an older Claude Code left in cwd when local lives at the repository root). --project-config-root
 * moves project and local to that folder.
 */
const claudeSettingsReads = Effect.fn("ClaudeAdapterV2.settingsReads")(function* (input: {
  readonly homePath: string;
  readonly cwd: string | null;
  readonly settingSources: ReadonlyArray<ClaudeSettingSource>;
  readonly projectConfigRoot: string | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { cwd, settingSources, fileSystem, path } = input;
  if (input.projectConfigRoot !== undefined) {
    const root = yield* checkClaudeProjectConfigRoot(path, input.projectConfigRoot);
    return [{ cwd: root, settingSources }];
  }
  if (cwd === null) {
    // No folder means no project or local settings, and resolveSettings would read this process's.
    const userOnly = settingSources.filter((source) => source === "user");
    return userOnly.length === 0 ? [] : [{ cwd: input.homePath, settingSources: userOnly }];
  }
  const localDirectory = settingSources.includes("local")
    ? yield* claudeLocalSettingsDirectory(fileSystem, path, cwd)
    : cwd;
  return [
    { cwd, settingSources },
    ...(localDirectory === cwd
      ? []
      : [{ cwd: localDirectory, settingSources: ["local" as const] }]),
  ];
});

/**
 * --settings as Claude Code keeps it: like a settings file, all of it or none when a field is
 * invalid. The SDK reads it as the project settings of a folder only this user can open, removed
 * once read.
 */
const validClaudeFlagSettings = Effect.fn("ClaudeAdapterV2.validLaunchArgSettings")(function* (
  settings: ClaudeSdkSettings,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-settings-" });
  yield* fileSystem.makeDirectory(path.join(directory, ".claude"));
  yield* fileSystem.writeFileString(
    path.join(directory, ".claude", "settings.json"),
    encodeClaudeJson(settings),
  );
  const [sources = []] = yield* Effect.tryPromise({
    try: () => resolveClaudeSettingsSources([{ cwd: directory, settingSources: ["project"] }]),
    catch: (cause) =>
      new ClaudeSettingsResolveError({ phase: "flag-validation", kind: "sdk-error", cause }),
  });
  return sources.find((entry) => entry.source === "project")?.settings as
    | ClaudeSdkSettings
    | undefined;
}, Effect.scoped);

const POLICY_HELPER_REASON =
  "Your organization computes Claude's settings with a policy helper, which T3.CodeShip cannot run.";
const POLICY_CACHE_REASON = "Claude's cached organization settings could not be read.";

// Claude Code reads its own key in policyHelpers, and WSL the linux one next. Any Linux counts
// both, since telling WSL apart only matters for an entry that would be read in vain.
const POLICY_HELPER_KEYS: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
  darwin: ["macos"],
  linux: ["wsl", "linux"],
  win32: ["windows"],
};

/**
 * resolveSettings passes policyHelper and policyHelpers (which the SDK types leave out) through
 * unchanged: it runs no helper and applies no static payload. Claude Code applies this platform's
 * entry, else the map's "default" payload, else policyHelper.
 */
const claudePolicyHelperApplies = (effective: ClaudeSdkSettings, platform: NodeJS.Platform) => {
  const { policyHelper, policyHelpers } = effective as ClaudeSdkSettings & {
    readonly policyHelpers?: unknown;
  };
  if (policyHelper != null) return true;
  if (policyHelpers == null) return false;
  if (typeof policyHelpers !== "object" || Array.isArray(policyHelpers)) return true;
  const entries = policyHelpers as Record<string, unknown>;
  return ["default", ...(POLICY_HELPER_KEYS[platform] ?? [])].some((key) => entries[key] != null);
};

export interface ClaudeSettingsCascadeInput {
  /** The account's config folder, which holds its user settings and its organization's cache. */
  readonly homePath: string;
  /** The account's environment, in which its user settings are resolved. */
  readonly environment: NodeJS.ProcessEnv;
  /** Without a folder, the project and local tiers do not apply. */
  readonly cwd: string | null;
  readonly settingSources: ReadonlyArray<ClaudeSettingSource>;
  readonly projectConfigRoot: string | undefined;
  /** The --settings Claude Code receives: for a turn, what `claudeFlagSettings` gives. */
  readonly flagSettings: ClaudeSdkSettings | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

export interface ClaudeSettingsCascade {
  /** Lowest precedence first: user, project, local, --settings, then the policy tier. */
  readonly tiers: ReadonlyArray<ClaudeSdkSettings>;
  /**
   * Why Claude Code's policy tier may hold settings `tiers` lacks: a policy helper applies, or the
   * organization's cache cannot be read, so Claude Code fetches what it holds.
   */
  readonly unreadablePolicy: string | undefined;
  /** Claude Code drops --settings whole for an invalid field, so `tiers` leaves it out. */
  readonly flagRejected: boolean;
}

/**
 * The settings Claude Code loads in `cwd`, one object per tier, each judged whole as Claude Code
 * judges it. The policy tier (managed files, their drop-ins, MDM and the organization's settings)
 * comes from resolveSettings given the account's own cache: by default it would read this
 * process's, which belongs to another account.
 */
export const readClaudeSettingsCascade = Effect.fn("ClaudeSettingsCascade.read")(
  function* (input: ClaudeSettingsCascadeInput) {
    const { fileSystem, path } = input;
    const files = yield* resolveClaudeSettingsFiles(
      input.homePath,
      input.environment,
      yield* claudeSettingsReads(input),
    ).pipe(Effect.provideService(Path.Path, path));
    const flag =
      input.flagSettings === undefined
        ? undefined
        : yield* validClaudeFlagSettings(input.flagSettings, fileSystem, path);
    // An empty object tells resolveSettings there is no organization cache. Claude Code also starts
    // without one it cannot read, and then fetches the organization's settings.
    const remote = yield* fileSystem
      .readFileString(path.join(input.homePath, "remote-settings.json"))
      .pipe(
        Effect.flatMap(decodeClaudeSettingsObject),
        Effect.asSome,
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedSome({})),
        Effect.catch((error) =>
          Effect.logWarning(POLICY_CACHE_REASON, { reason: error.message }).pipe(
            Effect.as(Option.none<Record<string, unknown>>()),
          ),
        ),
      );
    const policy = yield* Effect.tryPromise({
      try: () =>
        resolveClaudeSettings({
          settingSources: [],
          serverManagedSettings: claudeSdkShapedSettings(
            Option.getOrElse(remote, () => ({})) as ClaudeSdkSettings,
          ),
        }),
      catch: (cause) =>
        new ClaudeSettingsResolveError({ phase: "policy-resolution", kind: "sdk-error", cause }),
    });
    const tiers: ReadonlyArray<ClaudeSdkSettings> = [
      ...files,
      ...(flag === undefined ? [] : [flag]),
      policy.effective,
    ];
    return {
      tiers,
      unreadablePolicy: claudePolicyHelperApplies(policy.effective, yield* HostProcess.Platform)
        ? POLICY_HELPER_REASON
        : Option.isNone(remote)
          ? POLICY_CACHE_REASON
          : undefined,
      flagRejected: input.flagSettings !== undefined && flag === undefined,
    } satisfies ClaudeSettingsCascade;
  },
  Effect.tapErrorTag("ClaudeSettingsResolveError", ({ phase, kind }) =>
    Effect.logError("Claude's settings could not be resolved.", { phase, kind }),
  ),
);

/**
 * The cascade's tiers for a Claude provider outside a turn, whose launch arguments may limit them,
 * move them or add --settings, or None when they are not all Claude Code applies (see
 * `unreadablePolicy`) or cannot be read. Without a folder, --settings is left out, since a relative
 * one names a file in a folder.
 */
export const readConfirmedClaudeSettings = Effect.fn("ClaudeSettingsCascade.readConfirmed")(
  function* (input: {
    readonly settings: ClaudeLaunchArgs;
    readonly homePath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string | null;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    const { settings, ...location } = input;
    const launchArgSettings =
      location.cwd === null
        ? Effect.undefined
        : readClaudeLaunchArgSettings({ ...location, settings });
    return yield* launchArgSettings.pipe(
      Effect.flatMap((launchArgSettings) =>
        readClaudeSettingsCascade({
          ...location,
          settingSources: claudeSettingSources(settings),
          projectConfigRoot: claudeProjectConfigRoot(settings),
          flagSettings:
            launchArgSettings === undefined
              ? undefined
              : claudeSdkShapedSettings(launchArgSettings),
        }),
      ),
      Effect.map((cascade) =>
        cascade.unreadablePolicy === undefined ? Option.some(cascade.tiers) : Option.none(),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Claude's settings could not be read.", { reason: error.message }).pipe(
          Effect.as(Option.none<ReadonlyArray<ClaudeSdkSettings>>()),
        ),
      ),
    );
  },
);

/**
 * The `env` the tiers give Claude Code, later tiers winning. Claude Code coerces each value as
 * String() does: 600 becomes "600", true becomes "true".
 */
export const claudeSettingsEnvironment = (tiers: ReadonlyArray<ClaudeSdkSettings>) => {
  const environment: Record<string, string> = {};
  for (const tier of tiers) {
    for (const [name, value] of Object.entries(tier.env ?? {})) environment[name] = String(value);
  }
  return environment;
};

/** The `env` Claude Code applies from its settings in `cwd`; see readClaudeSettingsCascade. */
export const readClaudeSettingsEnvironment = Effect.fn("ClaudeAdapterV2.readSettingsEnvironment")(
  function* (input: ClaudeSettingsCascadeInput) {
    const { tiers, unreadablePolicy } = yield* readClaudeSettingsCascade(input);
    return { environment: claudeSettingsEnvironment(tiers), unreadablePolicy };
  },
);
