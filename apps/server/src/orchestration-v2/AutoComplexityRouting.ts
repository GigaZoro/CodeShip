import {
  REASONING_EFFORT_OPTION_IDS,
  type AutoModeModel,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type SelectProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  acceptedOptionSelections,
  modelSelectionsEqual,
  resolveSelectableModel,
  withLegacyUltracodeEffort,
  withModelSelectionOptions,
  type SelectableModelOption,
} from "@t3tools/shared/model";

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
