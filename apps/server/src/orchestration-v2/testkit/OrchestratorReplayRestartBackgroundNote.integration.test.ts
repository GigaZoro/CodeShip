import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2RestartCancelledBackgroundWork,
  ProviderDriverKind,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import { backgroundWorkStoppedNoticeId } from "../RestartBackgroundNote.ts";
import { makeProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./fixtures/claude_background_subagent_after_root/input.ts";
import { CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT } from "./fixtures/claude_background_task_after_root/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const SCENARIO = "claude_background_subagent_after_root";
const SESSION_ID = "cca274e4-25ae-4171-b972-bbb31118517e";
const FIRST_AFTER_RESTART = "Is the background subagent done yet?";
const SECOND_AFTER_RESTART = "Thanks. Anything else?";
const NOTE = [
  "Note: this background work was cancelled before it finished, because the T3 server restarted or the agent process running it ended. It will not report back on its own, so resume or restart what you still need and wait for its result:",
  "- subagent: Background subagent test (id a2995bfced8019363)",
].join("\n");

/** The recorded query options, minus the session id a resume replaces. */
function recordedResumeOptions(
  scenario: string,
  entries: ReadonlyArray<ProviderReplayEntry>,
): Record<string, unknown> {
  const queryOpen = entries[0];
  const openFrame = queryOpen?.type === "expect_outbound" ? queryOpen.frame : undefined;
  const queryOptions: unknown =
    typeof openFrame === "object" && openFrame !== null
      ? Reflect.get(openFrame, "options")
      : undefined;
  if (typeof queryOptions !== "object" || queryOptions === null) {
    throw new Error(`${scenario} must open with a recorded query.open frame.`);
  }
  const { sessionId: _sessionId, ...resumeOptions } = queryOptions as Record<string, unknown>;
  return resumeOptions;
}

function resumedTurn(
  sessionId: string,
  label: string,
  text: string,
): ReadonlyArray<ProviderReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: `prompt.offer:${label}`,
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
      },
    },
    {
      type: "emit_inbound",
      label: `assistant:${label}`,
      frame: {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: `msg_restart_${label}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `REPLY_${label}` }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: `restart-assistant-${label}`,
      },
    },
    {
      type: "emit_inbound",
      label: `result:${label}`,
      frame: {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: `REPLY_${label}`,
        stop_reason: "end_turn",
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        session_id: sessionId,
        uuid: `restart-result-${label}`,
      },
    },
  ];
}

const readRestartTranscript = Effect.fn("readRestartTranscript")(function* (
  resumedPrompts: ReadonlyArray<string>,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/claude_transcript.ndjson`, import.meta.url),
  );
  const rootResult = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "result",
  );
  const resumeOptions = recordedResumeOptions(SCENARIO, recorded.entries);
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      ...recorded.entries.slice(0, rootResult + 1),
      // Keep the query alive until the crash snapshot is captured.
      {
        type: "expect_outbound",
        label: "query.open:resume",
        frame: { type: "query.open", options: { ...resumeOptions, resume: SESSION_ID } },
      },
      ...resumedPrompts.flatMap((prompt, index) =>
        resumedTurn(SESSION_ID, String(index + 1), prompt),
      ),
    ],
  });
});

