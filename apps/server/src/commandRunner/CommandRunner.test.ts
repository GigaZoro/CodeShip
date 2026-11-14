// @effect-diagnostics nodeBuiltinImport:off - The commands under test are real processes, watched through the files they leave.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { seedLiveParent } from "../orchestration-v2/testkit/LiveParentThread.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as CommandRunner from "./CommandRunner.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("A command needs no provider process"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Every parent wake the orchestrator offers, in order. */
class Offers extends Context.Service<
  Offers,
  Queue.Queue<ProviderContinuationRequests.ProviderContinuationRequest>
>()("t3/commandRunner/CommandRunner.test/Offers") {}
const layerOffers = Layer.effect(
  Offers,
  Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>(),
);
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "command-runner" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.effect(
      ProviderContinuationRequests.ProviderContinuationRequests,
      Offers.pipe(
        Effect.map((offers) => ({
          offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
            Queue.offer(offers, request).pipe(Effect.asVoid),
          take: Effect.never,
        })),
      ),
    ),
  ),
  Layer.provideMerge(layerOffers),
);
const layerThreads = Layer.unwrap(
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: orchestrator.dispatch,
      getThreadRecords: orchestrator.getThreadRecords,
      streamDomainEvents: orchestrator.streamDomainEvents,
    }),
  ),
);
const layerTest = Layer.mergeAll(
  layerThreads,
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-runner-" }),
  NodeCrypto.layer,
).pipe(Layer.provideMerge(layerOrchestration), Layer.provideMerge(NodeServices.layer));

/** One server's life: a fresh runner that picks up what an earlier one left, until `use` ends. */
const withServer = <A, E, R>(
  use: (runner: CommandRunner.CommandRunner["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner.CommandRunner;
    yield* runner.start();
    return yield* use(runner);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.fresh(CommandRunner.layer)),
    Effect.provideService(CommandRunner.WatchInterval, Duration.millis(50)),
  );

const callerOf = (threadId: ThreadId): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:command-runner"),
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "provider-session:command-runner",
  thread: {
    threadId,
    providerSessionId: "provider-session:command-runner",
    providerInstanceId: instanceId,
  },
  client: undefined,
});

/** Resolves once `file` exists. Its folder is watched before the first look, so none is missed. */
const awaitFile = (file: string) =>
  Effect.callback<void>((resume) => {
    let done = false;
    const finish = () => {
      if (done || !NodeFS.existsSync(file)) return;
      done = true;
      watcher.close();
      resume(Effect.void);
    };
    const watcher = NodeFS.watch(NodePath.dirname(file), finish);
    finish();
    return Effect.sync(() => watcher.close());
  });

/** The next wake offered to `threadId`. */
const nextWake = (threadId: ThreadId) =>
  Offers.pipe(
    Effect.flatMap((offers) =>
      Queue.take(offers).pipe(Effect.repeat({ until: (request) => request.threadId === threadId })),
    ),
  );

const commandRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string; readonly delivered_at: string | null }>`
      SELECT status, delivered_at FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

const taskOf = (threadId: ThreadId, taskId: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(threadId)),
    Effect.map((projection) => projection.subagents.find((task) => task.id === taskId)),
  );

/** A chat whose run is live, in its own folder, whose commands are stopped when the test ends. */
const liveChat = (name: string) =>
  Effect.gen(function* () {
    const workspace = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${name}-`)),
    );
    const parent = yield* seedLiveParent({ name, driver, modelSelection, worktreePath: workspace });
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.addFinalizer(() =>
      sql<{ readonly pid: number }>`
        SELECT pid FROM command_runs WHERE thread_id = ${parent.threadId}
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ pid }) =>
            Effect.try(() => signalProcessGroup(pid, "SIGKILL")).pipe(Effect.ignore),
          ),
        ),
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => NodeFS.rmSync(workspace, { recursive: true, force: true })),
        ),
      ),
    );
    return { ...parent, workspace };
  });

// Real processes and the real clock: the runner watches commands on a wall-clock interval.
it.layer(layerTest, { excludeTestServices: true })("a command run apart from its agent", (it) => {
  it.effect("keeps running through a restart and wakes its chat once with its end", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-survives");
      const started = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "until [ -e go ]; do sleep 0.05; done; echo checked; exit 3",
          label: "Checks",
        }),
      );
      // The first server is gone; the command still waits for its go.
      const wake = yield* withServer(() =>
        Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")).pipe(
          Effect.andThen(nextWake(chat.threadId)),
        ),
      );
      assert.equal(wake.threadId, chat.threadId);
      const task = yield* taskOf(chat.threadId, started.taskId);
      assert.equal(task?.status, "failed");
      assert.match(task?.result ?? "", /^Exited with code 3 after .+\.\nLast output:\nchecked\n/);
      assert.include(task?.result ?? "", `Full output: ${started.logPath}`);
      // A later server, even one that starts before the end was marked delivered, wakes the chat
      // for nothing but the next command's end.
      const next = yield* withServer((runner) =>
        runner
          .run(callerOf(chat.threadId), { command: "echo second" })
          .pipe(Effect.tap(() => nextWake(chat.threadId))),
      );
      assert.equal((yield* taskOf(chat.threadId, next.taskId))?.status, "completed");
      const row = yield* commandRow(started.taskId);
      assert.equal(row?.status, "exited");
      assert.isNotNull(row?.delivered_at);
    }),
  );

  it.effect("delivers an end that came while no server was running, once one starts", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-ends-while-down");
      const started = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "until [ -e go ]; do sleep 0.05; done; echo built",
        }),
      );
      NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
      yield* awaitFile(NodePath.join(NodePath.dirname(started.logPath), "exit-status"));
      yield* withServer(() => nextWake(chat.threadId));
      const task = yield* taskOf(chat.threadId, started.taskId);
      assert.equal(task?.status, "completed");
      assert.match(task?.result ?? "", /^Exited with code 0 after .+\.\nLast output:\nbuilt\n/);
    }),
  );

  it.effect("reports a command that vanished without its exit status as lost", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-lost");
      // Killing its wrapper, as a reboot would, leaves no exit status.
      const started = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "until [ -e go ]; do sleep 0.05; done; kill -9 $PPID; echo > killed",
        }),
      );
      NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
      yield* awaitFile(NodePath.join(chat.workspace, "killed"));
      yield* withServer(() => nextWake(chat.threadId));
      const task = yield* taskOf(chat.threadId, started.taskId);
      assert.equal(task?.status, "failed");
      assert.match(task?.result ?? "", /without an exit status/);
      assert.equal((yield* commandRow(started.taskId))?.status, "lost");
    }),
  );

  it.effect("stops everything the command started when its task is cancelled", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-cancelled");
      yield* withServer((runner) =>
        Effect.gen(function* () {
          // A grandchild that notes the stop signal, so the test sees the whole tree got it.
          const started = yield* runner.run(callerOf(chat.threadId), {
            command: `sh -c 'trap "echo > stopped; exit 0" TERM; echo > ready; while :; do sleep 1; done' & wait`,
          });
          yield* awaitFile(NodePath.join(chat.workspace, "ready"));
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          // What task_cancel records for a command.
          yield* orchestrator.dispatch({
            type: "delegated_task.command.complete",
            commandId: CommandId.make("command:cancel:command-cancelled"),
            parentThreadId: chat.threadId,
            taskId: NodeId.make(started.taskId),
            status: "cancelled",
            result: "Cancelled.",
          });
          yield* awaitFile(NodePath.join(chat.workspace, "stopped"));
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "stopped");
        }),
      );
    }),
  );
});
