# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). It provides the Node version
pinned in `package.json` (Node 26), so no separate Node install is needed. The server's
`devEngines.runtime` must match that pin: Vite+ uses the nearest package declaration,
while its `engines.node` remains the published support range. `check:changed` and CI
check each workspace's development Node. CI also tests persistence and migrations
on the newest Node in the published range. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## GitCafe mirror (optional)

GitHub is the source of truth. [git.cafe/pingdotgg/t3code](https://git.cafe/pingdotgg/t3code) is a
two-way synced mirror with much higher API rate limits, which helps when many agents work at once.
You never need it to contribute.

Pushes, PRs, comments, reviews, labels, and issue edits made on GitCafe sync to GitHub within
about a minute, and PR and issue numbers match. CI runs on GitHub, and its checks show up on
GitCafe.

```sh
git remote set-url origin https://git.cafe/pingdotgg/t3code.git
git remote add github https://github.com/pingdotgg/t3code.git
gh repo set-default pingdotgg/t3code   # `gh` is still used for merging
bun install -g @gitcafe/cli@latest   # `cafe` needs Bun 1.2 or newer
cafe auth login && cafe auth http setup
cafe skills install --global  # optional: cafe-* skills for coding agents
```

With `origin` on git.cafe, work through GitCafe and leave GitHub's API alone:

- Push to `origin`, open PRs with `cafe pr create` (`--head owner/repo:branch` from a fork) or
  `cafe stack submit`, and use `cafe` for everything after that. Link the git.cafe PR URL, not the
  github.com one, wherever a tool tracks the PR, so polling stays on GitCafe.
- Read checks with `cafe pr status <n>`, and GitHub Actions logs with `cafe ci logs <run>` (run ids
  from `cafe ci list --pr <n>`). `cafe ci rerun <run>` reruns one. These need `cafe` 0.11 or newer.
- Write closing references as `Fixes pingdotgg/t3code#<n>`. GitCafe turns a bare `#<n>` in text it
  syncs to GitHub into a git.cafe link, and GitHub does not close issues from those.
- Merge with `gh pr merge <n> --match-head-commit <sha>`, because `cafe pr merge` cannot pin the
  commit you reviewed.
- `cafe` commands differ from `gh`: `cafe issue comments <n>` not `--comments`, `cafe pr status`
  not `pr checks`.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev`. An explicit `--home-dir` wins in both cases.
The first start in a worktree seeds its empty database from a read-only copy of
`~/.t3/userdata/statev2.sqlite` if the source is at most 500 MiB. Larger sources warn
and dev starts with an empty database. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding.
To copy a larger source, run `vp run migrate-dev-db` with dev stopped. It may use
substantial disk space before pruning.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Provider logins

A dev server never refreshes the developer's real Claude, Codex, Grok or Pi login. The dev runner
points the server at empty homes under `<home>/provider-homes` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`GROK_HOME`, `PI_CODING_AGENT_DIR`), drops `CLAUDE_CODE_OAUTH_TOKEN`, and keeps Codex MCP sign-ins
in that home instead of the shared OS keychain. Claude and Codex key their keychain items to that
folder, so those items are separate too. These providers show as signed out, and the runner prints
`providers=isolated`. Claude, ChatGPT and other refresh tokens are single-use, so a dev server
refreshing a shared login signs the real app out.

Two providers are not isolated: Cursor keeps its login in the OS keychain, and OpenCode in
`auth.json` under its XDG data folder. Neither has a variable of its own for that place, and moving
`XDG_DATA_HOME` for the whole dev server would also move the tools its terminals run. A dev server
uses their real logins. Anonymous telemetry also reads `~/.codex/auth.json` and `~/.claude.json`,
read-only, to pick its id.

For a test that needs a real provider, run `vp run dev --real-providers` or set
`T3CODE_DEV_REAL_PROVIDERS=1`. The runner then leaves the environment as it is and prints
`providers=real`. Prefer [Replay](#replay-provider) otherwise. If the dev home's `settings.json`
(copied by hand) names a provider home outside the dev home, the runner refuses to start and lists
the fields: remove them or opt in. It does not rewrite your settings. Antigravity profiles already
live under the dev home.

### Replay provider

`vp run dev` registers `Replay (dev)`, a local ACP agent at
[dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts). It plays recorded
ACP transcripts with simulated streaming, so the real adapter, orchestration, and UI run
without a paid model. Each scenario is a model, and each prompt plays the next recorded turn.
Bundled servers, including desktop dev, skip it because they have no agent script.
Dev servers add it back on start, so turn it off in Settings instead of removing it.
To add a scenario, point a `SCENARIOS` entry at a generic ACP replay fixture
(`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay).
The agent replays session updates, permission requests, and questions. It drops session setup
and vendor frames, so Grok and fx recordings lose their vendor-only behavior.

