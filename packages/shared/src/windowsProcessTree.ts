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
 * How far the start the system stamps on a process may lie outside the times Node read around its
 * spawn: Windows stamps at its clock's last tick, up to 16 ms early, and Node's clock may trail the
 * system's by as much. More would let a process that took the root's pid soon after pass for it.
 */
const CLOCK_SKEW_MS = 100;

/**
 * A child older than the parent it names, or the root's child created before from, is an earlier
 * holder's. A holder of the root's pid created outside [from, to], or once the root ended, is another
 * process; the root's children count only from before its start and the root's end, each bound with
 * CLOCK_SKEW_MS. Later passes walk only from processes the stop holds open, whose pids stay theirs.
 */
export const WINDOWS_PROCESS_TREE_FUNCTIONS = [
  "function Ms($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() }",
  "function Ticks($d) { ([DateTimeOffset]$d).UtcTicks }",
  "function Get-T3Descendants($all, $starts) {",
  "  $targets = @{}",
  "  $queue = New-Object System.Collections.Queue",
  "  $seen = @{}",
  "  foreach ($start in $starts) { $queue.Enqueue($start); $seen[$start[0]] = $true }",
  "  while ($queue.Count -gt 0) {",
  "    $id, $after, $limit = $queue.Dequeue()",
  "    foreach ($child in $all) {",
  "      if ($child.ParentProcessId -ne $id -or $seen.ContainsKey($child.ProcessId)) { continue }",
  "      $made = Ticks $child.CreationDate",
  "      if ($made -ge $after -and $made -lt $limit) {",
  "        $seen[$child.ProcessId] = $true; $targets[$child.ProcessId] = $child.CreationDate",
  "        $queue.Enqueue(@($child.ProcessId, $made, [long]::MaxValue))",
  "      }",
  "    }",
  "  }",
  "  $targets",
  "}",
  "function Get-T3ProcessTree($all, $root, $since, $from, $to, $ended = [double]::PositiveInfinity) {",
  "  $earliest = if ($from -gt $since) { $from } else { $since }",
  "  $after = [DateTimeOffset]::FromUnixTimeMilliseconds($earliest).UtcTicks; $mine = $null",
  "  $before = if ([double]::IsInfinity($ended)) { [long]::MaxValue } else { [DateTimeOffset]::FromUnixTimeMilliseconds($ended).UtcTicks }",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ticks $holder.CreationDate; $ms = Ms $holder.CreationDate",
  "    $isRoot = [double]::IsInfinity($ended) -and $ms -ge $from -and $ms -le $to",
  "    if ($isRoot) { $mine = $holder; if ($made -gt $after) { $after = $made } } elseif ($made -lt $before) { $before = $made }",
  "  }",
  "  $targets = Get-T3Descendants $all @(,@($root, $after, $before))",
  "  if ($mine) { $targets[$mine.ProcessId] = $mine.CreationDate }",
  "  $targets",
  "}",
  // Holds the process open until the stop returns, so its pid cannot change hands. CIM cuts start
  // times to the microsecond, so the walk saw this process only if its own start time cuts to the
  // same one. Until it is open, only the failure to open it tells that it ended: its pid may
  // already name another process, which HasExited would ask about.
  "function Open-T3Process($id, $created) {",
  "  $process = Get-Process -Id $id -ErrorAction SilentlyContinue",
  "  if (-not $process) { return }",
  "  $mine = $false",
  "  try {",
  "    $null = $process.get_Handle(); $made = Ticks $process.get_StartTime()",
  "    $mine = $made - $made % 10 -eq (Ticks $created)",
  "  } catch {",
  "    $e = $_.Exception.GetBaseException()",
  "    if (-not ($e -is [InvalidOperationException] -or ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 87))) { throw }",
  "  } finally { if (-not $mine) { $process.Dispose() } }",
  "  if ($mine) { $process }",
  "}",
  // Ends every process before it waits for any, so one slow to end holds up no other, and goes on
  // past a failure. A process that ended first is no error; one still running 5 s after the last
  // kill is. Outputs the first failure.
  "function Stop-T3Processes($processes) {",
  "  $failed = $null",
  "  foreach ($process in $processes) {",
  "    try { $process.Kill() } catch {",
  "      $why = $_; try { $gone = $process.HasExited } catch { $gone = $false }",
  "      if (-not ($gone -or $failed)) { $failed = $why }",
  "    }",
  "  }",
  "  $wait = [Diagnostics.Stopwatch]::StartNew()",
  "  foreach ($process in $processes) {",
  "    $left = 5000 - $wait.ElapsedMilliseconds; if ($left -lt 0) { $left = 0 }",
  "    try { $done = $process.WaitForExit($left) } catch { $done = $true; if (-not $failed) { $failed = $_ } }",
  "    if (-not ($done -or $failed)) { $failed = 'Process {0} still runs 5 s after its stop' -f $process.Id }",
  "  }",
  "  $failed",
  "}",
  // Opens every target of a pass before it ends any, so a parent that ends with its child is still
  // held and what it started meanwhile is found. What the sixth pass finds was started after the
  // fifth looked: the stop ends it but fails as unfinished, as on a target it may not open or end.
  "function Stop-T3ProcessTree($root, $since, $from = $since, $to = [double]::PositiveInfinity, $ended = [double]::PositiveInfinity) {",
  `  $since -= ${CLOCK_SKEW_MS}; $from -= ${CLOCK_SKEW_MS}; $to += ${CLOCK_SKEW_MS}; $ended += ${CLOCK_SKEW_MS}`,
  "  $open = @{}; $starts = New-Object System.Collections.ArrayList; $failed = $null",
  "  try {",
  "    for ($pass = 0; $pass -le 5; $pass++) {",
  "      $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
  "      $targets = if ($pass) { Get-T3Descendants $all $starts } else { Get-T3ProcessTree $all $root $since $from $to $ended }",
  "      if ($targets.Count -eq 0) { break }",
  "      $new = @(foreach ($id in @($targets.Keys)) {",
  "        try { $process = Open-T3Process $id $targets[$id] } catch { if (-not $failed) { $failed = $_ }; continue }",
  "        if ($process) { $open[$id] = $process; [void]$starts.Add(@($id, (Ticks $targets[$id]), [long]::MaxValue)); $process }",
  "      })",
  "      if ($new.Count -and $pass -eq 5 -and -not $failed) { $failed = 'The tree of {0} still started processes after 5 passes' -f $root }",
  "      $stopped = Stop-T3Processes $new; if ($stopped -and -not $failed) { $failed = $stopped }",
  "    }",
  "    if ($failed) { throw $failed }",
  "  } finally { foreach ($process in $open.Values) { $process.Dispose() } }",
  "}",
].join("\n");