const runRestart = Effect.fn("runRestart")(function* (input: {
  readonly resumedPrompts: ReadonlyArray<string>;
  readonly userMessagesAfterRestart: ReadonlyArray<string>;
  readonly continueThreadsAfterServerUpdate: boolean;
}) {
  const transcript = yield* readRestartTranscript(input.resumedPrompts);
  const workspace = yield* checkpointWorkspace(SCENARIO);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-orchestration-v2-restart-note-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: SCENARIO,
    fixtureInput: {
      steps: [
        { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
        ...input.userMessagesAfterRestart.map((text) => ({ type: "message" as const, text })),
      ],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });

  const firstIdle = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  const phase1Steps = materialized.steps.slice(0, firstIdle + 1);
  const phase2Steps = materialized.steps.slice(firstIdle + 1);
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
  const layerDatabase = SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const snapshotPath = path.join(tempDir, "restart-state.sqlite");
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${SCENARIO}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });

  const beforeScenario = scenario("before-restart", phase1Steps);
  const before = yield* Effect.scoped(
    Effect.gen(function* () {
      const result = yield* runOrchestratorV2Scenario(beforeScenario);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = materialized.projectionThreadIds[0];
      if (threadId === undefined) {
        return yield* Effect.die("restart scenario has no projection thread");
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const session = projection.providerSessions[0];
      if (session === undefined) {
        return yield* Effect.die("restart scenario has no provider session");
      }
      // Snapshot the legacy running task before exit cleanup settles it, then
      // seed the stopped session that older runtimes could leave after a crash.
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:restart-background-note:stopped-provider-session"),
            type: "provider-session.updated",
            threadId,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${snapshotPath}`;
      return result;
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProviderReplayHarness.layerProviderReplay(beforeScenario, harness, {
            databaseLayer: layerDatabase,
          }),
          layerDatabase,
        ),
      ),
    ),
  );
  const snapshotDatabase = SqlitePersistence.layerFromPath(snapshotPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const settled = projectionFor(before, SCENARIO);
  assert.equal(settled.runs[0]?.status, "completed");
  assert.equal(settled.subagents[0]?.status, "running");

  const restartScenario = scenario("restarted", []);
  const restarted = yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      return yield* runOrchestratorV2Scenario(restartScenario);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(restartScenario, harness, {
          databaseLayer: snapshotDatabase,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
        }),
      ),
    ),
  );
  const recovered = projectionFor(restarted, SCENARIO);
  assert.deepEqual(
    recovered.runs.map((run) => run.status),
    ["completed"],
  );
  assert.equal(recovered.subagents[0]?.status, "cancelled");
  assert.equal(recovered.runs[0]?.restartCancelledBackgroundWork?.[0]?.kind, "subagent");

  const after = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(scenario("after-restart", phase2Steps), harness, {
      databaseLayer: snapshotDatabase,
      continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
    }),
  );

  yield* assertComplete;
  const projection = projectionFor(after, SCENARIO);
  assert.equal(projection.subagents[0]?.status, "cancelled");
  return projection;
});

const userTexts = (projection: ReturnType<typeof projectionFor>) =>
  projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []));

describe("restart-cancelled background work", () => {
  it.effect.each([false, true])(
    "keeps the thread settled and tells the next user turn once when continuation is %s",
    (continueThreadsAfterServerUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* runRestart({
            resumedPrompts: [
              `${NOTE}\n\nUser message:\n${FIRST_AFTER_RESTART}`,
              SECOND_AFTER_RESTART,
            ],
            userMessagesAfterRestart: [FIRST_AFTER_RESTART, SECOND_AFTER_RESTART],
            continueThreadsAfterServerUpdate,
          });
          assert.deepEqual(
            projection.runs.map((run) => run.status),
            ["completed", "completed", "completed"],
          );
          assert.isFalse(
            projection.runs.some((run) => run.restartContinuationOfRunId !== undefined),
          );

          assert.deepEqual(userTexts(projection), [
            CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
            FIRST_AFTER_RESTART,
            SECOND_AFTER_RESTART,
          ]);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );
});

const LOST_SCENARIO = "claude_background_task_after_root";
const LOST_SESSION_ID = "ec24a006-617b-4324-b516-57a7afff15a4";
const LOST_TASK_ID = "bc9gkn8ei";
const LOST_TASK_LABEL = "sleep 25 && echo L2_BG_DONE (id bc9gkn8ei)";
const LOST_WORK = {
  kind: "shell",
  label: LOST_TASK_LABEL,
  id: LOST_TASK_ID,
  nativeItemId: "toolu_01DAnwwvVvLM1cTfzrm6kkor",
} as const;
const LOST_GATE = "process-exit";
const QUESTION_AFTER_LOSS = "Is the background command done yet?";
const QUESTION_AFTER_FAILURE = "What happened?";
const LOST_NOTE = [
  "Note: this background work was cancelled before it finished, because the T3 server restarted or the agent process running it ended. It will not report back on its own, so resume or restart what you still need and wait for its result:",
  `- shell: ${LOST_TASK_LABEL}`,
].join("\n");

/** The background work a lost-work scenario's process runs when it ends. */
interface LostWork {
  readonly name: string;
  readonly scenario: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly rootResultLabel: string;
  readonly work: OrchestrationV2RestartCancelledBackgroundWork;
  readonly note: string;
}

const LOST_COMMAND: LostWork = {
  name: "a background command",
  scenario: LOST_SCENARIO,
  sessionId: LOST_SESSION_ID,
  prompt: CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT,
  rootResultLabel: "result:root",
  work: LOST_WORK,
  note: LOST_NOTE,
};

/** No roster lists a background subagent; only the process that runs it knows it. */
const LOST_SUBAGENT: LostWork = {
  name: "a background subagent",
  scenario: SCENARIO,
  sessionId: SESSION_ID,
  prompt: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
  rootResultLabel: "result",
  work: {
    kind: "subagent",
    label: "Background subagent test (id a2995bfced8019363)",
    id: "a2995bfced8019363",
    nativeItemId: "toolu_01AS7YtghJ9Knkp7QuuGTo7j",
  },
  note: NOTE,
};

type SessionRelease = Exclude<
  ProviderSessionManager.ProviderSessionReleaseReason,
  "server_shutdown"
>;

/** How the thread says its background work stopped: the process ended, a Stop closed it, or its session was released. */
const LOST_NOTICE: Record<"process-ended" | "stopped" | SessionRelease, readonly [string, string]> =
  {
    "process-ended": ["Agent process ended", "The agent process ended"],
    stopped: ["Chat stopped", "Stopping the chat ended the agent process"],
    idle_timeout: [
      "Agent session closed",
      "The agent's session was closed after too long without activity",
    ],
    runtime_error: ["Agent session failed", "The agent's session failed"],
    manual_shutdown: ["Agent session closed", "The agent's session was closed"],
  };

/**
 * The root turn settles with the command still running. Then its process exits on its own, while
 * idle or during the next turn, or stays up until the test stops the chat or releases its session.
 */
const readLostTaskTranscript = Effect.fn("readLostTaskTranscript")(function* (
  lost: LostWork,
  resumedPrompts: ReadonlyArray<string>,
  processExits: "idle" | { readonly duringTurn: string } | false,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${lost.scenario}/claude_transcript.ndjson`, import.meta.url),
  );
  const label = (name: string) =>
    recorded.entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === name);
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      ...recorded.entries.slice(0, label(lost.rootResultLabel) + 1),
      // Holds the process until the test lets it go; it then ends unprompted.
      // The frame carries nothing, so no event races the process exit.
      ...(processExits === "idle"
        ? ([
            {
              type: "emit_inbound",
              label: LOST_GATE,
              frame: {
                type: "rate_limit_event",
                session_id: lost.sessionId,
                uuid: "lost-task-hold",
              },
            },
            { type: "runtime_exit", status: "success" },
          ] as const)
        : processExits === false
          ? []
          : ([
              // The process takes the prompt and ends before it answers.
              {
                type: "expect_outbound",
                label: "prompt.offer:cut",
                frame: {
                  type: "prompt.offer",
                  message: {
                    type: "user",
                    message: { role: "user", content: processExits.duringTurn },
                    parent_tool_use_id: null,
                  },
                },
              },
              { type: "runtime_exit", status: "success" },
            ] as const)),
      {
        type: "expect_outbound",
        label: "query.open:resume",
        frame: {
          type: "query.open",
          options: {
            ...recordedResumeOptions(lost.scenario, recorded.entries),
            resume: lost.sessionId,
          },
        },
      },
      ...resumedPrompts.flatMap((prompt, index) =>
        resumedTurn(lost.sessionId, String(index + 1), prompt),
      ),
    ],
  });
});

