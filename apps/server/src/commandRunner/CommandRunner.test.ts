// @effect-diagnostics nodeBuiltinImport:off - The commands under test are real processes, watched through the files they leave.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
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
import { isProcessAlive } from "@t3tools/shared/processProbe";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { WindowsJobHost, windowsJobName } from "@t3tools/shared/windowsJob";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

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
/** Fails the Windows launch, after its scripts are written, and hands over the launcher's input. */
const refuseWindowsLaunch = (
  processRunner: ProcessRunner.ProcessRunner["Service"],
  launcher: Deferred.Deferred<ProcessRunner.ProcessRunInput>,
): ProcessRunner.ProcessRunner["Service"] => ({
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

/**
 * Resolves once `file` exists, from its state rather than folder events: on macOS a file made just
 * after `fs.watch` returns can raise none, and a sandbox refuses the watch.
 */
const awaitFile = (file: string) =>
  Effect.callback<void>((resume) => {
    const look = () => {
      if (!NodeFS.existsSync(file)) return;
      NodeFS.unwatchFile(file, look);
      resume(Effect.void);
    };
    NodeFS.watchFile(file, { interval: 20 }, look);
    look();
    return Effect.sync(() => NodeFS.unwatchFile(file, look));
  });

/** Resolves once each of `threadIds` has been offered a wake. */
const wakesOf = (threadIds: ReadonlyArray<ThreadId>) =>
  Offers.pipe(
    Effect.flatMap((offers) => {
      const waiting = new Set<string>(threadIds);
      return Queue.take(offers).pipe(
        Effect.tap((request) => Effect.sync(() => waiting.delete(request.threadId))),
        Effect.repeat({ until: () => waiting.size === 0 }),
      );
    }),
  );

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
      readonly exit_code: number | null;
      readonly pid: number | null;
      readonly process_started_at: number | null;
      readonly started_at: string;
      readonly delivered_at: string | null;
      readonly last_alive_at: string | null;
      readonly probe_error: string | null;
      readonly lost_reason: string | null;
      readonly lost_output: string | null;
    }>`
      SELECT status, exit_code, pid, process_started_at, started_at, delivered_at, last_alive_at, probe_error, lost_reason,
        lost_output
      FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

const observeDelivery =
  (
    taskId: string,
    delivered: Deferred.Deferred<void>,
    field: "pid" | "reported_at" | "delivered_at" = "delivered_at",
  ): Statement.Transformer =>
  (statement, sql) => {
    const [query, params] = statement.compile();
    if (
      !query.includes("UPDATE command_runs") ||
      !query.includes(`${field} =`) ||
      params.at(-1) !== taskId ||
      params[field === "pid" ? 0 : field === "reported_at" ? 12 : 6] === null
    )
      return Effect.succeed(statement);
    return statement.pipe(
      Effect.provideService(Statement.CurrentTransformer, undefined),
      Effect.orDie,
      Effect.andThen(Deferred.succeed(delivered, undefined)),
      Effect.as(sql`SELECT 1 WHERE 0`),
    );
  };

/** What the record holds when its server stops between starting it and recording the pid. */
const forgetPid = (taskId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      UPDATE command_runs SET pid = NULL, process_started_at = NULL, last_alive_at = NULL
      WHERE task_id = ${taskId}
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
    const processRunner = yield* ProcessRunner.ProcessRunner;
    yield* Effect.addFinalizer(() =>
      sql<{
        readonly pid: number | null;
        readonly directory: string;
        readonly started_at: string;
        readonly process_started_at: number | null;
      }>`
        SELECT pid, directory, started_at, process_started_at FROM command_runs WHERE thread_id = ${parent.threadId}
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              if (isWindowsHost) {
                const identity = yield* Effect.try(() =>
                  NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8")
                    .trim()
                    .split(/\s+/),
                ).pipe(Effect.orElseSucceed(() => [] as string[]));
                if (identity.length !== 2) return;
                yield* processRunner.run({
                  command: yield* yield* WindowsJobHost,
                  args: ["stop", windowsJobName(NodePath.basename(row.directory)), ...identity],
                  timeout: Duration.minutes(2),
                });
                return;
              }
              const pid =
                row.pid ??
                Number(
                  (yield* Effect.try(() =>
                    NodeFS.readFileSync(NodePath.join(row.directory, "pid"), "utf8"),
                  ))
                    .trim()
                    .split(/\s+/)[0],
                );
              if (Number.isSafeInteger(pid) && pid > 1)
                yield* Effect.try(() => signalProcessGroup(pid, "SIGKILL"));
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
const ORPHANING_COMMAND = `echo orphaning; ${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; kill -9 $PPID; echo > orphaned; wait`;

// Tests of sh, kill and process groups skip on Windows, which lacks them. Its wrapper's stop and lost paths are
// tested in "a Windows command whose wrapper ended".

// Real processes and the real clock: the runner watches commands on a wall-clock interval.
it.layer(layerTest, { excludeTestServices: true })("a command run apart from its agent", (it) => {
  it.effect.skipIf(isWindowsHost)(
    "a paused POSIX wrapper cannot run after restart cancels its gate",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("posix-native-gate");
        const agentScope = yield* AgentScope;
        let releasePath = "";
        const release = Effect.try(() => {
          if (releasePath === "") return;
          const descriptor = NodeFS.openSync(
            releasePath,
            NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            NodeFS.writeSync(descriptor, "go\n");
          } finally {
            NodeFS.closeSync(descriptor);
            releasePath = "";
          }
        });
        yield* Effect.gen(function* () {
          const first = yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), {
              command: "echo ran > ran",
            }),
          ).pipe(
            Effect.provideService(AgentScope, {
              ...agentScope,
              wrap: (input) =>
                Effect.gen(function* () {
                  const directory = NodePath.dirname(input.args[5]!);
                  releasePath = NodePath.join(directory, "release");
                  NodeChildProcess.execFileSync("mkfifo", [releasePath]);
                  const args = [...input.args];
                  args[1] =
                    'printf "ready\\n" > "${3%/*}/paused"; IFS= read -r go < "${3%/*}/release"\n' +
                    args[1];
                  return yield* agentScope.wrap({ ...input, args });
                }),
            }),
          );
          const directory = NodePath.dirname(first.logPath);
          yield* awaitFile(NodePath.join(directory, "paused"));
          yield* forgetPid(first.taskId);
          yield* withServer(() => nextWake(chat.threadId));
          assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
          yield* release;
          yield* awaitFile(NodePath.join(directory, "exit-status"));
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
        }).pipe(Effect.ensuring(release.pipe(Effect.ignore)));
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "keeps running through a restart and wakes its chat once with its end",
    () =>
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

  it.effect.skipIf(isWindowsHost)(
    "delivers an end that came while no server was running, once one starts",
    () =>
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

  it.effect.skipIf(isWindowsHost)(
    "adopts a command whose server stopped before it recorded the pid",
    () =>
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

  it.effect.skipIf(isWindowsHost)(
    "keeps the end of a log that grew too large, after a note that it was cut",
    () =>
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

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
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
          assert.equal(started.shell, "sh");
          assert.equal(seen, `set for ${chat.workspace} ${chat.threadId} kept removed`);
          assert.equal(commandPath, PATH);
          assert.match(shellOptions ?? "", /errexit/);
          const task = yield* taskOf(chat.threadId, started.taskId);
          assert.equal(task?.status, "failed");
          assert.match(task?.result ?? "", /^Exited with code 7 after /);
        }),
    );
  });

  it.effect(
    "starts a Windows command from a hidden wrapper, with the host environment under its agent's in Unicode, each name once, writing no value and reading none to start",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-environment");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const refused = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), { command: "Write-Output started" })
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provide(
            // Spellings Windows reads as one name; the later one is the value the agent's own get.
            providerShell(
              (_cwd, { HOST_REMOVED: _removed, SystemRoot: _systemRoot, ...inherited }) =>
                Effect.succeed({
                  ...inherited,
                  PATH: "C:\\agent",
                  AGENT_SETTING: "from user settings",
                  agent_setting: "from settings",
                }),
            ),
          ),
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
          Effect.provideService(HostProcess.Environment, {
            Path: "C:\\host",
            HOST_ONLY: "kept",
            HOST_REMOVED: "removed by its settings",
            SystemRoot: "C:\\Windows",
            T3CODE_AUTH_TOKEN: "server only",
          }),
        );
        assert.include(
          (yield* taskOf(chat.threadId, refused.taskId))?.result ?? "",
          "Win32_Process.Create returned 9",
        );
        const launch = yield* Deferred.await(launcher);
        assert.deepEqual(
          Buffer.from(launch.stdin ?? "", "base64")
            .toString("utf8")
            .split("\0")
            .toSorted(),
          [
            "HOST_ONLY=kept",
            "PATH=C:\\agent",
            `T3CODE_THREAD_ID=${chat.threadId}`,
            "agent_setting=from settings",
          ],
        );
        const launcherScript = launch.args.join(" ");
        assert.include(launcherScript, "CreateFlags = [uint32]1024");
        // SW_HIDE: otherwise every command opens a console window on the user's desktop.
        assert.include(launcherScript, "ShowWindow = [uint16]0");
        assert.include(
          launcherScript,
          "HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)",
        );
        assert.include(
          launcherScript,
          "Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'",
        );
        const runPath = /-File "(.+run\.ps1)"/.exec(launcherScript)?.[1] ?? "";
        // The wrapper reads no variable, so no setting can move the cmd or PowerShell it starts.
        assert.notMatch(NodeFS.readFileSync(runPath, "utf8"), /\$env:/i);
        const scriptPath = NodePath.join(NodePath.dirname(runPath), "command.ps1");
        for (const file of [runPath, scriptPath]) {
          assert.notInclude(NodeFS.readFileSync(file, "utf8"), "from settings");
        }
      }),
  );

  // PowerShell 5.1 drops a `"` inside an argument to a program, so `bash -c '<command>'` lost them.
  it.effect(
    "hands a Windows bash command to Git Bash as a file whose path is its only argument, so PowerShell never reads it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-windows-bash-file");
        const processRunner = yield* ProcessRunner.ProcessRunner;
        const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
        const command = `grep -E "^# (pass|fail)" results.txt\necho '$t3Ok' "a \\"b\\"" \`date\``;
        yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command, shell: "bash" }),
        ).pipe(
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
          Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
        );
        const launch = yield* Deferred.await(launcher);
        const folder = NodePath.dirname(
          /-File "(.+run\.ps1)"/.exec(launch.args.join(" "))?.[1] ?? "",
        );
        const bashScript = NodePath.join(folder, "command.sh");
        assert.equal(NodeFS.readFileSync(bashScript, "utf8"), command);
        const powershell = NodeFS.readFileSync(NodePath.join(folder, "command.ps1"), "utf8");
        assert.notInclude(powershell, "results.txt");
        assert.include(
          powershell,
          `ProcessStartInfo]::new([IO.Path]::Combine($t3GitBash, 'bash.exe'), '"${bashScript.replaceAll("\\", "/")}"')`,
        );
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

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
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
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "lost");
          // How it ended stays on its record.
          assert.equal(row?.lost_reason, "gone");
          assert.equal(row?.probe_error, "ESRCH");
          assert.equal(row?.last_alive_at === null, pidUnrecorded);
          assert.include(row?.lost_output ?? "", "orphaning");
          assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );

    it.effect(
      "waits while a probe cannot tell whether its wrapper runs, stopping nothing and still trimming its log",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-probe-unknown");
          const fs = yield* FileSystem.FileSystem;
          const trimmed = yield* Deferred.make<void>();
          const kill = process.kill.bind(process);
          yield* withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                // As ORPHANING_COMMAND, with a log too large once `go` exists.
                command: `${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; head -c 9000000 /dev/zero | tr '\\0' x; echo; kill -9 $PPID; echo > orphaned; wait`,
              });
              yield* awaitFile(NodePath.join(chat.workspace, "ready"));
              const wrapperPid = (yield* commandRow(started.taskId))!.pid!;
              // A probe failure that is not ESRCH, as an overloaded or restricted host can give.
              const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
                if (pid !== wrapperPid || signal !== 0) return kill(pid, signal);
                throw Object.assign(new Error(`kill EIO ${pid}`), { code: "EIO" });
              });
              yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
              NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
              yield* awaitFile(NodePath.join(chat.workspace, "orphaned"));
              yield* Deferred.await(trimmed);
              const waiting = yield* commandRow(started.taskId);
              assert.equal(waiting?.status, "running");
              assert.equal(waiting?.probe_error, "EIO");
              assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
              const log = NodeFS.readFileSync(started.logPath, "utf8");
              assert.match(log, /^\[CodeShip removed earlier output to keep this log small\]\n/);
              assert.isBelow(log.length, 8 * 1024 * 1024);
              probe.mockRestore();
              yield* nextWake(chat.threadId);
              const lost = yield* commandRow(started.taskId);
              assert.equal(lost?.lost_reason, "gone");
              assert.equal(lost?.probe_error, "ESRCH");
              assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
            }),
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              open: (path, options) =>
                fs.open(path, options).pipe(
                  Effect.map(
                    (file) =>
                      new Proxy(file, {
                        get: (target, key) =>
                          key === "truncate"
                            ? (...args: Parameters<typeof file.truncate>) =>
                                file
                                  .truncate(...args)
                                  .pipe(Effect.tap(() => Deferred.succeed(trimmed, undefined)))
                            : Reflect.get(target, key, target),
                      }),
                  ),
                ),
            }),
          );
        }),
    );
  });

  it.effect.skipIf(isWindowsHost)(
    "watches a command whose request was cancelled while it started",
    () =>
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

  it.effect.skipIf(isWindowsHost)("stops a command whose chat was deleted while it started", () =>
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

  it.effect.skipIf(isWindowsHost)(
    "never starts a command for a retry of a request that could not start it",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-unstarted");
        const request = { command: "echo started", clientRequestId: "command-unstarted" };
        const unstartable = yield* AgentScope;
        const first = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provideService(AgentScope, {
            ...unstartable,
            wrap: ({ args }) => Effect.succeed({ command: "/nonexistent/t3-shell", args }),
          }),
        );
        assert.match(
          (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
          /^Could not start the command: /,
        );
        const retried = yield* withServer((runner) => runner.run(callerOf(chat.threadId), request));
        assert.equal(retried.taskId, first.taskId);
        const projection = yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) => orchestrator.getThreadProjection(chat.threadId)),
        );
        const tasks = projection.subagents.filter((task) => task.command !== undefined);
        assert.deepEqual(
          tasks.map((task) => task.status),
          ["failed"],
        );
        assert.equal((yield* commandRow(tasks[0]!.id))?.status, "unstarted");
      }),
  );

  it.effect.skipIf(isWindowsHost)(
    "stops everything the command started when its task is cancelled",
    () =>
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

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
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
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() => Deferred.await(delivered)).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(started.taskId, delivered),
          ),
        );
        assert.isTrue(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        const row = yield* commandRow(started.taskId);
        assert.equal(row?.status, "stopped");
        assert.isNotNull(row?.delivered_at);
      }),
    );
  });

  describe.skipIf(isWindowsHost)("POSIX shell and process groups", () => {
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
          const row = yield* commandRow(started.taskId);
          assert.equal(row?.status, "lost");
          assert.equal(row?.lost_reason, "rebooted");
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "stopped")));
        }),
    );
  });
});

