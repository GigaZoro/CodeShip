import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import { pipe } from "effect/Function";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  ProviderInstanceId,
  CodexSettings,
  CustomModelSetting,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  PREFERRED_DEFAULT_CODEX_MODELS,
  ProviderSkillError,
  ServerSettingsError,
} from "@t3tools/contracts";

import {
  codexModelFamily,
  createModelCapabilities,
  formatCodexModelName,
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import { isCodexLoginRejected } from "./CodexLoginRejected.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  providerModelsFromSettings,
  providerProbeEnvironment,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  providerOutputReason,
  withProviderFailureReason,
} from "@t3tools/provider-core/server/providerOutput";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  type CodexRateLimitsRead,
} from "./codexUsageLimits.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

type CodexRateLimitsProbe = CodexRateLimitsRead | { readonly failure: string };

const CodexRoutingConfig = Schema.Struct({
  model_provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
  openai_base_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_providers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ base_url: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const decodeCodexRoutingConfig = Schema.decodeUnknownOption(CodexRoutingConfig);

const CodexCyberAccessConfig = Schema.Struct({
  daybreak: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  features: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        api_key_cyber_access_programs: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
});
const decodeCodexCyberAccessConfig = Schema.decodeUnknownOption(CodexCyberAccessConfig);

// Null is Codex's auth-dependent OpenAI default; undefined is a route that cannot be read.
function codexRouteBaseUrl(config: unknown): string | null | undefined {
  const decoded = decodeCodexRoutingConfig(config);
  if (Option.isNone(decoded)) return undefined;
  const routing = decoded.value;
  const providerId = routing.model_provider ?? "openai";
  if (providerId === "openai") return routing.openai_base_url || null;
  const provider = routing.model_providers?.[providerId];
  return provider ? (provider.base_url ?? null) : undefined;
}

function routesToNativeOpenai(config: unknown): boolean {
  const baseUrl = codexRouteBaseUrl(config);
  if (baseUrl === undefined) return false;
  if (baseUrl === null) return true;
  if (!URL.canParse(baseUrl)) return false;
  const url = new URL(baseUrl);
  return (
    url.protocol === "https:" &&
    (url.hostname === "api.openai.com" || url.hostname === "chatgpt.com")
  );
}

/** The origin of the custom endpoint Codex sends model requests to, if it uses one. */
export function codexCustomEndpoint(config: unknown): string | undefined {
  const baseUrl = codexRouteBaseUrl(config);
  const url = baseUrl ? URL.parse(baseUrl) : null;
  return url && /^https?:$/.test(url.protocol) && !routesToNativeOpenai(config)
    ? url.origin
    : undefined;
}

// A stored login does not mean this provider's traffic spends that login's quota.
export const codexRoutesSpendNativeQuota = (
  account: CodexSchema.V2GetAccountResponse,
  config: unknown,
): boolean =>
  account.requiresOpenaiAuth && account.account?.type !== "apiKey" && routesToNativeOpenai(config);

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_CATALOG_REFRESH_TIMEOUT_MS = 3_000;
const CODEX_CONFIG_PROBE_TIMEOUT_MS = 3_000;
const CODEX_CATALOG_REFRESH_POLL = "100 millis" as const;
// OpenAI tailors the Codex model catalog to known originators; an unknown one gets the plain-CLI list.
export const CODEX_ORIGINATOR = "T3 Code";
const CODEX_CLIENT_TITLE = "T3.CodeShip";
// Handshake plus account/models/skills requests can exceed the shared 10s probe budget.
const CODEX_AUTH_PROBE_TIMEOUT_MS = 20_000;
const CODEX_DISCOVERY_MARGIN_MS = 250;
// `codex-cli 0.159.0`, `codex-cli 0.160.0-alpha.1` or the npm CLI's bare `0.1.4161006`.
// Keep a prerelease suffix so compatibility stays unknown for it, as it does for `initialize`.
const CODEX_CLI_VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/u;

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly endpoint?: string | undefined;
  readonly nativeUsage?: boolean;
  readonly rateLimits?: CodexRateLimitsProbe;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel> | undefined;
  readonly serviceTier?: string | undefined;
  /** Undefined when `config/read` failed, so T3 cannot know Codex's default program. */
  readonly daybreakEnabled?: boolean | undefined;
  readonly cyberAccessProgramsUnavailable?: boolean | undefined;
  readonly usesNativeOpenAiBackend?: boolean;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly storedLogin?: CodexStoredChatGptLogin | undefined;
}

interface CodexStoredChatGptLogin {
  readonly email: string;
  readonly accountId: string;
}

const decodeCodexAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ tokens: Schema.Struct({ id_token: Schema.String }) })),
);
const decodeCodexIdTokenClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      email: Schema.String,
      "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
    }),
  ),
);

