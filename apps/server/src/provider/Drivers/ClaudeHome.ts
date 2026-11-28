import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts/providerInstance";
import type { ClaudeSettings } from "@t3tools/contracts/settings";
import { settingsSecretLiteral } from "@t3tools/contracts/settingsSecretValue";
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

export class ClaudeBillingConfigurationError extends Schema.TaggedError<ClaudeBillingConfigurationError>()(
  "ClaudeBillingConfigurationError",
  {},
) {
  override get message(): string {
    return "Configure this account's Billing and required API key settings, and remove conflicting authentication overrides from Claude settings.";
  }
}

export const validateClaudeBillingSettings = Effect.fn("validateClaudeBillingSettings")(function* (
  config: Pick<ClaudeSettings, "billingKind" | "apiKey">,
  tiers: ReadonlyArray<{
    readonly env?: Readonly<Record<string, string>>;
    readonly apiKeyHelper?: string;
  }>,
  baseEnvironment: NodeJS.ProcessEnv = {},
) {
  const environment = {
    ...baseEnvironment,
    ...Object.fromEntries(tiers.flatMap((tier) => Object.entries(tier.env ?? {}))),
  };
  const alternateBackend = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((key) => {
    const value = environment[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
  });
  const apiKey = config.billingKind === "payPerUse" ? settingsSecretLiteral(config.apiKey) : "";
  if (
    alternateBackend ||
    (environment.ANTHROPIC_BASE_URL &&
      environment.ANTHROPIC_BASE_URL.replace(/\/$/, "") !== "https://api.anthropic.com") ||
    (config.billingKind === "payPerUse" && !apiKey.trim()) ||
    tiers.some((tier) => Boolean(tier.apiKeyHelper)) ||
    (environment.ANTHROPIC_API_KEY && environment.ANTHROPIC_API_KEY !== apiKey) ||
    environment.ANTHROPIC_AUTH_TOKEN ||
    (config.billingKind === "payPerUse" && environment.CLAUDE_CODE_OAUTH_TOKEN)
  )
    return yield* new ClaudeBillingConfigurationError({});
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> &
    Partial<Pick<ClaudeSettings, "billingKind" | "apiKey">>,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = { ...(baseEnv ?? process.env) };
  resolvedBaseEnv.ANTHROPIC_API_KEY = "";
  resolvedBaseEnv.ANTHROPIC_AUTH_TOKEN = "";
  if (config.billingKind === "payPerUse") {
    resolvedBaseEnv.CLAUDE_CODE_OAUTH_TOKEN = "";
    const apiKey = settingsSecretLiteral(config.apiKey);
    if (apiKey) resolvedBaseEnv.ANTHROPIC_API_KEY = apiKey;
  }
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Base env for the Claude processes T3.CodeShip runs, before `makeClaudeEnvironment`.
 * Claude Code reads its entrypoint from the process env, not its settings `env`, so T3.CodeShip applies that override itself.
 */
export const mergeClaudeProcessEnvironment = Effect.fn("mergeClaudeProcessEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "launchArgs">>,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entrypoint = yield* findProviderInstanceEnvironmentVariable(
    instanceEnvironment,
    "CLAUDE_CODE_ENTRYPOINT",
  );
  const merged = yield* mergeProviderInstanceEnvironment(
    entrypoint === undefined ? undefined : [entrypoint],
    { ...hostEnvironment, CLAUDE_CODE_ENTRYPOINT: "t3-code" },
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