/** Times are milliseconds since the epoch, read from the wall clock the system stamps processes with. */
export interface WindowsProcessTreeRoot {
  readonly pid: number;
  /** Nothing in the tree started before this. */
  readonly since: number;
  /** When the root started; a process holding its pid outside this window is another process. */
  readonly created?: { readonly from: number; readonly to: number };
  /**
   * When the root's spawner first reported its exit. A process the walk then finds holding the
   * root's pid is another one, and the root started nothing after this.
   */
  readonly ended?: number;
}

/**
 * PowerShell's arguments that stop a tree once its root is appended to the last one as
 * ` <pid> <since> [<from> <to>] [-ended <ended>]`, for code that cannot import this module. They
 * hold no double quote, which Node would escape.
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
    ...(root.ended === undefined ? [] : ["-ended", root.ended]),
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

/** The root of a process whose spawner reported its exit just now, as on Node's `exit` event. */
export const endedWindowsTreeRoot = (root: WindowsProcessTreeRoot): WindowsProcessTreeRoot => ({
  ...root,
  ended: Date.now(),
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
const stopWindowsProcessTree = Effect.fn("WindowsProcessTree.stop")(
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
 * Runs a spawn and pairs its handle with a stop of its tree. A watch in the spawn's scope notes when
 * the handle reports the exit, so a stop long after it still bounds the root's children by that time.
 */
export const withWindowsTreeStop = <
  A extends Pick<ChildProcessSpawner.ChildProcessHandle, "pid" | "exitCode" | "isRunning">,
  E,
  R,
>(
  spawn: Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const rootOf = windowsTreeRootFromNow();
    return Effect.flatMap(spawn, (handle) => {
      const root = rootOf(handle.pid);
      let ended: number | undefined;
      const noteEnd = Effect.sync(() => (ended ??= Date.now()));
      const stopTree = Effect.flatMap(handle.isRunning, (running) =>
        running
          ? stopWindowsProcessTree(root)
          : Effect.flatMap(noteEnd, (at) => stopWindowsProcessTree({ ...root, ended: at })),
      );
      return Effect.as(
        Effect.forkScoped(Effect.andThen(Effect.exit(handle.exitCode), noteEnd), {
          startImmediately: true,
        }),
        { handle, stopTree },
      );
    });
  });

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
      const spawned = yield* withWindowsTreeStop(inner.spawn(command));
      const { handle } = spawned;
      let referenced = true;
      let unendedReads = 0;
      // A kill and the scope's close share one walk.
      const stopTree = yield* Effect.cached(
        spawned.stopTree.pipe(
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
