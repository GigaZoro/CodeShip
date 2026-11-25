import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ClaudeSettings,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  findProviderInstanceEnvironmentVariable,
  mergeProviderInstanceEnvironment,
} from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claudeProjectConfigRoot,
  claudeSettingSources,
  claudeSettingsEnvironment,
  readClaudeSettingsCascade,
} from "./ClaudeSettingsCascade.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(
  ProviderDriverKind.make("claudeAgent"),
);

/**
 * A `CLAUDE_CODE_OAUTH_TOKEN` overrides Claude's saved login, so the machine's token belongs to
 * the default provider only. Any other provider keeps its own sign-in unless its settings set one.
 * A blank token in a provider's settings hides the machine's token so that provider can sign in.
 */
export const mergeClaudeInstanceEnvironment = Effect.fn("mergeClaudeInstanceEnvironment")(
  function* (
    instanceId: ProviderInstanceId,
    environment: ProviderInstanceEnvironment | undefined,
    hostEnvironment: NodeJS.ProcessEnv,
  ) {
    const { CLAUDE_CODE_OAUTH_TOKEN: _machineToken, ...withoutToken } = hostEnvironment;
    const merged = yield* mergeProviderInstanceEnvironment(
      environment,
      instanceId === DEFAULT_CLAUDE_INSTANCE_ID ? hostEnvironment : withoutToken,
    );
    if (merged.CLAUDE_CODE_OAUTH_TOKEN?.trim() !== "") return merged;
    const { CLAUDE_CODE_OAUTH_TOKEN: _blankToken, ...withoutBlankToken } = merged;
    return withoutBlankToken;
  },
);

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

// A Claude Code session that launched T3 exports these. A claude spawned with them acts as part of
// that session: its session id, messaging socket and token, and effort.
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

/**
 * Base env for the Claude processes T3.CodeShip runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3.CodeShip applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete baseEnvironment[name];
  // The desktop runs the server as Node through Electron. Commands Claude runs inherit its env, so
  // an Electron app they start (T3.CodeShip itself, VS Code) would run as Node and exit.
  delete baseEnvironment.ELECTRON_RUN_AS_NODE;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entrypoint = yield* findProviderInstanceEnvironmentVariable(
    instanceEnvironment,
    "CLAUDE_CODE_ENTRYPOINT",
  );
  const merged = yield* mergeProviderInstanceEnvironment(
    entrypoint === undefined ? undefined : [entrypoint],
    baseEnvironment,
  );
  // Claude resolves a relative folder against each process's working directory, which differs by
  // project. It names its Keychain item from the exact value, so an absolute one passes unchanged.
  const configDir = merged.CLAUDE_CONFIG_DIR?.trim();
  const environment =
    configDir && !path.isAbsolute(configDir)
      ? { ...merged, CLAUDE_CONFIG_DIR: path.resolve(configDir) }
      : merged;
  // One entrypoint serves every folder, so the tiers relative to one are left out. It is only a
  // label, so one set by policy T3.CodeShip cannot read may be missing.
  const settingsEntrypoint = yield* readClaudeSettingsCascade({
    homePath: yield* resolveClaudeHomePath(config, environment),
    environment,
    cwd: null,
    settingSources: claudeSettingSources(config),
    projectConfigRoot: claudeProjectConfigRoot(config),
    flagSettings: undefined,
    fileSystem,
    path,
  }).pipe(
    Effect.map(({ tiers }) => claudeSettingsEnvironment(tiers).CLAUDE_CODE_ENTRYPOINT),
    Effect.catch((error) =>
      Effect.logWarning("Claude's settings entrypoint could not be read.", {
        reason: error.message,
      }).pipe(Effect.as(undefined)),
    ),
  );
  return settingsEntrypoint
    ? { ...environment, CLAUDE_CODE_ENTRYPOINT: settingsEntrypoint }
    : environment;
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

// A worktree's .git file points at <main>/.git/worktrees/<name>, whose commondir leads back to
// <main>/.git. A bare repository has no main checkout, so its worktree keeps its own file.
// Untraced because claudeLocalSettingsDirectory already owns the span.
const mainCheckoutRoot = Effect.fnUntraced(function* (checkout: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(checkout, ".git")).pipe(
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
});

// Claude Code keeps .claude/settings.local.json at the repository root, or in cwd outside a
// repository, on Windows, or when the root is home. Its owner check is skipped, so callers must
// stay safe when Claude Code ignores the root file.
export const claudeLocalSettingsDirectory = Effect.fn("claudeLocalSettingsDirectory")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") return cwd;
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const isCheckout = yield* fileSystem
      .exists(path.join(directory, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isCheckout) {
      const root = yield* mainCheckoutRoot(directory);
      return root === (yield* HostProcess.HomeDirectory) ? cwd : root;
    }
    if (path.dirname(directory) === directory) return cwd;
  }
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * After Anthropic's updated Consumer Terms take effect, Claude Code refuses to start a non-interactive
 * session for an account that has not answered them, prints this notice on stderr and exits 1. Only an
 * interactive `claude` lets the account's owner answer.
 */
const CLAUDE_TERMS_REVIEW_NOTICE = /\[ACTION REQUIRED\][^\n]*Consumer Terms/;

export const isClaudeTermsReviewNotice = (text: string): boolean =>
  CLAUDE_TERMS_REVIEW_NOTICE.test(text);

export const CLAUDE_TERMS_REVIEW_MESSAGE =
  "Anthropic updated its Consumer Terms, and Claude won't start for this account until they are reviewed. In Settings → Providers & models, select Sign in for this account to review them.";

/** Claude Code refused to start because its account has not reviewed Anthropic's updated Consumer Terms. */
export class ClaudeTermsReviewRequiredError extends Schema.TaggedError<ClaudeTermsReviewRequiredError>()(
  "ClaudeTermsReviewRequiredError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return CLAUDE_TERMS_REVIEW_MESSAGE;
  }
}

export const isClaudeTermsReviewRequiredError = Schema.is(ClaudeTermsReviewRequiredError);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then resume this thread, or send your message again if Claude had not started on it. For API-key authentication, check this instance's configured credentials.`;
};
