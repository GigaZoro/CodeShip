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
  // kill is. Outputs left for each it saw not end as soon as it knows; the first failure goes in
  // $stop.failed, since a caller that assigned the output would hold those lines back.
  "function Stop-T3Processes($processes, $ticksOf, $stop) {",
  "  $told = @{}",
  "  foreach ($process in $processes) {",
  "    try { $process.Kill() } catch {",
  "      $why = $_; try { $gone = $process.HasExited } catch { $gone = $false }",
  "      if (-not $gone) {",
  "        if (-not $stop.failed) { $stop.failed = $why }",
  "        $told[$process.Id] = $true; 'left {0} {1}' -f $process.Id, $ticksOf[[long]$process.Id]",
  "      }",
  "    }",
  "  }",
  "  $wait = [Diagnostics.Stopwatch]::StartNew()",
  "  foreach ($process in $processes) {",
  "    $ms = 5000 - $wait.ElapsedMilliseconds; if ($ms -lt 0) { $ms = 0 }",
  "    try { $done = $process.WaitForExit($ms) } catch { $done = $false; if (-not $stop.failed) { $stop.failed = $_ } }",
  "    if (-not $done) {",
  "      if (-not $stop.failed) { $stop.failed = 'Process {0} still runs 5 s after its stop' -f $process.Id }",
  "      if (-not $told.ContainsKey($process.Id)) { 'left {0} {1}' -f $process.Id, $ticksOf[[long]$process.Id] }",
  "    }",
  "  }",
  "}",
  // Opens every target of a pass before it ends any, so a parent that ends with its child is still
  // held and what it started meanwhile is found. The sixth pass finds what started after the fifth
  // looked: the stop ends it but fails as unfinished, as on a target it may not open or end. Outputs
  // ended <ms> when -running finds the root gone, and left <pid> <ticks> once a target will not end.
  "function Stop-T3ProcessTree($root, $since, $from = $since, $to = [double]::PositiveInfinity, $ended = [double]::PositiveInfinity, [long[]]$left = @(), [switch]$running) {",
  `  $since -= ${CLOCK_SKEW_MS}; $from -= ${CLOCK_SKEW_MS}; $to += ${CLOCK_SKEW_MS}; $ended += ${CLOCK_SKEW_MS}`,
  "  $open = @{}; $ticksOf = @{}; $starts = New-Object System.Collections.ArrayList; $failed = $null",
  "  try {",
  "    for ($pass = 0; $pass -le 5; $pass++) {",
  "      $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
  "      $targets = if ($pass) { Get-T3Descendants $all $starts } else { Get-T3ProcessTree $all $root $since $from $to $ended $running.IsPresent }",
  "      if ($null -eq $targets) { 'ended {0}' -f (Ms ([DateTimeOffset]::UtcNow)); break }",
  // -left lists as pid and creation ticks what an earlier stop of the tree found but did not end,
  // perhaps once it had ended their parents; CIM still listing one with that start makes it and
  // what it started since targets.
  "      if (-not $pass) {",
  "        $carried = New-Object System.Collections.ArrayList",
  "        for ($i = 0; $i + 1 -lt $left.Count; $i += 2) {",
  "          foreach ($p in $all) {",
  "            if ($p.ProcessId -eq $left[$i] -and (Ticks $p.CreationDate) -eq $left[$i + 1]) {",
  "              $targets[$p.ProcessId] = $p.CreationDate; [void]$carried.Add(@($p.ProcessId, $left[$i + 1], [long]::MaxValue))",
  "            }",
  "          }",
  "        }",
  "        $below = Get-T3Descendants $all $carried",
  "        foreach ($id in @($below.Keys)) { $targets[$id] = $below[$id] }",
  "      }",
  "      if ($targets.Count -eq 0) { break }",
  // What the first pass found while the root was listed is the root's, so a stop that then cannot
  // open the root still ends it. It says when it saw the root gone, which the root had exited by,
  // so the caller's next walk counts only what the root started before then. A loop whose output
  // were assigned would hold these lines back until every target was opened.
  "      $new = [Collections.Generic.List[psobject]]::new()",
  "      foreach ($id in @($targets.Keys)) {",
  "        $ticksOf[[long]$id] = Ticks $targets[$id]",
  "        try { $process = Open-T3Process $id $targets[$id] } catch { if (-not $failed) { $failed = $_ }; 'left {0} {1}' -f $id, $ticksOf[[long]$id]; continue }",
  "        if ($process) { $open[$id] = $process; [void]$starts.Add(@($id, $ticksOf[[long]$id], [long]::MaxValue)); $new.Add($process) }",
  "        elseif ($running -and -not $pass -and $id -eq $root) { 'ended {0}' -f (Ms ([DateTimeOffset]::UtcNow)) }",
  "      }",
  "      if ($new.Count -and $pass -eq 5 -and -not $failed) { $failed = 'The tree of {0} still started processes after 5 passes' -f $root }",
  "      $stop = @{ failed = $null }",
  "      Stop-T3Processes $new $ticksOf $stop",
  "      if ($stop.failed -and -not $failed) { $failed = $stop.failed }",
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
  /**
   * When the root started; a process holding its pid outside this window is another process.
   * "unknown" trusts any holder of the pid, for a root whose start was never recorded.
   */
  readonly created: { readonly from: number; readonly to: number } | "unknown";
  /**
   * When the root's spawner first reported its exit. A process the walk then finds holding the
   * root's pid is another one, and the root started nothing after this. "running" is for a caller
   * that has not seen the root exit.
   */
  readonly ended: number | "running";
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
  ...(root.created === "unknown" ? [] : [root.created.from, root.created.to]),
  ...(root.ended === "running" ? [] : ["-ended", root.ended]),
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
  return (pid) => ({ pid, since, created: { from: since, to: Date.now() }, ended: "running" });
};