/**
 * A model provider that does not require OpenAI auth makes `account/read`
 * answer with no account, yet usage still comes from the saved ChatGPT login.
 * Its id_token is only an identity hint, so callers must match it against the
 * account the backend reports.
 */
export const readCodexStoredChatGptLogin = Effect.fn("readCodexStoredChatGptLogin")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(codexHome, "auth.json"))
    .pipe(Effect.option);
  return Option.flatMap(text, decodeCodexAuthFile).pipe(
    Option.flatMap(({ tokens }) => Option.fromNullishOr(tokens.id_token.split(".")[1])),
    Option.map((payload) => Buffer.from(payload, "base64url").toString("utf8")),
    Option.flatMap(decodeCodexIdTokenClaims),
    Option.flatMap((claims): Option.Option<CodexStoredChatGptLogin> => {
      const email = claims.email.trim();
      const accountId = claims["https://api.openai.com/auth"].chatgpt_account_id.trim();
      return email && accountId ? Option.some({ email, accountId }) : Option.none();
    }),
    Option.getOrUndefined,
  );
});

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIER_ID = "default";

const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: "Even faster, more expensive",
};

const CYBER_ACCESS_PROGRAM_LABELS: Readonly<Record<string, string>> = {
  standard: "Standard",
  daybreakBlue: "Daybreak Blue",
  daybreakRed: "Daybreak Red",
};

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(
  account: CodexSchema.V2GetAccountResponse["account"],
  usagePlanType: string | null | undefined,
) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  // account/read takes the plan from the cached login token; the usage read asks the backend.
  const usageLabel = usagePlanType === "unknown" ? undefined : codexPlanLabel(usagePlanType);
  return usageLabel ?? codexPlanLabel(account.planType);
}

/** Some workspace plans charge for every token, including while ordinary usage is allowed. */
export function codexPlanFunding(plan: string | null | undefined) {
  switch (plan) {
    case "enterprise_cbp_usage_based":
    case "self_serve_business_usage_based":
      return "metered" as const;
    case "free":
    case "go":
    case "plus":
    case "pro":
    case "prolite":
    case "promax":
    case "self_serve_business_prolite":
      return "included" as const;
    default:
      return "unknown" as const;
  }
}

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function sameCodexAccountEmail(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = left?.trim().toLowerCase();
  return Boolean(normalizedLeft) && normalizedLeft === right?.trim().toLowerCase();
}

export function codexDefaultReasoningEffortOverride(model: string): "medium" | undefined {
  return codexModelFamily(model) === "gpt-6-astra" ? "medium" : undefined;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort ===
    (codexDefaultReasoningEffortOverride(model.model) ?? model.defaultReasoningEffort)
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => {
          const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
          return {
            id: tier.id,
            label: tier.name,
            ...(description ? { description } : {}),
            ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
          };
        }),
      ],
      currentValue: defaultServiceTier,
    });
  }
  const cyberAccessPrograms = model.availableAccessPrograms?.cyber ?? [];
  if (cyberAccessPrograms.length > 0) {
    const hasStandard = cyberAccessPrograms.includes("standard");
    const defaultProgram = hasStandard ? "standard" : cyberAccessPrograms[0];
    optionDescriptors.push({
      id: "cyberAccessProgram",
      label: "Cyber Access",
      type: "select",
      // Standard stays selectable as an opt-out; Codex rejects it visibly when the login cannot use it.
      options: (hasStandard ? cyberAccessPrograms : ["standard", ...cyberAccessPrograms]).map(
        (program) => ({
          id: program,
          label: CYBER_ACCESS_PROGRAM_LABELS[program] ?? program,
          ...(program === defaultProgram ? { isDefault: true } : {}),
        }),
      ),
      ...(defaultProgram === undefined ? {} : { currentValue: defaultProgram }),
    });
  }

  return createModelCapabilities({
    optionDescriptors,
  });
}

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: formatCodexModelName(model.displayName),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: mapCodexModelCapabilities(model),
  }));
}

