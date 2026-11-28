import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
} from "@t3tools/contracts/baseSchemas";
import type { OrchestrationV2DelegatedReviewRequest } from "@t3tools/contracts/orchestrationV2";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
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
import * as EventSink from "./EventSink.ts";
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

/** A reviewer in this environment, with a thread of its own. */
const requestLocalReview = (parent: Parent, key: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`command:review:${key}`),
      parentThreadId: parent.threadId,
      parentRunId: parent.runId,
      parentNodeId: parent.rootNodeId,
      task: `Review the diff (${key}).`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      review: {},
    }),
  );

/**
 * Ends the run at `ordinal` in a local reviewer's thread, adding it as a continuation when the
 * thread has no such run yet. The parent records nothing until its worker runs.
 */
const endReviewerRun = (
  parent: Parent,
  key: string,
  ordinal: number,
  status: "completed" | "failed" | "rolled_back",
) =>
  Effect.gen(function* () {
    const threadId = (yield* taskFor(parent, key)).childThreadId!;
    const { runs } = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    );
    const now = yield* DateTime.now;
    const run = runs.find((candidate) => candidate.ordinal === ordinal) ?? {
      ...runs.at(-1)!,
      id: RunId.make(`run:${key}:${ordinal}`),
      ordinal,
      userMessageId: MessageId.make(`message:${key}:${ordinal}`),
      requestedAt: now,
      startedAt: now,
    };
    yield* EventSink.EventSinkV2.use((sink) =>
      sink.write({
        commandId: CommandId.make(`command:reviewer-run:${key}:${ordinal}:${status}`),
        events: [
          {
            id: EventId.make(`event:reviewer-run:${key}:${ordinal}:${status}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, status, completedAt: now },
          },
        ],
      }),
    );
  });

/** The task a request started, with its place in the parent's review count. */
const taskFor = (parent: Parent, key: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.getThreadProjection(parent.threadId),
  ).pipe(
    Effect.map((projection) =>
      projection.subagents.find((task) => task.prompt === `Review the diff (${key}).`)!,
    ),
  );

/** The parent's record of a completed follow-up in a reviewer's thread; it holds no review. */
const recordCompletedFollowup = (parent: Parent, key: string) =>
  Effect.gen(function* () {
    const { review: _review, ...original } = yield* taskFor(parent, key);
    const now = yield* DateTime.now;
    const followup = {
      ...original,
      id: NodeId.make(`node:followup:${key}`),
      prompt: `Finish the review (${key}).`,
      status: "completed" as const,
      result: "Found a blocking defect.",
      completedAt: now,
      updatedAt: now,
    };
    yield* EventSink.EventSinkV2.use((sink) =>
      sink.write({
        commandId: CommandId.make(`command:followup:${key}`),
        events: [
          {
            id: EventId.make(`event:followup:${key}`),
            type: "subagent.updated",
            threadId: parent.threadId,
            ...(followup.runId === null ? {} : { runId: followup.runId }),
            nodeId: followup.id,
            driver: followup.driver,
            providerInstanceId: followup.providerInstanceId,
            occurredAt: now,
            payload: followup,
          },
        ],
      }),
    );
  });

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

  it.effect(
    "count a round answered once a reviewer's run completes, before the parent records it",
    () =>
      Effect.gen(function* () {
        const parent = yield* seedLiveParent("answered-in-its-thread");
        yield* requestLocalReview(parent, "reviewer");
        yield* endReviewerRun(parent, "reviewer", 1, "failed");
        yield* requestReview(parent, "retry-after-a-failure");
        assert.deepEqual((yield* taskFor(parent, "retry-after-a-failure")).review, {
          part: 1,
          round: 1,
        });

        yield* endReviewerRun(parent, "reviewer", 2, "completed");
        assert.notEqual((yield* taskFor(parent, "reviewer")).status, "completed");
        yield* requestReview(parent, "after-the-continuation");
        assert.deepEqual((yield* taskFor(parent, "after-the-continuation")).review, {
          part: 1,
          round: 2,
        });
      }),
  );

  it.effect("keep a round answered after the reviewer's thread rolls its answer back", () =>
    Effect.gen(function* () {
      const parent = yield* seedLiveParent("answer-rolled-back");
      yield* requestLocalReview(parent, "rolled-back");
      yield* endReviewerRun(parent, "rolled-back", 1, "failed");
      yield* endReviewerRun(parent, "rolled-back", 2, "completed");
      yield* recordCompletedFollowup(parent, "rolled-back");
      yield* endReviewerRun(parent, "rolled-back", 2, "rolled_back");

      yield* requestReview(parent, "after-the-rollback");
      assert.deepEqual((yield* taskFor(parent, "after-the-rollback")).review, {
        part: 1,
        round: 2,
      });
    }),
  );

  it.effect("start a part split off while a round is open, shared by its reviewers", () =>
    Effect.gen(function* () {
      const parent = yield* seedLiveParent("split-in-round-one");
      yield* requestReview(parent, "whole-change");
      const newPartReason = "Split the cache migration into its own change.";
      for (const key of ["split", "split-second-reviewer"]) {
        yield* requestReview(parent, key, { newPartReason });
        assert.deepEqual((yield* taskFor(parent, key)).review, {
          part: 2,
          round: 1,
          newPartReason,
        });
      }
      yield* requestReview(parent, "unnamed-reviewer");
      assert.deepEqual((yield* taskFor(parent, "unnamed-reviewer")).review, { part: 2, round: 1 });
      yield* requestReview(parent, "another-split", { newPartReason: "Split the decoder fix." });
      assert.deepInclude((yield* taskFor(parent, "another-split")).review, { part: 3, round: 1 });
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
