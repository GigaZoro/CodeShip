// @effect-diagnostics nodeBuiltinImport:off - A command outlives the server, so it starts detached and unreferenced, outside every Effect scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { flow } from "effect/Function";
import { admitWorkspaceProcess } from "../workspace/workspaceLease.ts";

import {
  CommandId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpCommandCleanup,
  OrchestratorMcpFailure,
  type OrchestratorMcpRunCommandInput,
  type OrchestratorMcpRunCommandResult,
  ProviderDriverKind,
  type ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  holdProcessGroup,
  isFifoHolderHeld,
  releaseFifoHolder,
  signalProcessGroup,
} from "@t3tools/shared/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { probeProcess } from "@t3tools/shared/processProbe";
import { overrideEnvironment } from "@t3tools/shared/shell";
import {
  WindowsJobHost,
  windowsJobName,
  parseWindowsProcessIdentity,
  windowsCreationTimeMillis,
} from "@t3tools/shared/windowsJob";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import * as CpuAdmission from "../resourceTelemetry/CpuAdmission.ts";
import * as MemoryAdmission from "../resourceTelemetry/MemoryAdmission.ts";
import { forkParked } from "../serverActivation.ts";
import { LOG_KEEP_BYTES, LOG_TRIM_AT_BYTES, TRIMMED_MARKER } from "./posixLogWriter.ts";
import {
  readProcessStartedAt,
  readWindowsProcessIdentity,
  readWindowsProcessNaming,
} from "../serverRuntimeState.ts";
import {
  ENDED_IDENTITY,
  compareIdentity,
  identityTime,
  identityWindow,
  linuxIdentity,
  timeIdentity,
} from "./processIdentity.ts";
import { isServerOnlyEnvKey } from "../terminal/userShellEnv.ts";

/** How often running commands are checked; tests shorten it. */
export const WatchInterval = Context.Reference<Duration.Duration>(
  "t3/commandRunner/WatchInterval",
  { defaultValue: () => Duration.seconds(1) },
);

/** How long a shortage holds the queue before memory is read again; tests set their own. */
export const ShortageRecheck = Context.Reference<Duration.Duration>(
  "t3/commandRunner/ShortageRecheck",
  { defaultValue: () => Duration.millis(MemoryAdmission.SHORTAGE_RECHECK_MS) },
);

const LOG_FILE = "output.log";
const STATUS_FILE = "exit-status";
const PID_FILE = "pid";
const WRAPPER_FILE = "run.ps1";
const LAUNCH_PENDING = "launch-pending";
const LAUNCH_STARTED = "launch-started";
const LAUNCH_CANCELLED = "launch-cancelled";
// PowerShell startup and WMI can each be slow on a loaded Windows host.
const WINDOWS_LAUNCH_TIMEOUT = Duration.minutes(2);
const HOLDER_FILE = "group-holder";
const LOG_COPY_CHUNK_BYTES = 1024 * 1024;
// Read double the diagnostic tail so dense ANSI sequences do not crowd out final lines.
const RESULT_TAIL_READ_BYTES = 8 * 1024;
export const RESULT_SUCCESS_TAIL_CHARS = 1536;
export const RESULT_FAILURE_TAIL_CHARS = 4 * 1024;
const KILL_GRACE = Duration.seconds(5);
/** How long a cancel waits for its command to stop before it reports that cleanup is pending. */
const CANCEL_REPORT_WAIT = Duration.seconds(15);
const RETENTION = Duration.days(14);
const RETENTION_INTERVAL = Duration.hours(1);
/**
 * More than half the commands that ran within this window lost is a wave. It goes on while each
 * loss comes within this window of the one before, and is logged as one warning.
 */
const WAVE_WINDOW = Duration.minutes(1);
/**
 * The waves as the database holds them, rewritten whenever one changes. A wave lasts as long as a
 * record it holds, which is RETENTION after its command's end was delivered.
 */
export const LOSS_LOG_FILE = "command-losses.ndjson";
const COMMAND_DRIVER = ProviderDriverKind.make("command");
// Win32_ProcessStartup's Create_Unicode_Environment (without it the block is ANSI).
const CREATE_UNICODE_ENVIRONMENT = 0x400;
// Win32_ProcessStartup's ShowWindow as SW_HIDE: the wrapper's console, which only it uses, opens
// no window. Windows PowerShell started with no console at all (Detached_Process) exits at once.
const SW_HIDE = 0;
// Without it, Windows PowerShell reads a script in the ANSI code page, which changes what the script
// holds outside that page, such as a command's text or folder.
const UTF8_BOM = "﻿";