export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((model) => !model.isCustom && codexModelFamily(model.slug) === slug),
  )[0]?.slug;
  if (!preferredSlug) {
    return models;
  }
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) {
      return model;
    }
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

function mapCodexOptionDescriptors(
  models: ReadonlyArray<ServerProviderModel>,
  update: (
    descriptors: ReadonlyArray<ProviderOptionDescriptor>,
    model: ServerProviderModel,
  ) => ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (!model.capabilities?.optionDescriptors) return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: update(model.capabilities.optionDescriptors, model),
      },
    };
  });
}

function withConfiguredSelectDefault(
  models: ReadonlyArray<ServerProviderModel>,
  descriptorId: string,
  pick: (options: ReadonlyArray<{ readonly id: string }>) => string | undefined,
): ReadonlyArray<ServerProviderModel> {
  return mapCodexOptionDescriptors(models, (descriptors) =>
    descriptors.map((descriptor) => {
      if (descriptor.id !== descriptorId || descriptor.type !== "select") return descriptor;
      const value = pick(descriptor.options);
      if (!value) return descriptor;
      return {
        ...descriptor,
        currentValue: value,
        options: descriptor.options.map(({ isDefault: _isDefault, ...option }) =>
          option.id === value ? { ...option, isDefault: true } : option,
        ),
      };
    }),
  );
}

function applyConfiguredCodexServiceTier(
  models: ReadonlyArray<ServerProviderModel>,
  serviceTier: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!serviceTier) return models;
  return withConfiguredSelectDefault(
    models,
    "serviceTier",
    (options) =>
      options.find(
        (option) =>
          option.id === serviceTier || (serviceTier === "fast" && option.id === "priority"),
      )?.id,
  );
}

/** Mirrors Codex: `daybreak = true` prefers a Daybreak program, Blue before Red. */
function applyConfiguredCodexCyberAccess(
  models: ReadonlyArray<ServerProviderModel>,
  snapshot: Pick<
    CodexAppServerProviderSnapshot,
    "daybreakEnabled" | "cyberAccessProgramsUnavailable"
  >,
): ReadonlyArray<ServerProviderModel> {
  // Without a descriptor no turn sends a program; without a default only an explicit choice goes.
  const offered = mapCodexOptionDescriptors(models, (descriptors, model) =>
    descriptors.flatMap((descriptor): ReadonlyArray<ProviderOptionDescriptor> => {
      if (descriptor.id !== "cyberAccessProgram" || descriptor.type !== "select") {
        return [descriptor];
      }
      if (model.isCustom || snapshot.cyberAccessProgramsUnavailable === true) return [];
      if (snapshot.daybreakEnabled !== undefined) return [descriptor];
      const { currentValue: _currentValue, ...withoutDefault } = descriptor;
      return [
        {
          ...withoutDefault,
          options: descriptor.options.map(({ isDefault: _isDefault, ...option }) => option),
        },
      ];
    }),
  );
  if (snapshot.daybreakEnabled !== true) return offered;
  return withConfiguredSelectDefault(offered, "cyberAccessProgram", (options) =>
    ["daybreakBlue", "daybreakRed"].find((program) =>
      options.some((option) => option.id === program),
    ),
  );
}

/**
 * Codex has no static default capability set, so a bare custom slug borrows
 * the first built-in's descriptors; an entry with its own capabilities keeps
 * them.
 */
function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  return providerModelsFromSettings(models, customModels, fallbackCapabilities);
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

