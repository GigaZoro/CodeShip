import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2DelegatedReviewRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as SqlClient from "effect/sql/SqlClient";
import type { MigrationError } from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { seedLiveParent as seedLiveParentThread } from "./testkit/LiveParentThread.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// A parent thread counts the review rounds it delegates, so a fourth round nobody re-planned
// is refused instead of started.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for review round records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerFor = (
  databaseLayer: Layer.Layer<
    SqlClient.SqlClient,
    MigrationError | PlatformError.PlatformError | SqlError
  >,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "delegated-review-rounds" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  );

const remoteChild = {
  environmentId: EnvironmentId.make("environment:box"),
  threadId: ThreadId.make("thread:reviewer-on-the-box"),
  label: "Box",
};

type Parent = Effect.Success<ReturnType<typeof seedLiveParentThread>>;

const requestReview = (
  parent: Parent,
  key: string,
  // null: a task that is not a review.
  review: OrchestrationV2DelegatedReviewRequest | null = {},
) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "delegated_task.remote.request",
      commandId: CommandId.make(`command:review:${key}`),
      parentThreadId: parent.threadId,
      parentRunId: parent.runId,
      parentNodeId: parent.rootNodeId,
      task: `Review the diff (${key}).`,
      driver: ProviderDriverKind.make("remote"),
      modelSelection,
      remoteChild,
      ...(review === null ? {} : { review }),
    }),
  );

/** The task a request started, with its place in the parent's review count. */
const taskFor = (parent: Parent, key: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.getThreadProjection(parent.threadId),
  ).pipe(
    Effect.map((projection) =>
      projection.subagents.find((task) => task.prompt === `Review the diff (${key}).`)!,
    ),
  );

const answer = (parent: Parent, key: string) =>
  Effect.gen(function* () {
    const task = yield* taskFor(parent, key);
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make(`command:review-result:${key}`),
        parentThreadId: parent.threadId,
        taskId: task.id,
        status: "completed",
        result: "Found a blocking defect.",
      }),
    );
  });

/** Starts and answers rounds 1 to 3 of the first part. */
const reviewThreeRounds = (parent: Parent) =>
  Effect.gen(function* () {
    for (const round of [1, 2, 3]) {
      yield* requestReview(parent, `round-${round}`);
      assert.deepEqual((yield* taskFor(parent, `round-${round}`)).review, { part: 1, round });
      yield* answer(parent, `round-${round}`);
    }
  });

const seedLiveParent = (name: string) => seedLiveParentThread({ name, driver, modelSelection });

it.layer(layerFor(SqlitePersistence.layerMemory))("delegated review rounds", (it) => {
  it.effect("start rounds 1 to 3, refuse round 4, and start a re-planned part at round 1", () =>
    Effect.gen(function* () {
      const parent = yield* seedLiveParent("review-limit");
      yield* reviewThreeRounds(parent);

      const refused = yield* requestReview(parent, "round-4").pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorReviewRoundLimitError");
      assert.deepInclude(refused, { part: 1, rounds: 3 });

      // The refusal records no receipt, so the same call goes through once it says how it split.
      const newPartReason = "Split the schema migration into its own change.";
      yield* requestReview(parent, "round-4", { newPartReason });
      assert.deepEqual((yield* taskFor(parent, "round-4")).review, {
        part: 2,
        round: 1,
        newPartReason,
      });
    }),
  );

  it.effect("let reviewers started before a round answers share it", () =>
    Effect.gen(function* () {
      const parent = yield* seedLiveParent("parallel-reviewers");
      yield* requestReview(parent, "first-reviewer");
      yield* requestReview(parent, "second-reviewer");
      yield* requestReview(parent, "not-a-review", null);
      assert.deepEqual((yield* taskFor(parent, "second-reviewer")).review, {
        part: 1,
        round: 1,
      });
      assert.isUndefined((yield* taskFor(parent, "not-a-review")).review);

      yield* answer(parent, "first-reviewer");
      yield* requestReview(parent, "after-the-answer");
      assert.deepEqual((yield* taskFor(parent, "after-the-answer")).review, {
        part: 1,
        round: 2,
      });
    }),
  );
});

it.effect("keeps the review count of a parent thread across a server restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "review-rounds-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );

    const parent = yield* Effect.gen(function* () {
      const seeded = yield* seedLiveParent("review-restart");
      yield* reviewThreeRounds(seeded);
      return seeded;
    }).pipe(Effect.provide(layerFor(database)));

    const refused = yield* requestReview(parent, "round-4").pipe(
      Effect.flip,
      Effect.provide(layerFor(database)),
    );
    assert.equal(refused._tag, "OrchestratorReviewRoundLimitError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
