// @effect-diagnostics nodeBuiltinImport:off - A command outlives the server, so it starts detached and unreferenced, outside every Effect scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  NodeId,
  ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpFailure,
  type OrchestratorMcpRunCommandInput,
  type OrchestratorMcpRunCommandResult,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { isProcessAlive, readProcessStartedAt } from "../serverRuntimeState.ts";
import { isServerOnlyEnvKey } from "../terminal/userShellEnv.ts";

/** How often running commands are checked; tests shorten it. */
export const WatchInterval = Context.Reference<Duration.Duration>(
  "t3/commandRunner/WatchInterval",
  { defaultValue: () => Duration.seconds(1) },
);

const LOG_FILE = "output.log";
const STATUS_FILE = "exit-status";
const LOG_TRIM_AT_BYTES = 8 * 1024 * 1024;
const LOG_KEEP_BYTES = 4 * 1024 * 1024;
const RESULT_TAIL_BYTES = 4 * 1024;
const KILL_GRACE = Duration.seconds(5);
const RETENTION = Duration.days(14);
const RETENTION_INTERVAL = Duration.hours(1);
const COMMAND_DRIVER = ProviderDriverKind.make("command");
const TRIMMED_MARKER = "[CodeShip removed earlier output to keep this log small]\n";

// Runs the command in the user's shell and outlives it to write its exit status; the rename makes
// the status file appear whole. Arguments: log, shell, status file, command.
const POSIX_WRAPPER = [
  'exec >>"$1" 2>&1 </dev/null',
  '"$2" -c "$4"',
  "code=$?",
  'printf "%s\\n" "$code" >"$3.tmp" && mv -f "$3.tmp" "$3"',
].join("\n");

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/**
 * `lost`: it vanished without an exit status. `stopped`: its task got a result elsewhere
 * (task_cancel, Stop, archive), so the runner stopped it.
 */
type CommandRunStatus = "running" | "exited" | "timed_out" | "lost" | "stopped";

interface CommandRunRow {
  readonly task_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly label: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly directory: string;
  readonly pid: number;
  readonly process_started_at: number | null;
  readonly unit: string | null;
  readonly status: CommandRunStatus;
  readonly exit_code: number | null;
  readonly started_at: string;
  readonly deadline_at: string;
  readonly ended_at: string | null;
  readonly delivered_at: string | null;
}

/**
 * `t3_command_run`: a command CodeShip runs itself, outside both the provider and the server, so
 * a restart neither stops it nor loses its end. Each command is a task on its thread, recorded
 * like a delegated task, and its end wakes the thread once through the same delivery.
 */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: (
      scope: ThreadScope,
      input: OrchestratorMcpRunCommandInput,
    ) => Effect.Effect<OrchestratorMcpRunCommandResult, OrchestratorMcpFailure>;
    /**
     * Adopts the commands an earlier server started, then watches every command until its end
     * reaches its task, and stops a command whose task got its result elsewhere.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/commandRunner/CommandRunner") {}

class CommandLaunchError extends Schema.TaggedError<CommandLaunchError>()("CommandLaunchError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** bash or zsh as the user's own commands expect; anything else (fish, nu) gets /bin/sh. */
const posixShell = (env: NodeJS.ProcessEnv) => {
  const shell = env.SHELL;
  return shell !== undefined && shell.startsWith("/") && /\/(?:ba|z)sh$/.test(shell)
    ? shell
    : "/bin/sh";
};

