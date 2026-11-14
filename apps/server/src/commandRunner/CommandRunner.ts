// @effect-diagnostics nodeBuiltinImport:off - A command outlives the server, so it starts detached and unreferenced, outside every Effect scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

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
const PID_FILE = "pid";
const LOG_TRIM_AT_BYTES = 8 * 1024 * 1024;
const LOG_KEEP_BYTES = 4 * 1024 * 1024;
const LOG_COPY_CHUNK_BYTES = 1024 * 1024;
const RESULT_TAIL_BYTES = 4 * 1024;
const KILL_GRACE = Duration.seconds(5);
const RETENTION = Duration.days(14);
const RETENTION_INTERVAL = Duration.hours(1);
const COMMAND_DRIVER = ProviderDriverKind.make("command");
const TRIMMED_MARKER = "[CodeShip removed earlier output to keep this log small]\n";

// Names itself first, then runs the command in the user's shell and outlives it to write its exit
// status; each rename makes its file appear whole. Arguments: log, shell, status file, command,
// pid file.
const POSIX_WRAPPER = [
  'printf "%s\\n" "$$" >"$5.tmp" && mv -f "$5.tmp" "$5"',
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
  /** Null from its record until its process starts. */
  readonly pid: number | null;
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

  /** A file the wrapper wrote, with when it wrote it. */
  const readWrapperFile = (file: string) =>
    Effect.all([fs.readFileString(file), fs.stat(file)]).pipe(
      Effect.map(([text, info]) => ({
        value: Number.parseInt(text.trim(), 10),
        writtenAt: Option.getOrUndefined(info.mtime),
      })),
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

  /** Its exit code, and when it ended: a command can end while no server watches it. */
  const readExitStatus = (row: CommandRunRow) =>
    readWrapperFile(statusPathOf(row)).pipe(
      Effect.map((status) =>
        status === undefined
          ? undefined
          : {
              code: Number.isSafeInteger(status.value) ? status.value : null,
              endedAt: status.writtenAt?.toISOString(),
            },
      ),
    );

  /** Nothing a command started outlives a reboot, after which its pid can name anything. */
  const rebootedSince = (row: CommandRunRow) =>
    DateTime.now.pipe(
      Effect.map(
        (now) => DateTime.toEpochMillis(now) - NodeOS.uptime() * 1_000 > Date.parse(row.started_at),
      ),
    );

  /** Whether `pid` is still the process this command started, not a later one reusing it. */
  const isSameProcess = Effect.fn("CommandRunner.isSameProcess")(function* (row: CommandRunRow) {
    if (row.pid === null || !isProcessAlive(row.pid) || (yield* rebootedSince(row))) return false;
    if (row.process_started_at === null) return true;
    const startedAt = yield* startedAtOf(row.pid);
    // ps reports whole seconds. Unknown identity stays conservative.
    return startedAt === undefined || Math.abs(startedAt - row.process_started_at) <= 1_000;
  });

  /** SIGTERM to the whole group, then SIGKILL to what is left of it after the grace period. */
  const killGroup = Effect.fn("CommandRunner.killGroup")(function* (pid: number) {
    const signal = (name: NodeJS.Signals | 0) =>
      Effect.sync(() => {
        try {
          signalProcessGroup(pid, name);
          return true;
        } catch {
          return false;
        }
      });
    if (!(yield* signal("SIGTERM"))) return;
    const gone = yield* signal(0).pipe(
      Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced(Duration.millis(200)) }),
      Effect.timeoutOption(KILL_GRACE),
    );
    if (Option.isNone(gone)) yield* signal("SIGKILL");
  });

  /**
   * Stops the command and everything it started: its process group, or its tree on Windows. A
   * group outlives its wrapper and its id is not reused while any member lives, so short of a
   * reboot, only a live process reusing the wrapper's pid means nothing of the group is left.
   */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    const pid = row.pid;
    if (pid !== null && !(yield* rebootedSince(row))) {
      if (!windows) {
        if (!isProcessAlive(pid) || (yield* isSameProcess(row))) yield* killGroup(pid);
      } else if (yield* isSameProcess(row)) {
        yield* processRunner
          .run({
            command: "taskkill",
            args: ["/PID", String(pid), "/T", "/F"],
            timeout: Duration.seconds(30),
            maxOutputBytes: 16_384,
          })
          .pipe(Effect.ignore({ log: true }));
      }
    }
    if (row.unit !== null) yield* agentScope.stop(row.unit);
  });

  const writeRow = (row: CommandRunRow) =>
    sql`
      UPDATE command_runs
      SET pid = ${row.pid}, process_started_at = ${row.process_started_at}, unit = ${row.unit},
        status = ${row.status}, exit_code = ${row.exit_code}, ended_at = ${row.ended_at},
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

  /**
   * Keeps a log that keeps growing to its last part; on Windows only once the command ends. The
   * wrapper still appends to it, so the last part moves to the front in place, following what
   * lands meanwhile. Output that lands after the last copy, before the cut, is lost, never
   * reordered.
   */
  const trimLog = Effect.fn("CommandRunner.trimLog")(function* (row: CommandRunRow) {
    const logPath = logPathOf(row);
    const grown = yield* fs.stat(logPath).pipe(
      Effect.map((info) => Number(info.size) > LOG_TRIM_AT_BYTES),
      Effect.orElseSucceed(() => false),
    );
    if (!grown) return;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(logPath, { flag: "r+" });
        const size = Number((yield* file.stat).size);
        const marker = new TextEncoder().encode(TRIMMED_MARKER);
        yield* file.seek(0n, "start");
        yield* file.writeAll(marker);
        let readAt = size - LOG_KEEP_BYTES;
        let writeAt = marker.length;
        let end = size;
        while (readAt < end) {
          yield* file.seek(BigInt(readAt), "start");
          const chunk = Option.getOrUndefined(
            yield* file.readAlloc(Math.min(LOG_COPY_CHUNK_BYTES, end - readAt)),
          );
          if (chunk === undefined || chunk.length === 0) break;
          yield* file.seek(BigInt(writeAt), "start");
          yield* file.writeAll(chunk);
          readAt += chunk.length;
          writeAt += chunk.length;
          // A command that writes faster than this copies is cut at the next check instead.
          if (readAt >= end && writeAt < LOG_TRIM_AT_BYTES) end = Number((yield* file.stat).size);
        }
        yield* file.truncate(writeAt);
      }),
    ).pipe(Effect.ignore({ log: true }));
  });

  /** Moves a running command on: its end, its deadline, or its process gone without a status. */
  const check = Effect.fn("CommandRunner.check")(function* (row: CommandRunRow) {
    // stopForTask is still stopping it, and records it once it has.
    if (row.status === "stopped") return;
    if (row.status !== "running") return yield* deliver(row);
    const ended = (status: CommandRunStatus, exitCode: number | null, endedAt?: string) =>
      (endedAt === undefined ? nowIso : Effect.succeed(endedAt)).pipe(
        Effect.flatMap((at) => {
          const next = { ...row, status, exit_code: exitCode, ended_at: at };
          return settle(next).pipe(Effect.andThen(deliver(next)));
        }),
      );
    const exit = yield* readExitStatus(row);
    if (exit !== undefined) {
      yield* trimLog(row);
      return yield* ended("exited", exit.code, exit.endedAt);
    }
    // A deadline that passed while no server ran is enforced at the first check after.
    if (Date.parse(row.deadline_at) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      yield* killTree(row);
      return yield* ended("timed_out", null);
    }
    if (row.pid === null || !isProcessAlive(row.pid)) {
      // Its wrapper writes the status just before it exits.
      const late = yield* readExitStatus(row);
      if (late !== undefined) return yield* ended("exited", late.code, late.endedAt);
      // Its wrapper was killed; what it started is not left running unwatched.
      yield* killTree(row);
      return yield* ended("lost", null);
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

  /**
   * The task got its result elsewhere: a cancel, Stop, or the thread archived. It is recorded as
   * delivered only once its process is gone, so a server that stops meanwhile leaves the next one
   * to stop it. The kill runs outside the lock, which it would hold for its grace period.
   */
  const stopForTask = (taskId: string) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const row = watched.get(taskId);
          if (row === undefined || row.status !== "running") return undefined;
          const stopped: CommandRunRow = { ...row, status: "stopped", ended_at: yield* nowIso };
          yield* settle(stopped);
          return stopped;
        }),
      )
      .pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? Effect.void
            : killTree(row).pipe(
                Effect.andThen(nowIso),
                Effect.flatMap((now) => lock.withPermits(1)(settle({ ...row, delivered_at: now }))),
              ),
        ),
      );

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
          path.join(directory, PID_FILE),
        ],
        name: "command",
        env: commandEnv,
        survivesRestart: true,
      });
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd);
      return { pid, unit: scoped.unit ?? null };
    }
    // Win32_Process.Create parents the command under WMI, outside this server's job and tree,
    // with the user's own environment. PowerShell first names its cmd parent, the process this
    // command is known by, and cmd writes the status once PowerShell exits.
    const scriptPath = path.join(directory, "command.ps1");
    const runPath = path.join(directory, "run.cmd");
    yield* fs.writeFileString(
      scriptPath,
      [
        "﻿$ErrorActionPreference = 'Continue'",
        `$t3PidFile = Join-Path $PSScriptRoot '${PID_FILE}'`,
        `(Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId | Set-Content -LiteralPath "$t3PidFile.tmp"`,
        `Move-Item -Force -LiteralPath "$t3PidFile.tmp" -Destination $t3PidFile`,
        command,
        "$t3Ok = $?",
        "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
        "if (-not $t3Ok) { exit 1 }",
        "exit 0",
        "",
      ].join("\r\n"),
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
      const parentNodeId = parentRun.rootNodeId;
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
      // A request cancelled in here would leave a task, or a command, that nothing watches.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const recorded = yield* threads
            .dispatch({
              type: "delegated_task.command.request",
              commandId,
              parentThreadId: scope.thread.threadId,
              parentRunId: parentRun.id,
              parentNodeId,
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
              Effect.mapError(() =>
                failure("orchestration_error", "Unable to record the command."),
              ),
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
          /** Fails a task whose command never started, with nothing left to wake its thread for. */
          const unstarted = (message: string) =>
            threads
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
                Effect.andThen(Effect.fail(failure("orchestration_error", message))),
              );
          return yield* lock
            .withPermits(1)(
              Effect.gen(function* () {
                const existing = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM command_runs WHERE task_id = ${taskId}
          `;
                if (existing.length > 0) return result(taskId);
                // Its first request could not start it, and the task already says why.
                if (prior?.result != null)
                  return yield* failure("orchestration_error", prior.result);
                const now = yield* DateTime.now;
                const row: CommandRunRow = {
                  task_id: taskId,
                  thread_id: scope.thread.threadId,
                  run_id: parentRun.id,
                  label: input.label ?? null,
                  command: input.command,
                  cwd,
                  directory,
                  pid: null,
                  process_started_at: null,
                  unit: null,
                  status: "running",
                  exit_code: null,
                  started_at: DateTime.formatIso(now),
                  deadline_at: DateTime.formatIso(DateTime.add(now, { minutes: timeoutMinutes })),
                  ended_at: null,
                  delivered_at: null,
                };
                // Recorded before it starts, so a server that stops in between leaves the next one
                // a record to adopt it by, never a command nothing watches.
                const recordedRow = yield* fs.makeDirectory(directory, { recursive: true }).pipe(
                  Effect.andThen(
                    sql`
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
              `,
                  ),
                  Effect.result,
                );
                if (recordedRow._tag === "Failure") {
                  return yield* unstarted(
                    `Could not start the command: ${recordedRow.failure.message}`,
                  );
                }
                const started = yield* launch(directory, input.command, cwd).pipe(Effect.result);
                if (started._tag === "Failure") {
                  yield* sql`DELETE FROM command_runs WHERE task_id = ${taskId}`.pipe(
                    Effect.ignore({ log: true }),
                  );
                  return yield* unstarted(
                    `Could not start the command: ${started.failure.message}`,
                  );
                }
                const { pid, unit } = started.success;
                const launched: CommandRunRow = {
                  ...row,
                  pid,
                  process_started_at: (yield* startedAtOf(pid)) ?? null,
                  unit,
                };
                watched.set(taskId, launched);
                // Its pid file names it to the next server if this write is lost.
                yield* writeRow(launched).pipe(Effect.ignore({ log: true }));
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
        }),
      );
    },
  );

  /**
   * A command whose server stopped before it recorded the pid: its wrapper's pid file names it.
   * Without that file it never started, so its record goes and its task fails with the others.
   */
  const recoverPid = Effect.fn("CommandRunner.recoverPid")(function* (row: CommandRunRow) {
    const named = yield* readWrapperFile(path.join(row.directory, PID_FILE));
    if (named === undefined || !Number.isSafeInteger(named.value) || named.value <= 0) {
      if ((yield* readExitStatus(row)) !== undefined) return row;
      yield* sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`;
      return undefined;
    }
    const pid = named.value;
    if (!isProcessAlive(pid)) return row;
    const startedAt = yield* startedAtOf(pid);
    const writtenAt = named.writtenAt?.getTime();
    // It started before it wrote the file; a later process reusing the pid did not. ps reports
    // whole seconds.
    if (startedAt !== undefined && writtenAt !== undefined && startedAt > writtenAt + 1_000) {
      return row;
    }
    const recovered: CommandRunRow = { ...row, pid, process_started_at: startedAt ?? null };
    yield* writeRow(recovered);
    return recovered;
  });

  /** What one record an earlier server left needs, given its task if that is still open. */
  const adoptRow = Effect.fn("CommandRunner.adoptRow")(function* (
    stored: CommandRunRow,
    task: ProjectionStore.ProjectionOpenCommandTask | undefined,
  ) {
    const row = stored.pid === null ? yield* recoverPid(stored) : stored;
    if (row === undefined) return;
    if (row.status === "stopped") {
      // Its server stopped before the stop was done.
      yield* killTree(row);
      return yield* settle({ ...row, delivered_at: yield* nowIso });
    }
    if (row.status !== "running") {
      watched.set(row.task_id, row);
      return;
    }
    if (task === undefined || task.threadClosed !== null) {
      // Its task got its result while no server ran (a cancel), or its chat was closed.
      if (task?.threadClosed != null) {
        yield* threads
          .dispatch({
            type: "delegated_task.command.complete",
            commandId: CommandId.make(`command:command-task-${task.threadClosed}:${row.task_id}`),
            parentThreadId: task.parentThreadId,
            taskId: task.taskId,
            status: "interrupted",
            result: `Stopped: the chat was ${task.threadClosed}.`,
          })
          .pipe(Effect.ignore);
      }
      yield* killTree(row);
      const now = yield* nowIso;
      return yield* settle({ ...row, status: "stopped", ended_at: now, delivered_at: now });
    }
    if ((yield* readExitStatus(row)) !== undefined) {
      watched.set(row.task_id, row);
      return;
    }
    // A pid reused by another process means this command ended while no server watched it.
    if (yield* isSameProcess(row)) {
      watched.set(row.task_id, row);
      return;
    }
    yield* killTree(row);
    yield* settle({ ...row, status: "lost", ended_at: yield* nowIso });
  });

  /**
   * Picks up what an earlier server left: commands to watch again, ends to deliver, stops to
   * finish, and tasks whose command never got its record (the server stopped between the two),
   * which are lost.
   */
  const adopt = Effect.gen(function* () {
    const open = yield* projections.getOpenCommandTasks;
    const openById = new Map<string, ProjectionStore.ProjectionOpenCommandTask>(
      open.map((task) => [task.taskId, task]),
    );
    const rows = yield* sql<CommandRunRow>`
      SELECT * FROM command_runs WHERE delivered_at IS NULL
    `;
    yield* Effect.forEach(rows, (row) =>
      adoptRow(row, openById.get(row.task_id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("command-runner.adopt-failed", { taskId: row.task_id, cause }),
        ),
      ),
    );
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
            const handled =
              event.type === "subagent.updated" &&
              event.payload.command !== undefined &&
              event.payload.result !== null
                ? stopForTask(event.payload.id)
                : event.type === "thread.archived"
                  ? stopForThread(event.threadId, "archived")
                  : event.type === "thread.deleted"
                    ? stopForThread(event.threadId, "deleted")
                    : Effect.void;
            // One failed stop must not end the subscription every later stop needs.
            return handled.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("command-runner.stop-failed", { type: event.type, cause }),
              ),
            );
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
