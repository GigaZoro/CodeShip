# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. Upgrading
that launcher requires a local service update.

Within one protocol, launcher fixes arrive with updates: at start and after a
commit, the launcher the service manager started hands the service to the active
release's launcher. That delegate hands the service back for the next hand-off
instead of starting a launcher of its own, so a service runs at most two. The
service manager keeps starting the launcher it was installed with, and one from
before hand-back nests a launcher at every update, so its service runs a third
until a local service update reinstalls it. A delegate that fails can leave its
server running, even mid-migration, and only the service manager stops every
process of the service. The launcher above it therefore exits 0, which every
launcher since the hand-off takes as done, so the exit reaches the service
manager and the service restarts. A launcher that reads the failure marker then
skips that release's launcher; an installed one from before hand-back does not.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared`. The launcher
then commits the target version durably and replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version. After commit, the target
is authoritative and the service manager's ordinary restart policy applies.

The prepared deadline is long because migrations can scale with the database
and block the trial's main thread, so it cannot report progress. A missed
deadline restores the snapshot, and the retry pays the same cost again. A
crashed trial is caught when it exits; the deadline bounds only a stuck one.
Client update waits must outlast the deadline, or a slow update shows as failed.

## Database rollback

The snapshot exists to undo migrations, so the launcher makes one only when the
target build will apply a migration. The target's preflight reports this as
`migratesDatabase`: startup's migrator runs every migration above the highest
recorded id, so the database migrates when its history is empty or ends below the
build's migration head. When the head is equal, nothing changes the schema, the
previous build still reads the database, and rollback needs no restore. The
preflight already refuses a database that records migrations the target does not
know. A target whose preflight predates the field, or a request without it, is
treated as migrating.

For a migrating update, the launcher refuses before stopping the old child when
the snapshot will not fit on disk, so a full disk does not cause an outage. After
the old child exits, a WAL database is pinned rather than copied: the launcher
checkpoints it empty and a helper process holds a read transaction, so SQLite
cannot checkpoint the trial's frames into the main file and every trial write
stays in the WAL. Rollback kills the helper (a clean close would checkpoint),
deletes the WAL and its index, and checks that the main file's size and mtime are
unchanged. The snapshot costs the WAL's growth, not the database's size, which a
filesystem without reflink would otherwise copy in full. A database that is not
in WAL mode, or whose checkpoint is busy, falls back to copying SQLite's main
file, WAL, and shared-memory file. Either way trial migrations are reversible
without down migrations. The snapshot is
made once per update and survives launcher restarts; replacing it during a retry
could capture changes from the failed trial. A pin dies with the launcher, so a
launcher that restarts mid-trial undoes the trial's WAL first and pins again. An update that skips the snapshot
records that on its pending state, so the space check and the copy are both skipped.
An older launcher ignores the field and snapshots every update, so the launcher
needs a local service update to benefit.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Restoring with no snapshot leaves the database as the trial left it: the previous
schema, and little else written, because the trial accepts no commands and runs no
background work before commit. Attachments and other files outside SQLite are outside this
rollback boundary.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

The native backend sends update commands over the telemetry control descriptor. For a primary
backend in WSL, Electron polls authenticated HTTP for the oldest unacknowledged command and
acknowledges it after handing it to the same command handler. A cancellation supersedes queued
commands for its own request ID. Commands for other requests retain their order.

## Automatic installs

