# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

## Collection cost

The native child owns sampling and bounded in-memory history. It samples on a timer
only while diagnostics has live subscribers. With none, the server sends a sample
interval of 0 and the child samples only on request, so an idle server never walks
the process table. The exception is OTLP metrics export: a server exporting metrics
requests one sample a minute and exports process totals by group
([`ProcessGroupMetrics`](../../apps/server/src/resourceTelemetry/ProcessGroupMetrics.ts)),
because the user asked for continuous telemetry. Groups are a fixed set named after
the server's direct children, never process IDs or threads, so the series count
stays bounded as agents come and go. History therefore covers only time with a live
subscriber, plus on-demand and export samples. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.

## Memory admission

Automated heavy starts pass one gate,
[`MemoryAdmission`](../../apps/server/src/resourceTelemetry/MemoryAdmission.ts). These are
scheduled occurrences, `delegate_task` children (including another machine's child) and an
agent's emulator boot. A new automated start path must call it too. Nothing else bounds how
much starts at once across tasks, and the 24 GB Mac panicked with each task within its own
limit. Chats the user starts are never gated.

- macOS judges the compressor's share of physical memory plus the kernel pressure level.
  Compressed memory is not used memory: a normal day reads about 0.31 and must keep
  starting work. The pressure level alone reads normal between warn readings, even at the
  panic, so only the share holds the gate shut.
- A probe that fails or times out admits the start. Linux without `MemAvailable` admits
  too, because free memory leaves out the reclaimable page cache.
- Readings go stale. The scheduler judges again after a run condition answers, and after
  a prompt-file read that waited for the network. That run already shows as running, so a
  shortage there fails it instead of skipping it.

## CPU admission

`t3_command_run` also holds a new command while the CPUs are saturated
([`CpuAdmission`](../../apps/server/src/resourceTelemetry/CpuAdmission.ts)): memory had room
when 18 commands, mostly test suites, started together and left a 12-core machine at 1.00 busy
per core, slow enough to fail the timeouts they were guarded by.

- The reading is the busy share per core over a half-second window of `os.cpus()` times,
  against the 0.95 limit Machine health's `cpu-overload` check uses. A reading stands for two
  seconds so a burst of commands shares it.
- CodeShip starts commands at the server's nice level plus `AGENT_NICE_INCREMENT`, so its
  own commands can compete for niced CPU time. When a potentially saturated Linux host reports
  niced time, admission measures which threads ran below an incoming command's priority over a
  second sample window. Linux accounts nice per thread and charges kernel time separately.
  Only observed lower-priority user time is deducted. Unattributed time stays busy, including
  when thread readings are unavailable. When at least 10% of host CPU time was niced, the
  queue message gives both the total niced share and the share deducted from busy time.
- The hold applies only while another `t3_command_run` command of this server is running. With
  none running the first queued command starts whatever the reading: other programs can keep
  the CPUs busy for hours, and a gate that waited for them would starve every command.
- `delegate_task` and the chat-resume queue do not use it. A delegate refuses on memory instead
  of queueing, so a CPU refusal would fail a task that only needs to wait out a burst. The
  resume queue already starts one run at a time, and what a run does on the CPU goes through
  commands.
