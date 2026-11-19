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
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * How far the start the system stamps on a process may lie outside the times Node read around its
 * spawn: Windows stamps at its clock's last tick, up to 16 ms early, and Node's clock may trail the
 * system's by as much. More would let a process that took the root's pid soon after pass for it, or
 * a child the pid's last holder started just before the spawn pass for an ended root's.
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
  "function Get-T3ProcessTree($all, $root, $since, $from, $to, $ended = [double]::PositiveInfinity, $running = $false) {",
  "  $earliest = if ($from -gt $since) { $from } else { $since }",
  "  $after = [DateTimeOffset]::FromUnixTimeMilliseconds($earliest).UtcTicks; $mine = $null",
  "  $before = if ([double]::IsInfinity($ended)) { [long]::MaxValue } else { [DateTimeOffset]::FromUnixTimeMilliseconds($ended).UtcTicks }",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ticks $holder.CreationDate; $ms = Ms $holder.CreationDate",
  "    $isRoot = [double]::IsInfinity($ended) -and $ms -ge $from -and $ms -le $to",
  "    if ($isRoot) { $mine = $holder; if ($made -gt $after) { $after = $made } } elseif ($made -lt $before) { $before = $made }",
  "  }",
  "  if ($running -and -not $mine) { return }",
  "  $targets = Get-T3Descendants $all @(,@($root, $after, $before))",
  "  if ($mine) { $targets[$mine.ProcessId] = $mine.CreationDate }",
  "  $targets",
  "}",
  // Holds the process open until the stop returns, so its pid cannot change hands. CIM cuts start
  // times to the microsecond, so the walk saw this process only if its own start cuts to the same
  // one. Until it is open, its pid may name another process, which HasExited would ask about, so a
  // failure to open it means it ended, unless CIM still lists its pid with the start the walk saw.
  "function Open-T3Process($id, $created) {",
  "  $process = Get-Process -Id $id -ErrorAction SilentlyContinue",
  "  if (-not $process) { return }",
  "  $mine = $false",
  "  try {",
  "    $null = $process.get_Handle(); $made = Ticks $process.get_StartTime()",
  "    $mine = $made - $made % 10 -eq (Ticks $created)",
  "  } catch {",
  "    $why = $_; $e = $why.Exception.GetBaseException()",
  "    if (-not ($e -is [InvalidOperationException] -or ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 87))) {",
  "      $still = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $id) -ErrorAction Stop | Where-Object { $_.ProcessId -eq $id -and (Ticks $_.CreationDate) -eq (Ticks $created) }",
  "      if ($still) { throw $why }",
  "    }",
  "  } finally { if (-not $mine) { $process.Dispose() } }",
  "  if ($mine) { $process }",
  "}",
  // Ends every process before it waits for any, so one slow to end holds up no other, and goes on
  // past a failure. A process that ended first is no error; one still running 5 s after the last
  // kill is. Adds the pid of each it did not see end to $unended and outputs the first failure.
  "function Stop-T3Processes($processes, $unended) {",
  "  $failed = $null",
  "  foreach ($process in $processes) {",
  "    try { $process.Kill() } catch {",
  "      $why = $_; try { $gone = $process.HasExited } catch { $gone = $false }",
  "      if (-not ($gone -or $failed)) { $failed = $why }",
  "    }",
  "  }",
  "  $wait = [Diagnostics.Stopwatch]::StartNew()",
  "  foreach ($process in $processes) {",
  "    $ms = 5000 - $wait.ElapsedMilliseconds; if ($ms -lt 0) { $ms = 0 }",
  "    try { $done = $process.WaitForExit($ms) } catch { $done = $false; if (-not $failed) { $failed = $_ } }",
  "    if (-not $done) {",
  "      [void]$unended.Add([long]$process.Id)",
  "      if (-not $failed) { $failed = 'Process {0} still runs 5 s after its stop' -f $process.Id }",
  "    }",
  "  }",
  "  $failed",
  "}",
  // Opens every target of a pass before it ends any, so a parent that ends with its child is still
  // held and what it started meanwhile is found. What the sixth pass finds was started after the
  // fifth looked: the stop ends it but fails as unfinished, as on a target it may not open or end.
  // Outputs ended when -running and the root is gone, and left <pid> <ticks> for each it did not end.
  "function Stop-T3ProcessTree($root, $since, $from = $since, $to = [double]::PositiveInfinity, $ended = [double]::PositiveInfinity, [long[]]$left = @(), [switch]$running) {",
  `  $since -= ${CLOCK_SKEW_MS}; $from -= ${CLOCK_SKEW_MS}; $to += ${CLOCK_SKEW_MS}; $ended += ${CLOCK_SKEW_MS}`,
  "  $open = @{}; $ticksOf = @{}; $starts = New-Object System.Collections.ArrayList; $failed = $null",
  "  try {",
  "    for ($pass = 0; $pass -le 5; $pass++) {",
  "      $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
  "      $targets = if ($pass) { Get-T3Descendants $all $starts } else { Get-T3ProcessTree $all $root $since $from $to $ended $running.IsPresent }",
  "      if ($null -eq $targets) { 'ended'; break }",
  // -left lists as pid and creation ticks what an earlier stop of the tree found but did not end,
  // perhaps once it had ended their parents; CIM still listing one with that start makes it a target.
  "      if (-not $pass) {",
  "        for ($i = 0; $i + 1 -lt $left.Count; $i += 2) {",
  "          foreach ($p in $all) { if ($p.ProcessId -eq $left[$i] -and (Ticks $p.CreationDate) -eq $left[$i + 1]) { $targets[$p.ProcessId] = $p.CreationDate } }",
  "        }",
  "      }",
  "      if ($targets.Count -eq 0) { break }",
  "      $lost = $false; $unended = New-Object System.Collections.ArrayList",
  "      $new = @(foreach ($id in @($targets.Keys)) {",
  "        $ticksOf[[long]$id] = Ticks $targets[$id]",
  "        try { $process = Open-T3Process $id $targets[$id] } catch { if (-not $failed) { $failed = $_ }; [void]$unended.Add([long]$id); continue }",
  "        if ($process) { $open[$id] = $process; [void]$starts.Add(@($id, $ticksOf[[long]$id], [long]::MaxValue)); $process }",
  "        elseif ($running -and -not $pass -and $id -eq $root) { $lost = $true }",
  "      })",
  // What the first pass found while the root was listed is the root's, so a stop that then cannot
  // open the root still ends it; the caller walks again from the root's exit for what came after.
  "      if ($lost) { 'ended' }",
  "      if ($new.Count -and $pass -eq 5 -and -not $failed) { $failed = 'The tree of {0} still started processes after 5 passes' -f $root }",
  "      $stopped = Stop-T3Processes $new $unended; if ($stopped -and -not $failed) { $failed = $stopped }",
  "      foreach ($id in $unended) { 'left {0} {1}' -f $id, $ticksOf[$id] }",
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

