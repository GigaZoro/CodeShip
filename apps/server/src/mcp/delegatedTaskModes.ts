import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { withLegacyUltracodeEffort } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";

/** How much a runtime mode allows, narrowest first. */
export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/**
 * The mode a child runs at: the one asked for, never broader than its parent's.
 * An inherited mode the target provider does not offer steps down to the
 * broadest one it does; an explicitly requested one is refused instead.
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/** Yields the model a slug or alias names; a provider that lists no models accepts any slug. */
export const findAdvertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find(
    (candidate) =>
      candidate.slug === model ||
      candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

/** The slug a provider lists for a model named by slug or alias, or the name as given. */
export const advertisedSlug = (provider: ServerProvider | undefined, model: string) =>
  (provider === undefined ? undefined : findAdvertisedModel(provider, model))?.slug ?? model;

/** Skip checks without descriptors; reject duplicate IDs because consumers disagree on precedence. */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

/**
 * The options without each inherited one the model cannot run: one it does not offer, or a repeat
 * of an id already kept. `inheritedIds` names the inherited ids; without it, every option is.
 */
export function withoutUnrunnableInherited(
  options: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  inheritedIds?: ReadonlySet<string>,
): ReadonlyArray<ProviderOptionSelection> {
  const kept = new Set<string>();
  return options.filter((option) => {
    if (inheritedIds !== undefined && !inheritedIds.has(option.id)) return true;
    if (kept.has(option.id) || invalidOptionSelections([option], descriptors).length > 0)
      return false;
    kept.add(option.id);
    return true;
  });
}

/**
 * The options as the model runs them. Each must be one the model offers, except those with an id
 * in `inheritedIds`, which came from a parent rather than the caller: withoutUnrunnableInherited
 * drops those the model cannot run.
 */
export function requireOfferedOptions(
  selection: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  },
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
  inheritedIds?: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<ProviderOptionSelection> | undefined, OrchestratorMcpFailure> {
  const named = withLegacyUltracodeEffort(descriptors ?? [], selection.options) ?? undefined;
  const options =
    inheritedIds === undefined || named === undefined
      ? named
      : withoutUnrunnableInherited(named, descriptors, inheritedIds);
  const invalid = invalidOptionSelections(options ?? [], descriptors);
  return invalid.length === 0
    ? Effect.succeed(options)
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Model ${selection.model} on provider ${selection.instanceId} rejected options: ${invalid.join(" ")}`,
        }),
      );
}

/** A child's options: each given one replaces the inherited one with its id, and [] clears them. */
export function overrideOptions(
  inherited: ReadonlyArray<ProviderOptionSelection> | undefined,
  given: ReadonlyArray<ProviderOptionSelection> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (given === undefined) return inherited;
  if (given.length === 0) return [];
  const selections = new Map((inherited ?? []).map((selection) => [selection.id, selection]));
  for (const selection of given) selections.set(selection.id, selection);
  return [...selections.values()];
}

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}
