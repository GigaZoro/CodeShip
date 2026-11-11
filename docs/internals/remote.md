# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment;
an agent reaches another environment's threads only through a peer link.
The canonical key follows the `upstream` remote when one exists, so pull request
features target the repository a fork tracks. A fork also reports its own
`origin`, and clients group and label by that, so a fork never collapses into a
checkout of its upstream.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

A saved environment holds an ordered list of routes, and the
[driver](../../packages/client-runtime/src/connection/driver.ts) connects over
the first that works. Each direct route is first checked with the public
descriptor, so a saved LAN address that a different machine answers on another
network receives no credential. That check is not proof of a working route:
when every route stays silent, each is still tried. A route that fails to
connect, including a blocked one such as a signed-out T3 Connect, moves on to
the next; only an incompatible server stops the walk, because it is the same
server on every route. While connected over a later route the
[supervisor](../../packages/client-runtime/src/connection/supervisor.ts)
preflights the earlier ones and replaces the session when one would connect.
Preflight includes authorization so a route that answers but rejects this
client never costs a working session; a route that still fails afterwards is
held back for a cooldown so a flaky network cannot bounce the connection.

A connected server reports the LAN and tailnet addresses it is bound to, and the
client saves them as learned routes. A learned route reuses the credential of
the route it was learned over: the T3 Connect access token, which is not bound
to an origin because each DPoP proof names the URL it signs, or the paired
bearer token. A paired token only learns a plain HTTP address off the tailnet
when it was itself paired over plain HTTP, so a token paired over HTTPS never
starts travelling unencrypted. Learned routes the server stops reporting are
dropped, which is how a changed LAN address replaces the old one; routes the
user saved are never touched. The reported addresses are hints like any advertised endpoint, so a
learned route still has to answer as this environment before it is used.

A background service with no configured host is what makes this work for
headless machines. It listens on every IPv4 interface and closes each
connection unless both addresses of the direct peer are loopback, private, or
tailnet IPv4. That keeps a VPS's public address closed, including a cloud VM
whose public address is NATed to a private interface. It is not a firewall:
T3 Connect and Tailscale Serve reach the server over loopback by design, and a
proxy that rewrites the source address looks private. One listener per address would
miss a DHCP change, and the wildcard keeps the reported addresses current.

Pull request routing trust covers the whole route list. Adding or changing a route
revokes it; reordering does not, because the same addresses remain trusted.

## Peer links

A [peer link](../../apps/server/src/peer/PeerLinks.ts) lets one environment's
agents work in another. The linking environment signs in to the other's `/mcp`
as an outside MCP client, with a pairing code from it, and keeps that session's
token in its own secret store. The other environment needs nothing new: it
sees one more OAuth client, lists it in Sharing & access, and revokes it there.
Unlinking on the linking side only forgets the token.

- **The Linked environments beta (`linkedEnvironmentsEnabled`) gates both
  sides.** Off on the linking side, `PeerLinks.link`, link requests and
  `PeerForwarding.call`/`links` refuse; `readThread`, `waitForThread` and
  `interruptThread` do not, so a remote task already running still completes
  and can still be cancelled. Off on the receiving side, link registrations are
  refused and link sessions get a 403, which the linking side reports as
  retryable so the task's follower waits rather than failing it.
- **A tool runs in a linked environment when its parameters take
  `OrchestratorMcpEnvironmentTarget`** as `environmentId`.
  [`McpToolAccess.toLayer`](../../apps/server/src/mcp/McpToolAccess.ts) sends
  such a call there once the tool's access declaration has checked the caller,
  so a read-only or ended caller is refused before anything is sent. The
  thread or project the call names is checked where it lives. A tool that acts
  as the calling thread itself cannot take a linked environment.
- **Every forwarded call carries the calling agent's modes** in
  `T3-Mode-Limit`, which the receiving `/mcp` only ever narrows the client's
  approved access with. A plan-mode agent therefore cannot start full-access
  work through a full-access link.
- **The token goes only to an address that proves it is the linked
  environment**: its descriptor must report the linked environment id. A LAN
  address that now belongs to another machine never receives it.
- **All callers on one side share the link's single session on the other**,
  so idempotency keys are hashed with the caller's namespace before they
  leave. Without that, two agents reusing a key would collide on the far side.
- **A forwarded wait is split into calls of at most 50 s**, because the
  receiving `/mcp` sends nothing while a wait is open and T3 Connect's edge
  drops idle requests after about 100 s. A link's `terminal_write` instead
  watches a command for at most 50 s, after up to 15 s for a shell it opens to
  start, and the agent reads the rest with its cursor.

**Work a link paired below full access starts stays within that link.** The
receiving environment knows a session is a peer link because the linking side
registers its OAuth client with the `t3code-peer-link` software id, and the
marker is signed into the session. Threads that session launches carry it, with
the access it was paired with, as an immutable `linkOrigin`, and so do the
subagents, forks and `create_threads` they derive. The rules live in
[`mcp/linkOrigin.ts`](../../apps/server/src/mcp/linkOrigin.ts) and run in the
shared access declarations, not tool by tool:

