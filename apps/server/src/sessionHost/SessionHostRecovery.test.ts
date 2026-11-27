// @effect-diagnostics nodeBuiltinImport:off -- Verifies live detached session host survival and dead-broker fallback with real __session-host subprocesses.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { isProcessAlive } from "@t3tools/shared/processProbe";
import { AgentScope, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { timeIdentity } from "../commandRunner/processIdentity.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderTurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { DetachedStdioHandle } from "./DetachedStdioHandle.ts";
import * as SessionHostService from "./SessionHostService.ts";

const sessionHostLayer = SessionHostService.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ProcessRunner.layer),
);

const ECHO_CHILD_SCRIPT = `
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ kind: "ready", pid: process.pid }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  process.stdout.write(JSON.stringify({ kind: "echo", pid: process.pid, line }) + "\\n");
});
`;

// Ignores SIGTERM, so it ends only when the broker escalates to SIGKILL after its grace period.
const STUBBORN_CHILD_SCRIPT = `
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ kind: "ready", pid: process.pid }) + "\\n");
process.stdin.resume();
`;

// Writes a burst of output on each "burst" line from a TCP control socket, so a test can make
// output appear while no server is attached.
const BURST_CHILD_SCRIPT = `
const net = require("node:net");
const control = net.createServer((socket) => {
  socket.on("data", () => {
    process.stdout.write(JSON.stringify({ kind: "burst", pad: "x".repeat(200) }) + "\\n", () => {
      socket.end("done\\n");
    });
  });
});
control.listen(0, "127.0.0.1", () => {
  process.stdout.write(
    JSON.stringify({ kind: "ready", pid: process.pid, port: control.address().port }) + "\\n",
  );
});
process.stdin.resume();
`;

const sendBurst = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => socket.write("burst\n"));
    socket.once("end", () => resolve());
    socket.resume();
  });

const readNextLine = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        stream.off("data", onData);
        resolve(buffer.slice(0, nl).replace(/\r$/, ""));
      }
    };
    stream.on("data", onData);
  });

const makeRunningProjection = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
}) =>
  ({
    thread: {
      id: input.threadId,
      projectId: "project_session_host_test",
      providerInstanceId: ProviderInstanceId.make("claude"),
      title: "Session host test thread",
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      snoozedUntil: null,
    },
    runtimeRequests: [],
    providerSessions: [
      {
        id: input.providerSessionId,
        driver: ProviderDriverKind.make("claude"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        status: "ready",
        nativeSessionRef: {
          driver: ProviderDriverKind.make("claude"),
          kind: "claude_session",
          nativeId: "native-session-1",
          strength: "strong",
        },
      },
    ],
    providerThreads: [
      {
        id: input.providerThreadId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        driver: ProviderDriverKind.make("claude"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerSessionId: input.providerSessionId,
        status: "active",
        nativeThreadRef: {
          driver: ProviderDriverKind.make("claude"),
          kind: "claude_session",
          nativeId: "native-thread-1",
          strength: "strong",
        },
      },
    ],
    providerTurns: [
      {
        id: "provider_turn_live",
        providerThreadId: input.providerThreadId,
        runAttemptId: input.attemptId,
        nodeId: input.rootNodeId,
        status: "running",
        nativeTurnRef: {
          driver: ProviderDriverKind.make("claude"),
          kind: "claude_turn",
          nativeId: "native-turn-1",
          strength: "strong",
        },
      },
    ],
    runs: [
      {
        id: input.runId,
        status: "running",
        activeAttemptId: input.attemptId,
        providerInstanceId: ProviderInstanceId.make("claude"),
        providerThreadId: input.providerThreadId,
        userMessageId: "message_live",
      },
    ],
    attempts: [
      {
        id: input.attemptId,
        runId: input.runId,
        rootNodeId: input.rootNodeId,
        status: "running",
      },
    ],
    nodes: [
      {
        id: input.rootNodeId,
        runId: input.runId,
        status: "running",
      },
    ],
    subagents: [],
    messages: [{ id: "message_live", createdBy: "user" }],
    turnItems: [],
  }) as unknown as OrchestrationV2ThreadProjection;

/** A thread on the process with no run of its own. */
const makeIdleProjection = (input: Parameters<typeof makeRunningProjection>[0]) =>
  ({
    ...makeRunningProjection(input),
    runs: [],
    attempts: [],
    nodes: [],
    providerTurns: [],
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

/** Whether a commit marks the provider session stopped. */
const stopsSession = (
  commit: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0],
  providerSessionId: ProviderSessionId,
) =>
  commit.events.some(
    (event) =>
      event.type === "provider-session.updated" &&
      event.payload.id === providerSessionId &&
      event.payload.status === "stopped",
  );

type AdoptTurn = ProviderTurnStart.ProviderTurnStartServiceV2["Service"]["adopt"];
type ReleaseAdoptedOutput =
  ProviderTurnStart.ProviderTurnStartServiceV2["Service"]["releaseAdoptedOutput"];

const buildRecoveryLayer = (
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  onCommit: (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => void,
  hooks: {
    /** Further threads served by the same provider process. */
    readonly otherThreads?: ReadonlyArray<OrchestrationV2ThreadProjection>;
    readonly adopt?: AdoptTurn;
    readonly releaseAdoptedOutput?: ReleaseAdoptedOutput;
    readonly onAbandonAdoption?: (providerSessionId: ProviderSessionId) => void;
    readonly onPruneRestored?: (keepThreadIds: ReadonlySet<ThreadId>) => void;
    readonly onReconcileAfterProcessLoss?: () => void;
  } = {},
) => {
  const { adopt, onAbandonAdoption, onPruneRestored } = hooks;
  const projectionsById = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [threadId, projection],
    ...(hooks.otherThreads ?? []).map((other) => [other.thread.id, other] as const),
  ]);
  const projectionFor = (id: ThreadId) => projectionsById.get(id) ?? projection;
  return ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
    Layer.provide(
      Layer.mergeAll(
        adopt === undefined
          ? Layer.empty
          : Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
              adopt,
              releaseAdoptedOutput: hooks.releaseAdoptedOutput ?? (() => Effect.succeed(true)),
              abandonAdoption: (providerSessionId) =>
                Effect.sync(() => onAbandonAdoption?.(providerSessionId)),
            }),
        onPruneRestored === undefined
          ? Layer.empty
          : Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              pruneRestored: (keepThreadIds) => Effect.sync(() => onPruneRestored(keepThreadIds)),
            }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([...projectionsById.keys()]),
          getRuntimeRecoveryProjection: (id) => Effect.succeed(projectionFor(id)),
          getThreadRecords: (id) => Effect.succeed(projectionFor(id)),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          lastCommittedAt: Effect.succeed(null),
          commitCommand: (input) => {
            onCommit(input);
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
          writeWithEffects: () =>
            Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never),
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
          reconcileAfterProcessLoss: Effect.sync(() => {
            hooks.onReconcileAfterProcessLoss?.();
            return { requeued: 0, cancelled: 0 };
          }),
        }),
      ),
    ),
  );
};

