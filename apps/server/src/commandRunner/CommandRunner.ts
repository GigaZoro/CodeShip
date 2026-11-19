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
import { WindowsJobHost, windowsJobName } from "@t3tools/shared/windowsJob";
import {
  WINDOWS_PROCESS_TREE_FUNCTIONS,
  windowsStopTreeArgs,
} from "@t3tools/shared/windowsProcessTree";
import * as Cause from "effect/Cause";
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
const LAUNCH_PENDING = "launch-pending";
const LAUNCH_STARTED = "launch-started";
const LAUNCH_CANCELLED = "launch-cancelled";
// PowerShell startup and WMI can each be slow on a loaded Windows host.
const WINDOWS_LAUNCH_TIMEOUT = Duration.minutes(2);
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
  `  try { [IO.Directory]::Move((Join-Path $PSScriptRoot '${LAUNCH_PENDING}'), (Join-Path $PSScriptRoot '${LAUNCH_STARTED}')) } catch {`,
  `    $why = if ([IO.Directory]::Exists((Join-Path $PSScriptRoot '${LAUNCH_CANCELLED}'))) { 'Command launch was cancelled before it started.' } else { "Could not take the command start gate: $_" }`,
  `    Add-Content -LiteralPath (Join-Path $PSScriptRoot '${LOG_FILE}') -Value $why`,
  "    exit 1",
  "  }",
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
type CommandRunStatus = "running" | "exited" | "timed_out" | "lost" | "stopped" | "unstarted";

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
  /** The caller can receive a deadline failure while uncertain legacy ownership still needs checking. */
  readonly reported_at: string | null;
  /** The last check that found its process alive, written about once a minute while it runs. */
  readonly last_alive_at: string | null;
  /** What the last probe of its pid that did not find it alive reported. */
  readonly probe_error: string | null;
  readonly lost_reason: LostReason | null;
  /** Its output's tail when it was lost. */
  readonly lost_output: string | null;
  readonly launch_error: string | null;
}