const decodeCodexModelsCacheStamp = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fetched_at: Schema.String })),
);

const readCodexModelsCacheFetchedAt = Effect.fn("readCodexModelsCacheFetchedAt")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(codexHome, "models_cache.json"))
    .pipe(Effect.option);
  return Option.flatMap(text, decodeCodexModelsCacheStamp).pipe(
    Option.flatMap((stamp) => DateTime.make(stamp.fetched_at)),
    Option.match({ onNone: () => Number.NaN, onSome: DateTime.toEpochMillis }),
  );
});

const withCodexDiscoveryDeadline = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadlineMs: number,
  timeoutMs = Infinity,
) {
  const remainingMs = Math.min(timeoutMs, deadlineMs - DateTime.toEpochMillis(yield* DateTime.now));
  if (remainingMs <= 0) return undefined;
  return yield* effect.pipe(
    Effect.timeoutOption(Duration.millis(remainingMs)),
    Effect.map(Option.getOrUndefined),
  );
});

/**
 * Every Codex client on the machine shares that file, and the backend tailors
 * the catalog to each client's originator: the plain CLI does not get Sol
 * Ultrafast. App-server refreshes the catalog online at startup, so wait until
 * a write newer than this process's spawn lands, then list again.
 */
const requestCodexChatGptModels = Effect.fn("requestCodexChatGptModels")(function* (input: {
  readonly client: CodexClient.CodexAppServerClient["Service"];
  readonly codexHome: string;
  readonly spawnedAtMs: number;
  readonly deadlineMs: number;
}) {
  const models = yield* withCodexDiscoveryDeadline(
    requestAllCodexModels(input.client),
    input.deadlineMs,
  );
  if (models === undefined) return undefined;
  const refreshed = yield* withCodexDiscoveryDeadline(
    readCodexModelsCacheFetchedAt(input.codexHome).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(CODEX_CATALOG_REFRESH_POLL),
        until: (fetchedAtMs) => fetchedAtMs >= input.spawnedAtMs,
      }),
    ),
    input.deadlineMs,
    CODEX_CATALOG_REFRESH_TIMEOUT_MS,
  );
  if (refreshed === undefined) {
    yield* Effect.logWarning(
      "Codex did not refresh its model catalog in time; using the cached catalog.",
    );
    return models;
  }
  return (
    (yield* withCodexDiscoveryDeadline(requestAllCodexModels(input.client), input.deadlineMs)) ??
    models
  );
});

/** Set originator at spawn; the pre-initialize refresh otherwise overwrites shared cache with plain-CLI models. */
export const codexAppServerEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_ORIGINATOR,
  ...environment,
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: CODEX_ORIGINATOR,
      title: CODEX_CLIENT_TITLE,
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const codexProcessEnvironment = Effect.fn("codexProcessEnvironment")(function* (input: {
  readonly homePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  // Expand CODEX_HOME explicitly: spawn passes a literal ~ that Codex rejects.
  const resolvedHomePath = input.homePath
    ? expandHomePath(input.homePath, yield* HostProcess.HomeDirectory)
    : undefined;
  return {
    ...codexAppServerEnvironment(input.environment),
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
});

export function makeCodexSetSkillEnabled<E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly openClient: Effect.Effect<CodexClient.CodexAppServerClient["Service"], E, Scope.Scope>;
}): NonNullable<ProviderInstance["setSkillEnabled"]> {
  return Effect.fn("CodexProvider.setSkillEnabled")(({ path, enabled }) =>
    input.openClient.pipe(
      Effect.flatMap((client) => client.request("skills/config/write", { path, enabled })),
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.asVoid,
      Effect.tapError((cause) =>
        Effect.logWarning("Codex skill toggle failed", { instanceId: input.instanceId, cause }),
      ),
      Effect.mapError(
        () =>
          new ProviderSkillError({
            operation: "setEnabled",
            instanceId: input.instanceId,
            reason: "failed",
          }),
      ),
    ),
  );
}