const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The last lines of a log, starting at a whole line when the start was cut. */
const decodeTail = (bytes: Uint8Array, cut: boolean) => {
  const text = new TextDecoder().decode(bytes);
  if (!cut) return text;
  const newline = text.indexOf("\n");
  return newline < 0 ? text : text.slice(newline + 1);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const agentScope = yield* AgentScope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { logsDir } = yield* ServerConfig.ServerConfig;
  const windows = (yield* HostProcess.Platform) === "win32";
  const hostEnv = yield* HostProcess.Environment;
  const watchInterval = yield* WatchInterval;

  const commandsDir = path.join(logsDir, "commands");
  const commandEnv = Object.fromEntries(
    Object.entries(hostEnv).filter(
      ([key, value]) => value !== undefined && !isServerOnlyEnvKey(key),
    ),
  );
  /** Commands whose end has not reached their task yet, by task id. */
  const watched = new Map<string, CommandRunRow>();
  /** Every change to a watched command, so its process is stopped or delivered once. */
  const lock = yield* Semaphore.make(1);
  /** Open once start() has adopted the commands an earlier server left, so run() never races it. */
  const adopted = yield* Deferred.make<void>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const startedAtOf = (pid: number) =>
    readProcessStartedAt(pid).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
  const logPathOf = (row: Pick<CommandRunRow, "directory">) => path.join(row.directory, LOG_FILE);
  const statusPathOf = (row: Pick<CommandRunRow, "directory">) =>
    path.join(row.directory, STATUS_FILE);

  const readExitStatus = (row: CommandRunRow) =>
    fs.readFileString(statusPathOf(row)).pipe(
      Effect.map((text) => {
        const code = Number.parseInt(text.trim(), 10);
        return { code: Number.isSafeInteger(code) ? code : null };
      }),
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

  /** Whether `pid` is still the process this command started, not a later one reusing it. */
  const isSameProcess = Effect.fn("CommandRunner.isSameProcess")(function* (row: CommandRunRow) {
    if (!isProcessAlive(row.pid)) return false;
    if (row.process_started_at === null) return true;
    const startedAt = yield* startedAtOf(row.pid);
    // ps reports whole seconds. Unknown identity stays conservative.
    return startedAt === undefined || Math.abs(startedAt - row.process_started_at) <= 1_000;
  });

  /** Stops the command and everything it started: its process group, or its tree on Windows. */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    if (!(yield* isSameProcess(row))) return;
    if (windows) {
      yield* processRunner
        .run({
          command: "taskkill",
          args: ["/PID", String(row.pid), "/T", "/F"],
          timeout: Duration.seconds(30),
          maxOutputBytes: 16_384,
        })
        .pipe(Effect.ignore({ log: true }));
    } else {
      const signal = (name: NodeJS.Signals | 0) =>
        Effect.sync(() => {
          try {
            signalProcessGroup(row.pid, name);
            return true;
          } catch {
            return false;
          }
        });
      if (yield* signal("SIGTERM")) {
        const gone = yield* signal(0).pipe(
          Effect.repeat({
            while: (alive) => alive,
            schedule: Schedule.spaced(Duration.millis(200)),
          }),
          Effect.timeoutOption(KILL_GRACE),
        );
        if (Option.isNone(gone)) yield* signal("SIGKILL");
      }
    }
    if (row.unit !== null) yield* agentScope.stop(row.unit);
  });

  const writeRow = (row: CommandRunRow) =>
    sql`
      UPDATE command_runs
      SET status = ${row.status}, exit_code = ${row.exit_code}, ended_at = ${row.ended_at},
        delivered_at = ${row.delivered_at}
      WHERE task_id = ${row.task_id}
    `;

  /** Records a watched command's new state; one that is delivered is no longer watched. */
  const settle = Effect.fn("CommandRunner.settle")(function* (row: CommandRunRow) {
    yield* writeRow(row);
    if (row.delivered_at === null) watched.set(row.task_id, row);
    else watched.delete(row.task_id);
  });

  const resultText = Effect.fn("CommandRunner.resultText")(function* (row: CommandRunRow) {
    const elapsed = formatDuration(
      Date.parse(row.ended_at ?? row.started_at) - Date.parse(row.started_at),
    );
    const ending =
      row.status === "timed_out"
        ? `Timed out and was stopped after ${elapsed}.`
        : row.status === "lost"
          ? `Ended after at most ${elapsed} without an exit status: it was killed, or this machine restarted.`
          : row.exit_code === null
            ? `Ended after ${elapsed} with an unreadable exit status.`
            : `Exited with code ${row.exit_code} after ${elapsed}.`;
    const logPath = logPathOf(row);
    const tail = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(logPath, { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - RESULT_TAIL_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        return Option.match(bytes, {
          onNone: () => "",
          onSome: (read) => decodeTail(read, start > 0),
        });
      }),
    ).pipe(Effect.orElseSucceed(() => ""));
    const output = tail.trimEnd();
    return [
      ending,
      output === "" ? "No output." : `Last output:\n${output}`,
      `Full output: ${logPath}`,
    ].join("\n");
  });

  /**
   * Hands a command's end to its task, which wakes the thread. A task that already has its result
   * (a cancel or Stop landed first) or no longer exists keeps nothing waiting, so it is delivered.
   */
  const deliver = Effect.fn("CommandRunner.deliver")(function* (row: CommandRunRow) {
    const attempt = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const parentThreadId = ThreadId.make(row.thread_id);
    const taskId = NodeId.make(row.task_id);
    const delivered = yield* threads
      .dispatch({
        type: "delegated_task.command.complete",
        commandId: CommandId.make(`command:command-task-complete:${row.task_id}:${attempt}`),
        parentThreadId,
        taskId,
        status: row.status === "exited" && row.exit_code === 0 ? "completed" : "failed",
        result: yield* resultText(row),
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          threads.getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] }).pipe(
            Effect.map(({ subagents }) => subagents[0]?.result != null || subagents.length === 0),
            Effect.orElseSucceed(() => false),
            Effect.tap((settled) =>
              settled
                ? Effect.void
                : Effect.logWarning("command-runner.deliver-failed", { taskId, cause }),
            ),
          ),
        ),
      );
    if (delivered) yield* settle({ ...row, delivered_at: yield* nowIso });
  });

  /** Keeps a log that keeps growing to its last part; on Windows only once the command ends. */
  const trimLog = Effect.fn("CommandRunner.trimLog")(function* (row: CommandRunRow) {
    const logPath = logPathOf(row);
    const size = yield* fs.stat(logPath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (size <= LOG_TRIM_AT_BYTES) return;
    // Its wrapper appends, so a write that lands during the trim is kept, after the kept part.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(logPath, { flag: "r+" });
        yield* file.seek(BigInt(size - LOG_KEEP_BYTES), "start");
        const kept = Option.getOrElse(
          yield* file.readAlloc(LOG_KEEP_BYTES),
          () => new Uint8Array(),
        );
        yield* file.truncate(0);
        yield* fs.writeFile(
          logPath,
          new Uint8Array([...new TextEncoder().encode(TRIMMED_MARKER), ...kept]),
          { flag: "a" },
        );
      }),
    ).pipe(Effect.ignore({ log: true }));
  });

  /** Moves a running command on: its end, its deadline, or its process gone without a status. */
  const check = Effect.fn("CommandRunner.check")(function* (row: CommandRunRow) {
    if (row.status !== "running") return yield* deliver(row);
    const ended = (status: CommandRunStatus, exitCode: number | null) =>
      nowIso.pipe(
        Effect.flatMap((endedAt) => {
          const next = { ...row, status, exit_code: exitCode, ended_at: endedAt };
          return settle(next).pipe(Effect.andThen(deliver(next)));
        }),
      );
    const exit = yield* readExitStatus(row);
    if (exit !== undefined) {
      yield* trimLog(row);
      return yield* ended("exited", exit.code);
    }
    if (Date.parse(row.deadline_at) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      yield* killTree(row);
      return yield* ended("timed_out", null);
    }
    if (!isProcessAlive(row.pid)) {
      // Its wrapper writes the status just before it exits.
      const late = yield* readExitStatus(row);
      return yield* late === undefined ? ended("lost", null) : ended("exited", late.code);
    }
    if (!windows) yield* trimLog(row);
  });

  const watchOnce = lock.withPermits(1)(
    Effect.suspend(() =>
      Effect.forEach([...watched.values()], (row) =>
        check(row).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command-runner.check-failed", { taskId: row.task_id, cause }),
          ),
        ),
      ),
    ),
  );

  /** The task got its result elsewhere: a cancel, Stop, or the thread archived. */
  const stopForTask = (taskId: string) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const row = watched.get(taskId);
          if (row === undefined || row.status !== "running") return undefined;
          const now = yield* nowIso;
          yield* settle({ ...row, status: "stopped", ended_at: now, delivered_at: now });
          return row;
        }),
      )
      .pipe(Effect.flatMap((row) => (row === undefined ? Effect.void : killTree(row))));

  /** A thread that is archived or deleted keeps nothing running. */
  const stopForThread = Effect.fn("CommandRunner.stopForThread")(function* (
    threadId: ThreadId,
    why: "archived" | "deleted",
  ) {
    const running = [...watched.values()].filter(
      (row) => row.thread_id === threadId && row.status === "running",
    );
    yield* Effect.forEach(running, (row) =>
      threads
        .dispatch({
          type: "delegated_task.command.complete",
          commandId: CommandId.make(`command:command-task-${why}:${row.task_id}`),
          parentThreadId: threadId,
          taskId: NodeId.make(row.task_id),
          status: "interrupted",
          result: `Stopped: the chat was ${why}.`,
        })
        .pipe(
          Effect.ignore,
          // A deleted thread records nothing, so its command is stopped here.
          Effect.andThen(stopForTask(row.task_id)),
        ),
    );
  });

  const spawnDetached = (command: string, args: ReadonlyArray<string>, cwd: string) =>
    Effect.callback<number, CommandLaunchError>((resume) => {
      const child = NodeChildProcess.spawn(command, args, {
        cwd,
        env: commandEnv,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (cause) =>
        resume(Effect.fail(new CommandLaunchError({ detail: cause.message, cause }))),
      );
      child.once("spawn", () => {
        child.unref();
        resume(Effect.succeed(child.pid ?? 0));
      });
    });

  /**
   * Starts the command in its own session (POSIX) or outside this process tree (Windows), so
   * neither the desktop app, the launcher, nor a service manager stopping the server reaches it.
   * On Linux under systemd it also leaves the server's cgroup, in the agents slice.
   */
  const launch = Effect.fn("CommandRunner.launch")(function* (
    directory: string,
    command: string,
    cwd: string,
  ) {
    const logPath = path.join(directory, LOG_FILE);
    const statusPath = path.join(directory, STATUS_FILE);
    if (!windows) {
      const scoped = yield* agentScope.wrap({
        command: "/bin/sh",
        args: [
          "-c",
          POSIX_WRAPPER,
          "t3-command",
          logPath,
          posixShell(commandEnv),
          statusPath,
          command,
        ],
        name: "command",
        env: commandEnv,
        survivesRestart: true,
      });
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd);
      return { pid, unit: scoped.unit ?? null };
    }
    // Win32_Process.Create parents the command under WMI, outside this server's job and tree,
    // with the user's own environment. cmd writes the status once PowerShell exits.
    const scriptPath = path.join(directory, "command.ps1");
    const runPath = path.join(directory, "run.cmd");
    yield* fs.writeFileString(
      scriptPath,
      `﻿$ErrorActionPreference = 'Continue'\r\n${command}\r\n$t3Ok = $?\r\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\r\nif (-not $t3Ok) { exit 1 }\r\nexit 0\r\n`,
    );
    yield* fs.writeFileString(
      runPath,
      [
        "@echo off",
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0command.ps1" >> "%~dp0${LOG_FILE}" 2>&1`,
        `> "%~dp0${STATUS_FILE}.tmp" echo %ERRORLEVEL%`,
        `move /y "%~dp0${STATUS_FILE}.tmp" "%~dp0${STATUS_FILE}" > nul`,
        "",
      ].join("\r\n"),
    );
    yield* fs.writeFileString(logPath, "");
    const created = yield* processRunner.run({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShell(`cmd.exe /d /s /c ""${runPath}""`)}; CurrentDirectory = ${quotePowerShell(cwd)} }; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned $($r.ReturnValue)"); exit 1 }; $r.ProcessId`,
      ],
      timeout: Duration.seconds(30),
      maxOutputBytes: 16_384,
    });
    const pid = Number.parseInt(created.stdout.trim(), 10);
    if (created.code !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
      return yield* new CommandLaunchError({
        detail: created.stderr.trim() || "Win32_Process.Create failed.",
      });
    }
    return { pid, unit: null };
  });

  const run: CommandRunner["Service"]["run"] = Effect.fn("CommandRunner.run")(
    function* (scope, input) {
      yield* Deferred.await(adopted);
      const parent = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs", "subagents"])
        .pipe(
          Effect.mapError(() => failure("thread_not_found", "The calling thread was not found.")),
        );
      const parentRun = parent.runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Commands require an active run owned by this MCP provider session.",
        );
      }
      const project = yield* projects.getById(parent.thread.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const base = parent.thread.worktreePath ?? project?.workspaceRoot;
      if (base === undefined && (input.cwd === undefined || !path.isAbsolute(input.cwd))) {
        return yield* failure(
          "invalid_request",
          "This thread has no folder; pass an absolute cwd.",
        );
      }
      const cwd = base === undefined ? input.cwd! : path.resolve(base, input.cwd ?? ".");
      const isFolder = yield* fs.stat(cwd).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!isFolder) return yield* failure("invalid_request", `No folder at ${cwd}.`);
      const timeoutMinutes =
        input.timeoutMinutes ?? ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES;
      const key = input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const commandId = CommandId.make(
        `command:mcp:${encodeURIComponent(scope.requestNamespace)}:command-run:${encodeURIComponent(key)}`,
      );
      // Named by the request, so a retry with the same clientRequestId finds the same folder.
      const directory = path.join(
        commandsDir,
        NodeCrypto.createHash("sha256").update(commandId).digest("hex").slice(0, 32),
      );
      const logPath = path.join(directory, LOG_FILE);
      const result = (taskId: NodeId): OrchestratorMcpRunCommandResult => ({
        taskId,
        logPath,
        timeoutMinutes,
        next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
      });
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.command.request",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          ...(input.label === undefined ? {} : { title: input.label }),
          driver: COMMAND_DRIVER,
          providerInstanceId: scope.thread.providerInstanceId,
          command: { command: input.command, cwd, logPath, timeoutMinutes },
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("command-runner.record-failed", {
              parentThreadId: scope.thread.threadId,
              cause,
            }),
          ),
          Effect.mapError(() => failure("orchestration_error", "Unable to record the command.")),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      // A retried request recorded the task the first time.
      const prior = parent.subagents.find((task) => task.command?.logPath === logPath);
      const taskId =
        taskEvent?.event.type === "subagent.updated" ? taskEvent.event.payload.id : prior?.id;
      if (taskId === undefined) {
        return yield* failure("orchestration_error", "The command was not recorded.");
      }
      return yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM command_runs WHERE task_id = ${taskId}
          `;
            if (existing.length > 0) return result(taskId);
            // Its first request could not start it, and the task already says why.
            if (prior?.result != null) return yield* failure("orchestration_error", prior.result);
            const started = yield* fs
              .makeDirectory(directory, { recursive: true })
              .pipe(Effect.andThen(launch(directory, input.command, cwd)), Effect.result);
            if (started._tag === "Failure") {
              const message = `Could not start the command: ${started.failure.message}`;
              yield* threads
                .dispatch({
                  type: "delegated_task.command.complete",
                  commandId: CommandId.make(`command:command-task-unstarted:${taskId}`),
                  parentThreadId: scope.thread.threadId,
                  taskId,
                  status: "failed",
                  result: message,
                })
                .pipe(
                  Effect.andThen(
                    threads.dispatch({
                      type: "delegated_task.completion-delivery.dispose",
                      commandId: CommandId.make(`command:command-task-unstarted-dispose:${taskId}`),
                      parentThreadId: scope.thread.threadId,
                      taskId,
                    }),
                  ),
                  Effect.ignore({ log: true }),
                );
              return yield* failure("orchestration_error", message);
            }
            const { pid, unit } = started.success;
            const processStartedAt = (yield* startedAtOf(pid)) ?? null;
            const now = yield* DateTime.now;
            const row: CommandRunRow = {
              task_id: taskId,
              thread_id: scope.thread.threadId,
              run_id: parentRun.id,
              label: input.label ?? null,
              command: input.command,
              cwd,
              directory,
              pid,
              process_started_at: processStartedAt,
              unit,
              status: "running",
              exit_code: null,
              started_at: DateTime.formatIso(now),
              deadline_at: DateTime.formatIso(DateTime.add(now, { minutes: timeoutMinutes })),
              ended_at: null,
              delivered_at: null,
            };
            yield* sql`
            INSERT INTO command_runs (
              task_id, thread_id, run_id, label, command, cwd, directory, pid,
              process_started_at, unit, status, exit_code, started_at, deadline_at, ended_at,
              delivered_at
            ) VALUES (
              ${row.task_id}, ${row.thread_id}, ${row.run_id}, ${row.label}, ${row.command},
              ${row.cwd}, ${row.directory}, ${row.pid}, ${row.process_started_at}, ${row.unit},
              ${row.status}, ${row.exit_code}, ${row.started_at}, ${row.deadline_at},
              ${row.ended_at}, ${row.delivered_at}
            )
          `;
            watched.set(row.task_id, row);
            return result(taskId);
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (cause) =>
              Effect.logWarning("command-runner.insert-failed", { taskId, cause }).pipe(
                Effect.andThen(
                  Effect.fail(failure("orchestration_error", "Unable to record the command.")),
                ),
              ),
          }),
        );
    },
  );

  /**
   * Picks up what an earlier server left: commands to watch again, ends to deliver, and tasks
   * whose command never got its record (the server stopped between the two), which are lost.
   */
  const adopt = Effect.gen(function* () {
    const rows = yield* sql<CommandRunRow>`
      SELECT * FROM command_runs WHERE delivered_at IS NULL
    `;
    yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        if (row.status !== "running" || (yield* readExitStatus(row)) !== undefined) {
          watched.set(row.task_id, row);
          return;
        }
        // A pid reused by another process means this command ended while no server watched it.
        if (yield* isSameProcess(row)) watched.set(row.task_id, row);
        else yield* settle({ ...row, status: "lost", ended_at: yield* nowIso });
      }),
    );
    const open = yield* projections.getOpenCommandTasks;
    const known = new Set(
      (yield* sql<{ readonly task_id: string }>`SELECT task_id FROM command_runs`).map(
        (row) => row.task_id,
      ),
    );
    yield* Effect.forEach(
      open.filter((task) => !known.has(task.taskId)),
      ({ parentThreadId, taskId }) =>
        threads
          .dispatch({
            type: "delegated_task.command.complete",
            commandId: CommandId.make(`command:command-task-unrecorded:${taskId}`),
            parentThreadId,
            taskId,
            status: "failed",
            result: "CodeShip stopped before this command started. Run it again.",
          })
          .pipe(Effect.ignore({ log: true })),
    );
  });

  /** Removes delivered commands, and folders left without a record, after RETENTION. */
  const prune = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, RETENTION));
    const old = yield* sql<{ readonly task_id: string; readonly directory: string }>`
      SELECT task_id, directory FROM command_runs
      WHERE delivered_at IS NOT NULL AND delivered_at < ${cutoff}
    `;
    yield* Effect.forEach(old, (row) =>
      fs
        .remove(row.directory, { recursive: true, force: true })
        .pipe(
          Effect.andThen(sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`),
          Effect.ignore({ log: true }),
        ),
    );
    const recorded = new Set(
      (yield* sql<{ readonly directory: string }>`SELECT directory FROM command_runs`).map((row) =>
        path.basename(row.directory),
      ),
    );
    const entries = yield* fs.readDirectory(commandsDir).pipe(Effect.orElseSucceed(() => []));
    const cutoffMs = Date.parse(cutoff);
    yield* Effect.forEach(
      entries.filter((entry) => !recorded.has(entry)),
      (entry) =>
        Effect.gen(function* () {
          const folder = path.join(commandsDir, entry);
          const info = yield* fs.stat(folder);
          const modified = Option.getOrUndefined(info.mtime)?.getTime();
          if (modified !== undefined && modified < cutoffMs) {
            yield* fs.remove(folder, { recursive: true, force: true });
          }
        }).pipe(Effect.ignore({ log: true })),
    );
  });

  const start: CommandRunner["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Subscribed before adopting, so a cancel that lands meanwhile is not missed.
        yield* Effect.forkScoped(
          Stream.runForEach(threads.streamDomainEvents, (event) => {
            if (
              event.type === "subagent.updated" &&
              event.payload.command !== undefined &&
              event.payload.result !== null
            ) {
              return stopForTask(event.payload.id);
            }
            if (event.type === "thread.archived") return stopForThread(event.threadId, "archived");
            if (event.type === "thread.deleted") return stopForThread(event.threadId, "deleted");
            return Effect.void;
          }).pipe(Effect.ignoreCause({ log: true })),
          { startImmediately: true },
        );
        yield* lock
          .withPermits(1)(adopt)
          .pipe(
            Effect.ensuring(Deferred.succeed(adopted, undefined)),
            Effect.ignoreCause({ log: true }),
          );
        yield* Effect.forkScoped(
          prune.pipe(
            Effect.ignoreCause({ log: true }),
            Effect.repeat(Schedule.spaced(RETENTION_INTERVAL)),
          ),
        );
        yield* watchOnce.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.repeat(Schedule.spaced(watchInterval)),
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return CommandRunner.of({ run, start });
});

export const layer = Layer.effect(CommandRunner, make);
