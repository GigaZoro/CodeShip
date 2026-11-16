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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
      readonly started_at: string;
      readonly delivered_at: string | null;
      readonly last_alive_at: string | null;
      readonly probe_error: string | null;
      readonly lost_reason: string | null;
      readonly lost_output: string | null;
    }>`
      SELECT status, exit_code, pid, started_at, delivered_at, last_alive_at, probe_error, lost_reason,
        lost_output
      FROM command_runs WHERE task_id = ${taskId}
    `;
    return rows[0];
  });

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
const ORPHANING_COMMAND = `echo orphaning; ${STOP_NOTING_CHILD} until [ -e go ]; do sleep 0.05; done; kill -9 $PPID; echo > orphaned; wait`;

// Tests of sh, kill and process groups skip on Windows, which lacks them. Its wrapper's stop and lost paths are
// tested in "a Windows command whose wrapper ended".

// Real processes and the real clock: the runner watches commands on a wall-clock interval.
it.layer(layerTest, { excludeTestServices: true })("a command run apart from its agent", (it) => {
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
                }),
            ),
          ),
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
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
          Effect.flip,
          Effect.provideService(
            ProcessRunner.ProcessRunner,
            refuseWindowsLaunch(processRunner, launcher),
          ),
          Effect.provideService(HostProcess.Platform, "win32"),
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
          const probes = yield* Queue.unbounded<void>();
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
                Queue.offerUnsafe(probes, undefined);
                throw Object.assign(new Error(`kill EIO ${pid}`), { code: "EIO" });
              });
              yield* Effect.addFinalizer(() => Effect.sync(() => probe.mockRestore()));
              NodeFS.writeFileSync(NodePath.join(chat.workspace, "go"), "");
              yield* awaitFile(NodePath.join(chat.workspace, "orphaned"));
              // Its wrapper is gone, and the check that made the first later probe has finished.
              yield* Queue.clear(probes);
              yield* Queue.take(probes);
              yield* Queue.take(probes);
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
        // A run waits until the server has adopted what the earlier one left.
        yield* withServer((runner) => runner.run(callerOf(chat.threadId), { command: "true" }));
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

// A Windows wrapper that ended leaves what it started running under a dead parent pid.
describe.runIf(isWindowsHost)("Windows only", () => {
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
          yield* Effect.addFinalizer(() =>
            Effect.try({
              try: () => process.kill(childPid),
              catch: (cause) => new ProcessCleanupError({ cause }),
            }).pipe(Effect.ignore),
          );
          // Only the wrapper, as a stop cut by a restart leaves it.
          // oxlint-disable-next-line t3code/no-raw-taskkill -- this stops the wrapper alone on purpose
          NodeChildProcess.execFileSync("taskkill", [
            "/PID",
            String((yield* commandRow(started.taskId))!.pid),
            "/F",
          ]);
          assert.isTrue(isProcessAlive(childPid));
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
});