// Runs command.ps1 in a new console with no window, shared by the command and what it starts, so no
// console event they get (Ctrl+C, Ctrl+Break, its closing) reaches the wrapper, which outlives them to
// write the exit status; each rename makes its file appear whole. The wrapper works in its own folder,
// since Windows will not remove a folder a process works in: the command's is free once it ends.
const windowsWrapper = (cwd: string) =>
  [
    `${UTF8_BOM}$ErrorActionPreference = 'Stop'`,
    "$code = 1",
    "function Write-T3File($name, $value) {",
    "  $file = Join-Path $PSScriptRoot $name",
    `  Set-Content -LiteralPath "$file.tmp" -Value $value`,
    `  Move-Item -Force -LiteralPath "$file.tmp" -Destination $file`,
    "}",
    "try {",
    `  try { [IO.Directory]::Move((Join-Path $PSScriptRoot '${LAUNCH_PENDING}'), (Join-Path $PSScriptRoot '${LAUNCH_STARTED}')) } catch {`,
    `    $why = if ([IO.Directory]::Exists((Join-Path $PSScriptRoot '${LAUNCH_CANCELLED}'))) { 'Command launch was cancelled before it started.' } else { "Could not take the command start gate: $_" }`,
    `    Add-Content -LiteralPath (Join-Path $PSScriptRoot '${LOG_FILE}') -Value $why`,
    "    exit 1",
    "  }",
    "  $system = [Environment]::SystemDirectory",
    "  $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $system 'cmd.exe'))",
    // cmd only appends the output of PowerShell and everything it starts to the log. Input is NUL,
    // as /dev/null elsewhere: a command that reads it ends instead of waiting on the hidden console.
    // The paths reach cmd as variables, which it expands once, so a % or ! in them stays as written;
    // cmd clears them before it starts PowerShell, so the command never sees them.
    "  $start.EnvironmentVariables['T3CODE_COMMAND_POWERSHELL'] = Join-Path $system 'WindowsPowerShell\\v1.0\\powershell.exe'",
    "  $start.EnvironmentVariables['T3CODE_COMMAND_SCRIPT'] = Join-Path $PSScriptRoot 'command.ps1'",
    `  $start.EnvironmentVariables['T3CODE_COMMAND_LOG'] = Join-Path $PSScriptRoot '${LOG_FILE}'`,
    `  $start.Arguments = '/d /v:off /s /c "set "T3CODE_COMMAND_POWERSHELL=" & set "T3CODE_COMMAND_SCRIPT=" & set "T3CODE_COMMAND_LOG=" & "%T3CODE_COMMAND_POWERSHELL%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%T3CODE_COMMAND_SCRIPT%" < NUL >> "%T3CODE_COMMAND_LOG%" 2>&1"'`,
    `  $start.WorkingDirectory = ${escapePowerShellStringLiteral(cwd)}`,
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

// The registered wrapper stays the command's parent. It names itself and takes the start gate,
// then hands output to a detached reader that owns the log across server restarts and acknowledges
// completion even when descendants inherit the output pipe. Arguments: log, status file, pid file,
// runtime, cliEntry, then the command's argv.
const POSIX_WRAPPER = [
  // Linux publishes kernel start ticks; macOS publishes ps's own rounded creation time.
  "if [ -r /proc/$$/stat ]; then",
  "  stat=$(cat /proc/$$/stat) && boot=$(cat /proc/sys/kernel/random/boot_id) || exit 125",
  '  ticks=$(printf "%s\\n" "${stat##*) }" | cut -d " " -f 20)',
  '  identity="boot:$boot:$ticks"',
  "else",
  '  started=$(LC_ALL=C TZ=UTC /bin/ps -p "$$" -o lstart=) && [ -n "$started" ] || exit 125',
  '  identity="ps:$started"',
  "fi",
  'printf "%s\\n%s\\n" "$$" "$identity" >"$3.tmp" && mv -f "$3.tmp" "$3" || exit 1',
  'if ! mv "${3%/*}/launch-pending" "${3%/*}/launch-started" 2>/dev/null; then',
  '  if [ -d "${3%/*}/launch-cancelled" ]; then',
  '    printf "%s\\n" "Command launch was cancelled before it started." >>"$1"',
  '  else printf "%s\\n" "Could not take the command start gate." >>"$1"; fi',
  '  printf "1\\n" >"$2.tmp" && mv -f "$2.tmp" "$2"',
  "  exit 0",
  "fi",
  'fail() { printf "%s\\n" "CodeShip could not capture command output." >>"$1"; printf "1\\n" >"$2.tmp" && mv -f "$2.tmp" "$2"; exit 1; }',
  'mkfifo -m 600 "$1.pipe" "$1.ack" || fail "$1" "$2"',
  "writer() {",
  '  if [ -n "$5" ]; then set -- "$4" "$5" __command-log "$1" "$2" --input-fd 3;',
  '  else set -- "$4" __command-log "$1" "$2" --input-fd 3; fi',
  '  exec /usr/bin/env -i ELECTRON_RUN_AS_NODE=1 "$@"',
  "}",
  'writer "$@" </dev/null 3<"$1.pipe" >"$1.ack" &',
  'exec 4>"$1.pipe" 3<"$1.ack"',
  'rm -f "$1.pipe" "$1.ack"',
  'set -- "$(IFS= read -r token <&3 && printf %s "$token")" "$@"',
  '[ -n "$1" ] || fail "$2" "$3"',
  'run() { shift 6; "$@"; }',
  'run "$@" </dev/null >&4 2>&1 3<&- 4>&-',
  'printf "%s\\n" "$?" >"$3.tmp" || exit 1',
  "trap '' PIPE",
  'printf "\\000%s\\000" "$1" >&4 || fail "$2" "$3"',
  "exec 4>&-",
  'IFS= read -r ack <&3 || fail "$2" "$3"',
].join("\n");

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/**
 * `queued`: it waits for memory or CPU to start, with no process yet. `lost`: it vanished without an
 * exit status. `stopped`: its task got a result elsewhere (task_cancel, Stop, archive), so the
 * runner stopped it. `unstarted`: its gate closed before it ran, since its launch failed or the
 * server stopped during it.
 */
type CommandRunStatus =
  | "queued"
  | "running"
  | "exited"
  | "timed_out"
  | "lost"
  | "stopped"
  | "unstarted";

interface CommandRunRow {
  readonly task_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly label: string | null;
  readonly command: string;
  /** The shell it asked for; null is the platform's own. */
  readonly shell: "bash" | null;
  readonly cwd: string;
  readonly directory: string;
  /** Null from its record until its process starts. */
  readonly pid: number | null;
  readonly process_identity: string | null;
  /**
   * Full FILETIME, which alone authorizes a Windows stop. An older row gets it once its live
   * process matches the millisecond its launcher recorded.
   */
  readonly windows_created_at: string | null;
  readonly unit: string | null;
  readonly status: CommandRunStatus;
  readonly exit_code: number | null;
  /** When it started, so its time limit counts from there; while queued, when it was queued. */
  readonly started_at: string;
  readonly deadline_at: string;
  readonly ended_at: string | null;
  readonly delivered_at: string | null;
  /** The caller can receive a deadline failure while uncertain legacy ownership still needs checking. */
  readonly reported_at: string | null;
  /** The last check that found its process alive, written about once a minute while it runs. */
  readonly last_alive_at: string | null;
  /** What the last probe of its pid that did not find it alive reported. */
  readonly probe_error: string | null;
  readonly lost_reason: LostReason | Unproven["lost_reason"] | null;
  /** Its output's tail when it was lost. */
  readonly lost_output: string | null;
  readonly launch_error: string | null;
  /** Why its exit status could not be read when it was stopped, which did not wait for it. */
  readonly exit_status_error: string | null;
  /**
   * The processes the last stop of a command without a job could not end, as the host's `left`
   * lines name them. The next stop starts from them, since their parents may have ended.
   */
  readonly stop_leftovers: string | null;
}

/** Why a queued command could not start, for its task. */
interface UnstartedEnd {
  readonly row: CommandRunRow;
  readonly status: "failed" | "interrupted";
  readonly result: string;
}

/** A process a stop without a job could not end, and why. */
interface StopLeftover {
  readonly pid: number;
  readonly created: string;
  readonly reason: string;
}

const LEFTOVER_LINE = /^left (\d+) (\d+) (.+)$/;

/** The `left <pid> <created> <reason>` lines the host prints, which a row also keeps. */
const stopLeftovers = (text: string | null): ReadonlyArray<StopLeftover> =>
  (text ?? "").split("\n").flatMap((line) => {
    const match = LEFTOVER_LINE.exec(line.trim());
    return match === null ? [] : [{ pid: Number(match[1]), created: match[2]!, reason: match[3]! }];
  });

/** A result names this many of the processes its stop left, then how many more. */
const LEFTOVERS_SHOWN = 5;
/** Room for a `left` line for each of thousands of processes. */
const STOP_TREE_OUTPUT_BYTES = 1_048_576;

type LaunchResolution =
  /** Its gate closed before the command ran; the row names any process its launcher published. */
  | { readonly outcome: "cancelled"; readonly row: CommandRunRow }
  | { readonly outcome: "started"; readonly row: CommandRunRow }
  | { readonly outcome: "ended"; readonly row: CommandRunRow; readonly loss: Loss }
  | { readonly outcome: "unresolved" };

/**
 * Why a command counts as lost: its record names no process, its process is gone, the machine
 * restarted since it started, or its pid now names a later process.
 */
type LostReason = "no-pid" | "gone" | "rebooted" | "pid-reused";

/** One line of the losses log: the commands lost together, and how many still ran when it began. */
const LossWave = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
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

type LossEvidenceRow = Pick<
  CommandRunRow,
  | "task_id"
  | "thread_id"
  | "pid"
  | "lost_reason"
  | "probe_error"
  | "started_at"
  | "last_alive_at"
  | "ended_at"
>;

/** What the losses log keeps of each lost command. */
const lossEvidence = (row: LossEvidenceRow) => ({
  taskId: row.task_id,
  threadId: row.thread_id,
  pid: row.pid,
  lostReason: row.lost_reason,
  probeError: row.probe_error,
  startedAt: row.started_at,
  lastAliveAt: row.last_alive_at,
  endedAt: row.ended_at,
});

/**
 * Places the losses no wave holds yet, oldest first. One that comes within WAVE_WINDOW after the
 * latest loss of the last wave joins it. The others wait, and those of the WAVE_WINDOW up to one
 * start a wave when they are more than half of `commandsAt` it, the commands that ran in that time.
 */
export const placeLosses = <L extends { readonly at: number }>(
  lastLossAt: number | undefined,
  losses: ReadonlyArray<L>,
  commandsAt: (at: number) => number,
) => {
  const window = Duration.toMillis(WAVE_WINDOW);
  const joining: Array<L> = [];
  const waves: Array<{ readonly at: number; readonly losses: Array<L> }> = [];
  let waiting: Array<L> = [];
  let latest = lastLossAt;
  for (const loss of [...losses].sort((a, b) => a.at - b.at)) {
    if (latest !== undefined && loss.at >= latest && loss.at - latest <= window) {
      (waves.at(-1)?.losses ?? joining).push(loss);
      latest = loss.at;
      continue;
    }
    waiting.push(loss);
    const recent = waiting.filter((other) => other.at > loss.at - window);
    if (2 * recent.length > commandsAt(loss.at)) {
      waves.push({ at: loss.at, losses: recent });
      waiting = waiting.filter((other) => other.at <= loss.at - window);
      latest = loss.at;
    }
  }
  return { joining, waves, waiting };
};

interface Loss {
  readonly lost_reason: LostReason;
  readonly probe_error: string | null;
}

/**
 * Not a loss: an older Windows record whose live pid nothing it holds can tell from a later
 * process's, so CodeShip never stops it and says so at its deadline or cancellation.
 */
interface Unproven {
  readonly lost_reason: "unproven";
  readonly probe_error: string | null;
}

/**
 * What a stopped or timed-out command's report says about its processes: they were stopped, the
 * stop has not finished yet, or the launch was cancelled before it started any.
 */
type Cleanup = "done" | "pending" | "never-started";

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
    /**
     * Stops a command its caller cancelled, then reports what happened to its task: its end once
     * it has stopped, or, after CANCEL_REPORT_WAIT, that cleanup is still pending. A task whose
     * command is not recorded yet ends at once, and run() then never starts it. Returns what the
     * cancel did to the command, or undefined when the command had already ended or been reported.
     */
    readonly cancel: (input: {
      readonly parentThreadId: ThreadId;
      readonly taskId: NodeId;
      readonly reason: string | undefined;
    }) => Effect.Effect<OrchestratorMcpCommandCleanup | undefined, OrchestratorMcpFailure>;
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

class CommandStopError extends Schema.TaggedError<CommandStopError>()("CommandStopError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isCommandStopError = Schema.is(CommandStopError);

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

/** `caffeinate -i -w <pid>`: no elevation, and it exits with the watched process. */
export const macKeepAwakeCommand = (pid: number) =>
  ["/usr/bin/caffeinate", ["-i", "-w", String(pid)]] as const;

/**
 * Windows runs PowerShell, or Git Bash when asked for bash. Elsewhere bash or zsh as the user's own
 * commands expect; anything else (fish, nu) gets /bin/sh, and bash comes from PATH when the user's
 * shell is not bash. A path with `=` would read as an assignment to `env`.
 */
export const resolveCommandShell = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  requested: OrchestratorMcpRunCommandInput["shell"],
): { readonly name: CommandShellName; readonly path: string } => {
  if (platform === "win32") {
    return requested === "bash"
      ? { name: "bash", path: "bash.exe" }
      : { name: "powershell", path: "powershell.exe" };
  }
  const match = env.SHELL === undefined ? null : /^\/(?:[^=]*\/)?(ba|z)sh$/.exec(env.SHELL);
  if (requested === "bash") return { name: "bash", path: match?.[1] === "ba" ? match[0] : "bash" };
  if (match === null) return { name: "sh", path: "/bin/sh" };
  return { name: match[1] === "ba" ? "bash" : "zsh", path: match[0] };
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

const GIT_BASH_NAMES = ["bash", "sh"].flatMap((name) => [
  { name, exe: `${name}.exe` },
  { name: `${name}.exe`, exe: `${name}.exe` },
]);

const noGitBash = (name: string) =>
  escapePowerShellStringLiteral(
    `${name}: no Git Bash found: no bin\\bash.exe in the install of the git on PATH, in Program Files\\Git or in LOCALAPPDATA\\Programs\\Git. Install Git for Windows (https://git-scm.com/download/win); WSL's bash runs through wsl.`,
  );

// System32's bash.exe is WSL's: no node, no `C:/` paths. Sets $t3GitBash to the bin folder of Git
// for Windows, whose bash.exe sets up the PATH its own tools need.
const FIND_GIT_BASH = [
  "$t3GitBash = & {",
  "  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  if ($git) {",
  // --exec-path names the install behind a launcher or shim; GIT_EXEC_PATH would replace it. A git
  // that cannot answer leaves the standard folders, and the error below names where it looked.
  "    $probeJob = 'Global\\CodeShip.Job.' + [Guid]::NewGuid().ToString('N')",
  "    $run = $null",
  "    $probeError = $null",
  "    try {",
  "      $probeError = [IO.Path]::GetTempFileName()",
  `      $start = [Diagnostics.ProcessStartInfo]::new($t3JobHost, 'git-path "' + $probeJob + '" "' + $git.Path + '"')`,
  "      $start.UseShellExecute = $false",
  "      $start.RedirectStandardOutput = $true",
  "      $start.StandardOutputEncoding = [Text.Encoding]::UTF8",
  "      $start.EnvironmentVariables.Remove('GIT_EXEC_PATH')",
  "      $start.EnvironmentVariables['T3CODE_WINDOWS_JOB_DIAGNOSTIC'] = $probeError",
  "      $run = [Diagnostics.Process]::Start($start)",
  "      $out = $run.StandardOutput.ReadToEndAsync()",
  "      if ($run.WaitForExit(10000)) {",
  // <install>\<build>\libexec\git-core
  "        if ($run.ExitCode -eq 0 -and $out.Wait(1000) -and $out.Result.Trim()) { [IO.Path]::GetFullPath([IO.Path]::Combine($out.Result.Trim(), '..', '..', '..')) }",
  "        if ($run.ExitCode -ne 0) { [Console]::Error.Write([IO.File]::ReadAllText($probeError)) }",
  "      } else {",
  "        [Console]::Error.WriteLine(\"CodeShip stopped 'git --exec-path' ($($git.Path)), which did not answer within 10 s, and looks for Git Bash in the standard install folders.\")",
  "        $run.Kill(); $run.WaitForExit()",
  "      }",
  '    } catch { [Console]::Error.WriteLine("CodeShip could not ask git where Git Bash is: $_") } finally { if ($run) { if (-not $run.HasExited) { $run.Kill(); $run.WaitForExit() }; $run.Dispose() }; if ($probeError) { [IO.File]::Delete($probeError) } }',
  "  }",
  "  foreach ($folder in $env:ProgramFiles, $env:ProgramW6432, ${env:ProgramFiles(x86)}) { if ($folder) { [IO.Path]::Combine($folder, 'Git') } }",
  "  if ($env:LOCALAPPDATA) { [IO.Path]::Combine($env:LOCALAPPDATA, 'Programs', 'Git') }",
  "} | ForEach-Object { [IO.Path]::Combine($_, 'bin') } | Where-Object { [IO.File]::Exists([IO.Path]::Combine($_, 'bash.exe')) } | Select-Object -First 1",
];

// A PowerShell command's `bash` and `sh` are aliases of Git Bash's (a function would lose a `--`
// argument), or an error naming it. PATH stays as it is, since Git's bin also holds a git.exe that
// would replace the command's `git`; a program the command starts that runs `bash` itself still
// gets WSL's.
const GIT_BASH_ALIASES = [
  "if ($t3GitBash) {",
  ...GIT_BASH_NAMES.map(
    ({ name, exe }) =>
      `  Set-Alias -Name '${name}' -Value ([IO.Path]::Combine($t3GitBash, '${exe}'))`,
  ),
  "} else {",
  ...GIT_BASH_NAMES.map(
    ({ name }) => `  function ${name} { [Console]::Error.WriteLine(${noGitBash(name)}); exit 127 }`,
  ),
  "}",
];

/**
 * Runs a bash command's script in Git Bash. PowerShell 5.1's call operator drops a `"` inside an
 * argument, while Process.Start passes them as written: here only the script's path, in double
 * quotes, which Cygwin reads literally. With forward slashes, which Cygwin also reads as a Windows
 * path, no backslash can read as an escape (a `\\server` path's would).
 */
const runInGitBash = (scriptPath: string) => [
  ...FIND_GIT_BASH,
  `if (-not $t3GitBash) { [Console]::Error.WriteLine(${noGitBash("bash")}); exit 127 }`,
  "try {",
  `  $t3Start = [Diagnostics.ProcessStartInfo]::new([IO.Path]::Combine($t3GitBash, 'bash.exe'), ${escapePowerShellStringLiteral(`"${scriptPath.replaceAll("\\", "/")}"`)})`,
  "  $t3Start.UseShellExecute = $false",
  "  $t3Bash = [Diagnostics.Process]::Start($t3Start)",
  '} catch { [Console]::Error.WriteLine("CodeShip could not start Git Bash: $_"); exit 1 }',
  "$t3Bash.WaitForExit()",
  "exit $t3Bash.ExitCode",
];

// Matches line-bounded OSC and DCS/SOS/PM/APC, 7/8-bit CSI, and ECMA-48 ESC sequences.
// `\x9b`/`\x9c` match UTF-8-encoded C1 sequences (C2 9B / C2 9C) after TextDecoder.
const ANSI_ESCAPE_PATTERN =
  /\x1b\][^\x07\x1b\x9c\n]*(?:\x07|\x1b\\|\x9c)|\x1b[PX^_][^\x1b\x9c\n]*(?:\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-Z\\^-~]/g;

const isCleanExit = (row: Pick<CommandRunRow, "status" | "exit_code">) =>
  row.status === "exited" && row.exit_code === 0;

/** Removes ANSI escape codes and keeps the final in-place carriage-return segment per line. */
export const stripAnsi = (text: string): string => {
  const cleaned = text.replaceAll("\r\n", "\n").replace(ANSI_ESCAPE_PATTERN, "");
  if (!cleaned.includes("\r")) return cleaned;
  return cleaned
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const trimmed = line.replace(/\r+$/, "");
      const cr = trimmed.lastIndexOf("\r");
      return cr < 0 ? trimmed : trimmed.slice(cr + 1);
    })
    .join("\n");
};

const sliceStartFromEnd = (text: string, limit: number): number => {
  let start = text.length - limit;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return start;
};

/** Decodes a log tail cleanly across UTF-8, UTF-16, and line boundaries, capped to `maxChars`. */
export const decodeTail = (
  bytes: Uint8Array,
  cut: boolean,
  maxChars: number = RESULT_FAILURE_TAIL_CHARS,
): string => {
  if (maxChars <= 0) return "";
  let offset = 0;
  if (cut) {
    // Skip continuation bytes from a multi-byte UTF-8 sequence split at the seek offset.
    while (offset < bytes.length && offset < 3 && (bytes[offset]! & 0xc0) === 0x80) {
      offset += 1;
    }
  }
  const decoded = new TextDecoder().decode(offset === 0 ? bytes : bytes.subarray(offset));
  const text = stripAnsi(decoded).trimEnd();
  if (text === "") return "";
  const start = text.length <= maxChars ? 0 : sliceStartFromEnd(text, maxChars);
  const tail = start === 0 ? text : text.slice(start);
  const startsMidLine = (start === 0 && cut) || (start > 0 && text.charCodeAt(start - 1) !== 10);
  if (!startsMidLine) return tail;
  const newline = tail.indexOf("\n");
  if (newline >= 0 && newline + 1 <= maxChars / 2) {
    const after = tail.slice(newline + 1);
    if (after !== "") return after;
  }
  if (maxChars <= 1) return tail;
  if (tail.length < maxChars) return `…${tail}`;
  return `…${text.slice(sliceStartFromEnd(text, maxChars - 1))}`;
};