const stopTreeCall = (root: WindowsProcessTreeRoot): Array<string | number> => [
  root.pid,
  root.since,
  ...(root.created === undefined ? [] : [root.created.from, root.created.to]),
  ...(root.ended === undefined ? [] : ["-ended", root.ended]),
];

const stopTreeArgs = (call: ReadonlyArray<string | number>): Array<string> =>
  WINDOWS_STOP_TREE_ARGS.map((arg, index) =>
    index === WINDOWS_STOP_TREE_ARGS.length - 1 ? `${arg} ${call.join(" ")}` : arg,
  );

export const windowsStopTreeArgs = (root: WindowsProcessTreeRoot): Array<string> =>
  stopTreeArgs(stopTreeCall(root));

/**
 * Call just before a spawn; what it returns gives the process's root once its pid is known. What the
 * spawner does before the process starts, such as checking its cwd, widens by its length the time in
 * which a child the pid's last holder started counts for an ended root's.
 */
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
/** A walk that found the root gone waits this long for its spawner to report the exit. */
const EXIT_REPORT_TIMEOUT = Duration.seconds(5);
const OUTPUT_TAIL_CHARS = 4_096;

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

const tailOf = <E>(output: Stream.Stream<Uint8Array, E>) =>
  output.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (tail, chunk: string) => (tail + chunk).slice(-OUTPUT_TAIL_CHARS),
    ),
  );

