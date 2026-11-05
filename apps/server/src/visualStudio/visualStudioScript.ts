/**
 * Windows PowerShell 5.1 script that drives Visual Studio through EnvDTE over COM. Node has
 * no COM, and powershell.exe ships with every Windows. Each command prints JSON lines;
 * a failure prints `{"error": "..."}` and exits 1.
 */
export const VISUAL_STUDIO_SCRIPT = String.raw`[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('status', 'select', 'eval', 'continue', 'watch', 'start', 'stop')]
  [string]$Command,

  [string]$Solution,
  [int]$TimeoutSec = 1800,
  [switch]$IncludeBreakpoints
)

$ErrorActionPreference = 'Stop'

$DesignMode = 1
$BreakMode = 2
$ModeNames = @{ 1 = 'design'; 2 = 'break'; 3 = 'run' }
# EnvDTE.dbgEventReason
$BreakReasons = @{
  1 = 'none'; 2 = 'go'; 3 = 'attach'; 4 = 'detach'; 5 = 'launch'; 6 = 'end'; 7 = 'stop'
  8 = 'step'; 9 = 'breakpoint'; 10 = 'exception-thrown'; 11 = 'exception-unhandled'
  12 = 'user-break'; 13 = 'context-switch'
}
$EvalTimeoutMs = 5000
$PollMs = 500
$ResumeSettleMs = 2000
$MaxFrames = 25
$MaxLocals = 30
$MaxValueLength = 300

if (-not ('VsDbgRot' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class VsDbgRot
{
    [DllImport("ole32.dll")] private static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable rot);
    [DllImport("ole32.dll")] private static extern int CreateBindCtx(int reserved, out IBindCtx ctx);

    public static Dictionary<string, object> FindDteInstances()
    {
        var found = new Dictionary<string, object>();
        IRunningObjectTable rot;
        IBindCtx ctx;
        IEnumMoniker monikers;
        Marshal.ThrowExceptionForHR(GetRunningObjectTable(0, out rot));
        Marshal.ThrowExceptionForHR(CreateBindCtx(0, out ctx));
        rot.EnumRunning(out monikers);
        var batch = new IMoniker[1];
        while (monikers.Next(1, batch, IntPtr.Zero) == 0)
        {
            string name;
            try { batch[0].GetDisplayName(ctx, null, out name); }
            // An entry that cannot name itself cannot be matched to Visual Studio either.
            catch (COMException) { continue; }
            if (!name.StartsWith("!VisualStudio.DTE.", StringComparison.Ordinal)) continue;
            object dte;
            if (rot.GetObject(batch[0], out dte) == 0) found[name] = dte;
        }
        return found;
    }
}

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVsDbgMessageFilter
{
    [PreserveSig] int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);
    [PreserveSig] int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);
    [PreserveSig] int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
}

// Visual Studio rejects COM calls while it is busy (building, showing a dialog).
// Retrying turns "Call was rejected by callee" into a short wait.
public class VsDbgMessageFilter : IVsDbgMessageFilter
{
    private const int ServerCallRetryLater = 2;
    private const int RetryAfterMs = 200;
    private const int GiveUpAfterMs = 30000;
    private const int WaitDefProcess = 2;

    [DllImport("ole32.dll")] private static extern int CoRegisterMessageFilter(IVsDbgMessageFilter newFilter, out IVsDbgMessageFilter oldFilter);

    public static bool Register()
    {
        IVsDbgMessageFilter old;
        return CoRegisterMessageFilter(new VsDbgMessageFilter(), out old) == 0;
    }

    public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo) { return 0; }

    public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType)
    {
        return rejectType == ServerCallRetryLater && tickCount < GiveUpAfterMs ? RetryAfterMs : -1;
    }

    public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType) { return WaitDefProcess; }
}
'@
}

# Lines go straight to stdout so a watch streams them as they happen.
function Write-Json($Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 6 -Compress
  # \u-escape non-ASCII so text survives whatever code page the console uses.
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Limit-Text([string]$Text) {
  if ($null -eq $Text -or $Text.Length -le $MaxValueLength) { return $Text }
  $Text.Substring(0, $MaxValueLength) + '...'
}

# The debugger shows strings C#-style: quoted, with \r\n and \\ escapes.
function ConvertFrom-DebuggerString([string]$Text) {
  if ($Text -notmatch '^".*"$') { return $Text }
  $inner = $Text.Substring(1, $Text.Length - 2)
  try { [regex]::Unescape($inner) } catch [System.ArgumentException] { $inner }
}

function Get-Instances {
  $found = [VsDbgRot]::FindDteInstances()
  $instances = @(foreach ($entry in $found.GetEnumerator()) {
      # SQL Server Management Studio registers the same DTE name; keep Visual Studio only.
      $process = Get-Process -Id ([int]($entry.Key -replace '^.*:', '')) -ErrorAction SilentlyContinue
      if (-not $process -or $process.ProcessName -ne 'devenv') { continue }
      $dte = $entry.Value
      [pscustomobject]@{
        Solution  = $dte.Solution.FullName
        Mode      = [int]$dte.Debugger.CurrentMode
        Dte       = $dte
      }
    })
  if ($Solution) {
    $instances = @($instances | Where-Object { $_.Solution.IndexOf($Solution, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  if ($instances.Count -gt 0) { return $instances }
  if ($Solution) { throw "No open Visual Studio solution matches '$Solution'." }
  if (Get-Process devenv -ErrorAction SilentlyContinue) {
    throw 'Visual Studio is running but T3.CodeShip cannot reach it. Visual Studio and T3.CodeShip must run at the same elevation: both as administrator, or neither.'
  }
  throw 'Visual Studio is not running on this machine.'
}

function Select-Instance {
  $instances = @(Get-Instances)
  if ($instances.Count -gt 1) {
    $debugging = @($instances | Where-Object { $_.Mode -ne $DesignMode })
    if ($debugging.Count -gt 0) { $instances = $debugging }
  }
  if ($instances.Count -gt 1) {
    $names = ($instances | ForEach-Object { $_.Solution }) -join '; '
    throw "Several Visual Studio windows match. Pass solution with part of the .sln path. Open: $names"
  }
  $instances[0]
}

function Get-Value($Debugger, [string]$Expr) {
  $result = $Debugger.GetExpression($Expr, $false, $EvalTimeoutMs)
  if ($result.IsValidValue) { ConvertFrom-DebuggerString $result.Value }
}

function Get-ExceptionInfo($Debugger) {
  $exception = $Debugger.GetExpression('$exception', $false, $EvalTimeoutMs)
  if (-not $exception.IsValidValue) { return $null }
  $info = [ordered]@{ type = $exception.Type }
  # ToString() and Message need a function evaluation, which the debugger can refuse;
  # _message is a plain field read.
  foreach ($expr in '$exception.ToString()', '$exception.Message', '$exception._message') {
    $details = Get-Value $Debugger $expr
    if ($details) { $info.details = $details; break }
  }
  $info
}

function Get-BreakInfo($Instance) {
  $debugger = $Instance.Dte.Debugger
  $mode = [int]$debugger.CurrentMode
  $info = [ordered]@{ solution = $Instance.Solution; mode = $ModeNames[$mode] }
  if ($mode -eq $DesignMode) { return $info }
  $process = $debugger.CurrentProcess
  if ($process) { $info.process = $process.Name }
  if ($mode -ne $BreakMode) { return $info }

  $reason = [int]$debugger.LastBreakReason
  $info.reason = if ($BreakReasons.ContainsKey($reason)) { $BreakReasons[$reason] } else { "$reason" }
  $info.exception = Get-ExceptionInfo $debugger
  $frame = $debugger.CurrentStackFrame
  # EnvDTE collections are 1-based.
  if ($frame) {
    $info.location = $frame.FunctionName
    $locals = $frame.Locals
    $info.locals = @(for ($i = 1; $i -le [Math]::Min($locals.Count, $MaxLocals); $i++) {
        $local = $locals.Item($i)
        [ordered]@{ name = $local.Name; type = $local.Type; value = Limit-Text $local.Value }
      })
  }
  $thread = $debugger.CurrentThread
  if ($thread) {
    $frames = $thread.StackFrames
    $info.stack = @(for ($i = 1; $i -le [Math]::Min($frames.Count, $MaxFrames); $i++) {
        $stackFrame = $frames.Item($i)
        "$($stackFrame.FunctionName) [$($stackFrame.Module)]"
      })
  }
  $info
}

function Assert-BreakMode($Debugger) {
  if ([int]$Debugger.CurrentMode -ne $BreakMode) {
    throw "Not paused: Visual Studio is in $($ModeNames[[int]$Debugger.CurrentMode]) mode."
  }
}

function Wait-LeaveBreak($Debugger) {
  $until = (Get-Date).AddMilliseconds($ResumeSettleMs)
  while ([int]$Debugger.CurrentMode -eq $BreakMode -and (Get-Date) -lt $until) {
    Start-Sleep -Milliseconds 50
  }
}

function Invoke-Watch($Instance) {
  $debugger = $Instance.Dte.Debugger
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $sawSession = $false
  $resumed = 0
  while ((Get-Date) -lt $deadline) {
    $mode = [int]$debugger.CurrentMode
    if ($mode -eq $DesignMode) {
      if ($sawSession) { Write-Json ([ordered]@{ event = 'ended'; resumed = $resumed }); return }
    }
    else {
      $sawSession = $true
    }
    if ($mode -eq $BreakMode) {
      $info = Get-BreakInfo $Instance
      if ($null -eq $info.exception -and -not $IncludeBreakpoints) {
        $info.Insert(0, 'event', 'paused')
        Write-Json $info
        return
      }
      $info.Insert(0, 'event', 'resumed')
      Write-Json $info
      $debugger.Go($false)
      $resumed++
      Wait-LeaveBreak $debugger
      continue
    }
    Start-Sleep -Milliseconds $PollMs
  }
  Write-Json ([ordered]@{ event = 'timeout'; resumed = $resumed })
}

try {
  if (-not [VsDbgMessageFilter]::Register()) {
    Write-Warning 'Could not register the COM retry filter (not an STA thread). Busy-IDE calls may fail.'
  }

  if ($Command -eq 'status') {
    foreach ($instance in Get-Instances) { Write-Json (Get-BreakInfo $instance) }
    exit 0
  }

  $instance = Select-Instance
  $debugger = $instance.Dte.Debugger
  switch ($Command) {
    'select' { Write-Json ([ordered]@{ solution = $instance.Solution; mode = $ModeNames[$instance.Mode] }) }
    'eval' {
      # Arrives on stdin, so quotes and leading dashes survive the command line.
      $Expression = (New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)).ReadToEnd().Trim()
      if (-not $Expression) { throw 'eval needs an expression.' }
      Assert-BreakMode $debugger
      $result = $debugger.GetExpression($Expression, $true, $EvalTimeoutMs)
      Write-Json ([ordered]@{
          expression = $Expression
          valid      = [bool]$result.IsValidValue
          type       = $result.Type
          value      = ConvertFrom-DebuggerString $result.Value
        })
    }
    'continue' {
      Assert-BreakMode $debugger
      $debugger.Go($false)
      Wait-LeaveBreak $debugger
      Write-Json (Get-BreakInfo $instance)
    }
    'watch' { Invoke-Watch $instance }
    'start' {
      if ($instance.Mode -ne $DesignMode) { throw 'Already debugging. Stop first.' }
      # Building first keeps the "There were build errors, continue?" dialog from blocking F5.
      $build = $instance.Dte.Solution.SolutionBuild
      $build.Build($true)
      if ($build.LastBuildInfo -ne 0) {
        throw "Build failed in $($build.LastBuildInfo) project(s). See the Error List in Visual Studio, or run dotnet build to read the errors."
      }
      $debugger.Go($false)
      Write-Json (Get-BreakInfo $instance)
    }
    'stop' {
      if ($instance.Mode -ne $DesignMode) { $debugger.Stop($true) }
      Write-Json (Get-BreakInfo $instance)
    }
  }
}
catch {
  Write-Json ([ordered]@{ error = $_.Exception.Message })
  exit 1
}
`;