const runLostTask = Effect.fn("runLostTask")(function* (input: {
  readonly lost: LostWork;
  readonly resumedPrompts: ReadonlyArray<string>;
  readonly userMessagesAfterRestart: ReadonlyArray<string>;
  readonly continueThreadsAfterServerUpdate: boolean;
  /** The server that sees the process end keeps running and wakes the chat itself. */
  readonly wakeWithoutRestart?: boolean;
  /** The process stays up and its session is released instead. */
  readonly release?: SessionRelease;
  /** The process stays up and the user stops the chat's background work instead. */
  readonly stop?: boolean;
}) {
  const { lost: lostWork } = input;
  const scenarioName = lostWork.scenario;
  const wakeWithoutRestart = input.wakeWithoutRestart === true;
  const stop = input.stop === true;
  const transcript = yield* readLostTaskTranscript(
    lostWork,
    input.resumedPrompts,
    input.release === undefined && !stop ? "idle" : false,
  );
  const workspace = yield* checkpointWorkspace(scenarioName);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-orchestration-v2-lost-task-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: scenarioName,
    fixtureInput: {
      steps: [
        { type: "message", text: lostWork.prompt },
        { type: "await_run_status", targetRunIndex: 1, status: "completed" },
        ...input.userMessagesAfterRestart.map((text) => ({ type: "message" as const, text })),
      ],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });
  const threadId = materialized.projectionThreadIds[0];
  if (threadId === undefined) {
    return yield* Effect.die("lost task scenario has no projection thread");
  }
  const settledAt = materialized.steps.findIndex((step) => step.type === "await_run_status");
  const phase1Steps = materialized.steps.slice(0, settledAt + 1);
  const phase3Steps = materialized.steps.slice(settledAt + 1);
  const replayGate = makeProviderReplayGate([LOST_GATE]);
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript, {
    replayGate,
    closeEndsProcess: stop,
  });
  const layerDatabase = SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const snapshotPath = path.join(tempDir, "restart-state.sqlite");
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${scenarioName}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });

  const beforeScenario = scenario("process-ended", phase1Steps);
  const lost = yield* Effect.scoped(
    Effect.gen(function* () {
      // The scenario would release every gate when it ends; this one stays held.
      yield* runOrchestratorV2Scenario(beforeScenario);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const settled = yield* orchestrator.getThreadProjection(threadId);
      const providerThread = settled.providerThreads[0];
      if (providerThread?.providerSessionId == null) {
        return yield* Effect.die("lost task scenario has no provider session");
      }
      const afterSequence = yield* eventSink.latestSequence({ threadId });
      const settledRun = settled.runs[0];
      if (stop && settledRun !== undefined) {
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:lost-task:stop"),
          threadId,
          runId: settledRun.id,
          holdQueue: true,
        });
      } else if (input.release === undefined) replayGate.release(LOST_GATE);
      else {
        yield* sessions.release({
          providerSessionId: providerThread.providerSessionId,
          reason: input.release,
        });
      }
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(({ event }) => event.type === "run.background-work-cancelled"),
        Stream.runHead,
      );
      if (lostWork.work.kind === "subagent") {
        // Whatever stopped it also ends its record, which a restart would otherwise find open.
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "subagent" &&
              !isOrchestrationV2WorkActive(event.payload.status),
          ),
          Stream.runHead,
        );
      }
      if (wakeWithoutRestart) {
        // The wake is queued just after the loss commits, so wait for the run it starts.
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.created" &&
              event.payload.restartContinuationOfRunId !== undefined,
          ),
          Stream.runHead,
        );
        return projectionFor(
          yield* runOrchestratorV2Scenario(
            scenario("woken", [{ type: "await_thread_idle", threadId }]),
          ),
          scenarioName,
        );
      }
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${snapshotPath}`;
      return yield* orchestrator.getThreadProjection(threadId);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProviderReplayHarness.layerProviderReplay(beforeScenario, harness, {
            databaseLayer: layerDatabase,
            continueThreadsAfterServerUpdate: wakeWithoutRestart,
          }),
          layerDatabase,
        ),
      ),
    ),
  );
  const lostRun = lost.runs[0];
  if (lostRun === undefined) return yield* Effect.die("lost task scenario has no run");
  assert.equal(lostRun.status, "completed");
  assert.deepEqual(lost.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  assert.deepEqual(lostRun.restartCancelledBackgroundWork, [lostWork.work]);
  assert.isFalse(lost.subagents.some((subagent) => isOrchestrationV2WorkActive(subagent.status)));
  const notice = lost.turnItems.find(
    (item) => item.id === backgroundWorkStoppedNoticeId(lostRun.id),
  );
  const [title, lead] = LOST_NOTICE[stop ? "stopped" : (input.release ?? "process-ended")];
  assert.deepInclude(notice, {
    type: "system_notice",
    runId: lostRun.id,
    title,
    message: [
      `${lead} and stopped background work before it finished:`,
      `- ${lostWork.work.kind}: ${lostWork.work.label}`,
      ...(lostWork.work.kind === "shell" ? [] : ["This chat was waiting on it."]),
    ].join("\n"),
  });
  if (wakeWithoutRestart) {
    yield* assertComplete;
    return { recovered: lost, after: lost };
  }

  const snapshotDatabase = SqlitePersistence.layerFromPath(snapshotPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const restartScenario = scenario("restarted", [{ type: "await_thread_idle", threadId }]);
  const restarted = yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      return yield* runOrchestratorV2Scenario(restartScenario);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(restartScenario, harness, {
          databaseLayer: snapshotDatabase,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
        }),
      ),
    ),
  );
  const recovered = projectionFor(restarted, scenarioName);

  const after = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(scenario("after-restart", phase3Steps), harness, {
      databaseLayer: snapshotDatabase,
      continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
    }),
  );
  yield* assertComplete;
  return { recovered, after: projectionFor(after, scenarioName) };
});

/**
 * The chat leaves a background command running, the user asks about it, and the process ends
 * during that turn. Threads continue after restarts here, so a wake would show as a continuation run.
 */
const runLostTaskDuringTurn = Effect.gen(function* () {
  const transcript = yield* readLostTaskTranscript(
    LOST_COMMAND,
    [`${LOST_NOTE}\n\nUser message:\n${QUESTION_AFTER_FAILURE}`],
    { duringTurn: QUESTION_AFTER_LOSS },
  );
  const workspace = yield* checkpointWorkspace(LOST_SCENARIO);
  const materialized = yield* materializeFixtureInput({
    scenario: LOST_SCENARIO,
    fixtureInput: {
      steps: [
        { type: "message", text: CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT },
        { type: "await_run_status", targetRunIndex: 1, status: "completed" },
        { type: "message", text: QUESTION_AFTER_LOSS },
        { type: "await_run_status", targetRunIndex: 2, status: "failed" },
        { type: "message", text: QUESTION_AFTER_FAILURE },
      ],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });
  const threadId = materialized.projectionThreadIds[0];
  if (threadId === undefined) {
    return yield* Effect.die("lost task scenario has no projection thread");
  }
  const settledAt = materialized.steps.findIndex((step) => step.type === "await_run_status");
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${LOST_SCENARIO}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });
  const settledScenario = scenario("settled", materialized.steps.slice(0, settledAt + 1));
  const after = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* runOrchestratorV2Scenario(settledScenario);
      const result = yield* runOrchestratorV2Scenario(
        scenario("cut", materialized.steps.slice(settledAt + 1)),
      );
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      return projectionFor(result, LOST_SCENARIO);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(settledScenario, harness, {
          continueThreadsAfterServerUpdate: true,
        }),
      ),
    ),
  );
  yield* assertComplete;
  return after;
});

describe("background work its agent process lost", () => {
  it.effect(
    "a restart wakes a chat whose run completed while it waits on a background subagent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { recovered } = yield* runLostTask({
            lost: LOST_SUBAGENT,
            resumedPrompts: [LOST_SUBAGENT.note],
            userMessagesAfterRestart: [],
            continueThreadsAfterServerUpdate: true,
          });
          assert.deepEqual(
            recovered.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", recovered.runs[0]?.id],
            ],
          );
          const continuation = recovered.runs[1];
          assert.equal(
            recovered.messages.find((message) => message.id === continuation?.userMessageId)?.text,
            LOST_SUBAGENT.note,
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "wakes the chat at once when only the agent process running a background subagent ends",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lost = LOST_SUBAGENT;
          const { after: woken } = yield* runLostTask({
            lost,
            resumedPrompts: [lost.note],
            userMessagesAfterRestart: [],
            continueThreadsAfterServerUpdate: true,
            wakeWithoutRestart: true,
          });
          assert.deepEqual(
            woken.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", woken.runs[0]?.id],
            ],
          );
          const continuation = woken.runs[1];
          assert.equal(
            woken.messages.find((message) => message.id === continuation?.userMessageId)?.text,
            lost.note,
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "wakes the chat waiting on a background subagent when its session is closed after too long without activity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lost = LOST_SUBAGENT;
          const { after: woken } = yield* runLostTask({
            lost,
            resumedPrompts: [lost.note],
            userMessagesAfterRestart: [],
            continueThreadsAfterServerUpdate: true,
            wakeWithoutRestart: true,
            release: "idle_timeout",
          });
          assert.deepEqual(
            woken.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", woken.runs[0]?.id],
            ],
          );
          const continuation = woken.runs[1];
          assert.equal(
            woken.messages.find((message) => message.id === continuation?.userMessageId)?.text,
            lost.note,
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect.each([LOST_COMMAND, LOST_SUBAGENT])(
    "a session someone closed is told about $name with the next message, and a restart does not wake it",
    (lost) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { recovered, after } = yield* runLostTask({
            lost,
            resumedPrompts: [`${lost.note}\n\nUser message:\n${QUESTION_AFTER_LOSS}`],
            userMessagesAfterRestart: [QUESTION_AFTER_LOSS],
            // Not even a restart that continues threads wakes it.
            continueThreadsAfterServerUpdate: true,
            release: "manual_shutdown",
          });
          assert.lengthOf(recovered.runs, 1);
          assert.deepEqual(
            after.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", undefined],
            ],
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect.each([LOST_COMMAND, LOST_SUBAGENT])(
    "a chat someone stopped is told about $name with the next message, and nothing wakes it",
    (lost) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { recovered, after } = yield* runLostTask({
            lost,
            resumedPrompts: [`${lost.note}\n\nUser message:\n${QUESTION_AFTER_LOSS}`],
            userMessagesAfterRestart: [QUESTION_AFTER_LOSS],
            // Not even a restart that continues threads wakes it.
            continueThreadsAfterServerUpdate: true,
            stop: true,
          });
          assert.lengthOf(recovered.runs, 1);
          assert.deepEqual(
            after.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["completed", undefined],
            ],
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect(
    "a process that ends during a turn leaves the lost work on the failed run for the next message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const after = yield* runLostTaskDuringTurn;
          assert.deepEqual(
            after.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
            [
              ["completed", undefined],
              ["failed", undefined],
              ["completed", undefined],
            ],
          );
          const failedRun = after.runs[1];
          assert.deepEqual(failedRun?.restartCancelledBackgroundWork, [LOST_WORK]);
          assert.deepEqual(after.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
          const [title, lead] = LOST_NOTICE["process-ended"];
          assert.deepInclude(
            after.turnItems.find(
              (item) =>
                failedRun !== undefined && item.id === backgroundWorkStoppedNoticeId(failedRun.id),
            ),
            {
              type: "system_notice",
              title,
              message: [
                `${lead} and stopped background work before it finished:`,
                `- shell: ${LOST_TASK_LABEL}`,
              ].join("\n"),
            },
          );
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );

  it.effect.each([
    { lost: LOST_COMMAND, continueThreadsAfterServerUpdate: true, case: "a background command" },
    {
      lost: LOST_SUBAGENT,
      continueThreadsAfterServerUpdate: false,
      case: "a subagent when restarts do not continue threads",
    },
  ])("tells the next user message about $case", ({ lost, continueThreadsAfterServerUpdate }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { recovered, after } = yield* runLostTask({
          lost,
          resumedPrompts: [`${lost.note}\n\nUser message:\n${QUESTION_AFTER_LOSS}`],
          userMessagesAfterRestart: [QUESTION_AFTER_LOSS],
          continueThreadsAfterServerUpdate,
        });
        assert.lengthOf(recovered.runs, 1);
        assert.deepEqual(
          after.runs.map((run) => [run.status, run.restartContinuationOfRunId]),
          [
            ["completed", undefined],
            ["completed", undefined],
          ],
        );
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    ),
  );
});