/**
 * Runs on the spawner beneath `endingWindowsTrees`, so a stop never stops a tree of its own. `left`
 * holds, as `<pid>,<ticks>`, what earlier walks of the tree found but did not end; the walk ends
 * those too and adds what it did not end as it reports it. Succeeds with whether the walk found a
 * running root gone, and its failure once it ran.
 */
const walkWindowsTree = Effect.fn("WindowsProcessTree.stop")(
  function* (
    root: WindowsProcessTreeRoot,
    call: ReadonlyArray<string | number>,
    left: Set<string>,
  ) {
    const spawner = withoutWindowsTreeEnding(yield* ChildProcessSpawner.ChildProcessSpawner);
    const carried = [...left].join(",");
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "powershell.exe",
        stopTreeArgs(carried === "" ? call : [...call, "-left", carried]),
        { stdin: "ignore" },
      ),
    );
    let gone = false;
    const said = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          const unended = /^left (\d+) (\d+)$/.exec(line.trim());
          if (unended !== null) left.add(`${unended[1]},${unended[2]}`);
          else if (line.trim() === "ended") gone = true;
        }),
      ),
    );
    const [, stderr, exitCode] = yield* Effect.all([said, tailOf(handle.stderr), handle.exitCode], {
      concurrency: "unbounded",
    });
    const failure =
      exitCode === 0
        ? undefined
        : stopFailed(root, "Unknown", `PowerShell exited ${exitCode}: ${stderr.trim()}`);
    return { gone, failure };
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

const stopWindowsProcessTree = (root: WindowsProcessTreeRoot, left = new Set<string>()) =>
  Effect.flatMap(walkWindowsTree(root, stopTreeCall(root), left), ({ failure }) =>
    failure === undefined ? Effect.void : Effect.fail(failure),
  );

/**
 * Whether a handle's exit report says the process exited. A spawner fails `exitCode` with method
 * `exitCode` for an exit by a signal; another failure, such as a lost worker's, says nothing of it.
 */
const reportsExit = (exit: Exit.Exit<unknown, PlatformError.PlatformError>) =>
  Exit.isSuccess(exit) ||
  Exit.findErrorOption(exit).pipe(Option.exists((error) => error.reason.method === "exitCode"));

/**
 * Pairs a spawn's handle with a stop of its tree, shared while it runs and once it succeeded; a stop
 * after a failed one also ends what that one left. The handle's exit report bounds the root's children
 * in every later stop. A walk that finds a running root gone awaits that report and walks again.
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
    return Effect.flatMap(spawn, (handle) =>
      Effect.gen(function* () {
        const root = rootOf(handle.pid);
        const left = new Set<string>();
        let ended: number | undefined;
        const noteEnd = Effect.flatMap(Effect.exit(handle.exitCode), (exit) =>
          Effect.sync(() => {
            if (reportsExit(exit)) ended ??= Date.now();
            return ended;
          }),
        );
        const stopEnded = noteEnd.pipe(
          Effect.timeoutOrElse({
            duration: EXIT_REPORT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                stopFailed(
                  root,
                  "TimedOut",
                  "the walk found it gone, yet it reported no exit in 5 s",
                ),
              ),
          }),
          Effect.flatMap((at) =>
            stopWindowsProcessTree(at === undefined ? root : { ...root, ended: at }, left),
          ),
        );
        const stopRunning = Effect.flatMap(
          walkWindowsTree(root, [...stopTreeCall(root), "-running"], left),
          ({ gone, failure }) => {
            if (failure === undefined) return gone ? stopEnded : Effect.void;
            const failed = Effect.fail(failure);
            return gone
              ? Effect.andThen(Effect.ignore(stopEnded, { log: "Error" }), failed)
              : failed;
          },
        );
        const stopTree = yield* Effect.cachedWithTTL(
          Effect.flatMap(handle.isRunning, (running) => (running ? stopRunning : stopEnded)),
          (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
        );
        yield* Effect.forkDetach(noteEnd, { startImmediately: true });
        return { handle, stopTree };
      }),
    );
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
      const stopTree = spawned.stopTree.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, inner),
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