it.live(
  "preserves a live detached session across planned update restart without cancelling the run or queuing CONTINUE_PROMPT",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-live-"));
    const threadId = ThreadId.make("thread_detached_live");
    const runId = RunId.make("run_detached_live");
    const attemptId = RunAttemptId.make("attempt_detached_live");
    const rootNodeId = NodeId.make("node_detached_live");
    const providerSessionId = ProviderSessionId.make("ps_detached_live");
    const providerThreadId = ProviderThreadId.make("pt_detached_live");
    const projection = makeRunningProjection({
      threadId,
      runId,
      attemptId,
      rootNodeId,
      providerSessionId,
      providerThreadId,
    });

    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const commitsDuringShutdown: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
      > = [];
      const commitsDuringStartup: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
      > = [];

      // Server instance 1: spawn a detached provider session and detach for planned update.
      const firstHostLayer = sessionHostLayer;
      let originalChildPid = 0;

      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;

        const handle = yield* sessionHost.spawn({
          providerSessionId,
          providerThreadId,
          threadId,
          driver: "codex",
          command: process.execPath,
          args: ["-e", ECHO_CHILD_SCRIPT],
          cwd: tempBaseDir,
          env: process.env,
        });

        const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
          kind: string;
          pid: number;
        };
        assert.equal(ready.kind, "ready");
        originalChildPid = ready.pid;

        // Planned update shutdown: detach hosts first, then run shutdown reconciliation.
        const detached = yield* sessionHost.detachAllForUpdate();
        assert.equal(detached.length, 1);
        assert.deepEqual(detached[0]?.threadIds, [threadId]);

        const shutdownSummary = yield* recovery.reconcile("shutdown");
        assert.equal(shutdownSummary.terminalizedRuns, 0);
        assert.equal(shutdownSummary.stoppedSessions, 0);
        assert.equal(commitsDuringShutdown.length, 0);
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) =>
            commitsDuringShutdown.push(input),
          ).pipe(Layer.provideMerge(firstHostLayer)),
        ),
      );

      // Server instance 2 (fresh SessionHostService + RecoveryService against the same SQLite DB):
      // the turn start service takes the reattached process over, as the Codex adapter does.
      const adoptRequests: Array<Parameters<AdoptTurn>[0]> = [];
      const prunedKeep: Array<ReadonlyArray<ThreadId>> = [];
      const startupOrder: Array<string> = [];
      let adoptedHandle: DetachedStdioHandle | undefined;
      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;

        const startupSummary = yield* recovery.reconcile("startup");
        assert.equal(startupSummary.reattachedSessionHosts, 1);
        assert.equal(startupSummary.terminalizedRuns, 0);
        assert.equal(startupSummary.stoppedSessions, 0);
        assert.equal(commitsDuringStartup.length, 0);
        assert.deepEqual(adoptRequests, [{ threadId, runId }]);
        // Credentials are pruned after the takeover, so the taken-over thread keeps its own.
        assert.deepEqual(prunedKeep, [[threadId]]);
        // What the replayed output queues, such as the thread's next run, is not the old process's.
        assert.deepEqual(startupOrder, ["outbox reconciled", "output released"]);

        const reattachedHandle = adoptedHandle;
        assert.isDefined(reattachedHandle);
        if (reattachedHandle !== undefined) {
          // The ready line reached the old server, so the replay starts after it.
          reattachedHandle.stdin.write("hello-after-restart\n");
          const echo = JSON.parse(
            yield* Effect.promise(() => readNextLine(reattachedHandle.stdout)),
          ) as { kind: string; pid: number; line: string };
          assert.equal(echo.kind, "echo");
          assert.equal(echo.pid, originalChildPid);
          assert.equal(echo.line, "hello-after-restart");
        }

        // Cleanly terminate the surviving detached host.
        if (reattachedHandle !== undefined) {
          yield* sessionHost.terminate(reattachedHandle.sessionHostId);
        }
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const sessionHost = yield* SessionHostService.SessionHostService;
              return buildRecoveryLayer(
                threadId,
                projection,
                (input) => commitsDuringStartup.push(input),
                {
                  adopt: (request) =>
                    sessionHost.takeAdoptable(providerSessionId).pipe(
                      Effect.map((taken) => {
                        adoptRequests.push(request);
                        if (Option.isSome(taken)) adoptedHandle = taken.value.handle;
                      }),
                    ),
                  releaseAdoptedOutput: () =>
                    Effect.sync(() => {
                      startupOrder.push("output released");
                      adoptedHandle?.releaseOutput();
                      return adoptedHandle !== undefined;
                    }),
                  onPruneRestored: (keepThreadIds) => prunedKeep.push([...keepThreadIds]),
                  onReconcileAfterProcessLoss: () => startupOrder.push("outbox reconciled"),
                },
              );
            }),
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "ends a reattached process whose turn cannot be taken over and continues the run instead",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-noadopt-"));
    const threadId = ThreadId.make("thread_detached_noadopt");
    const runId = RunId.make("run_detached_noadopt");
    const attemptId = RunAttemptId.make("attempt_detached_noadopt");
    const rootNodeId = NodeId.make("node_detached_noadopt");
    const providerSessionId = ProviderSessionId.make("ps_detached_noadopt");
    const providerThreadId = ProviderThreadId.make("pt_detached_noadopt");
    const projection = makeRunningProjection({
      threadId,
      runId,
      attemptId,
      rootNodeId,
      providerSessionId,
      providerThreadId,
    });

    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let childPid = 0;

      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const handle = yield* sessionHost.spawn({
          providerSessionId,
          providerThreadId,
          threadId,
          driver: "codex",
          command: process.execPath,
          args: ["-e", STUBBORN_CHILD_SCRIPT],
          cwd: tempBaseDir,
          env: process.env,
        });
        const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
          kind: string;
          pid: number;
        };
        childPid = ready.pid;
        yield* sessionHost.detachAllForUpdate();
      }).pipe(Effect.provide(sessionHostLayer));

      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      const prunedKeep: Array<ReadonlyArray<ThreadId>> = [];
      const abandoned: Array<ProviderSessionId> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const startupSummary = yield* recovery.reconcile("startup");
        // The thread whose process was not taken over loses its restored credential.
        assert.deepEqual(prunedKeep, [[]]);
        assert.deepEqual(abandoned, [providerSessionId]);

        // The old process is gone before the continuation can start a new one on the thread.
        assert.isFalse(
          isProcessAlive(childPid),
          "The process the old server left running still runs",
        );
        assert.equal(startupSummary.terminalizedRuns, 1);
        const effects = commits.flatMap((commit) => commit.effects ?? []);
        assert.isTrue(
          effects.some((effect) => effect.id === EffectOutbox.restartContinuationEffectId(runId)),
          "Expected the run whose process was not taken over to get a RestartContinuation",
        );
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM session_hosts WHERE provider_session_id = ${providerSessionId}
        `;
        assert.deepEqual(rows, [], "An ended host stays recorded");
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) => commits.push(input), {
            adopt: ({ runId: failedRunId }) =>
              Effect.fail(
                new ProviderTurnStart.ProviderTurnStartError({
                  runId: failedRunId,
                  cause: "This provider cannot take over a running turn.",
                }),
              ),
            onAbandonAdoption: (id) => abandoned.push(id),
            onPruneRestored: (keepThreadIds) => prunedKeep.push([...keepThreadIds]),
          }).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

const makeSharedProcessThreads = (name: string) => {
  const providerSessionId = ProviderSessionId.make(`ps_${name}`);
  const thread = (suffix: string) => {
    const threadId = ThreadId.make(`thread_${name}_${suffix}`);
    const runId = RunId.make(`run_${name}_${suffix}`);
    const providerThreadId = ProviderThreadId.make(`pt_${name}_${suffix}`);
    return {
      threadId,
      runId,
      providerThreadId,
      projection: makeRunningProjection({
        threadId,
        runId,
        attemptId: RunAttemptId.make(`attempt_${name}_${suffix}`),
        rootNodeId: NodeId.make(`node_${name}_${suffix}`),
        providerSessionId,
        providerThreadId,
      }),
    };
  };
  return { providerSessionId, first: thread("first"), second: thread("second") };
};

/** Spawns one provider process for two threads and detaches it for the update. */
const detachSharedProcess = (
  shared: ReturnType<typeof makeSharedProcessThreads>,
  cwd: string,
  takenOverThreads: ReadonlyArray<ThreadId> = [shared.first.threadId, shared.second.threadId],
) =>
  Effect.gen(function* () {
    const sessionHost = yield* SessionHostService.SessionHostService;
    const handle = yield* sessionHost.spawn({
      providerSessionId: shared.providerSessionId,
      providerThreadId: shared.first.providerThreadId,
      threadId: shared.first.threadId,
      driver: "codex",
      command: process.execPath,
      args: ["-e", ECHO_CHILD_SCRIPT],
      cwd,
      env: process.env,
    });
    const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
      readonly pid: number;
    };
    const detached = yield* sessionHost.detachAllForUpdate({
      prepare: () =>
        Effect.succeed({
          deliver: Effect.void,
          drain: Effect.void,
          takenOverThreads: Effect.succeed(takenOverThreads),
        }),
    });
    assert.deepEqual(detached[0]?.threadIds, takenOverThreads);
    return { childPid: ready.pid, sessionHostId: handle.sessionHostId };
  }).pipe(Effect.provide(sessionHostLayer));

/** Ends a host a failed assertion left running; ending an ended host does nothing. */
const endHost = (sessionHostId: string) =>
  SessionHostService.SessionHostService.pipe(
    Effect.flatMap((sessionHost) => sessionHost.terminate(sessionHostId)),
    Effect.provide(sessionHostLayer),
    Effect.orDie,
  );

it.live(
  "takes over every thread a shared process serves and releases its output once all are adopted",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-shared-"));
    const shared = makeSharedProcessThreads("detached_shared");
    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const { childPid, sessionHostId } = yield* detachSharedProcess(shared, tempBaseDir);
      const steps: Array<string> = [];
      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      const prunedKeep: Array<ReadonlyArray<ThreadId>> = [];
      let adoptedHandle: DetachedStdioHandle | undefined;
      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const startupSummary = yield* recovery.reconcile("startup");

        assert.deepEqual(steps, [
          `adopt:${shared.first.runId}`,
          `adopt:${shared.second.runId}`,
          "release",
        ]);
        assert.equal(startupSummary.terminalizedRuns, 0);
        assert.equal(startupSummary.stoppedSessions, 0);
        assert.equal(commits.length, 0);
        assert.deepEqual(prunedKeep, [[shared.first.threadId, shared.second.threadId]]);

        const handle = adoptedHandle;
        assert.isDefined(handle);
        if (handle !== undefined) {
          handle.stdin.write("both-threads\n");
          const echo = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
            readonly pid: number;
            readonly line: string;
          };
          assert.equal(echo.pid, childPid);
          assert.equal(echo.line, "both-threads");
          yield* sessionHost.terminate(handle.sessionHostId);
        }
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const sessionHost = yield* SessionHostService.SessionHostService;
              return buildRecoveryLayer(
                shared.first.threadId,
                shared.first.projection,
                (input) => commits.push(input),
                {
                  otherThreads: [shared.second.projection],
                  adopt: (request) =>
                    Effect.gen(function* () {
                      steps.push(`adopt:${request.runId}`);
                      if (adoptedHandle !== undefined) return;
                      const taken = yield* sessionHost.takeAdoptable(shared.providerSessionId);
                      if (Option.isSome(taken)) adoptedHandle = taken.value.handle;
                    }),
                  releaseAdoptedOutput: () =>
                    Effect.sync(() => {
                      steps.push("release");
                      adoptedHandle?.releaseOutput();
                      return adoptedHandle !== undefined;
                    }),
                  onPruneRestored: (keepThreadIds) => prunedKeep.push([...keepThreadIds]),
                },
              );
            }),
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
        Effect.ensuring(endHost(sessionHostId)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "ends a shared process when one of its runs cannot be taken over and continues every run on it",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-partial-"));
    const shared = makeSharedProcessThreads("detached_partial");
    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const { childPid, sessionHostId } = yield* detachSharedProcess(shared, tempBaseDir);
      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      const prunedKeep: Array<ReadonlyArray<ThreadId>> = [];
      const abandoned: Array<ProviderSessionId> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        yield* recovery.reconcile("startup");

        assert.deepEqual(abandoned, [shared.providerSessionId]);
        assert.isFalse(isProcessAlive(childPid), "The shared process still runs");
        assert.deepEqual(prunedKeep, [[]]);
        const effectIds = commits.flatMap((commit) => commit.effects ?? []).map((e) => e.id);
        // The run already taken over ends with the server's session, like any run a restart cuts.
        assert.include(effectIds, EffectOutbox.restartContinuationEffectId(shared.first.runId));
        assert.include(effectIds, EffectOutbox.restartContinuationEffectId(shared.second.runId));
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(
            shared.first.threadId,
            shared.first.projection,
            (input) => commits.push(input),
            {
              otherThreads: [shared.second.projection],
              adopt: ({ runId }) =>
                runId === shared.first.runId
                  ? Effect.void
                  : Effect.fail(
                      new ProviderTurnStart.ProviderTurnStartError({
                        runId,
                        cause: "The second run could not be taken over.",
                      }),
                    ),
              onAbandonAdoption: (id) => abandoned.push(id),
              onPruneRestored: (keepThreadIds) => prunedKeep.push([...keepThreadIds]),
            },
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
        Effect.ensuring(endHost(sessionHostId)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "ends a shared process without taking over any run when a thread on it has a run it cannot take over",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-blocked-"));
    const shared = makeSharedProcessThreads("detached_blocked");
    const starting = {
      ...shared.second.projection,
      runs: shared.second.projection.runs.map((run) => ({ ...run, status: "starting" })),
    } as unknown as OrchestrationV2ThreadProjection;
    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const { childPid, sessionHostId } = yield* detachSharedProcess(shared, tempBaseDir);
      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      const adopted: Array<RunId> = [];
      const abandoned: Array<ProviderSessionId> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        yield* recovery.reconcile("startup");

        assert.deepEqual(adopted, []);
        assert.deepEqual(abandoned, [shared.providerSessionId]);
        assert.isFalse(isProcessAlive(childPid), "The shared process still runs");
        const effectIds = commits.flatMap((commit) => commit.effects ?? []).map((e) => e.id);
        assert.include(effectIds, EffectOutbox.restartContinuationEffectId(shared.first.runId));
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(
            shared.first.threadId,
            shared.first.projection,
            (input) => commits.push(input),
            {
              otherThreads: [starting],
              adopt: ({ runId }) => Effect.sync(() => adopted.push(runId)),
              onAbandonAdoption: (id) => abandoned.push(id),
            },
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
        Effect.ensuring(endHost(sessionHostId)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "takes over a shared process while a thread that once used it runs on another provider session",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-recovery-elsewhere-"),
    );
    const shared = makeSharedProcessThreads("detached_elsewhere");
    // The second thread used the shared process before and now runs on another session.
    const runningElsewhere = makeRunningProjection({
      threadId: shared.second.threadId,
      runId: shared.second.runId,
      attemptId: RunAttemptId.make("attempt_detached_elsewhere_other"),
      rootNodeId: NodeId.make("node_detached_elsewhere_other"),
      providerSessionId: ProviderSessionId.make("ps_detached_elsewhere_other"),
      providerThreadId: ProviderThreadId.make("pt_detached_elsewhere_other"),
    });
    const elsewhere = {
      ...runningElsewhere,
      providerSessions: [
        ...shared.second.projection.providerSessions,
        ...runningElsewhere.providerSessions,
      ],
      providerThreads: [
        ...shared.second.projection.providerThreads,
        ...runningElsewhere.providerThreads,
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const { childPid, sessionHostId } = yield* detachSharedProcess(shared, tempBaseDir, [
        shared.first.threadId,
      ]);
      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      const adopted: Array<RunId> = [];
      const abandoned: Array<ProviderSessionId> = [];
      let adoptedHandle: DetachedStdioHandle | undefined;
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        yield* recovery.reconcile("startup");

        assert.deepEqual(adopted, [shared.first.runId]);
        assert.deepEqual(abandoned, []);
        assert.isTrue(isProcessAlive(childPid), "The shared process was ended");
        assert.isFalse(
          commits.some((commit) => stopsSession(commit, shared.providerSessionId)),
          "Startup marked the taken-over session stopped",
        );
        const effectIds = commits.flatMap((commit) => commit.effects ?? []).map((e) => e.id);
        assert.include(effectIds, EffectOutbox.restartContinuationEffectId(shared.second.runId));
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const sessionHost = yield* SessionHostService.SessionHostService;
              return buildRecoveryLayer(
                shared.first.threadId,
                shared.first.projection,
                (input) => commits.push(input),
                {
                  otherThreads: [elsewhere],
                  adopt: ({ runId }) =>
                    sessionHost.takeAdoptable(shared.providerSessionId).pipe(
                      Effect.map((taken) => {
                        adopted.push(runId);
                        if (Option.isSome(taken)) adoptedHandle = taken.value.handle;
                      }),
                    ),
                  releaseAdoptedOutput: () =>
                    Effect.sync(() => {
                      adoptedHandle?.releaseOutput();
                      return adoptedHandle !== undefined;
                    }),
                  onAbandonAdoption: (id) => abandoned.push(id),
                },
              );
            }),
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
        Effect.ensuring(endHost(sessionHostId)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "keeps a taken-over shared session live while a thread on it that was not taken over is reconciled",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-idle-"));
    const shared = makeSharedProcessThreads("detached_idle");
    const idle = makeIdleProjection({
      threadId: shared.second.threadId,
      runId: shared.second.runId,
      attemptId: RunAttemptId.make("attempt_detached_idle_second"),
      rootNodeId: NodeId.make("node_detached_idle_second"),
      providerSessionId: shared.providerSessionId,
      providerThreadId: shared.second.providerThreadId,
    });
    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const shutdownCommits: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
      > = [];
      let sessionHostId = "";
      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const handle = yield* sessionHost.spawn({
          providerSessionId: shared.providerSessionId,
          providerThreadId: shared.first.providerThreadId,
          threadId: shared.first.threadId,
          driver: "codex",
          command: process.execPath,
          args: ["-e", ECHO_CHILD_SCRIPT],
          cwd: tempBaseDir,
          env: process.env,
        });
        sessionHostId = handle.sessionHostId;
        yield* Effect.promise(() => readNextLine(handle.stdout));
        const detached = yield* sessionHost.detachAllForUpdate({
          prepare: () =>
            Effect.succeed({
              deliver: Effect.void,
              drain: Effect.void,
              takenOverThreads: Effect.succeed([shared.first.threadId]),
            }),
        });
        assert.deepEqual(detached[0]?.threadIds, [shared.first.threadId]);
        yield* recovery.reconcile("shutdown");
        assert.isFalse(
          shutdownCommits.some((commit) => stopsSession(commit, shared.providerSessionId)),
          "Shutdown marked the kept session stopped",
        );
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(
            shared.first.threadId,
            shared.first.projection,
            (input) => shutdownCommits.push(input),
            { otherThreads: [idle] },
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
      );

      const startupCommits: Array<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]
      > = [];
      const prunedKeep: Array<ReadonlyArray<ThreadId>> = [];
      const adopted: Array<RunId> = [];
      let adoptedHandle: DetachedStdioHandle | undefined;
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const summary = yield* recovery.reconcile("startup");

        assert.deepEqual(adopted, [shared.first.runId]);
        assert.deepEqual(prunedKeep, [[shared.first.threadId]]);
        assert.equal(summary.stoppedSessions, 0);
        assert.isFalse(
          startupCommits.some((commit) => stopsSession(commit, shared.providerSessionId)),
          "Startup marked the taken-over session stopped",
        );
        assert.isDefined(adoptedHandle);
        assert.isFalse(adoptedHandle?.exited ?? true, "The taken-over process ended");
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.gen(function* () {
              const sessionHost = yield* SessionHostService.SessionHostService;
              return buildRecoveryLayer(
                shared.first.threadId,
                shared.first.projection,
                (input) => startupCommits.push(input),
                {
                  otherThreads: [idle],
                  adopt: ({ runId }) =>
                    sessionHost.takeAdoptable(shared.providerSessionId).pipe(
                      Effect.map((taken) => {
                        adopted.push(runId);
                        if (Option.isSome(taken)) adoptedHandle = taken.value.handle;
                      }),
                    ),
                  releaseAdoptedOutput: () =>
                    Effect.sync(() => {
                      adoptedHandle?.releaseOutput();
                      return adoptedHandle !== undefined;
                    }),
                  onPruneRestored: (keepThreadIds) => prunedKeep.push([...keepThreadIds]),
                },
              );
            }),
          ).pipe(Layer.provideMerge(sessionHostLayer)),
        ),
        Effect.ensuring(endHost(sessionHostId)),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "falls back to RestartContinuation when a detached broker died while the server was down",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-dead-"));
    const threadId = ThreadId.make("thread_detached_dead");
    const runId = RunId.make("run_detached_dead");
    const attemptId = RunAttemptId.make("attempt_detached_dead");
    const rootNodeId = NodeId.make("node_detached_dead");
    const providerSessionId = ProviderSessionId.make("ps_detached_dead");
    const providerThreadId = ProviderThreadId.make("pt_detached_dead");
    const projection = makeRunningProjection({
      threadId,
      runId,
      attemptId,
      rootNodeId,
      providerSessionId,
      providerThreadId,
    });

    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let brokerPid: number | null = null;
      let childPid: number | null = null;

      // Server instance 1: spawn a detached host, detach it, then kill both broker and child.
      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const handle = yield* sessionHost.spawn({
          providerSessionId,
          providerThreadId,
          threadId,
          driver: "codex",
          command: process.execPath,
          args: ["-e", ECHO_CHILD_SCRIPT],
          cwd: tempBaseDir,
          env: process.env,
        });
        const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
          kind: string;
          pid: number;
        };
        assert.equal(ready.kind, "ready");
        childPid = ready.pid;

        const stored = yield* sql<{
          readonly broker_pid: number | null;
          readonly socket_path: string;
        }>`
          SELECT broker_pid, socket_path
          FROM session_hosts
          WHERE provider_session_id = ${providerSessionId}
        `;
        brokerPid = stored[0]?.broker_pid ?? null;
        const socketPath = stored[0]?.socket_path ?? handle.socketPath;

        yield* sessionHost.detachAllForUpdate();

        // Simulate the detached broker dying while the server was restarting.
        const killPid = (pid: number | null) =>
          pid === null
            ? Effect.void
            : Effect.sync(() => {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  // Already gone.
                }
              });
        yield* killPid(childPid);
        yield* killPid(brokerPid);
        // Remove the socket file so the dead broker cannot accept a stray connect during OS teardown.
        if (!isWindowsHost && NodeFS.existsSync(socketPath)) {
          NodeFS.rmSync(socketPath, { force: true });
        }
      }).pipe(Effect.provide(sessionHostLayer));

      // Server instance 2: startup recovery sees the dead broker and falls back to RestartContinuation.
      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const startupSummary = yield* recovery.reconcile("startup");

        assert.isUndefined(startupSummary.reattachedSessionHosts);
        assert.equal(startupSummary.terminalizedRuns, 1);
        assert.equal(startupSummary.stoppedSessions, 1);
        assert.isAbove(commits.length, 0);

        const effects = commits.flatMap((commit) => commit.effects ?? []);
        const expectedContinuationId = EffectOutbox.restartContinuationEffectId(runId);
        assert.isTrue(
          effects.some((effect) => effect.id === expectedContinuationId),
          "Expected dead detached session host to schedule a RestartContinuation effect",
        );

        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM session_hosts WHERE provider_session_id = ${providerSessionId}
        `;
        assert.deepEqual(rows, [], "An ended host stays recorded");
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) => commits.push(input)).pipe(
            Layer.provideMerge(sessionHostLayer),
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live(
  "falls back to RestartContinuation when the broker dropped output the old server never read",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-gap-"));
    const threadId = ThreadId.make("thread_detached_gap");
    const runId = RunId.make("run_detached_gap");
    const attemptId = RunAttemptId.make("attempt_detached_gap");
    const rootNodeId = NodeId.make("node_detached_gap");
    const providerSessionId = ProviderSessionId.make("ps_detached_gap");
    const providerThreadId = ProviderThreadId.make("pt_detached_gap");
    const projection = makeRunningProjection({
      threadId,
      runId,
      attemptId,
      rootNodeId,
      providerSessionId,
      providerThreadId,
    });

    const baseLayer = Layer.mergeAll(
      Sqlite.layerMemory,
      ServerConfig.layerTest(tempBaseDir, tempBaseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));

    let childPid: number | null = null;
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        // The buffer holds less than two bursts, so the second evicts the first unread one.
        const handle = yield* sessionHost.spawn({
          providerSessionId,
          providerThreadId,
          threadId,
          driver: "codex",
          command: process.execPath,
          args: ["-e", BURST_CHILD_SCRIPT],
          cwd: tempBaseDir,
          env: process.env,
          maxBufferBytes: 300,
        });
        const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
          pid: number;
          port: number;
        };
        childPid = ready.pid;
        yield* sessionHost.detachAllForUpdate();
        yield* Effect.promise(() => sendBurst(ready.port));
        yield* Effect.promise(() => sendBurst(ready.port));
      }).pipe(Effect.provide(sessionHostLayer));

      const commits: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const startupSummary = yield* recovery.reconcile("startup");

        assert.isUndefined(startupSummary.reattachedSessionHosts);
        assert.equal(startupSummary.terminalizedRuns, 1);
        const effects = commits.flatMap((commit) => commit.effects ?? []);
        assert.isTrue(
          effects.some((effect) => effect.id === EffectOutbox.restartContinuationEffectId(runId)),
          "Expected lost output to schedule a RestartContinuation effect",
        );
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM session_hosts WHERE provider_session_id = ${providerSessionId}
        `;
        assert.deepEqual(rows, [], "An ended host stays recorded");
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) => commits.push(input)).pipe(
            Layer.provideMerge(sessionHostLayer),
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (childPid !== null) {
            try {
              process.kill(childPid, "SIGKILL");
            } catch {
              // Already stopped by the terminate the gap triggered.
            }
          }
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(baseLayer),
    );
  },
);

it.live("keeps the broker auth token in the secret store and removes it when the host ends", () => {
  const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-session-host-token-"));
  const baseLayer = Layer.mergeAll(
    Sqlite.layerMemory,
    ServerConfig.layerTest(tempBaseDir, tempBaseDir),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const providerSessionId = ProviderSessionId.make("ps_token");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const sessionHost = yield* SessionHostService.SessionHostService;
    const handle = yield* sessionHost.spawn({
      providerSessionId,
      threadId: ThreadId.make("thread_token"),
      driver: "codex",
      command: process.execPath,
      args: ["-e", ECHO_CHILD_SCRIPT],
      cwd: tempBaseDir,
      env: process.env,
    });
    yield* Effect.promise(() => readNextLine(handle.stdout));

    const rows = yield* sql`SELECT * FROM session_hosts`;
    assert.equal(rows.length, 1);
    assert.notInclude(JSON.stringify(rows), handle.authToken);
    const secretPath = NodePath.join(config.secretsDir, `session-host-${handle.sessionHostId}.bin`);
    assert.equal(NodeFS.readFileSync(secretPath, "utf8"), handle.authToken);

    yield* sessionHost.terminate(handle.sessionHostId);
    assert.isFalse(NodeFS.existsSync(secretPath));
    assert.deepEqual(yield* sql`SELECT id FROM session_hosts`, []);
  }).pipe(
    Effect.provide(sessionHostLayer),
    Effect.ensuring(
      Effect.sync(() => NodeFS.rmSync(tempBaseDir, { recursive: true, force: true })),
    ),
    Effect.provide(baseLayer),
  );
});

const isolatedBaseLayer = (tempBaseDir: string) =>
  Layer.mergeAll(Sqlite.layerMemory, ServerConfig.layerTest(tempBaseDir, tempBaseDir)).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

it.live.skipIf(isWindowsHost)(
  "gives the broker the provider process's agent scope, which its child stays in",
  () => {
    const tempBaseDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-session-host-scope-"),
    );
    const wrapped: Array<Parameters<AgentScopeShape["wrap"]>[0]> = [];
    const recordingScope: AgentScopeShape = {
      ...AgentScope.defaultValue(),
      wrap: (input) => {
        wrapped.push(input);
        return Effect.succeed({ command: input.command, args: input.args });
      },
    };
    const threadId = ThreadId.make("thread_scope");

    return Effect.gen(function* () {
      const sessionHost = yield* SessionHostService.SessionHostService;
      const handle = yield* sessionHost.spawn({
        providerSessionId: ProviderSessionId.make("ps_scope"),
        threadId,
        driver: "codex",
        command: process.execPath,
        args: ["-e", ECHO_CHILD_SCRIPT],
        cwd: tempBaseDir,
        env: process.env,
      });
      yield* Effect.promise(() => readNextLine(handle.stdout));
      yield* sessionHost.terminate(handle.sessionHostId);

      assert.equal(wrapped.length, 1);
      assert.include(wrapped[0], {
        name: "codex",
        threadId,
        shared: true,
        survivesRestart: true,
      });
    }).pipe(
      Effect.provide(sessionHostLayer),
      Effect.provideService(AgentScope, recordingScope),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(tempBaseDir, { recursive: true, force: true })),
      ),
      Effect.provide(isolatedBaseLayer(tempBaseDir)),
    );
  },
);

/** Spawns a host in a service that then closes, as a server does when it stops. */
const spawnHostInClosedService = (tempBaseDir: string, detachForUpdate: boolean) =>
  Effect.gen(function* () {
    const sessionHost = yield* SessionHostService.SessionHostService;
    const handle = yield* sessionHost.spawn({
      providerSessionId: ProviderSessionId.make(`ps_${NodePath.basename(tempBaseDir)}`),
      threadId: ThreadId.make(`thread_${NodePath.basename(tempBaseDir)}`),
      driver: "codex",
      command: process.execPath,
      args: ["-e", ECHO_CHILD_SCRIPT],
      cwd: tempBaseDir,
      env: process.env,
    });
    const ready = JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as {
      pid: number;
    };
    if (detachForUpdate) yield* sessionHost.detachAllForUpdate();
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly broker_pid: number; readonly socket_path: string }>`
      SELECT broker_pid, socket_path FROM session_hosts WHERE id = ${handle.sessionHostId}
    `;
    return {
      id: handle.sessionHostId,
      childPid: ready.pid,
      brokerPid: rows[0]?.broker_pid ?? null,
      socketPath: rows[0]?.socket_path ?? handle.socketPath,
    };
  }).pipe(Effect.provide(sessionHostLayer));

/** Stops the broker and child of a test by the pids recorded at spawn. */
const stopSpawned = (pids: ReadonlyArray<number | null>) => {
  for (const pid of pids) {
    if (pid !== null && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
};

it.live("ends hosts a stopped server left running and forgets them with their tokens", () => {
  const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sh-leftover-"));
  let spawned: { brokerPid: number | null; childPid: number } | undefined;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const host = yield* spawnHostInClosedService(tempBaseDir, false);
    spawned = host;
    const secretPath = NodePath.join(config.secretsDir, `session-host-${host.id}.bin`);
    assert.isTrue(NodeFS.existsSync(secretPath));

    yield* Effect.gen(function* () {
      const sessionHost = yield* SessionHostService.SessionHostService;
      yield* sessionHost.reattachAllDetachedForUpdate();
    }).pipe(Effect.provide(sessionHostLayer));

    assert.deepEqual(yield* sql`SELECT id FROM session_hosts`, []);
    assert.isFalse(NodeFS.existsSync(secretPath), "The leftover host's token is still stored");
    assert.isFalse(isProcessAlive(host.childPid), "The leftover host's process still runs");
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        stopSpawned([spawned?.childPid ?? null, spawned?.brokerPid ?? null]);
        NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
      }),
    ),
    Effect.provide(isolatedBaseLayer(tempBaseDir)),
  );
});

it.live("stops a host instead of detaching it when what was queued for it is not delivered", () => {
  const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sh-undelivered-"));
  let childPid: number | null = null;
  let brokerPid: number | null = null;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionHost = yield* SessionHostService.SessionHostService;
    const threadId = ThreadId.make(`thread_${NodePath.basename(tempBaseDir)}`);
    const handle = yield* sessionHost.spawn({
      providerSessionId: ProviderSessionId.make(`ps_${NodePath.basename(tempBaseDir)}`),
      threadId,
      driver: "codex",
      command: process.execPath,
      args: ["-e", ECHO_CHILD_SCRIPT],
      cwd: tempBaseDir,
      env: process.env,
    });
    childPid = (
      JSON.parse(yield* Effect.promise(() => readNextLine(handle.stdout))) as { pid: number }
    ).pid;
    const rows = yield* sql<{ readonly broker_pid: number }>`
      SELECT broker_pid FROM session_hosts WHERE id = ${handle.sessionHostId}
    `;
    brokerPid = rows[0]?.broker_pid ?? null;

    const detached = yield* sessionHost.detachAllForUpdate({
      prepare: () =>
        Effect.succeed({
          deliver: Effect.never,
          drain: Effect.void,
          takenOverThreads: Effect.succeed([threadId]),
        }),
    });

    assert.deepEqual(detached, []);
    assert.isFalse(yield* sessionHost.isThreadDetachedForUpdate(threadId));
    assert.deepEqual(
      yield* sql`SELECT id FROM session_hosts WHERE status = 'detached_for_update'`,
      [],
    );
    assert.isFalse(isProcessAlive(childPid), "The undelivered host's process still runs");
  }).pipe(
    Effect.provide(sessionHostLayer),
    Effect.ensuring(
      Effect.sync(() => {
        stopSpawned([childPid, brokerPid]);
        NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
      }),
    ),
    Effect.provide(isolatedBaseLayer(tempBaseDir)),
  );
});

const refusesReattach = (
  name: string,
  tamper: (
    host: { readonly id: string; readonly socketPath: string },
    tempBaseDir: string,
  ) => Effect.Effect<void, never, SqlClient.SqlClient>,
  expectedDetail: RegExp,
) =>
  it.live(name, () => {
    const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sh-refuse-"));
    let spawned: { brokerPid: number | null; childPid: number } | undefined;
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const host = yield* spawnHostInClosedService(tempBaseDir, true);
      spawned = host;
      yield* tamper(host, tempBaseDir);

      const refused = yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        return yield* sessionHost.reattach(host.id).pipe(Effect.flip);
      }).pipe(Effect.provide(sessionHostLayer));

      assert.match(refused.detail, expectedDetail);
      assert.deepEqual(yield* sql`SELECT id FROM session_hosts`, []);
      // The broker never got the token, so it still waits for a server it can trust.
      assert.isTrue(isProcessAlive(host.childPid));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stopSpawned([spawned?.childPid ?? null, spawned?.brokerPid ?? null]);
          NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(isolatedBaseLayer(tempBaseDir)),
    );
  });

refusesReattach(
  "refuses a reattach to a broker pid now held by another process",
  (host) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly identity: string }>`
        SELECT json_extract(broker_identity_json, '$.identity') AS identity
        FROM session_hosts WHERE id = ${host.id}`;
      const stored = rows[0]?.identity ?? "";
      // An identity in this platform's format for an earlier holder of the pid.
      const earlier = stored.startsWith("boot:")
        ? stored.replace(/\d+$/, (ticks) => String(Number(ticks) + 1))
        : timeIdentity(0);
      assert.notStrictEqual(earlier, stored);
      yield* sql`UPDATE session_hosts SET broker_identity_json = ${JSON.stringify({ identity: earlier })} WHERE id = ${host.id}`;
    }).pipe(Effect.orDie),
  /broker_pid_reused/,
);

refusesReattach(
  "refuses a reattach to a broker whose identity cannot be checked",
  (host) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE session_hosts SET broker_identity_json = ${"unreadable"} WHERE id = ${host.id}`;
    }).pipe(Effect.orDie),
  /broker_identity_unknown/,
);

