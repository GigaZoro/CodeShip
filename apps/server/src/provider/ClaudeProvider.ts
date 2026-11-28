// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps the token out of the snapshot.
import * as NodeCrypto from "node:crypto";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK's spawn hook returns a Node child process.
import * as NodeChildProcess from "node:child_process";

import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  settingsSecretLiteral,
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { envTrampoline, supportsEnvChdir } from "@t3tools/shared/envTrampoline";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SpawnWorker from "../process/SpawnWorker.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type ModelInfo as ClaudeModelInfo,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
  type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";

import { resolveCliVersion } from "@t3tools/provider-core/server/cliVersionMemory";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  parseGenericCliVersion,
  isCommandMissingCause,
  providerModelsFromSettings,
  providerProbeEnvironment,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  commandFailureReason,
  PROVIDER_OUTPUT_MAX_CHARS,
  providerFailureReason,
  providerOutputHead,
  redactProviderOutput,
  withProviderFailureReason,
} from "@t3tools/provider-core/server/providerOutput";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import {
  ClaudeTermsReviewRequiredError,
  claudeSignedOutMessage,
  hasClaudeManagedMcpConfig,
  isClaudeTermsReviewNotice,
  isClaudeTermsReviewRequiredError,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./Drivers/ClaudeHome.ts";
import {
  claudeSettingsEnvironment,
  claudeSettingSources,
  claudeSdkShapedSettings,
  readClaudeLaunchArgSettings,
  readConfirmedClaudeSettings,
} from "./Drivers/ClaudeSettingsCascade.ts";
import {
  customClaudeApiEndpointHost,
  readClaudeSettingsEnv,
  discoverClaudeSkills,
  resolveClaudeConfigDirPath,
} from "./Drivers/ClaudeSkills.ts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  CLAUDE_EFFORT_LEVELS,
  capClaudeCatalogEffort,
  type ClaudeEffortCapSource,
  type ClaudeEffortLevel,
  type ClaudeModelCatalog,
  claudeReportedModels,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
  withUltracodeToggle,
} from "./ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function claudeProviderModels(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ClaudeSettings["customModels"],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  ).map((model) =>
    model.isCustom ? { ...model, capabilities: withUltracodeToggle(model.capabilities) } : model,
  );
}

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
    case "claudemax5xsubscription":
      return "Max";
    case "claudemax20xsubscription":
      return "Ultra";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
    case "max5":
      return "Max";
    case "max20":
      return "Ultra";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function hasApiKey(apiKeySource: string | undefined): boolean {
  return Boolean(apiKeySource) && apiKeySource !== "none";
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
  readonly apiKeySource: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey" || hasApiKey(input.apiKeySource)) {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  // A long-lived token cannot read the account, so name the login instead of showing nothing.
  if (input.authMethod === "CLAUDE_CODE_OAUTH_TOKEN") {
    return { type: "oauthToken", label: "Claude token" };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/** Probe completion only proves Claude started. Only tokenSource: "none" disproves auth. */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // API keys can authenticate with tokenSource: none; also check key and account fields.
  return hasApiKey(capabilities.apiKeySource) || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// Bedrock initialization includes backend startup and awsAuthRefresh, taking longer than first-party auth.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
// Bounds the wait for a custom spawn's stderr after Claude exits; a child it started can hold it open.
const CAPABILITIES_PROBE_STDERR_DRAIN_MS = 1_000;
// Native CLI startup on Windows can exceed the shared probe deadline.
const CLAUDE_VERSION_CHECK_TIMEOUT_MS = 20_000;

const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/**
 * The SDK's own spawn stats the executable and hands libuv the workspace as cwd, so a mount
 * that stops answering freezes the server. `env` enters the cwd and finds the CLI in the child.
 * A shell would not do: dash drops the exported Bash functions a launcher may call.
 */
export function spawnClaudeProbeThroughEnv({
  command,
  args,
  cwd,
  env,
  signal,
}: ClaudeSpawnOptions) {
  const launch = envTrampoline(command, args, cwd) ?? { command, args, cwd };
  return NodeChildProcess.spawn(launch.command, launch.args, {
    ...("cwd" in launch ? { cwd: launch.cwd } : {}),
    env,
    signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Windows runs CreateProcess on the calling thread, so the probe launches from a launcher thread. */
function spawnClaudeProbeOffThread({ command, args, cwd, env, signal }: ClaudeSpawnOptions) {
  return SpawnWorker.spawnPiped(command, args, { cwd, env, signal, windowsHide: true });
}

export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly managedMcpConfig: boolean;
  readonly onStderr: (chunk: string) => void;
  /** Receives a custom spawn's stderr, which the SDK neither reads nor drains before it reports the exit. */
  readonly onSpawnedStderr: (stderr: NodeJS.ReadableStream) => void;
  readonly spawnVia: "env" | "launcher-thread" | undefined;
}): ClaudeQueryOptions {
  const spawn =
    input.spawnVia === "env"
      ? spawnClaudeProbeThroughEnv
      : input.spawnVia === "launcher-thread"
        ? spawnClaudeProbeOffThread
        : undefined;
  return {
    ...(spawn === undefined
      ? {}
      : {
          spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => {
            const child = spawn(options);
            input.onSpawnedStderr(child.stderr);
            return child;
          },
        }),
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // Keep settings for slash-command discovery, but disable hooks so health checks do not run SessionStart repeatedly.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Exclude filesystem MCP servers; omit strict mode when managed-mcp.json already excludes them and forbids the flag.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...providerProbeEnvironment(input.environment),
      // Disable claude.ai MCP separately; it is discovered outside filesystem config.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // Skipping this avoids a Windows tasklist | findstr process tree on every refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: input.onStderr,
  };
}

/**
 * Claude Code stopped before it initialized. `detail` is what it printed on stderr, or the SDK's
 * error when it printed nothing, with home paths, secrets and emails redacted.
 */
export class ClaudeCapabilitiesProbeFailedError extends Schema.TaggedError<ClaudeCapabilitiesProbeFailedError>()(
  "ClaudeCapabilitiesProbeFailedError",
  { detail: Schema.optional(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return withProviderFailureReason(
      "Claude Agent CLI failed while checking account status",
      this.detail === undefined ? undefined : providerFailureReason(this.detail),
    );
  }
}

const claudeProbeFailure = (
  stderr: string,
  cause: unknown,
  homeDirectory: string,
  environment: NodeJS.ProcessEnv,
): ClaudeTermsReviewRequiredError | ClaudeCapabilitiesProbeFailedError => {
  const causeMessage = cause instanceof Error ? cause.message : "";
  if (isClaudeTermsReviewNotice(stderr) || isClaudeTermsReviewNotice(causeMessage)) {
    return new ClaudeTermsReviewRequiredError({ cause });
  }
  const output = providerOutputHead(stderr.trim() !== "" ? stderr : causeMessage);
  const detail = redactProviderOutput(output, homeDirectory, environment);
  return new ClaudeCapabilitiesProbeFailedError({
    detail: detail === "" ? undefined : detail,
    cause,
  });
};

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly workspaceId?: string | undefined;
  /** `usageAccountKey` of the signed-in account, from `.claude.json`. */
  readonly accountKey?: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  /** OAuth applies only to firstParty; Bedrock uses external AWS credentials and omits subscription/token fields. */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly models?: ReadonlyArray<ClaudeModelInfo>;
  /** Undefined means get_usage failed; absent windows on success mean no subscription windows, as with API keys. */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly usageCheckedAt?: string;
  /** Each settings source's `maxEffortLevel` caps; Claude Code clamps every higher effort. */
  readonly effortCapSources?: ReadonlyArray<ClaudeEffortCapSource>;
};

// `getSettings` exists at runtime but is missing from the SDK's `Query` type, and older CLIs
// reject the control request.
type ClaudeSettingsQuery = {
  readonly getSettings?: () => Promise<{
    readonly effective?: unknown;
    readonly sources?: unknown;
  }>;
};

function parseClaudeMaxEffortLevel(value: unknown): ClaudeEffortLevel | undefined {
  return CLAUDE_EFFORT_LEVELS.find((level) => level === value);
}

function parseClaudeModelMaxEffortLevels(
  modelSettings: unknown,
): ReadonlyMap<string, ClaudeEffortLevel> | undefined {
  if (!modelSettings || typeof modelSettings !== "object") return undefined;
  const levels = new Map<string, ClaudeEffortLevel>();
  for (const [model, settings] of Object.entries(modelSettings)) {
    const level = parseClaudeMaxEffortLevel(
      settings && typeof settings === "object"
        ? (settings as { readonly maxEffortLevel?: unknown }).maxEffortLevel
        : undefined,
    );
    if (level) levels.set(model, level);
  }
  return levels.size > 0 ? levels : undefined;
}

function parseClaudeEffortCapSource(settings: unknown): ClaudeEffortCapSource | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const { maxEffortLevel, modelSettings } = settings as {
    readonly maxEffortLevel?: unknown;
    readonly modelSettings?: unknown;
  };
  const level = parseClaudeMaxEffortLevel(maxEffortLevel);
  const modelMaxEffortLevels = parseClaudeModelMaxEffortLevels(modelSettings);
  return level || modelMaxEffortLevels
    ? {
        ...(level ? { maxEffortLevel: level } : {}),
        ...(modelMaxEffortLevels ? { modelMaxEffortLevels } : {}),
      }
    : undefined;
}

// `sources` holds each settings file's raw settings. CLIs that report only the merged `effective`
// settings are read as a single source.
function parseClaudeEffortCapSources(
  settings: { readonly effective?: unknown; readonly sources?: unknown } | undefined,
): ReadonlyArray<ClaudeEffortCapSource> | undefined {
  const sources = Array.isArray(settings?.sources)
    ? settings.sources.flatMap((source) => {
        const parsed = parseClaudeEffortCapSource(
          source && typeof source === "object"
            ? (source as { readonly settings?: unknown }).settings
            : undefined,
        );
        return parsed ? [parsed] : [];
      })
    : [parseClaudeEffortCapSource(settings?.effective)].filter((source) => source !== undefined);
  return sources.length > 0 ? sources : undefined;
}

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * With gateway model discovery on, Claude Code refreshes its model cache in the background after
 * initialization, so the probe subprocess outlives init by Claude Code's discovery timeout.
 */
function claudeGatewayDiscoveryGraceMs(environment: Readonly<Record<string, unknown>>): number {
  const enabled = String(environment.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "")
    .trim()
    .toLowerCase();
  if (!enabled || enabled === "0" || enabled === "false") return 0;
  if (!String(environment.ANTHROPIC_BASE_URL ?? "").trim()) return 0;
  const configured = Number(environment.CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 3_000;
}

class ClaudeCapabilitiesProbeSdkError extends Schema.TaggedError<ClaudeCapabilitiesProbeSdkError>()(
  "ClaudeCapabilitiesProbeSdkError",
  { operation: Schema.Literals(["initialize", "usage", "settings"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Claude capability probe ${this.operation} failed.`;
  }
}

/** A never-yielding prompt allows local initialization IPC without sending an Anthropic request. */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeStatus = true,
  launch?: Pick<ClaudeQueryOptions, "settings" | "settingSources" | "extraArgs">,
) => {
  const abort = new AbortController();
  const abortProbe = Effect.sync(() => {
    if (!abort.signal.aborted) abort.abort();
  });
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
      cwd,
    );
    const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
    const homeDirectory = yield* HostProcess.HomeDirectory;
    // Claude names why it refused to start only on stderr.
    let stderr = "";
    let stderrClosed: Promise<void> = Promise.resolve();
    const appendStderr = (chunk: string) => {
      // One character past the cap lets providerOutputHead see the output was cut.
      if (stderr.length <= PROVIDER_OUTPUT_MAX_CHARS) {
        stderr = `${stderr}${chunk}`.slice(0, PROVIDER_OUTPUT_MAX_CHARS + 1);
      }
    };
    // Workspace probes (no usage) discard models; the machine probe refreshes the shared cache.
    const graceMs = includeStatus
      ? claudeGatewayDiscoveryGraceMs({
          ...claudeEnvironment,
          ...(yield* readClaudeSettingsEnv(claudeSettings, cwd, claudeEnvironment)),
        })
      : 0;
    const platform = yield* HostProcess.Platform;
    const spawnVia =
      platform === "win32"
        ? "launcher-thread"
        : platform === "linux" && (yield* Effect.promise(supportsEnvChdir))
          ? "env"
          : undefined;
    return yield* Effect.tryPromise({
      try: async () => {
        const q = claudeQuery({
          // oxlint-disable-next-line require-yield -- never yields, so no prompt reaches the API
          prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
            await waitForAbortSignal(abort.signal);
          })(),
          options: {
            ...buildClaudeCapabilitiesProbeQueryOptions({
              executablePath,
              abortController: abort,
              environment: claudeEnvironment,
              cwd,
              managedMcpConfig,
              spawnVia,
              onStderr: appendStderr,
              onSpawnedStderr: (spawnedStderr) => {
                stderrClosed = new Promise((resolve) =>
                  spawnedStderr.once("close", () => resolve()),
                );
                spawnedStderr.setEncoding("utf8").on("data", appendStderr);
              },
            }),
            ...launch,
          },
        });
        const init = await q.initializationResult();
        return { q, init, graceMs };
      },
      catch: (cause) => new ClaudeCapabilitiesProbeSdkError({ operation: "initialize", cause }),
    }).pipe(
      Effect.catch(({ cause }) =>
        Effect.promise(() => stderrClosed).pipe(
          Effect.timeoutOption(CAPABILITIES_PROBE_STDERR_DRAIN_MS),
          Effect.flatMap(() =>
            Effect.fail(claudeProbeFailure(stderr, cause, homeDirectory, claudeEnvironment)),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.timeout(
      resolveProviderProbeTimeoutMs("claude", CAPABILITIES_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.flatMap(({ q, init, graceMs }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        // The effort caps are read in parallel under the same deadline; workspace probes skip both.
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const { getSettings } = q as ClaudeSettingsQuery;
        const [usageResult, settingsResult] = yield* Effect.all(
          [
            includeStatus
              ? Effect.tryPromise({
                  try: () =>
                    q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
                      skipBehaviors: true,
                    }),
                  catch: (cause) =>
                    new ClaudeCapabilitiesProbeSdkError({ operation: "usage", cause }),
                }).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
              : Effect.undefined,
            includeStatus && getSettings
              ? Effect.tryPromise({
                  try: () => getSettings.call(q),
                  catch: (cause) =>
                    new ClaudeCapabilitiesProbeSdkError({ operation: "settings", cause }),
                }).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
              : Effect.undefined,
          ],
          { concurrency: "unbounded" },
        );
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const effortCapSources = parseClaudeEffortCapSources(
          settingsResult && Result.isSuccess(settingsResult) ? settingsResult.success : undefined,
        );
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(init.models?.length ? { models: init.models } : {}),
          ...(usage ? { usage, usageCheckedAt } : {}),
          ...(effortCapSources ? { effortCapSources } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }).pipe(
        Effect.tap(() =>
          graceMs > 0
            ? Effect.sleep(graceMs).pipe(Effect.andThen(abortProbe), Effect.forkDetach)
            : abortProbe,
        ),
      ),
    ),
    Effect.onError(() => abortProbe),
    // Claude's stderr can name the account, so it goes only to the provider status, never the log.
    Effect.tapError((error) =>
      Effect.logWarning("Claude capability probe failed.", { errorTag: error._tag }),
    ),
  );
};

type ClaudeCapabilitiesProbeError = Effect.Error<ReturnType<typeof probeClaudeCapabilities>>;

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    cwd,
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const probeClaudeWorkspaceSnapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
  claudeSettings: ClaudeSettings,
  machineSnapshot: ServerProvider,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ProviderWorkspaceSnapshot,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  if (!claudeSettings.enabled) return machineSnapshot;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
  const fileSystem = yield* FileSystem.FileSystem;
  // A deleted worktree can never answer the probe. Pending would make clients rescan it forever.
  const cwdExists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true));
  const probeResult = cwdExists
    ? yield* probeClaudeCapabilities(claudeSettings, environment, cwd, false).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  return {
    ...machineSnapshot,
    skills,
    slashCommands: dedupeSlashCommands([
      COMPACT_SLASH_COMMAND,
      ...(capabilities?.slashCommands ?? []),
    ]),
    slashCommandsPending: cwdExists && !capabilities,
  };
});

/**
 * Names the login behind a Claude instance, so two instances on one login count as one account
 * even when Claude reports no email: the CLI's saved login belongs to its config folder, and a
 * `CLAUDE_CODE_OAUTH_TOKEN` is its own login. A saved login reports no token source.
 */
const claudeLoginProfileId = Effect.fn("claudeLoginProfileId")(function* (
  claudeSettings: ClaudeSettings,
  capabilities: ClaudeCapabilitiesProbe,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  if ((capabilities.apiProvider ?? "firstParty") !== "firstParty") return undefined;
  if ((capabilities.apiKeySource ?? "none") !== "none") return undefined;
  const token = environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (capabilities.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN" && token) {
    return `oauth-token:${NodeCrypto.createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }
  if (capabilities.tokenSource !== undefined && capabilities.tokenSource !== "claude.ai") {
    return undefined;
  }
  return `claude.ai:${yield* resolveClaudeHomePath(claudeSettings, environment)}`;
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined, ClaudeCapabilitiesProbeError>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  /** The account's limit resets, read beside its usage; subscription logins only. */
  resolveResetCredits?: (
    usageLimits: ServerProviderUsageLimits,
  ) => Effect.Effect<
    Pick<ServerProviderUsageLimits, "resetCredits" | "resetCreditsError" | "resetPrograms">
  >,
  /** When the saved subscription login stops renewing; undefined when unknown. */
  resolveLoginExpiry?: Effect.Effect<string | undefined>,
  /** The version this instance last reported, used when `--version` misses its deadline. */
  lastKnownVersion: string | null = null,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = claudeProviderModels(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3.CodeShip settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    providerProbeEnvironment(resolvedEnvironment),
    cwd,
  ).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("claude", CLAUDE_VERSION_CHECK_TIMEOUT_MS, resolvedEnvironment),
    ),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  const resolvedVersion = yield* resolveCliVersion({
    cli: "Claude Agent CLI",
    output: versionProbe.success,
    lastKnownVersion,
    parse: parseGenericCliVersion,
  });
  if (resolvedVersion === null) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Claude Agent CLI did not answer \`claude --version\` within ${CLAUDE_VERSION_CHECK_TIMEOUT_MS / 1_000}s.`,
      },
    });
  }

  const { output: version, version: parsedVersion } = resolvedVersion;
  if (version !== undefined && version.code !== 0) {
    const reason = commandFailureReason(
      version,
      yield* HostProcess.HomeDirectory,
      resolvedEnvironment,
    );
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      ...(reason === undefined ? {} : { reason }),
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        // A failed `--version` run reports no version: its output can be a wrapper's, such as mise's.
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: withProviderFailureReason(
          "Claude Agent CLI is installed but failed to run",
          reason,
        ),
      },
    });
  }

  const updateRequiredModels = resolveClaudeUpdateRequiredModels(modelCatalog, parsedVersion);
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const probeResult = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  const probeFailure =
    probeResult && Result.isFailure(probeResult) ? probeResult.failure : undefined;
  const models = capClaudeCatalogEffort(
    modelCatalog,
    claudeProviderModels(
      [
        ...resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
        ...claudeReportedModels(modelCatalog, claudeSettings.customModels, capabilities?.models),
      ],
      claudeSettings.customModels,
    ),
    capabilities?.effortCapSources ?? [],
  );
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        // Pending terms block every session for this account, so they are an error, not an unverified check.
        status: isClaudeTermsReviewRequiredError(probeFailure) ? "error" : "warning",
        auth: { status: "unknown" },
        message:
          probeFailure === undefined
            ? "Could not verify Claude authentication status from initialization result."
            : Cause.isTimeoutError(probeFailure)
              ? `Timed out after ${resolveProviderProbeTimeoutMs("claude", CAPABILITIES_PROBE_TIMEOUT_MS, resolvedEnvironment) / 1_000}s while checking Claude account status.`
              : probeFailure.message,
      },
    });
  }

  // First-party account fields cannot verify custom endpoint credentials. The status speaks for
  // every folder, so the tiers relative to one are left out.
  const settings = yield* readConfirmedClaudeSettings({
    settings: claudeSettings,
    homePath: yield* resolveClaudeConfigDirPath(claudeSettings, resolvedEnvironment, cwd),
    environment: resolvedEnvironment,
    cwd: null,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
  });
  const baseUrl =
    Option.match(settings, {
      onNone: () => undefined,
      onSome: (tiers) => claudeSettingsEnvironment(tiers).ANTHROPIC_BASE_URL,
    }) ?? resolvedEnvironment.ANTHROPIC_BASE_URL;
  const customApiEndpoint = customClaudeApiEndpointHost(baseUrl) !== undefined;
  const endpoint = customApiEndpoint ? URL.parse(baseUrl?.trim() ?? "")?.origin : undefined;
  if (!customApiEndpoint && claudeAuthStatus(capabilities) === "unauthenticated") {
    // A lapsed login reads as signed out; its date tells the person why.
    const loginExpiresAt =
      resolveLoginExpiry && Option.isSome(settings) ? yield* resolveLoginExpiry : undefined;
    const path = yield* Path.Path;
    const configDir = (yield* makeClaudeEnvironment(claudeSettings, resolvedEnvironment))
      .CLAUDE_CONFIG_DIR;
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      // Settings T3.CodeShip cannot read may send Claude to an endpoint with a login of its own.
      probe: Option.isNone(settings)
        ? {
            installed: true,
            version: parsedVersion,
            status: "warning",
            auth: { status: "unknown" },
            message:
              "T3.CodeShip could not read all of Claude's settings here, so it cannot confirm the Claude login.",
          }
        : {
            installed: true,
            version: parsedVersion,
            status: "error",
            auth: {
              status: "unauthenticated",
              ...(loginExpiresAt ? { loginExpiresAt } : {}),
            },
            message:
              configDir === undefined
                ? "Claude Code is not authenticated. Run `claude auth login` and try again."
                : claudeSignedOutMessage({ configDir, cwd: path.resolve(cwd ?? ".") }),
          },
    });
  }

  // A proxy's ANTHROPIC_AUTH_TOKEN reads as an API key; the endpoint is what the token is for.
  const authMetadata =
    apiProviderAuthMetadata(capabilities.apiProvider) ??
    (customApiEndpoint
      ? { type: "customEndpoint", label: "Custom API endpoint", ...(endpoint ? { endpoint } : {}) }
      : undefined) ??
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
      apiKeySource: capabilities.apiKeySource,
    });
  const usesApiKey =
    Boolean(capabilities.apiKeySource && capabilities.apiKeySource !== "none") ||
    normalizeClaudeAuthMethod(capabilities.tokenSource) === "apiKey";
  const billingMismatch =
    claudeSettings.billingKind === "payPerUse"
      ? !settingsSecretLiteral(claudeSettings.apiKey) || !usesApiKey
      : usesApiKey;
  const billingMessage =
    claudeSettings.billingKind === "payPerUse"
      ? "Claude API credit requires a configured API key."
      : "This Claude account uses an API key. Select pay-per-use billing or sign in with a subscription.";
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  // A setup-token OAuth login can stream subscription windows without get_usage support.
  // Do not reclassify API-key, custom-endpoint, or third-party backend accounts.
  const allowStreamedLimits =
    !customApiEndpoint &&
    capabilities.apiProvider === "firstParty" &&
    capabilities.apiKeySource === "none" &&
    (capabilities.tokenSource === "oauth" ||
      capabilities.tokenSource === "CLAUDE_CODE_OAUTH_TOKEN");
  const nativeApiKey =
    !customApiEndpoint &&
    capabilities.apiProvider === "firstParty" &&
    normalizeClaudeAuthMethod(capabilities.apiKeySource) === "apiKey";
  const funding =
    authMetadata?.type === "apiKey" || authMetadata?.type === "bedrock" || nativeApiKey
      ? "metered"
      : "unknown";
  const usageReading = !capabilities.usage
    ? makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        ...(allowStreamedLimits
          ? {
              message:
                "This Claude login cannot probe limits. Limits will appear when a turn reports them.",
            }
          : {}),
      })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
          allowStreamedLimits,
        })
      : claudeUsageResponseToLimits({
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
          allowStreamedLimits,
        }).limits;
  const usageLimits = {
    ...usageReading,
    ...(capabilities.accountKey ? { accountKey: capabilities.accountKey } : {}),
    ...(capabilities.subscriptionType ? { plan: capabilities.subscriptionType } : {}),
  };
  const loginProfileId = customApiEndpoint
    ? undefined
    : yield* claudeLoginProfileId(claudeSettings, capabilities, resolvedEnvironment);
  // Only a saved subscription login renews on a schedule; keys, tokens and other backends do not.
  const loginExpiresAt =
    resolveLoginExpiry && loginProfileId?.startsWith("claude.ai:")
      ? yield* resolveLoginExpiry
      : undefined;
  const resetFields =
    resolveResetCredits &&
    capabilities.subscriptionType &&
    usageLimits.unavailable?.reason !== "unsupported"
      ? yield* resolveResetCredits(usageLimits)
      : undefined;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: billingMismatch ? "error" : "ready",
      auth: {
        status: billingMismatch ? "unauthenticated" : "authenticated",
        funding,
        ...(funding === "unknown" && capabilities.apiProvider === "firstParty"
          ? { fundingScope: "workspace" as const }
          : {}),
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(loginProfileId ? { profileId: loginProfileId } : {}),
        ...(loginExpiresAt ? { loginExpiresAt } : {}),
        ...(capabilities.workspaceId ? { workspaceId: capabilities.workspaceId } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(billingMismatch
        ? { message: billingMessage }
        : versionUpgradeMessage
          ? { message: versionUpgradeMessage }
          : {}),
      usageLimits: resetFields ? { ...usageLimits, ...resetFields } : usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = Effect.fn("ClaudeProvider.makePendingClaudeProvider")(
  function* (
    claudeSettings: ClaudeSettings,
    modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  ): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* nowIso;
    const models = claudeProviderModels(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3.CodeShip settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  },
);

/** This check uses the actual launch folder and sends no prompt. The usage endpoint explicitly reports whether extra usage can cover sends. */
export const claudeWorkspaceFunding = Effect.fn("ClaudeProvider.workspaceFunding")(
  function* (
    settings: ClaudeSettings,
    inherited: NodeJS.ProcessEnv,
    input: { readonly cwd: string; readonly provider: ServerProvider },
    probe: typeof probeClaudeCapabilities = probeClaudeCapabilities,
  ) {
    const { cwd, provider } = input;
    if (
      !settings.enabled ||
      provider.status !== "ready" ||
      provider.auth.status !== "authenticated" ||
      (!provider.auth.email && !provider.auth.profileId)
    )
      return "unknown" as const;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* makeClaudeEnvironment(settings, inherited);
    const homePath = yield* resolveClaudeConfigDirPath(settings, environment, cwd);
    const tiers = yield* readConfirmedClaudeSettings({
      settings,
      cwd,
      homePath,
      environment,
      fileSystem,
      path,
    });
    if (Option.isNone(tiers)) return "unknown" as const;
    const settingsEnv = claudeSettingsEnvironment(tiers.value);
    const effective = { ...environment, ...settingsEnv };
    const url = effective.ANTHROPIC_BASE_URL?.trim();
    if (
      (url && URL.parse(url)?.href !== "https://api.anthropic.com/") ||
      effective.ANTHROPIC_API_KEY ||
      effective.ANTHROPIC_AUTH_TOKEN ||
      effective.ANTHROPIC_CUSTOM_HEADERS ||
      tiers.value.some(
        ({ settings: tier }) =>
          tier.apiKeyHelper ||
          (tier.forceLoginMethod && tier.forceLoginMethod !== "claudeai") ||
          (tier.forceLoginOrgUUID &&
            (!provider.auth.workspaceId ||
              ![tier.forceLoginOrgUUID].flat().includes(provider.auth.workspaceId))),
      ) ||
      (settingsEnv.CLAUDE_CONFIG_DIR !== undefined &&
        settingsEnv.CLAUDE_CONFIG_DIR !== environment.CLAUDE_CONFIG_DIR) ||
      (settingsEnv.CLAUDE_CODE_OAUTH_TOKEN !== undefined &&
        settingsEnv.CLAUDE_CODE_OAUTH_TOKEN !== environment.CLAUDE_CODE_OAUTH_TOKEN)
    )
      return "unknown" as const;
    const { flags, positionals } = parseCliArgs(settings.launchArgs);
    // An unmodelled launch flag could change the selected account, environment, or backend.
    if (
      positionals.length ||
      Object.keys(flags).some(
        (flag) =>
          ![
            "settings",
            "setting-sources",
            "project-config-root",
            "permission-mode",
            "dangerously-skip-permissions",
            "effort",
            "append-system-prompt",
            "append-system-prompt-file",
            "add-dir",
          ].includes(flag),
      )
    )
      return "unknown" as const;
    const launchSettings = yield* readClaudeLaunchArgSettings({ settings, cwd, fileSystem, path });
    const capabilities = yield* probe(settings, environment, cwd, true, {
      settingSources: [...claudeSettingSources(settings)],
      settings: {
        ...(launchSettings ? claudeSdkShapedSettings(launchSettings) : {}),
        disableAllHooks: true,
      },
      ...(flags["project-config-root"] === undefined
        ? {}
        : { extraArgs: { "project-config-root": flags["project-config-root"] } }),
    });
    if (
      capabilities.apiProvider !== "firstParty" ||
      capabilities.apiKeySource !== "none" ||
      !(
        ["oauth", "claude.ai", "CLAUDE_CODE_OAUTH_TOKEN"].includes(
          capabilities.tokenSource ?? "",
        ) ||
        (capabilities.tokenSource === undefined &&
          capabilities.email &&
          capabilities.subscriptionType)
      ) ||
      (provider.auth.email && provider.auth.email !== capabilities.email) ||
      (provider.usageLimits?.plan && capabilities.subscriptionType !== provider.usageLimits.plan) ||
      (provider.auth.profileId &&
        provider.auth.profileId !==
          (yield* claudeLoginProfileId(settings, capabilities, environment)))
    )
      return "unknown" as const;
    const limits = capabilities.usage?.rate_limits;
    if (!capabilities.usage?.rate_limits_available || !limits) return "unknown" as const;
    const spend = (limits as { readonly spend?: { readonly enabled?: unknown } | null }).spend;
    if (limits.extra_usage?.is_enabled === true || spend?.enabled === true)
      return "metered" as const;
    return limits.extra_usage?.is_enabled === false && (spend == null || spend.enabled === false)
      ? ("included" as const)
      : ("unknown" as const);
  },
  Effect.catchCause(() => Effect.succeed("unknown" as const)),
);

export { probeClaudeCapabilities };