The same [automatic update service](../../apps/server/src/cloud/autoUpdate.ts) runs in the
launcher-managed server and the desktop app's bundled server, when the app can apply an update.
Whoever starts any other server updates it. `server-runtime.json` records which kind of server is
running (`automaticUpdates`), so a diagnosis can tell them apart. The service checks at activation, at the daily install time and when a retry is due,
with at most 30 minutes between checks while `installUpdatesAutomatically` is on. An update becomes due when a release
newer than the running version was published by the most recent daily `automaticUpdateTime`
(default `03:00`, in the server's local time). The GitHub release index supplies the publication
times; the index is newest first but not strictly by version, so the service reads every entry
above the running release. Once due, the launcher installs the newest release on the running
track. The desktop shell installs its feed's newest release, which can lag the index, so it gets
the newest due release as the least it may install. A local time skipped by a clock change moves
forward by the gap. A repeated time uses the later occurrence once it has passed. An install
leaves the machine on a release at least as new as every due one, so nothing is due again until
the next day's time.

The service waits up to two hours for a restart hold with no running turns or work, then
[`UpdateDrain`](../../apps/server/src/cloud/updateDrain.ts) holds new scheduled starts for up to
three more hours while existing chats finish. After that, the wait follows **Update when it
finishes** and waits only for the listed background work and tool calls, for at most one hour so
work that never ends cannot hold every later day. The log names the threads that may be cut;
they resume according to the server's restart-continuation setting. Timed and webhook runs share
the drain admission check: accepted webhook deliveries stay in the persisted dispatch queue, and
manual task starts remain available. A fixed-time occurrence held during the drain is recorded in
`scheduled_task_drain_holds`. When the drain ends or the server restarts, it runs once if its
scheduled time is closer than the next regular occurrence, regardless of its catch-up setting.

On desktop the policy runs only in the primary backend, while Electron's install stops every
backend the app runs, such as a WSL backend beside the Windows one. So the waits and the drain go
through [`MachineRestartHold`](../../apps/server/src/cloud/machineRestartHold.ts), which merges the
primary's own hold with each other backend's. Electron lists non-primary backends from spawn
through process exit, including those still starting. It sends the inventory over the telemetry
descriptor and replays it on each new stream. For a WSL primary it posts changes and replays
the current inventory on its HTTP control poll. The primary waits up to a minute for the first
inventory, even on a machine where the eventual list is empty.

Each listed backend streams JSON lines from `GET /api/desktop/restart-hold` and repeats its
hold every 20 seconds. The backend-control token uses its own HMAC purpose and the same clock
windows as desktop bootstrap. With `drain=1`, the backend holds scheduled starts and waits for
admissions already in progress to become visible before sending its first line. Preparation
waits for local admission and an acknowledgement from each listed backend, each bounded by a
minute. Overlapping drains share links through the handoff. A dropped or silent link loses its
acknowledgement until the backend reconnects and reports again.

The final check reads the setting, managed policy, local hold, current inventory and each live
drain link's latest hold. An unknown inventory, an unreachable backend or a missing acknowledgement
counts as a failed attempt and triggers backoff, including in the cut phase. Once the deadline
passes, a successfully read busy hold allows the cut. When a chat
started during preparation, the service waits again with the same two-hour or drain deadline, so
a busy machine cannot restart those waits with each preparation. `UpdateDrain` counts holds:
every preparation holds scheduled starts, and an accepted handoff keeps holding them for up to
five minutes, until the installer stops the server, so none starts in the launcher's handoff
window. The subscription to setting changes opens before the settings are read, so turning
automatic updates off or changing the time during the release lookup still ends the wait. The
bundled server prepares and commits the update through the desktop shell's update channel; the
launcher stages and trials the release. Both apply the server's restart-continuation setting.

Before each handoff, and after each failure before one, the service writes
`runtime/automatic-update.json` with the running version, the target, the attempt count and the
next allowed attempt: 15 minutes, doubling per attempt up to six hours. The record outlives the
process, so an install that did not apply, a launcher update that failed, or a handoff that left
the same version running waits out that time, and new releases do not reset it. A record from an
older version is ignored, and an unreadable one is replaced. A release the launcher rolled back,
or a desktop update that did not apply, is skipped until a newer release is due. Manual updates
can be started at any time.

Every check that found a due release ends its "Automatic update" log lines with "Automatic update
handed to its installer.", "Automatic update check ended without an install." (with the target
and whether the settings changed), or "Automatic update check failed." when the check itself
fails. A check can stop with no other line, when the
schedule changes or the release is no longer due, so without that line its log would read as an
install still under way.

