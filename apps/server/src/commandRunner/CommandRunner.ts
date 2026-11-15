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
import { isProcessAlive, probeProcess } from "@t3tools/shared/processProbe";
import { overrideEnvironment } from "@t3tools/shared/shell";
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
import * as PortScanner from "../preview/PortScanner.ts";
import { escapePowerShellStringLiteral } from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { readProcessStartedAt } from "../serverRuntimeState.ts";
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
/**
 * More than half the commands that ran within this window lost is a wave. It goes on while each
 * loss comes within this window of the one before, and is logged as one warning.
 */
const WAVE_WINDOW = Duration.minutes(1);
/** Holds each wave for RETENTION, like the records it names; at most one wave starts a minute. */
export const LOSS_LOG_FILE = "command-losses.ndjson";
const COMMAND_DRIVER = ProviderDriverKind.make("command");
const TRIMMED_MARKER = "[CodeShip removed earlier output to keep this log small]\n";
// Win32_ProcessStartup's Create_Unicode_Environment (without it the block is ANSI).
const CREATE_UNICODE_ENVIRONMENT = 0x400;
// Win32_ProcessStartup's ShowWindow as SW_HIDE: the wrapper's console, which only it uses, opens
// no window. Windows PowerShell started with no console at all (Detached_Process) exits at once.
const SW_HIDE = 0;

// Runs command.ps1 in a new console with no window, which the command and what it starts share, so
// no console event they get (Ctrl+C, Ctrl+Break, that console closing) reaches the wrapper, which
// outlives them to write the exit status; each rename makes its file appear whole.
const WINDOWS_WRAPPER = [
  "$ErrorActionPreference = 'Stop'",
  "$code = 1",
  "function Write-T3File($name, $value) {",
  "  $file = Join-Path $PSScriptRoot $name",
  `  Set-Content -LiteralPath "$file.tmp" -Value $value`,
  `  Move-Item -Force -LiteralPath "$file.tmp" -Destination $file`,
  "}",
  "try {",
  `  Write-T3File '${PID_FILE}' $PID`,
  "  $system = [Environment]::SystemDirectory",
  "  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $system 'cmd.exe'))",
  // cmd only appends the output of PowerShell and everything it starts to the log.
  `  $start.Arguments = '/d /s /c ""' + (Join-Path $system 'WindowsPowerShell\\v1.0\\powershell.exe') + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'command.ps1') + '" >> "' + (Join-Path $PSScriptRoot '${LOG_FILE}') + '" 2>&1"'`,
  "  $start.UseShellExecute = $false",
  "  $start.CreateNoWindow = $true",
  "  $command = [Diagnostics.Process]::Start($start)",
  "  $command.WaitForExit()",
  "  $code = $command.ExitCode",
  "} catch {",
  `  Add-Content -LiteralPath (Join-Path $PSScriptRoot '${LOG_FILE}') -Value "CodeShip could not run the command: $_"`,
  "} finally {",
  `  Write-T3File '${STATUS_FILE}' $code`,
  "}",
  "",
].join("\r\n");