- linked work may change only threads with the same origin, not the user's own
  threads and not another link's;
- it cannot change projects, settings or scheduled tasks, nor use the receiving
  environment's own links;
- its project setup scripts are skipped
  ([`ProjectSetupScriptRunner`](../../apps/server/src/project/ProjectSetupScriptRunner.ts)
  checks every path that runs them).

Reads are not fenced, and a client's own `thread.create` can never carry
`linkOrigin`.

**A delegated task can run in a linked environment.** Its child is then an
ordinary thread there, so the parent here records the task without a child
thread of its own (`remoteChild` instead of `childThreadId`). A follower in
[`RemoteDelegation`](../../apps/server/src/peer/RemoteDelegation.ts) waits on
that thread and completes the task with `delegated_task.remote.complete`. That
internal command reuses the parent half of a local finalize, so the parent
wakes the same way. Open remote tasks are followed again at startup, which is
also what keeps restart recovery from treating them as abandoned provider work.

The link is routing, not isolation: an agent the link starts runs as the
receiving environment's user. **A full-access link is therefore not fenced**:
its agents can already do anything that user can, so the fence would only stop
T3's own tools. Its work still carries `linkOrigin`, so clients show where it
came from. A stamp without the access, from before it was recorded, is fenced.

**Linking both ways is one grant made on the linking side.** A link is one-way: the linking
environment's agents reach the other, not the reverse. When the user also lets the other
machine reach this one, [`PeerLinkBack`](../../apps/server/src/peer/PeerLinkBack.ts) mints a
short-lived pairing code _here_ and sends it over the new link to the other environment's
`t3_link_back` tool, which runs its ordinary `PeerLinks.link` toward this one. The code never
passes through a client or a log, and an unredeemed one is revoked. Linking back is the one change
to an environment's links a fenced link may make, so the rule is narrow
([`assertMayLinkBack`](../../apps/server/src/mcp/linkOrigin.ts)): the caller is a peer link whose
signed session declared the environment it signed in from (`ple`, set from `peer_environment_id`
at registration) and may link back only to that one, and its access is at least `auto`. A link
made before sessions named their origin, or below `auto`, is refused and the user links from the
other side. The declared environment is the link's own claim, so it narrows what the link may
ask for without being proof of who it is: the code that makes the request useful can only come
from an administrator of the environment it opens, and the other side still checks that the
address answers as that environment.

## Shared scheduled tasks sync through clients

A shared scheduled task has the same id on every machine, and each machine
runs its own copy. Clients connected to several environments push newer copies
to machines that are behind
([`scheduledTaskSharing.ts`](../../packages/client-runtime/src/scheduledTaskSharing.ts)).
Links only pull: a link paired below full access may not change scheduled tasks
there, so each machine reads its links' copies through the link-only
`t3_shared_scheduled_tasks` tool and applies them itself
([`SharedTaskPull.ts`](../../apps/server/src/scheduledTasks/SharedTaskPull.ts)).
That tool leaves out copies that exclude the asking machine.

- **Highest revision wins, per task.** A machine stamps its own edits with
  `max(now, previous + 1 ms)` and its id, and keeps a stamp it receives as-is,
  so every machine settles on the same copy even with skewed clocks.
  `scheduledTasks.applyShared` ignores anything not newer than what it holds,
  so any number of clients can push at once.
- **Deletes leave a deletion record** that spreads to every machine, including
  ones that never had the task. Without it, a machine that was offline during
  the delete would bring the task back.
- **A machine left out drops its copy without a deletion record**, which would
  otherwise delete the task everywhere.
- **A client never plans from a list it has not loaded.** An unloaded list
  would read as a machine with no tasks.
- **Projects travel as references:** No project, or a repository's canonical
  key that each machine resolves to its own project.

A **one-machine** task runs each occurrence once. Its project's machine order
is a synced record of its own. Interval occurrences count from the task's
creation, not each machine's last run, so every machine agrees on when one is
due. A machine late in the order waits its rank times
a grace period, then asks the machines in the order through its peer links
(`list_scheduled_tasks`, a read, which links below full access allow) whether
one is working on or finished that occurrence. A machine that can't ask one
runs the task and records it, so a missing or expired link causes a duplicate
run, not a missed one. A late first machine asks the same way before it runs.
An answer of "still working" is not final: the asking machine keeps the
occurrence and asks again each grace period until the run ends or the next
occurrence is due (12 hours for a one-time task), and runs it if that run
fails. A run a restart cut off reports working while its continuation is
pending, and a machine that was working must miss two checks in a row before
another takes over, so neither starts a second copy of a long run. Every
machine behind a run watches it, so when it ends only the nearest takes over at
once; the others wait their place and ask again, which finds that machine's new
run. A Stop from the user or an agent leaves an interrupt request on the run, so
its `lastRun` says `stopped` and other machines treat it as settled. A
usage-limit stop that auto-resume later continues still counts as not
finishing. Waits and watches live in memory.
After a restart, `next_run_at` may hold a check time, so the occurrence is
recovered from the schedule (the latest aligned slot or fixed time at or before
it) before asking. The restarted machine does lose the watch, so its first
check is an ordinary one: an unanswered call then runs the task, as any
machine that can't ask does.

