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
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SessionHostService from "./SessionHostService.ts";

const ECHO_CHILD_SCRIPT = `
const readline = require("node:readline");
process.stdout.write(JSON.stringify({ kind: "ready", pid: process.pid }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  process.stdout.write(JSON.stringify({ kind: "echo", pid: process.pid, line }) + "\\n");
});
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

const buildRecoveryLayer = (
  threadId: ThreadId,
  projection: OrchestrationV2ThreadProjection,
  onCommit: (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => void,
) =>
  ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: () => Effect.succeed([threadId]),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadRecords: () => Effect.succeed(projection),
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
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

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
      const firstHostLayer = SessionHostService.layer;
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
        assert.equal(detached[0]?.threadId, threadId);

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
      yield* Effect.gen(function* () {
        const sessionHost = yield* SessionHostService.SessionHostService;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;

        const startupSummary = yield* recovery.reconcile("startup");
        assert.equal(startupSummary.reattachedSessionHosts, 1);
        assert.equal(startupSummary.terminalizedRuns, 0);
        assert.equal(startupSummary.stoppedSessions, 0);
        assert.equal(commitsDuringStartup.length, 0);

        const reattachedHandle =
          yield* sessionHost.getActiveHandleByProviderSession(providerSessionId);
        assert.isDefined(reattachedHandle);
        if (reattachedHandle !== undefined) {
          reattachedHandle.stdin.write("hello-after-restart\n");
          const echo = JSON.parse(
            yield* Effect.promise(() => readNextLine(reattachedHandle.stdout)),
          ) as { kind: string; pid: number; line: string };
          assert.equal(echo.kind, "echo");
          assert.equal(echo.pid, originalChildPid);
          assert.equal(echo.line, "hello-after-restart");
        }

        // Cleanly terminate the surviving detached host.
        yield* sessionHost.terminateByProviderSession(providerSessionId);
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) =>
            commitsDuringStartup.push(input),
          ).pipe(Layer.provideMerge(SessionHostService.layer)),
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
      }).pipe(Effect.provide(SessionHostService.layer));

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
        assert.equal(rows[0]?.status, "dead");
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) => commits.push(input)).pipe(
            Layer.provideMerge(SessionHostService.layer),
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
      }).pipe(Effect.provide(SessionHostService.layer));

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
        assert.equal(rows[0]?.status, "dead");
      }).pipe(
        Effect.provide(
          buildRecoveryLayer(threadId, projection, (input) => commits.push(input)).pipe(
            Layer.provideMerge(SessionHostService.layer),
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