## Recovering interrupted threads

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode keeps the default unless its raw text still shows
`"continueThreadsAfterServerUpdate": false`: settings writes are atomic, so only a hand
edit or a newer version leaves the file unreadable. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
continues a cut turn only with matching durable run, provider thread, session, and native
resume identity. A run cut before any provider turn recorded its prompt (preparing its
workspace, waiting on `provider-turn.start`, or running before its first turn) needs none
of that: `prepared-run.retry` starts the same run again with its own message, model and
workspace, so the timeline gains no copy of the message and scheduled-occurrence links
stay intact. The prompt is sent only after the run is persisted as `running`, so a run cut
before that never sent it; one cut later may have, and from then until a provider turn
records delivery each restart resends it with a note that the agent may already have it.
An unconfirmed `/goal` is not replayed, because it reaches the provider verbatim and
replaying it resets the goal, and a cut delegated-task result is left to delegated
recovery, which offers it again under a new generation.
The same revival runs before later work someone asks for, whatever the preference: a message
a person or an agent sends, **Resume** or **Send now** starts the cut run again first and
waits behind it (Send now's message next), so the agent never gets a later message without
the one the restart kept from it. Server and provider messages (wakes, notifications,
scheduled occurrences) do not revive it, nor does anything after a Stop, a switch to another
provider, or a skip of a stale scheduled occurrence. A revived run that was still preparing
its workspace queues a `workspace.prepare` effect, which runs the original preparation again.
Queued runs never started, so recovery holds them and continues the run they wait
behind. With the preference on, the hold is marked `queueHeldByRestart`: nobody chose it,
so the thread's next completed run releases it like an agent's held message, and the
queue follows the continuation. Nothing is released while a resume that can still run is
pending in the outbox; a resume whose run a later run superseded will stand down and holds
nothing. Stop, or a failure of the resumed run with no retry scheduled, turns the hold
into an ordinary one, and every release drops the mark, so a later failure hold cannot
inherit it. The run-update listener does
not replay completions from before startup, so a startup pass after reconciliation applies
the same release to threads whose latest run completed, then starts their queues. A settled run qualifies only when it lost work the agent waits on
and its session was live, so stale records from an older crash never wake it. Its
continuation prompt names the lost work. A provider-owned shell or monitor carries its
explicit wait through restart recovery. A service left running is reported on the next
user message.
For a settled chat the provider thread's roster is often the only record of a background
command, since the command's turn item may already have completed. Whoever empties a
roster whose process is gone therefore records the loss on a run in the same write: the
note's work and a notice in the thread. Three writers do this while the server runs.
Claude's roster lists only its opaque tasks, not background subagents, which end with the
process all the same, so every writer also takes the subagents that process still runs from
the adapter. The adapter gives each one out once per process: a turn that reported it is not
followed by a second report when the process then exits.

A provider process that ends on its own, or that a Stop closes, reports the roster it
drops as lost, and ingestion records it on the reporting run. Only a process that ends on
its own while that run is settled (a crash, or a restart that kills it before the server)
also queues a wake. That wake is queued after the write, so a server that dies first leaves
the work on the run, where startup recovery finds it as the latest run's undelivered work.
A process that ends during a turn fails the run where the user sees it, and a Stop was
asked for, so neither wakes the chat: the next prompt of that conversation carries the
note. A turn that does not complete reports in the roster update before its terminal
event, because the run's stream stops reading at that terminal.
The run's event stream decides when to stop from the adapter's live state, which runs
ahead of its queued events. For a runtime whose tasks end with its process, it keeps
reading while the last roster it stored still lists tasks, or the update that reports them
lost would be dropped with the roster left behind.

A session release ends the process without a report from it, so the session manager
records the loss itself. It records what the process ran when it was released, minus what
a run already carries, and not what the roster still lists: a replacement process may have
stored its own empty roster first. A release nobody asked for (the idle pin expired, or the
runtime failed) queues the wake in the write that clears the roster, because the session
is already stopped and startup recovery would not find the chat. An idle
close does not wake a run that was itself woken for lost work: an agent that restarts
quiet work would be closed and woken again every few hours with nobody watching. The wake
of a finished `/compact` run sends only the note. A release someone asked for records the work
without a wake: a forced stop, a sign-out, archiving or settling the thread, and any
change that needs a new session (another account, access mode, workspace or provider).
The next prompt of that native conversation carries the note, also when an account move
resumes it under another provider thread.

Such a change points the provider thread at its next session before the old one is
released, so the release asks the runtime it closes whose background work it still runs
instead of trusting the session id on the row. The record goes to the latest run that is
not being started again, because the run being started can still build its prompt from it.

A release writes that record before it closes the session's scope, which can take 30
seconds, so a turn that opens a session meanwhile builds its prompt with it. The roster
and the wake wait for the close: events the closing process already queued could put a
cleared roster back, and a woken turn would resume the conversation while the old process
still runs. The write that clears the roster also ends the records of the background
subagents the release stopped: the process's own update of them reaches no subscriber once
the release ended them, and a subagent left running would show as running and be recorded
a second time by the next startup's recovery. A record whose write fails is written again with the roster after the close,
and retried; turns that start before it lands do not wait for it, since the retry lasts
as long as the database fails, and the first prompt after it lands tells it. Holding the
session's open lock for the whole release was set aside: a slow close would block the
next turn for as long as it takes, and open itself releases inside that lock when its
attach write fails. No ordering covers every case, since a release can start while a turn
builds its prompt, so delivery is recorded instead of being inferred from a later turn
having completed. Each attempt stores the lost work its prompt names
(`backgroundWorkNote`), and work stays owed until a turn of an attempt that named it
completes. A wake's text is written when the wake is queued, so its turn adds a note for
the work recorded since; each line of its text stands for one entry. A run started again
owes what was recorded on it as well. A wake that a running session may answer from
buffered output, and a continuation that only resumes, are not sure to send their text:
they name nothing. An attempt from before the record counts as having delivered all work
lost before its run. Only `run.background-work-cancelled` changes a run's record: a run
finishes from the snapshot it started with, so the projection keeps the stored record
whatever a `run.updated` carries. A wake leaves out work a completed prompt already
named, since a run started again tells its own, and a settled run whose waited-on work was
all told is not woken.

A restart of a running turn moves its run to the next attempt before it interrupts the
process the old attempt ran, so the run gate refuses that attempt's last roster, the update
that reports what the closed process lost. Ingestion still records the loss, without the
stale roster, on the same run a release would. When no earlier run shares the provider
thread it stays on the restarted run, which owes its own record when it starts again. The
provider reports the loss after the turn's own status and before its terminal, so the
restart waits until the interrupted attempt's stream has ingested that terminal before it
detaches a session or builds the next prompt.

A rollback closes the process as well and writes the provider thread itself, so the
adapter returns the tasks it stopped with the rolled-back thread instead of reporting them
on a run's stream, which that write would race and whose stale roster it would put back.
The rollback records them on the latest run that stays. The rewound conversation no longer
knows the work its rolled-back turns started, and a note would have the agent start it
again, so that work is left out. It is also removed from the records rolled-back runs
carry, including runs an earlier rollback removed, because a rolled-back run still counts
as a source for the work that remains on it. A record names the tool call that started
its work for this; a run's turn items tell which run that was. A rollback that fails after
the process closed rewound nothing, so it records on the latest run what that process ran
and no run holds yet, unless its own write committed first.

Shutdown reconciles the roster itself. Claude refuses to replace a process that still
runs background work for its chat, so a new turn never reaches that close with a roster.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns before dispatching: a cut `/compact` is resumed by compacting
again, and a cut `/logout` is not repeated, since only a person signs a provider out. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a question recovery keeps answerable by message, since the
person's answer continues the thread. Approvals, other questions and secret requests the
restart closes do not block: the resumed agent asks again. Delivery also stops after three
consecutive continuations in one `restartContinuationOfRunId` chain, or three starts of the
same run within five minutes, so a turn that crashes the server cannot loop. A later
restart that cuts the same run again re-arms its settled resume effect, whose id stays
the run's so delegated-task waiters keep finding it. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Clients hold an update while chats wait on subagents or background tasks a restart would
cut, because no provider's background work outlives the provider process a restart stops.
Claude Code owns its `run_in_background` shells and kills them when it exits, and a new
server cannot reattach to an old provider process mid-protocol. A native shell or monitor holds
an update only when the agent has explicitly said it needs that task's result. `server.watchRestartHold` streams the
part of what a restart would cancel that a chat waits on, computed by the same
`restartCancelledBackgroundWork` the shutdown reconcile uses for its note, so the hold
and the note cannot disagree. The client that starts the update waits on it before
restarting and lets the user update now or cancel. The wait happens outside the
per-environment config queue so other settings for that server are not held. A
crash still loses the work; the note reports it.

A command an agent starts with `t3_command_run` belongs to the app, outside the
provider and server lifetimes. The [command runner](../../apps/server/src/commandRunner/CommandRunner.ts)
starts POSIX commands in their own session; Linux services also give them a systemd scope
outside the service cgroup. Windows uses WMI to start a separate native host, and the launcher
waits on a handle to it: a host that exits fails the launch at once, even when Windows gives its
PID to another process. The host
creates the command inside a named Job Object before any command code executes, and
holds the job until the command ends. A restarted server opens the job, pins the recorded
child process, and verifies its full 100 ns FILETIME creation identity and membership before stopping it.
That identity stays a decimal string through IPC and persistence, and only it authorizes a stop.
A reused job name never authorizes termination. Windows retains descendant membership even when an intermediate process
exits; PID ancestry snapshots cannot establish that ownership. The host closes admission
and terminates the job before reporting completion. A host crash also terminates the job.

The [same native host](../../packages/shared/src/windowsJob.ts) owns provider subprocesses
through the worker, standalone spawners and SDK callbacks. Their control pipe keeps them
owned through startup: losing the owner ends the job unless an acknowledged unref permits
it to outlive that owner. Command-runner hosts instead survive server restarts. Job handles
and control descriptors are private to the host, so a child cannot retain ownership by
inheriting them. The host releases its copies of command stream handles after spawn, so a
child closing stdout can finish a protocol stream while it remains alive. The helper builds
with the Windows .NET Framework compiler and verifies cached executable contents by SHA-256
once per server process. It is unsigned and stored in the user's cache: AppLocker or WDAC rules
that block executables in user-writable folders prevent Windows commands and provider processes
from launching. A rejected host spawn preserves the cached executable's path and system error;
access-denied or unknown spawn errors name these policies as a possible cause.

Launch and identity work run outside the shared state lock. Startup registers every row
before accepting new requests, without waiting for probes. Separate bounded probe and stop
queues keep cancellation and deadlines independent of a held launcher or identity check.
Healthy commands use cheap liveness checks with periodic identity verification. Before a
command takes its start gate, its wrapper records its PID and identity: Linux uses boot ID and
kernel start ticks so wall-clock corrections cannot change ownership, macOS uses the wrapper's
creation time, and Windows uses full FILETIME. A Linux boot ID or a Windows FILETIME also decides
whether the machine rebooted since the command started; only a row with neither compares its start
with the clock and uptime. POSIX and Windows cancellation and recovery atomically close the same gate.
A closed gate proves the command
cannot execute, including a late WMI creation; a failed database write does not prevent gate
closure. Gate failures are written to the command log. A command waiting in the memory or CPU
queue has no gate or launcher yet: the runner opens its gate in the same locked step that marks
it running, and cancelling it while it waits removes it from the queue and reports it as never
started.

A launcher failure returns a task ID. The task remains watched while startup evidence is
unreadable, and its result arrives through normal task delivery. Recovery retries filesystem
and database failures after a restart too. Missing legacy evidence proves neither execution
nor non-execution. A deadline reports once before identity probes or termination, with cleanup
explicitly pending. `task_cancel` hands a command to its runner, which closes the gate, stops the
command and reports the result with the cancel's reason. The result says the command was stopped,
that cleanup is still pending (when stopping fails or takes over 15 seconds), or that the
command was cancelled before it started, and the cancel's response gives the same outcome as its
`cleanup`. A command that already wrote its exit status keeps it: a cancel or deadline reports it
as exited with its code. One whose exit status cannot be read is stopped anyway, and its result
says why the status could not be read. Cleanup failures remain watched and retry independently;
delivery is recorded after the gate is closed or authorized cleanup finishes. A legacy
launch with no gate, unit, PID file or exit status retires at its deadline on every platform with an explicit
ownership-unknown result; this does not claim it never ran or that any process was stopped. A status file
preserves the wrapper-reported PID even when identity is unavailable. Proven absence,
replacement or reboot ends a legacy task; an unknown identity alone does not prove loss.

An older Windows row that recorded only its wrapper's creation millisecond takes the full FILETIME
of a live process under its PID that started in that millisecond. Windows gives a PID to a new
process only after the old one ends, so that process is the wrapper. The runner records the
FILETIME and stops the command through it. A row that holds only a launch window or a PID-file time
cannot tell its wrapper from a later process. It is marked unproven and never stopped, and its
deadline or cancellation result says CodeShip could not prove the process was the command's. Its
identity check gets one probe's time past the deadline before the timeout is decided. A command
without a job is stopped with the processes it started. The host opens its root through the full
identity and holds that handle, so the PID cannot pass on, then takes one list of every process. A
process belongs to the command when its parent PID names a member that still holds it and it
started after that member, which tells a child from the orphan of an earlier holder of that PID.
The host stops each member through a handle it opened and checked, lists again to catch what
started meanwhile, and names each process it could not stop. The row keeps those, its cleanup stays
pending, its result names them, and the next stop starts from them. A process whose parent ended
before the stop cannot be traced. macOS wrappers publish their
own `ps` identity before taking the launch gate; legacy PID-only records require an identity
within the recorded launch and PID-file bounds. Persisted PID replacement or reboot evidence
forbids further PID or process-group signals.
A systemd unit owns its cleanup even after the leader exits; a failed scope with no processes left
counts as stopped. Without a unit, as on macOS,
cleanup may signal the surviving group only when no replacement has been observed. One window
remains unobservable: the whole original group ends, a replacement leader reuses its PID, and
that leader exits while its children live, all between two probes. Neither platform treats
an I/O failure as a missing status file or a delay as proof that a launch cannot execute.

Output goes to a capped log and exit status is published by atomic rename. The Windows
command has a separate console so its Ctrl+C or console close cannot end the wrapper first.
Completion uses the durable delegated-task delivery and refuses a second result. Cancellation,
Stop, archiving and deletion also end the task. The restart hold excludes app-owned commands;
continuation tells the agent that surviving commands still run and will wake it.

The hold also lists a running turn's in-flight tool calls and native subagents as `turnCall`
entries. Claude creates a running item for every `tool_use` block of an assistant message at
once, so a call queued behind a slow one is already listed, and a restart would cut the slow one
mid-effect and drop the rest unstarted. Calls that wait on the person, on another thread, or that
the agent sent to the background are left out: those resume or are reported. A manual wait
latches each chat that was running calls and releases it the first time that chat runs none, so a
chat working in rounds cannot hold an update past its next gap; listing only the calls seen at
the start would miss a subagent that registers after it. A subagent moves between the two lists
(it outlives its turn, or its turn waits on an approval), so both use the provider's id for it
and the wait keeps every entry it has waited on, under either list. The hold is recomputed in
fixed windows rather than after a quiet moment, which a busy agent never takes. When a restart
cuts calls anyway, the continuation names the run's items the reconcile cancelled (their
`completedAt` equals the run's) so the agent checks each before repeating it.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. A parent's recovery projection leaves an
app-owned child's provider thread out, even though the subagent row names it: resetting
it there would leave the child's own reconcile no active provider thread to resume, so
the child's cut run would stay cut whenever the parent recovered first. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.

## Pinning thread system instructions

Resuming a native provider conversation after a server update would invalidate the
provider's prompt cache if the newer binary sent reworded runtime, orchestration, or
PR-linking instructions in the system prompt prefix. Each provider thread therefore
stores the instruction block it started with as `pinnedSystemInstructions: { key, text }`.

- **Key.** `pinnedSystemInstructionsKey` (provider-core) hashes the inputs that
  legitimately change the block, plus `PINNED_INSTRUCTIONS_EPOCH`. A resumed thread reuses
  the stored text only when the stored key equals the key the running binary computes;
  otherwise it rebuilds the text and stores the new pin. A wording-only release keeps the
  key, so it keeps the pin and the cache.
- **Epoch.** Bump `PINNED_INSTRUCTIONS_EPOCH` when an instruction change must reach running
  threads (a security fix, say). Every key changes, so every thread rebuilds on its next turn.
- **Claude** pins the static `systemPrompt.append` block (`buildRuntimeInstructions`,
  `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, and the device-tool instructions). Its key holds the
  harness, whether T3 MCP servers are attached, and whether the MCP session has the
  `device` capability, so a first turn without MCP, or a device toggle, rebuilds the block.
  Browser availability does not change this text, so it is not part of the key. Dynamic
  inputs (`permissionMode`, CLI `--append-system-prompt`, `SubagentStart` hooks,
  post-compaction state) are computed per turn.
- **Antigravity (ACP)** pins the session-level `_meta.antigravity.systemPrompt.append`
  string (`PULL_REQUEST_LINKING_INSTRUCTIONS` on Antigravity >= 1.4.5) under the
  `ANTIGRAVITY_PINNED_SYSTEM_INSTRUCTIONS` key, and replays it on `session/load`,
  `session/resume`, and `session/fork`.
- **Codex is not pinned.** T3 sends its context as `additionalContext` on every Codex
  `turn/start`, rebuilt with the current model, effort and tool availability. Codex appends
  it as a developer message after the existing history, and only when it changed, so the
  cached prefix survives an update without a pin.

**Storage.** The pin is never part of a `provider-thread.updated` payload: `EventSink`
strips it from every write, and adapters report a changed pin through a side field on
their `provider_thread.updated` event. An adapter keeps the pin a native session runs with
apart from the stored one: the provider threads it returns from ensure (a forced replacement
too), resume, snapshot, rollback and fork carry the stored pin unchanged (none for a new
provider thread), and `startTurn` reports the session's pin when it differs. A returned
thread that carried the session's pin would make `startTurn` compare the pin with itself and
never store it. The ingestor turns that field into a dedicated
`provider-thread.pinned-instructions-set` event `{ providerThreadId, key, text }`, emitted
only when the key or text changed, so the text is stored once per change instead of on
every thread update. The projection writes the `pinned_system_instructions` and
`pinned_system_instructions_key` columns of `orchestration_v2_projection_provider_threads`
only from that event, and adapter-facing reads hydrate the pin from those columns.
Cold-history compaction keeps the latest pin event per provider thread. WebSocket wire
projections drop the pin, and wire pin events carry an empty `text`. A database that has
not run migration 124 reads every pin as `null`.

Pinned instructions survive server restarts, upgrades, native forks, and same-conversation
account switches (`canResumeAcrossInstances`). A new native session (new thread, provider
switch, resume-failure fallback, forced replacement, or rollback to `thread_start`) builds
the running binary's current instructions. A provider thread created before pinning reads
`pinnedSystemInstructions: null` and stores the current binary's instructions on its next
turn.

## Detached provider session hosts

Codex app-server processes run inside a detached [`__session-host`](../../apps/server/src/sessionHost/broker.ts) broker
outside `t3-server`'s process tree and cgroup so live agent sessions survive planned
updates without dying or injecting a continuation prompt. The broker uses the same
isolation mechanisms as `CommandRunner` (`AgentScope` with `survivesRestart` on Linux,
`detached: true` with `stdio: "ignore"` on macOS, and `Win32_Process.Create` on Windows)
and records its PID and start identity ([`processIdentity.ts`](../../apps/server/src/commandRunner/processIdentity.ts))
in SQLite (`session_hosts`).

Each broker owns one provider child process and serves a per-session local IPC socket
(`<stateDir>/session-hosts/<hash>.sock` mode `0600` on POSIX, with a short `/tmp` fallback
if `stateDir` would exceed `sun_path`, and `\\.\pipe\t3-session-host-<hash>` on Windows).
The startup config file carrying the random `authToken` is written mode `0600` and
unlinked immediately on broker startup; the token never appears in argv. While attached,
the broker forwards stdin and tags every stdout, stderr, and exit event with a strictly
increasing sequence number (`seq`) in a bounded ring buffer.

On planned-update shutdown (detected via [`isPlannedUpdateShutdown`](../../apps/server/src/cloud/updateHandoff.ts),
which checks both the launcher update handoff and the desktop restart marker),
[`ProviderRuntimeRecoveryService.detachForUpdate`](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
runs before the effect worker stops. It first restricts the worker to the effects a kept
process must get (`runtime-request.respond`, `provider-turn.interrupt` and
`provider-turn.steer`, `DELIVERED_BEFORE_DETACH_EFFECT_TYPES`), so an answer the user gave
just before the update is still written to the process and nothing new starts. Then
[`SessionHostService.detachAllForUpdate`](../../apps/server/src/sessionHost/SessionHostService.ts)
keeps a broker only once everything its server read is persisted, so the next server
replays exactly the rest, with no overlap and no gap. For each live broker it:

1. Stops a broker that never attached: it keeps its child only for a detach it got while
   attached.
2. Asks `ProviderSessionManagerV2.prepareDetachForUpdate` for the threads the process
   serves, and waits within `DETACH_DELIVER_TIMEOUT` (1 s) until every effect of those
   types queued for those threads has settled.
3. Holds the output that has not reached the reader yet (`holdForDetach`) and takes the
   seq of the last frame the reader got. That seq becomes the row's `last_acked_seq`.
4. Drains within `DETACH_DRAIN_TIMEOUT` (2 s). Codex's drain waits until every server
   request handler has reached its waitpoint (registered its pending request), flushes
   what the client still has to write, and writes a `t3/outputBarrier` line past the held
   output (`injectOutputLine`). The app-server reader handles lines in order, so the
   barrier arrives after every line it already got. The drain then flushes the buffered
   text deltas and returns how many events the adapter sent. The session manager waits
   until its event pump has handled that many events. Each run subscriber then flushes its
   assistant streaming filter in both modes, so the whole text up to the replay point is
   stored, and reads past a barrier signal or stops reading.
5. Asks which threads the next server takes over. A process is kept only when every
   nonterminal run of every thread on it is `running` with a running native turn on this
   provider session, and nothing is still queued for it. It sends `{ type: "detach" }`,
   marks the row `detached_for_update` with those threads, and leaves the broker and
   provider child running.

The process is stopped instead (fail closed) when no session uses it, when a queued answer
is not delivered in time, when its runtime cannot drain, when the drain fails, dies or
times out, or when any run on it cannot be taken over. Its threads then continue as after
any restart. Only the threads of a kept process are preserved; reconciling any other thread
never stops or releases a kept shared session.

The desktop restart sends `SIGTERM` before the shutdown finalizer runs. A broker's child
is outside the server's process group, so the signal does not reach it, and during a
planned update the event pump keeps handling that session's events until the detach.
After an ordinary `SIGTERM`, or for a normal child, which dies with the server, events
after the signal are dropped. The stream end a detach causes is not a provider failure:
the session manager leaves that session and its runs to the shutdown.

Each kept session costs one extra process: its `__session-host` broker, the server
binary in broker mode, beside the provider child. Normal shutdowns, explicit stops,
thread closes, and session evictions send `{ type: "terminate" }`. The broker signals the
child process group, escalates to `SIGKILL` after `DEFAULT_TERMINATE_GRACE_MS`, and sends
the exit frame before it closes the connection; `terminate` waits for that frame, so a
replacement never starts while the old process still runs.

On startup, [`ProviderRuntimeRecoveryService`](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
calls `reattachAllDetachedForUpdate()`. Each `detached_for_update` row is verified against
its stored process identity before reconnecting with `{ type: "attach", afterSeq, authToken }`.
The broker first sends each request the child asked at or before `afterSeq` that is still
unanswered (`pending_request`, with its original JSON-RPC id), then every buffered frame
after `afterSeq` in order, then `replay_complete`, then live output. The reattached handle
holds that output until a taker releases it. If the broker's ring buffer dropped frames
the old server never read, the host is ended: a turn cannot be rebuilt from part of its
output.

Recovery gives a reattached host up when any thread on it has a nonterminal run it cannot
take over. Otherwise it hands the host to `ProviderTurnStartService.adopt` for each
running run on the threads its process serves, each under its thread's lock. The adapter
takes the stdio handle over (`SessionHostService.takeAdoptable`). Codex then:

- skips `initialize` and `thread/start` or `thread/resume`;
- uses prefixed request ids, so replies to the old server's requests are ignored;
- rebuilds each turn's state from the projection, seeding active assistant, plan and
  command items with their persisted text, so replayed deltas extend it;
- numbers new items after the highest stored ordinal of the turn (`nextItemOrdinal`), so
  several stored items that share one native id never collide with a new one;
- gives a request the broker asks again the id and item of the stored pending request,
  so the answer given after the update reaches the request the user saw.

Once every run is registered, the held output is released into the normal event
ingestor. Replayed and live notifications finish the same runs, and an approval Codex
asked while no server was attached becomes a pending runtime request that can be
answered. The effect worker starts only once each taken-over process finished its replay
(`replay_complete` plus an output barrier, within 10 s), so a queued answer never reaches
the adapter before its request is registered. A replayed request never moves a stored
request back to `pending`: the projection keeps a terminal status. The adopted process
finishes only the turns it was running; the next turn starts a fresh session with this
server's MCP credential and instructions.

If any adoption fails, recovery releases the session the way a server shutdown does: it
interrupts the session's subscribers without writing `run.failed`, terminates the host
and waits for its exit. Every thread on that process, including those already adopted,
then recovers through `RestartContinuation`, as they do when a broker exited or failed
identity verification while the server was down (its row is marked `dead`). Any detached
broker that is never reattached self-terminates its child process group and removes its
socket after `orphanTtlMs` (default 15 minutes).

MCP credential hashes (`mcp_session_credentials`) are saved with the MCP endpoint they
were issued for. After the reattach outcome is known, startup keeps only the credentials
of threads whose process was taken over and deletes the rest from SQLite and memory. A
restored credential is refused when the new server's MCP endpoint (host and port) differs
from the saved one, and an unreadable saved credential counts as unusable. A restricted
review's credential is never saved: a restore does not rebuild its assignment, and a
restricted review runs on Claude, which never runs in a session host.

### Which drivers run in a session host

Only a driver whose running turn a new server can adopt runs in a session host, and only
once a test proves the adoption (`SessionHostDriver` in
[`protocol.ts`](../../apps/server/src/sessionHost/protocol.ts)). Every other driver is a
normal child of `t3-server`, dies with it, and resumes through `RestartContinuation`.

- **Claude stays a normal child.** The Claude Agent SDK keeps the turn's control state in
  the server process: `can_use_tool` permission callbacks, hooks and SDK MCP servers are
  closures registered by `query()`, and the CLI sends each `control_request` to the process
  that started the turn. A probe on 2026-11-27 with `claude` 2.1.332 (isolated
  `CLAUDE_CONFIG_DIR` and `HOME`, no paid turn) showed an idle CLI answers a second
  `initialize`, but nothing shows that a new `query()` takes over a turn in flight or
  receives the requests the old process left unanswered. Proving that needs a paid
  mid-turn run, so Claude is not detached.
- **ACP stays a normal child.** The `session/prompt` response is the turn's terminal message,
  and it answers a request id owned by the old server's client, so a new client cannot finish
  the run. Each ACP agent also keeps its own adapter state, which a new server would have to
  rebuild per agent.