const make = Effect.gen(function* () {
  const serviceScope = yield* Effect.scope;
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
  const windowsJobHost = yield* WindowsJobHost;
  const runtime = yield* HostProcess.ExecutablePath;
  const cliEntry = (yield* HostProcess.IsExecutable)
    ? ""
    : NodeURL.fileURLToPath(
        new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
      );
  const windows = platform === "win32";
  const hostEnv = yield* HostProcess.Environment;
  const watchInterval = yield* WatchInterval;
  const memoryAdmission = yield* MemoryAdmission.MemoryAdmission;
  const cpuAdmission = yield* CpuAdmission.CpuAdmission;
  const heldShortage = MemoryAdmission.holdShortage(
    memoryAdmission.shortage,
    Duration.toMillis(yield* ShortageRecheck),
  );
  const queuedShortage = Clock.clockWith((clock) =>
    heldShortage(Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n)),
  );

  const commandsDir = path.join(logsDir, "commands");
  const jobFor = (directory: string) => windowsJobName(path.basename(directory));
  const jobUnitPrefix = "windows-job:";
  const hostCommandEnv = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isServerOnlyEnvKey(entry[0]),
    ),
  );
  /** Commands whose end has not reached their task yet, by task id. */
  const watched = new Map<string, CommandRunRow>();
  const launching = new Set<string>();
  const checking = new Set<string>();
  const stopping = new Set<string>();
  const pendingStops = new Set<string>();
  const verified = new Map<string, { readonly key: string; readonly at: number }>();
  /** When an older Windows row found overdue before its identity check stops waiting for it. */
  const identityDue = new Map<string, number>();
  const checkFailures = new Map<string, string>();
  /** Cancels waiting for their command's report, which then says what the stop did. */
  const reportWaiters = new Map<
    string,
    Deferred.Deferred<OrchestratorMcpCommandCleanup | undefined>
  >();
  /** Why a cancelled command was cancelled, for its report; a restart before it loses only this. */
  const cancelReasons = new Map<string, string>();
  // Slow probes and stops have separate limits so an unavailable probe cannot starve a deadline.
  const identitySlots = yield* Semaphore.make(2);
  const stopSlots = yield* Semaphore.make(2);
  const identityKey = (row: CommandRunRow) =>
    `${row.pid}:${row.process_identity}:${row.windows_created_at}`;
  /** Commands waiting for memory or CPU to start, oldest first. Changed under the lock. */
  const queue: Array<CommandRunRow> = [];
  /** Every change to a watched command, so its process is stopped or delivered once. */
  const lock = yield* Semaphore.make(1);
  /** Serializes direct-log trims and tail reads per task; never acquires `lock`. */
  const logLocks = new Map<string, { readonly lock: Semaphore.Semaphore; refs: number }>();
  const withLogLock = <A, E, R>(taskId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = logLocks.get(taskId) ?? { lock: Semaphore.makeUnsafe(1), refs: 0 };
        entry.refs += 1;
        logLocks.set(taskId, entry);
        return entry;
      }),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.refs -= 1;
          if (entry.refs === 0) logLocks.delete(taskId);
        }),
    );
  /**
   * Held from a start's memory and CPU reading until its command is recorded as running or queued,
   * so none overtakes a command queued meanwhile and each reading counts the commands started
   * before it. Taken before the lock. Neither is held through the launch, so a slow launcher holds
   * back no other command and a cancel can close its gate while it runs.
   */
  const admission = yield* Semaphore.make(1);
  /**
   * Settles each time start() tries to adopt the commands an earlier server left, so run() and
   * cancel() never race it: they go on once a try succeeds and fail with a try that failed, which
   * start() repeats with a new one.
   */
  let adoption = yield* Deferred.make<void, OrchestratorMcpFailure>();
  const adopted = Effect.suspend(() => Deferred.await(adoption));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const startedAtOf = (pid: number) =>
    identitySlots.withPermits(1)(
      readProcessStartedAt(pid, windows ? WINDOWS_LAUNCH_TIMEOUT : undefined).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(WindowsJobHost, windowsJobHost),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
  /**
   * Linux reads the start in ticks since boot, which a step of the wall clock cannot move. A
   * `recorded` identity that holds a wall-clock start, as records from before boot identities do,
   * is read on that clock.
   */
  const identityOf = Effect.fn("CommandRunner.identityOf")(function* (
    pid: number,
    recorded: string | null = null,
  ) {
    if (platform === "linux" && identityTime(recorded) === undefined) {
      const read = yield* Effect.all([
        fs.readFileString(`/proc/${pid}/stat`),
        fs.readFileString("/proc/sys/kernel/random/boot_id"),
      ]).pipe(Effect.option);
      return Option.isSome(read) ? linuxIdentity(read.value[0], read.value[1]) : undefined;
    }
    const startedAt = yield* startedAtOf(pid);
    return startedAt === undefined ? undefined : timeIdentity(startedAt);
  });
  const windowsIdentityOf = (pid: number) =>
    identitySlots.withPermits(1)(
      readWindowsProcessIdentity(pid, WINDOWS_LAUNCH_TIMEOUT).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(WindowsJobHost, windowsJobHost),
      ),
    );
  const windowsNamingOf = (pid: number, text: string) =>
    identitySlots.withPermits(1)(
      readWindowsProcessNaming(pid, text, WINDOWS_LAUNCH_TIMEOUT).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(WindowsJobHost, windowsJobHost),
      ),
    );
  const logPathOf = (row: Pick<CommandRunRow, "directory">) => path.join(row.directory, LOG_FILE);
  const statusPathOf = (row: Pick<CommandRunRow, "directory">) =>
    path.join(row.directory, STATUS_FILE);
  const holderPathOf = (row: Pick<CommandRunRow, "directory">) =>
    path.join(row.directory, HOLDER_FILE);

  /** A file the wrapper wrote, with when it wrote it. */
  const readWrapperFile = (file: string) =>
    Effect.all([fs.readFileString(file), fs.stat(file)]).pipe(
      Effect.map(([text, info]) => {
        const raw = text.trim();
        const numeric = /^\d+\s+(\d+)$/.exec(raw)?.[1];
        const posix = /^\d+\nps:(.+)$/.exec(raw)?.[1];
        const windowsIdentity = parseWindowsProcessIdentity(/^\d+\s+ft:(\d+)$/.exec(raw)?.[1]);
        const identity =
          windowsIdentity !== undefined
            ? windowsCreationTimeMillis(windowsIdentity)
            : numeric === undefined
              ? Date.parse(`${posix ?? ""} UTC`)
              : Number(numeric);
        return {
          value: Number.parseInt(raw, 10),
          identity: Number.isFinite(identity) ? identity : undefined,
          windowsIdentity,
          processIdentity:
            /^\d+\s+(boot:[^\s:]+:\d+)$/.exec(raw)?.[1] ??
            (Number.isFinite(identity) ? timeIdentity(identity) : undefined),
          writtenAt: Option.getOrUndefined(info.mtime),
        };
      }),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );

  const publishedPid = (named: { readonly value: number } | undefined) =>
    named !== undefined && Number.isSafeInteger(named.value) && named.value > 0
      ? named.value
      : undefined;

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

  /** Whether its holder runs, which keeps the wrapper's pid from changing hands too. */
  const isHeld = (row: Pick<CommandRunRow, "task_id" | "directory">) =>
    windows
      ? Effect.succeed(false)
      : Effect.try(() => isFifoHolderHeld(holderPathOf(row))).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("command-runner.holder-check-failed", {
              taskId: row.task_id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

  /** Lets the group's number go once nothing will signal the group again. */
  const releaseHolder = (directory: string) =>
    windows
      ? Effect.void
      : Effect.try(() => releaseFifoHolder(path.join(directory, HOLDER_FILE))).pipe(
          Effect.ignore({ log: true }),
        );

  const rebootedWithoutHolder = Effect.fn("CommandRunner.rebootedWithoutHolder")(function* (
    row: Pick<CommandRunRow, "process_identity" | "windows_created_at" | "started_at">,
  ) {
    if (row.process_identity?.startsWith("boot:")) {
      const boot = yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(Effect.option);
      return Option.isSome(boot) && row.process_identity.split(":")[1] !== boot.value.trim();
    }
    // A full FILETIME names one process across reboots: comparing it proves reuse instead.
    if (row.windows_created_at !== null) return false;
    const now = yield* DateTime.now;
    return DateTime.toEpochMillis(now) - NodeOS.uptime() * 1_000 > Date.parse(row.started_at);
  });

  /**
   * Nothing a command started outlives a reboot, after which its pid can name anything. A holder
   * that still runs proves there was none, whatever step the wall clock took since; otherwise an
   * exact identity answers this without the wall clock.
   */
  const rebootedSince = Effect.fn("CommandRunner.rebootedSince")(function* (
    row: Pick<
      CommandRunRow,
      "task_id" | "directory" | "process_identity" | "windows_created_at" | "started_at"
    >,
  ) {
    if (yield* isHeld(row)) return false;
    return yield* rebootedWithoutHolder(row);
  });

  /** An older Windows row whose live process matched its recorded millisecond keeps its FILETIME. */
  const retainWindowsIdentity = Effect.fn("CommandRunner.retainWindowsIdentity")(
    (row: CommandRunRow, windowsCreatedAt: string) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = watched.get(row.task_id);
          if (
            current === undefined ||
            identityKey(current) !== identityKey(row) ||
            current.windows_created_at !== null
          )
            return;
          const next: CommandRunRow = {
            ...current,
            process_identity:
              current.process_identity ?? timeIdentity(windowsCreationTimeMillis(windowsCreatedAt)),
            windows_created_at: windowsCreatedAt,
          };
          watched.set(row.task_id, next);
          yield* writeRow(next);
        }),
      ),
  );

  const readIdentity = Effect.fn("CommandRunner.readIdentity")(function* (
    row: CommandRunRow,
  ): Effect.fn.Return<
    string | Loss | Unproven,
    import("effect/PlatformError").PlatformError | import("effect/sql/SqlError").SqlError
  > {
    const probe_error = row.probe_error;
    if (row.pid === null) return { lost_reason: row.lost_reason ?? "no-pid", probe_error };
    if (row.process_identity === ENDED_IDENTITY) return { lost_reason: "pid-reused", probe_error };
    const held = yield* isHeld(row);
    if (!held && (yield* rebootedWithoutHolder(row)))
      return { lost_reason: "rebooted", probe_error };
    const probe = probeProcess(row.pid);
    if (probe.state === "gone") return { lost_reason: "gone", probe_error: probe.code };
    if (probe.state === "unknown") return "unknown";
    if (held) {
      // No process can take the pid while the holder keeps its group, whatever a start read says.
      if (row.process_identity !== null) return row.process_identity;
      const named = yield* readWrapperFile(path.join(row.directory, PID_FILE));
      return (
        (named?.value === row.pid ? named.processIdentity : undefined) ??
        (yield* identityOf(row.pid)) ??
        "unknown"
      );
    }
    if (windows) {
      const observed = yield* windowsIdentityOf(row.pid);
      if (observed === undefined) return "unknown";
      const named =
        row.windows_created_at === null
          ? yield* readWrapperFile(path.join(row.directory, PID_FILE))
          : undefined;
      const expected =
        row.windows_created_at ?? (named?.value === row.pid ? named.windowsIdentity : undefined);
      const observedMillis = windowsCreationTimeMillis(observed);
      if (expected !== undefined)
        return observed === expected
          ? timeIdentity(observedMillis)
          : { lost_reason: "pid-reused", probe_error };
      const legacyMillis =
        identityTime(row.process_identity) ??
        (named?.value === row.pid ? named.identity : undefined);
      if (legacyMillis !== undefined) {
        if (observedMillis !== legacyMillis) return { lost_reason: "pid-reused", probe_error };
        // An older launcher read the wrapper's creation time by pid, which the wrapper can have
        // passed on by then. A job stop checks membership; otherwise only a process whose command
        // line runs this command's wrapper is it.
        if (!row.unit?.startsWith(jobUnitPrefix)) {
          const wrapper = yield* windowsNamingOf(row.pid, path.join(row.directory, WRAPPER_FILE));
          if (wrapper?.createdAt !== observed) return "unknown";
          if (!wrapper.named) return { lost_reason: "unproven", probe_error };
        }
        yield* retainWindowsIdentity(row, observed);
        return timeIdentity(observedMillis);
      }
      const window = identityWindow(row.process_identity);
      if (window !== undefined && (observedMillis < window.from || observedMillis > window.to))
        return { lost_reason: "pid-reused", probe_error };
      if (
        named?.writtenAt !== undefined &&
        (observedMillis < Date.parse(row.started_at) || observedMillis > named.writtenAt.getTime())
      )
        return { lost_reason: "pid-reused", probe_error };
      // A launch window or file time can prove a later process, never this one.
      return { lost_reason: "unproven", probe_error };
    }
    const named =
      row.process_identity === null
        ? yield* readWrapperFile(path.join(row.directory, PID_FILE))
        : undefined;
    const expected =
      row.process_identity ?? (named?.value === row.pid ? named.processIdentity : undefined);
    if (expected?.startsWith("boot:")) {
      const observed = yield* identityOf(row.pid);
      if (observed === undefined) return "unknown";
      return compareIdentity(expected, observed) === "same"
        ? observed
        : { lost_reason: "pid-reused", probe_error };
    }
    const startedAt = yield* startedAtOf(row.pid);
    if (startedAt === undefined) return "unknown";
    const observed = timeIdentity(startedAt);
    if (expected !== undefined) {
      const verdict = compareIdentity(expected, observed);
      return verdict === "other"
        ? { lost_reason: "pid-reused", probe_error }
        : verdict === "same" && identityTime(expected) !== undefined
          ? observed
          : "unknown";
    }
    const exit = yield* readExitStatus(row);
    const upper =
      exit?.endedAt === undefined ? named?.writtenAt?.getTime() : Date.parse(exit.endedAt);
    if (upper === undefined) return "unknown";
    const precision = 1_000;
    if (startedAt < Date.parse(row.started_at) - precision || startedAt > upper + precision)
      return { lost_reason: "pid-reused", probe_error };
    return observed;
  });

  const forbidsSignals = (
    row: Pick<CommandRunRow, "lost_reason">,
  ): row is { readonly lost_reason: "pid-reused" | "rebooted" } =>
    row.lost_reason === "pid-reused" || row.lost_reason === "rebooted";

  const isUnproven = (
    row: Pick<CommandRunRow, "lost_reason">,
  ): row is { readonly lost_reason: "unproven" } => row.lost_reason === "unproven";

  /**
   * Whether an overdue older Windows row still waits for its identity check, which decides whether
   * CodeShip may stop it and so what its timeout says. It waits one probe's time at most.
   */
  const awaitsIdentity = (row: CommandRunRow, now: number) => {
    if (
      !windows ||
      row.status !== "running" ||
      row.pid === null ||
      row.windows_created_at !== null ||
      row.lost_reason !== null
    )
      return false;
    const due = identityDue.get(row.task_id) ?? now + Duration.toMillis(WINDOWS_LAUNCH_TIMEOUT);
    identityDue.set(row.task_id, due);
    return now < due;
  };

  /** A verdict that rules out signals stays with its row, so no later check can signal it. */
  const retainOwnershipLoss = Effect.fn("CommandRunner.retainOwnershipLoss")(
    (row: CommandRunRow, loss: Loss | Unproven) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = watched.get(row.task_id);
          if (
            current === undefined ||
            identityKey(current) !== identityKey(row) ||
            // A real loss outranks an unproven one, which never replaces it.
            (isUnproven(loss) ? current.lost_reason !== null : forbidsSignals(current))
          )
            return;
          const next = { ...current, ...loss };
          // A failed database write must not let another in-flight check signal the replacement.
          watched.set(row.task_id, next);
          yield* writeRow(next);
        }),
      ),
  );

  const isSameProcess = Effect.fn("CommandRunner.isSameProcess")(function* (row: CommandRunRow) {
    return yield* readIdentity(row).pipe(
      Effect.tap((identity) =>
        typeof identity !== "string" && (forbidsSignals(identity) || isUnproven(identity))
          ? retainOwnershipLoss(row, identity)
          : Effect.void,
      ),
    );
  });

  /**
   * Whether the POSIX group's number is still the command's: while its holder or its verified
   * wrapper runs. Once neither does, an unrelated group can take the number, which `kill(-pid, 0)`
   * would count too.
   */
  const ownsGroup = Effect.fn("CommandRunner.ownsGroup")(function* (row: CommandRunRow) {
    if (forbidsSignals(row)) return "not-ours" as const;
    if (yield* isHeld(row)) return "owned" as const;
    const identity = yield* isSameProcess(row);
    if (identity === "unknown") return "unknown" as const;
    if (typeof identity !== "string") return "not-ours" as const;
    if (forbidsSignals(watched.get(row.task_id) ?? row)) return "not-ours" as const;
    return "owned" as const;
  });

  /**
   * SIGTERM to the whole group, then SIGKILL to what is left of it after the grace period, each
   * only while the group is still the command's.
   */
  const killGroup = Effect.fn("CommandRunner.killGroup")(function* (row: CommandRunRow) {
    const signal = (name: NodeJS.Signals | 0) =>
      Effect.try({
        try: () => {
          try {
            // oxlint-disable-next-line t3code/no-raw-process-group-signal -- ownsGroup just found its holder or wrapper keeping the number
            signalProcessGroup(row.pid!, name);
            return true;
          } catch (cause) {
            if (
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ESRCH"
            )
              return false;
            throw cause;
          }
        },
        catch: (cause) =>
          new CommandStopError({
            detail: `Could not signal command group ${row.pid} with ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
    const current = watched.get(row.task_id);
    if (current === undefined || identityKey(current) !== identityKey(row)) return false;
    const initial = yield* ownsGroup(current);
    if (initial === "unknown") return false;
    if (initial === "not-ours") {
      // Another program's group may have its number by now, so what the command left runs on.
      yield* Effect.logWarning("command-runner.group-not-ours", {
        taskId: row.task_id,
        pid: row.pid,
      });
      return true;
    }
    if (!(yield* signal("SIGTERM"))) return true;
    const poll = Effect.gen(function* () {
      const latest = watched.get(row.task_id);
      if (latest === undefined || identityKey(latest) !== identityKey(row)) return "retry" as const;
      const ownership = yield* ownsGroup(latest);
      if (ownership === "unknown") return "retry" as const;
      if (ownership === "not-ours") return "done" as const;
      return (yield* signal(0)) ? ("alive" as const) : ("done" as const);
    });
    const settled = yield* poll.pipe(
      Effect.repeat({
        while: (state) => state === "alive",
        schedule: Schedule.spaced(Duration.millis(200)),
      }),
      Effect.timeoutOption(KILL_GRACE),
    );
    if (Option.isSome(settled)) return settled.value === "done";
    const latest = watched.get(row.task_id);
    if (latest === undefined || identityKey(latest) !== identityKey(row)) return false;
    const ownership = yield* ownsGroup(latest);
    if (ownership === "unknown") return false;
    if (ownership === "not-ours") return true;
    if (!(yield* signal("SIGKILL"))) return true;
    const afterKill = yield* ownsGroup(latest);
    if (afterKill === "unknown") return false;
    if (afterKill === "not-ours") return true;
    return !(yield* signal(0));
  });

  /**
   * The full FILETIME that authorizes stopping a Windows row's root, which an older row has once
   * its live root matched its recorded millisecond. Otherwise whether its cleanup is over: a root
   * that is gone or unproven leaves nothing CodeShip may stop, and an unreadable one is retried.
   */
  const windowsStopIdentity = Effect.fn("CommandRunner.windowsStopIdentity")(function* (
    row: CommandRunRow,
  ) {
    const same = yield* isSameProcess(row);
    if (same === "unknown") return false;
    if (typeof same !== "string") return true;
    if (row.windows_created_at !== null) return row.windows_created_at;
    const retained = watched.get(row.task_id);
    return (retained?.pid === row.pid ? retained.windows_created_at : null) ?? false;
  });

  /**
   * Jobs retain Windows membership; a legacy record proves only its root's identity, so the host
   * stops the processes that root started through its pinned handle. What it could not stop comes
   * back as leftovers, which keep cleanup pending.
   */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    const hasScope = !windows && row.unit !== null;
    if (hasScope && (yield* agentScope.stopCommand(row.unit!))) return true;
    const verdict = watched.get(row.task_id) ?? row;
    if (forbidsSignals(verdict)) return !hasScope;
    if (isUnproven(verdict)) return true;
    if (windows && row.unit?.startsWith(jobUnitPrefix)) {
      if (row.pid === null) return false;
      // The host checks the job's recorded child against this identity before it stops anything.
      const createdAt = row.windows_created_at ?? (yield* windowsStopIdentity(row));
      if (typeof createdAt === "boolean") return createdAt;
      const host = yield* windowsJobHost;
      const stopped = yield* stopSlots
        .withPermits(1)(
          processRunner.run({
            command: host,
            args: ["stop", row.unit.slice(jobUnitPrefix.length), String(row.pid), createdAt],
            timeout: Duration.seconds(30),
            maxOutputBytes: 16_384,
          }),
        )
        .pipe(Effect.mapError((cause) => new CommandStopError({ detail: cause.message, cause })));
      if (stopped.code !== 0)
        return yield* new CommandStopError({
          detail: `Could not stop the command job (exit ${stopped.code}): ${stopped.stderr.trim()}`,
        });
      return true;
    }
    const pid = row.pid;
    if (pid !== null) {
      if (!windows) {
        if (!(yield* killGroup(row))) return false;
      } else {
        // A legacy row has no job. A stop that left processes starts from them: their parents,
        // the root among them, may have ended, and the host cannot trace an orphan.
        const held = stopLeftovers(row.stop_leftovers);
        let roots = held.flatMap((left) => [String(left.pid), left.created]);
        if (held.length === 0) {
          const createdAt = yield* windowsStopIdentity(row);
          if (typeof createdAt === "boolean") return createdAt;
          roots = [String(pid), createdAt];
        }
        const stopped = yield* stopSlots
          .withPermits(1)(
            processRunner.run({
              command: yield* windowsJobHost,
              args: ["stop-tree", ...roots],
              timeout: Duration.seconds(30),
              maxOutputBytes: STOP_TREE_OUTPUT_BYTES,
            }),
          )
          .pipe(Effect.mapError((cause) => new CommandStopError({ detail: cause.message, cause })));
        // A failed stop names what it had not confirmed ended, so a retry misses no orphan.
        const left = stopLeftovers(stopped.stdout);
        if (left.length > 0)
          return {
            leftovers: left
              .map((process) => `left ${process.pid} ${process.created} ${process.reason}`)
              .join("\n"),
          };
        if (stopped.code !== 0) {
          return yield* new CommandStopError({
            detail: `Could not stop the command's processes (exit ${stopped.code}): ${stopped.stderr.trim()}`,
          });
        }
      }
    }
    return !hasScope;
  });

  const writeRow = (row: CommandRunRow) =>
    sql`
      UPDATE command_runs
      SET pid = ${row.pid}, process_identity = ${row.process_identity}, unit = ${row.unit},
        status = ${row.status}, exit_code = ${row.exit_code}, ended_at = ${row.ended_at},
        delivered_at = ${row.delivered_at}, last_alive_at = ${row.last_alive_at},
        probe_error = ${row.probe_error}, lost_reason = ${row.lost_reason},
        lost_output = ${row.lost_output}, launch_error = ${row.launch_error}, reported_at = ${row.reported_at},
        windows_created_at = ${row.windows_created_at}, exit_status_error = ${row.exit_status_error},
        stop_leftovers = ${row.stop_leftovers}
      WHERE task_id = ${row.task_id}
    `;

  /** A command is watched until its end is delivered. */
  const remember = (row: CommandRunRow) => {
    if (row.delivered_at === null) watched.set(row.task_id, row);
    else {
      watched.delete(row.task_id);
      pendingStops.delete(row.task_id);
      verified.delete(row.task_id);
      identityDue.delete(row.task_id);
      checkFailures.delete(row.task_id);
      cancelReasons.delete(row.task_id);
    }
  };

  /** Records a watched command's new state. Its group is never signalled once its end is delivered. */
  const settle = Effect.fn("CommandRunner.settle")(function* (row: CommandRunRow) {
    yield* writeRow(row);
    remember(row);
    if (row.delivered_at !== null) yield* releaseHolder(row.directory);
  });

  const readTail = (row: CommandRunRow, maxChars: number = RESULT_FAILURE_TAIL_CHARS) =>
    withLogLock(
      row.task_id,
      Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(logPathOf(row), { flag: "r" });
          const size = Number((yield* file.stat).size);
          const start = Math.max(0, size - RESULT_TAIL_READ_BYTES);
          yield* file.seek(BigInt(start), "start");
          const bytes = yield* file.readAlloc(size - start);
          return Option.match(bytes, {
            onNone: () => "",
            onSome: (read) => decodeTail(read, start > 0, maxChars),
          });
        }),
      ),
    ).pipe(Effect.orElseSucceed(() => ""));

  const resultText = Effect.fn("CommandRunner.resultText")(function* (
    row: CommandRunRow,
    cleanup: Cleanup,
  ) {
    const elapsed = formatDuration(
      Date.parse(row.ended_at ?? row.started_at) - Date.parse(row.started_at),
    );
    const unproven = `CodeShip could not prove that process ${row.pid} was this command's, so it did not stop it; the command may still be running.`;
    const reason = row.status === "stopped" ? cancelReasons.get(row.task_id) : undefined;
    const ending =
      row.status === "unstarted"
        ? `Could not start the command: ${row.launch_error ?? "the server stopped before launch completed."}`
        : row.status === "timed_out"
          ? isUnproven(row)
            ? `Timed out after ${elapsed}. ${unproven}`
            : cleanup === "never-started"
              ? "Timed out before the command started."
              : cleanup === "pending"
                ? `Timed out after ${elapsed}; cleanup is still pending. CodeShip keeps trying to stop the command.`
                : `Timed out and was stopped after ${elapsed}.`
          : row.status === "stopped"
            ? isUnproven(row)
              ? `Cancelled after ${elapsed}. ${unproven}`
              : cleanup === "never-started"
                ? "Cancelled before the command started."
                : cleanup === "pending"
                  ? `Cancelled after ${elapsed}; cleanup is still pending. CodeShip keeps trying to stop the command.`
                  : `Cancelled and stopped after ${elapsed}.`
            : row.status === "lost"
              ? row.lost_reason === "no-pid"
                ? "The command's deadline passed, but its ownership could not be established. Monitoring ended without stopping any process; the command may still be running."
                : `Ended after at most ${elapsed} without an exit status: it was killed, or this machine restarted.`
              : row.exit_code === null
                ? `Ended after ${elapsed} with an unreadable exit status.`
                : `Exited with code ${row.exit_code} after ${elapsed}.`;
    const logPath = logPathOf(row);
    const maxChars = isCleanExit(row) ? RESULT_SUCCESS_TAIL_CHARS : RESULT_FAILURE_TAIL_CHARS;
    const output = yield* readTail(row, maxChars);
    const left = stopLeftovers(row.stop_leftovers);
    const named = left
      .slice(0, LEFTOVERS_SHOWN)
      .map((process) => `process ${process.pid} (${process.reason})`)
      .join("; ");
    return [
      ending,
      ...(row.exit_status_error === null
        ? []
        : [`Its exit status could not be read: ${row.exit_status_error}`]),
      ...(left.length === 0
        ? []
        : [
            `CodeShip could not stop ${left.length === 1 ? "a process" : `${left.length} processes`} the command started: ${named}${left.length > LEFTOVERS_SHOWN ? `; and ${left.length - LEFTOVERS_SHOWN} more` : ""}`,
          ]),
      ...(reason === undefined ? [] : [`Reason: ${reason}`]),
      output === "" ? "No output." : `Last output:\n${output}`,
      `Full output: ${logPath}`,
    ].join("\n");
  });

  /** What a report of this row tells a cancel it did; nothing when the command ended by itself. */
  const cancelOutcome = (
    row: CommandRunRow,
    cleanup: Cleanup,
  ): OrchestratorMcpCommandCleanup | undefined =>
    row.status !== "stopped" && row.status !== "timed_out"
      ? undefined
      : isUnproven(row)
        ? "unproven"
        : cleanup === "done"
          ? "stopped"
          : cleanup;

  /** Ends the wait of a cancel for this command's report with what the report says. */
  const reportedTo = Effect.fn("CommandRunner.reportedTo")(function* (
    row: CommandRunRow,
    cleanup: Cleanup,
  ) {
    const waiter = reportWaiters.get(row.task_id);
    if (waiter === undefined) return;
    reportWaiters.delete(row.task_id);
    yield* Deferred.succeed(waiter, cancelOutcome(row, cleanup));
  });

  /**
   * Hands a command's end to its task, which wakes the thread. True once nothing waits on it: the
   * task has this result, or one that landed first (a cancel or Stop), or its chat or it is gone.
   */
  const completeTask = Effect.fn("CommandRunner.completeTask")(function* (
    row: CommandRunRow,
    status: "completed" | "failed" | "interrupted" | "cancelled",
    result: string,
  ) {
    const attempt = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const parentThreadId = ThreadId.make(row.thread_id);
    const taskId = NodeId.make(row.task_id);
    return yield* threads
      .dispatch({
        type: "delegated_task.command.complete",
        commandId: CommandId.make(`command:command-task-complete:${row.task_id}:${attempt}`),
        parentThreadId,
        taskId,
        status,
        result,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          threads.getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] }).pipe(
            Effect.map(
              ({ thread, subagents }) =>
                thread.deletedAt !== null || subagents[0]?.result != null || subagents.length === 0,
            ),
            Effect.orElseSucceed(() => false),
            Effect.tap((settled) =>
              settled
                ? Effect.void
                : Effect.logWarning("command-runner.deliver-failed", { taskId, cause }),
            ),
          ),
        ),
      );
  });

  /**
   * Hands a command's end to its task, as completeTask does. A row whose cleanup is `retained`
   * stays watched; an unproven one has nothing to stop.
   */
  const deliver = Effect.fn("CommandRunner.deliver")(function* (
    row: CommandRunRow,
    cleanup: Cleanup = "done",
    retained = cleanup === "pending",
  ) {
    const cleanupPending = retained && !isUnproven(row);
    if (row.reported_at !== null) {
      yield* reportedTo(row, cleanup);
      if (!cleanupPending) yield* settle({ ...row, delivered_at: yield* nowIso });
      return;
    }
    const status = isCleanExit(row)
      ? "completed"
      : row.status === "stopped"
        ? "cancelled"
        : "failed";
    if (yield* completeTask(row, status, yield* resultText(row, cleanup))) {
      const now = yield* nowIso;
      yield* settle({ ...row, reported_at: now, delivered_at: cleanupPending ? null : now });
      yield* reportedTo(row, cleanup);
    }
  });

  // Pre-upgrade POSIX wrappers and Windows redirect directly to this inode. The new writer
  // rotates before the limit, so its log never enters this compatibility path.
  const trimDirectLog = Effect.fn("CommandRunner.trimLog")(function* (row: CommandRunRow) {
    yield* withLogLock(
      row.task_id,
      Effect.gen(function* () {
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
              if (readAt >= end && writeAt < LOG_TRIM_AT_BYTES)
                end = Number((yield* file.stat).size);
            }
            yield* file.truncate(writeAt);
          }),
        );
      }),
    ).pipe(Effect.ignore({ log: true }));
  });

  /** Set while the losses log may not show the waves the database holds. */
  let logStale = true;
  /** Set once a write of the log fails and until one succeeds, so the failure is logged once. */
  let saveFailing = false;
  const lossLogPath = path.join(logsDir, LOSS_LOG_FILE);

  /** Writes the losses log from the waves in the database, whole, so no line is torn. */
  const writeLossLog = Effect.gen(function* () {
    const rows = yield* sql<
      LossEvidenceRow & {
        readonly wave_id: string;
        readonly wave_started_at: string;
        readonly wave_running: number;
      }
    >`
      SELECT w.wave_id, w.started_at AS wave_started_at, w.running AS wave_running, r.task_id,
        r.thread_id, r.pid, r.lost_reason, r.probe_error, r.started_at, r.last_alive_at,
        r.ended_at
      FROM command_loss_waves w JOIN command_runs r ON r.loss_wave_id = w.wave_id
      ORDER BY w.started_at, w.wave_id, r.ended_at, r.task_id
    `;
    const waves = new Map<
      string,
      {
        readonly time: string;
        readonly running: number;
        readonly runs: Array<ReturnType<typeof lossEvidence>>;
      }
    >();
    for (const row of rows) {
      const wave = waves.get(row.wave_id) ?? {
        time: row.wave_started_at,
        running: row.wave_running,
        runs: [],
      };
      wave.runs.push(lossEvidence(row));
      waves.set(row.wave_id, wave);
    }
    if (waves.size === 0) return yield* fs.remove(lossLogPath, { force: true });
    const lines = yield* Effect.forEach(waves, ([id, wave]) =>
      encodeLossWave({ id, ...wave, lost: wave.runs.length }),
    );
    const temp = `${lossLogPath}.tmp`;
    yield* fs.makeDirectory(logsDir, { recursive: true });
    yield* fs.writeFileString(temp, `${lines.join("\n")}\n`);
    yield* fs.rename(temp, lossLogPath);
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
    const endedAt = yield* nowIso;
    const lost: CommandRunRow = {
      ...row,
      ...loss,
      status: "lost",
      ended_at: endedAt,
      lost_output: output === "" ? null : output,
    };
    // With the loss, so a server that stops before it is placed leaves it for the next one.
    yield* sql.withTransaction(
      writeRow(lost).pipe(
        Effect.andThen(
          sql`UPDATE command_runs SET loss_unplaced = 1 WHERE task_id = ${row.task_id}`,
        ),
      ),
    );
    remember(lost);
    return lost;
  });

  const isoAt = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

  /**
   * Places the losses no wave holds yet (placeLosses) from the database alone, each against the
   * commands that ran when it was lost, so a restart neither misses a wave nor starts one twice.
   * Warns once for each wave that starts.
   */
  const placeWaves = Effect.fn("CommandRunner.placeWaves")(function* (
    unplaced: ReadonlyArray<{ readonly task_id: string; readonly ended_at: string }>,
  ) {
    const window = Duration.toMillis(WAVE_WINDOW);
    const losses = unplaced.map((row) => ({ taskId: row.task_id, at: Date.parse(row.ended_at) }));
    const times = losses.map((loss) => loss.at);
    const [lastWave] = yield* sql<{ readonly wave_id: string; readonly latest: string }>`
      SELECT loss_wave_id AS wave_id, MAX(ended_at) AS latest FROM command_runs
      WHERE loss_wave_id IS NOT NULL
      GROUP BY loss_wave_id ORDER BY latest DESC LIMIT 1
    `;
    const spans = (yield* sql<{ readonly started_at: string; readonly ended_at: string | null }>`
      SELECT started_at, ended_at FROM command_runs
      WHERE status <> 'queued' AND started_at <= ${isoAt(Math.max(...times))}
        AND (ended_at IS NULL OR ended_at > ${isoAt(Math.min(...times) - window)})
    `).map((row) => ({
      start: Date.parse(row.started_at),
      end: row.ended_at === null ? Number.POSITIVE_INFINITY : Date.parse(row.ended_at),
    }));
    const runningBetween = (from: number, to: number) =>
      spans.filter((span) => span.start <= to && span.end > from).length;
    const commandsAt = (at: number) => runningBetween(at - window, at);
    const { joining, waves, waiting } = placeLosses(
      lastWave === undefined ? undefined : Date.parse(lastWave.latest),
      losses,
      commandsAt,
    );
    const started = yield* Effect.forEach(waves, (wave) =>
      crypto.randomUUIDv4().pipe(
        Effect.orDie,
        Effect.map((id) => ({ ...wave, id, running: runningBetween(wave.at, wave.at) })),
      ),
    );
    const tooOld = DateTime.toEpochMillis(yield* DateTime.now) - window;
    const placed = [
      ...joining,
      ...waves.flatMap((wave) => wave.losses),
      ...waiting.filter((loss) => loss.at <= tooOld),
    ];
    if (placed.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (lastWave !== undefined && joining.length > 0) {
          yield* sql`
            UPDATE command_runs SET loss_wave_id = ${lastWave.wave_id}
            WHERE task_id IN ${sql.in(joining.map((loss) => loss.taskId))}
          `;
        }
        for (const wave of started) {
          yield* sql`
            INSERT INTO command_loss_waves (wave_id, started_at, running)
            VALUES (${wave.id}, ${isoAt(wave.at)}, ${wave.running})
          `;
          yield* sql`
            UPDATE command_runs SET loss_wave_id = ${wave.id}
            WHERE task_id IN ${sql.in(wave.losses.map((loss) => loss.taskId))}
          `;
        }
        yield* sql`
          UPDATE command_runs SET loss_unplaced = 0
          WHERE task_id IN ${sql.in(placed.map((loss) => loss.taskId))}
        `;
      }),
    );
    yield* Effect.forEach(started, (wave) =>
      Effect.logWarning("command-runner.loss-wave", {
        lost: wave.losses.length,
        commands: commandsAt(wave.at),
        running: wave.running,
        filePath: lossLogPath,
      }),
    );
    if (joining.length > 0 || started.length > 0) logStale = true;
  });

  /**
   * Places the losses no wave holds yet and brings the losses log up to date; a write that fails
   * is tried again at the next pass.
   */
  const noteWave = Effect.fn("CommandRunner.noteWave")(function* () {
    const unplaced = yield* sql<{ readonly task_id: string; readonly ended_at: string }>`
      SELECT task_id, ended_at FROM command_runs WHERE loss_unplaced = 1
    `;
    if (unplaced.length > 0) yield* placeWaves(unplaced);
    if (!logStale) return;
    yield* writeLossLog.pipe(
      Effect.andThen(
        Effect.sync(() => {
          logStale = false;
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

  const closeLaunchGate = Effect.fn("CommandRunner.closeLaunchGate")(function* (
    row: CommandRunRow,
  ) {
    const closed = yield* fs
      .rename(path.join(row.directory, LAUNCH_PENDING), path.join(row.directory, LAUNCH_CANCELLED))
      .pipe(
        Effect.as(true),
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
      );
    if (closed || (yield* fs.exists(path.join(row.directory, LAUNCH_CANCELLED))))
      return "cancelled" as const;
    if (yield* fs.exists(path.join(row.directory, LAUNCH_STARTED))) return "started" as const;
    return "legacy" as const;
  });

  /**
   * Whether a launch may have left a process: one still launching, or one its record or pid file
   * names. A closed gate keeps that process from running the command, not from running: a wrapper
   * whose startup stalls stays alive with its job host until cleanup stops them.
   */
  const launcherMayRun = Effect.fn("CommandRunner.launcherMayRun")(function* (row: CommandRunRow) {
    // A Windows record names its job before it launches; a POSIX one names its scope as it starts.
    if (launching.has(row.task_id) || row.pid !== null || (!windows && row.unit !== null))
      return true;
    const named = yield* readWrapperFile(path.join(row.directory, PID_FILE)).pipe(Effect.result);
    if (named._tag === "Success") return publishedPid(named.success) !== undefined;
    // One it cannot read may name a process; its cleanup reads it again on the next check.
    yield* Effect.logWarning("command-runner.pid-file-unreadable", {
      taskId: row.task_id,
      cause: named.failure,
    });
    return true;
  });

  /**
   * A launch from before launch gates whose deadline passed with no pid, pid file or exit status
   * never published a process: its launcher gave up long before any deadline, on every platform.
   */
  const retireUnownedLegacy = Effect.fn("CommandRunner.retireUnownedLegacy")(function* (
    row: CommandRunRow,
    gate: "legacy" | "started" | "cancelled",
  ) {
    if (
      gate !== "legacy" ||
      row.pid !== null ||
      row.unit !== null ||
      forbidsSignals(row) ||
      Date.parse(row.deadline_at) > DateTime.toEpochMillis(yield* DateTime.now) ||
      (yield* readWrapperFile(path.join(row.directory, PID_FILE))) !== undefined
    )
      return false;
    // An exit status that cannot be read may still exist; the check that follows reports why.
    const exit = yield* readExitStatus(row).pipe(Effect.result);
    if (exit._tag === "Failure" || exit.success !== undefined) return false;
    const lost = yield* recordLoss(row, { lost_reason: "no-pid", probe_error: null });
    yield* deliver(lost);
    return true;
  });

  /**
   * Results precede cleanup, except for a cancel waiting to report how its stop went; unowned
   * legacy launches explicitly retire without claiming a stop. A launch its gate kept from running
   * reports that it never started, and its cleanup then stops whatever its launcher left.
   */
  const prepareCleanup = Effect.fn("CommandRunner.prepareCleanup")(function* (row: CommandRunRow) {
    if (watched.get(row.task_id) !== row) return undefined;
    const gate = yield* closeLaunchGate(row).pipe(Effect.result);
    if (gate._tag === "Success" && (yield* retireUnownedLegacy(row, gate.success)))
      return undefined;
    if (gate._tag === "Success" && gate.success === "cancelled") {
      yield* deliver(row, "never-started", yield* launcherMayRun(row));
      const current = watched.get(row.task_id);
      // A launch still in flight records what it published, then checks its row again.
      return current === undefined || launching.has(row.task_id)
        ? undefined
        : { row: current, cleanup: "never-started" as const };
    }
    if (
      (row.status === "stopped" || row.status === "timed_out") &&
      row.reported_at === null &&
      (gate._tag === "Failure" || !reportWaiters.has(row.task_id))
    )
      yield* deliver(row, "pending");
    if (gate._tag === "Failure") return yield* gate.failure;
    const current = watched.get(row.task_id);
    return current === undefined ? undefined : { row: current, cleanup: "done" as const };
  });

  /** Slow evidence and process operations belong to one row, never to the shared lock. */
  const check = Effect.fn("CommandRunner.check")(function* (initial: CommandRunRow) {
    let claimedStopping = false;
    // When a running check settles its row as ended, hold `stopping` until cleanup finishes so
    // the next watch pass cannot start a second cleanup/trim concurrently for the same task.
    const claimStopping = (settled: CommandRunRow): CommandRunRow | undefined => {
      if (initial.status !== "running") return settled;
      if (stopping.has(settled.task_id)) return undefined;
      stopping.add(settled.task_id);
      claimedStopping = true;
      return settled;
    };
    yield* Effect.gen(function* () {
      let snapshot = initial;
      if (snapshot.status !== "running") {
        const prepared = yield* lock.withPermits(1)(prepareCleanup(snapshot));
        if (prepared === undefined) return;
        snapshot = prepared.row;
      }
      let row = snapshot;
      let loss: Loss | undefined = forbidsSignals(row)
        ? { lost_reason: row.lost_reason, probe_error: row.probe_error }
        : undefined;
      if (
        (row.pid === null || (windows && row.windows_created_at === null)) &&
        !forbidsSignals(row) &&
        !isUnproven(row) &&
        (row.status !== "exited" || (windows && row.unit?.startsWith(jobUnitPrefix))) &&
        (row.status !== "unstarted" || row.reported_at !== null)
      ) {
        const resolution = yield* recoverPid(row);
        if (resolution.outcome === "unresolved") {
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (watched.get(row.task_id) !== snapshot) return;
              if (row.status !== "running") yield* deliver(row, "pending");
            }),
          );
        }
        // A launch its gate kept from running goes on to cleanup, which stops what it published.
        row =
          resolution.outcome === "cancelled"
            ? {
                ...resolution.row,
                status: row.status === "running" ? "unstarted" : row.status,
                ended_at: row.ended_at ?? (yield* nowIso),
              }
            : resolution.row;
        if (resolution.outcome === "ended") {
          loss = resolution.loss;
          row = { ...row, ...loss };
        }
      }
      const exit = row.status === "running" ? yield* readExitStatus(row) : undefined;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const overdue = Date.parse(row.deadline_at) <= now;
      if (
        row.status === "running" &&
        exit === undefined &&
        loss === undefined &&
        (!overdue || awaitsIdentity(row, now))
      ) {
        const probe = row.pid === null ? undefined : probeProcess(row.pid);
        const cached = verified.get(row.task_id);
        // An unproven row stays unproven until its process ends or its pid names a later one.
        const mustVerify =
          cached?.key !== identityKey(row) ||
          now - cached.at >= 60_000 ||
          (!isUnproven(row) &&
            (row.process_identity === null || (windows && row.windows_created_at === null))) ||
          probe?.state !== "alive" ||
          (yield* rebootedSince(row));
        const identity = mustVerify ? yield* isSameProcess(row) : row.process_identity;
        if (watched.get(row.task_id) !== snapshot) return;
        if (identity === "unknown") {
          const code = probe?.state === "unknown" ? probe.code : "identity-unavailable";
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (watched.get(row.task_id) !== snapshot || snapshot.probe_error === code) return;
              yield* Effect.logWarning("command-runner.probe-failed", {
                taskId: row.task_id,
                pid: row.pid,
                code,
              });
              yield* settle({ ...snapshot, probe_error: code });
            }),
          );
          return;
        }
        if (identity === null || typeof identity === "string" || isUnproven(identity)) {
          if (typeof identity === "string" && row.process_identity === null)
            row = { ...row, process_identity: identity };
          if (mustVerify) verified.set(row.task_id, { key: identityKey(row), at: now });
        } else loss = identity;
      }
      const ended = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (watched.get(row.task_id) !== snapshot) return undefined;
          if (row.status !== "running") {
            if (row !== snapshot) yield* settle(row);
            return claimStopping(row);
          }
          if (exit !== undefined) {
            const ended: CommandRunRow = {
              ...row,
              status: "exited",
              exit_code: exit.code,
              ended_at: exit.endedAt ?? (yield* nowIso),
            };
            yield* settle(ended);
            return claimStopping(ended);
          }
          if (overdue && !awaitsIdentity(row, now)) {
            const ended: CommandRunRow = { ...row, status: "timed_out", ended_at: yield* nowIso };
            yield* settle(ended);
            return claimStopping(ended);
          }
          if (loss !== undefined) {
            // The wrapper may publish its status between the first read and its process exiting.
            const late = yield* readExitStatus(row);
            if (late !== undefined) {
              const ended: CommandRunRow = {
                ...row,
                status: "exited",
                exit_code: late.code,
                ended_at: late.endedAt ?? (yield* nowIso),
              };
              yield* settle(ended);
              return claimStopping(ended);
            }
            return claimStopping(yield* recordLoss(row, loss));
          }
          const seen = { ...row, last_alive_at: yield* nowIso, probe_error: null };
          const minuteOf = (at: string | null) =>
            at === null ? -1 : Math.floor(Date.parse(at) / 60_000);
          if (
            row.pid !== snapshot.pid ||
            row.process_identity !== snapshot.process_identity ||
            row.windows_created_at !== snapshot.windows_created_at ||
            minuteOf(row.last_alive_at) !== minuteOf(seen.last_alive_at)
          ) {
            yield* settle(seen);
          } else watched.set(row.task_id, seen);
          return undefined;
        }),
      );
      if (ended === undefined) return;
      const prepared = yield* lock.withPermits(1)(prepareCleanup(ended));
      if (prepared === undefined) return;
      const { row: next, cleanup } = prepared;
      if (
        cleanup === "never-started" ||
        next.status === "stopped" ||
        next.status === "timed_out" ||
        next.status === "lost" ||
        (next.status === "unstarted" && next.pid !== null) ||
        (windows && next.status === "exited" && next.unit?.startsWith(jobUnitPrefix))
      ) {
        const killed = yield* killTree(next).pipe(Effect.result);
        if (killed._tag === "Failure" || killed.success !== true) {
          const leftovers =
            killed._tag === "Success" && typeof killed.success === "object"
              ? killed.success.leftovers
              : next.stop_leftovers;
          // Reported now, so a cancel waiting for this stop learns it failed without its timeout.
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (watched.get(next.task_id) !== next) return;
              const held =
                leftovers === next.stop_leftovers ? next : { ...next, stop_leftovers: leftovers };
              if (held !== next) {
                yield* Effect.logWarning("command-runner.stop-left-processes", {
                  taskId: next.task_id,
                  leftovers,
                });
                yield* settle(held);
              }
              yield* deliver(held, cleanup === "done" ? "pending" : cleanup, true);
            }),
          );
          if (killed._tag === "Failure") return yield* killed.failure;
          return;
        }
      }
      yield* trimDirectLog(next);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (watched.get(next.task_id) !== next) return;
          yield* deliver(
            next.stop_leftovers === null ? next : { ...next, stop_leftovers: null },
            cleanup,
          );
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (claimedStopping) stopping.delete(initial.task_id);
        }),
      ),
    );
  });

  const checkTask = Effect.fn("CommandRunner.checkTask")(function* (taskId: string) {
    const row = watched.get(taskId);
    if (row === undefined) return;
    const active = row.status === "running";
    const inFlight = active ? checking : stopping;
    if ((active && launching.has(taskId)) || inFlight.has(taskId)) return;
    inFlight.add(taskId);
    yield* check(row).pipe(
      Effect.ensuring(
        windows || !active
          ? Effect.void
          : Effect.suspend(() =>
              watched.get(taskId)?.status === "running" ? trimDirectLog(row) : Effect.void,
            ),
      ),
      Effect.tap(() => Effect.sync(() => checkFailures.delete(taskId))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          const detail = `${watched.get(taskId)?.status}:${isCommandStopError(error) ? error.message : Cause.pretty(cause)}`;
          if (checkFailures.get(taskId) === detail) return;
          checkFailures.set(taskId, detail);
          yield* Effect.logWarning("command-runner.check-failed", { taskId, cause });
        }),
      ),
      Effect.ensuring(Effect.sync(() => inFlight.delete(taskId))),
    );
  });

  const watchOnce = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    for (const taskId of watched.keys()) {
      const row = watched.get(taskId)!;
      const stop = Effect.gen(function* () {
        if (
          row.status === "running" &&
          Date.parse(row.deadline_at) <= now &&
          !awaitsIdentity(row, now)
        )
          yield* requestStop(taskId, "timed_out");
        else if (
          pendingStops.has(taskId) &&
          (row.status === "stopped" || row.status === "timed_out")
        )
          yield* requestStop(taskId, row.status);
      });
      yield* stop.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("command-runner.stop-failed", { taskId, cause }),
        ),
      );
      yield* Effect.forkScoped(checkTask(taskId), { startImmediately: true });
    }
    yield* lock.withPermits(1)(noteWave());
  });

  /** Cancellation closes the gate before waiting for any launcher or identity probe. */
  const requestStopLocked = Effect.fn("CommandRunner.requestStopLocked")(function* (
    taskId: string,
    status: "stopped" | "timed_out",
  ) {
    const row = watched.get(taskId);
    if (row === undefined || (row.status !== "running" && row.status !== status)) return;
    if (row.status === status && !pendingStops.has(taskId)) return;
    // A command that published its exit already ended: a stop or deadline must not rewrite that.
    // One whose exit status cannot be read is stopped anyway, and its result says why.
    const exit =
      row.status === "running" ? yield* readExitStatus(row).pipe(Effect.result) : undefined;
    if (exit?._tag === "Success" && exit.success !== undefined) {
      const exited: CommandRunRow = {
        ...row,
        status: "exited",
        exit_code: exit.success.code,
        ended_at: exit.success.endedAt ?? (yield* nowIso),
      };
      yield* settle(exited);
      return;
    }
    const stopped: CommandRunRow = {
      ...row,
      status,
      ended_at: row.ended_at ?? (yield* nowIso),
      exit_status_error: exit?._tag === "Failure" ? exit.failure.message : row.exit_status_error,
    };
    // Keep the stop intent even if persistence or the gate is temporarily unavailable.
    watched.set(taskId, stopped);
    pendingStops.add(taskId);
    const gate = yield* closeLaunchGate(stopped).pipe(Effect.result);
    const saved = yield* writeRow(stopped).pipe(Effect.result);
    if (gate._tag === "Success" && (yield* retireUnownedLegacy(stopped, gate.success))) return;
    // A cancel waiting for the stop reports it once check() has tried it, unless it cannot start.
    if (gate._tag === "Success" && gate.success === "cancelled")
      yield* deliver(stopped, "never-started", yield* launcherMayRun(stopped));
    else if (gate._tag === "Failure" || !reportWaiters.has(taskId))
      yield* deliver(stopped, "pending");
    if (gate._tag === "Failure") return yield* gate.failure;
    if (saved._tag === "Failure") return yield* saved.failure;
    pendingStops.delete(taskId);
  });

  const requestStop = (taskId: string, status: "stopped" | "timed_out") =>
    lock.withPermits(1)(requestStopLocked(taskId, status));

  /** Takes a queued command off for good, with its record; false when none is queued. */
  const dequeue = Effect.fn("CommandRunner.dequeue")(function* (taskId: string) {
    const waiting = queue.findIndex((row) => row.task_id === taskId);
    if (waiting < 0) return false;
    queue.splice(waiting, 1);
    yield* sql`DELETE FROM command_runs WHERE task_id = ${taskId}`;
    return true;
  });

  /**
   * The task got its result elsewhere: a cancel, Stop, or the thread archived. A queued command has
   * nothing to stop, so its record goes.
   */
  const stopForTask = (taskId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (yield* dequeue(taskId)) return;
        yield* requestStopLocked(taskId, "stopped");
      }),
    );

  /**
   * A thread that is archived or deleted keeps nothing running. It looks under the lock, so a
   * command still starting is watched by then, and run() starts none for a closed thread after.
   * A queued command has nothing to stop: its task is told, again each pass until it records it.
   */
  const stopForThread = Effect.fn("CommandRunner.stopForThread")(function* (
    threadId: ThreadId,
    why: "archived" | "deleted",
  ) {
    const running = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const waiting = queue.filter((row) => row.thread_id === threadId);
        for (const row of waiting) queue.splice(queue.indexOf(row), 1);
        yield* Effect.forEach(waiting, (row) =>
          endUnstarted({ row, ...chatClosed(why) }).pipe(Effect.ignore({ log: true })),
        );
        return [...watched.values()].filter(
          (row) => row.thread_id === threadId && row.status === "running",
        );
      }),
    );
    yield* Effect.forEach(running, (row) =>
      threads
        .dispatch({
          type: "delegated_task.command.complete",
          commandId: CommandId.make(`command:command-task-${why}:${row.task_id}`),
          parentThreadId: threadId,
          taskId: NodeId.make(row.task_id),
          ...chatClosed(why),
        })
        .pipe(
          Effect.ignore,
          // A deleted thread records nothing, so its command is stopped here.
          Effect.andThen(stopForTask(row.task_id)),
        ),
    );
  });

  const cancel: CommandRunner["Service"]["cancel"] = Effect.fn("CommandRunner.cancel")(function* ({
    parentThreadId,
    taskId,
    reason,
  }) {
    yield* adopted;
    const fresh = yield* Deferred.make<OrchestratorMcpCommandCleanup | undefined>();
    const cannotCancel = (error: { readonly message: string }) =>
      failure("orchestration_error", `Unable to cancel command task ${taskId}: ${error.message}`);
    const waiter = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = watched.get(taskId);
        const queued = queue.find((waiting) => waiting.task_id === taskId);
        // Adoption and run() watch or queue every record until its delivery, so one neither
        // watched nor queued was delivered.
        const delivered =
          row === undefined && queued === undefined
            ? (yield* sql<{ readonly thread_id: string }>`
                SELECT thread_id FROM command_runs WHERE task_id = ${taskId}
              `.pipe(Effect.mapError(cannotCancel)))[0]
            : undefined;
        const owner = row?.thread_id ?? queued?.thread_id ?? delivered?.thread_id;
        if (owner !== undefined && owner !== parentThreadId)
          return yield* failure("task_not_found", `Task ${taskId} is not this thread's.`);
        if (owner === undefined || queued !== undefined) {
          // Not recorded yet, or queued with no process: run() and startQueued() read this result
          // under the lock before they start anything.
          yield* threads
            .dispatch({
              type: "delegated_task.command.complete",
              commandId: CommandId.make(`command:command-task-cancel:${taskId}`),
              parentThreadId,
              taskId,
              status: "cancelled",
              result: [
                "Cancelled before the command started; nothing was running.",
                ...(reason === undefined ? [] : [`Reason: ${reason}`]),
              ].join("\n"),
            })
            .pipe(Effect.mapError(cannotCancel));
          yield* dequeue(taskId).pipe(Effect.mapError(cannotCancel));
          return "never-started" as const;
        }
        // Its end is already the task's result.
        if (row === undefined || row.reported_at !== null) return undefined;
        if (reason !== undefined && row.status === "running") cancelReasons.set(taskId, reason);
        const shared = reportWaiters.get(taskId) ?? fresh;
        reportWaiters.set(taskId, shared);
        // A stop that fails here is kept as pending and retried by the watch, which reports it.
        yield* requestStopLocked(taskId, "stopped").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command-runner.cancel-stop-failed", { taskId, cause }),
          ),
        );
        return shared;
      }),
    );
    if (waiter === undefined || typeof waiter === "string") return waiter;
    /** A stop still going when the wait ends is reported as pending; the watch keeps at it. */
    const reportPending = lock.withPermits(1)(
      Effect.gen(function* () {
        // Already reported: the report ended the wait with what it says.
        if (reportWaiters.get(taskId) !== waiter) return;
        reportWaiters.delete(taskId);
        const row = watched.get(taskId);
        const stopping =
          row !== undefined &&
          row.reported_at === null &&
          (row.status === "stopped" || row.status === "timed_out");
        // First, so a cancel whose report of the pending stop fails still says it is pending.
        yield* Deferred.succeed(waiter, stopping ? cancelOutcome(row, "pending") : undefined);
        if (stopping) yield* deliver(row, "pending");
      }),
    );
    yield* Deferred.await(waiter).pipe(
      Effect.timeoutOption(CANCEL_REPORT_WAIT),
      Effect.ensuring(reportPending.pipe(Effect.ignoreCause({ log: true }))),
    );
    return yield* Deferred.await(waiter);
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
    { directory, task_id, command, shell, cwd }: CommandRunRow,
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
      const wrapper = {
        command: "/bin/sh",
        args: [
          "-c",
          POSIX_WRAPPER,
          "t3-command",
          logPath,
          statusPath,
          path.join(directory, PID_FILE),
          runtime,
          cliEntry,
          ...prefix,
          resolveCommandShell(platform, env, shell ?? undefined).path,
          "-c",
          command,
        ],
      };
      // Its holder keeps the group's number, across restarts too, until the end is delivered.
      const held =
        holdProcessGroup(
          { ...wrapper, cwd, env },
          { fd: 3, fifo: path.join(directory, HOLDER_FILE) },
        ) ?? wrapper;
      const scoped = yield* agentScope.wrap({
        ...held,
        name: "command",
        env,
        survivesRestart: true,
      });
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = watched.get(task_id);
          if (current?.status !== "running")
            return yield* new CommandLaunchError({
              detail: "Command launch was cancelled before it started.",
            });
          // The wrapper cannot execute before its restart-safe owner is durable.
          if (scoped.unit !== undefined) yield* settle({ ...current, unit: scoped.unit });
        }),
      );
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd, env);
      if (platform === "darwin" && pid > 0) {
        // The assertion follows the wrapper across server restarts and ends with it.
        yield* spawnDetached(...macKeepAwakeCommand(pid), cwd, hostCommandEnv).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("command-runner.sleep-assertion-failed", { pid, cause }),
          ),
        );
      }
      return {
        pid,
        process_identity: (yield* identityOf(pid)) ?? null,
        windows_created_at: null,
        unit: scoped.unit ?? null,
      };
    }
    // Win32_Process.Create parents the wrapper under WMI, outside this server's job and tree; its
    // environment comes from stdin so no value reaches disk. Create returns only the host's PID,
    // which an ended host can pass on before the launcher opens it, so the launcher waits on that
    // process only while it holds it and its command line is the host's, naming this job.
    const host = yield* windowsJobHost;
    const scriptPath = path.join(directory, "command.ps1");
    const wrapperPath = path.join(directory, WRAPPER_FILE);
    const bashScriptPath = path.join(directory, "command.sh");
    if (shell === "bash") yield* fs.writeFileString(bashScriptPath, command);
    yield* fs.writeFileString(
      scriptPath,
      [
        `${UTF8_BOM}$ErrorActionPreference = 'Continue'`,
        `$t3JobHost = ${escapePowerShellStringLiteral(host)}`,
        ...(shell === "bash"
          ? runInGitBash(bashScriptPath)
          : [
              ...FIND_GIT_BASH,
              ...GIT_BASH_ALIASES,
              command,
              "$t3Ok = $?",
              "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
              "if (-not $t3Ok) { exit 1 }",
              "exit 0",
            ]),
        "",
      ].join("\r\n"),
    );
    yield* fs.writeFileString(wrapperPath, windowsWrapper(cwd));
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
        `$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split([char]0); $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); $environment = [Collections.Generic.List[string]]::new(); for ($i = $entries.Length - 1; $i -ge 0; $i--) { if ($names.Add($entries[$i].Substring(0, [Math]::Max(0, $entries[$i].IndexOf('=', 1))))) { $environment.Insert(0, $entries[$i]) } }; $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $environment.ToArray(); CreateFlags = [uint32]${CREATE_UNICODE_ENVIRONMENT}; ShowWindow = [uint16]${SW_HIDE} }; $commandLine = ${escapePowerShellStringLiteral(`"${host}" run "${jobFor(directory)}" "${path.join(directory, PID_FILE)}" "`)} + $powershell + ${escapePowerShellStringLiteral(`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperPath}"`)}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = ${escapePowerShellStringLiteral(directory)}; ProcessStartupInformation = $startup }; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned $($r.ReturnValue)"); exit 1 }; $pidFile = ${escapePowerShellStringLiteral(path.join(directory, PID_FILE))}; $hostProcess = $null; try { $hostProcess = [Diagnostics.Process]::GetProcessById([int]$r.ProcessId) } catch [ArgumentException] {}; if ($null -ne $hostProcess) { try { $null = $hostProcess.Handle; if ((Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($hostProcess.Id)").CommandLine -cne $commandLine) { $hostProcess = $null } } catch { [Console]::Error.WriteLine("Could not watch the command host: $($_.Exception.Message)"); exit 1 } }; while (-not [IO.File]::Exists($pidFile)) { if (($null -eq $hostProcess -or $hostProcess.WaitForExit(50) -or [IO.File]::Exists(${escapePowerShellStringLiteral(statusPath)})) -and -not [IO.File]::Exists($pidFile)) { [Console]::Error.WriteLine('The command host ended before publishing its pid.'); exit 1 } }; Get-Content -LiteralPath $pidFile`,
      ],
      // Base64, since PowerShell decodes stdin with the console code page.
      stdin: Buffer.from(
        Object.entries(commandEnv)
          .map(([name, value]) => `${name}=${value}`)
          .join("\0"),
        "utf8",
      ).toString("base64"),
      timeout: WINDOWS_LAUNCH_TIMEOUT,
      maxOutputBytes: 16_384,
    });
    if (created.code !== 0) {
      return yield* new CommandLaunchError({
        detail: created.stderr.trim() || "Win32_Process.Create failed.",
      });
    }
    const evidence = yield* readWrapperFile(path.join(directory, PID_FILE));
    const pid = evidence?.value;
    const identity = evidence?.identity;
    const windowsIdentity = evidence?.windowsIdentity;
    if (
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      identity === undefined ||
      !Number.isSafeInteger(identity) ||
      identity <= 0 ||
      windowsIdentity === undefined
    ) {
      return yield* new CommandLaunchError({
        detail: "The wrapper did not record its process creation time.",
      });
    }
    return {
      pid,
      process_identity: timeIdentity(identity),
      windows_created_at: windowsIdentity,
      unit: `${jobUnitPrefix}${jobFor(directory)}`,
    };
  });

  /**
   * The whole environment the agent's own shell commands get, read for the thread's folder, where
   * its session read its settings, though the command's `cwd` may differ.
   */
  const commandEnvironment = Effect.fn("CommandRunner.commandEnvironment")(function* (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
    folder: string,
    modelSelection: ModelSelection,
  ) {
    const instance = yield* providerInstances.getInstance(providerInstanceId);
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
        : yield* instance.shellEnvironment(folder, hostCommandEnv, modelSelection).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("command-runner.shell-environment-failed", {
                parentThreadId: threadId,
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
    return overrideEnvironment(
      agentShellEnv,
      { [PortScanner.AGENT_THREAD_ENV]: threadId },
      platform,
    );
  });

  const runningCount = () => {
    let running = 0;
    for (const row of watched.values()) if (row.status === "running") running += 1;
    return running;
  };

  /**
   * The saturation that holds a command back: none while no command of this server runs, so a
   * machine loaded by other programs still runs its commands, one at a time, instead of starving
   * them.
   */
  const cpuHold = Effect.suspend(() =>
    runningCount() === 0 ? Effect.succeed(null) : cpuAdmission.saturation,
  );

  /** Why a new command waits to start, or undefined when it starts at once. */
  const waitingReason = Effect.gen(function* () {
    const shortage = yield* memoryAdmission.shortage;
    const limit = "Its time limit counts from when it starts.";
    if (shortage !== null) {
      return `Queued until this machine has memory for it: ${MemoryAdmission.describeMemoryShortage(shortage)}. ${limit}`;
    }
    const saturation = yield* cpuHold;
    if (saturation !== null) {
      return `Queued, waiting for CPU: ${CpuAdmission.describeCpuSaturation(saturation)}. ${limit}`;
    }
    // Commands queued before it start first.
    return queue.length === 0
      ? undefined
      : `Queued behind commands that wait for memory or CPU to start. ${limit}`;
  });

  const closedOf = (thread: {
    readonly deletedAt: object | null;
    readonly archivedAt: object | null;
  }) =>
    thread.deletedAt !== null ? "deleted" : thread.archivedAt !== null ? "archived" : undefined;

  /** The environment a queued command starts with, read as its request read it. */
  const queuedEnvironment = Effect.fn("CommandRunner.queuedEnvironment")(function* (
    row: CommandRunRow,
  ) {
    const threadId = ThreadId.make(row.thread_id);
    const records = yield* threads.getThreadRecords(threadId, ["runs"], {
      runIds: [RunId.make(row.run_id)],
    });
    const parentRun = records.runs[0];
    if (parentRun === undefined) {
      return yield* failure("parent_not_active", "The run that asked for the command is gone.");
    }
    const project = yield* projects.getById(records.thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    return yield* commandEnvironment(
      threadId,
      parentRun.providerInstanceId,
      records.thread.worktreePath ?? project?.workspaceRoot ?? row.cwd,
      parentRun.modelSelection,
    );
  });

  /** Queued commands that could not start, until their task records why. */
  const unstartedEnds = new Map<string, UnstartedEnd>();

  /**
   * Hands why a queued command could not start to its task, which wakes its agent, and forgets the
   * command once nothing waits on it. Until then each pass tries again.
   */
  const endUnstarted = Effect.fn("CommandRunner.endUnstarted")(function* (end: UnstartedEnd) {
    unstartedEnds.set(end.row.task_id, end);
    if (!(yield* completeTask(end.row, end.status, end.result))) return;
    unstartedEnds.delete(end.row.task_id);
    yield* sql`DELETE FROM command_runs WHERE task_id = ${end.row.task_id}`;
  });

  /** Takes the oldest queued command off for good, ending its task with `end` when given. */
  const dropQueued = Effect.fn("CommandRunner.dropQueued")(function* (
    row: CommandRunRow,
    end?: Omit<UnstartedEnd, "row">,
  ) {
    queue.shift();
    if (end !== undefined) return yield* endUnstarted({ row, ...end });
    yield* sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`;
  });

  const couldNotStart = (message: string) => ({
    status: "failed" as const,
    result: `Could not start the command: ${message}`,
  });

  const chatClosed = (why: "archived" | "deleted") => ({
    status: "interrupted" as const,
    result: `Stopped: the chat was ${why}.`,
  });

  /**
   * Why a queued command must not start, read now; undefined while it may. `end` is what its task
   * is told, none when the task already has its result.
   */
  const notToStart = Effect.fn("CommandRunner.notToStart")(function* (row: CommandRunRow) {
    const records = yield* threads
      .getThreadRecords(ThreadId.make(row.thread_id), ["subagents"], {
        subagentIds: [NodeId.make(row.task_id)],
      })
      .pipe(Effect.result);
    if (records._tag === "Failure") return { end: couldNotStart(records.failure.message) };
    const { thread, subagents } = records.success;
    // Its task got its result while it waited, or is gone: nothing is left to start.
    if (subagents[0] === undefined || subagents[0].result !== null) return {};
    const closed = closedOf(thread);
    if (closed === undefined) return undefined;
    return { end: chatClosed(closed) };
  });

  /**
   * Opens the launch gate of a command about to start. Recursive, so a folder that exists already
   * (a retried start, or a command an older server queued) takes it too.
   */
  const openLaunchGate = (directory: string) =>
    fs.makeDirectory(path.join(directory, LAUNCH_PENDING), { recursive: true });

  /**
   * Launches a command recorded and watched as running behind its open gate, outside the lock so
   * a cancel can close the gate meanwhile, then records what the launch gave. A launch that fails
   * or was stopped is checked at once, which reports it.
   */
  const launchWatched = Effect.fn("CommandRunner.launchWatched")(function* (
    row: CommandRunRow,
    commandEnv: Readonly<Record<string, string>>,
  ) {
    const taskId = row.task_id;
    const started = yield* Effect.gen(function* () {
      const launched = yield* launch(row, commandEnv).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return Effect.logWarning("command-runner.launch-failed", { taskId, cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new CommandLaunchError({
                  detail:
                    error instanceof Error ? error.message : "The launcher failed unexpectedly.",
                  cause,
                }),
              ),
            ),
          );
        }),
        Effect.result,
      );
      yield* lock
        .withPermits(1)(
          Effect.gen(function* () {
            const current = watched.get(taskId);
            // Only a delivered row is unwatched, and its end is final.
            if (current === undefined) return;
            const next: CommandRunRow =
              launched._tag === "Success"
                ? { ...current, ...launched.success, last_alive_at: yield* nowIso }
                : { ...current, launch_error: launched.failure.message };
            watched.set(taskId, next);
            if (launched._tag === "Success" && next.process_identity !== null)
              verified.set(taskId, {
                key: identityKey(next),
                at: DateTime.toEpochMillis(yield* DateTime.now),
              });
            yield* writeRow(next);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("command-runner.launch-reconcile-failed", { taskId, cause }),
          ),
        );
      return launched;
    }).pipe(Effect.ensuring(Effect.sync(() => launching.delete(taskId))));
    if (started._tag === "Failure" || watched.get(taskId)?.status === "stopped") {
      yield* Effect.forkIn(checkTask(taskId), serviceScope, { startImmediately: true });
    }
  });

  /**
   * Starts the oldest queued command once this machine has memory and CPU for it, one a pass, so
   * each start reads them after the one before it took its share. Its time limit counts from here.
   */
  const startQueued = Effect.fn("CommandRunner.startQueued")(function* () {
    yield* lock.withPermits(1)(Effect.forEach([...unstartedEnds.values()], endUnstarted));
    const next = queue[0];
    if (next === undefined || (yield* queuedShortage) !== null || (yield* cpuHold) !== null) return;
    // Outside the lock, which a slow read of the agent's environment would hold.
    const environment = yield* queuedEnvironment(next).pipe(Effect.result);
    const row = yield* admission.withPermits(1)(
      lock.withPermits(1)(
        Effect.gen(function* () {
          // A cancel, Stop or close took it off meanwhile; the next pass looks again.
          if (queue[0] !== next) return undefined;
          // The read took a while, and may have started a process of its own.
          if ((yield* queuedShortage) !== null || (yield* cpuHold) !== null) return undefined;
          const instead = yield* notToStart(next);
          if (instead !== undefined) return yield* dropQueued(next, instead.end);
          if (environment._tag === "Failure") {
            return yield* dropQueued(next, couldNotStart(environment.failure.message));
          }
          // Before its record says it runs: a server that stops between the two leaves the next
          // one a queued command, which it queues again.
          const gate = yield* openLaunchGate(next.directory).pipe(Effect.result);
          if (gate._tag === "Failure") {
            return yield* dropQueued(next, couldNotStart(gate.failure.message));
          }
          const now = yield* DateTime.now;
          const limitMs = Date.parse(next.deadline_at) - Date.parse(next.started_at);
          const row: CommandRunRow = {
            ...next,
            status: "running",
            unit: windows ? `${jobUnitPrefix}${jobFor(next.directory)}` : null,
            started_at: DateTime.formatIso(now),
            deadline_at: DateTime.formatIso(DateTime.add(now, { milliseconds: limitMs })),
          };
          // Before its task runs: a server that stops between the two leaves the next one a
          // command recorded as running behind its open gate, which it ends as it ends any other.
          yield* sql`
              UPDATE command_runs
              SET status = ${row.status}, unit = ${row.unit}, started_at = ${row.started_at},
                deadline_at = ${row.deadline_at}
              WHERE task_id = ${row.task_id}
            `;
          // Its task runs before its command does. The start is refused once its task has a
          // result or its chat is closed, so a cancel or a close that lands first keeps it
          // unstarted.
          const startedTask = yield* threads
            .dispatch({
              type: "delegated_task.command.start",
              commandId: CommandId.make(`command:command-task-start:${next.task_id}`),
              parentThreadId: ThreadId.make(next.thread_id),
              taskId: NodeId.make(next.task_id),
            })
            .pipe(Effect.result);
          if (startedTask._tag === "Failure") {
            const refused = yield* notToStart(next);
            return yield* dropQueued(
              next,
              refused === undefined ? couldNotStart(startedTask.failure.message) : refused.end,
            );
          }
          queue.shift();
          watched.set(row.task_id, row);
          launching.add(row.task_id);
          return row;
        }),
      ),
    );
    // Outside the admission permit, so a slow launcher holds back no other command's start. This
    // pass still waits for it, so the next queued start reads memory and CPU after this one.
    if (row !== undefined && environment._tag === "Success")
      yield* launchWatched(row, environment.success);
  });

  const run: CommandRunner["Service"]["run"] = flow(
    Effect.fn("CommandRunner.run")(function* (
      scope: ThreadScope,
      input: OrchestratorMcpRunCommandInput,
    ) {
      if (input.command.includes("\0"))
        return yield* failure("invalid_request", "A command cannot contain a NUL character.");
      yield* adopted;
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
      yield* admitWorkspaceProcess([base ?? cwd, cwd]);
      const isFolder = yield* fs.stat(cwd).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!isFolder) return yield* failure("invalid_request", `No folder at ${cwd}.`);
      // Before the environment read, which can start a process of the provider's own.
      const early = yield* waitingReason;
      const commandEnv =
        early === undefined
          ? yield* commandEnvironment(
              scope.thread.threadId,
              scope.thread.providerInstanceId,
              base ?? cwd,
              parentRun.modelSelection,
            )
          : undefined;
      const timeoutMinutes =
        input.timeoutMinutes ?? ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES;
      const commandId = CommandId.make(
        `command:mcp:${encodeURIComponent(scope.requestNamespace)}:command-run:${encodeURIComponent(input.clientRequestId)}`,
      );
      // Named by the request, so a retry with the same clientRequestId finds the same folder.
      const directory = path.join(
        commandsDir,
        NodeCrypto.createHash("sha256").update(commandId).digest("hex").slice(0, 32),
      );
      const logPath = path.join(directory, LOG_FILE);
      const result = (taskId: NodeId): OrchestratorMcpRunCommandResult => ({
        taskId,
        // A queued command reads its agent's environment as it starts; the host's names it till then.
        shell: resolveCommandShell(
          platform,
          windows ? {} : posixLaunchEnvironment(hostCommandEnv, commandEnv ?? {}).env,
          input.shell,
        ).name,
        logPath,
        timeoutMinutes,
        next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
      });
      // A request cancelled in here would leave a task, or a command, that nothing watches. The
      // admission permit keeps it from overtaking a command queued meanwhile, or starting as
      // memory runs short. The launch runs after both the permit and the lock, so a slow launcher
      // holds back no retry or other command, and a cancel can close its gate.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const admitted = yield* admission.withPermits(1)(
            Effect.gen(function* () {
              // One already waiting takes no second reading here.
              const waiting = early ?? (yield* waitingReason);
              // Set exactly when it starts now: one that waited before has no environment yet.
              const startEnv = waiting === undefined ? commandEnv : undefined;
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
                  ...(waiting === undefined ? {} : { waiting }),
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
              // A retried request recorded the task the first time. A concurrent retry may
              // have read parent.subagents before the first attempt recorded it, so re-read
              // once before failing.
              const prior =
                taskEvent === undefined
                  ? (parent.subagents.find((task) => task.command?.logPath === logPath) ??
                    (yield* threads
                      .getThreadRecords(scope.thread.threadId, ["subagents"])
                      .pipe(Effect.orElseSucceed(() => undefined)))?.subagents.find(
                      (task) => task.command?.logPath === logPath,
                    ))
                  : undefined;
              const taskId =
                taskEvent?.event.type === "subagent.updated"
                  ? taskEvent.event.payload.id
                  : prior?.id;
              if (taskId === undefined) {
                return yield* failure("orchestration_error", "The command was not recorded.");
              }
              /** Ends a task whose command never started, with nothing left to wake its thread for. */
              const unstarted = ({ status, result: message }: Omit<UnstartedEnd, "row">) =>
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
                        commandId: CommandId.make(
                          `command:command-task-unstarted-dispose:${taskId}`,
                        ),
                        parentThreadId: scope.thread.threadId,
                        taskId,
                      }),
                    ),
                    Effect.ignore({ log: true }),
                    Effect.andThen(Effect.fail(failure("orchestration_error", message))),
                  );
              const prepared = yield* lock
                .withPermits(1)(
                  Effect.gen(function* () {
                    const existing = yield* sql<{ readonly task_id: string }>`
                    SELECT task_id FROM command_runs WHERE task_id = ${taskId}
                  `;
                    if (existing.length > 0) return undefined;
                    // Read again here: stopForTask or stopForThread may already have looked for a
                    // task cancelled, or a thread closed, since the request began.
                    const records = yield* threads
                      .getThreadRecords(scope.thread.threadId, ["subagents"], {
                        subagentIds: [taskId],
                      })
                      .pipe(Effect.result);
                    if (records._tag === "Failure") {
                      return yield* unstarted(couldNotStart(records.failure.message));
                    }
                    const { thread, subagents } = records.success;
                    // Cancelled, or its first request could not start it: the task already says why.
                    const endedWith = subagents[0]?.result;
                    if (endedWith != null) return yield* failure("orchestration_error", endedWith);
                    const closed = closedOf(thread);
                    if (closed !== undefined) return yield* unstarted(chatClosed(closed));
                    const now = yield* DateTime.now;
                    const row: CommandRunRow = {
                      task_id: taskId,
                      thread_id: scope.thread.threadId,
                      run_id: parentRun.id,
                      label: input.label ?? null,
                      command: input.command,
                      shell: input.shell ?? null,
                      cwd,
                      directory,
                      pid: null,
                      process_identity: null,
                      windows_created_at: null,
                      // A queued command gets its job as it starts.
                      unit:
                        windows && startEnv !== undefined
                          ? `${jobUnitPrefix}${jobFor(directory)}`
                          : null,
                      status: startEnv === undefined ? "queued" : "running",
                      exit_code: null,
                      // While queued, when it was queued: its time limit is counted from its start.
                      started_at: DateTime.formatIso(now),
                      deadline_at: DateTime.formatIso(
                        DateTime.add(now, { minutes: timeoutMinutes }),
                      ),
                      ended_at: null,
                      delivered_at: null,
                      reported_at: null,
                      last_alive_at: null,
                      probe_error: null,
                      lost_reason: null,
                      lost_output: null,
                      launch_error: null,
                      exit_status_error: null,
                      stop_leftovers: null,
                    };
                    // Recorded before it starts, so a server that stops in between leaves the next
                    // one a record to adopt it by, never a command nothing watches. A queued command
                    // opens its launch gate only as it starts.
                    const recordedRow = yield* fs
                      .makeDirectory(directory, { recursive: true })
                      .pipe(
                        Effect.andThen(
                          startEnv === undefined ? Effect.void : openLaunchGate(directory),
                        ),
                        Effect.andThen(
                          sql`
                        INSERT INTO command_runs (
                          task_id, thread_id, run_id, label, command, shell, cwd, directory, pid,
                          process_identity, unit, status, exit_code, started_at, deadline_at,
                          ended_at, delivered_at
                        ) VALUES (
                          ${row.task_id}, ${row.thread_id}, ${row.run_id}, ${row.label},
                          ${row.command}, ${row.shell}, ${row.cwd}, ${row.directory}, ${row.pid},
                          ${row.process_identity}, ${row.unit}, ${row.status}, ${row.exit_code},
                          ${row.started_at}, ${row.deadline_at}, ${row.ended_at}, ${row.delivered_at}
                        )
                      `,
                        ),
                        Effect.result,
                      );
                    if (recordedRow._tag === "Failure") {
                      return yield* unstarted(couldNotStart(recordedRow.failure.message));
                    }
                    if (startEnv === undefined) {
                      queue.push(row);
                      return undefined;
                    }
                    watched.set(taskId, row);
                    launching.add(taskId);
                    return row;
                  }),
                )
                .pipe(
                  Effect.catchTags({
                    SqlError: (cause) =>
                      Effect.logWarning("command-runner.insert-failed", { taskId, cause }).pipe(
                        Effect.andThen(
                          Effect.fail(
                            failure("orchestration_error", "Unable to record the command."),
                          ),
                        ),
                      ),
                  }),
                );
              return { taskId, prepared, startEnv };
            }),
          );
          if (admitted.prepared !== undefined && admitted.startEnv !== undefined) {
            yield* launchWatched(admitted.prepared, admitted.startEnv);
          }
          return result(admitted.taskId);
        }),
      );
    }),
    Effect.scoped,
  );

  /** The gate proves non-execution; unreadable evidence proves nothing. */
  const recoverPid = Effect.fn("CommandRunner.recoverPid")(
    function* (
      row: CommandRunRow,
    ): Effect.fn.Return<LaunchResolution, import("effect/PlatformError").PlatformError> {
      const gate = yield* closeLaunchGate(row);
      const named = yield* readWrapperFile(path.join(row.directory, PID_FILE));
      const namedPid = publishedPid(named);
      // Its stop checks the identity the launcher published with the pid.
      if (gate === "cancelled")
        return {
          outcome: "cancelled",
          row:
            row.pid !== null || named === undefined || namedPid === undefined
              ? row
              : {
                  ...row,
                  pid: namedPid,
                  process_identity: named.processIdentity ?? null,
                  windows_created_at: windows ? (named.windowsIdentity ?? null) : null,
                },
        };
      const ended = (
        reason: LostReason,
        pid = row.pid,
        code = row.probe_error,
      ): LaunchResolution => ({
        outcome: "ended",
        row: { ...row, pid },
        loss: { lost_reason: reason, probe_error: code },
      });
      const published = named?.value === row.pid || row.pid === null ? named : undefined;
      if (
        yield* rebootedSince({
          ...row,
          process_identity: row.process_identity ?? published?.processIdentity ?? null,
          windows_created_at:
            row.windows_created_at ?? (windows ? published?.windowsIdentity : undefined) ?? null,
        })
      )
        return ended("rebooted", namedPid ?? row.pid);
      if (named === undefined || namedPid === undefined) {
        if (row.pid !== null) return { outcome: "started", row };
        if ((yield* readExitStatus(row)) !== undefined) return { outcome: "started", row };
        return { outcome: "unresolved" };
      }
      const pid = namedPid;
      let identity: string | null | undefined = named.processIdentity;
      if (identity === undefined) {
        if ((yield* readExitStatus(row)) !== undefined)
          return { outcome: "started", row: { ...row, pid, process_identity: null } };
        const writtenAt = named.writtenAt?.getTime();
        if (writtenAt === undefined) return { outcome: "unresolved" };
        const probe = probeProcess(pid);
        if (probe.state === "unknown") return { outcome: "unresolved" };
        if (probe.state === "alive") {
          if (!windows && (yield* isHeld(row))) {
            identity = (yield* identityOf(pid)) ?? null;
          } else {
            const startedAt = yield* startedAtOf(pid);
            if (startedAt === undefined) return { outcome: "unresolved" };
            const precision = windows ? 0 : 1_000;
            if (
              startedAt < Date.parse(row.started_at) - precision ||
              startedAt > writtenAt + precision
            )
              return ended("pid-reused", pid);
            // Its identity check then proves the process from the recorded millisecond or reports
            // that nothing it holds can.
            if (windows)
              return {
                outcome: "started",
                row: {
                  ...row,
                  pid,
                  process_identity: pid === row.pid ? row.process_identity : null,
                },
              };
            identity = platform === "linux" ? yield* identityOf(pid) : timeIdentity(startedAt);
            if (identity === undefined) return { outcome: "unresolved" };
          }
        } else return ended("gone", pid, probe.code);
      }
      return {
        outcome: "started",
        row: {
          ...row,
          pid,
          process_identity: identity,
          windows_created_at: windows ? (named.windowsIdentity ?? null) : null,
        },
      };
    },
    Effect.catch((cause) =>
      Effect.logWarning("command-runner.launch-recovery-failed", { cause }).pipe(
        Effect.as({ outcome: "unresolved" } as const),
      ),
    ),
  );

  /**
   * Register every undelivered row before trying evidence that can temporarily be unavailable. A
   * queued one waits again, unless its task got its result or its chat was closed meanwhile.
   */
  const adoptRow = Effect.fn("CommandRunner.adoptRow")(function* (
    row: CommandRunRow,
    task: ProjectionStore.ProjectionOpenCommandTask | undefined,
  ) {
    if (row.status === "queued") {
      if (task === undefined) {
        return yield* sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`;
      }
      if (task.threadClosed === null) {
        // A failed adoption is tried again, and must not queue it twice.
        if (!queue.some((waiting) => waiting.task_id === row.task_id)) queue.push(row);
        return;
      }
      return yield* endUnstarted({ row, ...chatClosed(task.threadClosed) });
    }
    watched.set(row.task_id, row);
    if (row.status !== "running" || (task !== undefined && task.threadClosed === null)) return;
    if (task?.threadClosed != null) {
      yield* threads
        .dispatch({
          type: "delegated_task.command.complete",
          commandId: CommandId.make(`command:command-task-${task.threadClosed}:${row.task_id}`),
          parentThreadId: task.parentThreadId,
          taskId: task.taskId,
          ...chatClosed(task.threadClosed),
        })
        .pipe(Effect.ignore({ log: true }));
    }
    yield* requestStopLocked(row.task_id, "stopped");
  });

  /**
   * Picks up what an earlier server left: commands to watch again, ends to deliver, stops to
   * finish, commands still waiting for memory, in the order they were queued, and tasks whose
   * command never got its record (the server stopped between the two), which are lost.
   */
  const adopt = Effect.gen(function* () {
    const open = yield* projections.getOpenCommandTasks;
    const openById = new Map<string, ProjectionStore.ProjectionOpenCommandTask>(
      open.map((task) => [task.taskId, task]),
    );
    const rows = yield* sql<CommandRunRow>`
      SELECT * FROM command_runs WHERE delivered_at IS NULL ORDER BY rowid
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
    // Read again: a task adoption just told is no longer open, though its record may be gone.
    yield* Effect.forEach(
      (yield* projections.getOpenCommandTasks).filter((task) => !known.has(task.taskId)),
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

  /**
   * Removes delivered commands, the waves left without one, and folders left without a record,
   * after RETENTION.
   */
  const prune = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, RETENTION));
    const old = yield* sql<{ readonly task_id: string; readonly directory: string }>`
      SELECT task_id, directory FROM command_runs
      WHERE delivered_at IS NOT NULL AND delivered_at < ${cutoff}
    `;
    yield* Effect.forEach(old, (row) =>
      releaseHolder(row.directory).pipe(
        Effect.andThen(fs.remove(row.directory, { recursive: true, force: true })),
        Effect.andThen(sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`),
        Effect.ignore({ log: true }),
      ),
    );
    if (old.length > 0) {
      // Under the lock, so a log write that read the removed records is followed by another.
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM command_loss_waves WHERE wave_id NOT IN (
              SELECT loss_wave_id FROM command_runs WHERE loss_wave_id IS NOT NULL
            )
          `;
          logStale = true;
        }),
      );
    }
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
            yield* releaseHolder(folder);
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
        // A failed try leaves an earlier server's commands unwatched, so it is tried again.
        const adoptionFailed = Effect.fn("CommandRunner.adoptionFailed")(function* (
          cause: Cause.Cause<unknown>,
        ) {
          const failed = adoption;
          adoption = yield* Deferred.make<void, OrchestratorMcpFailure>();
          yield* Deferred.fail(
            failed,
            failure(
              "orchestration_error",
              "CodeShip could not yet pick up the commands an earlier server left. Try again shortly.",
            ),
          );
          yield* Effect.logWarning("command-runner.adoption-failed", { cause });
          return false;
        });
        const tryAdopt = lock
          .withPermits(1)(adopt)
          .pipe(
            Effect.matchCauseEffect({
              onSuccess: () => Deferred.succeed(adoption, undefined).pipe(Effect.as(true)),
              onFailure: adoptionFailed,
            }),
          );
        yield* tryAdopt.pipe(
          Effect.repeat({ until: (adopted) => adopted, schedule: Schedule.spaced(watchInterval) }),
          // A runner that stops first leaves no call waiting.
          Effect.ensuring(
            Effect.suspend(() =>
              Deferred.fail(
                adoption,
                failure(
                  "orchestration_error",
                  "CodeShip stopped before it picked up its commands.",
                ),
              ),
            ),
          ),
        );
        const watchedOnce = watchOnce.pipe(Effect.ignoreCause({ log: true }));
        yield* watchedOnce;
        const pruned = prune.pipe(Effect.ignoreCause({ log: true }));
        yield* pruned;
        yield* Effect.forkScoped(pruned.pipe(Effect.delay(RETENTION_INTERVAL), Effect.forever));
        // Apart from the watch, whose deadlines a slow read of a queued command's environment
        // would hold back; one fiber, so queued commands start one at a time, in order.
        yield* Effect.forkScoped(
          startQueued().pipe(
            Effect.ignoreCause({ log: true }),
            Effect.repeat(Schedule.spaced(watchInterval)),
          ),
        );
        yield* watchedOnce.pipe(Effect.repeat(Schedule.spaced(watchInterval)));
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return CommandRunner.of({ run, start, cancel });
});

export const layer = Layer.effect(CommandRunner, make);