### Profiling dev startup

Run `vp run profile:startup` to capture the first 20 seconds of inherited Node processes under
`.t3/startup-profiles/<timestamp>`. Workers that execute the preload get separate profiles.
It starts the normal dev runner and accepts its flags.
Stop it with Ctrl+C after the capture. Set `T3CODE_STARTUP_PROFILE_DIR` to choose another output
directory. Profiling adds overhead, so compare readiness with an ordinary `vp run dev` run.

Open a `.cpuprofile` in Chrome DevTools' Performance panel for sampled function stacks and source
lines. Each `.modules.json` is a Chrome trace containing timed module resolution, loading,
synchronous subprocess calls, and startup measures. Per-file records include importer URLs,
source loading, preparation, recursive dependency linking, and top-level evaluation. Preparation
uses synchronous loader boundaries; linking includes dependencies, and CommonJS evaluation can
include nested `require` calls. Some ESM/CommonJS interop reports a combined stage. `.process.json` records the process, Node version, and capture window.
The server's nested Effect and SQL spans remain in `.t3/userdata/logs/server.trace.ndjson`.

The preload temporarily adds module-body timing markers and uses one automatic debugger pause
to instrument the live Node loader. The launcher adds `--no-node-snapshot` to inherited
`NODE_OPTIONS` because Node 26's snapshotted loader cannot accept that breakpoint. Include the
same flag when using the preload directly. This disables Node's built-in startup snapshot,
can change compilation-cache hits, and adds overhead.
Treat per-file captures as diagnostic runs; use uninstrumented runs for baseline startup latency.
The first entry module can compile before loader instrumentation is installed.

A fresh process still uses filesystem, Node compilation, provider, and Vite dependency caches.
Measure a missing Vite dependency cache separately from a restart with an existing database.
Neither the Vite ready message nor the HTTP listener proves that a browser has rendered the app.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

`vp run dev --share --built` skips the Vite dev server. It runs `vp build --watch` for the web
app, and the backend serves `apps/web/dist` on the same tailnet URL and pairing flow. Use it when
someone tests over a slow link or only needs to use the app: loads are production size, and the
first load does not wait for dev bundling. There is no HMR. After an edit, wait for the
`built in` line (about 6 s), then reload. Until the first build exists, the URL shows a page that
reloads by itself. The license manifest is not generated in this mode. `--built` requires
`--share` and the `dev` mode.

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3.CodeShip. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the third-party license notices, the generated GraphQL checks, typecheck
of the affected packages and their dependents, the test files beside the changed files, and the
test files that import a changed file directly or through test-support code (a `*.testkit.ts`, a
`testkit/`, `testing/`, `test/` or `fixtures/` folder), and the test files beside each production
file that imports a changed file. The walk goes no further into production code, so a provider's
replay suites and the service built on a changed module run, but not every test that loads the server.
It runs exactly those files, and one that its package's config leaves out passes, as
`vp test run --passWithNoTests` would. It also runs the checks that read other files: the agent context budget when the server is
affected, and React Compiler coverage for only the changed web and mobile files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the closest merge base with any remote's `main`, so a fork whose `main` lags
upstream still compares against upstream, or with a ref you pass. Before any check it installs
`pnpm-lock.yaml` with `--frozen-lockfile`, as CI does, so a branch rebased onto new dependencies
is checked against them, and a `package.json` the lockfile does not match fails at once. Upstream CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.

