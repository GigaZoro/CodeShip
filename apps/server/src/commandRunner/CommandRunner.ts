// @effect-diagnostics nodeBuiltinImport:off - A command outlives the server, so it starts detached and unreferenced, outside every Effect scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { flow } from "effect/Function";
import { admitWorkspaceProcess } from "../workspace/workspaceLease.ts";

import {
  CommandId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_COMMAND_DEFAULT_TIMEOUT_MINUTES,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpFailure,
  type OrchestratorMcpRunCommandInput,
  type OrchestratorMcpRunCommandResult,
  ProviderDriverKind,
  type ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { isProcessAlive, probeProcess } from "@t3tools/shared/processProbe";
import { overrideEnvironment } from "@t3tools/shared/shell";
import {
  WINDOWS_PROCESS_TREE_FUNCTIONS,
  windowsStopTreeArgs,
} from "@t3tools/shared/windowsProcessTree";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { readProcessStartedAt } from "../serverRuntimeState.ts";
import {
  compareIdentity,
  ENDED_IDENTITY,
  identityTime,
  identityWindow,
  launchIdentity,
  linuxIdentity,
  recordedIdentity,
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
const IDENTITY_FILE = "identity";
const LOG_TRIM_AT_BYTES = 8 * 1024 * 1024;
const LOG_KEEP_BYTES = 4 * 1024 * 1024;
const LOG_COPY_CHUNK_BYTES = 1024 * 1024;
const RESULT_TAIL_BYTES = 4 * 1024;
const KILL_GRACE = Duration.seconds(5);
/**
 * A start no process has, which a gone wrapper's stop passes as its root's, so a holder of the pid
 * is another process and bounds the wrapper's children by its start, not by a clock reading.
 */
const NO_ROOT = { from: 0, to: 0 };
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
  // cmd only appends the output of PowerShell and everything it starts to the log. Input is NUL,
  // as /dev/null elsewhere: a command that reads it ends instead of waiting on the hidden console.
  `  $start.Arguments = '/d /s /c ""' + (Join-Path $system 'WindowsPowerShell\\v1.0\\powershell.exe') + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'command.ps1') + '" < NUL >> "' + (Join-Path $PSScriptRoot '${LOG_FILE}') + '" 2>&1"'`,
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

/** PowerShell that prints when the process with id `pid` was made, or `ended` when none has it. */
export const windowsStartOrEnded = (pid: string) =>
  `$made = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($made) { $made.StartTime.ToUniversalTime().ToString('o') } else { '${ENDED_IDENTITY}' }`;

// Records its own identity, then names itself, then runs the command and outlives it to write its
// exit status; each rename makes its file appear whole. Arguments: log, status file, pid file,
// identity file, then the command's argv. Linux writes its stat line and the boot id, elsewhere
// ps's start; a file with no usable line gives a later server no ownership.
const POSIX_WRAPPER = [
  'if [ -r "/proc/$$/stat" ]; then',
  '  { read -r s <"/proc/$$/stat" && read -r b </proc/sys/kernel/random/boot_id && printf "%s\\n%s\\n" "$s" "$b"; } >"$4.tmp" && mv -f "$4.tmp" "$4"',
  "else",
  '  { LC_ALL=C TZ=UTC ps -p "$$" -o lstart=; } >"$4.tmp" 2>/dev/null && mv -f "$4.tmp" "$4"',
  "fi",
  'printf "%s\\n" "$$" >"$3.tmp" && mv -f "$3.tmp" "$3"',
  'exec >>"$1" 2>&1 </dev/null',
  'run() { shift 4; "$@"; }',
  'run "$@"',
  "code=$?",
  'printf "%s\\n" "$code" >"$2.tmp" && mv -f "$2.tmp" "$2"',
].join("\n");

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/**
 * `queued`: it waits for memory or CPU to start, with no process yet. `lost`: it vanished without an
 * exit status. `stopped`: its task got a result elsewhere (task_cancel, Stop, archive), so the
 * runner stopped it.
 */
type CommandRunStatus = "queued" | "running" | "exited" | "timed_out" | "lost" | "stopped";

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
  /** What tells the wrapper from a later process under its pid (`processIdentity.ts`). */
  readonly process_identity: string | null;
  readonly unit: string | null;
  readonly status: CommandRunStatus;
  readonly exit_code: number | null;
  /** When it started, so its time limit counts from there; while queued, when it was queued. */
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

/** Why a queued command could not start, for its task. */
interface UnstartedEnd {
  readonly row: CommandRunRow;
  readonly status: "failed" | "interrupted";
  readonly result: string;
}

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
  WINDOWS_PROCESS_TREE_FUNCTIONS,
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
  "      if ($run.WaitForExit(10000)) {",
  // <install>\<build>\libexec\git-core
  "        if ($run.ExitCode -eq 0 -and $out.Wait(1000) -and $out.Result.Trim()) { [IO.Path]::GetFullPath([IO.Path]::Combine($out.Result.Trim(), '..', '..', '..')) }",
  "      } else {",
  "        [Console]::Error.WriteLine(\"CodeShip stopped 'git --exec-path' ($($git.Path)), which did not answer within 10 s, and looks for Git Bash in the standard install folders.\")",
  // A shim such as git.cmd runs git in a child process, which stopping the shim alone leaves running.
  "        $made = Ms $run.StartTime",
  "        Stop-T3ProcessTree $run.Id $made $made $made",
  "      }",
  '    } catch { [Console]::Error.WriteLine("CodeShip could not ask git where Git Bash is: $_") }',
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
  const random = yield* SecureRandom.SecureRandom;
  const { logsDir } = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
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
  const hostCommandEnv = Object.fromEntries(
    Object.entries(hostEnv).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isServerOnlyEnvKey(entry[0]),
    ),
  );
  /** Commands whose end has not reached their task yet, by task id. */
  const watched = new Map<string, CommandRunRow>();
  /** Watched commands whose start read could not tell wrapper from pid reuse; each check asks again. */
  const unconfirmed = new Set<string>();
  /** Commands waiting for memory or CPU to start, oldest first. Changed under the lock. */
  const queue: Array<CommandRunRow> = [];
  /** Every change to a watched command, so its process is stopped or delivered once. */
  const lock = yield* Semaphore.make(1);
  /** Open once start() has adopted the commands an earlier server left, so run() never races it. */
  const adopted = yield* Deferred.make<void>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const startedAtOf = (pid: number) =>
    readProcessStartedAt(pid).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    );
  /** Linux reads the start in ticks since boot, which a step of the wall clock cannot move. */
  const identityOf = Effect.fn("CommandRunner.identityOf")(function* (pid: number) {
    if (platform === "linux") {
      const read = yield* Effect.all([
        fs.readFileString(`/proc/${pid}/stat`),
        fs.readFileString("/proc/sys/kernel/random/boot_id"),
      ]).pipe(Effect.option);
      return Option.isSome(read) ? linuxIdentity(read.value[0], read.value[1]) : undefined;
    }
    const startedAt = yield* startedAtOf(pid);
    return startedAt === undefined ? undefined : timeIdentity(startedAt);
  });
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

  /**
   * Why `pid` no longer names the process this command started; undefined while it does, and
   * "unconfirmed" while the start read could not tell.
   */
  const lossOf = Effect.fn("CommandRunner.lossOf")(function* (
    row: CommandRunRow,
  ): Effect.fn.Return<Loss | "unconfirmed" | undefined> {
    const probe_error = row.probe_error;
    if (row.pid === null) return { lost_reason: row.lost_reason ?? "no-pid", probe_error };
    if (yield* rebootedSince(row)) return { lost_reason: "rebooted", probe_error };
    const probe = probeProcess(row.pid);
    if (probe.state === "gone") return { lost_reason: "gone", probe_error: probe.code };
    if (row.process_identity === null) return undefined;
    if (row.process_identity === ENDED_IDENTITY) return { lost_reason: "pid-reused", probe_error };
    const verdict = compareIdentity(row.process_identity, yield* identityOf(row.pid));
    if (verdict === "unknown") return "unconfirmed";
    return verdict === "same" ? undefined : { lost_reason: "pid-reused", probe_error };
  });
  const isSameProcess = (row: CommandRunRow) =>
    // Unknown identity stays conservative for a stop: the wrapper's group is signalled.
    lossOf(row).pipe(Effect.map((loss) => loss === undefined || loss === "unconfirmed"));

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
   * from its wrapper's pid (`windowsStopTreeArgs`), also after the wrapper ended. A group outlives
   * its wrapper and its id is not reused while any member lives, so short of a reboot, only a live
   * process reusing the wrapper's pid means nothing of the group is left.
   */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    const pid = row.pid;
    if (pid !== null && !(yield* rebootedSince(row))) {
      if (!windows) {
        if (!isProcessAlive(pid) || (yield* isSameProcess(row))) yield* killGroup(pid);
      } else {
        const identity = row.process_identity;
        const pinned = identityTime(identity);
        const created = identity === ENDED_IDENTITY ? NO_ROOT : identityWindow(identity);
        // With a window or an ended record, take nothing made before the record or before the
        // wrapper named itself, just before it started the command, since the window may hold what
        // an earlier holder of its pid made; a clock set back spares the command's own processes.
        // Without a window, `since` also places the root, which was made before it named itself.
        const recorded = Date.parse(row.started_at);
        const named =
          pinned === undefined && created !== undefined
            ? yield* readWrapperFile(path.join(row.directory, PID_FILE))
            : undefined;
        const since = pinned ?? Math.max(recorded, named?.writtenAt?.getTime() ?? recorded);
        yield* processRunner
          .run({
            command: "powershell.exe",
            args: windowsStopTreeArgs({
              pid,
              since,
              created: created ?? "unknown",
              ended: row.ended_at === null ? "running" : Date.parse(row.ended_at),
            }),
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
      SET pid = ${row.pid}, process_identity = ${row.process_identity}, unit = ${row.unit},
        status = ${row.status}, exit_code = ${row.exit_code}, ended_at = ${row.ended_at},
        delivered_at = ${row.delivered_at}, last_alive_at = ${row.last_alive_at},
        probe_error = ${row.probe_error}, lost_reason = ${row.lost_reason},
        lost_output = ${row.lost_output}
      WHERE task_id = ${row.task_id}
    `;

  /** A command is watched until its end is delivered. */
  const remember = (row: CommandRunRow) => {
    if (row.delivered_at === null) watched.set(row.task_id, row);
    else {
      watched.delete(row.task_id);
      unconfirmed.delete(row.task_id);
    }
  };

  /** Records a watched command's new state. */
  const settle = Effect.fn("CommandRunner.settle")(function* (row: CommandRunRow) {
    yield* writeRow(row);
    remember(row);
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
   * Hands a command's end to its task, which wakes the thread. True once nothing waits on it: the
   * task has this result, or one that landed first (a cancel or Stop), or its chat or it is gone.
   */
  const completeTask = Effect.fn("CommandRunner.completeTask")(function* (
    row: CommandRunRow,
    status: "completed" | "failed" | "interrupted",
    result: string,
  ) {
    const attempt = yield* random.uuidV4();
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

  const deliver = Effect.fn("CommandRunner.deliver")(function* (row: CommandRunRow) {
    const status = row.status === "exited" && row.exit_code === 0 ? "completed" : "failed";
    if (yield* completeTask(row, status, yield* resultText(row))) {
      yield* settle({ ...row, delivered_at: yield* nowIso });
    }
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
    yield* killTree(row);
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
      random
        .uuidV4()
        .pipe(Effect.map((id) => ({ ...wave, id, running: runningBetween(wave.at, wave.at) }))),
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
      // A wrapper recorded as ended left its pid to whatever holds it now.
      if (unconfirmed.has(row.task_id) || row.process_identity === ENDED_IDENTITY) {
        const loss = yield* lossOf(row);
        if (loss === undefined) unconfirmed.delete(row.task_id);
        else if (loss !== "unconfirmed") return yield* lose(loss);
      }
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
   * to stop it. The kill runs outside the lock, which it would hold for its grace period. A queued
   * command has nothing to stop, so its record goes.
   */
  const stopForTask = (taskId: string) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const waiting = queue.findIndex((row) => row.task_id === taskId);
          if (waiting >= 0) {
            queue.splice(waiting, 1);
            yield* sql`DELETE FROM command_runs WHERE task_id = ${taskId}`;
            return undefined;
          }
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
    {
      directory,
      command,
      shell,
      cwd,
    }: Pick<CommandRunRow, "directory" | "command" | "shell" | "cwd">,
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
          path.join(directory, IDENTITY_FILE),
          ...prefix,
          resolveCommandShell(platform, env, shell ?? undefined).path,
          "-c",
          command,
        ],
        name: "command",
        env,
        survivesRestart: true,
      });
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd, env);
      return { pid, unit: scoped.unit ?? null, identity: undefined };
    }
    // Win32_Process.Create parents the wrapper under WMI, outside this server's job and tree. Its
    // startup block is the command's whole environment, which the launcher reads from stdin so no
    // value reaches the disk.
    const scriptPath = path.join(directory, "command.ps1");
    const wrapperPath = path.join(directory, "run.ps1");
    const bashScriptPath = path.join(directory, "command.sh");
    if (shell === "bash") yield* fs.writeFileString(bashScriptPath, command);
    yield* fs.writeFileString(
      scriptPath,
      [
        "\uFEFF$ErrorActionPreference = 'Continue'",
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
    yield* fs.writeFileString(wrapperPath, WINDOWS_WRAPPER);
    yield* fs.writeFileString(logPath, "");
    const created = yield* processRunner
      .run({
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // Windows folds names by a case table only it has, so the launcher keeps the last of the
          // spellings Windows reads as one name. It keeps them in a list: a dictionary key named
          // like a member (Values) hides that member in PowerShell.
          `$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split([char]0); $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); $environment = [Collections.Generic.List[string]]::new(); for ($i = $entries.Length - 1; $i -ge 0; $i--) { if ($names.Add($entries[$i].Substring(0, [Math]::Max(0, $entries[$i].IndexOf('=', 1))))) { $environment.Insert(0, $entries[$i]) } }; $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $environment.ToArray(); CreateFlags = [uint32]${CREATE_UNICODE_ENVIRONMENT}; ShowWindow = [uint16]${SW_HIDE} }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"' + $powershell + ${escapePowerShellStringLiteral(`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperPath}"`)}; CurrentDirectory = ${escapePowerShellStringLiteral(cwd)}; ProcessStartupInformation = $startup }; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned $($r.ReturnValue)"); exit 1 }; $r.ProcessId; ${windowsStartOrEnded("$r.ProcessId")}`,
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
      })
      .pipe(Effect.result);
    // Once Create returned a pid the command has started, whatever the launcher does after: its
    // stdout names the pid, and when a timeout lost the stdout, the wrapper's pid file does. The
    // creation read is best effort, since a failed read leaves the runner to read it itself.
    const output = created._tag === "Success" ? created.success : undefined;
    const [pidLine = "", madeLine = ""] = (output?.stdout ?? "").trim().split(/\s+/);
    const printed = Number.parseInt(pidLine, 10);
    const pid =
      Number.isSafeInteger(printed) && printed > 0
        ? printed
        : yield* readWrapperFile(path.join(directory, PID_FILE)).pipe(
            Effect.map((named) =>
              named !== undefined && Number.isSafeInteger(named.value) && named.value > 0
                ? named.value
                : undefined,
            ),
          );
    if (pid === undefined) {
      return yield* new CommandLaunchError({
        detail:
          output?.stderr.trim() ||
          (created._tag === "Failure" ? created.failure.message : "") ||
          "Win32_Process.Create failed.",
      });
    }
    // The creation time comes from the call that created the process, as Windows stored it. A
    // wrapper the launcher no longer finds has ended: a later read could find a process that took
    // its pid inside a window a clock step widened.
    const madeAt = Date.parse(madeLine);
    // It names itself in its pid file before it starts the command, so without that file it
    // started nothing, and what the pid's earlier holder started must not be taken for its own.
    // A file that cannot be looked for may be there, so its record stays for the watcher.
    const named =
      madeLine !== ENDED_IDENTITY ||
      (yield* fs
        .exists(path.join(directory, PID_FILE))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("command-runner.pid-file-unseen", { pid, cause }).pipe(
              Effect.as(true),
            ),
          ),
        ));
    if (!named) {
      return yield* new CommandLaunchError({
        detail: "PowerShell ended before it started the command.",
      });
    }
    return {
      pid,
      unit: null,
      identity:
        madeLine === ENDED_IDENTITY
          ? ENDED_IDENTITY
          : Number.isFinite(madeAt)
            ? timeIdentity(madeAt)
            : undefined,
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

  /**
   * The wall clock between two monotonic reads, each pair read in one step so no pause falls
   * between its reads: the wall clock then falls behind by at least any step back between the
   * record and the launch's return.
   */
  const recordedClocks = Clock.clockWith((clock) =>
    Effect.sync(() => {
      const monotonic = clock.monotonicTimeNanosUnsafe();
      return { monotonic, wall: clock.currentTimeMillisUnsafe() };
    }),
  );

  /**
   * Starts a command whose record says it runs, recorded at `recorded`, and watches it. One that
   * cannot start loses its record, and the reason comes back.
   */
  const startRecorded = Effect.fn("CommandRunner.startRecorded")(function* (
    row: CommandRunRow,
    recorded: Effect.Success<typeof recordedClocks>,
    commandEnv: Readonly<Record<string, string>>,
  ) {
    const started = yield* fs
      .makeDirectory(row.directory, { recursive: true })
      .pipe(Effect.andThen(launch(row, commandEnv)), Effect.result);
    if (started._tag === "Failure") {
      yield* sql`DELETE FROM command_runs WHERE task_id = ${row.task_id}`.pipe(
        Effect.ignore({ log: true }),
      );
      return started.failure.message;
    }
    const { pid, unit, identity } = started.success;
    const returned = yield* Clock.clockWith((clock) =>
      Effect.sync(() => {
        const wall = clock.currentTimeMillisUnsafe();
        return { wall, monotonic: clock.monotonicTimeNanosUnsafe() };
      }),
    );
    const tookMs = Number(returned.monotonic - recorded.monotonic) / 1_000_000;
    // A step back stamps a wrapper that started before it up to this late, and one that started
    // after it up to this early.
    const lagMs = Math.max(0, Math.ceil(tookMs - (returned.wall - recorded.wall)));
    const launched: CommandRunRow = {
      ...row,
      pid,
      // Taken before the read, which can take seconds and find a later process.
      process_identity:
        identity ??
        launchIdentity(
          yield* identityOf(pid),
          { from: recorded.wall - lagMs, to: returned.wall + lagMs },
          platform,
        ),
      unit,
      last_alive_at: yield* nowIso,
    };
    watched.set(row.task_id, launched);
    // Its pid file names it to the next server if this write is lost.
    yield* writeRow(launched).pipe(Effect.ignore({ log: true }));
    return undefined;
  });

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
   * Starts the oldest queued command once this machine has memory and CPU for it, one a pass, so
   * each start reads them after the one before it took its share. Its time limit counts from here.
   */
  const startQueued = Effect.fn("CommandRunner.startQueued")(function* () {
    yield* lock.withPermits(1)(Effect.forEach([...unstartedEnds.values()], endUnstarted));
    const next = queue[0];
    if (next === undefined || (yield* queuedShortage) !== null || (yield* cpuHold) !== null) return;
    // Outside the lock, which a slow read of the agent's environment would hold.
    const environment = yield* queuedEnvironment(next).pipe(Effect.result);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // A cancel, Stop or close took it off meanwhile; the next pass looks again.
        if (queue[0] !== next) return;
        // The read took a while, and may have started a process of its own.
        if ((yield* queuedShortage) !== null || (yield* cpuHold) !== null) return;
        const instead = yield* notToStart(next);
        if (instead !== undefined) return yield* dropQueued(next, instead.end);
        if (environment._tag === "Failure") {
          return yield* dropQueued(next, couldNotStart(environment.failure.message));
        }
        const recorded = yield* recordedClocks;
        const now = DateTime.makeUnsafe(recorded.wall);
        const limitMs = Date.parse(next.deadline_at) - Date.parse(next.started_at);
        const row: CommandRunRow = {
          ...next,
          status: "running",
          started_at: DateTime.formatIso(now),
          deadline_at: DateTime.formatIso(DateTime.add(now, { milliseconds: limitMs })),
        };
        // Before its task runs: a server that stops between the two leaves the next one a command
        // recorded as running that never started, which it ends as it ends any other.
        yield* sql`
          UPDATE command_runs
          SET status = ${row.status}, started_at = ${row.started_at}, deadline_at = ${row.deadline_at}
          WHERE task_id = ${row.task_id}
        `;
        // Its task runs before its command does. The start is refused once its task has a result
        // or its chat is closed, so a cancel or a close that lands first keeps it unstarted.
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
        const notStarted = yield* startRecorded(row, recorded, environment.success);
        if (notStarted !== undefined) yield* endUnstarted({ row, ...couldNotStart(notStarted) });
      }),
    );
  });

  const run: CommandRunner["Service"]["run"] = flow(
    Effect.fn("CommandRunner.run")(function* (
      scope: ThreadScope,
      input: OrchestratorMcpRunCommandInput,
    ) {
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
      const key = input.clientRequestId ?? (yield* random.uuidV4());
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
      // lock keeps it from overtaking a command queued meanwhile, or starting as memory runs short.
      return yield* Effect.uninterruptible(
        lock.withPermits(1)(
          Effect.gen(function* () {
            // One already waiting takes no second reading here, under the lock that watching needs.
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
            // A retried request recorded the task the first time.
            const prior = parent.subagents.find((task) => task.command?.logPath === logPath);
            const taskId =
              taskEvent?.event.type === "subagent.updated" ? taskEvent.event.payload.id : prior?.id;
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
                      commandId: CommandId.make(`command:command-task-unstarted-dispose:${taskId}`),
                      parentThreadId: scope.thread.threadId,
                      taskId,
                    }),
                  ),
                  Effect.ignore({ log: true }),
                  Effect.andThen(Effect.fail(failure("orchestration_error", message))),
                );
            return yield* Effect.gen(function* () {
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
                return yield* unstarted(couldNotStart(records.failure.message));
              }
              const { thread, subagents } = records.success;
              // Cancelled, or its first request could not start it: the task already says why.
              const endedWith = subagents[0]?.result;
              if (endedWith != null) return yield* failure("orchestration_error", endedWith);
              const closed = closedOf(thread);
              if (closed !== undefined) {
                return yield* unstarted(chatClosed(closed));
              }
              const clocks = yield* recordedClocks;
              const now = DateTime.makeUnsafe(clocks.wall);
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
                unit: null,
                status: startEnv === undefined ? "queued" : "running",
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
              const inserted = yield* sql`
                INSERT INTO command_runs (
                  task_id, thread_id, run_id, label, command, shell, cwd, directory, pid,
                  process_identity, unit, status, exit_code, started_at, deadline_at, ended_at,
                  delivered_at
                ) VALUES (
                  ${row.task_id}, ${row.thread_id}, ${row.run_id}, ${row.label}, ${row.command},
                  ${row.shell}, ${row.cwd}, ${row.directory}, ${row.pid}, ${row.process_identity},
                  ${row.unit}, ${row.status}, ${row.exit_code}, ${row.started_at},
                  ${row.deadline_at}, ${row.ended_at}, ${row.delivered_at}
                )
              `.pipe(Effect.result);
              if (inserted._tag === "Failure") {
                return yield* unstarted(couldNotStart(inserted.failure.message));
              }
              if (startEnv === undefined) {
                queue.push(row);
                return result(taskId);
              }
              const notStarted = yield* startRecorded(row, clocks, startEnv);
              if (notStarted !== undefined) {
                return yield* unstarted(couldNotStart(notStarted));
              }
              return result(taskId);
            }).pipe(
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
        ),
      );
    }),
    Effect.scoped,
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
    // A wrapper that is gone still names its group, which can outlive it. A live process under its
    // pid later is another one, so it is never taken for the wrapper.
    if (!isProcessAlive(pid)) {
      return { ...row, pid, process_identity: ENDED_IDENTITY };
    }
    // Windows keeps its creation time from the launch; elsewhere the wrapper recorded its own
    // identity before it named itself, which no step of the clock can move. A file without one
    // (an older server's, or an unreadable start) gives no ownership: the group is left running.
    const recorded =
      platform === "win32"
        ? undefined
        : recordedIdentity(
            platform,
            yield* fs
              .readFileString(path.join(row.directory, IDENTITY_FILE))
              .pipe(Effect.option, Effect.map(Option.getOrElse(() => ""))),
          );
    if (platform !== "win32") {
      if (recorded === undefined || compareIdentity(recorded, yield* identityOf(pid)) === "other") {
        return { ...row, lost_reason: "pid-reused" as const };
      }
    } else {
      const startedAt = yield* startedAtOf(pid);
      const writtenAt = named.writtenAt?.getTime();
      // It started before it wrote the file; a later process reusing the pid did not. ps reports
      // whole seconds.
      if (startedAt !== undefined && writtenAt !== undefined && startedAt > writtenAt + 1_000) {
        return { ...row, lost_reason: "pid-reused" as const };
      }
    }
    const recovered: CommandRunRow = {
      ...row,
      pid,
      process_identity: recorded ?? (yield* identityOf(pid)) ?? null,
    };
    yield* writeRow(recovered);
    return recovered;
  });

  /** What one record an earlier server left needs, given its task if that is still open. */
  const adoptRow = Effect.fn("CommandRunner.adoptRow")(function* (
    stored: CommandRunRow,
    task: ProjectionStore.ProjectionOpenCommandTask | undefined,
  ) {
    if (stored.status === "queued") {
      // It waits again, unless its task got its result or its chat was closed meanwhile.
      if (task === undefined) {
        return yield* sql`DELETE FROM command_runs WHERE task_id = ${stored.task_id}`;
      }
      if (task.threadClosed === null) {
        queue.push(stored);
        return;
      }
      return yield* endUnstarted({ row: stored, ...chatClosed(task.threadClosed) });
    }
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
            ...chatClosed(task.threadClosed),
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
    if (loss === undefined || loss === "unconfirmed") {
      if (loss === "unconfirmed") unconfirmed.add(row.task_id);
      watched.set(row.task_id, row);
      return;
    }
    yield* recordLoss(row, loss);
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
      fs
        .remove(row.directory, { recursive: true, force: true })
        .pipe(
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
        // Before the first pass, which writes the losses log.
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
        yield* watchOnce.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.repeat(Schedule.spaced(watchInterval)),
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return CommandRunner.of({ run, start });
});

export const layer = Layer.effect(CommandRunner, make);
