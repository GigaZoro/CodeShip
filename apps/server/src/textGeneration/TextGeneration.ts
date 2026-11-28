import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ModelSelection, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderInstanceBackgroundAllowed,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import { fallbackTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationUsageRepository from "../persistence/TextGenerationUsage.ts";
import {
  TextGenerationAttribution,
  type TextGenerationCallUsage,
  TextGenerationUsageSink,
  unknownCallUsage,
} from "./TextGenerationUsage.ts";

type UsageOutcome = Pick<
  TextGenerationUsageRepository.TextGenerationUsageRow,
  "outcome" | "errorDetail"
>;

const usageOutcome = (exit: Exit.Exit<unknown, TextGenerationError>): UsageOutcome =>
  Exit.isSuccess(exit)
    ? { outcome: "succeeded", errorDetail: null }
    : Cause.hasInterruptsOnly(exit.cause)
      ? { outcome: "interrupted", errorDetail: null }
      : {
          outcome: "failed",
          errorDetail: Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.detail ?? null,
        };

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  ManualStepReviewGenerationInput,
  ManualStepReviewGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateManualStepReview"
  | "generateTranscriptionPostProcessing";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.filterOrFail(
      (instance): instance is ProviderInstance => instance !== undefined,
      () =>
        new TextGenerationError({
          operation,
          detail: `No provider instance registered for id '${instanceId}'.`,
          retryable: false,
        }),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const usageRepository = yield* TextGenerationUsageRepository.TextGenerationUsageRepository;
  const recordUsage = Effect.fn("TextGeneration.recordUsage")(function* (
    operation: TextGenerationOp,
    instance: ProviderInstance,
    calls: ReadonlyArray<TextGenerationCallUsage>,
    { outcome, errorDetail }: UsageOutcome,
  ) {
    const { threadId, demandId } = yield* TextGenerationAttribution;
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    yield* usageRepository
      .record(
        calls.map((call) => ({
          ...call,
          driver: instance.driverKind,
          providerInstanceId: instance.instanceId,
          operation,
          threadId,
          demandId,
          outcome,
          errorDetail,
          occurredAt,
        })),
      )
      .pipe(
        // The ledger runs as the generation's finalizer, so a defect would replace its result.
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record text generation usage", { operation, cause }),
        ),
      );
  });
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    if (selection.quotaAwareAuto === true) {
      return yield* new TextGenerationError({
        operation,
        detail: "Auto needs a provider selection before starting text generation.",
        retryable: false,
      });
    }
    const textGenerator = yield* textGenerators.runner(selection.instanceId);
    // A review guide reaches a text generator only through a fallback; it needs an agent instead.
    const textGeneratorId = selection.instanceId;
    const textGeneratorCannotRun =
      textGenerator !== undefined && operation === "generateReviewGuide";
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        selection,
      );
    }
    const instances = yield* registry.listInstances;
    const instanceById = new Map(instances.map((instance) => [instance.instanceId, instance]));
    const snapshots = yield* Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    const selectedDisabled = selected?.enabled === false;
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      selectedDisabled ||
      (selected?.enabled === true &&
        (!isProviderTextGenerationCapable(selected) ||
          selected.models.find((model) => model.slug === selection.model)
            ?.supportsTextGeneration === false ||
          (selected.status === "error" &&
            (!selected.installed || selected.auth.status === "unauthenticated"))));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      const rejected = selection;
      const fallbackWhere = (sameInstance: boolean) =>
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver, model) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            return (
              (sameInstance ? model !== rejected.model : instanceId !== rejected.instanceId) &&
              provider?.enabled === true &&
              resolveProjectProviderInstanceEnabled(settings, projectId ?? null, instanceId) &&
              isProviderInstanceBackgroundAllowed(settings, instanceId) &&
              provider.installed &&
              provider.auth.status !== "unauthenticated" &&
              provider.status !== "error" &&
              isProviderAvailable(provider) &&
              isProviderTextGenerationCapable(provider) &&
              provider.models.find((candidate) => candidate.slug === model)
                ?.supportsTextGeneration !== false &&
              (operation !== "generateReviewGuide" ||
                instanceById.get(instanceId)?.textGeneration.supportsInvestigation === true) &&
              !exhaustedUsageWindow(provider, now, model)
            );
          },
          { defaultModelSelection: settings.defaultModelSelection },
        );
      // Another instance first; the rejected instance's other models only when none qualifies.
      selection = fallbackWhere(false) ?? fallbackWhere(true) ?? selection;
    }
    if (textGeneratorCannotRun && selection.instanceId === textGeneratorId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control & issues.",
      });
    }
    if (selectedDisabled && selection.instanceId === selected.instanceId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "No text generation provider is available. Enable a provider that can generate text in Settings → Providers.",
      });
    }
    return yield* installationGate.execute(
      selection.instanceId,
      Effect.gen(function* () {
        const instance = yield* resolveInstance(registry, operation, selection.instanceId);
        const services = yield* Effect.context<never>();
        const unknownCalls = (count: number) =>
          Array.from({ length: count }, () => unknownCallUsage(selection.model));
        // One writer per call: the usage the runner reported, else one unknown-count row per send the
        // provider accepted. A success proves one even from a runner that does not signal dispatch.
        const reported: Array<TextGenerationCallUsage> = [];
        let dispatched = 0;
        let written = 0;
        let settled: UsageOutcome | undefined;
        return yield* invoke(instance.textGeneration, selection).pipe(
          Effect.provideService(TextGenerationUsageSink, (calls) => {
            reported.push(...calls);
          }),
          Effect.provideService(TextGenerationOperations.OnDispatch, () => {
            dispatched += 1;
            if (settled === undefined || reported.length > 0 || dispatched <= written) return;
            // The provider accepted a send after the generation ended, so nothing awaits this row.
            written = dispatched;
            Effect.runForkWith(services)(
              recordUsage(operation, instance, unknownCalls(1), settled),
            );
          }),
          Effect.onExit((exit) => {
            settled = usageOutcome(exit);
            if (reported.length > 0) return recordUsage(operation, instance, reported, settled);
            written = Math.max(dispatched, Exit.isSuccess(exit) ? 1 : 0);
            return written === 0
              ? Effect.void
              : recordUsage(operation, instance, unknownCalls(written), settled);
          }),
        );
      }),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    generateManualStepReview: Effect.fn("TextGeneration.generateManualStepReview")(
      function (input) {
        return generate(
          "generateManualStepReview",
          input.modelSelection,
          null,
          (service, modelSelection) =>
            service.generateManualStepReview({ ...input, modelSelection }),
        );
      },
    ),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
  Layer.provide(TextGenerationUsageRepository.layer),
);
