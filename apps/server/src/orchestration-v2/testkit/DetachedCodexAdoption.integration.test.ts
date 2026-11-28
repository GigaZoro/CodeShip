// @effect-diagnostics nodeBuiltinImport:off -- Drives a real __session-host broker and a fake Codex app server across two server instances.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  ProviderDriverKind,
  type OrchestrationV2Command,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { isProcessAlive } from "@t3tools/shared/processProbe";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as SessionHostService from "../../sessionHost/SessionHostService.ts";
import * as CodexAdapterV2 from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  READ_ONLY_ON_REQUEST_POLICY,
  TOOL_CALL_WRITE_PROMPT,
} from "./fixtures/shared.ts";
import { toolCallReadOnlyOnRequestInput } from "./fixtures/tool_call_read_only_on_request/input.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { makeReplayServerConfig } from "./ReplayServerConfig.ts";

const SCENARIO = "detached_codex_adoption";
const APPROVAL_METHOD = "item/commandExecution/requestApproval";
const TRANSCRIPT = NodeURL.fileURLToPath(
  new URL("./fixtures/tool_call_read_only_on_request/codex_transcript.ndjson", import.meta.url),
);
const PEER = NodeURL.fileURLToPath(
  new URL("../../sessionHost/testFixtures/codexTranscriptPeer.mjs", import.meta.url),
);
/** The recorded approval's request id; the second thread's ids are shifted by the offset. */
const RECORDED_APPROVAL_ID = 0;
const SECOND_THREAD_ID_OFFSET = 100;
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

interface PeerLogRecord {
  readonly kind: "started" | "received" | "unexpected";
  readonly pid?: number;
  readonly controlPort?: number;
  readonly method?: string | null;
  readonly id?: string | number | null;
}

const readPeerLog = (logPath: string): ReadonlyArray<PeerLogRecord> =>
  NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PeerLogRecord);

const readTranscriptLines = (): ReadonlyArray<string> =>
  NodeFS.readFileSync(TRANSCRIPT, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

/** The recorded turn, and the same turn on a second thread whose native and JSON-RPC ids differ. */
const twoThreadLines = () => {
  const lines = readTranscriptLines();
  const second = lines.map((line) =>
    line
      .replaceAll(/01a0d604|02c3fc6e|0cdfbd98/g, "0b0b0b0b")
      .replaceAll(
        /"(id|requestId)":(\d+)/g,
        (_match, key: string, id: string) => `"${key}":${Number(id) + SECOND_THREAD_ID_OFFSET}`,
      ),
  );
  return {
    lines,
    second,
    threadStart: lines.findIndex((line) => line.includes('"method":"initialized"')) + 1,
    approval: lines.findIndex((line) => line.includes(`"method":"${APPROVAL_METHOD}"`)),
  };
};

/** Both turns reach the approval, then each finishes in order. */
const twoThreadTranscript = () => {
  const { lines, second, threadStart, approval } = twoThreadLines();
  return [
    ...lines.slice(0, approval),
    ...second.slice(threadStart, approval),
    ...lines.slice(approval),
    ...second.slice(approval),
  ];
};

/**
 * Both turns ask for approval. Once the first is answered Codex pauses, so the update finds both
 * running and the second still waiting; after "continue" the first finishes, then the second.
 */
const answeredBeforeUpdateTranscript = () => {
  const { lines, second, threadStart, approval } = twoThreadLines();
  return [
    ...lines.slice(0, approval),
    ...second.slice(threadStart, approval),
    lines[approval]!,
    second[approval]!,
    lines[approval + 1]!,
    JSON.stringify({ type: "pause" }),
    ...lines.slice(approval + 2),
    ...second.slice(approval + 1),
  ];
};

/** Lets the paused peer write its held frames and resolves once they are out. */
const continuePeer = (controlPort: number) =>
  Effect.callback<void, Error>((resume) => {
    const socket = NodeNet.connect(controlPort, "127.0.0.1", () => socket.write("continue\n"));
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      if (String(data).includes("done")) resume(Effect.void);
    });
    socket.on("error", (cause) => resume(Effect.fail(cause)));
    return Effect.sync(() => socket.destroy());
  });

