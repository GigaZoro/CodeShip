import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { restartRetryNoticeId } from "../RestartBackgroundNote.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
  SIMPLE_PROMPT,
} from "./fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const SCENARIO = "restart_before_prompt";

describe("restart before provider prompt delivery", () => {
  it.effect("replays the original prompt on the same run without a second user message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recorded = yield* readProviderReplayTranscript(
          new URL("./fixtures/simple/claude_transcript.ndjson", import.meta.url),
        );
        const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(recorded);
        const workspace = yield* checkpointWorkspace(SCENARIO);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "t3-orchestration-v2-restart-before-prompt-" }),
          (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: SCENARIO,
          fixtureInput: { steps: [{ type: "message", text: SIMPLE_PROMPT }] },
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        });
        const threadId = materialized.projectionThreadIds[0];
        if (threadId === undefined) {
          return yield* Effect.die("restart scenario has no projection thread");
        }
        const scenario = {
          name: SCENARIO,
          transcript,
          commands: [],
          steps: materialized.steps.filter((step) => step.type === "await_thread_idle"),
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd: workspace },
        };
        const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
        const databaseLayer = SqlitePersistence.layerFromPath(
          path.join(tempDir, "state.sqlite"),
        ).pipe(Layer.provide(NodeServices.layer));
        const snapshotPath = path.join(tempDir, "restart-state.sqlite");

        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            for (const command of materialized.commands) {
              yield* orchestrator.dispatch(command);
              if (command.type === "message.dispatch") {
                const effects = yield* outbox.listByCommandId(command.commandId);
                assert.deepEqual(
                  effects
                    .filter((effect) => effect.request.type === "provider-turn.start")
                    .map((effect) => effect.status),
                  ["pending"],
                );
              }
            }
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              ["starting"],
            );
            assert.isEmpty(projection.providerTurns);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`VACUUM INTO ${snapshotPath}`;
            return projection;
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                ProviderReplayHarness.layerProviderReplay(scenario, harness, {
                  databaseLayer,
                  runEffectWorker: false,
                }),
                EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
                databaseLayer,
              ),
            ),
          ),
        );
        const snapshotDatabase = SqlitePersistence.layerFromPath(snapshotPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const after = yield* Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            return yield* runOrchestratorV2Scenario(scenario);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerProviderReplay(scenario, harness, {
                databaseLayer: snapshotDatabase,
                recoverOnStartup: true,
                continueThreadsAfterServerUpdate: true,
              }),
            ),
          ),
        );
        const projection = projectionFor(after, SCENARIO);
        const run = before.runs[0];
        if (run === undefined) {
          return yield* Effect.die("restart scenario has no original run");
        }
        assert.deepEqual(
          projection.runs.map((recovered) => ({ id: recovered.id, status: recovered.status })),
          [{ id: run.id, status: "completed" }],
        );
        assert.deepEqual(
          projection.attempts.map((attempt) => ({
            id: attempt.id,
            rootNodeId: attempt.rootNodeId,
          })),
          before.attempts.map((attempt) => ({
            id: attempt.id,
            rootNodeId: attempt.rootNodeId,
          })),
        );
        assert.deepEqual(
          projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
          [SIMPLE_PROMPT],
        );
        assert.isTrue(
          projection.turnItems.some(
            (item) => item.id === restartRetryNoticeId(run.id, 1, "unsent"),
          ),
        );
        yield* assertComplete;
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );

  it.effect("ends a resent delegated run that still cannot start as failed with the reason", () =>
    Effect.gen(function* () {
      const { child, parent } = yield* restartUnstartedDelegatedChild({
        openChildSession: () => Effect.die(new Error("codex app-server exited")),
        afterRestart: drainWithBackoff,
      });
      const run = child.runs[0]!;
      assert.deepEqual(
        child.runs.map((candidate) => candidate.status),
        ["failed"],
      );
      assert.isTrue(
        child.turnItems.some((item) => item.id === restartRetryNoticeId(run.id, 1, "unsent")),
      );
      assert.deepEqual(
        child.turnItems.flatMap((item) =>
          item.type === "error" ? [[item.title, item.failure.message]] : [],
        ),
        [["Provider turn failed to start", "codex app-server exited"]],
      );
      assert.deepEqual(
        parent.subagents.map((subagent) => subagent.status),
        ["failed"],
      );
    }),
  );

  it.effect("ends a resent delegated run whose provider never answers as failed", () =>
    Effect.gen(function* () {
      const childOpened = yield* Deferred.make<void>();
      const { child, parent } = yield* restartUnstartedDelegatedChild({
        openChildSession: () =>
          Deferred.succeed(childOpened, undefined).pipe(Effect.andThen(Effect.never)),
        afterRestart: (worker) =>
          Effect.gen(function* () {
            const draining = yield* Effect.forkScoped(drainWithBackoff(worker));
            yield* Deferred.await(childOpened);
            yield* TestClock.adjust("5 minutes");
            yield* Fiber.join(draining);
          }),
      });
      assert.deepEqual(
        child.runs.map((candidate) => candidate.status),
        ["failed"],
      );
      assert.deepEqual(
        child.turnItems.flatMap((item) =>
          item.type === "error" ? [[item.title, item.failure.message]] : [],
        ),
        [
          [
            "Provider session failed to open",
            "The provider did not open its session within 5 minutes.",
          ],
        ],
      );
      assert.deepEqual(
        parent.subagents.map((subagent) => subagent.status),
        ["failed"],
      );
    }),
  );
});

