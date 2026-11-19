// @effect-diagnostics globalDate:off globalDateInEffect:off - The walk compares times with process creation times, which the system clock stamps.
/**
 * Ends a process and what it started on Windows, also after the process exited. Windows has no
 * process groups, and `taskkill /T` finds descendants only through a running leader, so what a
 * leader left running outlives it. This walks `Win32_Process` by `ParentProcessId`, which outlives
 * the parent, in PowerShell.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A child older than the parent it names belongs to an earlier holder of that pid, as does a root
 * created outside [from, to], give or take a second of clock skew, or seen after the first pass,
 * which ended it. The root's children count from its start and before another holder's; later
 * passes keep those bounds and stop what the last one's processes started as they ended.
 */
export const WINDOWS_PROCESS_TREE_FUNCTIONS = [
  "function Ms($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }",
  "function Get-T3ProcessTree($all, $root, $since, $from, $to, $before = [long]::MaxValue) {",
  "  $targets = @{}",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ms $holder.CreationDate",
  "    if ($made -ge $from -and $made -le $to) { $targets[$root] = $holder.CreationDate; if ($made -gt $since) { $since = $made } }",
  "    elseif ($made -lt $before) { $before = $made }",
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
  "        $seen[$child.ProcessId] = $true; $targets[$child.ProcessId] = $child.CreationDate",
  "        $queue.Enqueue(@($child.ProcessId, $made, [long]::MaxValue))",
  "      }",
  "    }",
  "  }",
  "  return @{ Targets = $targets; Since = $since; Before = $before }",
  "}",
  // Holds the process open from its start-time check to its end, so the pid cannot change hands in
  // between. The walk read the same start time to the microsecond, so a difference of one means
  // another process took the pid. Kill only begins the end. An ended target is no error, a running
  // one is; until the process is open, only the failure to open it tells, as its pid may be reused.
  "function Stop-T3Process($id, $created) {",
  "  $process = Get-Process -Id $id -ErrorAction SilentlyContinue",
  "  if (-not $process) { return }",
  "  $open = $false",
  "  try {",
  "    $null = $process.get_Handle(); $open = $true",
  "    $skew = ([DateTimeOffset]$process.get_StartTime()).UtcTicks - ([DateTimeOffset]$created).UtcTicks",
  "    if ([math]::Abs($skew) -ge 10) { return }",
  "    $process.Kill()",
  "    if (-not $process.WaitForExit(5000)) { throw ('Process {0} still runs 5 s after its stop' -f $id) }",
  "  } catch {",
  "    $ended = if ($open) { $process.HasExited } else { $_.Exception.InnerException -is [InvalidOperationException] }",
  "    if (-not $ended) { throw }",
  "  } finally { $process.Dispose() }",
  "}",
  "function Stop-T3ProcessTree($root, $since, $from = [double]::NegativeInfinity, $to = [double]::PositiveInfinity) {",
  "  $since -= 1000; $from -= 1000; $to += 1000; $before = [long]::MaxValue",
  "  for ($pass = 0; $pass -lt 5; $pass++) {",
  "    $walk = Get-T3ProcessTree @(Get-CimInstance Win32_Process -ErrorAction Stop) $root $since $from $to $before",
  "    if ($walk.Targets.Count -eq 0) { return }",
  "    $since = $walk.Since; $before = $walk.Before; $from = [double]::PositiveInfinity",
  "    foreach ($id in $walk.Targets.Keys) { Stop-T3Process $id $walk.Targets[$id] }",
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

/** Call just before a spawn; what it returns gives the process's root once its pid is known. */
export const windowsTreeRootFromNow = (): ((pid: number) => WindowsProcessTreeRoot) => {
  const since = Date.now();
  return (pid) => ({ pid, since, created: { from: since, to: Date.now() } });
};

/** Runs a spawn and pairs its handle with the root a stop of its tree needs. */
export const withWindowsTreeRoot = <A extends { readonly pid: number }, E, R>(
  spawn: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly handle: A; readonly root: WindowsProcessTreeRoot }, E, R> =>
  Effect.suspend(() => {
    const rootOf = windowsTreeRootFromNow();
    return Effect.map(spawn, (handle) => ({ handle, root: rootOf(handle.pid) }));
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

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const beneath = new WeakMap<Spawner, Spawner>();

/** The spawner beneath `endingWindowsTrees`, for code that stops its processes' trees itself. */
export const withoutWindowsTreeEnding = (spawner: Spawner): Spawner =>
  beneath.get(spawner) ?? spawner;

/** Runs on the spawner beneath `endingWindowsTrees`, so a stop never stops a tree of its own. */
export const stopWindowsProcessTree = Effect.fn("WindowsProcessTree.stop")(
  function* (root: WindowsProcessTreeRoot) {
    const spawner = withoutWindowsTreeEnding(yield* ChildProcessSpawner.ChildProcessSpawner);
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
 * A function that starts a stop of a tree at once, for a Node callback such as a child's `exit`, and
 * returns its completion, which never rejects: a failure is logged. The stop outlives the caller's
 * scope, so code that ends with the server awaits it.
 */
export const windowsTreeStopper = Effect.map(
  Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
  (context) => {
    const runPromise = Effect.runPromiseWith(context);
    return (root: WindowsProcessTreeRoot): Promise<void> =>
      runPromise(stopWindowsProcessTree(root).pipe(Effect.ignoreCause({ log: "Error" })));
  },
);

/**
 * When `endingWindowsTrees` stops a tree, which starts PowerShell. `always`: on a kill or the scope's
 * close, for an agent's CLI. `leftBehind`: on a kill, a close while it runs or by interruption, or a
 * close with a begun read of its output unended, as when a leftover holds that pipe; a command that
 * exits and closes its output costs no walk.
 */
export type WindowsTreeEnding = "always" | "leftBehind";

/**
 * Ends spawned processes with their trees on Windows, also after they exited, as a process group
 * does on POSIX, when `ending` says to. Wrapping a wrapped spawner replaces its policy, so one
 * process never costs two walks. An unreferenced process outlives its scope. A pipeline fails: its
 * handle reports only the last process, so what an earlier one left running would survive.
 */
export const endingWindowsTrees = (
  spawner: Spawner,
  platform: NodeJS.Platform,
  ending: WindowsTreeEnding = "always",
): Spawner => {
  if (platform !== "win32") return spawner;
  const inner = withoutWindowsTreeEnding(spawner);
  const wrapped = ChildProcessSpawner.make(
    Effect.fnUntraced(function* (command) {
      if (command._tag === "PipedCommand") {
        return yield* PlatformError.badArgument({
          module: "ChildProcess",
          method: "spawn",
          description:
            "endingWindowsTrees ends one process's tree; spawn a pipeline's stages one by one",
        });
      }
      const { handle, root } = yield* withWindowsTreeRoot(inner.spawn(command));
      let referenced = true;
      let unendedReads = 0;
      // A kill and the scope's close share one walk.
      const stopTree = yield* Effect.cached(
        stopWindowsProcessTree(root).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, inner),
        ),
      );
      // The leader ends first, so its exit is known before the inner spawner's release looks.
      const kill = (options?: ChildProcess.KillOptions) =>
        Effect.exit(handle.kill(options)).pipe(
          Effect.flatMap((killed) => Effect.andThen(stopTree, killed)),
        );
      yield* Effect.addFinalizer((exit) =>
        Effect.gen(function* () {
          if (!referenced) return;
          if (yield* handle.isRunning) return yield* kill();
          if (ending === "always" || Exit.hasInterrupts(exit) || unendedReads > 0) {
            yield* stopTree;
          }
        }).pipe(Effect.ignore({ log: "Error" })),
      );
      const read = <E>(output: Stream.Stream<Uint8Array, E>) =>
        Stream.suspend(() => {
          unendedReads++;
          return Stream.onEnd(
            output,
            Effect.sync(() => {
              unendedReads--;
            }),
          );
        });
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdout: read(handle.stdout),
        stderr: read(handle.stderr),
        all: read(handle.all),
        getOutputFd: (fd) => read(handle.getOutputFd(fd)),
        kill,
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
  beneath.set(wrapped, inner);
  return wrapped;
};
