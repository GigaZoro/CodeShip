import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts/baseSchemas";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
// Holds model-selection planning until both racing commands have read no receipt.
let capabilityGate: Effect.Effect<void> | undefined;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () =>
    (capabilityGate ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2)),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "receipt-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("a command id reused concurrently for two threads succeeds for only one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadIds = [ThreadId.make("thread:race-a"), ThreadId.make("thread:race-b")];
    for (const threadId of threadIds) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: threadId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }

    const arrived = yield* Ref.make(0);
    const bothArrived = yield* Deferred.make<void>();
    capabilityGate = Effect.gen(function* () {
      if ((yield* Ref.updateAndGet(arrived, (count) => count + 1)) === 2) {
        yield* Deferred.succeed(bothArrived, undefined);
      }
      yield* Deferred.await(bothArrived);
    });
    const setModel = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:shared"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
    const exits = yield* Effect.forEach(threadIds, (threadId) => Effect.exit(setModel(threadId)), {
      concurrency: "unbounded",
    }).pipe(Effect.ensuring(Effect.sync(() => (capabilityGate = undefined))));

    const winner = exits.findIndex(Exit.isSuccess);
    const loser = exits.findIndex(Exit.isFailure);
    assert.isAtLeast(winner, 0);
    assert.isAtLeast(loser, 0);
    const winnerExit = exits[winner]!;
    const loserExit = exits[loser]!;
    assert.isTrue(Exit.isSuccess(winnerExit) && Exit.isFailure(loserExit));
    if (Exit.isFailure(loserExit)) {
      const error = Cause.findErrorOption(loserExit.cause);
      assert.isTrue(error._tag === "Some");
      if (error._tag === "Some") {
        assert.equal(error.value._tag, "OrchestratorCommandIdConflictError");
        if (error.value._tag === "OrchestratorCommandIdConflictError") {
          assert.equal(error.value.receiptThreadId, threadIds[winner]);
          assert.equal(error.value.commandThreadId, threadIds[loser]);
        }
      }
    }

    const models = yield* Effect.forEach(threadIds, (threadId) =>
      projections.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.modelSelection.model)),
    );
    assert.equal(models[winner], "gpt-6");
    assert.equal(models[loser], "gpt-5.1-codex");

    // The winner's own thread still replays its receipt.
    const replay = yield* setModel(threadIds[winner]!);
    if (Exit.isSuccess(winnerExit)) {
      assert.equal(replay.sequence, winnerExit.value.sequence);
      assert.isAbove(replay.storedEvents.length, 0);
      assert.deepEqual(
        replay.storedEvents.map((stored) => stored.sequence),
        winnerExit.value.storedEvents.map((stored) => stored.sequence),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { outcome: "a rejected star", starred: true },
  { outcome: "a no-op unstar", starred: false },
])(
  "replays the winning cross-thread rejection when $outcome loses the receipt insert",
  ({ starred }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const loserThreadId = ThreadId.make("thread:race-loser");
      const winnerThreadId = ThreadId.make("thread:race-winner");
      for (const threadId of [loserThreadId, winnerThreadId]) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make("project:receipt-race"),
          title: threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }

      // Insert the other thread's receipt after the lookup and before the dispatch reserves it.
      yield* sql`
        CREATE TEMP TRIGGER win_receipt_race BEFORE INSERT ON orchestration_command_receipts
        WHEN NEW.command_id = 'command:star-race' AND NEW.aggregate_id = 'thread:race-loser'
        BEGIN
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, command_type,
            accepted_at, result_sequence, status, error
          ) VALUES (
            NEW.command_id, 'thread', 'thread:race-winner', 'queued-run.edit',
            NEW.accepted_at, NEW.result_sequence, 'rejected', 'The queued run is missing.'
          );
        END
      `;
      const command = {
        type: "thread.message.star",
        commandId: CommandId.make("command:star-race"),
        threadId: loserThreadId,
        messageId: MessageId.make("message:missing"),
        starred,
      } as const;
      const lost = yield* orchestrator.dispatch(command).pipe(Effect.result);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.result);
      assert(Result.isFailure(retry));
      assert.equal(retry.failure._tag, "OrchestratorCommandPreviouslyRejectedError");
      assert(Result.isFailure(lost), "the initial dispatch must replay the winning rejection");
      assert.deepEqual(lost.failure, retry.failure);
    }).pipe(Effect.provide(layerTest)),
);