type LaunchResolution =
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "started"; readonly row: CommandRunRow }
  | { readonly outcome: "ended"; readonly row: CommandRunRow; readonly loss: Loss }
  | { readonly outcome: "unstarted" }
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
  const windows = platform === "win32";
  const hostEnv = yield* HostProcess.Environment;
  const watchInterval = yield* WatchInterval;

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
  const checkFailures = new Map<string, string>();
  // Slow probes and stops have separate limits so an unavailable probe cannot starve a deadline.
  const identitySlots = yield* Semaphore.make(2);
  const stopSlots = yield* Semaphore.make(2);
  const identityKey = (row: CommandRunRow) => `${row.pid}:${row.process_started_at}`;
  /** Every change to a watched command, so its process is stopped or delivered once. */
  const lock = yield* Semaphore.make(1);
  /** Open once start() has adopted the commands an earlier server left, so run() never races it. */
  const adopted = yield* Deferred.make<void>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const startedAtOf = (pid: number) =>
    identitySlots.withPermits(1)(
      readProcessStartedAt(pid, windows ? WINDOWS_LAUNCH_TIMEOUT : undefined).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    );
  const logPathOf = (row: Pick<CommandRunRow, "directory">) => path.join(row.directory, LOG_FILE);
  const statusPathOf = (row: Pick<CommandRunRow, "directory">) =>
    path.join(row.directory, STATUS_FILE);

  /** A file the wrapper wrote, with when it wrote it. */
  const readWrapperFile = (file: string) =>
    Effect.all([fs.readFileString(file), fs.stat(file)]).pipe(
      Effect.map(([text, info]) => ({
        value: Number.parseInt(text.trim(), 10),
        identity: /^\d+\s+\d+$/.test(text.trim()) ? Number(text.trim().split(/\s+/)[1]) : undefined,
        writtenAt: Option.getOrUndefined(info.mtime),
      })),
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
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

  const isSameProcess = Effect.fn("CommandRunner.isSameProcess")(function* (
    row: CommandRunRow,
  ): Effect.fn.Return<number | "unknown" | Loss, import("effect/PlatformError").PlatformError> {
    const probe_error = row.probe_error;
    if (row.pid === null) return { lost_reason: row.lost_reason ?? "no-pid", probe_error };
    if (yield* rebootedSince(row)) return { lost_reason: "rebooted", probe_error };
    const probe = probeProcess(row.pid);
    if (probe.state === "gone") return { lost_reason: "gone", probe_error: probe.code };
    if (probe.state === "unknown") return "unknown";
    const startedAt = yield* startedAtOf(row.pid);
    // ps reports whole seconds; a failed probe proves neither ownership nor loss.
    if (startedAt === undefined) return "unknown";
    if (row.process_started_at === null) {
      const named = yield* readWrapperFile(path.join(row.directory, PID_FILE));
      const exit = yield* readExitStatus(row);
      const upper =
        exit?.endedAt === undefined ? named?.writtenAt?.getTime() : Date.parse(exit.endedAt);
      if (upper === undefined) return "unknown";
      const precision = windows ? 0 : 1_000;
      if (startedAt < Date.parse(row.started_at) - precision || startedAt > upper + precision)
        return { lost_reason: "pid-reused", probe_error };
      return windows ? "unknown" : startedAt;
    }
    return Math.abs(startedAt - row.process_started_at) <= (windows ? 0 : 1_000)
      ? startedAt
      : { lost_reason: "pid-reused", probe_error };
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
   * Stops the command and everything it started: its process group, or on Windows what descends
   * from its wrapper's pid (`windowsStopTreeArgs`), also after the wrapper ended. A group outlives
   * its wrapper and its id is not reused while any member lives, so short of a reboot, only a live
   * process reusing the wrapper's pid means nothing of the group is left.
   */
  const killTree = Effect.fn("CommandRunner.killTree")(function* (row: CommandRunRow) {
    if (windows && row.unit?.startsWith(jobUnitPrefix)) {
      const host = yield* yield* WindowsJobHost;
      const stopped = yield* stopSlots
        .withPermits(1)(
          processRunner.run({
            command: host,
            args: ["stop", row.unit.slice(jobUnitPrefix.length)],
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
    if (pid !== null && !(yield* rebootedSince(row))) {
      if (!windows) {
        const same = yield* isSameProcess(row);
        if (same === "unknown") return false;
        if (typeof same === "number" || same.lost_reason === "gone") yield* killGroup(pid);
      } else {
        const same = yield* isSameProcess(row);
        if (same === "unknown") return false;
        // A legacy row has no retained membership after its root ends; never infer another holder's family.
        if (typeof same !== "number") return true;
        const stopped = yield* stopSlots
          .withPermits(1)(
            processRunner.run({
              command: "powershell.exe",
              args: windowsStopTreeArgs({
                pid,
                since: same,
                created:
                  row.process_started_at === null
                    ? null
                    : { from: row.process_started_at, to: row.process_started_at },
              }),
              timeout: Duration.seconds(30),
              maxOutputBytes: 16_384,
            }),
          )
          .pipe(Effect.mapError((cause) => new CommandStopError({ detail: cause.message, cause })));
        if (stopped.code !== 0) {
          return yield* new CommandStopError({
            detail: `Could not stop the command tree (exit ${stopped.code}): ${stopped.stderr.trim()}`,
          });
        }
      }
    }
    if (row.unit !== null) yield* agentScope.stop(row.unit);
    return true;
  });

  const writeRow = (row: CommandRunRow) =>
    sql`
      UPDATE command_runs
      SET pid = ${row.pid}, process_started_at = ${row.process_started_at}, unit = ${row.unit},
        status = ${row.status}, exit_code = ${row.exit_code}, ended_at = ${row.ended_at},
        delivered_at = ${row.delivered_at}, last_alive_at = ${row.last_alive_at},
        probe_error = ${row.probe_error}, lost_reason = ${row.lost_reason},
        lost_output = ${row.lost_output}, launch_error = ${row.launch_error}, reported_at = ${row.reported_at}
      WHERE task_id = ${row.task_id}
    `;

  /** A command is watched until its end is delivered. */
  const remember = (row: CommandRunRow) => {
    if (row.delivered_at === null) watched.set(row.task_id, row);
    else {
      watched.delete(row.task_id);
      pendingStops.delete(row.task_id);
      verified.delete(row.task_id);
      checkFailures.delete(row.task_id);
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

  const resultText = Effect.fn("CommandRunner.resultText")(function* (
    row: CommandRunRow,
    cleanupPending = false,
  ) {
    const elapsed = formatDuration(
      Date.parse(row.ended_at ?? row.started_at) - Date.parse(row.started_at),
    );
    const ending =
      row.status === "unstarted"
        ? `Could not start the command: ${row.launch_error ?? "the server stopped before launch completed."}`
        : row.status === "timed_out"
          ? cleanupPending
            ? `Timed out after ${elapsed}. CodeShip cannot verify ownership yet and keeps checking before stopping it.`
            : `Timed out and was stopped after ${elapsed}.`
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
  const deliver = Effect.fn("CommandRunner.deliver")(function* (
    row: CommandRunRow,
    cleanupPending = false,
  ) {
    if (row.reported_at !== null) {
      if (!cleanupPending) yield* settle({ ...row, delivered_at: yield* nowIso });
      return;
    }
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
        result: yield* resultText(row, cleanupPending),
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
    if (delivered) {
      const now = yield* nowIso;
      yield* settle({ ...row, reported_at: now, delivered_at: cleanupPending ? null : now });
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
      WHERE started_at <= ${isoAt(Math.max(...times))}
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
    if (!windows) return "legacy" as const;
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

  /** Slow evidence and process operations belong to one row, never to the shared lock. */
  const check = Effect.fn("CommandRunner.check")(function* (snapshot: CommandRunRow) {
    let row = snapshot;
    let loss: Loss | undefined;
    if (
      (row.pid === null || (windows && row.process_started_at === null)) &&
      row.status !== "exited" &&
      (row.status !== "unstarted" || row.reported_at !== null) &&
      !(row.status !== "running" && windows && row.unit?.startsWith(jobUnitPrefix))
    ) {
      const resolution = yield* recoverPid(row);
      if (resolution.outcome === "unresolved" || resolution.outcome === "unstarted") {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (watched.get(row.task_id) !== snapshot) return;
            if (
              resolution.outcome === "unstarted" &&
              (row.status === "running" || row.status === "timed_out")
            ) {
              row = { ...row, status: "unstarted", ended_at: row.ended_at ?? (yield* nowIso) };
              yield* settle(row);
            }
            if (row.status !== "running") yield* deliver(row, true);
          }),
        );
      }
      if (resolution.outcome === "cancelled") {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (watched.get(row.task_id) !== snapshot) return;
            const now = yield* nowIso;
            const next: CommandRunRow = {
              ...row,
              status: row.status === "running" ? "unstarted" : row.status,
              ended_at: row.ended_at ?? now,
            };
            if (next.status === "stopped") return yield* settle({ ...next, delivered_at: now });
            yield* settle(next);
            yield* deliver(next);
          }),
        );
      }
      row = resolution.row;
      if (resolution.outcome === "ended") {
        loss = resolution.loss;
        row = { ...row, ...loss };
      }
    }
    const exit = row.status === "running" ? yield* readExitStatus(row) : undefined;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const overdue = Date.parse(row.deadline_at) <= now;
    if (row.status === "running" && exit === undefined && !overdue && loss === undefined) {
      const probe = row.pid === null ? undefined : probeProcess(row.pid);
      const cached = verified.get(row.task_id);
      const mustVerify =
        cached?.key !== identityKey(row) ||
        now - cached.at >= 60_000 ||
        row.process_started_at === null ||
        probe?.state !== "alive" ||
        (yield* rebootedSince(row));
      const identity = mustVerify ? yield* isSameProcess(row) : row.process_started_at!;
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
      if (typeof identity === "number") {
        if (row.process_started_at === null) row = { ...row, process_started_at: identity };
        if (mustVerify) verified.set(row.task_id, { key: identityKey(row), at: now });
      } else loss = identity;
    }
    const next = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (watched.get(row.task_id) !== snapshot) return undefined;
        if (row.status !== "running") {
          if (row !== snapshot) yield* settle(row);
          return row;
        }
        if (exit !== undefined) {
          const ended: CommandRunRow = {
            ...row,
            status: "exited",
            exit_code: exit.code,
            ended_at: exit.endedAt ?? (yield* nowIso),
          };
          yield* settle(ended);
          return ended;
        }
        if (overdue) {
          const ended: CommandRunRow = { ...row, status: "timed_out", ended_at: yield* nowIso };
          yield* settle(ended);
          return ended;
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
            return ended;
          }
          return yield* recordLoss(row, loss);
        }
        const seen = { ...row, last_alive_at: yield* nowIso, probe_error: null };
        const minuteOf = (at: string | null) =>
          at === null ? -1 : Math.floor(Date.parse(at) / 60_000);
        if (
          row.pid !== snapshot.pid ||
          row.process_started_at !== snapshot.process_started_at ||
          minuteOf(row.last_alive_at) !== minuteOf(seen.last_alive_at)
        ) {
          yield* settle(seen);
        } else watched.set(row.task_id, seen);
        return undefined;
      }),
    );
    if (next === undefined) return;
    if (
      (next.status === "stopped" ||
        next.status === "timed_out" ||
        next.status === "lost" ||
        (next.status === "unstarted" && next.pid !== null) ||
        (windows && next.status === "exited" && next.unit?.startsWith(jobUnitPrefix))) &&
      !(yield* killTree(next))
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (watched.get(next.task_id) === next) yield* deliver(next, true);
        }),
      );
    }
    if (windows) yield* trimLog(next);
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (watched.get(next.task_id) !== next) return;
        if (next.status === "stopped") yield* settle({ ...next, delivered_at: yield* nowIso });
        else yield* deliver(next);
      }),
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
      Effect.ensuring(windows ? Effect.void : trimLog(row)),
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
        if (row.status === "running" && Date.parse(row.deadline_at) <= now)
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
  const requestStop = (taskId: string, status: "stopped" | "timed_out") =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const row = watched.get(taskId);
        if (row === undefined || (row.status !== "running" && row.status !== status)) return;
        if (row.status === status && !pendingStops.has(taskId)) return;
        if (status === "timed_out" && row.status === "running") {
          const exit = yield* readExitStatus(row);
          if (exit !== undefined) {
            const exited: CommandRunRow = {
              ...row,
              status: "exited",
              exit_code: exit.code,
              ended_at: exit.endedAt ?? (yield* nowIso),
            };
            yield* settle(exited);
            return;
          }
        }
        const stopped: CommandRunRow = {
          ...row,
          status,
          ended_at: row.ended_at ?? (yield* nowIso),
        };
        // Keep the stop intent even if persistence or the gate is temporarily unavailable.
        watched.set(taskId, stopped);
        pendingStops.add(taskId);
        const gate = yield* closeLaunchGate(stopped).pipe(Effect.result);
        const saved = yield* writeRow(stopped).pipe(Effect.result);
        if (gate._tag === "Success" && gate.success === "cancelled") {
          if (status === "stopped") yield* settle({ ...stopped, delivered_at: yield* nowIso });
          else yield* deliver(stopped);
        }
        if (gate._tag === "Failure") return yield* gate.failure;
        if (saved._tag === "Failure") return yield* saved.failure;
        pendingStops.delete(taskId);
      }),
    );

  const stopForTask = (taskId: string) => requestStop(taskId, "stopped");

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
    { command, shell }: Pick<OrchestratorMcpRunCommandInput, "command" | "shell">,
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
          resolveCommandShell(platform, env, shell).path,
          "-c",
          command,
        ],
        name: "command",
        env,
        survivesRestart: true,
      });
      const pid = yield* spawnDetached(scoped.command, scoped.args, cwd, env);
      return {
        pid,
        process_started_at: (yield* startedAtOf(pid)) ?? null,
        unit: scoped.unit ?? null,
      };
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
    const host = yield* yield* WindowsJobHost;
    const created = yield* processRunner.run({
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Windows folds names by a case table only it has, so the launcher keeps the last of the
        // spellings Windows reads as one name. It keeps them in a list: a dictionary key named
        // like a member (Values) hides that member in PowerShell.
        `$entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())).Split([char]0); $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); $environment = [Collections.Generic.List[string]]::new(); for ($i = $entries.Length - 1; $i -ge 0; $i--) { if ($names.Add($entries[$i].Substring(0, [Math]::Max(0, $entries[$i].IndexOf('=', 1))))) { $environment.Insert(0, $entries[$i]) } }; $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\\v1.0\\powershell.exe'; $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $environment.ToArray(); CreateFlags = [uint32]${CREATE_UNICODE_ENVIRONMENT}; ShowWindow = [uint16]${SW_HIDE} }; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${escapePowerShellStringLiteral(`"${host}" run "${jobFor(directory)}" "${path.join(directory, PID_FILE)}" "`)} + $powershell + ${escapePowerShellStringLiteral(`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${wrapperPath}"`)}; CurrentDirectory = ${escapePowerShellStringLiteral(cwd)}; ProcessStartupInformation = $startup }; if ($r.ReturnValue -ne 0) { [Console]::Error.WriteLine("Win32_Process.Create returned $($r.ReturnValue)"); exit 1 }; $pidFile = ${escapePowerShellStringLiteral(path.join(directory, PID_FILE))}; while (-not [IO.File]::Exists($pidFile)) { if ([IO.File]::Exists(${escapePowerShellStringLiteral(statusPath)}) -or -not (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('The command host ended before publishing its pid.'); exit 1 }; Start-Sleep -Milliseconds 50 }; Get-Content -LiteralPath $pidFile`,
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
    if (
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      identity === undefined ||
      !Number.isSafeInteger(identity) ||
      identity <= 0
    ) {
      return yield* new CommandLaunchError({
        detail: "The wrapper did not record its process creation time.",
      });
    }
    return { pid, process_started_at: identity, unit: `${jobUnitPrefix}${jobFor(directory)}` };
  });

  const run: CommandRunner["Service"]["run"] = Effect.fn("CommandRunner.run")(
    function* (scope, input) {
      if (input.command.includes("\0"))
        return yield* failure("invalid_request", "A command cannot contain a NUL character.");
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
          input.shell,
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
          const prepared = yield* lock
            .withPermits(1)(
              Effect.gen(function* () {
                const existing = yield* sql<{ readonly task_id: string }>`
            SELECT task_id FROM command_runs WHERE task_id = ${taskId}
          `;
                if (existing.length > 0) return undefined;
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
                  unit: windows ? `${jobUnitPrefix}${jobFor(directory)}` : null,
                  status: "running",
                  exit_code: null,
                  started_at: DateTime.formatIso(now),
                  deadline_at: DateTime.formatIso(DateTime.add(now, { minutes: timeoutMinutes })),
                  ended_at: null,
                  delivered_at: null,
                  reported_at: null,
                  last_alive_at: null,
                  probe_error: null,
                  lost_reason: null,
                  lost_output: null,
                  launch_error: null,
                };
                // Recorded before it starts, so a server that stops in between leaves the next one
                // a record to adopt it by, never a command nothing watches.
                const recordedRow = yield* fs.makeDirectory(directory, { recursive: true }).pipe(
                  Effect.andThen(
                    windows ? fs.makeDirectory(path.join(directory, LAUNCH_PENDING)) : Effect.void,
                  ),
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
                      Effect.fail(failure("orchestration_error", "Unable to record the command.")),
                    ),
                  ),
              }),
            );
          if (prepared === undefined) return result(taskId);
          const started = yield* Effect.gen(function* () {
            const launched = yield* launch(directory, input, cwd, commandEnv).pipe(
              Effect.catchCause((cause) => {
                const error = Cause.squash(cause);
                return Effect.logWarning("command-runner.launch-failed", { taskId, cause }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new CommandLaunchError({
                        detail:
                          error instanceof Error
                            ? error.message
                            : "The launcher failed unexpectedly.",
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
                  // A cancellation that won the gate is already delivered; never resurrect it.
                  if (current === undefined) return;
                  const next: CommandRunRow =
                    launched._tag === "Success"
                      ? { ...current, ...launched.success, last_alive_at: yield* nowIso }
                      : { ...current, launch_error: launched.failure.message };
                  watched.set(taskId, next);
                  if (launched._tag === "Success" && next.process_started_at !== null)
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
          return result(taskId);
        }),
      );
    },
  );

  /** The gate proves non-execution; unreadable evidence proves nothing. */
  const recoverPid = Effect.fn("CommandRunner.recoverPid")(
    function* (
      row: CommandRunRow,
    ): Effect.fn.Return<LaunchResolution, import("effect/PlatformError").PlatformError> {
      const gate = yield* closeLaunchGate(row);
      if (gate === "cancelled") return { outcome: "cancelled" };
      const named = yield* readWrapperFile(path.join(row.directory, PID_FILE));
      const ended = (reason: LostReason, pid = row.pid): LaunchResolution => ({
        outcome: "ended",
        row: { ...row, pid },
        loss: { lost_reason: reason, probe_error: row.probe_error },
      });
      if (yield* rebootedSince(row))
        return ended(
          "rebooted",
          named !== undefined && Number.isSafeInteger(named.value) && named.value > 0
            ? named.value
            : row.pid,
        );
      if (named === undefined || !Number.isSafeInteger(named.value) || named.value <= 0) {
        if ((yield* readExitStatus(row)) !== undefined) return { outcome: "started", row };
        if (!windows && row.launch_error !== null) return { outcome: "cancelled" };
        if (
          !windows &&
          DateTime.toEpochMillis(yield* DateTime.now) - Date.parse(row.started_at) >= 5_000
        )
          return { outcome: "unstarted" };
        return { outcome: "unresolved" };
      }
      const pid = named.value;
      let identity = named.identity;
      if (identity === undefined) {
        if ((yield* readExitStatus(row)) !== undefined)
          return { outcome: "started", row: { ...row, pid, process_started_at: null } };
        const writtenAt = named.writtenAt?.getTime();
        if (writtenAt === undefined) return { outcome: "unresolved" };
        if (isProcessAlive(pid)) {
          const startedAt = yield* startedAtOf(pid);
          if (startedAt === undefined) return { outcome: "unresolved" };
          const precision = windows ? 0 : 1_000;
          if (
            startedAt < Date.parse(row.started_at) - precision ||
            startedAt > writtenAt + precision
          )
            return ended("pid-reused", pid);
          if (windows) return { outcome: "unresolved" };
          identity = startedAt;
        } else return ended("gone", pid);
      }
      return { outcome: "started", row: { ...row, pid, process_started_at: identity } };
    },
    Effect.catch((cause) =>
      Effect.logWarning("command-runner.launch-recovery-failed", { cause }).pipe(
        Effect.as({ outcome: "unresolved" } as const),
      ),
    ),
  );

  /** Register every undelivered row before trying evidence that can temporarily be unavailable. */
  const adoptRow = Effect.fn("CommandRunner.adoptRow")(function* (
    row: CommandRunRow,
    task: ProjectionStore.ProjectionOpenCommandTask | undefined,
  ) {
    watched.set(row.task_id, row);
    if (row.status !== "running" || (task !== undefined && task.threadClosed === null)) return;
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
        .pipe(Effect.ignore({ log: true }));
    }
    const stopped: CommandRunRow = { ...row, status: "stopped", ended_at: yield* nowIso };
    watched.set(row.task_id, stopped);
    yield* writeRow(stopped);
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
        const watchedOnce = watchOnce.pipe(Effect.ignoreCause({ log: true }));
        yield* watchedOnce;
        const pruned = prune.pipe(Effect.ignoreCause({ log: true }));
        yield* pruned;
        yield* Effect.forkScoped(pruned.pipe(Effect.delay(RETENTION_INTERVAL), Effect.forever));
        yield* watchedOnce.pipe(Effect.repeat(Schedule.spaced(watchInterval)));
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return CommandRunner.of({ run, start });
});

export const layer = Layer.effect(CommandRunner, make);
