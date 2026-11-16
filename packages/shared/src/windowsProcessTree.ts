// @effect-diagnostics globalDate:off globalDateInEffect:off - The walk compares times with process creation times, which the system clock stamps.
/**
 * Ends a process and what it started on Windows, also after the process exited. Windows has no
 * process groups, and `taskkill /T` finds descendants only through a running leader, so what a
 * leader left running outlives it. This walks `Win32_Process` by `ParentProcessId`, which outlives
 * the parent, in PowerShell.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A child older than the parent it names belongs to an earlier holder of that pid, as does a root
 * created outside [from, to]; another holder's children count only from before it. The stop allows
 * a second of clock skew, and each pass stops what the last one's processes started as they ended.
 * A process that ends before its stop is no error; one still running is.
 */
export const WINDOWS_PROCESS_TREE_FUNCTIONS = [
  "function Ms($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }",
  "function Get-T3ProcessTree($all, $root, $since, $from, $to) {",
  "  $targets = @{}",
  "  $before = [long]::MaxValue",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ms $holder.CreationDate",
  "    if ($made -ge $from -and $made -le $to) { $targets[$root] = $true; $since = [math]::Max($since, $made) } else { $before = $made }",
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
  "function Stop-T3ProcessTree($root, $since, $from = [double]::NegativeInfinity, $to = [double]::PositiveInfinity) {",
  "  for ($pass = 0; $pass -lt 5; $pass++) {",
  "    $targets = Get-T3ProcessTree @(Get-CimInstance Win32_Process -ErrorAction Stop) $root ($since - 1000) ($from - 1000) ($to + 1000)",
  "    if ($targets.Count -eq 0) { return }",
  "    foreach ($id in $targets.Keys) {",
  "      try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw } }",
  "    }",
  "  }",
  "}",
].join("\n");

/** Times are milliseconds since the epoch, read from the wall clock the system stamps processes with. */
export interface WindowsProcessTreeRoot {
  readonly pid: number;
  /** Nothing in the tree started before this. */
  readonly since: number;
  /** When the root started; a process holding its pid outside this window is another process. */
  readonly created?: { readonly from: number; readonly to: number };
}

/**
 * PowerShell's arguments that stop a tree once its root is appended to the last one as
 * ` <pid> <since> [<from> <to>]`, for code that cannot import this module. They hold no double
 * quote, which Node would escape.
 */
export const WINDOWS_STOP_TREE_ARGS: ReadonlyArray<string> = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  ["$ErrorActionPreference = 'Stop'", WINDOWS_PROCESS_TREE_FUNCTIONS, "Stop-T3ProcessTree"].join(
    "\n",
  ),
];

export const windowsStopTreeArgs = (root: WindowsProcessTreeRoot): Array<string> => {
  const call = [
    root.pid,
    root.since,
    ...(root.created === undefined ? [] : [root.created.from, root.created.to]),
  ].join(" ");
  return WINDOWS_STOP_TREE_ARGS.map((arg, index) =>
    index === WINDOWS_STOP_TREE_ARGS.length - 1 ? `${arg} ${call}` : arg,
  );
};

/** Runs a spawn and pairs its handle with the root a stop of its tree needs. */
export const withWindowsTreeRoot = <A extends { readonly pid: number }, E, R>(
  spawn: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly handle: A; readonly root: WindowsProcessTreeRoot }, E, R> =>
  Effect.suspend(() => {
    const since = Date.now();
    return Effect.map(spawn, (handle) => ({
      handle,
      root: { pid: handle.pid, since, created: { from: since, to: Date.now() } },
    }));
  });

const STOP_TIMEOUT = Duration.seconds(30);
const STDERR_TAIL_CHARS = 4_096;

const stopFailed = (root: WindowsProcessTreeRoot, tag: PlatformError.SystemErrorTag, why: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "ChildProcess",
    method: "kill",
    pathOrDescriptor: root.pid,
    description: `Could not stop the process tree of ${root.pid}: ${why}`,
  });

export const stopWindowsProcessTree = Effect.fn("WindowsProcessTree.stop")(
  function* (root: WindowsProcessTreeRoot) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("powershell.exe", windowsStopTreeArgs(root), {
        stdin: "ignore",
        stdout: "ignore",
      }),
    );
    const [stderr, exitCode] = yield* Effect.all(
      [
        handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (tail, chunk: string) => (tail + chunk).slice(-STDERR_TAIL_CHARS),
          ),
        ),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* stopFailed(root, "Unknown", `PowerShell exited ${exitCode}: ${stderr.trim()}`);
    }
  },
  (effect, root) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: STOP_TIMEOUT,
        orElse: () =>
          Effect.fail(stopFailed(root, "TimedOut", "PowerShell did not finish within 30 s")),
      }),
    ),
);

/**
 * Ends each spawned process with its tree when its scope closes or it is killed, also after it
 * exited, as a process group does on POSIX. A stop starts PowerShell, so this suits spawners that
 * start few processes. An unreferenced process outlives its scope. A pipeline fails: its handle
 * reports only the last process, so what an earlier one left running would survive.
 */
export const endingWindowsTrees = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  platform !== "win32"
    ? spawner
    : ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          if (command._tag === "PipedCommand") {
            return yield* PlatformError.badArgument({
              module: "ChildProcess",
              method: "spawn",
              description:
                "endingWindowsTrees ends one process's tree; spawn a pipeline's stages one by one",
            });
          }
          const { handle, root } = yield* withWindowsTreeRoot(spawner.spawn(command));
          let referenced = true;
          const stopTree = stopWindowsProcessTree(root).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          yield* Effect.addFinalizer(() =>
            referenced ? Effect.ignore(stopTree, { log: "Error" }) : Effect.void,
          );
          return ChildProcessSpawner.makeHandle({
            ...handle,
            kill: (options) =>
              Effect.exit(handle.kill(options)).pipe(
                Effect.flatMap((killed) => Effect.andThen(stopTree, killed)),
              ),
            unref: handle.unref.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  referenced = false;
                }),
              ),
              Effect.map((reref) =>
                reref.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      referenced = true;
                    }),
                  ),
                ),
              ),
            ),
          });
        }),
      );