/** A real broker and a fake Codex app server that every server built by `serverLayer` shares. */
const setUpAdoption = (transcriptLines: ReadonlyArray<string>) => {
  // A short base path keeps the broker's socket path within the platform limit.
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-"));
  const peerLog = NodePath.join(tempDir, "peer.ndjson");
  const transcript = NodePath.join(tempDir, "codex_transcript.ndjson");
  NodeFS.writeFileSync(transcript, `${transcriptLines.join("\n")}\n`);
  const wrapper = NodePath.join(tempDir, "codex");
  // The adapter passes app-server arguments; the fake ignores them.
  NodeFS.writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `exec '${process.execPath}' '${PEER}' '${transcript}' '${peerLog}' '${APPROVAL_METHOD}'`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  NodeFS.mkdirSync(NodePath.join(tempDir, "codex-home"));
  const settings = decodeCodexSettings({
    binaryPath: wrapper,
    homePath: NodePath.join(tempDir, "codex-home"),
  });

  const databaseLayer = SqlitePersistence.layerFromPath(
    NodePath.join(tempDir, "state.sqlite"),
  ).pipe(Layer.provide(NodeServices.layer));
  // Both servers find the broker through the same state directory and secret store.
  const sessionHostLayer = SessionHostService.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(Layer.merge(ServerConfig.layerTest(tempDir, tempDir), databaseLayer)),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const registryLayer = ProviderAdapterRegistry.layerFromAdaptersEffect(
    CodexAdapterV2.createCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment: [],
      enabled: true,
      config: settings,
    }).pipe(Effect.map((adapter) => [adapter])),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        CodexAdapterV2.layerAppServerClientFactory.pipe(
          Layer.provide(sessionHostLayer),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
        Layer.effect(
          ServerConfig.ServerConfig,
          makeReplayServerConfig(SCENARIO).pipe(Effect.orDie),
        ),
        IdAllocator.layer,
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PortScanner.PortDiscovery)({
          trackAgent: () => () => undefined,
          watchAgentCommandStops: () => Effect.void,
        }),
      ),
    ),
  );
  const scenario = {
    name: SCENARIO,
    runtimePolicyOverride: { ...READ_ONLY_ON_REQUEST_POLICY, cwd: tempDir },
  };
  const serverLayer = (options: { readonly recoverOnStartup: boolean }) =>
    Layer.mergeAll(
      ProviderReplayHarness.layerWithRegistry(scenario, registryLayer, {
        databaseLayer,
        continueThreadsAfterServerUpdate: true,
        ...options,
      }),
      sessionHostLayer,
    ).pipe(Layer.provideMerge(sessionHostLayer));
  const removeTempDir = Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }));
  return { peerLog, serverLayer, removeTempDir };
};

interface ApprovalThread {
  readonly threadId: ThreadId;
  readonly startCommands: ReadonlyArray<OrchestrationV2Command>;
  readonly approve: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>;
}

/** A thread running the approval fixture, with the answer it gives after the update. */
const materializeApprovalThread = Effect.fn("DetachedCodexAdoptionTest.materializeApprovalThread")(
  function* (scenario: string) {
    const materialized = yield* materializeFixtureInput({
      scenario,
      fixtureInput: toolCallReadOnlyOnRequestInput(),
      driver: ProviderDriverKind.make("codex"),
      modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-6-sol" },
    });
    const threadId = materialized.projectionThreadIds[0];
    const approve = materialized.commands.find(
      (command) => command.type === "runtime-request.respond",
    );
    if (threadId === undefined || approve?.type !== "runtime-request.respond") {
      return yield* Effect.die("the approval fixture has no thread or approval");
    }
    return {
      threadId,
      approve,
      startCommands: materialized.commands.filter((command) => command !== approve),
    } satisfies ApprovalThread;
  },
);

/** Starts the thread's turn and waits until Codex runs its command. */
const startApprovalTurn = Effect.fn("DetachedCodexAdoptionTest.startApprovalTurn")(function* (
  thread: ApprovalThread,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (const command of thread.startCommands) yield* orchestrator.dispatch(command);
  yield* orchestrator
    .streamStoredEventsFrom({ threadId: thread.threadId, eventType: "turn-item.updated" })
    .pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "turn-item.updated" && event.payload.type === "command_execution",
      ),
      Stream.runHead,
    );
});