// System32's bash.exe is WSL's, which has no node and cannot read `C:/` paths. command.ps1 puts Git
// Bash's folder first on its PATH, found with the command's own environment and folder, or makes a
// bare `bash` and `sh` fail naming it. A program that searches System32 first still gets WSL's.
const WINDOWS_GIT_BASH = [
  "$t3GitBash = & {",
  "  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  if ($git) {",
  // --exec-path names the install behind a launcher or shim; GIT_EXEC_PATH would replace it. A git
  // that cannot answer leaves the standard folders, and the error below names where it looked.
  "    try {",
  "      $start = [Diagnostics.ProcessStartInfo]::new($git.Path, '--exec-path')",
  "      $start.UseShellExecute = $false",
  "      $start.RedirectStandardOutput = $true",
  "      $start.StandardOutputEncoding = [Text.Encoding]::UTF8",
  "      $start.EnvironmentVariables.Remove('GIT_EXEC_PATH')",
  "      $run = [Diagnostics.Process]::Start($start)",
  "      $out = $run.StandardOutput.ReadToEndAsync()",
  "      if (-not $run.WaitForExit(10000)) { $run.Kill() } elseif ($run.ExitCode -eq 0 -and $out.Wait(1000) -and $out.Result.Trim()) {",
  // <install>\<build>\libexec\git-core
  "        [IO.Path]::GetFullPath([IO.Path]::Combine($out.Result.Trim(), '..', '..', '..'))",
  "      }",
  "    } catch {}",
  "  }",
  "  foreach ($folder in $env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)}) { if ($folder) { [IO.Path]::Combine($folder, 'Git') } }",
  "  if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'Git') }",
  "} | ForEach-Object { [IO.Path]::Combine($_, 'bin') } | Where-Object { [IO.File]::Exists([IO.Path]::Combine($_, 'bash.exe')) } | Select-Object -First 1",
  "if ($t3GitBash) { $env:PATH = $t3GitBash + ';' + $env:PATH } else {",
  ...["bash", "sh"].map(
    (name) =>
      `  function ${name} { [Console]::Error.WriteLine(${escapePowerShellStringLiteral(
        `${name}: no Git Bash found: no bin\\bash.exe in the install of the git on PATH, in Program Files\\Git or in LOCALAPPDATA\\Programs\\Git. Install Git for Windows (https://git-scm.com/download/win); WSL's bash runs through wsl.`,
      )}); exit 127 }`,
  ),
  "}",
];

// Names itself first, then runs the command and outlives it to write its exit status; each rename
// makes its file appear whole. Arguments: log, status file, pid file, then the command's argv.
const POSIX_WRAPPER = [
  'printf "%s\\n" "$$" >"$3.tmp" && mv -f "$3.tmp" "$3"',
  'exec >>"$1" 2>&1 </dev/null',
  'run() { shift 3; "$@"; }',
  'run "$@"',
  "code=$?",
  'printf "%s\\n" "$code" >"$2.tmp" && mv -f "$2.tmp" "$2"',
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
  /** The last check that found its process alive, written about once a minute while it runs. */
  readonly last_alive_at: string | null;
  /** What the last probe of its pid that did not find it alive reported. */
  readonly probe_error: string | null;
  readonly lost_reason: LostReason | null;
  /** Its output's tail when it was lost. */
  readonly lost_output: string | null;
}

/**
 * Why a command counts as lost: its record names no process, its process is gone, the machine
 * restarted since it started, or its pid now names a later process.
 */
type LostReason = "no-pid" | "gone" | "rebooted" | "pid-reused";

/** One line of the losses log: the commands lost together, and how many still ran. */
const LossWave = Schema.fromJsonString(
  Schema.Struct({
    time: Schema.String,
    lost: Schema.Number,
    running: Schema.Number,
    runs: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        threadId: Schema.String,
        pid: Schema.NullOr(Schema.Number),
        lostReason: Schema.NullOr(Schema.String),
        probeError: Schema.NullOr(Schema.String),
        startedAt: Schema.String,
        lastAliveAt: Schema.NullOr(Schema.String),
        endedAt: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const encodeLossWave = Schema.encodeEffect(LossWave);

/** What the losses log keeps of each lost command. */
const lossEvidence = (row: CommandRunRow) => ({
  taskId: row.task_id,
  threadId: row.thread_id,
  pid: row.pid,
  lostReason: row.lost_reason,
  probeError: row.probe_error,
  startedAt: row.started_at,
  lastAliveAt: row.last_alive_at,
  endedAt: row.ended_at,
});
const decodeLossWave = Schema.decodeUnknownOption(LossWave);

interface Loss {
  readonly lost_reason: LostReason;
  readonly probe_error: string | null;
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

type CommandShellName = OrchestratorMcpRunCommandResult["shell"];

/** What the tool description (`tools.ts`) says of each shell; the test keeps the two in step. */
export const COMMAND_SHELL_LABELS: Readonly<Record<CommandShellName, string>> = {
  powershell: "Windows PowerShell 5.1",
  bash: "bash",
  zsh: "zsh",
  sh: "/bin/sh",
};

/**
 * Windows runs PowerShell. Elsewhere bash or zsh as the user's own commands expect; anything else
 * (fish, nu) gets /bin/sh. A path with `=` would read as an assignment to `env`.
 */
export const resolveCommandShell = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { readonly name: CommandShellName; readonly path: string } => {
  if (platform === "win32") return { name: "powershell", path: "powershell.exe" };
  const path = env.SHELL;
  const match = path === undefined ? null : /^\/(?:[^=]*\/)?(ba|z)sh$/.exec(path);
  if (path === undefined || match === null) return { name: "sh", path: "/bin/sh" };
  return { name: match[1] === "ba" ? "bash" : "zsh", path };
};

/** The options and functions bash, /bin/sh on macOS and many Linux systems, reads from its environment. */
const isShellConfiguration = (name: string) =>
  name === "SHELLOPTS" ||
  name === "BASHOPTS" ||
  name === "EXECIGNORE" ||
  name.startsWith("BASH_FUNC_");

/**
 * The launcher keeps the host's PATH, or the shell's default search when it has none, to find its
 * `mv`, and `env` arguments turn its environment into the command's own. Shell configuration
 * reaches only the command, so an option such as errexit cannot stop the launcher recording the end.
 */
const posixLaunchEnvironment = (
  host: Readonly<Record<string, string>>,
  command: Readonly<Record<string, string>>,
) => {
  const { PATH: commandPath, ...commandWithoutPath } = command;
  const env = Object.fromEntries(
    Object.entries({ ...host, ...commandWithoutPath }).filter(
      ([name]) => !isShellConfiguration(name),
    ),
  );
  const envArgs = [
    ...Object.keys(env).flatMap((name) => (Object.hasOwn(command, name) ? [] : ["-u", name])),
    ...Object.entries(command)
      .filter(([name]) => isShellConfiguration(name))
      .map(([name, value]) => `${name}=${value}`),
    ...(commandPath === undefined || commandPath === env.PATH ? [] : [`PATH=${commandPath}`]),
  ];
  return { env, prefix: envArgs.length === 0 ? [] : ["/usr/bin/env", ...envArgs] };
};

/**
 * Ids under the wrapper by `ParentProcessId`, which outlives it (a named Job object does not). A
 * child older than its parent belongs to an earlier holder of that pid; the wrapper's children
 * also start after the command, and before the pid's holder when that is no longer the wrapper.
 */
export const WINDOWS_COMMAND_TREE_FUNCTION = [
  "function Ms($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }",
  "function Get-T3CommandTree($all, $root, $since, $identity) {",
  "  $targets = @{}",
  "  $before = [long]::MaxValue",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ms $holder.CreationDate",
  "    if ($identity -ge 0 -and [math]::Abs($made - $identity) -gt 1000) { $before = $made } else { $targets[$root] = $true }",
  "  }",
  "  $queue = New-Object System.Collections.Queue",
  "  $queue.Enqueue(@($root, $since, $before))",
  "  $seen = @{ $root = $true }",
  "  while ($queue.Count -gt 0) {",
  "    $id, $after, $limit = $queue.Dequeue()",
  "    foreach ($child in $all) {",
  "      if ($child.ParentProcessId -ne $id -or $seen.ContainsKey($child.ProcessId)) { continue }",
  "      $made = Ms $child.CreationDate",
  "      if ($made -ge $after -and $made -lt $limit) {",
  "        $seen[$child.ProcessId] = $true; $targets[$child.ProcessId] = $true",
  "        $queue.Enqueue(@($child.ProcessId, $made, [long]::MaxValue))",
  "      }",
  "    }",
  "  }",
  "  return $targets",
  "}",
].join("\n");

const windowsStopScript = (pid: number, sinceMs: number, identityMs: number | null) =>
  [
    "$ErrorActionPreference = 'Stop'",
    WINDOWS_COMMAND_TREE_FUNCTION,
    "for ($pass = 0; $pass -lt 5; $pass++) {",
    `  $targets = Get-T3CommandTree @(Get-CimInstance Win32_Process) ${pid} ${sinceMs} ${identityMs ?? -1}`,
    "  if ($targets.Count -eq 0) { break }",
    "  foreach ($id in $targets.Keys) {",
    "    try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw } }",
    "  }",
    "}",
  ].join("\n");

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
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const agentScope = yield* AgentScope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { logsDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const windows = platform === "win32";
  const hostEnv = yield* HostProcess.Environment;
  const watchInterval = yield* WatchInterval;

  const commandsDir = path.join(logsDir, "commands");
  const hostCommandEnv = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isServerOnlyEnvKey(entry[0]),
    ),
  );
  /** Commands whose end has not reached their task yet, by task id. */
  const watched = new Map<string, CommandRunRow>();
  /** Commands that ended within the last WAVE_WINDOW, however they ended, by task id. */
  const recentEnds = new Map<string, { readonly at: number; readonly row: CommandRunRow }>();
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

  /** Why `pid` no longer names the process this command started; undefined while it does. */
  const lossOf = Effect.fn("CommandRunner.lossOf")(function* (
    row: CommandRunRow,
  ): Effect.fn.Return<Loss | undefined> {
    const probe_error = row.probe_error;
    if (row.pid === null) return { lost_reason: row.lost_reason ?? "no-pid", probe_error };
    if (yield* rebootedSince(row)) return { lost_reason: "rebooted", probe_error };
    const probe = probeProcess(row.pid);
    if (probe.state === "gone") return { lost_reason: "gone", probe_error: probe.code };
    if (row.process_started_at === null) return undefined;
    const startedAt = yield* startedAtOf(row.pid);
    // ps reports whole seconds. Unknown identity stays conservative.
    return startedAt === undefined || Math.abs(startedAt - row.process_started_at) <= 1_000
      ? undefined
      : { lost_reason: "pid-reused", probe_error };
  });
  const isSameProcess = (row: CommandRunRow) =>
    lossOf(row).pipe(Effect.map((loss) => loss === undefined));

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
   * Stops the command and everything it started: its process group, or on Windows what descends
   * from its wrapper's pid (`windowsStopScript`), also after the wrapper ended. A group outlives
   * its wrapper and its id is not reused while any member lives, so short of a reboot, only a live
   * process reusing the wrapper's pid means nothing of the group is left.
   */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    const pid = row.pid;
    if (pid !== null && !(yield* rebootedSince(row))) {
      if (!windows) {
        if (!isProcessAlive(pid) || (yield* isSameProcess(row))) yield* killGroup(pid);
      } else {
        yield* processRunner
          .run({
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              windowsStopScript(pid, Date.parse(row.started_at), row.process_started_at),
            ],
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
        delivered_at = ${row.delivered_at}, last_alive_at = ${row.last_alive_at},
        probe_error = ${row.probe_error}, lost_reason = ${row.lost_reason},
        lost_output = ${row.lost_output}
      WHERE task_id = ${row.task_id}
    `;

  /** Records a watched command's new state; one that is delivered is no longer watched. */
  const settle = Effect.fn("CommandRunner.settle")(function* (row: CommandRunRow) {
    yield* writeRow(row);
    if (row.delivered_at === null) watched.set(row.task_id, row);
    else watched.delete(row.task_id);
    if (row.ended_at !== null) recentEnds.set(row.task_id, { at: Date.parse(row.ended_at), row });
  });

  const readTail = (row: CommandRunRow) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(logPathOf(row), { flag: "r" });
        const size = Number((yield* file.stat).size);
        const start = Math.max(0, size - RESULT_TAIL_BYTES);
        yield* file.seek(BigInt(start), "start");
        const bytes = yield* file.readAlloc(size - start);
        return Option.match(bytes, {
          onNone: () => "",
          onSome: (read) => decodeTail(read, start > 0),
        });
      }),
    ).pipe(
      Effect.map((tail) => tail.trimEnd()),
      Effect.orElseSucceed(() => ""),
    );

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
    const output = yield* readTail(row);
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

  /** The wave still going on, if any, and the waves the losses log does not hold as they are now. */
  let openWave: typeof LossWave.Type | undefined;
  const unsaved = new Map<string, typeof LossWave.Type>();
  /** Set once a write of the log fails and until one succeeds, so the failure is logged once. */
  let saveFailing = false;
  const lossLogPath = path.join(logsDir, LOSS_LOG_FILE);

  /** Each line of the losses log, with its wave when the line reads as one. */
  const readLossLog = fs.readFileString(lossLogPath).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => ({ line, wave: Option.getOrUndefined(decodeLossWave(line)) })),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
  );

  /**
   * Ends an earlier server recorded within the window still count, and the log's last wave goes
   * on when its latest loss came within WAVE_WINDOW of the first loss since, as it would have
   * without the restart.
   */
  const resumeWave = Effect.gen(function* () {
    const since = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, WAVE_WINDOW));
    const ended = yield* sql<CommandRunRow>`
      SELECT * FROM command_runs WHERE ended_at > ${since}
    `;
    for (const row of ended) {
      if (row.ended_at !== null) recentEnds.set(row.task_id, { at: Date.parse(row.ended_at), row });
    }
    const lossTimes = ended.flatMap((row) =>
      row.status === "lost" && row.ended_at !== null ? [Date.parse(row.ended_at)] : [],
    );
    if (lossTimes.length === 0) return;
    const last = (yield* readLossLog).at(-1)?.wave;
    if (last === undefined) return;
    const latest = Math.max(
      ...last.runs.map((run) => (run.endedAt === null ? -Infinity : Date.parse(run.endedAt))),
    );
    if (latest > Math.min(...lossTimes) - Duration.toMillis(WAVE_WINDOW)) openWave = last;
  });

  /**
   * Writes the unsaved waves to the losses log in place of their earlier lines, and drops waves
   * from before `keepSince`. A line that does not read as a wave cannot be dated, so it stays. The
   * log is replaced whole, so no line is torn.
   */
  const saveWaves = Effect.fn("CommandRunner.saveWaves")(function* (keepSince: string) {
    const lines = yield* Effect.forEach(unsaved.values(), (wave) => encodeLossWave(wave));
    const kept = (yield* readLossLog).filter(
      ({ wave }) => wave === undefined || (wave.time >= keepSince && !unsaved.has(wave.time)),
    );
    const temp = `${lossLogPath}.tmp`;
    yield* fs.makeDirectory(logsDir, { recursive: true });
    yield* fs.writeFileString(temp, [...kept.map(({ line }) => line), ...lines].join("\n") + "\n");
    yield* fs.rename(temp, lossLogPath);
    unsaved.clear();
  });

  /**
   * Ends a command gone without an exit status, keeping what shows how: its output before
   * anything is stopped, and when it was last seen alive. What it started is not left running.
   */
  const recordLoss = Effect.fn("CommandRunner.recordLoss")(function* (
    row: CommandRunRow,
    loss: Loss,
  ) {
    const output = yield* readTail(row);
    yield* killTree(row);
    const lost: CommandRunRow = {
      ...row,
      ...loss,
      status: "lost",
      ended_at: yield* nowIso,
      lost_output: output === "" ? null : output,
    };
    yield* settle(lost);
    return lost;
  });

  /**
   * Starts a wave once more than half the commands of the last minute were lost, adds each later
   * loss to it, and saves it; a save that fails is tried again at the next pass.
   */
  const noteWave = Effect.fn("CommandRunner.noteWave")(function* () {
    const now = yield* DateTime.now;
    const cutoff = DateTime.toEpochMillis(DateTime.subtractDuration(now, WAVE_WINDOW));
    for (const [taskId, { at }] of recentEnds) if (at <= cutoff) recentEnds.delete(taskId);
    const losses = [...recentEnds.values()].flatMap(({ row }) =>
      row.status === "lost" ? [row] : [],
    );
    if (losses.length === 0) openWave = undefined;
    else {
      const running = [...watched.values()].filter((row) => row.status === "running").length;
      if (openWave === undefined && 2 * losses.length > running + recentEnds.size) {
        yield* Effect.logWarning("command-runner.loss-wave", {
          lost: losses.length,
          running,
          ended: recentEnds.size - losses.length,
          filePath: lossLogPath,
        });
        openWave = { time: DateTime.formatIso(now), lost: 0, running, runs: [] };
      }
      const known = new Set(openWave?.runs.map((run) => run.taskId));
      const added = losses.filter((row) => !known.has(row.task_id));
      if (openWave !== undefined && added.length > 0) {
        openWave = {
          ...openWave,
          lost: openWave.lost + added.length,
          running,
          runs: [...openWave.runs, ...added.map(lossEvidence)],
        };
        unsaved.set(openWave.time, openWave);
      }
    }
    if (unsaved.size === 0) return;
    yield* saveWaves(DateTime.formatIso(DateTime.subtractDuration(now, RETENTION))).pipe(
      Effect.andThen(
        Effect.sync(() => {
          saveFailing = false;
        }),
      ),
      Effect.catchCause((cause) =>
        saveFailing
          ? Effect.void
          : Effect.logWarning("command-runner.loss-log-write-failed", {
              filePath: lossLogPath,
              cause,
            }).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  saveFailing = true;
                }),
              ),
            ),
      ),
    );
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
    const lose = Effect.fn("CommandRunner.lose")(function* (loss: Loss) {
      // Its wrapper writes the status just before it exits.
      const late = yield* readExitStatus(row);
      if (late !== undefined) return yield* ended("exited", late.code, late.endedAt);
      yield* deliver(yield* recordLoss(row, loss));
    });
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
    if (row.pid === null) return yield* lose({ lost_reason: "no-pid", probe_error: null });
    const probe = probeProcess(row.pid);
    if (probe.state === "gone") {
      return yield* lose({ lost_reason: "gone", probe_error: probe.code });
    }
    if (probe.state === "unknown") {
      // A probe that cannot tell proves nothing gone, so the next check asks again.
      if (row.probe_error !== probe.code) {
        yield* Effect.logWarning("command-runner.probe-failed", {
          taskId: row.task_id,
          pid: row.pid,
          code: probe.code,
        });
        yield* settle({ ...row, probe_error: probe.code });
      }
    } else {
      // Written once a wall-clock minute, for the next server; a loss writes the exact time.
      const seen: CommandRunRow = { ...row, last_alive_at: yield* nowIso };
      const minuteOf = (at: string | null) =>
        at === null ? -1 : Math.floor(Date.parse(at) / 60_000);
      if (minuteOf(row.last_alive_at) === minuteOf(seen.last_alive_at)) {
        watched.set(row.task_id, seen);
      } else {
        yield* settle(seen);
      }
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
    ).pipe(Effect.andThen(noteWave())),
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

  /**
   * A thread that is archived or deleted keeps nothing running. It looks under the lock, so a
   * command still starting is watched by then, and run() starts none for a closed thread after.
   */
  const stopForThread = Effect.fn("CommandRunner.stopForThread")(function* (
    threadId: ThreadId,
    why: "archived" | "deleted",
  ) {
    const running = yield* lock.withPermits(1)(
      Effect.sync(() =>
        [...watched.values()].filter(
          (row) => row.thread_id === threadId && row.status === "running",
        ),
      ),
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

  const spawnDetached = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) =>
    Effect.callback<number, CommandLaunchError>((resume) => {
      const child = NodeChildProcess.spawn(command, args, {
        cwd,
        env,
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
    /** The command's whole environment, as the calling agent's own shell commands get it. */
    commandEnv: Readonly<Record<string, string>>,
  ) {
    const logPath = path.join(directory, LOG_FILE);
    const statusPath = path.join(directory, STATUS_FILE);
    if (Object.entries(commandEnv).some((entry) => entry.join("=").includes("\0"))) {
      return yield* new CommandLaunchError({
        detail: "An environment variable for the command contains a NUL character.",
      });
    }
    if (!windows) {
      const { env, prefix } = posixLaunchEnvironment(hostCommandEnv, commandEnv);
      const scoped = yield* agentScope.wrap({
        command: "/bin/sh",
        args: [
          "-c",
          POSIX_WRAPPER,
          "t3-command",
          logPath,
          statusPath,
          path.join(directory, PID_FILE),
          ...prefix,
          resolveCommandShell(platform, env).path,
          "-c",
          command,
        ],
        name: "command",
        env,
        survivesRestart: true,
      });
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd, env);
      return { pid, unit: scoped.unit ?? null };
    }
    // Win32_Process.Create parents the wrapper under WMI, outside this server's job and tree. Its
    // startup block is the command's whole environment, which the launcher reads from stdin so no
    // value reaches the disk.
    const scriptPath = path.join(directory, "command.ps1");
    const wrapperPath = path.join(directory, "run.ps1");
    yield* fs.writeFileString(
      scriptPath,
      [
        "\uFEFF$ErrorActionPreference = 'Continue'",
        ...WINDOWS_GIT_BASH,
        command,
        "$t3Ok = $?",
        "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
        "if (-not $t3Ok) { exit 1 }",
        "exit 0",
        "",
      ].join("\r\n"),
    );
    yield* fs.writeFileString(wrapperPath, WINDOWS_WRAPPER);
    yield* fs.writeFileString(logPath, "");
    const created = yield* processRunner.run({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Windows folds names by a case table only it has, so the launcher keeps the last of the
        // spellings Windows reads as one name. It keeps them in a list: a dictionary key named
        // like a member (Values) hides that member in PowerShell.
        `$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split([char]0); $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); $environment = [Collections.Generic.List[string]]::new(); for ($i = $entries.Length - 1; $i -ge 0; $i--) { if ($names.Add($entries[$i].Substring(0, [Math]::Max(0, $entries[$i].IndexOf('=', 1))))) { $environment.Insert(0, $entries[$i]) } }; $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $environment.ToArray(); CreateFlags = [uint32]${CREATE_UNICODE_ENVIRONMENT}; ShowWindow = [uint16]${SW_HIDE} }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"' + $powershell + ${escapePowerShellStringLiteral(`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperPath}"`)}; CurrentDirectory = ${escapePowerShellStringLiteral(cwd)}; ProcessStartupInformation = $startup }; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned $($r.ReturnValue)"); exit 1 }; $r.ProcessId`,
      ],
      // Base64, since PowerShell decodes stdin with the console code page.
      stdin: Buffer.from(
        Object.entries(commandEnv)
          .map(([name, value]) => `${name}=${value}`)
          .join("\0"),
        "utf8",
      ).toString("base64"),
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
      // Read for the thread's folder, where the agent's own session read its settings, though `cwd` may differ.
      const instance = yield* providerInstances.getInstance(scope.thread.providerInstanceId);
      // A turned-off instance never resolved its secrets, so its environment would lack them.
      if (instance === undefined || !instance.enabled) {
        return yield* failure(
          "provider_unavailable",
          "This agent's provider is turned off or not running, so the environment its shell commands get is unknown.",
        );
      }
      const agentShellEnv =
        instance.shellEnvironment === undefined
          ? hostCommandEnv
          : yield* instance
              .shellEnvironment(base ?? cwd, hostCommandEnv, parentRun.modelSelection)
              .pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("command-runner.shell-environment-failed", {
                    parentThreadId: scope.thread.threadId,
                    cause,
                  }),
                ),
                Effect.mapError((cause) =>
                  failure(
                    "provider_unavailable",
                    `Could not read the environment this agent's shell commands get. ${cause.detail}`,
                  ),
                ),
              );
      const commandEnv = overrideEnvironment(
        agentShellEnv,
        { [PortScanner.AGENT_THREAD_ENV]: scope.thread.threadId },
        platform,
      );
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
        shell: resolveCommandShell(
          platform,
          windows ? {} : posixLaunchEnvironment(hostCommandEnv, commandEnv).env,
        ).name,
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
          /** Ends a task whose command never started, with nothing left to wake its thread for. */
          const unstarted = (message: string, status: "failed" | "interrupted" = "failed") =>
            threads
              .dispatch({
                type: "delegated_task.command.complete",
                commandId: CommandId.make(`command:command-task-unstarted:${taskId}`),
                parentThreadId: scope.thread.threadId,
                taskId,
                status,
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
                // Read again here: stopForTask or stopForThread may already have looked for a task
                // cancelled, or a thread closed, since the request began.
                const records = yield* threads
                  .getThreadRecords(scope.thread.threadId, ["subagents"], {
                    subagentIds: [taskId],
                  })
                  .pipe(Effect.result);
                if (records._tag === "Failure") {
                  return yield* unstarted(
                    `Could not start the command: ${records.failure.message}`,
                  );
                }
                const { thread, subagents } = records.success;
                // Cancelled, or its first request could not start it: the task already says why.
                const endedWith = subagents[0]?.result;
                if (endedWith != null) return yield* failure("orchestration_error", endedWith);
                const closed =
                  thread.deletedAt !== null
                    ? "deleted"
                    : thread.archivedAt !== null
                      ? "archived"
                      : undefined;
                if (closed !== undefined) {
                  return yield* unstarted(`Stopped: the chat was ${closed}.`, "interrupted");
                }
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
                  last_alive_at: null,
                  probe_error: null,
                  lost_reason: null,
                  lost_output: null,
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
                const started = yield* launch(directory, input.command, cwd, commandEnv).pipe(
                  Effect.result,
                );
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
                  last_alive_at: yield* nowIso,
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
    // A wrapper that is gone still names its group, which can outlive it. When it wrote the file
    // stands in for its start, so a later process under the pid is never taken for it.
    if (!isProcessAlive(pid)) {
      return { ...row, pid, process_started_at: named.writtenAt?.getTime() ?? null };
    }
    const startedAt = yield* startedAtOf(pid);
    const writtenAt = named.writtenAt?.getTime();
    // It started before it wrote the file; a later process reusing the pid did not. ps reports
    // whole seconds.
    if (startedAt !== undefined && writtenAt !== undefined && startedAt > writtenAt + 1_000) {
      return { ...row, lost_reason: "pid-reused" as const };
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
    const loss = yield* lossOf(row);
    if (loss === undefined) {
      watched.set(row.task_id, row);
      return;
    }
    yield* recordLoss(row, loss);
  });

  /**
   * Picks up what an earlier server left: commands to watch again, ends to deliver, stops to
   * finish, and tasks whose command never got its record (the server stopped between the two),
   * which are lost.
   */
  const adopt = Effect.gen(function* () {
    // Before adoptRow, whose losses are this server's own.
    yield* resumeWave.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("command-runner.resume-wave-failed", { cause }),
      ),
    );
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
