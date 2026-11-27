// @effect-diagnostics nodeBuiltinImport:off -- Drives a real __session-host broker and a fake Codex app server across two server instances.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import * as SessionHostService from "../../sessionHost/SessionHostService.ts";
import * as CodexAdapterV2 from "../Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
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

describe.skipIf(isWindowsHost)("a Codex turn running across a planned update", () => {
  it.live(
    "is taken over by the new server, which answers the approval asked while it was down",
    () => {
      // A short base path keeps the broker's socket path within the platform limit.
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-adopt-"));
      const peerLog = NodePath.join(tempDir, "peer.ndjson");
      const wrapper = NodePath.join(tempDir, "codex");
      // The adapter passes app-server arguments; the fake ignores them.
      NodeFS.writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          `exec '${process.execPath}' '${PEER}' '${TRANSCRIPT}' '${peerLog}' '${APPROVAL_METHOD}'`,
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
        Layer.provide(Layer.merge(ServerConfig.layerTest(tempDir, tempDir), databaseLayer)),
        Layer.provide(NodeServices.layer),
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
        Layer.provide(NodeServices.layer),
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

      return Effect.gen(function* () {
        const materialized = yield* materializeFixtureInput({
          scenario: SCENARIO,
          fixtureInput: toolCallReadOnlyOnRequestInput(),
          driver: ProviderDriverKind.make("codex"),
          modelSelection: { ...CODEX_MODEL_SELECTION, model: "gpt-6-sol" },
        });
        const threadId = materialized.projectionThreadIds[0];
        const approve = materialized.commands.find(
          (command) => command.type === "runtime-request.respond",
        );
        if (threadId === undefined || approve === undefined) {
          return yield* Effect.die("the approval fixture has no thread or approval");
        }

        // Server 1 starts the turn and is replaced while Codex runs the command.
        const runId = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            for (const command of materialized.commands) {
              if (command.type === "runtime-request.respond") continue;
              yield* orchestrator.dispatch(command);
            }
            yield* orchestrator
              .streamStoredEventsFrom({ threadId, eventType: "turn-item.updated" })
              .pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "turn-item.updated" &&
                    event.payload.type === "command_execution",
                ),
                Stream.runHead,
              );
            const sessionHost = yield* SessionHostService.SessionHostService;
            const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
            const detached = yield* sessionHost.detachAllForUpdate();
            assert.deepEqual(
              detached.map((host) => host.threadId),
              [threadId],
            );
            const shutdown = yield* recovery.reconcile("shutdown");
            assert.equal(shutdown.terminalizedRuns, 0);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              projection.runs.map((run) => run.status),
              ["running"],
            );
            return projection.runs[0]!.id;
          }).pipe(Effect.provide(serverLayer({ recoverOnStartup: false }))),
        );

        // Codex asks for approval while no server is attached.
        const started = readPeerLog(peerLog).find((record) => record.kind === "started");
        assert.isDefined(started?.controlPort);
        assert.isDefined(started?.pid);
        yield* continuePeer(started!.controlPort!);

        // Server 2 takes the process over, answers the approval, and the same run finishes.
        const projection = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const pending = yield* orchestrator
              .streamStoredEventsFrom({ threadId, eventType: "runtime-request.updated" })
              .pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "runtime-request.updated" && event.payload.status === "pending",
                ),
                Stream.runHead,
              );
            const request = Option.getOrUndefined(pending)?.event;
            if (request?.type !== "runtime-request.updated") {
              return yield* Effect.die("the new server found no pending approval");
            }
            yield* orchestrator.dispatch({ ...approve, requestId: request.payload.id });
            yield* orchestrator.streamStoredEventsFrom({ threadId, eventType: "run.updated" }).pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.runId === runId &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            return yield* orchestrator.getThreadProjection(threadId);
          }).pipe(Effect.provide(serverLayer({ recoverOnStartup: true }))),
        );

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
          projection.turnItems.some(
            (item) => item.type === "assistant_message" && item.runId === runId,
          ),
        );

        const log = readPeerLog(peerLog);
        const methods = log.flatMap((record) =>
          record.kind === "received" && record.method !== null ? [record.method] : [],
        );
        assert.deepEqual(
          log.filter((record) => record.kind === "unexpected"),
          [],
        );
        assert.equal(methods.filter((method) => method === "initialize").length, 1);
        assert.equal(methods.filter((method) => method === "thread/start").length, 1);
        assert.notInclude(methods, "thread/resume");
        assert.equal(methods.filter((method) => method === "turn/start").length, 1);
        assert.isTrue(
          log.some(
            (record) => record.kind === "received" && record.method === null && record.id === 0,
          ),
          "The approval Codex asked while the server was down was answered",
        );
        // The adopted process finishes its turn, then ends with the server that took it over.
        assert.isFalse(isProcessAlive(started!.pid!));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      );
    },
  );
});