/** As the server's shutdown does: the process is kept once its output is persisted. */
const shutDownForUpdate = Effect.fn("DetachedCodexAdoptionTest.shutDownForUpdate")(function* (
  threads: ReadonlyArray<ApprovalThread>,
) {
  const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const detached = yield* recovery.detachForUpdate(providerSessions.prepareDetachForUpdate);
  assert.deepEqual(
    detached.map((host) => host.threadIds.toSorted()),
    [threads.map((thread) => thread.threadId).toSorted()],
    "One kept process serves every thread",
  );
  const shutdown = yield* recovery.reconcile("shutdown");
  assert.equal(shutdown.terminalizedRuns, 0);
  return yield* Effect.forEach(threads, (thread) =>
    Effect.gen(function* () {
      const projection = yield* orchestrator.getThreadProjection(thread.threadId);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["running"],
      );
      return projection.runs[0]!.id;
    }),
  );
});

/** The first approval the thread's run asked for that is still pending. */
const awaitPendingApproval = Effect.fn("DetachedCodexAdoptionTest.awaitPendingApproval")(function* (
  thread: ApprovalThread,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const pending = yield* orchestrator
    .streamStoredEventsFrom({ threadId: thread.threadId, eventType: "runtime-request.updated" })
    .pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "runtime-request.updated" && event.payload.status === "pending",
      ),
      Stream.runHead,
    );
  const request = Option.getOrUndefined(pending)?.event;
  if (request?.type !== "runtime-request.updated") {
    return yield* Effect.die("no pending approval was found");
  }
  return request.payload.id;
});

/** Answers the approval the taken-over run asks for, waits for the run to end, and checks it. */
const approveAndFinish = Effect.fn("DetachedCodexAdoptionTest.approveAndFinish")(function* (
  thread: ApprovalThread,
  runId: RunId,
  requestId?: RuntimeRequestId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    ...thread.approve,
    requestId: requestId ?? (yield* awaitPendingApproval(thread)),
  });
  yield* awaitFinished(thread, runId);
});