export const withCodexAppServerClient = Effect.fn("withCodexAppServerClient")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* codexProcessEnvironment(input);
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    { cwd: input.cwd, env: environment, extendEnv: true },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
  const initialize = yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return { client, initialize };
});

// Usage is an enrichment: a failure or a slow answer degrades to "no usage this
// probe" rather than costing the account and models.
const readCodexRateLimits = (
  client: CodexClient.CodexAppServerClient["Service"],
  deadlineMs: number,
) =>
  withCodexDiscoveryDeadline(client.request("account/rateLimits/read", null), deadlineMs).pipe(
    Effect.map(
      (response): CodexRateLimitsProbe =>
        response ?? { failure: "Codex did not answer the usage request." },
    ),
    Effect.catch((error) =>
      Effect.logDebug("Codex rate-limit read failed.", { cause: error }).pipe(
        Effect.as<CodexRateLimitsProbe>({ failure: codexRateLimitsFailureMessage(error) }),
      ),
    ),
  );

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly probeTimeoutMs: number;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeLoginUsage?: boolean;
}) {
  const spawnedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
  const { client, initialize } = yield* withCodexAppServerClient(input);

  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: [],
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  // Optional discovery must finish before the outer timeout can discard the account result.
  const deadlineMs = spawnedAtMs + input.probeTimeoutMs - CODEX_DISCOVERY_MARGIN_MS;
  const [skillsResponse, models, { config, nativeUsage, rateLimits }] = yield* Effect.all(
    [
      withCodexDiscoveryDeadline(client.request("skills/list", { cwds: [input.cwd] }), deadlineMs),
      accountResponse.account?.type === "chatgpt"
        ? requestCodexChatGptModels({
            client,
            codexHome: initialize.codexHome,
            spawnedAtMs,
            deadlineMs,
          })
        : withCodexDiscoveryDeadline(requestAllCodexModels(client), deadlineMs),
      // The shared catalog must exclude config from the server's launch project.
      withCodexDiscoveryDeadline(
        client.request("config/read", { includeLayers: false }),
        deadlineMs,
        CODEX_CONFIG_PROBE_TIMEOUT_MS,
      ).pipe(
        Effect.catch(() => Effect.logDebug("Codex config read failed.").pipe(Effect.as(undefined))),
        Effect.flatMap((config) => {
          // Only a confirmed native route may probe or publish the login's quota.
          const nativeUsage =
            config !== undefined && codexRoutesSpendNativeQuota(accountResponse, config.config);
          const readUsage: Effect.Effect<CodexRateLimitsProbe | undefined> =
            nativeUsage || input.homeLoginUsage === true
              ? readCodexRateLimits(client, deadlineMs)
              : Effect.undefined;
          return readUsage.pipe(
            Effect.map((rateLimits) => ({
              config: config?.config,
              nativeUsage,
              rateLimits,
            })),
          );
        }),
      ),
    ],
    { concurrency: "unbounded" },
  );

  // Keyring storage can leave a stale auth.json behind, so only the file store names the account in use.
  const credentialStore = config?.cli_auth_credentials_store ?? "file";
  const storedLogin =
    accountResponse.account || !config || credentialStore !== "file"
      ? undefined
      : yield* readCodexStoredChatGptLogin(initialize.codexHome);

  const cyberAccess = Option.getOrUndefined(decodeCodexCyberAccessConfig(config));
  return {
    account: accountResponse,
    endpoint: config ? codexCustomEndpoint(config) : undefined,
    nativeUsage,
    ...(rateLimits ? { rateLimits } : {}),
    version,
    models,
    serviceTier: config?.service_tier ?? undefined,
    daybreakEnabled: config === undefined ? undefined : cyberAccess?.daybreak === true,
    // An unread config cannot rule out an API key with the programs turned off.
    cyberAccessProgramsUnavailable:
      accountResponse.account?.type === "apiKey" &&
      (config === undefined || cyberAccess?.features?.api_key_cyber_access_programs === false),
    usesNativeOpenAiBackend:
      config !== undefined && nativeCodexBackend(config, input.environment ?? {}),
    skills: skillsResponse ? parseCodexSkillsListResponse(skillsResponse, input.cwd) : [],
    ...(storedLogin ? { storedLogin } : {}),
  } satisfies CodexAppServerProviderSnapshot;
});

