import {
  REASONING_EFFORT_OPTION_IDS,
  type ModelCapabilities,
  type ProviderOptionSelection,
  type SelectProviderOptionDescriptor,
} from "@t3tools/contracts/model";
import type {
  AutoCapabilityTier,
  AutoRoutingConstraints,
  AutoRoutingDegradationReason,
  ModelSelection,
} from "@t3tools/contracts/modelSelection";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { AutoModeModel } from "@t3tools/contracts/settings";
import {
  acceptedOptionSelections,
  modelSelectionsEqual,
  resolveSelectableModel,
  withLegacyUltracodeEffort,
  withModelSelectionOptions,
  type SelectableModelOption,
} from "@t3tools/shared/model";

export { type AutoCapabilityTier, type AutoRoutingConstraints, type AutoRoutingDegradationReason };

export type AutoRequestComplexity = "lite" | "standard" | "deep";

export interface AutoRequestPrompt {
  readonly text: string;
  readonly attachmentCount?: number | undefined;
}

export interface AutoComplexityInput extends AutoRequestPrompt {
  readonly started: boolean;
}

export type AutoComplexityModelOption = SelectableModelOption & {
  readonly capabilities?: ModelCapabilities | null | undefined;
  readonly isLegacy?: boolean | undefined;
  readonly isDefault?: boolean | undefined;
  readonly isCustom?: boolean | undefined;
};

const DEEP_CUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:architect(?:ure|ural|ing)?|redesign(?:ed|ing)?|system design)\b/i,
  /\b(?:distributed|concurrency|concurrent|race condition|deadlock|livelock)\b/i,
  /\b(?:security audit|vulnerabilit(?:y|ies)|threat model)\b/i,
  /\b(?:data loss|data corruption|schema migration|database migration|migration)\b/i,
  /\b(?:root[- ]cause|investigate why)\b/i,
  /\b(?:performance profil\w*|memory leak|cpu profil\w*)\b/i,
  /\b(?:multi[- ]repo|cross[- ]repo)\b/i,
  /\b(?:protocol change|wire protocol)\b/i,
  /\b(?:deep dive|think deeply|thoroughly analyze|end-to-end redesign|ultrathink|ultra)\b/i,
];

const DEEP_MIN_STRUCTURAL_CHARS = 1400;
const DEEP_MIN_ATTACHMENTS = 4;
const LITE_MAX_CHARS = 280;
const LITE_MAX_NON_EMPTY_LINES = 3;
const LITE_MAX_ATTACHMENTS = 1;
const LITE_FOLLOWUP_MAX_CHARS = 120;

const UTILITY_SLASH_COMMAND_PATTERN =
  /^\/(?:compact|clear|status|help|cost|context|model)(?:\s|$)/i;
const FENCED_CODE_MARKER_PATTERN = /(?:^|\n)\s*(?:```|~~~)/g;
const BULLET_OR_NUMBERED_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const FILE_PATH_PATTERN =
  /(?:^|[\s(`"'])((?:\.{0,2}\/)?(?:[a-zA-Z0-9_@.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s)`"':;?!])/g;

// Only pure closings, acknowledgments, and status pings lower effort on started threads.
// Approvals ("go ahead", "yes, do it", "ok", "lgtm", "ship it") often kick off a proposed plan and stay standard.
const CLOSING_TOKEN =
  "(?:thanks|thank you|thx|ty|got it|cool|nice|great|awesome|status|any updates?)";

const STARTED_CLOSING_PATTERN = new RegExp(
  `^${CLOSING_TOKEN}(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)${CLOSING_TOKEN})*$`,
  "i",
);

const READ_ONLY_LOOKUP_PATTERN =
  /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+|pls\s+|quickly\s+|briefly\s+)?(?:what(?:'s| is| are)|where(?:'s| is| are)|why\s+(?:did|does|is|was)|how\s+(?:does|do|is)|explain|summarize|list|show(?:\s+me)?|check\s+status|git\s+(?:status|log|diff)|pr\s+status)\b/i;