/** Waits for the run to end and checks it completed without a continuation prompt. */
const awaitFinished = Effect.fn("DetachedCodexAdoptionTest.awaitFinished")(function* (
  thread: ApprovalThread,
  runId: RunId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator
    .streamStoredEventsFrom({ threadId: thread.threadId, eventType: "run.updated" })
    .pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.runId === runId &&
          (event.payload.status === "completed" || event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
  const projection = yield* orchestrator.getThreadProjection(thread.threadId);
  assert.deepEqual(
    projection.runs.map((run) => ({ id: run.id, status: run.status })),
    [{ id: runId, status: "completed" }],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    [TOOL_CALL_WRITE_PROMPT],
    "The new server sent no continuation prompt",
  );
  assert.isTrue(
    projection.turnItems.some((item) => item.type === "assistant_message" && item.runId === runId),
  );
});

/** Takes the kept process over on a new server, answers each approval in order, and checks it. */
const takeOverAndFinish = (input: {
  readonly peerLog: string;
  readonly serverLayer: ReturnType<typeof setUpAdoption>["serverLayer"];
  readonly threads: ReadonlyArray<ApprovalThread>;
  readonly runIds: ReadonlyArray<RunId>;
}) =>
  Effect.gen(function* () {
    // Codex asks for approval while no server is attached.
    const started = readPeerLog(input.peerLog).find((record) => record.kind === "started");
    assert.isDefined(started?.controlPort);
    assert.isDefined(started?.pid);
    yield* continuePeer(started!.controlPort!);

    // The new server takes the process over and the same runs finish.
    yield* Effect.scoped(
      Effect.forEach(
        input.threads,
        (thread, index) => approveAndFinish(thread, input.runIds[index]!),
        { discard: true },
      ).pipe(Effect.provide(input.serverLayer({ recoverOnStartup: true }))),
    );
    assertPeerSawOneServerAnswerEach(input.peerLog, input.threads.length);
    // The adopted process finishes its turns, then ends with the server that took it over.
    assert.isFalse(isProcessAlive(started!.pid!));
  });

/** One initialize, a start per thread, no resume, and every approval answered exactly once. */
const assertPeerSawOneServerAnswerEach = (peerLog: string, threadCount: number) => {
  const log = readPeerLog(peerLog);
  assert.deepEqual(
    log.filter((record) => record.kind === "unexpected"),
    [],
  );
  const methods = log.flatMap((record) =>
    record.kind === "received" && record.method !== null ? [record.method] : [],
  );
  const count = (method: string) => methods.filter((candidate) => candidate === method).length;
  assert.equal(count("initialize"), 1);
  assert.equal(count("thread/start"), threadCount);
  assert.equal(count("turn/start"), threadCount);
  assert.notInclude(methods, "thread/resume");
  assert.deepEqual(
    log.flatMap((record) =>
      record.kind === "received" && record.method === null ? [record.id] : [],
    ),
    Array.from(
      { length: threadCount },
      (_unused, index) => RECORDED_APPROVAL_ID + index * SECOND_THREAD_ID_OFFSET,
    ),
    "Each approval Codex asked was answered once",
  );
};

describe.skipIf(isWindowsHost)("a Codex turn running across a planned update", () => {
  it.live(
    "is taken over by the new server, which answers the approval asked while it was down",
    () => {
      const { peerLog, serverLayer, removeTempDir } = setUpAdoption(readTranscriptLines());
      return Effect.gen(function* () {
        const thread = yield* materializeApprovalThread(SCENARIO);
        // Server 1 starts the turn and is replaced while Codex runs the command.
        const runIds = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* startApprovalTurn(thread);
            return yield* shutDownForUpdate([thread]);
          }).pipe(Effect.provide(serverLayer({ recoverOnStartup: false }))),
        );
        yield* takeOverAndFinish({ peerLog, serverLayer, threads: [thread], runIds });
      }).pipe(
        Effect.ensuring(removeTempDir),
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      );
    },
  );

  it.live("is taken over with another thread's turn that shares its app server", () => {
    const { peerLog, serverLayer, removeTempDir } = setUpAdoption(twoThreadTranscript());
    return Effect.gen(function* () {
      const threads = [
        yield* materializeApprovalThread(`${SCENARIO}_first`),
        yield* materializeApprovalThread(`${SCENARIO}_second`),
      ];
      // Server 1 starts both turns on one app server and is replaced while both run commands.
      const runIds = yield* Effect.scoped(
        Effect.gen(function* () {
          for (const thread of threads) yield* startApprovalTurn(thread);
          return yield* shutDownForUpdate(threads);
        }).pipe(Effect.provide(serverLayer({ recoverOnStartup: false }))),
      );
      yield* takeOverAndFinish({ peerLog, serverLayer, threads, runIds });
    }).pipe(
      Effect.ensuring(removeTempDir),
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    );
  });

  it.live("delivers an answer given just before the update, and both shared runs finish", () => {
    const { peerLog, serverLayer, removeTempDir } = setUpAdoption(answeredBeforeUpdateTranscript());
    return Effect.gen(function* () {
      const [answered, waiting] = [
        yield* materializeApprovalThread(`${SCENARIO}_answered`),
        yield* materializeApprovalThread(`${SCENARIO}_waiting`),
      ];
      const { runIds, waitingRequestId } = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          for (const thread of [answered, waiting]) yield* startApprovalTurn(thread);
          const controlPort = readPeerLog(peerLog).find(
            (record) => record.kind === "started",
          )?.controlPort;
          assert.isDefined(controlPort);
          yield* continuePeer(controlPort!);
          const answeredRequestId = yield* awaitPendingApproval(answered);
          const waitingRequestId = yield* awaitPendingApproval(waiting);
          // The update starts while the answer is still queued for delivery.
          yield* orchestrator.dispatch({ ...answered.approve, requestId: answeredRequestId });
          const runIds = yield* shutDownForUpdate([answered, waiting]);
          return { runIds, waitingRequestId };
        }).pipe(Effect.provide(serverLayer({ recoverOnStartup: false }))),
      );
      const peer = readPeerLog(peerLog).find((record) => record.kind === "started");
      assert.isTrue(
        readPeerLog(peerLog).some(
          (record) =>
            record.kind === "received" &&
            record.method === null &&
            record.id === RECORDED_APPROVAL_ID,
        ),
        "The answer reached Codex before the old server let go of it",
      );
      // The answered turn finishes while no server is attached.
      yield* continuePeer(peer!.controlPort!);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* awaitFinished(answered, runIds[0]!);
          // Codex asks the waiting approval again; the id stored before the update still answers it.
          yield* approveAndFinish(waiting, runIds[1]!, waitingRequestId);
        }).pipe(Effect.provide(serverLayer({ recoverOnStartup: true }))),
      );
      assertPeerSawOneServerAnswerEach(peerLog, 2);
      assert.isFalse(isProcessAlive(peer!.pid!));
    }).pipe(
      Effect.ensuring(removeTempDir),
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    );
  });
});
