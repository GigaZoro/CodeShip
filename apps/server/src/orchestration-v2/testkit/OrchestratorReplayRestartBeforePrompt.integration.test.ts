import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
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
});
