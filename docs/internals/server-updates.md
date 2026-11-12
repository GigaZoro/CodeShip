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

Before stopping the old child, the launcher refuses an update whose snapshot will
not fit on disk, so a full disk does not cause an outage. After the old child
exits, the launcher snapshots SQLite's main file, WAL, and shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Attachments and other files outside SQLite are outside this rollback boundary.

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

## Automatic installs

With `installUpdatesAutomatically` on, a launcher-managed server starts the same update a client
would, but waits by a stricter rule than a user's "Update when it finishes": nobody chose to cut
anything, so it waits until a restart hold lists no work and no running turn
(`untilRestartHoldIsEmpty`, shared with the desktop app). A running turn would resume after the
restart, so a manual update ignores `runningTurns`, but an automatic one must not cut a chat mid
answer. Preparing a release takes minutes, so `beforeHandoff` reads the setting, the policy and
the hold once more right before the launcher takes over
([`autoUpdate.ts`](../../apps/server/src/cloud/autoUpdate.ts)). A busy hold there puts the update
off to the next check without counting as a failed attempt. A user's update keeps
`untilListedRestartHoldWorkEnds`: it waits only for the work running when they chose it. Nothing
else about the update is special: staging, preflight, trial and rollback all apply. The
back-off for a release that rolled back reads the launcher's settled outcome, which survives the
restart that the failed attempt's process did not. Failures before the handoff are remembered only
in memory, because the process that made them is still running. The desktop app does not use this
path: its renderer installs, because the app, not the server, owns the restart and the install. It
waits by the same rule, reads each hosted server's hold again right before installing and goes back
to waiting when work or a turn started, and ends its own wait when the setting is turned off.
`runningTurns` is optional in the hold: a server that predates it reports none.

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
(a subagent, a background task, or a shell or monitor the agent marked with
`t3_background_wait`) and its session was live, so stale records from an older crash
never wake it. Its continuation prompt is the note of what will not report back. An
unmarked shell or monitor does not wake a settled run: most are dev servers and their
watchdogs that nobody waits on, so that note waits for the next user message.
For a settled chat the provider thread's roster is often the only record of a background
command, since the command's turn item may already have completed. Whoever empties a
roster whose process is gone therefore records the loss on a run in the same write: the
note's work and a notice in the thread. Three writers do this while the server runs.

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
records the loss when it clears the roster. It records what the process ran when it was
released, minus what a run already carries, and not what the roster still lists: a
replacement process may have stored its own empty roster first. A release nobody asked
for (the idle pin expired, or the runtime failed) queues the wake in that write, because
the session is already stopped and startup recovery would not find the chat. An idle
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
not being started again, so the prompt that run is about to build includes it.

A restart of a running turn moves its run to the next attempt before it interrupts the
process the old attempt ran, so the run gate refuses that attempt's last roster, the update
that reports what the closed process lost. Ingestion still records the loss, without the
stale roster, on the same run a release would. When no earlier run shares the provider
thread it stays on the restarted run, and the next message carries it, because a run's own
record is told only to later runs. The provider reports the loss after the turn's own status
and before its terminal, so the restart waits until the interrupted attempt's stream has
ingested that terminal before it detaches a session or builds the next prompt.

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

Clients hold an update while chats wait on background work, because no provider's
background shell outlives the provider process a restart stops. Claude Code owns its
`run_in_background` shells and kills them when it exits, and a new server cannot
reattach to an old provider process mid-protocol. `server.watchRestartHold` streams
the awaited part of what a restart would cancel, computed by the same
`restartCancelledBackgroundWork` the shutdown reconcile uses for its note, so the hold
and the note cannot disagree. The client that starts the update waits on it before
restarting and lets the user update now or cancel. The wait happens outside the
per-environment config queue so other settings for that server are not held. A
crash still loses the work; the note reports it.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
