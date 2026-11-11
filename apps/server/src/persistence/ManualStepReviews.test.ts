import { assert, it } from "@effect/vitest";
import type { ManualStepReview } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ManualStepReviews from "./ManualStepReviews.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const review = (threadId: string, generatedAt: string): ManualStepReview => ({
  threadId,
  updatedAt: "2026-11-07T21:41:11.934Z",
  summary: "Waiting for a sign-in.",
  needsPerson: true,
  solutions: [
    { title: "Sign in", detail: "Run it.", command: "claude mcp login", agentCanDo: false },
  ],
  generatedAt,
  modelSelection: { instanceId: "codex", model: "gpt-5" } as ManualStepReview["modelSelection"],
});

it.effect("stores a review per thread and drops reviews older than 30 days on write", () =>
  Effect.gen(function* () {
    const repository = yield* ManualStepReviews.ManualStepReviewRepository;
    yield* repository.put(review("old", "2026-10-01T00:00:00.000Z"));
    yield* repository.put(review("recent", "2026-11-10T00:00:00.000Z"));
    const replacement = { ...review("recent", "2026-11-11T00:00:00.000Z"), summary: "Replaced." };
    yield* repository.put(replacement);

    assert.deepStrictEqual(yield* repository.get("recent"), Option.some(replacement));
    assert.deepStrictEqual(yield* repository.get("old"), Option.none());
  }).pipe(
    Effect.provide(ManualStepReviews.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