/** The root of a process whose spawner reported its exit just now, as on Node's `exit` event. */
export const endedWindowsTreeRoot = (root: WindowsProcessTreeRoot): WindowsProcessTreeRoot => ({
  ...root,
  ended: Date.now(),
});

const STOP_TIMEOUT = Duration.seconds(30);
/** How long a walk that saw a running root gone waits for its spawner to report the exit. */
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
 * What walks of one tree learned: as `<pid>,<ticks>`, what they found but did not end, and when the
 * first that saw a running root gone saw it so.
 */
interface WalkNotes {
  readonly left: Set<string>;
  goneAt: number | undefined;
}

/**
 * Runs on the spawner beneath `endingWindowsTrees`, so a stop never stops a tree of its own. The walk
 * also ends what `notes` says earlier walks left, and adds to them each line as it reads it, so a walk
 * cut short still passes on what it said.
 */
const walkWindowsTree = Effect.fn("WindowsProcessTree.stop")(
  function* (root: WindowsProcessTreeRoot, call: ReadonlyArray<string | number>, notes: WalkNotes) {
    const spawner = withoutWindowsTreeEnding(yield* ChildProcessSpawner.ChildProcessSpawner);
    const carried = [...notes.left].join(",");
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "powershell.exe",
        stopTreeArgs(carried === "" ? call : [...call, "-left", carried]),
        { stdin: "ignore" },
      ),
    );
    const said = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          const unended = /^left (\d+) (\d+)$/.exec(line.trim());
          const gone = /^ended (\d+)$/.exec(line.trim());
          if (unended !== null) notes.left.add(`${unended[1]},${unended[2]}`);
          if (gone !== null) notes.goneAt ??= Number(gone[1]);
        }),
      ),
    );
    const [, stderr, exitCode] = yield* Effect.all([said, tailOf(handle.stderr), handle.exitCode], {
      concurrency: "unbounded",
    });
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

const stopWindowsProcessTree = (
  root: WindowsProcessTreeRoot,
  notes: WalkNotes = { left: new Set(), goneAt: undefined },
) => walkWindowsTree(root, stopTreeCall(root), notes);

/**
 * Whether a handle's exit report says the process exited. A spawner fails `exitCode` with method
 * `exitCode` for an exit by a signal; another failure, such as a lost worker's, says nothing of it.
 */
const reportsExit = (exit: Exit.Exit<unknown, PlatformError.PlatformError>) =>
  Exit.isSuccess(exit) ||
  Exit.findErrorOption(exit).pipe(Option.exists((error) => error.reason.method === "exitCode"));

/**
 * Pairs a spawn's handle with a stop of its tree, shared while it runs and once it succeeded; a stop
 * after a failed one also ends what that one left. Later stops count the root's children only from
 * before the earlier of its reported exit and when a walk saw it gone; a walk that sees it gone waits
 * for that report, up to EXIT_REPORT_TIMEOUT, and walks again.
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
        const notes: WalkNotes = { left: new Set(), goneAt: undefined };
        let ended: number | undefined;
        const noteEnd = Effect.flatMap(Effect.exit(handle.exitCode), (exit) =>
          Effect.sync(() => {
            if (reportsExit(exit)) ended ??= Date.now();
          }),
        );
        const stopEnded = noteEnd.pipe(
          Effect.timeoutOption(EXIT_REPORT_TIMEOUT),
          Effect.flatMap(() => {
            const at = Math.min(ended ?? Infinity, notes.goneAt ?? Infinity);
            return stopWindowsProcessTree(at === Infinity ? root : { ...root, ended: at }, notes);
          }),
        );
        const stopRunning = Effect.flatMap(
          Effect.exit(walkWindowsTree(root, [...stopTreeCall(root), "-running"], notes)),
          (walked) => {
            if (notes.goneAt === undefined) return walked;
            return Exit.isSuccess(walked)
              ? stopEnded
              : Effect.andThen(Effect.ignore(stopEnded, { log: "Error" }), walked);
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