const drainWithBackoff = (worker: EffectWorker.OrchestrationEffectWorkerV2["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= 5; attempt++) {
      yield* worker.drain();
      yield* TestClock.adjust("30 seconds");
    }
  });

/** Restarts the server while a delegated Codex child run has not reached its provider. */
const restartUnstartedDelegatedChild = <E>(options: {
  readonly openChildSession: ProviderAdapter.ProviderAdapterV2["Service"]["openSession"];
  readonly afterRestart: (
    worker: EffectWorker.OrchestrationEffectWorkerV2["Service"],
  ) => Effect.Effect<void, E, Scope.Scope>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "t3-orchestration-v2-restart-delegated-" }),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.1-codex" };
      const parentThreadId = ThreadId.make("thread:restart-delegated-parent");
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: (input) =>
            input.threadId === parentThreadId
              ? Effect.die(new Error("codex app-server exited"))
              : options.openChildSession(input),
        } as ProviderAdapter.ProviderAdapterV2["Service"],
      ]);
      const databaseLayer = SqlitePersistence.layerFromPath(
        path.join(tempDir, "state.sqlite"),
      ).pipe(Layer.provide(NodeServices.layer));
      const snapshotPath = path.join(tempDir, "restart-state.sqlite");

      const childThreadId = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create:restart-delegated-parent"),
            threadId: parentThreadId,
            projectId: ProjectId.make("project:restart-delegated"),
            title: "Parent",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: tempDir,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("send:restart-delegated-parent"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:restart-delegated-parent"),
            text: "Delegate the work.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
          yield* orchestrator.dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make("delegate:restart-delegated-child"),
            parentThreadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId!,
            task: "Do the delegated work.",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "agent",
            creationSource: "mcp",
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM INTO ${snapshotPath}`;
          return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!
            .childThreadId!;
        }).pipe(
          Effect.provide(
            Layer.merge(
              ProviderReplayHarness.layerWithRegistry({ name: SCENARIO }, registry, {
                databaseLayer,
                runEffectWorker: false,
              }),
              databaseLayer,
            ),
          ),
        ),
      );

      const snapshotDatabase = SqlitePersistence.layerFromPath(snapshotPath).pipe(
        Layer.provide(NodeServices.layer),
      );
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* options.afterRestart(yield* EffectWorker.OrchestrationEffectWorkerV2);
          // The parent hears of the child's end from a run-update subscriber, not the worker.
          yield* orchestrator
            .streamStoredEventsFrom({ threadId: parentThreadId, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.childThreadId === childThreadId &&
                  !isOrchestrationV2WorkActive(stored.event.payload.status),
              ),
              Stream.runHead,
            );
          return {
            child: yield* orchestrator.getThreadProjection(childThreadId),
            parent: yield* orchestrator.getThreadProjection(parentThreadId),
          };
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry({ name: SCENARIO }, registry, {
              databaseLayer: snapshotDatabase,
              runEffectWorker: false,
              recoverOnStartup: true,
              continueThreadsAfterServerUpdate: true,
            }),
          ),
        ),
      );
    }),
  ).pipe(
    provideDeterministicTestRuntime,
    Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
  );
