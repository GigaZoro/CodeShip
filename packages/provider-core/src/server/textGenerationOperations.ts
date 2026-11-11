import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type ChatAttachment, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import type { ManualStepReviewGenerationResult, ProviderTextGeneration } from "./textGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildManualStepReviewPrompt,
  buildPrContentPrompt,
  buildReviewGuidePrompt,
  buildThreadTitlePrompt,
} from "./textGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;

export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Investigate cwd with read-only tools across turns; fail if the runner cannot guarantee read-only access. */
  readonly investigate?: { readonly timeoutMs: number } | undefined;
}

const INVESTIGATION_TIMEOUT_MS = 15 * 60_000;

export const investigationUnsupported = (operation: Operation, provider: string) =>
  new TextGenerationError({
    operation,
    detail: `${provider} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set.`,
  });

export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

export const withoutInvestigation =
  (provider: string, run: Runner): Runner =>
  (request) =>
    request.investigate
      ? Effect.fail(investigationUnsupported(request.operation, provider))
      : run(request);

export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

const MANUAL_STEP_SOLUTION_LIMIT = 3;
const MANUAL_STEP_SOLUTION_TITLE_LIMIT = 80;

interface RawManualStepReview {
  readonly summary: string;
  readonly needsPerson: boolean;
  readonly solutions: ReadonlyArray<{
    readonly title: string;
    readonly detail: string;
    readonly command?: string | undefined;
    readonly agentCanDo: boolean;
  }>;
}

export function normalizeManualStepReview(
  generated: RawManualStepReview,
): Effect.Effect<ManualStepReviewGenerationResult, TextGenerationError> {
  const summary = generated.summary.trim();
  const solutions = generated.solutions
    .flatMap((solution) => {
      const title = solution.title.trim().slice(0, MANUAL_STEP_SOLUTION_TITLE_LIMIT).trim();
      if (title.length === 0) return [];
      const command = solution.command?.trim() ?? "";
      return [
        {
          title,
          detail: solution.detail.trim(),
          ...(command.length > 0 ? { command } : {}),
          agentCanDo: solution.agentCanDo,
        },
      ];
    })
    .slice(0, MANUAL_STEP_SOLUTION_LIMIT);
  return summary.length === 0 || solutions.length === 0
    ? Effect.fail(
        new TextGenerationError({
          operation: "generateManualStepReview",
          detail: "The model returned a review without a summary or without solutions.",
        }),
      )
    : Effect.succeed({ summary, needsPerson: generated.needsPerson, solutions });
}

export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateCommitMessage: ProviderTextGeneration["generateCommitMessage"] = Effect.fn(
    `${name}.generateCommitMessage`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      }),
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: ProviderTextGeneration["generatePrContent"] = Effect.fn(
    `${name}.generatePrContent`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generatePrContent",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
        threadContext: input.threadContext,
      }),
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: ProviderTextGeneration["generateBranchName"] = Effect.fn(
    `${name}.generateBranchName`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateBranchName",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      }),
    });
    return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
  });

  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        forkSource: input.forkSource,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
        instructions: input.instructions,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const generateReviewGuide: ProviderTextGeneration["generateReviewGuide"] = Effect.fn(
    `${name}.generateReviewGuide`,
  )(function* (input) {
    return yield* run({
      operation: "generateReviewGuide",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      investigate: { timeoutMs: INVESTIGATION_TIMEOUT_MS },
      ...buildReviewGuidePrompt(input),
    });
  });

  const generateManualStepReview: ProviderTextGeneration["generateManualStepReview"] = Effect.fn(
    `${name}.generateManualStepReview`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateManualStepReview",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      ...buildManualStepReviewPrompt(input),
    });
    return yield* normalizeManualStepReview(generated);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateReviewGuide,
    generateManualStepReview,
  } satisfies ProviderTextGeneration;
}