The steps run side by side, as many at once as the machine allows: one per two cores and per 6 GiB
of available memory, with a typecheck per affected package and the test step's workers counted
too. Runs in every worktree of the repository share that budget, so several agents checking at once
take turns instead of overloading the machine; a run that finds every slot taken says so and waits.
On a large machine a run takes about as long as its slowest step, usually
knip's exports pass at about 10 s. Pass `--concurrency <n>` or set `CHECK_CHANGED_CONCURRENCY` to
change the limit (`1` runs the steps one by one). A step that runs past `--timeout <seconds>` or
`CHECK_CHANGED_TIMEOUT` (default 900), counted in time the machine is awake, is killed with every process it started and reported as
`TIMEOUT`, not as a failing check. On macOS, if the machine slept during a failed test attempt, failed and unfinished groups run once
more. A run whose checkout changed while it ran fails and lists the
changed paths. One nobody edited was written inside the checkout by a check or a tool, which should
write under the system temp folder or a gitignored folder instead. Test groups run concurrently within the test step's worker
budget. Server groups run in up to four independent serial chains alongside other packages, with each
running group isolated in its own short temp folder (under `/dev/shm` on Linux when writable,
executable, and with at least 2 GiB free, under `/tmp` on POSIX when the system temp path is long,
otherwise the system temp folder) that is removed when the group ends. If Vite+ interrupts an in-flight
group after another group fails, the test step runs it again and reports failures across the full
selection. A run under the landing turn stops at its first failure instead, since it can no longer pass: the first step to end
`FAIL` or `TIMEOUT` stops the others, which report `STOPPED`, and the first failing test group ends the test step. Each run uses a private copy of a cache that every commit with the same install shares;
once that cache reaches 256 MiB, runs start a new one, and a cache is removed after three days
without a run. When the test step ends, even after a timeout or interruption, it publishes passed
groups if HEAD and runtime inputs still match. A change to either fails the test step. A
force-killed run leaves its unpublished results in the private copy. Retries and rebases across
worktrees and chats, each with its own install, reuse a group when the tree's file modes, link
targets and gitlinks, execute access, the group's inputs, install state, tracked environment, user,
umask, and host capabilities match, at any commit. A group's inputs are the checkout files its tests
read, hashed when the group ends. A group in which a Git process opens, clones or fetches from this
checkout, or names it or its Git directories in an argument or a `GIT_DIR`-style variable, as Git's
trace2 events report, also keys on HEAD, so it reruns at every commit. Git run with `GIT_*`
variables removed or replaced, Git given a relative path to the checkout from a folder outside it,
or a test that reads `.git` itself escapes that and needs an uncached task. The machine's programs,
network interfaces and cgroups, Git state beyond the commit (the index, refs, config and other
branches, which a group that reads Git does not key on either), the read and write permissions of
checkout files, and files another process rewrites during the run are not
inputs, so a pass still replays after a program its tests run
changes or goes away. A test whose coverage they decide, such as one that skips cases without a
program or a cgroup it may join, or runs a program a variable names, or that writes a report another
step needs, needs an uncached task. A group runs its files with the options of the test script of
the nearest enclosing package that has one, as CI runs that package's suite. `check:changed` passes a
test that package's config leaves out, so it refuses a script that adds anything but
`--passWithNoTests`, `--config`, `--dir` and `--project` with literal values: a filter such as a file
name or `-t` would pass a test it never ran, and `|| true` would hide a failure. The repository
command guard checks every package's test script when a manifest changes, so the change that adds
such a script fails, not the next one that changes a test in that package. A test that skips without a host capability, such as file symlinks or the IPv6 loopback,
reads it from `packages/shared/src/testing/hostCapabilities.ts`. The command probes those
capabilities once, keys the cache on them and passes them to its tests; a probe of the test's own
would replay the skip after the host gains the capability. With `T3CODE_TEST_KEEP_PROVIDER_ENV=1`,
every group runs uncached, because only uncached tasks get the provider variables it keeps. When the
whole-run cache matches, the command validates the selected groups and reuses the previous summary
for the other checks.

