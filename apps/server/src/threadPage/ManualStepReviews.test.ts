import { describe, expect, it } from "@effect/vitest";
import {
  type ManualStep,
  type ManualStepReview,
  type TextGenerationError,
  TextGenerationError as TextGenerationFailure,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import { PersistenceDecodeError } from "../persistence/Errors.ts";
import * as ManualStepReviewRepository from "../persistence/ManualStepReviews.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ManualStepReviews from "./ManualStepReviews.ts";
import * as ThreadPageManualSteps from "./ThreadPageManualSteps.ts";

const STEP_UPDATED_AT = "2026-11-07T21:41:11.934Z";
const NEWER_UPDATED_AT = "2026-11-08T08:00:00.000Z";

const step = (updatedAt: string): ManualStep => ({
  threadId: "minions",
  title: "Sign in to minions",
  step: "run `claude mcp login minions` on this Mac.",
  kind: "hands-on",
  machine: "MacBook-Pro",
  updatedAt,
  url: "https://thread.page/app/threads/minions",
});

interface Harness {
  readonly lookup: Ref.Ref<"listed" | "missing" | "not-connected">;
  readonly stepUpdatedAt: Ref.Ref<string>;
  readonly generations: Ref.Ref<number>;
  readonly gate: Ref.Ref<Deferred.Deferred<void> | null>;
  readonly started: Ref.Ref<Deferred.Deferred<void> | null>;
  readonly failWith: Ref.Ref<TextGenerationError | null>;
  readonly command: Ref.Ref<string>;
  readonly decodeFails: Ref.Ref<boolean>;
}

const makeHarness = Effect.gen(function* () {
  return {
    lookup: yield* Ref.make<"listed" | "missing" | "not-connected">("listed"),
    stepUpdatedAt: yield* Ref.make(STEP_UPDATED_AT),
    generations: yield* Ref.make(0),
    gate: yield* Ref.make<Deferred.Deferred<void> | null>(null),
    started: yield* Ref.make<Deferred.Deferred<void> | null>(null),
    failWith: yield* Ref.make<TextGenerationError | null>(null),
    command: yield* Ref.make("claude mcp login minions"),
    decodeFails: yield* Ref.make(false),
  } satisfies Harness;
});

const memoryRepository = (harness: Harness) =>
  Layer.effect(
    ManualStepReviewRepository.ManualStepReviewRepository,
    Effect.gen(function* () {
      const rows = yield* Ref.make(new Map<string, ManualStepReview>());
      return {
        get: (threadId) =>
          Effect.gen(function* () {
            if (yield* Ref.get(harness.decodeFails)) {
              return yield* new PersistenceDecodeError({
                operation: "ManualStepReview",
                issue: "unreadable row",
              });
            }
            return Option.fromNullishOr((yield* Ref.get(rows)).get(threadId));
          }),
        put: (review) => Ref.update(rows, (map) => new Map(map).set(review.threadId, review)),
      } satisfies ManualStepReviewRepository.ManualStepReviewRepository["Service"];
    }),
  );

const layerFor = (harness: Harness) =>
  ManualStepReviews.layer.pipe(
    Layer.provide(memoryRepository(harness)),
    Layer.provide(
      Layer.succeed(ThreadPageManualSteps.ThreadPageManualSteps, {
        findStep: () =>
          Effect.gen(function* () {
            const mode = yield* Ref.get(harness.lookup);
            if (mode === "not-connected") return { _tag: "NotConnected" } as const;
            if (mode === "missing") return { _tag: "Missing" } as const;
            return { _tag: "Found", step: step(yield* Ref.get(harness.stepUpdatedAt)) } as const;
          }),
        notes: () =>
          Effect.succeed([
            {
              createdAt: STEP_UPDATED_AT,
              markdown: "Work order:\n  run   `claude mcp login minions`",
            },
          ]),
      } as unknown as ThreadPageManualSteps.ThreadPageManualSteps["Service"]),
    ),
    Layer.provide(
      Layer.succeed(TextGeneration.TextGeneration, {
        generateManualStepReview: () =>
          Effect.gen(function* () {
            yield* Ref.update(harness.generations, (count) => count + 1);
            const started = yield* Ref.get(harness.started);
            if (started !== null) yield* Deferred.succeed(started, undefined);
            const gate = yield* Ref.get(harness.gate);
            if (gate !== null) yield* Deferred.await(gate);
            const failure = yield* Ref.get(harness.failWith);
            if (failure !== null) return yield* failure;
            return {
              summary: "Waiting for a sign-in.",
              needsPerson: true,
              solutions: [
                {
                  title: "Sign in",
                  detail: "Run the command.",
                  command: yield* Ref.get(harness.command),
                  agentCanDo: false,
                },
              ],
            };
          }),
      } as unknown as TextGeneration.TextGeneration["Service"]),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-manual-step-reviews-" })),
    Layer.provide(NodeServices.layer),
  );

const withReviews = <A, E>(
  harness: Harness,
  use: (service: ManualStepReviews.ManualStepReviews["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ManualStepReviews.ManualStepReviews);
  }).pipe(Effect.provide(layerFor(harness).pipe(Layer.orDie)));

describe("ManualStepReviews", () => {
  it.effect("returns the stored review without generating again", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          const first = yield* service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
          expect(first.updatedAt).toBe(STEP_UPDATED_AT);
          expect(first.summary).toBe("Waiting for a sign-in.");
          // An older client version is also covered by the stored review.
          const second = yield* service.review({
            threadId: "minions",
            updatedAt: "2026-11-01T00:00:00.000Z",
          });
          expect(second).toEqual(first);
        }),
      );
      expect(yield* Ref.get(harness.generations)).toBe(1);
    }),
  );

  it.effect("reviews again when the step has a newer note than the stored review", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          yield* service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
          yield* Ref.set(harness.stepUpdatedAt, NEWER_UPDATED_AT);
          const next = yield* service.review({ threadId: "minions", updatedAt: NEWER_UPDATED_AT });
          expect(next.updatedAt).toBe(NEWER_UPDATED_AT);
        }),
      );
      expect(yield* Ref.get(harness.generations)).toBe(2);
    }),
  );

  it.effect("shares one generation between concurrent requests for a thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      yield* Ref.set(harness.gate, gate);
      yield* Ref.set(harness.started, started);
      const reviews = yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          const input = { threadId: "minions", updatedAt: STEP_UPDATED_AT };
          const first = yield* service
            .review(input)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          const second = yield* service
            .reviewAgain({ threadId: "minions", updatedAt: STEP_UPDATED_AT })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(gate, undefined);
          return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
        }),
      );
      expect(reviews[1]).toEqual(reviews[0]);
      expect(yield* Ref.get(harness.generations)).toBe(1);
    }),
  );

  it.effect("finishes and stores a review after the requesting client is gone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      yield* Ref.set(harness.gate, gate);
      yield* Ref.set(harness.started, started);
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          const request = yield* service
            .review({ threadId: "minions", updatedAt: STEP_UPDATED_AT })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          yield* Fiber.interrupt(request);
          yield* Deferred.succeed(gate, undefined);
          // The next request joins the run that is finishing, or reads what it stored.
          const next = yield* service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
          expect(next.summary).toBe("Waiting for a sign-in.");
        }),
      );
      expect(yield* Ref.get(harness.generations)).toBe(1);
    }),
  );

  it.effect("reports a thread that is no longer a Waiting step as not found", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.lookup, "missing");
      const error = yield* withReviews(harness, (service) =>
        service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT }),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("not-found");
      expect(yield* Ref.get(harness.generations)).toBe(0);
    }),
  );

  it.effect("reports a server without a ThreadPage token as not connected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.lookup, "not-connected");
      const error = yield* withReviews(harness, (service) =>
        service.reviewAgain({ threadId: "minions", updatedAt: STEP_UPDATED_AT }),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("not-connected");
    }),
  );

  it.effect("reviews again on request, replacing the stored review", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          yield* service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
          yield* service.reviewAgain({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
          // The replaced review is what later requests read.
          yield* service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT });
        }),
      );
      expect(yield* Ref.get(harness.generations)).toBe(2);
    }),
  );

  it.effect("maps a failed generation to generation-failed without the model's output", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(
        harness.failWith,
        new TextGenerationFailure({
          operation: "generateManualStepReview",
          detail: "raw model output: tp_secret_token",
        }),
      );
      const error = yield* withReviews(harness, (service) =>
        service.reviewAgain({ threadId: "minions", updatedAt: STEP_UPDATED_AT }),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("generation-failed");
      expect(error.detail).not.toContain("tp_secret_token");
    }),
  );

  it.effect("stores a review under the client's version when the server's step is older", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          const again = yield* service.reviewAgain({
            threadId: "minions",
            updatedAt: NEWER_UPDATED_AT,
          });
          expect(again.updatedAt).toBe(NEWER_UPDATED_AT);
          // The stored review already covers the client's version.
          yield* service.review({ threadId: "minions", updatedAt: NEWER_UPDATED_AT });
        }),
      );
      expect(yield* Ref.get(harness.generations)).toBe(1);
    }),
  );

  it.effect("keeps a command only when the step or its notes contain it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* withReviews(harness, (service) =>
        Effect.gen(function* () {
          // The note has the command with different whitespace.
          const sourced = yield* service.reviewAgain({
            threadId: "minions",
            updatedAt: STEP_UPDATED_AT,
          });
          expect(sourced.solutions[0]?.command).toBe("claude mcp login minions");
          yield* Ref.set(harness.command, "claude mcp login invented --flag");
          const invented = yield* service.reviewAgain({
            threadId: "minions",
            updatedAt: STEP_UPDATED_AT,
          });
          expect(invented.solutions[0]?.command).toBeUndefined();
        }),
      );
    }),
  );

  it.effect("treats a stored review that cannot be decoded as none and replaces it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.decodeFails, true);
      const review = yield* withReviews(harness, (service) =>
        service.review({ threadId: "minions", updatedAt: STEP_UPDATED_AT }),
      );
      expect(review.summary).toBe("Waiting for a sign-in.");
      expect(yield* Ref.get(harness.generations)).toBe(1);
    }),
  );
});
