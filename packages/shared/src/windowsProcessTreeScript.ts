// @effect-diagnostics globalDate:off - The walk compares times with process creation times, which the system clock stamps.
/**
 * The PowerShell walk that ends a Windows process tree, and the arguments that run it. It imports
 * nothing, so standalone Node tooling, such as the landing turn's scripts, loads it without the
 * Effect runtime that windowsProcessTree.ts runs it with.
 */
/**
 * How far the start the system stamps on a process may lie outside the times Node read around its
 * spawn: Windows stamps at its clock's last tick, up to 16 ms early, and Node's clock may trail the
 * system's by as much. More would let a process that took the root's pid soon after pass for it, or
 * a child the pid's last holder started just before the spawn pass for an ended root's.
 */
const WINDOWS_PROCESS_CLOCK_SKEW_MS = 100;

/**
 * A child older than the parent it names, or the root's child created before from, is an earlier
 * holder's. A holder of the root's pid created outside [from, to], or once the root ended, is another
 * process. A recorded later holder bounds the root's children even after that holder exits.
 * Later passes walk only from processes the stop holds open, whose pids stay theirs.
 */
const WINDOWS_PROCESS_TREE_FUNCTIONS = [
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
  "function Get-T3ProcessTree($all, $root, $since, $from, $to, $ended = [double]::PositiveInfinity, $running = $false, $later = [double]::PositiveInfinity) {",
  "  $earliest = if ($from -gt $since) { $from } else { $since }",
  "  $after = [DateTimeOffset]::FromUnixTimeMilliseconds($earliest).UtcTicks; $mine = $null",
  "  $limit = if ($later -lt $ended) { $later } else { $ended }",
  "  $before = if ([double]::IsInfinity($limit)) { [long]::MaxValue } else { [DateTimeOffset]::FromUnixTimeMilliseconds($limit).UtcTicks }",
  "  $holder = $all | Where-Object { $_.ProcessId -eq $root } | Select-Object -First 1",
  "  if ($holder) {",
  "    $made = Ticks $holder.CreationDate; $ms = Ms $holder.CreationDate",
  "    $isRoot = [double]::IsInfinity($limit) -and $ms -ge $from -and $ms -le $to",
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
  "function Stop-T3ProcessTree($root, $since, $from = $since, $to = [double]::PositiveInfinity, $ended = [double]::PositiveInfinity, [long[]]$left = @(), [switch]$running, $later = [double]::PositiveInfinity) {",
  `  $since -= ${WINDOWS_PROCESS_CLOCK_SKEW_MS}; $from -= ${WINDOWS_PROCESS_CLOCK_SKEW_MS}; $to += ${WINDOWS_PROCESS_CLOCK_SKEW_MS}; $ended += ${WINDOWS_PROCESS_CLOCK_SKEW_MS}`,
  "  $open = @{}; $ticksOf = @{}; $starts = New-Object System.Collections.ArrayList; $failed = $null",
  "  try {",
  "    for ($pass = 0; $pass -le 5; $pass++) {",
  "      $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
  "      $targets = if ($pass) { Get-T3Descendants $all $starts } else { Get-T3ProcessTree $all $root $since $from $to $ended $running.IsPresent $later }",
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
  /** When a later holder of the root's pid was observed to start. */
  readonly later?: number;
}

/**
 * PowerShell's arguments that stop a tree once its root is appended to the last one as
 * ` <pid> <since> [<from> <to>] [-ended <ended>] [-later <later>]`, for code that cannot import this module. They
 * hold no double quote, which Node would escape.
 */
const WINDOWS_STOP_TREE_ARGS: ReadonlyArray<string> = [
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
  ...(root.later === undefined ? [] : ["-later", root.later]),
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
