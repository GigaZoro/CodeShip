import * as Cause from "effect/Cause";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProjectId } from "@t3tools/contracts/baseSchemas";
import { TextGenerationError } from "@t3tools/contracts/git";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import { isProviderAvailable, isProviderTextGenerationCapable } from "@t3tools/contracts/provider";
import type { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import {
  isProviderInstanceBackgroundAllowed,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow, isPayPerUseAccount } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { ApiCreditBalance } from "../provider/ApiCreditBalance.ts";
import { UsageService } from "../usage/UsageService.ts";
import { TokenPricing } from "../usage/TokenPricing.ts";
import { routeAutoAccount } from "../orchestration-v2/AccountRouting.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
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
  | "generateManualStepReview";

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
  const balances = yield* Effect.serviceOption(ApiCreditBalance);
  const usage = yield* Effect.serviceOption(UsageService);
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    if (selection.quotaAwareAuto === true)
      return yield* new TextGenerationError({
        operation,
        detail: "Auto needs a provider selection before starting text generation.",
        retryable: false,
      });
    const instances = yield* registry.listInstances;
    const instanceById = new Map(instances.map((instance) => [instance.instanceId, instance]));
    const snapshots = yield* Option.isSome(providerRegistry)
      ? providerRegistry.value.getProviders
      : Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not read billing routing settings.",
            cause,
          }),
      ),
    );
    if (
      Option.isNone(providerRegistry) &&
      snapshots.some((provider) => provider.billingKind === "payPerUse")
    )
      return yield* new TextGenerationError({
        operation,
        detail: "Validated API credit account routing is unavailable.",
      });
    const route = (candidate: ModelSelection) =>
      routeAutoAccount({
        selection: candidate,
        settings,
        providers: snapshots,
        nowMs: now,
        projectId: ProjectId.make("text-generation"),
        currentInstanceId: candidate.instanceId,
        started: true,
        recordedLimits: new Map(),
        mcpSignInsNeeded: new Map(),
      });
    selection = route(selection);
    const limited = exhaustedUsageWindow(
      snapshots.find((provider) => provider.instanceId === selection.instanceId),
      now,
      selection.model,
    );
    if (limited) {
      selection =
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            return (
              instanceId !== selection.instanceId &&
              provider?.enabled === true &&
              resolveProjectProviderInstanceEnabled(settings, null, instanceId) &&
              isProviderInstanceBackgroundAllowed(settings, instanceId) &&
              provider.installed &&
              provider.auth.status !== "unauthenticated" &&
              isProviderAvailable(provider) &&
              isProviderTextGenerationCapable(provider) &&
              (operation !== "generateReviewGuide" ||
                instanceById.get(instanceId)?.textGeneration.supportsInvestigation === true) &&
              !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
            );
          },
          { includeConfiguredInstances: true },
        ) ?? selection;
      selection = route(selection);
    }
    const provider = snapshots.find((candidate) => candidate.instanceId === selection.instanceId);
    if (
      provider &&
      (!isProviderAvailable(provider) || provider.auth.status === "unauthenticated")
    ) {
      return yield* new TextGenerationError({
        operation,
        detail: "The selected provider account is unavailable or not authenticated.",
      });
    }
    const paid = provider !== undefined && isPayPerUseAccount(provider);
    if (paid && Option.isNone(balances)) {
      return yield* new TextGenerationError({
        operation,
        detail: "API balance tracking is unavailable.",
      });
    }
    if (paid && Option.isSome(balances)) {
      yield* balances.value
        .assertAvailable(selection.instanceId)
        .pipe(
          Effect.mapError(
            (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
          ),
        );
    }
    if (provider && exhaustedUsageWindow(provider, now, selection.model)) {
      return yield* new TextGenerationError({
        operation,
        detail: "No provider account has usage available for text generation.",
      });
    }
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
    const generation = invoke(instance.textGeneration, selection);
    const tracked = Option.isSome(balances)
      ? generation.pipe(Effect.provideService(ApiCreditBalance, balances.value))
      : generation;
    const priced = Option.isSome(usage)
      ? tracked.pipe(Effect.provideService(TokenPricing, { priceTokens: usage.value.priceTokens }))
      : tracked;
    return yield* priced.pipe(
      Effect.provideService(TextGenerationUsageSink, (calls) => {
        reported.push(...calls);
      }),
      Effect.provideService(TextGenerationOperations.OnDispatch, () => {
        dispatched += 1;
        if (settled === undefined || reported.length > 0 || dispatched <= written) return;
        // The provider accepted a send after the generation ended, so nothing awaits this row.
        written = dispatched;
        Effect.runForkWith(services)(recordUsage(operation, instance, unknownCalls(1), settled));
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
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate("generateCommitMessage", input.modelSelection, (service, modelSelection) =>
        service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate("generatePrContent", input.modelSelection, (service, modelSelection) =>
        service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate("generateBranchName", input.modelSelection, (service, modelSelection) =>
        service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate("generateReviewGuide", input.modelSelection, (service, modelSelection) =>
        service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateManualStepReview: Effect.fn("TextGeneration.generateManualStepReview")(
      function (input) {
        return generate(
          "generateManualStepReview",
          input.modelSelection,
          (service, modelSelection) =>
            service.generateManualStepReview({ ...input, modelSelection }),
        );
      },
    ),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
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
  Layer.provide(TextGenerationUsageRepository.layer),
);
