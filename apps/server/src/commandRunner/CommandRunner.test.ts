// @effect-diagnostics nodeBuiltinImport:off - The commands under test are real processes, watched through the files they leave.
import * as NodeChildProcess from "node:child_process";
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
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CommandRunner from "./CommandRunner.ts";

class ProcessCleanupError extends Schema.TaggedError<ProcessCleanupError>()("ProcessCleanupError", {
  cause: Schema.Defect(),
}) {}

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
/** The calling thread's provider, whose own settings give its shell commands these variables. */
const providerShell = (shellEnvironment?: ProviderInstance["shellEnvironment"]) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (id) =>
      Effect.succeed(
        id === instanceId
          ? ({
              instanceId,
              enabled: true,
              ...(shellEnvironment === undefined ? {} : { shellEnvironment }),
            } as ProviderInstance)
          : undefined,
      ),
  });
const layerTest = Layer.mergeAll(
  layerThreads,
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  providerShell(),
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
    const rows = yield* sql<{
      readonly status: string;
      readonly pid: number | null;
      readonly started_at: string;
      readonly delivered_at: string | null;
    }>`
      SELECT status, pid, started_at, delivered_at FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

/** What the record holds when its server stops between starting it and recording the pid. */
const forgetPid = (taskId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE command_runs SET pid = NULL, process_started_at = NULL WHERE task_id = ${taskId}
    `,
  );

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
      sql<{ readonly pid: number | null; readonly directory: string }>`
        SELECT pid, directory FROM command_runs WHERE thread_id = ${parent.threadId}
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Effect.try({
              try: () =>
                signalProcessGroup(
                  // A failed test can leave a row without its pid; the wrapper's pid file still names it.
                  row.pid ??
                    Number.parseInt(
                      NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8"),
                      10,
                    ),
                  "SIGKILL",
                ),
              catch: (cause) => new ProcessCleanupError({ cause }),
            }).pipe(Effect.ignore),
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

const deletionOf = (threadId: ThreadId) =>
  ({
    type: "thread.delete",
    commandId: CommandId.make(`command:delete:${threadId}`),
    threadId,
  }) as const;

/** What task_cancel records for a command. */
const cancellationOf = (threadId: ThreadId, taskId: string) =>
  ({
    type: "delegated_task.command.complete",
    commandId: CommandId.make(`command:cancel:${taskId}`),
    parentThreadId: threadId,
    taskId: NodeId.make(taskId),
    status: "cancelled",
    result: "Cancelled.",
  }) as const;

/** Starts a child that writes `ready` once it can note a stop signal, and `stopped` on one. */
const STOP_NOTING_CHILD = `sh -c 'trap "echo > stopped; exit 0" TERM; echo > ready; while :; do sleep 1; done' &`;
/** Once `go` exists it kills its wrapper, leaving no exit status, then writes `orphaned`. */
const ORPHANING_COMMAND = `${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; kill -9 $PPID; echo > orphaned; wait`;

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
      const statusFile = NodePath.join(NodePath.dirname(started.logPath), "exit-status");
      yield* awaitFile(statusFile);
      // The status file is written as it ends, so its time is the end, not the next server's start.
      const startedAt = Date.parse((yield* commandRow(started.taskId))!.started_at);
      const endedAtSeconds = (startedAt + 42_000) / 1000;
      NodeFS.utimesSync(statusFile, endedAtSeconds, endedAtSeconds);
      yield* withServer(() => nextWake(chat.threadId));
      const task = yield* taskOf(chat.threadId, started.taskId);
      assert.equal(task?.status, "completed");
      assert.match(task?.result ?? "", /^Exited with code 0 after 42s\.\nLast output:\nbuilt\n/);
    }),
  );

  it.effect("adopts a command whose server stopped before it recorded the pid", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-pid-unrecorded");
      const started = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "until [ -e go ]; do sleep 0.05; done; echo adopted",
        }),
      );
      // Its wrapper names itself at once; a restart takes far longer.
      yield* awaitFile(NodePath.join(NodePath.dirname(started.logPath), "pid"));
      yield* forgetPid(started.taskId);
      yield* withServer(() =>
        Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")).pipe(
          Effect.andThen(nextWake(chat.threadId)),
        ),
      );
      const task = yield* taskOf(chat.threadId, started.taskId);
      assert.match(task?.result ?? "", /^Exited with code 0 after .+\.\nLast output:\nadopted\n/);
      assert.isNotNull((yield* commandRow(started.taskId))?.pid);
    }),
  );

  it.effect("keeps the end of a log that grew too large, after a note that it was cut", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-log-trimmed");
      const started = yield* withServer((runner) =>
        runner
          .run(callerOf(chat.threadId), {
            command: "head -c 9000000 /dev/zero | tr '\\0' x; echo; echo last-line",
          })
          .pipe(Effect.tap(() => nextWake(chat.threadId))),
      );
      const log = NodeFS.readFileSync(started.logPath, "utf8");
      assert.match(
        log,
        /^\[CodeShip removed earlier output to keep this log small\]\nx+\nlast-line\n$/,
      );
      assert.isBelow(log.length, 8 * 1024 * 1024);
    }),
  );

  it.effect.each([
    ["/t3-agent-tools", true, "command-agent-shell"],
    ["", true, "command-agent-shell-empty-path"],
    ["/t3-agent-tools", false, "command-agent-shell-no-host-path"],
    ["", false, "command-agent-shell-empty-path-no-host-path"],
  ] as const)(
    "gives a command what its agent's own shell commands get, shell options only to the command, PATH %j, host PATH %s",
    ([PATH, hostHasPath, name]) =>
      Effect.gen(function* () {
        const { PATH: _hostPath, ...hostWithoutPath } = process.env;
        const chat = yield* liveChat(name);
        NodeFS.mkdirSync(NodePath.join(chat.workspace, "sub"));
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), {
              command:
                'printf "%s %s %s %s\\n%s\\n%s\\n" "$AGENT_SETTING" "$T3CODE_THREAD_ID" "$HOST_KEPT" "${HOST_REMOVED-removed}" "$PATH" "$SHELLOPTS"; exit 7',
              cwd: "sub",
            })
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provide(
            providerShell((cwd, { HOST_REMOVED: _removed, ...inherited }) =>
              // A PATH without the wrapper's own tools, which it still needs to record the end.
              // sh reads no startup files that could add to it.
              Effect.succeed({
                ...inherited,
                AGENT_SETTING: `set for ${cwd}`,
                PATH,
                SHELL: "/bin/sh",
                // bash as /bin/sh takes this as its own option; dash ignores it.
                SHELLOPTS: "errexit",
              }),
            ),
          ),
          Effect.provideService(HostProcess.Environment, {
            ...(hostHasPath ? process.env : hostWithoutPath),
            HOST_KEPT: "kept",
            HOST_REMOVED: "host",
          }),
        );
        const [seen, commandPath, shellOptions] = NodeFS.readFileSync(
          started.logPath,
          "utf8",
        ).split("\n");
        // Read for the chat's folder, as the agent's own settings were, though it ran below it.
        assert.equal(seen, `set for ${chat.workspace} ${chat.threadId} kept removed`);
        assert.equal(commandPath, PATH);
        assert.match(shellOptions ?? "", /errexit/);
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "failed");
        assert.match(task?.result ?? "", /^Exited with code 7 after /);
      }),
  );

  it.effect(
    "gives a Windows command the host environment under its agent's in Unicode, each name once, its ERRORLEVEL past cmd, writing no value and reading none to start",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-environment");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const refused = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "Write-Output started" }),
        ).pipe(
          Effect.flip,
          Effect.provide(
            // Spellings Windows reads as one name; the later one is the value the agent's own get.
            providerShell(
              (_cwd, { HOST_REMOVED: _removed, SystemRoot: _systemRoot, ...inherited }) =>
                Effect.succeed({
                  ...inherited,
                  PATH: "C:\\agent",
                  AGENT_SETTING: "from user settings",
                  agent_setting: "from settings",
                  // Defined, it would be the exit status cmd records whatever the command returns.
                  ErrorLevel: "0",
                }),
            ),
          ),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              !input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))
                ? processRunner.run(input)
                : Deferred.succeed(launcher, input).pipe(
                    Effect.as({
                      stdout: "",
                      stderr: "Win32_Process.Create returned 9",
                      code: ChildProcessSpawner.ExitCode(1),
                      timedOut: false,
                      stdoutTruncated: false,
                      stderrTruncated: false,
                      stdoutInvalidUtf8: false,
                      stderrInvalidUtf8: false,
                    }),
                  ),
          }),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, {
            Path: "C:\\host",
            HOST_ONLY: "kept",
            HOST_REMOVED: "removed by its settings",
            SystemRoot: "C:\\Windows",
            T3CODE_AUTH_TOKEN: "server only",
          }),
        );
        assert.include(refused.message, "Win32_Process.Create returned 9");
        const launch = yield* Deferred.await(launcher);
        assert.deepEqual(
          Buffer.from(launch.stdin ?? "", "base64")
            .toString("utf8")
            .split("\0")
            .toSorted(),
          [
            "HOST_ONLY=kept",
            "PATH=C:\\agent",
            "T3CODE_COMMAND_ERRORLEVEL=0",
            `T3CODE_THREAD_ID=${chat.threadId}`,
            "agent_setting=from settings",
          ],
        );
        const launcherScript = launch.args.join(" ");
        assert.include(launcherScript, "CreateFlags = [uint32]1024");
        assert.include(
          launcherScript,
          "HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
        );
        assert.include(
          launcherScript,
          "Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
        );
        const runPath = /""(.+run\.cmd)" "/.exec(launcherScript)?.[1] ?? "";
        // Its exit status is the only variable run.cmd reads, so no setting can move PowerShell.
        assert.deepEqual(NodeFS.readFileSync(runPath, "utf8").match(/%\w+%/g), ["%ERRORLEVEL%"]);
        const scriptPath = NodePath.join(NodePath.dirname(runPath), "command.ps1");
        assert.include(
          NodeFS.readFileSync(scriptPath, "utf8"),
          "[Environment]::SetEnvironmentVariable('ErrorLevel', $env:T3CODE_COMMAND_ERRORLEVEL); Remove-Item Env:T3CODE_COMMAND_ERRORLEVEL -ErrorAction Ignore",
        );
        for (const file of [runPath, scriptPath]) {
          assert.notInclude(NodeFS.readFileSync(file, "utf8"), "from settings");
        }
      }),
  );

  it.effect.each([
    [
      "its agent's shell environment cannot be read",
      "command-agent-shell-unreadable",
      providerShell(() =>
        Effect.fail(
          new ProviderDriverError({ driver, instanceId, detail: "settings.json is not JSON" }),
        ),
      ),
      "settings.json is not JSON",
    ],
    [
      "its agent's provider is no longer running",
      "command-agent-provider-gone",
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.undefined,
      }),
      "provider is turned off or not running",
    ],
    [
      // Its secrets were never resolved, so its shell environment would run the command without them.
      "its agent's provider is turned off",
      "command-agent-provider-off",
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed({ instanceId, enabled: false } as ProviderInstance),
      }),
      "provider is turned off",
    ],
  ] as const)("starts no command when %s", ([, name, providers, message]) =>
    Effect.gen(function* () {
      const chat = yield* liveChat(name);
      const failed = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "true" }),
      ).pipe(Effect.provide(providers), Effect.flip);
      assert.equal(failed.code, "provider_unavailable");
      assert.include(failed.message, message);
      const projection = yield* Orchestrator.OrchestratorV2.pipe(
        Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
      );
      assert.lengthOf(projection.subagents, 0);
    }),
  );

  it.effect.each([
    ["while no server runs", "command-lost", false, false],
    [
      "before its server recorded the pid, while no server runs",
      "command-lost-pid-unrecorded",
      false,
      true,
    ],
    ["while a server watches it", "command-lost-watched", true, false],
  ] as const)(
    "reports a command whose wrapper was killed %s as lost, and stops what it started",
    ([, name, watching, pidUnrecorded]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        // As a reboot would; what it started lives on.
        const request = { command: ORPHANING_COMMAND };
        const go = awaitFile(NodePath.join(chat.workspace, "ready")).pipe(
          Effect.andThen(
            Effect.sync(() => NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "")),
          ),
        );
        const started = watching
          ? yield* withServer((runner) =>
              runner
                .run(callerOf(chat.threadId), request)
                .pipe(Effect.tap(() => go.pipe(Effect.andThen(nextWake(chat.threadId))))),
            )
          : yield* withServer((runner) => runner.run(callerOf(chat.threadId), request)).pipe(
              Effect.tap(({ taskId }) =>
                go.pipe(
                  Effect.andThen(awaitFile(NodePath.join(chat.workspace, "orphaned"))),
                  Effect.andThen(pidUnrecorded ? forgetPid(taskId) : Effect.void),
                  Effect.andThen(withServer(() => nextWake(chat.threadId))),
                ),
              ),
            );
        const task = yield* taskOf(chat.threadId, started.taskId);
        assert.equal(task?.status, "failed");
        assert.match(task?.result ?? "", /without an exit status/);
        assert.equal((yield* commandRow(started.taskId))?.status, "lost");
        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
      }),
  );

  it.effect("watches a command whose request was cancelled while it started", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-request-cancelled");
      const agentScope = yield* AgentScope;
      const launching = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const ended = yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = yield* runner
            .run(callerOf(chat.threadId), {
              command: "until [ -e go ]; do sleep 0.05; done; echo watched",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(launching);
          // What a cancelled MCP call does to its handler.
          yield* Effect.forkChild(Fiber.interrupt(request), { startImmediately: true });
          yield* Deferred.succeed(proceed, undefined);
          yield* Fiber.await(request);
          const projection = yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
          );
          const task = projection.subagents.find((each) => each.command !== undefined);
          assert.isNotNull((yield* commandRow(task!.id))?.pid);
          NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
          yield* nextWake(chat.threadId);
          return yield* taskOf(chat.threadId, task!.id);
        }),
      ).pipe(
        Effect.provideService(AgentScope, {
          ...agentScope,
          wrap: (input) =>
            Deferred.succeed(launching, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(agentScope.wrap(input)),
            ),
        }),
      );
      assert.equal(ended?.status, "completed");
      assert.match(ended?.result ?? "", /Last output:\nwatched\n/);
    }),
  );

  it.effect.each([
    [
      "its chat was deleted",
      "command-chat-deleted-early",
      (threadId: ThreadId) => deletionOf(threadId),
      "Stopped: the chat was deleted.",
    ],
    [
      "its task was cancelled",
      "command-cancelled-early",
      (threadId: ThreadId, taskId: string) => cancellationOf(threadId, taskId),
      "Cancelled.",
    ],
  ] as const)(
    "never starts a command when %s while its request was recorded",
    ([, name, close, message]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const refused = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo started" }).pipe(Effect.flip),
        ).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            dispatch: (command) =>
              threads.dispatch(command).pipe(
                Effect.tap((recorded) => {
                  const task = recorded.storedEvents.find(
                    (stored) => stored.event.type === "subagent.updated",
                  )?.event;
                  return command.type === "delegated_task.command.request" &&
                    task?.type === "subagent.updated"
                    ? threads.dispatch(close(chat.threadId, task.payload.id))
                    : Effect.void;
                }),
              ),
          }),
        );
        assert.equal(refused.message, message);
        const sql = yield* SqlClient.SqlClient;
        const rows =
          yield* sql`SELECT task_id FROM command_runs WHERE thread_id = ${chat.threadId}`;
        assert.lengthOf(rows, 0);
      }),
  );

  it.effect("stops a command whose chat was deleted while it started", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-chat-deleted-late");
      const agentScope = yield* AgentScope;
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const starting = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      // Its first process lookup is the one that names the command it just started.
      let spawning = false;
      const started = yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = yield* runner
            .run(callerOf(chat.threadId), { command: `${STOP_NOTING_CHILD} wait` })
            .pipe(Effect.forkChild);
          yield* Deferred.await(starting);
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) => orchestrator.dispatch(deletionOf(chat.threadId))),
          );
          yield* Deferred.succeed(proceed, undefined);
          const result = yield* Fiber.join(request);
          yield* awaitFile(NodePath.join(chat.workspace, "stopped"));
          return result;
        }),
      ).pipe(
        Effect.provideService(AgentScope, {
          ...agentScope,
          wrap: (input) =>
            Effect.sync(() => {
              spawning = true;
            }).pipe(Effect.andThen(agentScope.wrap(input))),
        }),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (!spawning || input.command !== "ps") return processRunner.run(input);
            spawning = false;
            return awaitFile(NodePath.join(chat.workspace, "ready")).pipe(
              Effect.andThen(Deferred.succeed(starting, undefined)),
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(processRunner.run(input)),
            );
          },
        }),
      );
      assert.equal((yield* commandRow(started.taskId))?.status, "stopped");
    }),
  );

  it.effect("never starts a command for a retry of a request that could not start it", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-unstarted");
      const request = { command: "echo started", clientRequestId: "command-unstarted" };
      const unstartable = yield* AgentScope;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), request).pipe(Effect.flip),
      ).pipe(
        Effect.provideService(AgentScope, {
          ...unstartable,
          wrap: ({ args }) => Effect.succeed({ command: "/nonexistent/t3-shell", args }),
        }),
      );
      assert.match(first.message, /^Could not start the command: /);
      const retried = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), request).pipe(Effect.flip),
      );
      assert.equal(retried.message, first.message);
      const projection = yield* Orchestrator.OrchestratorV2.pipe(
        Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
      );
      const tasks = projection.subagents.filter((task) => task.command !== undefined);
      assert.deepEqual(
        tasks.map((task) => task.status),
        ["failed"],
      );
      assert.isUndefined(yield* commandRow(tasks[0]!.id));
    }),
  );

  it.effect("stops everything the command started when its task is cancelled", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("command-cancelled");
      yield* withServer((runner) =>
        Effect.gen(function* () {
          // A grandchild that notes the stop signal, so the test sees the whole tree got it.
          const started = yield* runner.run(callerOf(chat.threadId), {
            command: `${STOP_NOTING_CHILD} wait`,
          });
          yield* awaitFile(NodePath.join(chat.workspace, "ready"));
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          yield* awaitFile(NodePath.join(chat.workspace, "stopped"));
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "stopped");
        }),
      );
    }),
  );

  it.effect.each([
    ["its task is cancelled while no server runs", "command-cancelled-down", false, false],
    ["its server stopped before it finished stopping it", "command-stop-cut", true, false],
    [
      "its server stopped while stopping it, after its wrapper ended",
      "command-stop-orphaned",
      true,
      true,
    ],
  ] as const)("stops a command when %s, once a server starts", ([, name, cutStop, wrapperGone]) =>
    Effect.gen(function* () {
      const chat = yield* liveChat(name);
      const started = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
        }),
      );
      yield* awaitFile(NodePath.join(chat.workspace, "ready"));
      if (wrapperGone) {
        // Its wrapper ended, as it does on the stop signal, while what it started still runs.
        NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
        yield* awaitFile(NodePath.join(chat.workspace, "orphaned"));
      }
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
      if (cutStop) {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
            UPDATE command_runs SET status = 'stopped', ended_at = started_at
            WHERE task_id = ${started.taskId}
          `;
      }
      // A run waits until the server has adopted what the earlier one left.
      yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));
      assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
      const row = yield* commandRow(started.taskId);
      assert.equal(row?.status, "stopped");
      assert.isNotNull(row?.delivered_at);
    }),
  );

  it.effect.each([
    ["the group its ended wrapper's pid names", "command-rebooted-orphaned", true],
    ["a process of unknown start under its wrapper's pid", "command-rebooted-reused", false],
  ] as const)(
    "reports a command from before a reboot as lost and leaves alone %s",
    ([, name, wrapperGone]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: wrapperGone ? ORPHANING_COMMAND : `${STOP_NOTING_CHILD} wait`,
          }),
        );
        yield* awaitFile(NodePath.join(chat.workspace, "ready"));
        if (wrapperGone) {
          NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
          yield* awaitFile(NodePath.join(chat.workspace, "orphaned"));
        }
        const sql = yield* SqlClient.SqlClient;
        // Started before the machine last booted, so what its pid names now is someone else's.
        yield* sql`
          UPDATE command_runs SET started_at = '2000-01-01T00:00:00.000Z', process_started_at = NULL
          WHERE task_id = ${started.taskId}
        `;
        yield* withServer(() => nextWake(chat.threadId));
        assert.equal((yield* commandRow(started.taskId))?.status, "lost");
        assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
      }),
  );
});