/** Runs the Codex CLI against an instance's home, for what the app server has no method for. */
export const runCodexCli = Effect.fn("runCodexCli")(function* (
  input: {
    readonly binaryPath: string;
    readonly homePath?: string | undefined;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  },
  args: ReadonlyArray<string>,
) {
  const environment = yield* codexProcessEnvironment(input);
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, args, {
    cwd: input.cwd,
    env: environment,
    extendEnv: true,
  });
  return yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      env: environment,
      extendEnv: true,
      forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
      shell: spawnCommand.shell,
    }),
  );
});

// Old CLIs can exit before initialize reports the version needed for compatibility advice.
const probeCodexCliVersion = Effect.fn("probeCodexCliVersion")(
  function* (input: {
    readonly binaryPath: string;
    readonly homePath?: string | undefined;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv | undefined;
  }) {
    const result = yield* runCodexCli(input, ["--version"]);
    if (result.code !== 0) return null;
    return CODEX_CLI_VERSION_PATTERN.exec(result.stdout)?.[1] ?? null;
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOption(
        resolveProviderProbeTimeoutMs("codex", DEFAULT_TIMEOUT_MS, input.environment),
      ),
    ),
  Effect.map(Option.getOrNull),
  Effect.catch((cause) =>
    Effect.logDebug("Codex --version fallback failed.", { cause }).pipe(Effect.as(null)),
  ),
);

export const probeCodexSkillsForCwd = Effect.fn("probeCodexSkillsForCwd")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const { client } = yield* withCodexAppServerClient({
    ...input,
    environment: providerProbeEnvironment(input.environment ?? process.env),
  });
  const skillsResponse = yield* client.request("skills/list", { cwds: [input.cwd] });
  return parseCodexSkillsListResponse(skillsResponse, input.cwd);
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  appendCustomCodexModels([], codexSettings.customModels);

const makePendingCodexProvider = Effect.fn("CodexProvider.makePendingCodexProvider")(function* (
  codexSettings: CodexSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in T3.CodeShip settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex provider status has not been checked in this session yet.",
    },
  });
});

export const CODEX_NOT_FOUND_MESSAGE =
  "Codex CLI (`codex`) is not on the server's PATH. Install Codex in Settings → Providers & models → Codex, or set its Binary path there. Installing ChatGPT or Codex desktop may not add codex to PATH.";

/** The default binary path found no `codex` on PATH and no copy installed by T3.CodeShip. */
export const makeMissingCodexProvider = Effect.fn("CodexProvider.makeMissingCodexProvider")(
  function* (codexSettings: CodexSettings): Effect.fn.Return<ServerProviderDraft> {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
      models: emptyCodexModelsFromSettings(codexSettings),
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: CODEX_NOT_FOUND_MESSAGE,
      },
    });
  },
);

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

function nativeCodexBackend(
  config: CodexSchema.V2ConfigReadResponse__Config,
  environment: NodeJS.ProcessEnv,
) {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const redirected = (values: Record<string, unknown>) =>
    (values.model_provider != null && values.model_provider !== "openai") ||
    values.openai_base_url != null ||
    values.chatgpt_base_url != null ||
    (isRecord(values.model_providers) && Object.hasOwn(values.model_providers, "openai"));
  if (
    redirected(config) ||
    environment.OPENAI_BASE_URL?.trim() ||
    environment.CHATGPT_BASE_URL?.trim() ||
    environment.CODEX_CHATGPT_BASE_URL?.trim()
  )
    return false;
  if (config.profile == null) return true;
  const profile =
    typeof config.profile === "string" && isRecord(config.profiles)
      ? config.profiles[config.profile]
      : undefined;
  return isRecord(profile) && !redirected(profile);
}

