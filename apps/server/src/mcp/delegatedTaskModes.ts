import {
  DELEGATED_REVIEW_ROUND_LIMIT,
  type ModelSelection,
  type OrchestrationV2DelegatedReviewRequest,
  type OrchestrationV2SubagentReview,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
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

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

/** What a task asks of its parent's review count: a review task counts, others must not ask. */
export function reviewRequest(
  input: OrchestratorMcpDelegateTaskInput,
): Effect.Effect<OrchestrationV2DelegatedReviewRequest | undefined, OrchestratorMcpFailure> {
  if (input.role === "review") {
    return Effect.succeed(
      input.newReviewPart === undefined ? {} : { newPartReason: input.newReviewPart },
    );
  }
  return input.newReviewPart === undefined
    ? Effect.undefined
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: 'newReviewPart applies only to role "review".',
        }),
      );
}

/** The refusal of a review round past the limit, quoting the review rule it enforces. */
export function reviewRoundLimitFailure(refused: {
  readonly part: number;
  readonly rounds: number;
}): OrchestratorMcpFailure {
  const part = refused.part === 1 ? "this change" : `part ${refused.part} of this change`;
  return new OrchestratorMcpFailure({
    code: "review_round_limit",
    message: [
      `Review round ${refused.rounds + 1} refused: this chat already ran ${refused.rounds} review rounds of ${part}.`,
      `Review rule 8 (~/.agents/rules/review.md): "Fix-loop until approved, in at most three rounds. [...] When round 3 still finds any blocking defect (Critical or Major), in a fix or in code reviewed before, the approach is wrong: stop, re-plan or split the change, and report why instead of starting round 4."`,
      "Report why instead. Once the change is re-planned or split, call again with `newReviewPart`: one line saying how. That review starts round 1 of a new part.",
    ].join("\n"),
  });
}

/** How a result reports a review task's round in its parent thread. */
export function reviewRoundText(
  review: OrchestrationV2SubagentReview | undefined,
): string | undefined {
  if (review === undefined) return undefined;
  const part = review.part === 1 ? "" : ` (part ${review.part})`;
  const last =
    review.round < DELEGATED_REVIEW_ROUND_LIMIT
      ? ""
      : " The last one: if it still finds a blocking defect, re-plan or split the change instead of starting another.";
  return `Review round ${review.round} of ${DELEGATED_REVIEW_ROUND_LIMIT} in this chat${part}.${last}`;
}