const READ_ONLY_DEBUGGING_PATTERN =
  /\b(?:bugs?|broken|breaks?|broke|crash\w*|fail\w*|errors?|corrupt\w*|leak\w*|incident|outage|vulnerab\w*)\b/i;

const READ_ONLY_MUTATION_CLAUSE_PATTERN =
  /(?:(?:[,;:.!?]|\band\b|\bthen\b)\s*(?:(?:and|then)\s+)*(?:(?:can|could|would)\s+you\s+|also\s+|please\s+|pls\s+)*(?:fix|implement|refactor|rewrite|redesign|add|create|update|change|edit|modify|write|delete|remove|build|debug|investigate|repair|patch|resolve|commit|push|merge|rebase|revert|reset|drop|deploy|publish|release|make|run)\b)|\b(?:implement|refactor|rewrite|redesign|commit|push|merge|rebase|revert|reset|drop|deploy|publish|release|fix\s+(?:it|this|that|the\s+bug))\b/i;

const MECHANICAL_EDIT_PATTERN =
  /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+|pls\s+|just\s+)?(?:fix\s+(?:a\s+|the\s+|this\s+)?typos?|rename\s+(?:the\s+|this\s+)?(?:variable|symbol|file|function|method|const|prop|field|type)\b|(?:update|fix|edit|add|remove)\s+(?:a\s+|the\s+|this\s+)?(?:comments?|docstrings?|jsdoc)\b|remove\s+unused\s+(?:imports?|variables?)\b|format\s+(?:this\s+|the\s+)?file\b|run\s+prettier\b|bump\s+(?:the\s+)?version\b|add\s+(?:an?\s+|the\s+|missing\s+)?import\b)/i;

const BROAD_EDIT_SCOPE_PATTERN =
  /\b(?:across\s+(?:the\s+)?(?:codebase|repo|repository|all\s+files|project|every)|every\s+caller|all\s+callers|refactor|rewrite|redesign|implement|feature|bug|broken|crash(?:es|ing)?|debug|error|fail(?:s|ed|ing|ure)?|auth|security|database|table|column|schema|revert)\b|(?:\band\s+(?:then|find|keep|fix|update|verify|check)\b)|(?:,\s*(?:fix|find|keep|update|check|debug)\b)/i;

function hasStructuralDepth(trimmed: string): boolean {
  if (trimmed.length < DEEP_MIN_STRUCTURAL_CHARS) return false;
  const lines = trimmed.split(/\r?\n/);
  let listItems = 0;
  for (const line of lines) {
    if (BULLET_OR_NUMBERED_LINE_PATTERN.test(line)) {
      listItems += 1;
      if (listItems >= 2) return true;
    }
  }
  const fenceMarkers = trimmed.match(FENCED_CODE_MARKER_PATTERN);
  if ((fenceMarkers?.length ?? 0) >= 4) return true;
  const paths = new Set<string>();
  for (const match of trimmed.matchAll(FILE_PATH_PATTERN)) {
    const candidate = match[1];
    if (candidate !== undefined) {
      paths.add(candidate);
      if (paths.size >= 4) return true;
    }
  }
  return false;
}