Editing a changed file during checks fails the run because tests keep the first version they
load. Editing and restoring a file during a run, or changing an installed package in place, can
invalidate even an uncached verdict. A generated declaration that the checks themselves rewrite
keeps the whole-run pass out of the cache, and fails a run that reused an earlier pass, because
only its tests saw the new file. The test step's
limit grows by two minutes per selected test file, because each server chain runs its test files one at a time.

The checks select their files from the tree a commit of the checkout would get under Git's own
settings: tracked changes and untracked files that are not ignored. Each pass, a cached one
included, records that tree. The receipt lives in the repository's git
directory, so every worktree shares it. The tracked pre-push hook
([.vite-hooks/pre-push](../../.vite-hooks/pre-push), through
[check-changed-receipt.cjs](../../.github/scripts/check-changed-receipt.cjs)) refuses a push to
`main` unless a pass covers the pushed commit's tree and compared it against the commit the remote's
`main` is at, so every change the push brings was checked. Land from a worktree with nothing to commit
and no scratch files: the landing (below) runs the checks after its rebase, against that commit. Git runs these
hooks itself because `core.hooksPath` is `.vite-hooks`: `machine-config.json` declares that, and
`node ~/.agents/tools/machine-config.mjs check <checkout> --fix` applies it. A checkout with no
install still runs the push gate. `prepare` does not run `vp config`: it would point `core.hooksPath` at its
generated `.vite-hooks/_` shims, which exist only after an install.

While you iterate, run single checks:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node. No package install fetches that Chromium: `vp run check:changed`
installs it, and before running browser tests yourself on a new machine or Playwright version, run
`node apps/web/node_modules/playwright/cli.js install --only-shell chromium`.

TypeScript workspaces typecheck with `tsc`. The `typescript` catalog entry is
`@tsc-rs/typescript`, the tsc-rs drop-in, with Effect diagnostics, quick fixes, and
refactors built in. VS Code uses it through `js/ts.tsdk.path` in `.vscode/settings.json`.

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
CI runs the `apps/server` suite on Windows too, as eight duration-balanced `Test Server Windows`
shards. To reproduce one locally on Windows, run `vp test run --shard N/8` from `apps/server`. In a
fork, [windows-check-fork.yml](../../.github/workflows/windows-check-fork.yml) runs `check:changed`
on Windows for every push to `main`, because the push gate runs it only on the machine that pushes.
After landing, the ship skill and the upstream sync run
`node .github/scripts/windows-check.cjs <commit>`, which waits for that commit's run and exits 3
with its failures when it does not pass. Without a token GitHub shows no runs of a private fork, so
there it exits 3 as `unreadable`.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

### Landing on main

A pass of `check:changed` covers only the tree it checked, and main moves faster than a slow machine's check, so landers wait in a first-come, first-served queue on origin. `node .github/scripts/landing-turn.cjs land` takes its turn by claiming the lease at `refs/heads/landing-lease/main` on origin. One atomic push then moves main and deletes the lease (and any candidate ref), and origin refuses it unless the lease is still the commit this lander holds. Before the wait it rebases onto main and runs the checks, so a conflict or a failing check shows at once and holds no turn, and each run of the checks reads a private checkout of the commit to land (a detached worktree from the clone's bounded warm pool in the user's cache folder—at most two, capped further by the machine's check budget `min(floor(cores / 2), floor(totalMem / 6 GiB))` and overridable with `T3_LANDING_WARM_CHECKOUTS`—reset to the commit but for its `node_modules`, so `vp i --frozen-lockfile --prefer-offline` and Vite+'s cached typechecks start warm; a slot left dirty by a killed holder or whose `vp i` fails is rebuilt cleanly). Pre-turn checks never create overflow checkouts: while every warm slot is busy they wait in a local first-come, first-served queue backed by OS-released SQLite locks, and once a waiting lander takes a slot it re-checks its worktree and rebases onto fresh `origin/main` in place before checking if main moved while it waited. Only the turn holder (`turn !== null`, for `finalize` or an under-turn re-check) falls back to a transient overflow checkout when all warm slots are busy, stopping any active child tree before removing it after the run or on stop, so it never stalls behind pre-turn landers. Thus an edit to the lander's worktree meanwhile cannot reach the checks, and a turn lasts for the push alone unless main moved during the wait; then the lander rebases and checks again under the turn. When a holder must run `finalize`, an under-turn re-check, or await an in-flight speculative pre-check, it atomically publishes its candidate commit to `refs/heads/landing-lease/candidate` (and records `candidate` on the lease commit) and removes it on push, release, or lapsed-lease takeover; the first waiter in the queue speculatively rebases and pre-checks a private checkout against that candidate without touching its worktree or claiming under-turn priority, and if the holder lands that exact commit and the rebased tree matches, the waiter reuses the pass (still running `finalize` if configured), skips `underTurnCheck`, and pushes straight to `main`. A branch that was behind main starts again from the rebased tree, so the wait and the turn run the rebased copy of the script, which holds main's changes to it. A lander pushes the commit its checks passed for, stops if its checkout moved to another commit while it ran, and gives up on a fetch or push of main that does not finish within ten minutes awake; one the machine slept under runs again.