export const codexWorkspaceFunding = Effect.fn("CodexProvider.workspaceFunding")(
  function* (
    client: CodexClient.CodexAppServerClient["Service"],
    input: {
      readonly cwd: string;
      readonly provider: Pick<ServerProvider, "auth" | "usageLimits" | "checkedAt">;
    },
    environment: NodeJS.ProcessEnv,
  ) {
    const { provider, cwd } = input;
    if (
      !provider.auth.workspaceId ||
      !provider.auth.email ||
      provider.auth.status !== "authenticated" ||
      provider.auth.type !== "chatgpt"
    )
      return "unknown" as const;
    const { config } = yield* client.request("config/read", { cwd, includeLayers: false });
    if (!nativeCodexBackend(config, environment) || config.forced_login_method === "api")
      return "unknown" as const;
    if (
      config.forced_chatgpt_workspace_id &&
      ![config.forced_chatgpt_workspace_id].flat().includes(provider.auth.workspaceId)
    )
      return "unknown" as const;
    const { account, requiresOpenaiAuth } = yield* client.request("account/read", {});
    if (
      !requiresOpenaiAuth ||
      account?.type !== "chatgpt" ||
      !sameCodexAccountEmail(account.email, provider.auth.email)
    )
      return "unknown" as const;
    const read = yield* client.request("account/rateLimits/read", null);
    if (read.accountId?.trim() !== provider.auth.workspaceId) return "unknown" as const;
    const limits = codexRateLimitsToLimits({ read, checkedAt: provider.checkedAt });
    if (provider.usageLimits?.plan !== undefined && limits.plan !== provider.usageLimits.plan)
      return "unknown" as const;
    return codexPlanFunding(limits.plan);
  },
  Effect.catchCause(() => Effect.succeed("unknown" as const)),
);

