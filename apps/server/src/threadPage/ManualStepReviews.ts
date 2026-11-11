import {
  type ManualStepReview,
  ManualStepReviewError,
  type ManualStepReviewFailure,
  type ManualStepsListError,
  type TextGenerationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ManualStepReviewRepository from "../persistence/ManualStepReviews.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadPageManualSteps from "./ThreadPageManualSteps.ts";

const MAX_CONCURRENT_GENERATIONS = 2;

type ReviewRun = Deferred.Deferred<ManualStepReview, ManualStepReviewError>;

export class ManualStepReviews extends Context.Service<
  ManualStepReviews,
  {
    /** The stored review when it read this step version or a newer one, else a new one. */
    readonly review: (input: {
      readonly threadId: string;
      readonly updatedAt: string;
    }) => Effect.Effect<ManualStepReview, ManualStepReviewError>;
    /** A new review that replaces the stored one. */
    readonly reviewAgain: (input: {
      readonly threadId: string;
      readonly updatedAt: string;
    }) => Effect.Effect<ManualStepReview, ManualStepReviewError>;
  }
>()("t3/threadPage/ManualStepReviews") {}

const failure = (reason: ManualStepReviewFailure, detail: string) =>
  new ManualStepReviewError({ reason, detail });

const fromListError = (error: ManualStepsListError) => failure(error.reason, error.detail);

// Model errors can carry raw output and provider details; clients get a fixed sentence and the
// server log keeps the detail, so a timeout can be told from an auth failure.
const fromGenerationError = (threadId: string, error: TextGenerationError) =>
  Effect.logWarning("Manual step review model call failed", {
    threadId,
    operation: error.operation,
    detail: error.detail,
    ...(error.cause === undefined ? {} : { cause: Cause.pretty(Cause.fail(error.cause)) }),
  }).pipe(
    Effect.andThen(
      Effect.fail(failure("generation-failed", "The model could not review this step.")),
    ),
  );

const collapseWhitespace = (text: string) => text.replace(/\s+/g, " ");

// A command is shown with a Copy button, so it must come from the step or its notes.
const commandInSource = (command: string, sources: ReadonlyArray<string>) => {
  const wanted = collapseWhitespace(command.trim());
  return wanted.length > 0 && sources.some((source) => collapseWhitespace(source).includes(wanted));
};

const make = Effect.gen(function* () {
  const threadPage = yield* ThreadPageManualSteps.ThreadPageManualSteps;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const reviews = yield* ManualStepReviewRepository.ManualStepReviewRepository;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Effect.scope;
  const generationSlots = yield* Semaphore.make(MAX_CONCURRENT_GENERATIONS);
  const claims = yield* Semaphore.make(1);
  const runs = yield* Ref.make<ReadonlyMap<string, ReviewRun>>(new Map());

  // A row that no longer decodes is as good as none: the next generation overwrites it.
  const readStored = (threadId: string) =>
    reviews.get(threadId).pipe(
      Effect.catchTags({
        PersistenceDecodeError: (error) =>
          Effect.logWarning("Stored manual step review could not be decoded", {
            threadId,
            detail: error.message,
          }).pipe(Effect.as(Option.none<ManualStepReview>())),
      }),
      Effect.mapError(() => failure("generation-failed", "Could not read the stored review.")),
    );

  const generate = Effect.fn("ManualStepReviews.generate")(function* (
    threadId: string,
    updatedAt: string,
    force: boolean,
  ) {
    if (!force) {
      // A run that finished while this request waited for its turn has already stored the answer.
      const stored = Option.getOrNull(yield* readStored(threadId));
      if (stored !== null && stored.updatedAt >= updatedAt) return stored;
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => failure("generation-failed", "Could not read the model settings.")),
    );
    const modelSelection = settings.textGenerationModelSelection;
    // The step lookup and notes read hit ThreadPage; they share the model call's slot so that
    // many rows asking at once do not all read ThreadPage at once.
    const generated = yield* generationSlots.withPermits(1)(
      Effect.gen(function* () {
        const lookup = yield* threadPage
          .findStep(threadId, updatedAt)
          .pipe(Effect.mapError(fromListError));
        if (lookup._tag === "NotConnected") {
          return yield* failure("not-connected", "ThreadPage is not connected on this server.");
        }
        if (lookup._tag === "Missing") {
          return yield* failure(
            "not-found",
            "This step is no longer waiting in the Machine inbox.",
          );
        }
        const { step } = lookup;
        const notes = yield* threadPage.notes(threadId).pipe(Effect.mapError(fromListError));
        const result = yield* textGeneration
          .generateManualStepReview({
            cwd: config.baseDir,
            step: { title: step.title, step: step.step, kind: step.kind, machine: step.machine },
            notes,
            modelSelection,
          })
          .pipe(Effect.catch((error) => fromGenerationError(threadId, error)));
        return { step, notes, result };
      }),
    );
    const { step, notes, result } = generated;
    const sources = [step.title, step.step, ...notes.map((note) => note.markdown)];
    const review: ManualStepReview = {
      threadId,
      // The client keys the review by the version it shows; a lagging list must not break that.
      updatedAt: step.updatedAt >= updatedAt ? step.updatedAt : updatedAt,
      summary: result.summary,
      needsPerson: result.needsPerson,
      solutions: result.solutions.map(({ command, ...solution }) =>
        command !== undefined && commandInSource(command, sources)
          ? { ...solution, command }
          : solution,
      ),
      generatedAt: DateTime.formatIso(yield* DateTime.now),
      modelSelection,
    };
    yield* reviews
      .put(review)
      .pipe(Effect.mapError(() => failure("generation-failed", "Could not store the review.")));
    return review;
  });

  // The run lives in the service's scope, so it finishes and stores its review even when the
  // client that asked for it disconnects; every request for the same thread waits on one run.
  const join = Effect.fn("ManualStepReviews.join")(function* (
    threadId: string,
    updatedAt: string,
    force: boolean,
  ) {
    const run = yield* claims.withPermits(1)(
      Effect.gen(function* () {
        const existing = (yield* Ref.get(runs)).get(threadId);
        if (existing !== undefined) return existing;
        const created = yield* Deferred.make<ManualStepReview, ManualStepReviewError>();
        yield* Ref.update(runs, (current) => new Map(current).set(threadId, created));
        yield* generate(threadId, updatedAt, force).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Manual step review failed", {
              threadId,
              reason: error.reason,
              detail: error.detail,
            }),
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            claims
              .withPermits(1)(
                Ref.update(runs, (current) => {
                  const next = new Map(current);
                  next.delete(threadId);
                  return next;
                }),
              )
              .pipe(Effect.andThen(Deferred.done(created, exit)), Effect.asVoid),
          ),
          Effect.forkIn(serviceScope),
        );
        return created;
      }),
    );
    return yield* Deferred.await(run);
  });

  const review: ManualStepReviews["Service"]["review"] = Effect.fn("ManualStepReviews.review")(
    function* (input) {
      const stored = Option.getOrNull(yield* readStored(input.threadId));
      if (stored !== null && stored.updatedAt >= input.updatedAt) return stored;
      return yield* join(input.threadId, input.updatedAt, false);
    },
  );

  const reviewAgain: ManualStepReviews["Service"]["reviewAgain"] = Effect.fn(
    "ManualStepReviews.reviewAgain",
  )(function* (input) {
    return yield* join(input.threadId, input.updatedAt, true);
  });

  return ManualStepReviews.of({ review, reviewAgain });
});

export const layer = Layer.effect(ManualStepReviews, make);