function isStartedClosingFollowUp(trimmed: string): boolean {
  if (trimmed.length > LITE_FOLLOWUP_MAX_CHARS) return false;
  const normalized = trimmed
    .replace(/[.!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 && STARTED_CLOSING_PATTERN.test(normalized);
}

/**
 * Deterministically classifies an Auto-mode turn into `lite`, `standard`, or `deep`
 * with zero latency and zero model tokens.
 */
export function classifyAutoRequestComplexity(input: AutoComplexityInput): AutoRequestComplexity {
  const trimmed = input.text.trim();
  const attachmentCount = input.attachmentCount ?? 0;

  if (
    attachmentCount >= DEEP_MIN_ATTACHMENTS ||
    DEEP_CUE_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
    hasStructuralDepth(trimmed)
  ) {
    return "deep";
  }

  if (
    trimmed.length === 0 ||
    attachmentCount > LITE_MAX_ATTACHMENTS ||
    trimmed.length > LITE_MAX_CHARS ||
    /```|~~~/.test(trimmed)
  ) {
    return "standard";
  }

  const nonEmptyLines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length > LITE_MAX_NON_EMPTY_LINES) {
    return "standard";
  }

  // Only explicit utility slash commands stay lite; workflow/skill commands (/ship, /implement, etc.) stay standard.
  if (UTILITY_SLASH_COMMAND_PATTERN.test(trimmed)) {
    return "lite";
  }
  if (trimmed.startsWith("/")) {
    return "standard";
  }

  if (input.started && isStartedClosingFollowUp(trimmed)) {
    return "lite";
  }

  if (
    READ_ONLY_LOOKUP_PATTERN.test(trimmed) &&
    !READ_ONLY_DEBUGGING_PATTERN.test(trimmed) &&
    !READ_ONLY_MUTATION_CLAUSE_PATTERN.test(trimmed)
  ) {
    return "lite";
  }

  if (MECHANICAL_EDIT_PATTERN.test(trimmed) && !BROAD_EDIT_SCOPE_PATTERN.test(trimmed)) {
    return "lite";
  }

  return "standard";
}

function extractModelVersion(slug: string): string {
  const match = /(\d+(?:[.-]\d{1,2})?)/.exec(slug);
  return match?.[1]?.replaceAll("-", ".") ?? "";
}

function matchesToken(value: string, token: string): boolean {
  return new RegExp(`(?:^|[-_. ])${token}(?:$|[-_. \\[])`, "i").test(value);
}

function isAlreadyLiteModel(driver: ProviderDriverKind, slug: string): boolean {
  if (driver === "claudeAgent") {
    return matchesToken(slug, "sonnet") || matchesToken(slug, "haiku");
  }
  if (driver === "codex") {
    return (
      matchesToken(slug, "sol") ||
      matchesToken(slug, "terra") ||
      matchesToken(slug, "mini") ||
      matchesToken(slug, "luna")
    );
  }
  return false;
}

function liteModelTier(
  driver: ProviderDriverKind,
  model: AutoComplexityModelOption,
): number | null {
  if (model.isLegacy === true || model.isCustom === true) return null;
  if (driver === "claudeAgent") {
    const isSonnet =
      matchesToken(model.slug, "sonnet") ||
      model.aliases?.some((alias) => alias.toLowerCase() === "sonnet") === true;
    return isSonnet ? 0 : null;
  }
  if (driver === "codex") {
    if (matchesToken(model.slug, "sol")) return 0;
    if (matchesToken(model.slug, "terra")) return 1;
    if (matchesToken(model.slug, "mini")) return 2;
    return null;
  }
  return null;
}

function selectLiteModel(input: {
  readonly driver: ProviderDriverKind;
  readonly currentModel: string;
  readonly models: ReadonlyArray<AutoComplexityModelOption>;
  readonly modelHasRoom: (slug: string) => boolean;
}): string {
  if (isAlreadyLiteModel(input.driver, input.currentModel)) {
    return input.currentModel;
  }
  const candidates = input.models.flatMap((model) => {
    const tier = liteModelTier(input.driver, model);
    return tier === null ? [] : [{ model, tier, version: extractModelVersion(model.slug) }];
  });
  candidates.sort(
    (left, right) =>
      left.tier - right.tier ||
      right.version.localeCompare(left.version, "en", { numeric: true }) ||
      Number(right.model.isDefault === true) - Number(left.model.isDefault === true),
  );
  return (
    candidates.find(({ model }) => input.modelHasRoom(model.slug))?.model.slug ?? input.currentModel
  );
}

function findEffortDescriptor(
  capabilities: ModelCapabilities | null | undefined,
): SelectProviderOptionDescriptor | undefined {
  return capabilities?.optionDescriptors?.find(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" && REASONING_EFFORT_OPTION_IDS.includes(descriptor.id),
  );
}

function configuredEffortValue(
  configuredAuto: AutoModeModel | null,
  descriptor: SelectProviderOptionDescriptor,
  allDescriptors: ReadonlyArray<NonNullable<ModelCapabilities["optionDescriptors"]>[number]>,
): string | undefined {
  const normalized = withLegacyUltracodeEffort(allDescriptors, configuredAuto?.options);
  if (!normalized) return undefined;
  const exact = normalized.find(
    (option) => option.id === descriptor.id && typeof option.value === "string",
  );
  if (typeof exact?.value === "string") return exact.value;
  const fallback = normalized.find(
    (option) => REASONING_EFFORT_OPTION_IDS.includes(option.id) && typeof option.value === "string",
  );
  return typeof fallback?.value === "string" ? fallback.value : undefined;
}

function preferredEffortOrder(
  complexity: AutoRequestComplexity,
  configuredEffort: string | undefined,
): ReadonlyArray<string> {
  switch (complexity) {
    case "lite":
      return configuredEffort === "minimal"
        ? ["minimal", "low", "medium"]
        : ["low", "minimal", "medium"];
    case "standard":
      return configuredEffort === "minimal" || configuredEffort === "low"
        ? [configuredEffort, "medium", "high", "low"]
        : ["medium", "high", "low"];
    case "deep":
      if (configuredEffort === "ultra") return ["ultra", "xhigh", "high", "medium"];
      if (configuredEffort === "xhigh") return ["xhigh", "high", "medium"];
      if (configuredEffort === "max") return ["max", "high", "xhigh", "medium"];
      return ["high", "xhigh", "medium"];
  }
}

/**
 * Preserves a started thread's running model and valid options on the routed Auto account for
 * server-generated continuations and wakes (restart, usage-limit, delegated completion) so they
 * neither silently upgrade a lite thread to frontier nor change effort mid-task.
 */
export function preserveAutoSelectionOnAccount(input: {
  readonly selection: ModelSelection;
  readonly previousSelection: ModelSelection;
  readonly account: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<AutoComplexityModelOption>;
  };
  readonly modelHasRoom?: ((slug: string) => boolean) | undefined;
}): ModelSelection {
  if (input.selection.autoAccount !== true || input.selection.quotaAwareAuto === true) {
    return input.selection;
  }
  const hasRoom = input.modelHasRoom ?? (() => true);
  const resolvedPrevious = resolveSelectableModel(
    input.account.driver,
    input.previousSelection.model,
    input.account.models,
  );
  if (resolvedPrevious === null || !hasRoom(resolvedPrevious)) {
    return input.selection;
  }
  // Only preserve either a lite model or the current routed primary model (never a stale retired frontier model).
  if (
    resolvedPrevious !== input.selection.model &&
    !isAlreadyLiteModel(input.account.driver, resolvedPrevious)
  ) {
    return input.selection;
  }
  const modelEntry = input.account.models.find((model) => model.slug === resolvedPrevious);
  const descriptors = modelEntry?.capabilities?.optionDescriptors;
  const preservedOptions =
    descriptors !== undefined
      ? acceptedOptionSelections(descriptors, input.previousSelection.options)
      : input.previousSelection.options;
  const candidate = withModelSelectionOptions(
    { ...input.selection, model: resolvedPrevious, autoAccount: true },
    preservedOptions,
  );
  return modelSelectionsEqual(candidate, input.selection) ? input.selection : candidate;
}

/**
 * Tunes an Auto selection's model (monotonically — never downgrading mid-thread so KV cache stays
 * warm) and reasoning effort (elastically per turn) for `complexity`.
 */
export function applyAutoComplexityToSelection(input: {
  readonly selection: ModelSelection;
  readonly complexity: AutoRequestComplexity;
  readonly account: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<AutoComplexityModelOption>;
  };
  readonly started: boolean;
  /** The model the thread actually ran (from server state), NOT the web composer's primary selection. */
  readonly previousModel?: string | undefined;
  readonly configuredAuto: AutoModeModel | null;
  readonly modelHasRoom?: ((slug: string) => boolean) | undefined;
}): ModelSelection {
  if (input.selection.autoAccount !== true || input.selection.quotaAwareAuto === true) {
    return input.selection;
  }
  const hasRoom = input.modelHasRoom ?? (() => true);

  let chosenModel = input.selection.model;
  if (!input.started) {
    if (input.complexity === "lite") {
      chosenModel = selectLiteModel({
        driver: input.account.driver,
        currentModel: input.selection.model,
        models: input.account.models,
        modelHasRoom: hasRoom,
      });
    }
  } else if (
    input.complexity === "lite" &&
    input.previousModel !== undefined &&
    input.previousModel !== input.selection.model
  ) {
    const resolvedPrevious = resolveSelectableModel(
      input.account.driver,
      input.previousModel,
      input.account.models,
    );
    if (
      resolvedPrevious !== null &&
      resolvedPrevious !== input.selection.model &&
      isAlreadyLiteModel(input.account.driver, resolvedPrevious) &&
      hasRoom(resolvedPrevious)
    ) {
      chosenModel = resolvedPrevious;
    }
  }

  const modelChanged = chosenModel !== input.selection.model;
  const resolvedSlug =
    resolveSelectableModel(input.account.driver, chosenModel, input.account.models) ?? chosenModel;
  const modelEntry = input.account.models.find((model) => model.slug === resolvedSlug);
  const descriptors = modelEntry?.capabilities?.optionDescriptors;
  const effortDescriptor = findEffortDescriptor(modelEntry?.capabilities);

  let nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined = input.selection.options;
  if (modelChanged && descriptors !== undefined) {
    nextOptions = acceptedOptionSelections(descriptors, nextOptions);
  }

  if (effortDescriptor !== undefined) {
    const allowedChoices = new Set(
      effortDescriptor.options
        .map((choice) => choice.id)
        .filter((id) => !effortDescriptor.promptInjectedValues?.includes(id)),
    );
    const configuredEffort = configuredEffortValue(
      input.configuredAuto,
      effortDescriptor,
      descriptors ?? [effortDescriptor],
    );
    const targetEffort = preferredEffortOrder(input.complexity, configuredEffort).find((choice) =>
      allowedChoices.has(choice),
    );
    if (targetEffort !== undefined) {
      const existing = nextOptions ?? [];
      let replaced = false;
      const updated = existing.map((option) => {
        if (option.id !== effortDescriptor.id) return option;
        replaced = true;
        return { id: effortDescriptor.id, value: targetEffort };
      });
      nextOptions = replaced
        ? updated
        : [...updated, { id: effortDescriptor.id, value: targetEffort }];
    }
  }

  const candidate = withModelSelectionOptions(
    { ...input.selection, model: chosenModel, autoAccount: true },
    nextOptions,
  );
  return modelSelectionsEqual(candidate, input.selection) ? input.selection : candidate;
}

const CAPABILITY_TIER_RANK: Readonly<Record<AutoCapabilityTier, number>> = {
  fast: 0,
  standard: 1,
  deep: 2,
  frontier: 3,
};

function maxCapabilityTier(
  left: AutoCapabilityTier,
  right: AutoCapabilityTier,
): AutoCapabilityTier {
  return CAPABILITY_TIER_RANK[left] >= CAPABILITY_TIER_RANK[right] ? left : right;
}

function capabilityTierForComplexity(complexity: AutoRequestComplexity): AutoCapabilityTier {
  switch (complexity) {
    case "lite":
      return "fast";
    case "standard":
      return "standard";
    case "deep":
      return "deep";
  }
}

export function resolveEffectiveCapabilityTier(input: {
  readonly complexity?: AutoRequestComplexity | undefined;
  readonly constraints?: AutoRoutingConstraints | undefined;
}): AutoCapabilityTier {
  const requested =
    input.constraints?.capabilityTier ??
    (input.complexity !== undefined ? capabilityTierForComplexity(input.complexity) : "standard");
  return input.constraints?.minTier !== undefined
    ? maxCapabilityTier(requested, input.constraints.minTier)
    : requested;
}

function normalizeVendorFamily(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return "";
  switch (normalized) {
    case "anthropic":
    case "claude":
    case "claudeagent":
    case "claude-agent":
    case "claude_agent":
    case "claude-code":
    case "claudecode":
      return "anthropic";
    case "openai":
    case "codex":
    case "gpt":
    case "chatgpt":
      return "openai";
    case "google":
    case "gemini":
    case "antigravity":
      return "google";
    case "xai":
    case "x-ai":
    case "x.ai":
    case "grok":
      return "xai";
    case "muse":
    case "musecode":
    case "muse-code":
      return "muse";
    default:
      return normalized;
  }
}

const KNOWN_SLICE_VENDORS = new Set(["anthropic", "openai", "google", "xai"]);

export function vendorFamilyOfDriver(
  driver: ProviderDriverKind | string,
  modelSlug?: string | null | undefined,
): string {
  const trimmedModel = modelSlug?.trim();
  if (trimmedModel !== undefined && trimmedModel.length > 0) {
    const slashIndex = trimmedModel.indexOf("/");
    if (slashIndex > 0) {
      const prefixVendor = normalizeVendorFamily(trimmedModel.slice(0, slashIndex));
      if (KNOWN_SLICE_VENDORS.has(prefixVendor)) {
        return prefixVendor;
      }
    }
    if (
      matchesToken(trimmedModel, "claude") ||
      matchesToken(trimmedModel, "opus") ||
      matchesToken(trimmedModel, "sonnet") ||
      matchesToken(trimmedModel, "haiku")
    ) {
      return "anthropic";
    }
    if (
      matchesToken(trimmedModel, "gpt") ||
      matchesToken(trimmedModel, "codex") ||
      matchesToken(trimmedModel, "astra") ||
      matchesToken(trimmedModel, "sol") ||
      matchesToken(trimmedModel, "terra") ||
      matchesToken(trimmedModel, "luna") ||
      /^(?:openai\.)?(?:o1|o3|o4)(?:$|[-_.])/i.test(trimmedModel)
    ) {
      return "openai";
    }
    if (
      matchesToken(trimmedModel, "gemini") ||
      matchesToken(trimmedModel, "neon") ||
      matchesToken(trimmedModel, "argon")
    ) {
      return "google";
    }
    if (matchesToken(trimmedModel, "grok")) {
      return "xai";
    }
  }
  return normalizeVendorFamily(String(driver));
}

export function excludedVendorFamilies(
  constraints: AutoRoutingConstraints | undefined,
): ReadonlySet<string> {
  if (constraints?.excludeVendorFamily === undefined) return new Set();
  const values =
    typeof constraints.excludeVendorFamily === "string"
      ? [constraints.excludeVendorFamily]
      : constraints.excludeVendorFamily;
  const result = new Set<string>();
  for (const value of values) {
    const normalized = normalizeVendorFamily(value);
    if (normalized.length > 0) {
      result.add(normalized);
    }
  }
  return result;
}

export interface AutoProviderCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind | string;
  readonly model?: string | null | undefined;
  readonly hasQuota?: boolean | undefined;
}

export interface FilteredAutoProvidersResult<T extends AutoProviderCandidate> {
  readonly providers: ReadonlyArray<T>;
  readonly degradedReason?: AutoRoutingDegradationReason | undefined;
}

export function filterEligibleAutoProviders<T extends AutoProviderCandidate>(
  providers: ReadonlyArray<T>,
  constraints: AutoRoutingConstraints | undefined,
): FilteredAutoProvidersResult<T> {
  const excluded = excludedVendorFamilies(constraints);
  const withQuota = providers.filter((provider) => provider.hasQuota !== false);
  if (excluded.size === 0) {
    return { providers: withQuota.length > 0 ? withQuota : providers };
  }
  const dissimilarWithQuota = withQuota.filter(
    (provider) => !excluded.has(vendorFamilyOfDriver(provider.driver, provider.model)),
  );
  if (dissimilarWithQuota.length > 0) {
    return { providers: dissimilarWithQuota };
  }
  const fallback = withQuota.length > 0 ? withQuota : providers;
  return {
    providers: fallback,
    degradedReason: "no-dissimilar-provider-available",
  };
}

function isFlagshipFamily(driver: ProviderDriverKind, model: AutoComplexityModelOption): boolean {
  if (model.aliases?.some((alias) => alias.toLowerCase() === "primary") === true) {
    return true;
  }
  if (driver === "claudeAgent") {
    return (
      matchesToken(model.slug, "opus") ||
      model.aliases?.some((alias) => alias.toLowerCase() === "opus") === true
    );
  }
  if (driver === "codex") {
    return matchesToken(model.slug, "astra");
  }
  if (driver === "antigravity") {
    return matchesToken(model.slug, "neon");
  }
  return false;
}

function maxEffortRankForModel(model: AutoComplexityModelOption): number {
  const descriptor = findEffortDescriptor(model.capabilities);
  if (descriptor === undefined) return 0;
  const rankMap: Readonly<Record<string, number>> = {
    minimal: 1,
    low: 2,
    medium: 3,
    high: 4,
    xhigh: 5,
    max: 6,
    ultra: 7,
  };
  let best = 0;
  for (const choice of descriptor.options) {
    if (descriptor.promptInjectedValues?.includes(choice.id) === true) continue;
    best = Math.max(best, rankMap[choice.id] ?? 0);
  }
  return best;
}

function selectFlagshipModel(input: {
  readonly driver: ProviderDriverKind;
  readonly currentModel: string;
  readonly models: ReadonlyArray<AutoComplexityModelOption>;
  readonly configuredAuto: AutoModeModel | null;
  readonly modelHasRoom: (slug: string) => boolean;
}): string {
  const candidates = input.models.filter(
    (model) => model.isLegacy !== true && model.isCustom !== true && input.modelHasRoom(model.slug),
  );
  if (candidates.length === 0) return input.currentModel;
  const sorted = candidates.toSorted((left, right) => {
    const nonLiteDiff =
      Number(!isAlreadyLiteModel(input.driver, right.slug)) -
      Number(!isAlreadyLiteModel(input.driver, left.slug));
    if (nonLiteDiff !== 0) return nonLiteDiff;
    const flagshipDiff =
      Number(isFlagshipFamily(input.driver, right)) - Number(isFlagshipFamily(input.driver, left));
    if (flagshipDiff !== 0) return flagshipDiff;
    const versionDiff = extractModelVersion(right.slug).localeCompare(
      extractModelVersion(left.slug),
      "en",
      { numeric: true },
    );
    if (versionDiff !== 0) return versionDiff;
    const effortDiff = maxEffortRankForModel(right) - maxEffortRankForModel(left);
    if (effortDiff !== 0) return effortDiff;
    const configuredMatchDiff =
      Number(right.slug === input.configuredAuto?.model) -
      Number(left.slug === input.configuredAuto?.model);
    if (configuredMatchDiff !== 0) return configuredMatchDiff;
    return Number(right.isDefault === true) - Number(left.isDefault === true);
  });
  return sorted[0]?.slug ?? input.currentModel;
}

function preferredEffortOrderForTier(
  tier: AutoCapabilityTier,
  configuredEffort: string | undefined,
): ReadonlyArray<string> {
  switch (tier) {
    case "fast":
      return preferredEffortOrder("lite", configuredEffort);
    case "standard":
      return ["medium", "high", "low"];
    case "deep":
      return preferredEffortOrder("deep", configuredEffort);
    case "frontier":
      return ["ultra", "max", "xhigh", "high", "medium"];
  }
}

/**
 * Applies optional declarative capability tier and minimum tier floor constraints to an Auto
 * selection. Preserves `applyAutoComplexityToSelection` behavior when no tier constraints are set
 * and leaves concrete (non-Auto) selections untouched.
 */
export function applyAutoRoutingConstraints(input: {
  readonly selection: ModelSelection;
  readonly constraints?: AutoRoutingConstraints | undefined;
  readonly complexity?: AutoRequestComplexity | undefined;
  readonly account: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<AutoComplexityModelOption>;
  };
  readonly started: boolean;
  readonly previousModel?: string | undefined;
  readonly configuredAuto: AutoModeModel | null;
  readonly modelHasRoom?: ((slug: string) => boolean) | undefined;
}): ModelSelection {
  if (input.selection.autoAccount !== true || input.selection.quotaAwareAuto === true) {
    return input.selection;
  }
  const hasTierConstraint =
    input.constraints?.capabilityTier !== undefined || input.constraints?.minTier !== undefined;
  if (!hasTierConstraint) {
    if (input.complexity === undefined) return input.selection;
    return applyAutoComplexityToSelection({
      selection: input.selection,
      complexity: input.complexity,
      account: input.account,
      started: input.started,
      previousModel: input.previousModel,
      configuredAuto: input.configuredAuto,
      modelHasRoom: input.modelHasRoom,
    });
  }

  const hasRoom = input.modelHasRoom ?? (() => true);
  const effectiveTier = resolveEffectiveCapabilityTier({
    complexity: input.complexity,
    constraints: input.constraints,
  });

  let chosenModel = input.selection.model;
  if (effectiveTier === "fast") {
    if (!input.started) {
      chosenModel = selectLiteModel({
        driver: input.account.driver,
        currentModel: input.selection.model,
        models: input.account.models,
        modelHasRoom: hasRoom,
      });
    } else if (input.previousModel !== undefined && input.previousModel !== input.selection.model) {
      const resolvedPrevious = resolveSelectableModel(
        input.account.driver,
        input.previousModel,
        input.account.models,
      );
      if (
        resolvedPrevious !== null &&
        resolvedPrevious !== input.selection.model &&
        isAlreadyLiteModel(input.account.driver, resolvedPrevious) &&
        hasRoom(resolvedPrevious)
      ) {
        chosenModel = resolvedPrevious;
      }
    }
  } else if (effectiveTier === "frontier") {
    chosenModel = selectFlagshipModel({
      driver: input.account.driver,
      currentModel: input.selection.model,
      models: input.account.models,
      configuredAuto: input.configuredAuto,
      modelHasRoom: hasRoom,
    });
  } else if (isAlreadyLiteModel(input.account.driver, chosenModel)) {
    const resolvedConfigured =
      input.configuredAuto?.model !== undefined
        ? resolveSelectableModel(
            input.account.driver,
            input.configuredAuto.model,
            input.account.models,
          )
        : null;
    if (
      resolvedConfigured !== null &&
      !isAlreadyLiteModel(input.account.driver, resolvedConfigured) &&
      hasRoom(resolvedConfigured)
    ) {
      chosenModel = resolvedConfigured;
    } else {
      chosenModel = selectFlagshipModel({
        driver: input.account.driver,
        currentModel: chosenModel,
        models: input.account.models,
        configuredAuto: input.configuredAuto,
        modelHasRoom: hasRoom,
      });
    }
  }

  const modelChanged = chosenModel !== input.selection.model;
  const resolvedSlug =
    resolveSelectableModel(input.account.driver, chosenModel, input.account.models) ?? chosenModel;
  const modelEntry = input.account.models.find((model) => model.slug === resolvedSlug);
  const descriptors = modelEntry?.capabilities?.optionDescriptors;
  const effortDescriptor = findEffortDescriptor(modelEntry?.capabilities);

  let nextOptions: ReadonlyArray<ProviderOptionSelection> | undefined = input.selection.options;
  if (modelChanged && descriptors !== undefined) {
    nextOptions = acceptedOptionSelections(descriptors, nextOptions);
  }

  if (effortDescriptor !== undefined) {
    const allowedChoices = new Set(
      effortDescriptor.options
        .map((choice) => choice.id)
        .filter((id) => !effortDescriptor.promptInjectedValues?.includes(id)),
    );
    const configuredEffort = configuredEffortValue(
      input.configuredAuto,
      effortDescriptor,
      descriptors ?? [effortDescriptor],
    );
    const targetEffort = preferredEffortOrderForTier(effectiveTier, configuredEffort).find(
      (choice) => allowedChoices.has(choice),
    );
    if (targetEffort !== undefined) {
      const existing = nextOptions ?? [];
      let replaced = false;
      const updated = existing.map((option) => {
        if (option.id !== effortDescriptor.id) return option;
        replaced = true;
        return { id: effortDescriptor.id, value: targetEffort };
      });
      nextOptions = replaced
        ? updated
        : [...updated, { id: effortDescriptor.id, value: targetEffort }];
    }
  }

  const candidate = withModelSelectionOptions(
    { ...input.selection, model: chosenModel, autoAccount: true },
    nextOptions,
  );
  return modelSelectionsEqual(candidate, input.selection) ? input.selection : candidate;
}