type LossWave = {
  readonly id: string;
  readonly time: string;
  readonly lost: number;
  readonly running: number;
  readonly runs: ReadonlyArray<{ readonly taskId: string; readonly lostReason: string | null }>;
};

/** The waves in the losses log, oldest first. */
const lossWaves = Effect.map(ServerConfig.ServerConfig, ({ logsDir }) => {
  const file = NodePath.join(logsDir, CommandRunner.LOSS_LOG_FILE);
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as LossWave);
});

/** A command an earlier server recorded lost, in the wave `waveId` names, or in none yet. */
const seedLoss = (loss: {
  readonly taskId: string;
  readonly directory: string;
  readonly endedAt: string;
  readonly waveId: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status,
        started_at, deadline_at, ended_at, delivered_at, probe_error, lost_reason, loss_wave_id,
        loss_unplaced)
      VALUES (${loss.taskId}, 'thread-earlier', ${`run-${loss.taskId}`}, 'true', ${loss.directory},
        ${loss.directory}, 'lost', ${loss.endedAt}, ${loss.endedAt}, ${loss.endedAt},
        ${loss.endedAt}, 'ESRCH', 'gone', ${loss.waveId}, ${loss.waveId === null ? 1 : 0})
    `;
  });

/** A command an earlier server saw exit, and delivered. */
const seedExited = (run: {
  readonly taskId: string;
  readonly directory: string;
  readonly startedAt: string;
  readonly endedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_runs (task_id, thread_id, run_id, command, cwd, directory, status,
        exit_code, started_at, deadline_at, ended_at, delivered_at)
      VALUES (${run.taskId}, 'thread-earlier', ${`run-${run.taskId}`}, 'true', ${run.directory},
        ${run.directory}, 'exited', 0, ${run.startedAt}, ${run.endedAt}, ${run.endedAt},
        ${run.endedAt})
    `;
  });

const waveIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly wave_id: string }>`SELECT wave_id FROM command_loss_waves`).map(
    (row) => row.wave_id,
  );
});