Clients otherwise read a machine only through their own connection to it. The
exception is a linked machine's task list, which its owner wants to see while that
machine is offline and which no client can fetch then. Each machine stores the last
`list_scheduled_tasks` answer from every link and serves it read-only as
`scheduledTasks.subscribeLinked`
([`LinkedScheduledTasks.ts`](../../apps/server/src/scheduledTasks/LinkedScheduledTasks.ts)).
A failed ask keeps the stored list and records why, and removing a link drops its
list. Clients show only machines they can't read live, and change nothing through it.

## Shared settings follow links

A machine with `followSharedSettings` on keeps the settings in
[`MACHINE_SHARED_SETTING_KEYS`](../../packages/contracts/src/sharedSettings.ts) the same
as the other machines that follow. It serves its versions through the link-only `t3_shared_settings`
tool and pulls its links' every five minutes
([`SharedSettingsPull.ts`](../../apps/server/src/sharedSettings/SharedSettingsPull.ts)), so a
machine that was off when a change was saved catches up, and machines that are not linked to each
other converge by passing versions on. This is not the list in `client-runtime`'s
`sharedSettings.ts`, which only decides which writes a client sends to every connected machine now.

- **The group is the machines that follow, connected or not.** Once any machine is known to follow,
  from live or cached config, a client saving a shared key for all machines sends it only to
  followers; with none connected it saves nothing, since a non-follower must never take it and
  nothing would pass it on. With no follower known it is a plain bulk edit. Web and mobile plan this
  with one function (`planSharedSettingsWrites` in `client-runtime`'s `sharedSettings.ts`). A
  machine that does not follow refuses a stamped write, so racing a client that thought it still
  followed cannot change it through sharing.
- **Following is the trust decision.** A follower takes versions from any linked machine that also
  follows, over its own links, whatever the link's access level, the way shared scheduled tasks sync
  ([`SharedTaskPull.ts`](../../apps/server/src/scheduledTasks/SharedTaskPull.ts)). Turning on
  Follow shared settings is what grants that.
- **A server stamps a change, never a device.** The client saves the change first on one connected
  follower (the edited machine when it follows) through `server.shareSettings`, which merges it into
  that machine's values and stamps it by its clock under the settings lock, then sends the returned
  stamp and values to the other followers. Watermarks use server clocks too, so a device with a
  wrong clock cannot order a change before or after one it did not see.
- **One stamp means one value, passed on as sent.** A version is the key's whole value, never a
  patch, and the server replaces the key with it (`SettingsWritePlan.replace`) instead of merging.
  A machine stores and serves the JSON it received and decodes it only to apply it, so a build
  that does not know a field, or a managed policy, cannot shrink the value it passes on under the
  same stamp.
- **Ordering is per key, checked under the settings write lock** (`SettingsWriteHooks.prepare`).
  Each key records its last shared version and, for writes made on this machine alone, a local
  watermark (time and this machine). A version newer than both applies. One newer than the shared
  version but older than the local change is stored and served without applying, so it still
  reaches machines only this one links to, and since it is never pending, nothing applies it here
  later; a setting an administrator locks here is passed on the same way. Pulled versions, pending
  retries and stored versions recheck following under the same lock. Taking another lock around
  `updateSettings` would invert that order and deadlock.
- **Newest `updatedAt` wins, ties go to the larger `origin`, and stamps are never re-dated.** A
  pulled version stamped more than five minutes ahead of this machine's clock waits, unserved,
  until its time (logged once); re-dating it on each pull would let it undo every later save. A
  stamped write that far ahead is refused.
- **A model selection waits, pending and still served, while it cannot run here**: its instance is
  missing, runs another driver than on the machine that saved it (`instanceDriver`), or is turned
  off. It applies once that changes and no local change is newer, on a stamped write and a pull
  alike.
- **The pulling side checks everything**: the key must be shared and the value must decode as that
  key's setting, since a newer peer may share a key this build does not know. A peer whose build
  has no `t3_shared_settings` is skipped quietly (`PeerMcpClient.callIfAvailable`).

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.

### Desktop without a local environment

Desktop normally launches its own primary server, but the desktop setting `localEnvironmentEnabled`
(`apps/desktop/src/settings/DesktopAppSettings.ts`) turns that off. Changing it relaunches the app;
no local state is deleted. On the next start the main process skips port selection, server exposure,
and the primary and WSL backends, and opens the window right away. The renderer sees this through
`desktopBridge.getLocalEnvironmentEnabled()`: `readPrimaryEnvironmentTarget` returns null, so primary
auth and platform-managed discovery are skipped and only saved environments (pairing, relay, SSH)
connect. This is possible because the desktop renderer is not served by the backend: the `t3code://`
scheme serves the bundled client from disk (Vite in development) and API traffic always goes to the
environment's own URL.