/** Whether `pid` is still running once it has had a moment to end after being stopped. */
const stillRunning = (pid: number) =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Wait-Process -Id ${pid} -Timeout 10 -ErrorAction SilentlyContinue; if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
    ],
    { encoding: "utf8" },
  ).trim() === "alive";

// A Windows wrapper that ended leaves what it started running under a dead parent pid.
it.layer(layerTest, { excludeTestServices: true })(
  "a Windows command whose wrapper ended",
  (it) => {
    it.effect.each([
      ["its task is cancelled", "command-win-cancelled", true],
      ["it is found without its wrapper", "command-win-lost", false],
    ] as const)("leaves nothing running when %s", ([, name, cancelled]) =>
      Effect.gen(function* () {
        // The commands are PowerShell: other platforms have their own wrapper, tested above.
        if ((yield* HostProcess.Platform) !== "win32") return;
        const chat = yield* liveChat(name);
        const started = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command:
              "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; " +
              "Set-Content -LiteralPath child.pid -Value $p.Id; Set-Content -LiteralPath ready -Value 1; Start-Sleep 300",
          }),
        );
        yield* awaitFile(NodePath.join(chat.workspace, "ready"));
        const childPid = Number.parseInt(
          NodeFS.readFileSync(NodePath.join(chat.workspace, "child.pid"), "utf8"),
          10,
        );
        yield* Effect.addFinalizer(() =>
          Effect.try({
            try: () => process.kill(childPid),
            catch: (cause) => new ProcessCleanupError({ cause }),
          }).pipe(Effect.ignore),
        );
        // Only the wrapper, as a stop cut by a restart leaves it.
        NodeChildProcess.execFileSync("taskkill", [
          "/PID",
          String((yield* commandRow(started.taskId))!.pid),
          "/F",
        ]);
        assert.isTrue(process.kill(childPid, 0));
        if (cancelled) {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          // Run elsewhere: a Windows folder cannot be removed while a command still has it open.
          yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: "exit 0", cwd: NodeOS.tmpdir() }),
          );
        } else {
          yield* withServer(() => nextWake(chat.threadId));
        }
        assert.equal((yield* commandRow(started.taskId))?.status, cancelled ? "stopped" : "lost");
        assert.isFalse(stillRunning(childPid));
      }),
    );
  },
);