const seedWave = (waveId: string, startedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO command_loss_waves (wave_id, started_at, running) VALUES (${waveId}, ${startedAt}, 0)
    `;
  });

/** Once `go` exists it kills its wrapper, so it ends without an exit status. */
const LOSING_COMMAND = "until [ -e go ]; do sleep 0.05; done; kill -9 $PPID";
const go = (chat: { readonly workspace: string }) =>
  NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");

/**
 * Resolves once a pass that began after the call has ended, its wave noted. A pass wakes a command's
 * chat before it notes its wave, and run() waits for the pass under way, so the second command
 * starts only after the pass that saw the first one end; at a server's start none is under way.
 */
const nextPass = (runner: CommandRunner.CommandRunner["Service"], threadId: ThreadId) => {
  const runToEnd = runner
    .run(callerOf(threadId), { command: "true" })
    .pipe(Effect.andThen(nextWake(threadId)));
  return runToEnd.pipe(Effect.andThen(runToEnd));
};

describe("placing lost commands in waves", () => {
  it("joins the last wave while each loss comes within a minute after the one before, and starts one from more than half the commands of the minute up to a loss", () => {
    const lostAt = (...seconds: ReadonlyArray<number>) =>
      seconds.map((at) => ({ taskId: `task-${at}`, at: at * 1000 }));
    const commands = (count: number) => () => count;
    const place = (
      lastLossAt: number | undefined,
      losses: ReadonlyArray<{ readonly taskId: string; readonly at: number }>,
      commandsAt: (second: number) => number,
    ) => {
      const { joining, waves, waiting } = CommandRunner.placeLosses(
        lastLossAt === undefined ? undefined : lastLossAt * 1000,
        losses,
        (at) => commandsAt(at / 1000),
      );
      const seconds = (placed: ReadonlyArray<{ readonly at: number }>) =>
        placed.map((loss) => loss.at / 1000);
      return {
        joining: seconds(joining),
        waves: waves.map((wave) => seconds(wave.losses)),
        waiting: seconds(waiting),
      };
    };
    const none = { joining: [], waves: [], waiting: [] };
    assert.deepEqual(place(0, lostAt(100, 50), commands(3)), { ...none, joining: [50, 100] });
    // 65 s after the loss before it, so it starts a wave of its own.
    assert.deepEqual(place(0, lostAt(50, 115), commands(1)), {
      ...none,
      joining: [50],
      waves: [[115]],
    });
    // Lost before the last wave's latest loss, so it is not part of that wave.
    assert.deepEqual(place(100, lostAt(90), commands(3)), { ...none, waiting: [90] });
    assert.deepEqual(place(undefined, lostAt(10, 20), commands(4)), { ...none, waiting: [10, 20] });
    assert.deepEqual(place(undefined, lostAt(10, 20), commands(3)), { ...none, waves: [[10, 20]] });
    // More than a minute apart, so neither counts with the other.
    assert.deepEqual(place(undefined, lostAt(0, 70), commands(3)), { ...none, waiting: [0, 70] });
    // Against the commands that ran up to each loss, not fewer that run later.
    assert.deepEqual(
      place(undefined, lostAt(10, 20), (second) => (second < 30 ? 5 : 1)),
      { ...none, waiting: [10, 20] },
    );
  });
});

// Each has a database and logs folder of its own, since a wave counts every loss of the last minute.
describe.skipIf(isWindowsHost)("a wave of lost commands", () => {
  it.layer(layerTest, { excludeTestServices: true })("lost together", (it) => {
    it.effect("is logged once, and not again by the next server", () =>
      Effect.gen(function* () {
        const chats = yield* Effect.forEach(["one", "two", "three"], (name) =>
          liveChat(`command-wave-${name}`),
        );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Effect.forEach(chats, (chat) =>
              runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
            );
            for (const chat of chats) go(chat);
            yield* wakesOf(chats.map((chat) => chat.threadId));
            yield* nextPass(runner, chats[0]!.threadId);
          }),
        );
        // It counts the same losses, and finds them logged.
        yield* withServer((runner) => nextPass(runner, chats[0]!.threadId));
        assert.lengthOf(yield* waveIds, 1);
        const waves = yield* lossWaves;
        assert.lengthOf(waves, 1);
        // It holds all three, also when two were lost a pass before the third, which already is a wave.
        assert.equal(waves[0]!.lost, 3);
        assert.deepEqual(
          waves[0]!.runs.map((run) => run.lostReason),
          ["gone", "gone", "gone"],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost across a restart", (it) => {
    it.effect("counts the losses an earlier server recorded in the last minute", () =>
      Effect.gen(function* () {
        const chats = yield* Effect.forEach(["one", "two", "three"], (name) =>
          liveChat(`command-wave-restart-${name}`),
        );
        const [one, two, three] = [chats[0]!, chats[1]!, chats[2]!];
        yield* withServer((runner) =>
          Effect.gen(function* () {
            yield* Effect.forEach(chats, (chat) =>
              runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
            );
            go(one);
            yield* nextWake(one.threadId);
            yield* nextPass(runner, one.threadId);
          }),
        );
        // One lost while two run is no wave.
        assert.lengthOf(yield* lossWaves, 0);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            go(two);
            go(three);
            yield* wakesOf([two.threadId, three.threadId]);
            yield* nextPass(runner, two.threadId);
          }),
        );
        // Three of the four commands of the minute, nextPass's first one included, were lost.
        const waves = yield* lossWaves;
        assert.deepEqual(
          waves.map(({ lost, running }) => ({ lost, running })),
          [{ lost: 3, running: 0 }],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost after another ended", (it) => {
    it.effect(
      "is no wave when only half the commands of the minute were lost, though the other ended before a restart",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-half");
          yield* withServer((runner) =>
            runner.run(callerOf(chat.threadId), { command: LOSING_COMMAND }),
          );
          // The earlier server saw another command end normally, and delivered its end.
          const endedAt = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.seconds(10)),
          );
          yield* seedExited({
            taskId: "task-ended",
            directory: NodePath.join(chat.workspace, "task-ended"),
            startedAt: endedAt,
            endedAt,
          });
          yield* withServer((runner) =>
            Effect.gen(function* () {
              go(chat);
              yield* nextWake(chat.threadId);
              yield* nextPass(runner, chat.threadId);
            }),
          );
          assert.lengthOf(yield* lossWaves, 0);
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost on both sides of a restart", (it) => {
    it.effect("goes on as the wave its losses follow, holding each loss once", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-wave-continued");
        const now = yield* DateTime.now;
        const secondsAgo = (seconds: number) =>
          DateTime.formatIso(DateTime.subtractDuration(now, Duration.seconds(seconds)));
        // The earlier server began a wave 70 s ago, lost one more command 20 s ago, and stopped
        // before it placed that one in the wave.
        yield* seedWave("wave-earlier", secondsAgo(70));
        for (const [taskId, seconds, waveId] of [
          ["task-a", 70, "wave-earlier"],
          ["task-b", 70, "wave-earlier"],
          ["task-c", 20, null],
        ] as const) {
          yield* seedLoss({
            taskId,
            directory: NodePath.join(chat.workspace, taskId),
            endedAt: secondsAgo(seconds),
            waveId,
          });
        }
        const started = yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              command: LOSING_COMMAND,
            });
            go(chat);
            yield* nextWake(chat.threadId);
            yield* nextPass(runner, chat.threadId);
            return started;
          }),
        );
        const waves = yield* lossWaves;
        assert.deepEqual(
          waves.map(({ id, time, lost, runs }) => ({
            id,
            time,
            lost,
            runs: runs.map((run) => run.taskId),
          })),
          [
            {
              id: "wave-earlier",
              time: secondsAgo(70),
              lost: 4,
              runs: ["task-a", "task-b", "task-c", started.taskId],
            },
          ],
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost before a restart", (it) => {
    it.effect(
      "is placed by the next server however much later it starts, against the commands that ran then",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-unplaced");
          const now = yield* DateTime.now;
          const secondsAgo = (seconds: number) =>
            DateTime.formatIso(DateTime.subtractDuration(now, Duration.seconds(seconds)));
          // The earlier server recorded these and stopped before it placed them.
          for (const [taskId, seconds] of [
            ["task-a", 120],
            ["task-b", 120],
            ["task-c", 120],
            ["task-lone", 600],
          ] as const) {
            yield* seedLoss({
              taskId,
              directory: NodePath.join(chat.workspace, taskId),
              endedAt: secondsAgo(seconds),
              waveId: null,
            });
          }
          // With this one running too, the lone loss was only half of its minute's commands.
          yield* seedExited({
            taskId: "task-ran",
            directory: NodePath.join(chat.workspace, "task-ran"),
            startedAt: secondsAgo(660),
            endedAt: secondsAgo(590),
          });
          yield* withServer((runner) => nextPass(runner, chat.threadId));
          assert.deepEqual(
            (yield* lossWaves).map(({ time, lost, runs }) => ({
              time,
              lost,
              runs: runs.map((run) => run.taskId),
            })),
            [{ time: secondsAgo(120), lost: 3, runs: ["task-a", "task-b", "task-c"] }],
          );
          // None is read again at the next pass.
          const sql = yield* SqlClient.SqlClient;
          assert.lengthOf(yield* sql`SELECT task_id FROM command_runs WHERE loss_unplaced = 1`, 0);
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost alone", (it) => {
    it.effect(
      "is the only running command lost, and is logged once the log can be written, by a server that starts minutes later too",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-wave-alone");
          const { logsDir } = yield* ServerConfig.ServerConfig;
          const logPath = NodePath.join(logsDir, CommandRunner.LOSS_LOG_FILE);
          // The log cannot be written while its temporary file's path is taken.
          NodeFS.mkdirSync(`${logPath}.tmp`, { recursive: true });
          const started = yield* withServer((runner) =>
            Effect.gen(function* () {
              const started = yield* runner.run(callerOf(chat.threadId), {
                command: LOSING_COMMAND,
              });
              go(chat);
              yield* nextWake(chat.threadId);
              yield* nextPass(runner, chat.threadId);
              return started;
            }),
          );
          assert.lengthOf(yield* lossWaves, 0);
          const sql = yield* SqlClient.SqlClient;
          const minutesAgo = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(3)),
          );
          yield* sql`
            UPDATE command_runs SET ended_at = ${minutesAgo} WHERE task_id = ${started.taskId}
          `;
          yield* withServer((runner) =>
            Effect.gen(function* () {
              // Each run waits for the pass under way, so at least one write has failed here.
              yield* nextPass(runner, chat.threadId);
              yield* nextPass(runner, chat.threadId);
              assert.lengthOf(yield* lossWaves, 0);
              NodeFS.rmdirSync(`${logPath}.tmp`);
              yield* nextPass(runner, chat.threadId);
              yield* nextPass(runner, chat.threadId);
            }),
          );
          assert.deepEqual(
            (yield* lossWaves).map(({ lost, running, runs }) => ({
              lost,
              running,
              runs: runs.map((run) => run.taskId),
            })),
            [{ lost: 1, running: 0, runs: [started.taskId] }],
          );
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("lost long ago", (it) => {
    it.effect("goes once the records it holds go, 14 days after their ends were delivered", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-wave-kept");
        const now = yield* DateTime.now;
        for (const [waveId, days] of [
          ["wave-old", 15],
          ["wave-recent", 13],
        ] as const) {
          const endedAt = DateTime.formatIso(DateTime.subtractDuration(now, Duration.days(days)));
          yield* seedWave(waveId, endedAt);
          yield* seedLoss({
            taskId: `task-${waveId}`,
            directory: NodePath.join(chat.workspace, waveId),
            endedAt,
            waveId,
          });
        }
        // The second run waits for the first pass, which writes the log.
        yield* withServer((runner) =>
          nextPass(runner, chat.threadId).pipe(Effect.andThen(nextPass(runner, chat.threadId))),
        );
        assert.deepEqual(
          (yield* lossWaves).map((wave) => wave.id),
          ["wave-recent"],
        );
        assert.deepEqual(yield* waveIds, ["wave-recent"]);
      }),
    );
  });
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

describe("the shell a command runs in", () => {
  it.each([
    ["win32", { SHELL: "/bin/zsh" }, undefined, "powershell", "powershell.exe"],
    ["win32", { SHELL: "/bin/zsh" }, "bash", "bash", "bash.exe"],
    ["darwin", { SHELL: "/bin/zsh" }, undefined, "zsh", "/bin/zsh"],
    ["darwin", { SHELL: "/bin/zsh" }, "bash", "bash", "bash"],
    ["linux", { SHELL: "/usr/bin/bash" }, undefined, "bash", "/usr/bin/bash"],
    ["linux", { SHELL: "/usr/bin/bash" }, "bash", "bash", "/usr/bin/bash"],
    ["linux", { SHELL: "/usr/bin/fish" }, undefined, "sh", "/bin/sh"],
    ["linux", { SHELL: "/tmp/a=b/bash" }, undefined, "sh", "/bin/sh"],
    ["linux", { SHELL: "/tmp/a=b/bash" }, "bash", "bash", "bash"],
    ["linux", {}, undefined, "sh", "/bin/sh"],
  ] as const)(
    "on %s with %j, asked for %s, is %s at %s",
    (platform, env, requested, name, path) => {
      assert.deepEqual(CommandRunner.resolveCommandShell(platform, env, requested), { name, path });
    },
  );
});

const processOutput = (stdout = "") => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** A WMI boundary with explicit launch/probe barriers and no operating-system processes. */
const windowsFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const probes = yield* Queue.unbounded<void>();
  const reads = yield* Queue.unbounded<string>();
  const renamed = yield* Queue.unbounded<string>();
  const stopped = yield* Queue.unbounded<{
    readonly pid: number;
    readonly identity: number | undefined;
  }>();
  const processes = new Map<number, { identity: number; alive: boolean; directory: string }>();
  const jobs = new Map<string, { pid: number; identity: number }>();
  const groups = new Set<number>();
  const groupSignals: Array<string | number | undefined> = [];
  let nextPid = 2_147_483_000;
  const clock = yield* Clock.Clock;
  const fixture = {
    now: yield* Clock.currentTimeMillis,
    probes,
    reads,
    renamed,
    stopped,
    processes,
    jobs,
    groups,
    groupSignals,
    stopRequests: [] as Array<ReadonlyArray<string>>,
    unavailable: false,
    failGate: false,
    failRead: "",
    launches: 0,
    kills: 0,
    stopError: "",
    probeCalls: 0,
    beforeProbe: Effect.void as Effect.Effect<void>,
    launch: (_input: ProcessRunner.ProcessRunInput, directory: string) =>
      Effect.gen(function* () {
        const pid = nextPid++;
        const identity = DateTime.toEpochMillis(yield* DateTime.now);
        processes.set(pid, { identity, alive: true, directory });
        groups.add(pid);
        jobs.set(NodePath.basename(directory), { pid, identity });
        NodeFS.writeFileSync(NodePath.join(directory, "pid"), `${pid} ${identity}`);
        NodeFS.renameSync(
          NodePath.join(directory, "launch-pending"),
          NodePath.join(directory, "launch-started"),
        );
        return processOutput(`${pid} ${identity}`);
      }) as Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  };
  const originalKill = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0 && processes.has(-pid)) {
      groupSignals.push(signal);
      if (!groups.has(-pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0) groups.delete(-pid);
      return true;
    }
    const known = processes.get(pid);
    if (known === undefined) return originalKill(pid, signal);
    assert.equal(signal, 0);
    if (!known.alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
  const ioError = (method: string) =>
    new PlatformError.PlatformError(
      new PlatformError.SystemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method,
      }),
    );
  const layer = Layer.mergeAll(
    Layer.succeed(Clock.Clock, {
      currentTimeMillis: Effect.sync(() => fixture.now),
      currentTimeMillisUnsafe: () => fixture.now,
      currentTimeNanos: Effect.sync(() => BigInt(fixture.now) * 1_000_000n),
      currentTimeNanosUnsafe: () => BigInt(fixture.now) * 1_000_000n,
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      sleep: (duration) => clock.sleep(duration),
    }),
    Layer.succeed(HostProcess.Platform, "win32"),
    Layer.succeed(WindowsJobHost, Effect.succeed("job-host.exe")),
    Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      readFileString: (file, ...args) =>
        Effect.gen(function* () {
          yield* Queue.offer(reads, file);
          if (NodePath.basename(file) === fixture.failRead) return yield* ioError("readFileString");
          return yield* fs.readFileString(file, ...args);
        }),
      rename: (from, to) =>
        Effect.gen(function* () {
          if (fixture.failGate && NodePath.basename(from) === "launch-pending")
            return yield* ioError("rename");
          yield* fs.rename(from, to);
          yield* Queue.offer(renamed, to);
        }),
    }),
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          const script = input.args.join(" ");
          if (input.command === "job-host.exe" && input.args[0] === "stop") {
            fixture.stopRequests.push(input.args);
            const member = jobs.get(input.args[1]!.split(".").at(-1)!);
            if (member === undefined) return processOutput();
            const entry = processes.get(member.pid)!;
            const original =
              entry.identity === member.identity &&
              entry.alive &&
              (input.args.length === 2 ||
                (Number(input.args[2]) === member.pid &&
                  Number(input.args[3]) === member.identity));
            if (original && NodeFS.existsSync(NodePath.join(entry.directory, "exit-status")))
              entry.alive = false;
            if (entry.alive && original) fixture.kills++;
            if (fixture.stopError !== "") {
              yield* Queue.offer(stopped, member);
              return {
                ...processOutput(),
                code: ChildProcessSpawner.ExitCode(1),
                stderr: fixture.stopError,
              };
            }
            if (original) entry.alive = false;
            yield* Queue.offer(stopped, member);
            return processOutput();
          }
          if (script.includes("Win32_Process -MethodName Create")) {
            fixture.launches++;
            const wrapper = /-File "(.+run\.ps1)"/.exec(script)?.[1];
            assert.isDefined(wrapper);
            return yield* fixture.launch(input, NodePath.dirname(wrapper!));
          }
          if (input.command === "job-host.exe" && input.args[0] === "stop-process") {
            const pid = Number(input.args[1]);
            const identity = Number(input.args[2]);
            const entry = processes.get(pid)!;
            if (entry.identity === identity) {
              fixture.kills++;
              entry.alive = false;
            }
            yield* Queue.offer(stopped, { pid, identity });
            return processOutput();
          }
          const probe =
            input.command === "ps"
              ? /-p (\d+)/.exec(script)
              : input.command === "job-host.exe"
                ? /identity (\d+)/.exec(script)
                : /(?:Get-Process -Id |ProcessId = )(\d+)/.exec(script);
          assert.isNotNull(probe, script);
          fixture.probeCalls++;
          yield* Queue.offer(probes, undefined);
          yield* fixture.beforeProbe;
          if (fixture.unavailable)
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            });
          return processOutput(
            input.command === "ps"
              ? DateTime.toDateUtc(DateTime.makeUnsafe(processes.get(Number(probe![1]))!.identity))
                  .toUTCString()
                  .replace(" GMT", "")
              : script.includes("Get-CimInstance") || input.command === "job-host.exe"
                ? String(processes.get(Number(probe![1]))!.identity)
                : DateTime.formatIso(
                    DateTime.makeUnsafe(processes.get(Number(probe![1]))!.identity),
                  ),
          );
        }),
    }),
  );
  return { ...fixture, state: fixture, layer };
});

it.layer(layerTest, { excludeTestServices: true })("launch reconciliation", (it) => {
  it.effect(
    "names executable policy as a possible cause when Windows cannot start its cached host",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-host-policy");
        const fixture = yield* windowsFixture;
        fixture.state.launch = () =>
          Effect.succeed({
            ...processOutput(),
            code: ChildProcessSpawner.ExitCode(1),
            stderr: "Win32_Process.Create returned 2",
          });
        const result = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), {
              command: "echo policy",
            })
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(Effect.provide(fixture.layer));
        const message = (yield* taskOf(chat.threadId, result.taskId))?.result ?? "";
        assert.include(message, "Win32_Process.Create returned 2");
        assert.include(message, "AppLocker or WDAC");
        assert.include(message, "unsigned");
      }),
  );

  it.effect.each(["cancelled", "already stopped"] as const)(
    "closes a pending gate during restart cleanup for a task %s before late Create",
    (state) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`restart-pending-${state}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo late Create" }),
        ).pipe(Effect.provide(fixture.layer));
        const directory = NodePath.dirname(first.logPath);
        yield* forgetPid(first.taskId);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        NodeFS.renameSync(
          NodePath.join(directory, "launch-started"),
          NodePath.join(directory, "launch-pending"),
        );
        fixture.jobs.clear();
        fixture.processes.get(2147483000)!.alive = false;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId));
        const sql = yield* SqlClient.SqlClient;
        if (state === "already stopped")
          yield* sql`UPDATE command_runs SET status = 'stopped' WHERE task_id = ${first.taskId}`;
        const delivered = yield* Deferred.make<void>();
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(delivered);
            assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
            // The delayed host publishes identity before its wrapper competes for the gate.
            NodeFS.writeFileSync(NodePath.join(directory, "pid"), `2147483000 ${fixture.now}`);
            assert.throws(() =>
              NodeFS.renameSync(
                NodePath.join(directory, "launch-pending"),
                NodePath.join(directory, "launch-started"),
              ),
            );
            assert.isFalse(NodeFS.existsSync(NodePath.join(directory, "launch-started")));
            assert.equal((yield* commandRow(first.taskId))?.status, "stopped");
            assert.lengthOf(fixture.stopRequests, 0);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
        );
      }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "reports %s before a legacy cleanup identity probe is released",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`report-held-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo held cleanup",
            timeoutMinutes: 1,
          }),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const release = yield* Deferred.make<void>();
        const reported = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        fixture.state.beforeProbe = Deferred.await(release);
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            if (reason === "deadline") fixture.state.now += 60_000;
            else
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(chat.threadId, first.taskId)),
                ),
              );
            yield* Deferred.await(reported);
            if (reason === "deadline") {
              yield* nextWake(chat.threadId);
              assert.include(
                (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
                "cleanup is still pending",
              );
            }
            assert.isTrue(fixture.processes.get(2147483000)!.alive);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(Statement.CurrentTransformer, (...args) =>
            args[0].compile()[1][6] == null
              ? observeDelivery(first.taskId, reported, "reported_at")(...args)
              : observeDelivery(first.taskId, delivered)(...args),
          ),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
      }),
  );

  it.effect("keeps a replacement job alive when restart cleanup stops the recorded child", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-replaced-job");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "echo original" }),
      ).pipe(Effect.provide(fixture.layer));
      const row = (yield* commandRow(result.taskId))!;
      const directory = NodePath.dirname(result.logPath);
      const replacement = { pid: 2147483001, identity: fixture.now + 500 };
      fixture.jobs.set(NodePath.basename(directory), replacement);
      fixture.processes.set(replacement.pid, {
        identity: replacement.identity,
        directory,
        alive: true,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE command_runs SET status = 'stopped' WHERE task_id = ${result.taskId}`;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(result.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
      assert.isTrue(fixture.processes.get(replacement.pid)!.alive);
      assert.deepEqual(fixture.stopRequests[0]?.slice(2), [
        String(row.pid),
        String(row.process_started_at),
      ]);
    }),
  );

  it.effect("cancels a pending POSIX gate before a paused launcher can run", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-no-spawn");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "echo never started",
          timeoutMinutes: 1,
        }),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* forgetPid(first.taskId);
      yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
      NodeFS.unlinkSync(NodePath.join(NodePath.dirname(first.logPath), "pid"));
      NodeFS.renameSync(
        NodePath.join(NodePath.dirname(first.logPath), "launch-started"),
        NodePath.join(NodePath.dirname(first.logPath), "launch-pending"),
      );
      fixture.processes.get(2147483000)!.alive = false;
      fixture.state.now += 6_000;
      yield* withServer(() => nextWake(chat.threadId)).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provide(fixture.layer),
      );
      assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
      assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "failed");
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(NodePath.dirname(first.logPath), "launch-cancelled")),
      );
    }),
  );

  it.effect(
    "keeps a POSIX launcher that took the gate unresolved past five seconds until it publishes its pid",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("posix-late-pid");
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo late identity",
            timeoutMinutes: 1,
          }),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* forgetPid(first.taskId);
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const pidFile = NodePath.join(NodePath.dirname(first.logPath), "pid");
        const pidText = NodeFS.readFileSync(pidFile, "utf8");
        NodeFS.unlinkSync(pidFile);
        fixture.state.now += 6_000;
        const fs = yield* FileSystem.FileSystem;
        const missing = yield* Deferred.make<void>();
        const publish = yield* Deferred.make<void>();
        const adopted = yield* Deferred.make<void>();
        let held = true;
        const missingPid = Deferred.succeed(missing, undefined).pipe(
          Effect.andThen(Deferred.await(publish)),
          Effect.andThen(
            Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                }),
              ),
            ),
          ),
        );
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Deferred.await(missing);
            NodeFS.writeFileSync(pidFile, pidText);
            held = false;
            yield* Deferred.succeed(publish, undefined);
            yield* Deferred.await(adopted);
            assert.equal((yield* commandRow(first.taskId))?.status, "running");
            assert.isTrue(fixture.groups.has(2147483000));
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(first.logPath), "exit-status"),
              "0",
            );
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, adopted, "pid"),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, ...args) =>
              file === pidFile && held ? missingPid : fs.readFileString(file, ...args),
            stat: (file) => (file === pidFile && held ? missingPid : fs.stat(file)),
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(publish, undefined)),
        );
      }),
  );

  it.effect.each([
    "observed replacement",
    "recorded replacement",
    "recorded reboot",
    "systemd unit",
  ] as const)("never signals a replacement POSIX group after its leader exits: %s", (evidence) =>
    Effect.gen(function* () {
      const chat = yield* liveChat(`posix-group-${evidence}`);
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "echo original group",
        }),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      const reason =
        evidence === "recorded replacement"
          ? "pid-reused"
          : evidence === "recorded reboot"
            ? "rebooted"
            : null;
      const unit = evidence === "systemd unit" ? "original.scope" : null;
      yield* sql`UPDATE command_runs SET unit = ${unit}, lost_reason = ${reason},
        status = ${evidence === "observed replacement" ? "running" : "stopped"}
        WHERE task_id = ${first.taskId}`;
      const entry = fixture.processes.get(2147483000)!;
      entry.identity += 5_000;
      if (evidence === "observed replacement")
        fixture.state.beforeProbe = Effect.sync(() => {
          entry.alive = false;
        });
      else entry.alive = false;
      const delivered = yield* Deferred.make<void>();
      const agentScope = yield* AgentScope;
      const units: string[] = [];
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provideService(AgentScope, {
          ...agentScope,
          stopCommand: (name) =>
            Effect.sync(() => {
              units.push(name);
              return true;
            }),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provide(fixture.layer),
      );
      assert.isTrue(fixture.groups.has(2147483000));
      assert.deepEqual(fixture.groupSignals, []);
      assert.deepEqual(units, unit === null ? [] : [unit]);
      assert.equal(
        (yield* commandRow(first.taskId))?.lost_reason,
        evidence === "observed replacement" ? "pid-reused" : reason,
      );
    }),
  );

  it.effect.each([null, "pid-reused"] as const)(
    "retains command cleanup until its systemd scope is empty, loss %s",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`unit-stop-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo scoped" }),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        const unit = "t3code-command-owned.scope";
        yield* sql`UPDATE command_runs SET unit = ${unit}, lost_reason = ${reason}, status = 'stopped' WHERE task_id = ${first.taskId}`;
        fixture.processes.get(2147483000)!.alive = false;
        const attempts = yield* Queue.unbounded<string>();
        const delivered = yield* Deferred.make<void>();
        const agentScope = yield* AgentScope;
        let populated = true;
        const stop = (name: string) => Queue.offer(attempts, name).pipe(Effect.asVoid);
        yield* withServer(() =>
          Effect.gen(function* () {
            assert.equal(yield* Queue.take(attempts), unit);
            assert.equal(yield* Queue.take(attempts), unit);
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            assert.isTrue(fixture.groups.has(2147483000));
            populated = false;
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(first.taskId, delivered),
          ),
          Effect.provideService(AgentScope, {
            ...agentScope,
            stop,
            stopCommand: (name) =>
              stop(name).pipe(
                Effect.map(() => {
                  if (!populated) fixture.groups.delete(2147483000);
                  return !populated;
                }),
              ),
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provide(fixture.layer),
        );
        assert.isFalse(fixture.groups.has(2147483000));
        assert.deepEqual(fixture.groupSignals, []);
      }),
  );

  it.effect("reports an unresolved legacy launch at its deadline and reconciles a later pid", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-legacy-deadline");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "echo late legacy",
          timeoutMinutes: 1,
        }),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* forgetPid(first.taskId);
      yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
      const directory = NodePath.dirname(first.logPath);
      NodeFS.unlinkSync(NodePath.join(directory, "pid"));
      NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
      const entry = fixture.processes.get(2147483000)!;
      entry.alive = false;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() =>
        Effect.gen(function* () {
          fixture.state.now += 60_000;
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "failed");
          assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
        }),
      ).pipe(Effect.provide(fixture.layer));
      yield* withServer(() =>
        Effect.gen(function* () {
          entry.alive = true;
          NodeFS.writeFileSync(NodePath.join(directory, "pid"), `2147483000 ${entry.identity}`);
          yield* Deferred.await(delivered);
          assert.isFalse(entry.alive);
        }),
      ).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect.each(["gone", "pid-reused"] as const)(
    "settles a legacy pid-only command proven %s",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-${reason}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo old wrapper",
          }),
        ).pipe(Effect.provide(fixture.layer));
        const sql = yield* SqlClient.SqlClient;
        yield* forgetPid(first.taskId);
        yield* sql`UPDATE command_runs SET unit = NULL WHERE task_id = ${first.taskId}`;
        const directory = NodePath.dirname(first.logPath);
        const file = NodePath.join(directory, "pid");
        NodeFS.writeFileSync(file, "2147483000");
        NodeFS.utimesSync(file, fixture.state.now / 1_000, fixture.state.now / 1_000);
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        const entry = fixture.processes.get(2147483000)!;
        if (reason === "gone") entry.alive = false;
        else entry.identity += 500;
        yield* withServer(() => nextWake(chat.threadId)).pipe(Effect.provide(fixture.layer));
        const row = yield* commandRow(first.taskId);
        assert.equal(row?.lost_reason, reason);
        assert.equal(row?.pid, 2147483000);
        assert.equal(fixture.state.kills, 0);
        assert.equal(entry.alive, reason === "pid-reused");
      }),
  );

  it.effect("delivers a stopped legacy command whose pid was reused after its exit", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-legacy-stopped-exit");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), {
          command: "echo old stopped wrapper",
        }),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      yield* forgetPid(first.taskId);
      yield* sql`UPDATE command_runs SET unit = NULL, status = 'stopped' WHERE task_id = ${first.taskId}`;
      const directory = NodePath.dirname(first.logPath);
      NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
      NodeFS.writeFileSync(NodePath.join(directory, "pid"), "2147483000");
      const exit = NodePath.join(directory, "exit-status");
      NodeFS.writeFileSync(exit, "0");
      NodeFS.utimesSync(exit, fixture.state.now / 1_000, fixture.state.now / 1_000);
      fixture.processes.get(2147483000)!.identity += 500;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() => Deferred.await(delivered)).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(first.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
      assert.isNotNull((yield* commandRow(first.taskId))?.delivered_at);
      assert.isTrue(fixture.processes.get(2147483000)!.alive);
      assert.equal(fixture.state.kills, 0);
    }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "enforces %s after the same task's identity probe is held",
    (reason) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-held-probe-${reason}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo held identity",
            timeoutMinutes: 1,
          }),
        ).pipe(Effect.provide(fixture.layer));
        const release = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        fixture.state.beforeProbe = Deferred.await(release);
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            if (reason === "deadline") fixture.state.now += 60_000;
            else
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
                ),
              );
            yield* Queue.take(fixture.stopped).pipe(
              Effect.repeat({
                until: (stop) => stop.identity === fixture.processes.get(2147483000)!.identity,
              }),
            );
            assert.isFalse(fixture.processes.get(2147483000)!.alive);
            assert.equal(
              (yield* commandRow(result.taskId))?.status,
              reason === "deadline" ? "timed_out" : "stopped",
            );
            yield* Deferred.succeed(release, undefined);
            yield* Deferred.await(delivered);
          }),
        ).pipe(
          Effect.provideService(
            Statement.CurrentTransformer,
            observeDelivery(result.taskId, delivered),
          ),
          Effect.provide(fixture.layer),
          Effect.ensuring(Deferred.succeed(release, undefined)),
        );
      }),
  );

  it.effect("closes the pending gate at the deadline while its launcher is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-held-deadline");
      const fixture = yield* windowsFixture;
      const entered = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      let ran = false;
      fixture.state.launch = (input, directory) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, directory);
          yield* Deferred.await(release);
          if (NodeFS.existsSync(NodePath.join(directory, "launch-pending"))) {
            ran = true;
            return yield* create(input, directory);
          }
          return processOutput();
        });
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = {
            command: "echo held",
            timeoutMinutes: 1,
            clientRequestId: "held-deadline",
          };
          const pending = yield* runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.forkChild);
          const directory = yield* Deferred.await(entered);
          const task = yield* runner.run(callerOf(chat.threadId), request);
          fixture.state.now += 60_000;
          yield* Queue.take(fixture.renamed);
          assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
          yield* nextWake(chat.threadId);
          assert.equal((yield* commandRow(task.taskId))?.status, "timed_out");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          assert.isFalse(ran);
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("revalidates cached identity when a pid is replaced between live observations", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-cache-reused");
      const fixture = yield* windowsFixture;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo original" });
          fixture.processes.get(2147483000)!.identity += 500;
          fixture.state.now += 60_000;
          yield* nextWake(chat.threadId);
          const row = yield* commandRow(result.taskId);
          assert.equal(row?.lost_reason, "pid-reused");
          assert.isTrue(fixture.processes.get(2147483000)!.alive);
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each(["linux", "win32"] as const)(
    "recovers the pid from a legacy file with an already-published exit on %s",
    (platform) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-legacy-exit-${platform}`);
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), {
            command: "echo legacy",
          }),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const directory = NodePath.dirname(first.logPath);
        NodeFS.writeFileSync(NodePath.join(directory, "pid"), "2147483000");
        NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
        fixture.processes.get(2147483000)!.alive = false;
        yield* withServer(() => nextWake(chat.threadId)).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provide(fixture.layer),
        );
        assert.equal((yield* commandRow(first.taskId))?.pid, 2147483000);
        assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
      }),
  );

  it.effect("continues watching after the first wave query fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-first-watch-error");
      const fixture = yield* windowsFixture;
      const failed = yield* Deferred.make<void>();
      let injected = false;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          yield* Deferred.await(failed);
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo survives" });
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement, sql) => {
          if (injected || !statement.compile()[0].includes("WHERE loss_unplaced = 1"))
            return Effect.succeed(statement);
          injected = true;
          return Deferred.succeed(failed, undefined).pipe(
            Effect.as(sql`SELECT * FROM injected_missing_wave_table`),
          );
        }),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("returns a failed launch task while its recovery probe is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-return-before-recovery");
      const fixture = yield* windowsFixture;
      const release = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      fixture.state.beforeProbe = Deferred.await(release);
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                timeoutMs: 120_000,
              }),
            ),
          ),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo started" });
          yield* Queue.take(fixture.probes);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* Deferred.succeed(release, undefined);
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("refuses a later POSIX holder when launch identity was not recorded", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-reused");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "echo original" }),
      ).pipe(Effect.provide(fixture.layer));
      const sql = yield* SqlClient.SqlClient;
      const laterAlive = DateTime.formatIso(DateTime.makeUnsafe(fixture.state.now + 300_000));
      yield* sql`UPDATE command_runs SET process_started_at = NULL, unit = NULL, last_alive_at = ${laterAlive} WHERE task_id = ${result.taskId}`;
      const pidFile = NodePath.join(NodePath.dirname(result.logPath), "pid");
      NodeFS.writeFileSync(pidFile, "2147483000");
      NodeFS.utimesSync(pidFile, fixture.state.now / 1_000, fixture.state.now / 1_000);
      const entry = fixture.processes.get(2147483000)!;
      entry.identity += 10_000;
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* nextWake(chat.threadId);
          const row = yield* commandRow(result.taskId);
          assert.equal(row?.lost_reason, "pid-reused");
          assert.isNull(row?.process_started_at);
          assert.isTrue(entry.alive);
          assert.equal(fixture.state.kills, 0);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(fixture.layer));
    }),
  );

  it.effect("trims POSIX logs while identity remains unavailable", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-posix-trim");
      const fixture = yield* windowsFixture;
      const fs = yield* FileSystem.FileSystem;
      const trimmed = yield* Deferred.make<void>();
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "echo original" }),
      ).pipe(Effect.provide(fixture.layer));
      fixture.state.unavailable = true;
      NodeFS.writeFileSync(result.logPath, Buffer.alloc(9_000_000, "x"));
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* Deferred.await(trimmed);
          assert.isBelow(NodeFS.statSync(result.logPath).size, 8 * 1024 * 1024);
          assert.equal((yield* commandRow(result.taskId))?.status, "running");
          assert.isTrue(fixture.processes.get(2147483000)!.alive);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
        }),
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map(
                (file) =>
                  new Proxy(file, {
                    get: (target, key) =>
                      key === "truncate"
                        ? (...args: Parameters<typeof file.truncate>) =>
                            file
                              .truncate(...args)
                              .pipe(Effect.tap(() => Deferred.succeed(trimmed, undefined)))
                        : Reflect.get(target, key, target),
                  }),
              ),
            ),
        }),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("logs a repeated stop failure once with its stderr and retries delivery", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-stderr");
      const fixture = yield* windowsFixture;
      const delivered = yield* Deferred.make<void>();
      let taskId = "";
      fixture.state.stopError = "injected stop access denied";
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message }) => {
        if (String(message).includes("command-runner.check-failed")) warnings.push(message);
      });
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), {
            command: "echo deadline",
            timeoutMinutes: 1,
          });
          taskId = result.taskId;
          fixture.state.now += 60_000;
          for (let pass = 0; pass < 4; pass++) yield* Queue.take(fixture.stopped);
          assert.equal(warnings.length, 1);
          assert.include(JSON.stringify(warnings), "injected stop access denied");
          assert.isNull((yield* commandRow(result.taskId))?.delivered_at);
          yield* nextWake(chat.threadId);
          assert.include(
            (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
            "cleanup is still pending",
          );
          fixture.state.stopError = "";
          yield* Deferred.await(delivered);
          assert.equal((yield* commandRow(result.taskId))?.status, "timed_out");
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(
          Layer.merge(fixture.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    }),
  );

  it.effect("persists cancellation once while a started launch response is held", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-write-once");
      const fixture = yield* windowsFixture;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const create = fixture.state.launch;
      fixture.state.stopError = "hold cleanup";
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.tap(() => Deferred.await(release)),
        );
      yield* sql`CREATE TEMP TABLE cancellation_writes (task_id TEXT)`;
      yield* sql`CREATE TEMP TRIGGER count_cancellation_writes AFTER UPDATE ON command_runs
        WHEN NEW.status = 'stopped' AND OLD.status <> 'stopped'
        BEGIN INSERT INTO cancellation_writes VALUES (NEW.task_id); END`;
      let taskId = "";
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo held", clientRequestId: "stop-write-once" };
          const launch = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const task = yield* runner.run(callerOf(chat.threadId), request);
          taskId = task.taskId;
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, taskId)),
            ),
          );
          for (let pass = 0; pass < 4; pass++) yield* Queue.take(fixture.stopped);
          const writes =
            yield* sql`SELECT task_id FROM cancellation_writes WHERE task_id = ${taskId}`;
          assert.lengthOf(writes, 1);
          fixture.state.stopError = "";
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(launch);
          yield* Deferred.await(delivered);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
      );
    }),
  );

  it.effect("checks healthy commands without starting an identity process on every pass", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-probe-budget");
      const fixture = yield* windowsFixture;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo watched" });
          for (let pass = 0; pass < 20; pass++) {
            yield* Queue.take(fixture.reads).pipe(
              Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
            );
          }
          assert.equal(fixture.state.probeCalls, 0);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("enforces a deadline while the identity probe is unavailable", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-deadline-probe");
      const fixture = yield* windowsFixture;
      const result = yield* withServer((runner) =>
        runner.run(callerOf(chat.threadId), { command: "echo timed", timeoutMinutes: 1 }),
      ).pipe(Effect.provide(fixture.layer));
      fixture.state.unavailable = true;
      fixture.state.now += 60_000;
      const delivered = yield* Deferred.make<void>();
      yield* withServer(() =>
        Effect.gen(function* () {
          yield* nextWake(chat.threadId);
          yield* Deferred.await(delivered);
          assert.equal((yield* commandRow(result.taskId))?.status, "timed_out");
          assert.equal(fixture.state.probeCalls, 0);
          assert.isFalse(fixture.processes.get(2147483000)!.alive);
        }),
      ).pipe(
        Effect.provideService(
          Statement.CurrentTransformer,
          observeDelivery(result.taskId, delivered),
        ),
        Effect.provide(fixture.layer),
      );
    }),
  );

  it.effect("allows new launches while a restart identity probe is held", () =>
    Effect.gen(function* () {
      const prior = yield* liveChat("launch-restart-held");
      const next = yield* liveChat("launch-restart-new");
      const fixture = yield* windowsFixture;
      const first = yield* withServer((runner) =>
        runner.run(callerOf(prior.threadId), { command: "echo prior" }),
      ).pipe(Effect.provide(fixture.layer));
      const release = yield* Deferred.make<void>();
      fixture.state.beforeProbe = Deferred.await(release);
      yield* withServer((runner) =>
        Effect.gen(function* () {
          yield* Queue.take(fixture.probes);
          const started = yield* runner.run(callerOf(next.threadId), { command: "echo new" });
          assert.equal(fixture.state.launches, 2);
          for (const result of [first, started])
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(result.logPath), "exit-status"),
              "0",
            );
          yield* Deferred.succeed(release, undefined);
          yield* wakesOf([prior.threadId, next.threadId]);
        }),
      ).pipe(Effect.provide(fixture.layer), Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  );

  it.effect("closes a held launch gate even when persisting cancellation fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-stop-write-error");
      const fixture = yield* windowsFixture;
      const sql = yield* SqlClient.SqlClient;
      const entered = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      let taskId = "";
      let ran = false;
      fixture.state.launch = (_input, directory) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, directory);
          yield* Deferred.await(release);
          ran = NodeFS.existsSync(NodePath.join(directory, "launch-pending"));
          return processOutput();
        });
      yield* sql`CREATE TEMP TRIGGER reject_stop BEFORE UPDATE ON command_runs WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(FAIL, 'injected stop write failure'); END`;
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo never", clientRequestId: "stop-write" };
          const pending = yield* runner
            .run(callerOf(chat.threadId), request)
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const retry = yield* runner.run(callerOf(chat.threadId), request);
          taskId = retry.taskId;
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, retry.taskId)),
            ),
          );
          yield* Queue.take(fixture.renamed).pipe(
            Effect.repeat({ until: (file) => NodePath.basename(file) === "launch-cancelled" }),
          );
          yield* sql`DROP TRIGGER reject_stop`;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          yield* Deferred.await(delivered);
          assert.isFalse(ran);
          assert.equal((yield* commandRow(retry.taskId))?.status, "stopped");
          assert.isNotNull((yield* commandRow(retry.taskId))?.delivered_at);
        }),
      ).pipe(
        Effect.provideService(Statement.CurrentTransformer, (...args) =>
          observeDelivery(taskId, delivered)(...args),
        ),
        Effect.provide(fixture.layer),
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.ensuring(sql`DROP TRIGGER IF EXISTS reject_stop`.pipe(Effect.orDie)),
      );
    }),
  );

  it.effect("uses the wrapper identity when the launcher reports a replacement 500 ms later", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-identity-disagrees");
      const fixture = yield* windowsFixture;
      const create = fixture.state.launch;
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.map((output) => {
            const entry = fixture.processes.get(2147483000)!;
            entry.identity += 500;
            return { ...output, stdout: `2147483000 ${entry.identity}` };
          }),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo original" });
          assert.equal((yield* commandRow(result.taskId))?.process_started_at, fixture.state.now);
          yield* Orchestrator.OrchestratorV2.pipe(
            Effect.flatMap((orchestrator) =>
              orchestrator.dispatch(cancellationOf(chat.threadId, result.taskId)),
            ),
          );
          yield* Queue.take(fixture.stopped);
          assert.isTrue(fixture.processes.get(2147483000)!.alive);
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "keeps a legacy launch with no evidence until its late wrapper publishes identity",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-legacy-late");
        const fixture = yield* windowsFixture;
        const first = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo legacy" }),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(first.taskId);
        const directory = NodePath.dirname(first.logPath);
        NodeFS.unlinkSync(NodePath.join(directory, "pid"));
        NodeFS.rmdirSync(NodePath.join(directory, "launch-started"));
        yield* Queue.takeAll(fixture.reads);
        yield* withServer(() =>
          Effect.gen(function* () {
            for (let pass = 0; pass < 3; pass++)
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "pid" }),
              );
            assert.equal((yield* commandRow(first.taskId))?.status, "running");
            assert.isNull((yield* commandRow(first.taskId))?.delivered_at);
            NodeFS.writeFileSync(
              NodePath.join(directory, "pid"),
              `2147483000 ${fixture.state.now}`,
            );
            yield* Queue.take(fixture.probes);
            NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("settles a defective launch and rejects NUL commands before allocating a task", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-defect");
      const fixture = yield* windowsFixture;
      fixture.state.launch = () => Effect.die(new Error("injected spawn defect"));
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const invalid = yield* runner
            .run(callerOf(chat.threadId), { command: "echo \0" })
            .pipe(Effect.result);
          assert.equal(invalid._tag, "Failure");
          assert.equal(fixture.state.launches, 0);
          const result = yield* runner.run(callerOf(chat.threadId), { command: "echo failure" });
          yield* nextWake(chat.threadId);
          assert.equal((yield* commandRow(result.taskId))?.status, "unstarted");
          assert.equal(
            (yield* taskOf(chat.threadId, result.taskId))?.result,
            `Could not start the command: injected spawn defect\nNo output.\nFull output: ${result.logPath}`,
          );
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect(
    "cancels a held launch while other commands meet their deadlines and deliver completion",
    () =>
      Effect.gen(function* () {
        const held = yield* liveChat("launch-held");
        const deadline = yield* liveChat("launch-other-deadline");
        const completed = yield* liveChat("launch-other-completion");
        const fixture = yield* windowsFixture;
        const entered = yield* Deferred.make<string>();
        const release = yield* Deferred.make<void>();
        const create = fixture.state.launch;
        let ran = false;
        fixture.state.launch = (input, directory) =>
          !input.args.some((arg) => arg.includes(held.workspace))
            ? create(input, directory)
            : Effect.gen(function* () {
                yield* Deferred.succeed(entered, directory);
                yield* Deferred.await(release);
                if (NodeFS.existsSync(NodePath.join(directory, "launch-pending"))) {
                  ran = true;
                  return yield* create(input, directory);
                }
                return processOutput(`2147483001 ${DateTime.toEpochMillis(yield* DateTime.now)}`);
              });
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const request = { command: "echo held", clientRequestId: "held" };
            const pending = yield* runner
              .run(callerOf(held.threadId), request)
              .pipe(Effect.forkChild);
            const directory = yield* Deferred.await(entered);
            yield* Effect.gen(function* () {
              // The clock advances while the unrelated launcher stays behind its barrier.
              const due = yield* runner.run(callerOf(deadline.threadId), {
                command: "echo deadline",
                timeoutMinutes: 1,
              });
              fixture.state.now += 60_000;
              yield* nextWake(deadline.threadId);
              assert.equal((yield* commandRow(due.taskId))?.status, "timed_out");
              const done = yield* runner.run(callerOf(completed.threadId), {
                command: "echo completed",
              });
              NodeFS.writeFileSync(
                NodePath.join(NodePath.dirname(done.logPath), "exit-status"),
                "0",
              );
              yield* nextWake(completed.threadId);
              assert.equal((yield* taskOf(completed.threadId, done.taskId))?.status, "completed");
              const same = yield* runner.run(callerOf(held.threadId), request);
              yield* Orchestrator.OrchestratorV2.pipe(
                Effect.flatMap((orchestrator) =>
                  orchestrator.dispatch(cancellationOf(held.threadId, same.taskId)),
                ),
              );
              yield* Queue.take(fixture.renamed).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "launch-cancelled" }),
              );
              yield* runner.run(callerOf(held.threadId), request);
              const row = yield* commandRow(same.taskId);
              assert.equal(row?.status, "stopped");
              assert.isNotNull(row?.delivered_at);
              assert.isTrue(NodeFS.existsSync(NodePath.join(directory, "launch-cancelled")));
            }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
            const result = yield* Fiber.join(pending);
            assert.isFalse(ran);
            assert.equal((yield* commandRow(result.taskId))?.status, "stopped");
            assert.equal(fixture.state.launches, 3);
            assert.equal(fixture.state.kills, 1);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect(
    "retries a failed gate recovery on a later tick and keeps request retries idempotent",
    () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("launch-gate-error");
        const fixture = yield* windowsFixture;
        fixture.state.failGate = true;
        fixture.state.launch = (input) =>
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            }),
          );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const request = { command: "echo never", clientRequestId: "gate-error" };
            const first = yield* runner.run(callerOf(chat.threadId), request);
            assert.isNull((yield* commandRow(first.taskId))?.pid);
            assert.equal(
              (yield* runner.run(callerOf(chat.threadId), request)).taskId,
              first.taskId,
            );
            fixture.state.failGate = false;
            yield* nextWake(chat.threadId);
            assert.equal((yield* commandRow(first.taskId))?.status, "unstarted");
            assert.match(
              (yield* taskOf(chat.threadId, first.taskId))?.result ?? "",
              /^Could not start the command: .*timed out/,
            );
            assert.equal(fixture.state.launches, 1);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("keeps recovery watched when its database write fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-recovery-write-error");
      const fixture = yield* windowsFixture;
      const create = fixture.state.launch;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TEMP TRIGGER reject_recovery BEFORE UPDATE ON command_runs
      WHEN NEW.pid IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected recovery write failure'); END`;
      fixture.state.launch = (input, directory) =>
        create(input, directory).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                timeoutMs: 120_000,
              }),
            ),
          ),
        );
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const request = { command: "echo recovered", clientRequestId: "write-error" };
          const first = yield* runner.run(callerOf(chat.threadId), request);
          assert.isNull((yield* commandRow(first.taskId))?.pid);
          assert.equal((yield* runner.run(callerOf(chat.threadId), request)).taskId, first.taskId);
          yield* sql`DROP TRIGGER reject_recovery`;
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(first.logPath), "exit-status"), "0");
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, first.taskId))?.status, "completed");
          assert.equal((yield* commandRow(first.taskId))?.pid, 2147483000);
          assert.equal(fixture.state.launches, 1);
        }),
      ).pipe(
        Effect.provide(fixture.layer),
        Effect.ensuring(sql`DROP TRIGGER IF EXISTS reject_recovery`.pipe(Effect.orDie)),
      );
    }),
  );

  it.effect.each([true, false])(
    "reports a cancelled gate as unstarted with wrapper alive %s",
    (alive) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-cancel-wins-${alive}`);
        const fixture = yield* windowsFixture;
        fixture.state.launch = (input, directory) =>
          Effect.gen(function* () {
            const identity = DateTime.toEpochMillis(yield* DateTime.now);
            fixture.processes.set(2147483000, { identity, alive, directory });
            NodeFS.writeFileSync(NodePath.join(directory, "pid"), `2147483000 ${identity}`);
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            });
          });
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const result = yield* runner.run(callerOf(chat.threadId), { command: "echo never" });
            yield* nextWake(chat.threadId);
            assert.equal((yield* commandRow(result.taskId))?.status, "unstarted");
            assert.match(
              (yield* taskOf(chat.threadId, result.taskId))?.result ?? "",
              /^Could not start the command:/,
            );
            assert.equal(fixture.state.kills, 0);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect.each(["pending", "started", "cancelled"] as const)(
    "adopts a pid-null row at the %s gate boundary",
    (gate) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-restart-${gate}`);
        const fixture = yield* windowsFixture;
        fixture.state.failGate = true;
        fixture.state.launch = (input) =>
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: 120_000,
            }),
          );
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo recovered" }),
        ).pipe(Effect.provide(fixture.layer));
        const directory = NodePath.dirname(result.logPath);
        const identity = DateTime.toEpochMillis(yield* DateTime.now);
        fixture.processes.set(2147483000, { identity, alive: true, directory });
        NodeFS.writeFileSync(NodePath.join(directory, "pid"), `2147483000 ${identity}`);
        if (gate !== "pending")
          NodeFS.renameSync(
            NodePath.join(directory, "launch-pending"),
            NodePath.join(directory, `launch-${gate}`),
          );
        fixture.state.failGate = false;
        yield* withServer(() =>
          Effect.gen(function* () {
            if (gate === "started") {
              yield* Queue.take(fixture.probes);
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
              );
              yield* Queue.take(fixture.reads).pipe(
                Effect.repeat({ until: (file) => NodePath.basename(file) === "exit-status" }),
              );
              assert.equal((yield* commandRow(result.taskId))?.pid, 2147483000);
              NodeFS.writeFileSync(NodePath.join(directory, "exit-status"), "0");
            }
            yield* nextWake(chat.threadId);
            assert.equal(
              (yield* commandRow(result.taskId))?.status,
              gate === "started" ? "exited" : "unstarted",
            );
            assert.equal(fixture.state.kills, 0);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect.each(["identity", "pid-only"] as const)(
    "leaves a reused pid unresolved while its probe is unavailable, %s file",
    (format) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`launch-reused-${format}`);
        const fixture = yield* windowsFixture;
        const result = yield* withServer((runner) =>
          runner.run(callerOf(chat.threadId), { command: "echo original" }),
        ).pipe(Effect.provide(fixture.layer));
        yield* forgetPid(result.taskId);
        const entry = fixture.processes.get(2147483000)!;
        entry.identity += 10_000;
        fixture.state.unavailable = true;
        if (format === "pid-only") {
          const file = NodePath.join(entry.directory, "pid");
          NodeFS.writeFileSync(file, "2147483000");
          NodeFS.utimesSync(file, fixture.state.now / 1_000, fixture.state.now / 1_000);
        }
        yield* withServer(() =>
          Effect.gen(function* () {
            yield* Queue.take(fixture.probes);
            yield* Queue.take(fixture.probes);
            const unresolved = yield* commandRow(result.taskId);
            assert.isNull(unresolved?.pid);
            assert.equal(unresolved?.status, "running");
            assert.equal(fixture.state.kills, 0);
            assert.isTrue(entry.alive);
            NodeFS.writeFileSync(NodePath.join(entry.directory, "exit-status"), "0");
            fixture.state.unavailable = false;
            yield* nextWake(chat.threadId);
            assert.isTrue(entry.alive);
            assert.equal(fixture.state.kills, 0);
          }),
        ).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("does not lose or stop a command when reading its exit status fails", () =>
    Effect.gen(function* () {
      const chat = yield* liveChat("launch-status-unreadable");
      const fixture = yield* windowsFixture;
      fixture.state.failRead = "exit-status";
      yield* withServer((runner) =>
        Effect.gen(function* () {
          const result = yield* runner.run(callerOf(chat.threadId), {
            command: "echo completed",
            timeoutMinutes: 1,
          });
          fixture.state.now += 60_000;
          yield* Queue.take(fixture.reads);
          yield* Queue.take(fixture.reads);
          assert.equal((yield* commandRow(result.taskId))?.status, "running");
          assert.equal(fixture.state.kills, 0);
          NodeFS.writeFileSync(NodePath.join(NodePath.dirname(result.logPath), "exit-status"), "0");
          fixture.state.failRead = "";
          yield* nextWake(chat.threadId);
          assert.equal((yield* taskOf(chat.threadId, result.taskId))?.status, "completed");
        }),
      ).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect.each(["read", "stat"] as const)(
    "keeps a started command watched when its pid %s fails, then resolves without a restart",
    (operation) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(`command-pid-${operation}-failure`);
        const fs = yield* FileSystem.FileSystem;
        const request = { command: "echo recovered", clientRequestId: `pid-${operation}-failure` };
        let unreadable = true;
        let launches = 0;
        const error = new PlatformError.PlatformError(
          new PlatformError.SystemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: operation,
          }),
        );
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const first = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.result);
            assert.equal(first._tag, "Success", "ambiguous launch must remain an app-owned task");
            if (first._tag === "Failure") return yield* first.failure;
            assert.isNull((yield* commandRow(first.success.taskId))?.pid);
            const retried = yield* runner.run(callerOf(chat.threadId), request);
            assert.equal(retried.taskId, first.success.taskId);
            assert.equal(launches, 1);
            unreadable = false;
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(first.success.logPath), "exit-status"),
              "0",
            );
            yield* nextWake(chat.threadId);
            assert.equal((yield* taskOf(chat.threadId, first.success.taskId))?.status, "completed");
          }),
        ).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(WindowsJobHost, Effect.succeed("job-host.exe")),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, ...args) =>
              unreadable && operation === "read" && NodePath.basename(file) === "pid"
                ? Effect.fail(error)
                : fs.readFileString(file, ...args),
            stat: (file) =>
              unreadable && operation === "stat" && NodePath.basename(file) === "pid"
                ? Effect.fail(error)
                : fs.stat(file),
          }),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.gen(function* () {
                if (input.command === "job-host.exe" && input.args[0] === "stop")
                  return processOutput();
                assert.isTrue(
                  input.args.some((arg) => arg.includes("Win32_Process -MethodName Create")),
                );
                launches++;
                const wrapper = /-File "(.+run\.ps1)"/.exec(input.args.join(" "))?.[1];
                assert.isDefined(wrapper);
                const directory = NodePath.dirname(wrapper!);
                NodeFS.writeFileSync(
                  NodePath.join(directory, "pid"),
                  `2147483000 ${DateTime.toEpochMillis(yield* DateTime.now)}`,
                );
                NodeFS.renameSync(
                  NodePath.join(directory, "launch-pending"),
                  NodePath.join(directory, "launch-started"),
                );
                return yield* new ProcessRunner.ProcessTimeoutError({
                  command: input.command,
                  argumentCount: input.args.length,
                  timeoutMs: 120_000,
                });
              }),
          }),
        );
      }),
  );
});