The lander renews the lease every few minutes, so a lander that dies or sleeps frees main within ten minutes, and a turn ends three hours after its take. Before its push the lander renews the lease once more, and it stops a push that would outlast that lease. A push whose answer was lost counts as landed when main is at its commit or descends from it. A waiting lander treats a lease as given up once it has watched it unchanged for ten minutes awake, or, for a holder on another machine, once its clock says the lease was last renewed more than twenty minutes ago, so a waiter whose clock runs less than about 15 minutes ahead never takes a lease its holder still renews (10 minutes while the holder pushes). A holder on the waiter's own machine slept whenever the waiter did, so a sleep they share hands over no lease. Until every machine lands with this version, a waiter on an older one, which goes by the lease's expiry alone, can take a holder's lease when its clock runs more than about 5 minutes ahead; that holder then loses its turn and pushes nothing, so main stays intact. A lander also records the turn it takes in its clone's Git folder, so on Linux a waiter in a worktree of that clone takes over a lease whose lander has exited in the same kernel boot and PID namespace with no push to main in flight, without waiting for it to lapse. `node .github/scripts/landing-turn.cjs holder` prints the current lease and, when a worktree of this clone took it, the checkout and process that hold it.

A call to origin that runs past its limit, and the checks of a lost turn, end with every process they started: on macOS and Linux each runs in a process group of its own, which also ends when the lander dies, and on Windows the shared tree walk ends it. The queue drops entries that stop refreshing, and a waiting lander gives up only once neither the queue nor the lease has moved for longer than a whole turn. Origin is public, so a lease and a queue entry name their machine by the first 12 hex digits of the SHA-256 of its host name; `node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:os").hostname()).digest("hex").slice(0,12))'` prints this machine's. `.vite-hooks/pre-push` refuses a push to `main` from anyone else, one that does not delete the lease in the same push, or one for a tree no pass covers (the hook cannot tell whether a push is atomic, so land only with `land`), and a `check:changed` run the lander starts under the turn has the machine's check budget to itself: from its first step until it ends, other runs start no new step, while steps they already run finish. `vp run check:changed` for your own work needs none of this.