if (!isWindowsHost) {
  refusesReattach(
    "refuses a reattach through a symlinked socket directory",
    (host, tempBaseDir) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const link = NodePath.join(tempBaseDir, "socket-link");
        NodeFS.symlinkSync(NodePath.dirname(host.socketPath), link);
        const linkedPath = NodePath.join(link, NodePath.basename(host.socketPath));
        yield* sql`UPDATE session_hosts SET socket_path = ${linkedPath} WHERE id = ${host.id}`;
      }).pipe(Effect.orDie),
    /not a real directory/,
  );

  const terminateUnattached = (name: string, throughSymlink: boolean) =>
    it.live(name, () => {
      const tempBaseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sh-terminate-"));
      let spawned: { brokerPid: number | null; childPid: number } | undefined;
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const host = yield* spawnHostInClosedService(tempBaseDir, true);
        spawned = host;
        if (throughSymlink) {
          const link = NodePath.join(tempBaseDir, "socket-link");
          NodeFS.symlinkSync(NodePath.dirname(host.socketPath), link);
          const linkedPath = NodePath.join(link, NodePath.basename(host.socketPath));
          yield* sql`UPDATE session_hosts SET socket_path = ${linkedPath} WHERE id = ${host.id}`;
        }

        yield* Effect.gen(function* () {
          const sessionHost = yield* SessionHostService.SessionHostService;
          yield* sessionHost.terminate(host.id);
        }).pipe(Effect.provide(sessionHostLayer));

        assert.deepEqual(yield* sql`SELECT id FROM session_hosts`, []);
        if (throughSymlink) {
          assert.isTrue(isProcessAlive(host.childPid), "The token went to an unchecked socket");
        } else {
          // A caller that starts a replacement must not find the old process still running.
          assert.isFalse(isProcessAlive(host.childPid), "terminate returned before the exit");
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stopSpawned([spawned?.childPid ?? null, spawned?.brokerPid ?? null]);
            NodeFS.rmSync(tempBaseDir, { recursive: true, force: true });
          }),
        ),
        Effect.provide(isolatedBaseLayer(tempBaseDir)),
      );
    });

  terminateUnattached("terminates a host it is not attached to and waits for it to end", false);
  terminateUnattached(
    "sends no token when terminating a host through a symlinked socket directory",
    true,
  );
}