// A Windows wrapper that ended leaves what it started running under a dead parent pid.
describe.runIf(isWindowsHost)("Windows only", () => {
  it.layer(layerTest, { excludeTestServices: true })("Windows launch timeouts", (it) => {
    it.effect.each(["cancelled", "sharing-error"] as const)(
      "writes a %s gate failure to the command log",
      (reason) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(`command-gate-output-${reason}`);
          const processRunner = yield* ProcessRunner.ProcessRunner;
          yield* withServer((runner) =>
            Effect.gen(function* () {
              const result = yield* runner.run(callerOf(chat.threadId), {
                command: "Set-Content -LiteralPath ran -Value 1",
              });
              yield* nextWake(chat.threadId);
              const task = yield* taskOf(chat.threadId, result.taskId);
              assert.equal(task?.status, "failed");
              assert.include(
                task?.result ?? "",
                reason === "cancelled"
                  ? "Command launch was cancelled before it started"
                  : "Could not take the command start gate:",
              );
              assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
            }),
          ).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) =>
                Effect.gen(function* () {
                  if (input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))) {
                    const wrapper = /-File "(.+run\.ps1)"/.exec(input.args.join(" "))![1]!;
                    const directory = NodePath.dirname(wrapper);
                    if (reason === "cancelled")
                      NodeFS.renameSync(
                        NodePath.join(directory, "launch-pending"),
                        NodePath.join(directory, "launch-cancelled"),
                      );
                    else
                      NodeFS.writeFileSync(
                        NodePath.join(directory, "launch-started"),
                        "blocks the directory rename",
                      );
                  }
                  return yield* processRunner.run(input);
                }),
            }),
          );
        }),
    );

    it.effect.each([false, true])(
      "adopts a command when its launcher times out after starting it, retry %s",
      (retry) =>
        Effect.gen(function* () {
          const chat = yield* liveChat(`command-win-launch-adopt-${retry}`);
          NodeFS.writeFileSync(
            NodePath.join(chat.workspace, "command.cjs"),
            [
              'const fs = require("node:fs");',
              'const watcher = fs.watch(".", () => { if (fs.existsSync("go")) { watcher.close(); console.log("adopted"); } });',
              'fs.appendFileSync("starts", "1");',
              'fs.writeFileSync("ready", "");',
            ].join("\n"),
          );
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const request = {
            command: `& '${process.execPath}' command.cjs`,
            clientRequestId: `launch-adopt-${retry}`,
          };
          const adopted = yield* Deferred.make<void>();
          const delivered = yield* Deferred.make<void>();

          let taskId = "";
          let launches = 0;
          const started = yield* withServer((runner) =>
            Effect.gen(function* () {
              const first = yield* runner.run(callerOf(chat.threadId), request).pipe(Effect.result);
              assert.equal(first._tag, "Success");
              if (first._tag === "Failure") return yield* first.failure;
              taskId = first.success.taskId;

              if ((yield* commandRow(taskId))?.pid === null) yield* Deferred.await(adopted);
              const row = yield* commandRow(taskId);
              assert.equal(row?.status, "running");
              assert.isAbove(row?.pid ?? 0, 0);
              assert.isNumber(row?.process_started_at);

              if (retry) {
                const second = yield* runner.run(callerOf(chat.threadId), request);
                assert.equal(second.taskId, first.success.taskId);
                assert.equal(second.logPath, first.success.logPath);
              }
              assert.equal(launches, 1);
              assert.equal(
                NodeFS.readFileSync(NodePath.join(chat.workspace, "starts"), "utf8"),
                "1",
              );

              NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
              yield* nextWake(chat.threadId);

              yield* Deferred.await(delivered);
              return first.success;
            }),
          ).pipe(
            Effect.provideService(Statement.CurrentTransformer, (...args) => {
              const [, params] = args[0].compile();
              return params[6] == null
                ? observeDelivery(taskId, adopted, "pid")(...args)
                : observeDelivery(taskId, delivered)(...args);
            }),
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) => {
                if (!input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))) {
                  return processRunner.run(input);
                }
                launches++;
                return processRunner.run(input).pipe(
                  Effect.andThen(awaitFile(NodePath.join(chat.workspace, "ready"))),
                  Effect.andThen(
                    Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: input.command,
                        argumentCount: input.args.length,
                        timeoutMs: 120_000,
                      }),
                    ),
                  ),
                );
              },
            }),
          );
          const task = yield* taskOf(chat.threadId, started.taskId);
          assert.equal(task?.status, "completed");
          assert.include(task?.result ?? "", "adopted");
        }),
    );

    it.effect(
      "a launcher timeout before Create prevents even a late WMI request from running the command",
      () =>
        Effect.gen(function* () {
          const chat = yield* liveChat("command-win-launch-before-create");
          const processRunner = yield* ProcessRunner.ProcessRunner;
          const launcher = yield* Deferred.make<ProcessRunner.ProcessRunInput>();
          const refused = yield* withServer((runner) =>
            runner
              .run(callerOf(chat.threadId), {
                command: "Set-Content -LiteralPath ran -Value 1",
                clientRequestId: "launch-before-create",
              })
              .pipe(Effect.tap(() => nextWake(chat.threadId))),
          ).pipe(
            Effect.provideService(ProcessRunner.ProcessRunner, {
              run: (input) =>
                !input.args.some((arg) => arg.includes("Win32_Process -MethodName Create"))
                  ? processRunner.run(input)
                  : Deferred.succeed(launcher, input).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ProcessRunner.ProcessTimeoutError({
                            command: input.command,
                            argumentCount: input.args.length,
                            timeoutMs: 120_000,
                          }),
                        ),
                      ),
                    ),
            }),
          );
          assert.match(
            (yield* taskOf(chat.threadId, refused.taskId))?.result ?? "",
            /^Could not start the command: .*timed out/,
          );
          const launch = yield* Deferred.await(launcher);
          const runPath = /-File "(.+run\.ps1)"/.exec(launch.args.join(" "))?.[1];
          assert.isDefined(runPath);
          // WMI can finish Create after its caller has been killed.
          const late = yield* processRunner.run(launch);
          assert.equal(late.code, 0);
          const pid = Number.parseInt(late.stdout.trim(), 10);
          assert.isAbove(pid, 0);
          yield* awaitFile(NodePath.join(NodePath.dirname(runPath!), "exit-status"));
          // cmd publishes its status before exiting; Windows keeps its working directory open until then.
          const exited = yield* processRunner.run({
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$ErrorActionPreference = 'Stop'; $wrapper = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($wrapper) { $wrapper.WaitForExit() }; exit 0`,
            ],
            timeout: Duration.minutes(2),
          });
          assert.equal(exited.code, 0, exited.stderr);
          assert.isFalse(NodeFS.existsSync(NodePath.join(chat.workspace, "ran")));
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            yield* sql`SELECT status FROM command_runs WHERE thread_id = ${chat.threadId}`,
            [{ status: "unstarted" }],
          );
        }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("a Windows command's console", (it) => {
    // Send returns once the command's own handler has the event, and takes it so the command goes on.
    // No API sends a close event, which ends every process in its console with STATUS_CONTROL_C_EXIT;
    // Close ends the others the same way. Windows PowerShell compiles this as C# 5.
    const consoleApi = [
      "Add-Type -Namespace T3Test -Name Console -MemberDefinition '",
      '[DllImport("kernel32.dll")] private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);',
      "public delegate bool Handler(uint ctrlEvent);",
      '[DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(Handler handler, bool add);',
      "private static readonly System.Threading.ManualResetEvent got = new System.Threading.ManualResetEvent(false);",
      "private static uint wanted;",
      "private static readonly Handler take = ctrlEvent => { if (ctrlEvent != wanted) return false; got.Set(); return true; };",
      "public static bool Send(uint ctrlEvent) { wanted = ctrlEvent; return SetConsoleCtrlHandler(null, false) && SetConsoleCtrlHandler(take, true) && GenerateConsoleCtrlEvent(ctrlEvent, 0) && got.WaitOne(60000); }",
      '[DllImport("kernel32.dll")] private static extern uint GetConsoleProcessList(uint[] processes, uint count);',
      '[DllImport("kernel32.dll")] private static extern System.IntPtr OpenProcess(uint access, bool inherit, uint id);',
      '[DllImport("kernel32.dll")] private static extern bool TerminateProcess(System.IntPtr process, uint code);',
      "public static uint Close() { var processes = new uint[64]; var count = GetConsoleProcessList(processes, 64); if (count > 64) return 0; var self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id; for (uint i = 0; i < count; i++) { if (processes[i] != self && !TerminateProcess(OpenProcess(1, false, processes[i]), 0xC000013A)) return 0; } return count; }",
      "'",
    ].join("\n");
    it.effect.each([
      ["Ctrl+C", "command-win-ctrl-c", 0],
      ["Ctrl+Break", "command-win-ctrl-break", 1],
    ] as const)("records the exit status of a command whose console gets %s", ([, name, event]) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              command: [
                consoleApi,
                `if (-not [T3Test.Console]::Send(${event})) { exit 90 }`,
                "exit 3",
              ].join("\n"),
            });
            yield* nextWake(chat.threadId);
            const row = yield* commandRow(started.taskId);
            assert.equal(row?.status, "exited");
            assert.equal(row?.exit_code, 3);
          }),
        );
      }),
    );

    it.effect("records the exit status of a command whose console closes", () =>
      Effect.gen(function* () {
        const chat = yield* liveChat("command-win-console-closed");
        yield* withServer((runner) =>
          Effect.gen(function* () {
            const started = yield* runner.run(callerOf(chat.threadId), {
              // Its console holds cmd and this PowerShell, so a count below 2 means Close ended nothing.
              command: [
                consoleApi,
                "if ([T3Test.Console]::Close() -lt 2) { exit 93 }",
                "exit 94",
              ].join("\n"),
            });
            yield* nextWake(chat.threadId);
            const row = yield* commandRow(started.taskId);
            assert.equal(row?.status, "exited");
            // cmd's own STATUS_CONTROL_C_EXIT, as 0xC000013A reads in an Int32.
            assert.equal(row?.exit_code, -1073741510);
          }),
        );
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })("a Windows command's bash", (it) => {
    const system = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const powershellFolder = NodePath.join(system, "WindowsPowerShell", "v1.0");
    const installFolders = ["PROGRAMFILES", "PROGRAMW6432", "PROGRAMFILES(X86)", "LOCALAPPDATA"];
    // WSL's bash has no cygpath, and prints /usr/bin/node or /mnt/c/... for node. Git Bash shows
    // a HOME under TEMP as /tmp/..., so the home is compared as a Windows path.
    const nodeAndHome = "'command -v node; cygpath -w $HOME'";
    const isFolder = (printed: string | undefined, folder: string) =>
      NodeFS.realpathSync.native(printed ?? "").toLowerCase() ===
      NodeFS.realpathSync.native(folder).toLowerCase();
    const without = (env: Readonly<Record<string, string>>, names: ReadonlyArray<string>) =>
      Object.fromEntries(
        Object.entries(env).filter(([name]) => !names.includes(name.toUpperCase())),
      );
    const withNodeAndHome = ({
      inherited,
      workspace,
      otherBash,
    }: {
      readonly inherited: Readonly<Record<string, string>>;
      readonly workspace: string;
      readonly otherBash: string;
    }) => ({
      ...without(inherited, ["PATH", "HOME"]),
      HOME: workspace,
      PATH: [
        otherBash,
        NodePath.dirname(process.execPath),
        Object.entries(inherited).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "",
      ].join(";"),
    });
    const runBash = (
      name: string,
      input: { readonly command: string; readonly shell?: "bash" },
      env: (setup: {
        readonly inherited: Readonly<Record<string, string>>;
        readonly workspace: string;
        /** Not Git Bash, and first on PATH, as System32's WSL bash.exe often is. */
        readonly otherBash: string;
        /** A folder that does not exist. */
        readonly nowhere: string;
        /** Install variables that name no Git. */
        readonly noInstalls: Record<string, string>;
      }) => Record<string, string>,
    ) =>
      Effect.gen(function* () {
        const chat = yield* liveChat(name);
        const otherBash = NodePath.join(chat.workspace, "other-bash");
        NodeFS.mkdirSync(otherBash);
        NodeFS.copyFileSync(
          NodePath.join(system, "whoami.exe"),
          NodePath.join(otherBash, "bash.exe"),
        );
        const nowhere = NodePath.join(chat.workspace, "nowhere");
        const noInstalls = {
          ProgramFiles: nowhere,
          ProgramW6432: nowhere,
          "ProgramFiles(x86)": nowhere,
          LOCALAPPDATA: nowhere,
        };
        const started = yield* withServer((runner) =>
          runner
            .run(callerOf(chat.threadId), input)
            .pipe(Effect.tap(() => nextWake(chat.threadId))),
        ).pipe(
          Effect.provide(
            providerShell((_cwd, inherited) =>
              Effect.succeed(
                env({ inherited, workspace: chat.workspace, otherBash, nowhere, noInstalls }),
              ),
            ),
          ),
        );
        return {
          row: yield* commandRow(started.taskId),
          lines: NodeFS.readFileSync(started.logPath, "utf8").trim().split(/\r?\n/),
          workspace: chat.workspace,
        };
      });

    it.effect(
      "runs Git Bash for bash and sh, with or without .exe, which see the Windows home and node and take the command's arguments and input",
      () =>
        Effect.gen(function* () {
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-bash",
            {
              command: [
                `bash -c ${nodeAndHome}`,
                `sh -c ${nodeAndHome}`,
                `bash.exe -c ${nodeAndHome}`,
                "bash -c 'echo $1 $2' zero -- one",
                "'piped' | sh.exe -c 'cat; echo to-stderr >&2; exit 7'",
              ].join("; "),
            },
            withNodeAndHome,
          );
          assert.lengthOf(lines, 9);
          for (const [node, printedHome] of [
            lines.slice(0, 2),
            lines.slice(2, 4),
            lines.slice(4, 6),
          ]) {
            assert.match(node ?? "", /^\/[a-z]\/.+\/node(\.exe)?$/i);
            assert.isTrue(isFolder(printedHome, workspace), `${printedHome} is not the workspace`);
          }
          // Every argument as written, then plain lines, not PowerShell error records, and Git
          // Bash's own exit code.
          assert.deepEqual(lines.slice(6), ["-- one", "piped", "to-stderr"]);
          assert.equal(row?.exit_code, 7);
        }),
    );

    // Through PowerShell's `bash -c`, this grep lost its file and waited on the console for input.
    it.effect(
      "runs a bash command in Git Bash as written, double quotes included, in its cwd, with no input",
      () =>
        Effect.gen(function* () {
          const { row, lines, workspace } = yield* runBash(
            "command-win-shell-bash",
            {
              shell: "bash",
              command: [
                "printf '# pass 1\\n# fail 2\\nok 3\\n' > results.txt",
                'grep -E "^# (pass|fail)" results.txt',
                `echo "$(printf '%s' "a \\"b\\"")" 'c d' \\\\`,
                "cat",
                'echo "cat: $?"',
                'cygpath -w "$PWD"',
                "command -v node",
                "exit 5",
              ].join("\n"),
            },
            withNodeAndHome,
          );
          assert.deepEqual(lines.slice(0, 4), ["# pass 1", "# fail 2", 'a "b" c d \\', "cat: 0"]);
          assert.isTrue(isFolder(lines[4], workspace), `${lines[4]} is not the workspace`);
          assert.match(lines[5] ?? "", /^\/[a-z]\/.+\/node(\.exe)?$/i);
          assert.equal(row?.exit_code, 5);
        }),
    );

    it.effect(
      "finds Git Bash through a git that only the command's PATH names, in any case and whatever GIT_EXEC_PATH says, and leaves git to it",
      () =>
        Effect.gen(function* () {
          const git = NodeChildProcess.execFileSync("where.exe", ["git"], { encoding: "utf8" })
            .split(/\r?\n/)[0]!
            .trim();
          let calls = "";
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-shim",
            { command: "git --version; bash -c 'cygpath -w $HOME'" },
            ({ inherited, workspace, otherBash, nowhere, noInstalls }) => {
              // A launcher outside the install, as a package manager's shim is.
              const shim = NodePath.join(workspace, "git-shim");
              NodeFS.mkdirSync(shim, { recursive: true });
              calls = NodePath.join(shim, "calls.txt");
              NodeFS.writeFileSync(
                NodePath.join(shim, "git.cmd"),
                `@echo %*>>"%~dp0calls.txt"\r\n@"${git}" %*\r\n`,
              );
              return {
                ...without(inherited, ["PATH", "HOME", "GIT_EXEC_PATH", ...installFolders]),
                ...noInstalls,
                HOME: workspace,
                GIT_EXEC_PATH: nowhere,
                pAtH: [otherBash, shim, system, powershellFolder].join(";"),
              };
            },
          );
          assert.isTrue(isFolder(lines.at(-1), workspace), `${lines.at(-1)} is not the workspace`);
          // The command's own git is still the shim, not the git beside Git Bash.
          assert.deepEqual(NodeFS.readFileSync(calls, "utf8").trim().split(/\r?\n/), [
            "--exec-path",
            "--version",
          ]);
          assert.equal(row?.exit_code, 0);
        }),
    );

    it.effect(
      "stops a git that does not answer, with what it started, and finds Git Bash in the install folders",
      () =>
        Effect.gen(function* () {
          let childPidFile = "";
          const { row, lines, workspace } = yield* runBash(
            "command-win-git-hangs",
            { command: "bash -c 'cygpath -w $HOME'" },
            ({ inherited, workspace, otherBash }) => {
              // A shim whose git never answers, in a child of the shim as git.cmd's git is.
              const shim = NodePath.join(workspace, "git-shim");
              NodeFS.mkdirSync(shim, { recursive: true });
              childPidFile = NodePath.join(shim, "child.pid");
              NodeFS.writeFileSync(
                NodePath.join(shim, "git.cmd"),
                `@powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${childPidFile}' -Value $PID; Start-Sleep 300"\r\n`,
              );
              return {
                ...without(inherited, ["PATH", "HOME"]),
                HOME: workspace,
                PATH: [otherBash, shim, system, powershellFolder].join(";"),
              };
            },
          );
          const childPid = Number.parseInt(NodeFS.readFileSync(childPidFile, "utf8"), 10);
          const left = stillRunning(childPid);
          if (left) process.kill(childPid); // still runs here
          assert.isFalse(left);
          assert.include(lines[0] ?? "", "did not answer within 10 s");
          assert.isTrue(isFolder(lines.at(-1), workspace), `${lines.at(-1)} is not the workspace`);
          assert.equal(row?.exit_code, 0);
        }),
    );

    it.effect.each([
      ["bash in PowerShell", "command-win-no-git-bash", { command: `bash -c ${nodeAndHome}` }],
      ["shell bash", "command-win-no-git-bash-shell", { command: "echo ran", shell: "bash" }],
    ] as const)("fails naming Git Bash when it finds none, for %s", ([, name, input]) =>
      Effect.gen(function* () {
        const { row, lines } = yield* runBash(
          name,
          input,
          ({ inherited, otherBash, noInstalls }) => ({
            ...without(inherited, ["PATH", ...installFolders]),
            ...noInstalls,
            PATH: [otherBash, system, powershellFolder].join(";"),
          }),
        );
        assert.include(lines.join("\n"), "bash: no Git Bash found");
        assert.equal(row?.exit_code, 127);
      }),
    );
  });

  it.layer(layerTest, { excludeTestServices: true })(
    "a Windows command whose wrapper ended",
    (it) => {
      it.effect.each([
        ["its task is cancelled", "command-win-cancelled", true],
        ["it is found without its wrapper", "command-win-lost", false],
      ] as const)("leaves nothing running when %s", ([, name, cancelled]) =>
        Effect.gen(function* () {
          // The commands are PowerShell: other platforms have their own wrapper, tested above.
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
          assert.isTrue(isProcessAlive(childPid));
          // Only the wrapper, as a stop cut by a restart leaves it.
          // oxlint-disable-next-line t3code/no-raw-taskkill -- this stops the wrapper alone on purpose
          NodeChildProcess.execFileSync("taskkill", [
            "/PID",
            String((yield* commandRow(started.taskId))!.pid),
            "/F",
          ]);
          const delivered = yield* Deferred.make<void>();
          if (cancelled) {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch(cancellationOf(chat.threadId, started.taskId));
          }
          yield* withServer(() =>
            Effect.gen(function* () {
              if (!cancelled) yield* nextWake(chat.threadId);
              yield* Deferred.await(delivered);
            }),
          ).pipe(
            Effect.provideService(
              Statement.CurrentTransformer,
              observeDelivery(started.taskId, delivered),
            ),
          );
          assert.equal((yield* commandRow(started.taskId))?.status, cancelled ? "stopped" : "lost");
          assert.isFalse(stillRunning(childPid));
        }),
      );
    },
  );
});