function accountProbeStatus(
  { account, rateLimits, storedLogin, usesNativeOpenAiBackend }: CodexAppServerProviderSnapshot,
  codexHome: string | undefined,
): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(
    account.account,
    rateLimits && "rateLimits" in rateLimits ? rateLimits.rateLimits.planType : undefined,
  );
  const workspaceId =
    rateLimits && "rateLimits" in rateLimits ? rateLimits.accountId?.trim() : undefined;
  // Limits merge hosts by email, so a proxied login without one shows once per host.
  const authEmail =
    codexAccountEmail(account.account) ??
    (workspaceId && storedLogin?.accountId === workspaceId ? storedLogin.email : undefined);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    funding:
      account.account?.type === "apiKey" ||
      account.account?.type === "amazonBedrock" ||
      (account.account?.type === "chatgpt" &&
        codexPlanFunding(
          rateLimits && "rateLimits" in rateLimits
            ? (rateLimits.rateLimitsByLimitId?.codex?.planType ??
                rateLimits.rateLimits.planType ??
                account.account.planType)
            : account.account.planType,
        ) === "metered")
        ? "metered"
        : "unknown",
    ...(account.account?.type === "chatgpt" && account.requiresOpenaiAuth && usesNativeOpenAiBackend
      ? { fundingScope: "workspace" as const }
      : {}),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: codexHome
        ? `Codex CLI is not authenticated. Sign in in Settings → Providers & models → Codex, or run \`codex login\` with CODEX_HOME set to ${quotePath(codexHome)}.`
        : "Codex CLI is not authenticated. Sign in in Settings → Providers & models → Codex, or run `codex login`.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly probeTimeoutMs: number;
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeLoginUsage?: boolean;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
  managedAuth?: ServerProvider["auth"],
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = providerProbeEnvironment(environment ?? process.env);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in T3.CodeShip settings.",
      },
    });
  }

  const probeTimeoutMs = resolveProviderProbeTimeoutMs(
    "codex",
    CODEX_AUTH_PROBE_TIMEOUT_MS,
    resolvedEnvironment,
  );
  const sharesSubscription = managedAuth?.subscriptionSharing === true;
  const probeResult = yield* probe({
    probeTimeoutMs,
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment),
    cwd: process.cwd(),
    environment: resolvedEnvironment,
    // A sharing launch has no OpenAI login of its own, yet spends the connected account's quota.
    ...(sharesSubscription ? { homeLoginUsage: true } : {}),
  }).pipe(
    // Process teardown can outlast the work budget without discarding a completed snapshot.
    Effect.timeoutOption(Duration.millis(probeTimeoutMs)),
    Effect.scoped,
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    const version = installed
      ? yield* probeCodexCliVersion({
          binaryPath: codexSettings.binaryPath,
          homePath: codexSettings.homePath,
          cwd: process.cwd(),
          environment: resolvedEnvironment,
        })
      : null;
    // A rejected login fails the first account read, so this account must not take runs.
    const loginRejected = installed && isCodexLoginRejected({ message: error.message });
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version,
        status: "error",
        auth: { status: loginRejected ? "unauthenticated" : "unknown" },
        message: loginRejected
          ? "Codex rejected this account's login. Sign in again in Settings → Providers & models → Codex, or run `codex login`."
          : installed
            ? withProviderFailureReason(
                "Codex app-server provider probe failed",
                providerOutputReason(
                  error.message,
                  yield* HostProcess.HomeDirectory,
                  resolvedEnvironment,
                ),
              )
            : `Could not start Codex CLI (\`${codexSettings.binaryPath}\`). ` +
              (codexSettings.binaryPath === "codex"
                ? "The codex on the server's PATH could not be run. Reinstall it, or set Settings → Providers & models → Codex → Binary path."
                : "Check Settings → Providers & models → Codex → Binary path on the server. Make sure the configured executable exists and can be run."),
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const login = accountProbeStatus(
    snapshot,
    codexSettings.homePath
      ? expandHomePath(codexSettings.homePath, yield* HostProcess.HomeDirectory)
      : undefined,
  );
  const accountStatus = managedAuth
    ? { status: "ready" as const, auth: managedAuth, message: undefined }
    : login;
  const usageLimits =
    !snapshot.nativeUsage && !sharesSubscription && !accountStatus.message
      ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
      : snapshot.rateLimits === undefined || "failure" in snapshot.rateLimits
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            ...(accountStatus.message ? { message: accountStatus.message } : {}),
            ...(snapshot.rateLimits ? { message: snapshot.rateLimits.failure } : {}),
          })
        : codexRateLimitsToLimits({ read: snapshot.rateLimits, checkedAt });
  // A ChatGPT sharing token cannot read Codex limits; the home's own Codex login can. Its limits
  // are this account's only when the backend confirms that login is this account. A failed read
  // attributes nothing, so the saved login's identity hint is enough to report why it failed.
  const reportsUsageLimits =
    managedAuth === undefined ||
    (Boolean(managedAuth.workspaceId) &&
      login.auth.workspaceId === managedAuth.workspaceId &&
      sameCodexAccountEmail(login.auth.email, managedAuth.email)) ||
    ((snapshot.rateLimits === undefined || "failure" in snapshot.rateLimits) &&
      sameCodexAccountEmail(snapshot.storedLogin?.email, managedAuth.email));

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: pipe(
      appendCustomCodexModels(snapshot.models ?? [], codexSettings.customModels),
      applyPreferredCodexDefaultModel,
      (models) => applyConfiguredCodexServiceTier(models, snapshot.serviceTier),
      (models) => applyConfiguredCodexCyberAccess(models, snapshot),
    ),
    skills: snapshot.skills,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      {
        name: "goal",
        description: "Set a goal Codex keeps working toward until it is done",
        input: { hint: "Objective, or pause, resume, clear" },
      },
      {
        name: "feedback",
        description: "Send this thread and Codex logs to OpenAI",
        input: { hint: "Describe the issue (optional)" },
      },
    ],
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: snapshot.models === undefined ? "warning" : accountStatus.status,
      auth: snapshot.endpoint
        ? { ...accountStatus.auth, endpoint: snapshot.endpoint }
        : accountStatus.auth,
      ...(accountStatus.message
        ? { message: accountStatus.message }
        : snapshot.models === undefined
          ? { message: "Codex did not return its model catalog in time." }
          : {}),
      ...(reportsUsageLimits ? { usageLimits } : {}),
    },
  });
});

export { makePendingCodexProvider };
