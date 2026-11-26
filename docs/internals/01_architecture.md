# Architecture

T3.CodeShip keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

- **Server (`apps/server`).** Owns provider processes, terminals, Git, checkpoints, durable state,
  and project files.
- **Client runtime (`packages/client-runtime`).** Owns shared connection management and domain
  state across web, desktop, and mobile so reconnect and multi-environment behavior do not diverge.
  Clients supply platform services and UI. See [connection runtime](./09_connection-runtime.md) and
  [remote environments](./05_remote.md).
- **Contracts (`packages/contracts`).** The typed wire boundary between independently versioned
  clients and servers. Subscriptions send only the state a client needs. Authentication of a socket
  does not authorize every method on it; see [environment auth](./04_environment-auth.md).
- **Providers (`packages/provider-*`).** Provider-specific protocols and quirks stay behind an
  adapter. Orchestration and clients read capabilities, never provider names. See
  [providers](./03_providers.md).

## Settings ownership

Client preferences live in the current client; environment defaults and project overrides live on
their owning server. An unavailable settings target must never fall back to another environment.
**All environments** is an explicit bulk edit of currently connected servers, not a durable global
default or sync promise.

## Durable intent and side effects

Orchestration state is decided as events, and persisted projections are the source of truth once
applied. The [orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes
commands and decides events without doing I/O.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted
projections, command receipts, and outbox effects in one database transaction, then notifies
subscribers.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) runs side effects after
commit and feeds results back as commands. A command acknowledgement therefore means intent
committed, not that provider, checkpoint, or follow-up work finished. Never put external I/O in
command decisions or the database transaction. Effects tied to a lost provider process are retired
on recovery rather than replayed.

The event log retains only a bounded replay window, so projections cannot be rebuilt from scratch
from the log. Retained events must remain decodable across upgrades: schema changes affect stored
history at startup, not just live RPC traffic.

## Turn completion and checkpoints

A provider turn ending and follow-up work settling (checkpoints, diffs, PR sync) are separate
milestones. Late finalization must not keep the client showing provider work as active or extend
recorded provider duration.

A run is `completed` when its provider turn ends; the turn-end checkpoint is captured afterwards as
an outbox effect on the thread's effect lane. Until that capture commits, readers treat the missing
checkpoint as pending, and command decisions still see the run as `waiting`, so steers, queued
turns, rollback and restore line up behind the capture.

Checkpoints use hidden Git refs so workspace snapshots never add commits to the user's branch.
Reverting a checkpoint must coordinate workspace state with the provider conversation: if the
provider cannot roll back its conversation, reject the revert before touching the filesystem.

Thread settlement is server-owned. Clients render persisted settlement state rather than deriving it
from local clocks or PR caches.

## Desktop process isolation

Native modules never load on the Electron main process startup path. Native capabilities that can
crash or stall (such as accessibility or window-capture helpers) run in isolated child processes or
workers with deadlines, never as top-level imports in main.

See the [glossary](./00_glossary.md) for shared terms and the
[development runbook](../operations/00_development.md) for setup and checks.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. After repairing supported V2 preview ledgers,
[`runMigrations`](../../apps/server/src/persistence/Migrations.ts) rejects history that would skip a
requested migration at id 55 or later without its expected name. Earlier name clashes remain
warnings for compatibility with site-local migrations. There is no safe id range for a fork inside
this ledger: any id at or below a future upstream id masks it forever, so T3.CodeShip’s own schema changes live in `persistence/CodeShipMigrations/`, are recorded in
`codeship_migrations`, and never take an id in `Migrations/`.

## Checkpoint indices and thread settlement

Checkpoints, review previews, commit-message staging and `check:changed` copy the user's index to a
temporary one, so Git keeps its stat cache. Git rereads a file whose cached stat still matches only
when the file is no older than the index, and a copy is new, so each copy sets its time back to the
index's, floored to whole seconds. Without that, a same-size edit made in the second Git last wrote
the index reads as unchanged. A temporary index that holds entries is written with
`-c core.splitIndex=false -c splitIndex.sharedIndexExpire=never`: shared indexes live in the
repository, and a split write could remove the one the user's index still names.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. A subagent never runs those rules: it settles
once its parent holds the result of its latest task, as a remote delegate does on its machine, or
otherwise with its parent, whatever the settings say. A
provider-native subagent runs on its parent's run, so no settle takes it while that task works, a
settle on its result rejects once the task has changed, and the ingestor reopens it when the
provider resumes it. A
child working in its parent's worktree leaves that worktree's unmerged work and settle action to the
parent, as storage cleanup does. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. Each forge's
definition names its CLI's commands in `changeRequestCloseCommand`. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

See [CodeShip orchestrator tools](../orchestration-v2/orchestrator-mcp-server.md).