Every `land` run, failed ones included, appends one JSON line to `t3-landing/landings.jsonl` in the clone's common Git folder (`git rev-parse --git-common-dir`): its start time, branch, base and head commits, final status (`conflict` for a rebase that stopped, `error` for another failure that throws), the stage it ended in (`before-wait`, `waiting`, `under-turn`, or `remote`, which tells where a check failed), whether the turn's release was confirmed (null when it took no turn), whether a speculative pre-check was reused (`speculativeReused`, present when speculation ran), whether landing ran on a remote host (`remote`, boolean only—never a host name or path), and its total and per-phase milliseconds (`rebase`, `localSlotWait` when a pre-turn lander waited for a local warm checkout slot, `checkSlotWait` when an inner `check:changed` run waited with zero slots held for another run's shared budget slots, `preWaitCheck`, `waitForTurn`, `speculativeCheck`, `finalize`, `underTurnCheck`, `push`, or `remoteProbe`, `stagingPush`, `remoteLand` for remote landings). A run that rebases before its wait and starts itself again writes one line. A full file of 1,000 lines moves to `landings.1.jsonl`, replacing the one before it, and a killed lander writes nothing.

Waiting landers stagger their polls and reuse a lease commit's metadata until origin advertises a different commit. When a fallback lease release fails, the lander retries for up to ten minutes awake; if release still cannot be confirmed, the command prints any landed commit and exits nonzero.

To offload a landing to another machine over SSH, pass `--remote <host[,host2,...]>` (or set `T3_LANDING_REMOTE_HOST`), optionally with `--remote-dir <path>` (or `T3_LANDING_REMOTE_DIR`) when the remote checkout is not in a standard location (`~/CodeShip`, `~/code/CodeShip`, `~/dev/CodeShip`, `~/repos/CodeShip`, `~/src/CodeShip`, or `~/projects/CodeShip`); single-quote tilde paths locally (for example `--remote-dir '~/CodeShip'`) so the local shell does not expand `~` to the local home directory. Remote targets must be POSIX SSH hosts (Linux or macOS, not Windows PowerShell or `cmd.exe`). Pass `--local` to force local landing when `T3_LANDING_REMOTE_HOST` is set (`--local` cannot be combined with `--remote`). After running the same local worktree cleanliness checks first, the lander probes every listed host concurrently over batch-mode SSH, checks that its checkout matches this repository's `origin`, and picks the reachable host with the lowest normalized 1-minute load (`load1 / cpus`, preferring known load and preserving list order on ties). If no candidate host is reachable or ready, it logs why and falls back cleanly to local landing. Once a host is selected, it pushes `HEAD` to a unique staging ref under `refs/heads/landing-staging/`, runs `landing-turn.cjs land` (with `--finalize` forwarded and `T3_LANDING_REMOTE_HOST` cleared) in a temporary remote git worktree without touching the remote host's main checkout, always removes both the temporary worktree and the staging ref on `origin`, and syncs the local branch to the landed commit if the local worktree stayed clean and at the original commit. Once remote execution has started, a remote check failure, conflict, or mid-run SSH disconnect never falls back to local landing so two landers cannot race on the same change.

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

The staged app, the Windows server sidecar and the CLI archive install exactly the versions in the
root `pnpm-lock.yaml`, with the root workspace's patches, overrides and package extensions. A
package, dependency or patch the root lockfile does not hold, or a dependency it lists that the
stage would drop, fails the build instead of resolving from the registry, so run `vp i` and commit
the lockfile after changing a dependency. Staged installs get only the allowlisted variables in
`scripts/lib/child-env.ts`, so their install scripts never see signing, notarization or registry
credentials.

Release jobs build in two steps so no install runs with signing credentials: `--phase stage
--stage-dir <dir>` builds and installs everything that ships into an empty `<dir>`, and `--phase
package --stage-dir <dir>` signs and packages that stage for the same platform, arch, target and
version at the same commit. `scripts/build-cli-archive.ts` takes the same two flags.

Every desktop build stages Electron the same way: it downloads the zip for each target
architecture into `<stage>/electron-dist` and checks it against the SHA-256 in the locked
`electron` package's `checksums.json`, and electron-builder unpacks that zip instead of
downloading its own. `ELECTRON_MIRROR` sets the download host. Mac App Store targets (`mas`,
`mas-dev`) are rejected: they package Electron's separate Mac App Store build, which staging does
not download.

### Prepared server bytecode

Native macOS and Windows desktop artifact builds generate server bytecode with the packaged
Electron executable, after ASAR creation and before signing. Linux builds skip generation until
native packaging and relocated AppImage reuse have been validated. Cross-platform and
cross-architecture builds also skip generation explicitly. CLI, SEA and WSL runtimes keep their
existing behavior; only desktop backend imports covered by generation receive prepared bytecode.
Worker-only modules compile normally.

Electron's Node 24 cache has no read-only option and includes the producer UID in its directory
name. The backend links individual prepared files into its writable cache with keys for the
installed module paths. Node replaces files atomically, so regeneration cannot write through those
links into signed resources. Windows uses hard links and falls back to normal caching when volumes
differ or resource permissions prevent linking. Protected installations therefore may not reuse
prepared bytecode. No cache bytes are copied during startup.

The key calculation follows Node's internal portable ESM format. Generation checks that the
packaged engine produced the expected CLI entry and fails the build if that format changes.
The manifest also checks Electron, Node, OS, architecture and V8's flags-sensitive version tag.
Missing or rejected entries compile from the shipped JavaScript. Prepared backends skip the
explicit startup flush; Node can persist missing entries on normal exit. The writable fallback
keeps the explicit flush needed when Windows force-kills the backend.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.

## Working notes

- **Home.** The fork lives on GitHub (`GigaZoro/CodeShip`, remote `origin`); there is no Azure DevOps repository or `ado` remote. `gh` in a checkout defaults to upstream `pingdotgg/t3code`, so pass `-R GigaZoro/CodeShip` for the fork's runs and releases, and check `gh api repos/GigaZoro/CodeShip/actions/workflows` before relying on CI: `release-fork.yml` runs no tests, so `check:changed` is the only test gate.
- **Follow-ups.** The fork's GitHub Issues are off. Implement a suggested fix; what cannot be finished goes in the private Azure DevOps project `CodeShip` through agent-config's `long-term-fix.mjs`, and is started at once.
- **A worktree without setup.** With no `node_modules` and no `.t3/setup-*` marker, run `T3CODE_PROJECT_ROOT=<main checkout> node scripts/setup-worktree.ts` (about 15 seconds). Without the variable it throws and writes `.t3/setup-failed`.
- **A stale worktree.** A work order can name a commit newer than the worktree's base. Run `git fetch origin` and `git log --oneline HEAD..origin/main -- <files>` first, and rebase before designing.
- **Branch names.** A worktree starts on `t3/<id>` and CodeShip renames it to `cs/<slug>`; read `git branch --show-current` before deleting. A hook blocks `git checkout -- <file>` and `git branch -d`; use `git branch --delete`, and set `--set-upstream-to=origin/main` first when the main checkout's HEAD lags and refuses a merged branch.
- **zsh.** Brace a variable followed by `:` (`"${head}:refs/heads/main"`): `$head:refs` hits the `:r` modifier. `status` is read-only, so use `rc`.
- **Landing on a busy main.** Each shipment prepends to `docs/release-notes.md`, so the landing's plain `git rebase` stops on that conflict when its base is older than main. Resolve with your entry above main's, `git add`, `GIT_EDITOR=true git rebase --continue`, and land again; re-date your heading when main has a later entry. The landing merges `agentContextBudget.json` itself (main + yours − base per key); after the same conflict in a manual rebase, do that sum and run `AgentContextBudget.test.ts`. A landing keeps a Mac from idle-sleeping, but closing the lid still sleeps it. Land through `t3_command_run` with `timeoutMinutes: 720`; a full check took about 14 minutes.
- **Seeding the dev database.** The live database is over the 500 MiB auto-seed limit, so `vp run dev` starts empty. `vp run migrate-dev-db --projects 30 --threads-per-project 3` took about 15 minutes on a 5 GB source: start it early. Otherwise add a scratch git repo with `node apps/server/src/bin.ts project add --base-dir ../../.t3 <path>` from `apps/server`.
- **Dev server limits.** Provider homes sit under `<worktree>/.t3/userdata/providers/...`, so model-backed features fail with "Not logged in": run the prompt builder from a script with `claude -p --model claude-haiku-5-5` and insert results into the dev database. Before a test that starts chats, set `defaultModelSelection` to `{instanceId: "devReplay", model: "showcase"}` and disable every other provider instance in the dev `settings.json`. No-project threads fail inside a git checkout; copy `.t3/userdata` outside any repo and run `vp run dev --home-dir <folder>`. The default Browser panel profile carries so many localhost cookies that Vite answers 431: open with `profileId: "incognito"` and a token from `node apps/server/src/bin.ts pair --base-dir .t3`. Stop a `nohup` dev run by the owners of its two ports (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`) after checking their cwd; the wrapper's PID is not enough. Never print a secret file.
- **Replay tests of the timeline.** Prompts sent with `t3 thread send` are Agent messages with no "Edit from here"; type the prompt in the composer to test that. For the "New since your last visit" divider, open the thread, leave, send another prompt, let it finish, reopen.
- **A component capture without the Browser panel.** A temporary `*.browser.test.tsx` importing `~/index.css`, with mocked state hooks and `page.screenshot({ path })` inside the repo (`.t3/capture`), run with `vp test run --project browser <file>` from `apps/web`. Delete it afterwards.
- **Preview guest drawing.** Fake-based host tests cannot show whether Chromium draws a preview guest. Run an Electron main script (`apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <script.mjs> <DesktopBrowserHost.ts> <effect Effect.js>`) that imports the real host, and test both parkings: the Mac keeps an inactive webview visible offscreen, Windows and Linux use `visibility:hidden`.
- **Mobile on the Mac.** Android emulators work (`device_list`, then `device_open` the AVD); iOS needs Xcode and an Apple ID sign-in, so say iOS was not checked. `vp run mobile:install android` needs `JAVA_HOME` and `ANDROID_HOME`; the Device panel needs `ffmpeg` with libx264 and `java` on the server's PATH. `open` fails with `DEVICE_IN_USE` while another thread holds the emulator: never close its session, retry with `--wait 120000` (larger values are refused). If the emulator is shut down under you (`SESSION_NOT_FOUND`), `device_open` again.
- **The mark.** The Angleboat logo (`M14 3v6l-6 6l6 3v4l-12 -6zM18 3l12 13l-12 6v-4l6 -3l-6 -6zM3 25h26l-4 4h-18z` in a 32 grid) is duplicated in both `CodeShipMark.tsx` files, `assets/prod/logo.svg` and `apps/mobile/assets/widget/T3Mark.svg`, and `MARK_BOUNDS` in `scripts/export-android-icons.ts` must match it. After a change run `vp run icons:export`, `icons:export:android` and `icons:check`.

## Diagnosing provider and machine failures

- **Only Codex turns fail** with "did not load/resume the conversation within 5 minutes" while Claude works: the shared Codex app-server (`provider-session:provider-instance:codex:shared`) is stuck on dead connections. Look in `~/.codex/logs_2.sqlite` (query a narrow range; the file is large) for requests with no response, and check that the provider log's `thread/start` and `thread/resume` ids got no reply. `ProviderSessionManager.releaseIfSilent` releases such a session so the retry opens a new process; if the error repeats, look at the network or the account.
- **`model_not_found` "not supported when using Codex with a ChatGPT account"** usually means the Codex CLI is too old for the model. Compare `cliVersion` in the `thread/start` result (or `cli_version` in the first line of `~/.codex/sessions/.../rollout-*.jsonl`) with the latest, and probe with `CODEX_HOME=<instance>/shadow <codex binary> exec ... < /dev/null`. A running app-server keeps its old binary until it restarts. Never change the user's model pick, and change settings only through CodeShip's tools.
- **Evals** run on the Codex subscription: set `CODEX_BIN` to the managed binary (`~/.t3/tools/codex/<version>/bin/codex`) and `CODEX_HOME` to the instance's `shadow` folder. Never copy an `auth.json` (two copies sign each other out).
- **Another machine's database.** Delegate a read-only task there (`delegate_task` with `target.environmentId` and a `projectId` that exists on that machine) whose brief holds a complete script opening `statev2.sqlite` with `new DatabaseSync(path, { readOnly: true })`. Events are in `orchestration_events` (`aggregate_kind = 'thread'`, `stream_id`, `sequence`, `event_type`, `occurred_at`, `payload_json`), not the empty `orchestration_v2_events`; effects in `orchestration_v2_effect_outbox`. Keep output short, and query a live database by sequence range: a full scan of a 17 GB one times out.
