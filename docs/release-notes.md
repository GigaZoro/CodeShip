## 2026-11-24 — Open a thread beside the one you are reading

- Right-click a thread and choose **Open in side panel**, or Alt-click (Option-click on Mac) to open it beside your current thread.
- In the command palette, highlight a thread and press **Alt+Enter** (**Option+Enter** on Mac). Use **Open in main view** to move the thread into the main view.
- Opening a file, browser tab, pull request or side chat from a thread in the side panel moves that thread to the main view with it open.

## 2026-11-24 — Scheduler test coverage

- Scheduler changes run the notebook cleanup test and skip 29 unrelated attachment cases. Changes to attachment handling or document extraction still run all 30.

## 2026-11-24 — Changed-file checks resume completed test work

- Maintainers: `vp run check:changed` saves passed test groups when the test step ends and its inputs still match, so a retry after a timeout, in any worktree or chat with its own install, reuses them at the same commit with the same file modes, matching inputs, tracked environment, user, umask, host capabilities, Git version, system Git configuration, and Git ignore and attributes files under `~/.config/git`. Its tests run without your global Git configuration, as on CI, so a setting there such as a hooks path or commit signing no longer changes them.
- Maintainers: `check:changed` and the weekly upstream sync read Git's file lists as Git wrote them, so a file whose name has a quote, backslash, non-ASCII character or leading space is no longer misread. `check:changed` and `test:cached` stop with the name of a file whose name is not UTF-8 instead of leaving it out, and the upstream sync stops at a conflicted file whose name is not UTF-8. A rebase, merge or upstream sync that merges the release notes keeps a byte in them that is not UTF-8 as it is. `test:cached` stops when `--uncached` names a file the checkout does not hold, instead of running that file cached. `check:changed` skips a test the working tree deleted and no longer fails when a file replaces a tracked directory. `check:changed` takes its files, and the tests beside them, from the tree it records for the push gate, so it checks what a commit of the checkout would hold under Git's own ignore and case settings: an ignored test beside a changed file no longer runs, and a changed file that tree names in a case the disk does not hold stops the run. It finds the tests beside a changed file, and the tests that import it, where Git, the disk and an import spell a name or folder in different cases or Unicode forms. It runs them through the same exact-file runner as `test:cached`, under the test script of the nearest enclosing package that has one, and a test that package's config leaves out passes, as `vp test run --passWithNoTests` would. It refuses a package test script that adds anything but `--passWithNoTests`, `--config`, `--dir` and `--project` with literal values, since a filter such as a file name or `-t` would pass a test it never ran, and `|| true` would hide a failure; a change that adds such a script fails its own check instead of a later one. A change under the vendored `.repos/` references, in any case Git spells the folder, no longer runs their tests, and they no longer count toward a run that selects every test. Both stop at a test Git lists whose path holds a backslash, which Vitest cannot run, instead of passing without running it.
- Maintainers: the tree `check:changed` records for the push gate now holds a same-size edit made in the second Git last wrote the index, so such an edit no longer fails the run with "files changed while the checks ran" or lets the gate accept a pass for the older tree. It also reads that tree in a checkout or temporary folder whose path holds `:` (`;` on Windows), which Git used to split into two paths.

## 2026-11-24 — Maintainer scripts share one limit for Git output

- Maintainers: the PR size label no longer fails on a pull request that changes thousands of files, such as a sync of the vendored references. It, the release-notes driver, the evals, `test-cached`, the background-live verifier and the mobile showcase read Git output up to the shared 256 MiB limit, instead of Node's 1 MiB default or their own 32 MiB and 64 MiB limits.

## 2026-11-24 — A landing takes over a turn its lander left on the same machine

- Maintainers: a lander records the landing lease it takes in its clone's Git folder, and on Linux a lander waiting in another worktree of that clone takes the turn over once that lander has exited in the same kernel boot and PID namespace with no push to main in flight, instead of waiting up to three hours for its lease to expire. `node .github/scripts/landing-turn.cjs holder` prints the current lease and, when a worktree of this clone took it, the checkout and process that hold it.

## 2026-11-24 — The upstream sync lands the commit it verified

- Maintainers: `node scripts/upstream-sync.ts check` records the commit its pass covered, and `land` pushes only that commit and reports it. Both refuse a checkout with uncommitted or untracked files, and `check` one that does not hold the upstream merge, such as one reset to main or a commit with the merge's files on main's commit.
- When the checkout is not on the checked commit, `land` reports `unchecked` with both commits instead of pushing, and a push whose reply was lost counts as landed only when main holds the checked commit. When main moved, `land` merges it into the checked commit without moving any branch or the checkout, and returns the merge for the sync to fast-forward to and check again. The release notes merge by date with the repository's merge driver, the sync's entries above main's of the same date, and a merge that leaves Git anything else to decide, such as a directory rename split, holds instead.
- Maintainers: the upstream sync, landings, the `check:changed` receipt and the release-notes check no longer stop with `ENOBUFS` when Git prints over 1 MiB, such as a merge of main with thousands of conflicts, or release notes past 1 MiB, which they would have reached within weeks.

## 2026-11-24 — A landing checks before it waits and gives the turn back reliably

- Maintainers: `node .github/scripts/landing-turn.cjs land` rebases a branch that is behind main and runs `check:changed` before it waits for the landing turn, so a conflict or a failing check stops it at once and holds no turn. It first lists, once, the other local worktrees with unmerged work on the same files, so a conflict comes with the work to reconcile it with. When main stays still during the wait, the turn lasts for the push alone; when main moved, the lander rebases and checks again under the turn. A landing whose checkout moved to another commit while it ran stops instead of landing a commit its checks did not cover, and a fetch or push of main that stops answering ends the landing after ten minutes instead of holding the turn until it expires.
- A branch that was behind main starts the landing again from the rebased tree, so the wait and the turn run the rebased copy of the landing script, with main's changes to it, instead of the copy the branch started from. It continues through a command of its own, so a copy that cannot continue such a landing refuses it instead of starting another.
- A landing tries again when a passing network failure stops it from giving the turn back, instead of leaving the turn held for up to three hours.
- The pre-push hook lets a push that only gives the landing turn back through without loading the checkout's scripts, so a checkout whose landing script does not load can no longer leave the turn held. It also reads each pushed ref from the right, so a push to main whose source is a revision with a space in it, such as `HEAD^{/fix it}`, no longer skips the landing turn and the `check:changed` pass.
- The landing turn's timeout test holds its stalled push until it releases it and gives the git reads around that push ten seconds instead of two. The testing guide says how to test a timeout that way.

## 2026-11-24 — Faster replay fixture cleanup checks

- Replay fixture cleanup tests now load only the configuration they exercise, shortening local test runs.

## 2026-11-24 — Agent launches and model changes refuse options the model does not offer

- `t3_thread_launch` now checks the options of a given model as `delegate_task` and `create_threads` do, and refuses one the model or account does not offer, naming it, instead of starting a thread that silently runs without it (such as `serviceTier` on a managed Codex account).
- A task delegated to a linked machine is refused an option named for it that the model there does not offer. Options it inherits from your chat that the model there does not offer, or that your chat repeats, are dropped, as for a task on this machine. A linked machine on an older version still takes the task with every option, as before, and a task from an older machine has the options its model does not offer dropped rather than refused.
- A retried launch keeps the model and options it was accepted with.
- `t3_thread_configure`, a project's default model set with `t3_project_create` or `t3_project_update`, and a scheduled task's fallback models refuse a model or option the provider does not offer, naming it, instead of saving a selection a later turn cannot run. A fallback on an account this machine does not have, or has not installed, is left for the machine that has it.

## 2026-11-24 — See what needs you from a new thread, and submenus that stay on screen

- On web and desktop, a new thread's empty composer lists the threads that need you, as the sidebar's Needs you does, before your recent threads. Recent threads list running threads first, latest started first, then the threads you last sent to, and follow the sidebar's project and machine scope and its scheduled-task placement.
- On web, a context submenu with no room on the right opens to the left of its item and stays there, and deeper submenus keep going the same way instead of covering the menus they came from. In a right-to-left layout, submenus open to the left and the Left arrow opens them.

## 2026-11-24 — Claude starts with Ultracode exactly as the chat sets it

- A Claude chat or delegated task with Ultracode off could still start with it on when the Claude launch arguments turned it on, with `ultracode` in `--settings` or with `--effort ultracode`. Starting a chat now follows the model's Ultracode toggle and effort, the same as switching models mid-chat, so Ultracode stays off unless you turn it on. Generated titles, commit messages and pull request text follow the model's Ultracode and Fast mode toggles over the launch arguments too. When your organization's managed Claude settings set `ultracode` to the other value, Claude Code would ignore the toggle, so the message is refused with the reason instead, and the chat stays as it was.

## 2026-11-24 — Resume chats promptly after a restart

- A chat ready to resume while the server checks its memory queue now starts as soon as memory permits, including during startup.

## 2026-11-24 — Keep schedule edits made during a missed run

- Editing a task while the scheduler skips a missed run now preserves the new schedule. Run history records the skip only when the scheduler advances that occurrence.

## 2026-11-24 — Preserve ignored symlinks during worktree release

- On macOS, worktree owners can save ignored dependency trees containing relative or dangling symlinks. When a release request fails before publication, CodeShip removes redundant backup links where the checkout still has the original files.

## 2026-11-24 — Release a delivered task’s worktree

- Checkout owners can queue a release for one completed run, save its ignored files, and name the refs that preserve its history. The server waits for delivery and teardown, then releases the checkout. A follow-up opens a fresh checkout.
- Worktree cleanup can finish a progressing inspection that takes longer than thirty seconds. A stalled or incomplete inspection keeps the checkout.
- Commands, terminals and providers can start in other checkouts throughout a release. A damaged release request keeps its checkout and allows other releases to finish.

## 2026-11-23 — Cached test results

- The cached test runner applies the package’s Vitest configuration and checks that every selected file produced a result in each scheduled project before caching success.
- Package filters and runtime settings follow `vp test run`. If overlapping projects produce results that Vitest cannot attribute to a single project, the runner reports an incomplete group and leaves it uncached.
- A stale Git entry beneath a directory replaced by a file no longer interrupts selection of other tests.

## 2026-11-23 — Relay executable validation

- CodeShip requires the relay’s version command to exit successfully before selecting an executable or activating a download. It retries a failed version check the next time it looks for the relay.

## 2026-11-23 — Windows landing checks

- The landing tests exercise lost Git push replies, expired leases, and large lists of changed files on Windows using temporary repositories.

## 2026-11-23 — OpenCode questions and permissions

- On resumed chats, OpenCode routes questions and permission requests to their originating turn when the native session identifies it.

## 2026-11-23 — Replay of accepted sends and delegations

- Retrying a keyed send recovers its original delivery after the run settles or its thread is archived. Repeated delegations resolve to the task and destination first accepted.

## 2026-11-23 — Replay tests release their temporary files

- Provider replay tests remove their temporary directories when they finish, fail, or are interrupted, preventing repeated runs from filling the disk.

## 2026-11-23 — Accounting for provider background work

- Background completions in ACP, Claude, Codex and Muse carry their originating run when it can be identified. Duplicate ACP completion notices are counted once. Retrying a failed wake retains the original task even when a later task reuses its ID. Replacing an ACP runtime or a Muse host clears its pending reports.

## 2026-11-23 — A scheduled chat starts with what its run condition found

- When a task's **Check before running** command finds work, the chat it starts now gets the check's reason, and the `unit` its JSON answer names (a work item, a pull request or a settlement id), at the end of its first message, so the agent starts on that work instead of looking for it again. **Run history** shows the same reason and unit.

## 2026-11-23 — Remote delegation test coverage

- Remote delegation tests now exercise keyed launches with the destination thread’s actual project, modes, and link ownership.

## 2026-11-23 — Access checks for repeated thread launches

- Retrying a keyed MCP thread launch checks the thread's current project, link access, and modes before returning its details.

## 2026-11-23 — Accounting for messages, failover and review

- New owner requests and accepted guest messages receive a demand ID. Steering, failover, and final review retain the original demand. Delegated questions and completions use their recorded sources. On-return compaction shares the demand ID of the following message.

## 2026-11-22 — Relay client installs keep each other's locks

- CodeShip checks the version that each managed relay binary reports and reuses the exact pin even when an older release folder contains it. New installs use a separate cache tree and hold a SQLite transaction until they finish. The lock survives a host suspend, and the OS releases it if the installer exits.
- Upgrades can reuse the pinned relay from either previous cache layout while offline. Cleanup shares the install lock. A later tunnel registration retries cleanup if the lock is busy, a cache scan fails, or an obsolete executable cannot be removed. It retains a rollback binary and removes only identified older executables for this machine’s platform and architecture from the new cache. Legacy files, staging files and binaries reporting the pin or a newer version are preserved.
- A recent legacy lock gives the older installer time to finish. CodeShip can proceed in its own directory as soon as all identified legacy owners have exited, or after 30 minutes if ownership remains uncertain. It preserves the legacy lock and binary. Relay archive extraction has a two-minute timeout.

## 2026-11-22 — Long keys work for tasks on linked environments

- Starting or cancelling a task on a linked environment no longer fails when the chat's request key is at the 256-character limit.

## 2026-11-22 — Release build tests pass on Windows

- The staged-install tests no longer depend on how the host runs `vp`, and the development launcher's file-permission test is skipped on Windows, which has no POSIX permissions, so the Windows check passes for release build changes.

## 2026-11-22 — Filter, tag, and sort threads

- Filter the thread list by status on web, desktop, and mobile. The list shows when a filter is active and gives you a quick way to clear it.
- Add, remove, and filter by thread tags on web, desktop, and mobile. On web and desktop you can tag several selected threads together.
- Sort threads by last activity, creation, or name on web, desktop, and mobile. Pinned threads keep their manual order, and Settled stays in the order threads settled.
- While a status or tag filter is on, **Show more** in Settled and chat folders reveals loaded matches first. If more are needed, each press loads one page from each available machine at the current cutoff. Changing filters resets folder paging, and **Show less** on web and desktop returns that folder to its preview and releases its pages. A separate retry button handles failed page reads.

## 2026-11-22 — Unclosed display math no longer flattens the lists after it

- A `$$` or `\[` that never closed turned every later list and quote in the message into plain paragraphs, even after a blank line. Display math now ends at a blank line, as in TeX, so an unclosed opener stays text and the lists and quotes after the next blank line keep their structure. Display math that contains a blank line now shows as text.

## 2026-11-22 — Commands wait for memory before they start

- `t3_command_run` now waits until the machine has memory for a command before it starts it, as scheduled runs, delegated tasks, emulators and chats that resume by themselves already do. Before, every command started at once, so when many resumed chats started commands together after a restart, their shell wrappers alone could use up the free memory. A waiting command is never refused: commands start in the order they were asked for, `task_status` reports them as queued with the reason, each time limit counts from when the command starts, and a waiting command keeps its place through a restart. A waiting command whose task is cancelled or whose chat is archived never starts, and its task says why. The **Wait for memory before automated starts** setting in **Settings → Maintenance & about → Background activity** covers them too.
- The update prompts no longer call every open command "running": a queued command carries on through the update just as a running one does.

## 2026-11-22 — Delegated tasks on an Auto model keep the options they are given

- A delegated task, or a thread an agent launches, on its parent's Auto model or on a role or reviewer model set to Auto ran the effort and other options saved for Auto instead of the ones the agent gave. A target that gives options now runs on that model with them, keeping the parent's other options when it is on the parent's account and model, named by slug or alias (on a linked machine by its slug, since an alias there can name another model); one without options still runs as Auto. Options a role or reviewer model rejects now fail the call instead of quietly running the task on the parent's model, and a task on a linked machine that gives one option twice fails instead of keeping one of them.
- A role's model that its account no longer offers now falls back to the parent's model, as a removed account does, instead of starting the task on a model that cannot run, also when the account is rechecked first.
- `create_threads` now reports the account and model its prompt's run starts on, when routing moves it off an account at its usage limit, and a retry of the call reports that run even after the thread has started others.

## 2026-11-22 — Landings take turns in arrival order

- Landings on main now wait in a first-come, first-served queue. A later landing can no longer jump ahead by polling first when the lease is released. If a waiting lander crashes, its entry stops blocking the queue after it goes stale.
- A landing that joins the queue comes after every landing it finds waiting there, even when that landing's machine clock runs ahead; landings that join at the same moment, before either can see the other, go in the order of their machines' clocks. A queue of any length keeps moving, and a waiter reads a bounded part of it per poll. Entries origin will not delete block no one and are reported once: a crashed lander's, or a waiter's own old names, which no longer keep it from a free lease, and the waiter keeps renewing its entry, so it keeps its place. A landing whose entry origin refused joins again behind the landings that came meanwhile. A lander whose take reached origin while its answer was lost keeps the turn instead of waiting behind itself, unless the lease expired before the take was confirmed, and its checks get the time that lease has left.

## 2026-11-21 — Repository commands refuse arguments they do not take

- The landing, upstream sync, CI, release, translation, task cache, relay push and replay recording scripts check their whole command line before they act. Before, most of them ignored an argument they did not read, so `landing-turn.cjs land --quick-precheck` started a real landing and a mistyped `--uninstall` made the task cache installer install. Replay recorders reject invalid selections and blank output paths before starting a provider. The Claude and Codex package commands preserve Bun’s environment-file settings and run the recorder in Node. Use `--dry-run` to see the output path before recording. Mobile behavior checks that each selected case has a compatible device before preparing one. Changing a package command mapping or adding or deleting a repository command selects the argument checks.
- The cached test runner on Windows matches nested package filters, discovered shards and cache exceptions using the same paths as Git. It starts the repository’s Vite+ CLI directly for both the test run and verification of cached results.
- The landing lease test of a push that runs out of time passes on Windows: its unresponsive origin now waits outside the test's folder, which Windows would not delete while a process works in it.
- `vp run --filter @t3tools/mobile generate` starts again. The theme file it loads imported the app's `i18n.tsx`, which Node cannot load, so the generator failed before it wrote anything; a test now runs it the way the package script does and fails when the committed theme files are out of date.
- The Android push watcher no longer loads the relay's whole delivery service, database layer included, to build an alert, so it starts in about half the time.
- The task cache tests pass on Windows. They now point Windows' home folder at the test home as well, and pass the preload to Node as a file URL, the form the installer writes.

## 2026-11-21 — A machine that comes back reconnects without a click

- A linked machine that was away for a while (shut down, asleep, without power, or restarting for an update) could stay **Reconnecting** in the sidebar for up to 5 minutes after it was back, because the wait between tries grew to 5 minutes. While the app is open, it now waits at most 30 seconds after a failed try before trying again, so such a machine reconnects without a click on **Reconnect**.

## 2026-11-21 — A finished subagent no longer opens pull requests from its own worktree

- When a subagent that has its own worktree delivers its result, T3.CodeShip keeps it active while it has unmerged work but no longer looks up or opens a pull request for it. The agent that started the subagent decides how that work lands.

## 2026-11-21 — Recent threads keep their places while chats run

- The recent threads under an empty draft and the thread picker for linking a pull request no longer reorder while chats run. Both now order by when you last sent a message or started the chat, as the sidebar's Working list does, and the draft list shows that time. The draft list also leaves out tasks the sidebar shows under their parent thread, and the web command palette's thread times show when you last sent a message or started the chat.

## 2026-11-21 — Background work on a thread with no run reads the same everywhere

- A thread without a run that still holds background work, such as a finished subagent's, now shows that work in the sidebar the same way auto-settle counts it, so a thread can no longer look idle while settlement treats it as busy.

## 2026-11-21 — A failed worktree launch says why Git refused

- Starting a thread in a new worktree from a commit that exists only on another machine is now refused up front, naming the commit, instead of failing later with only "git worktree add failed". A fetch no longer counts as proof that the remote holds the commit.
- A failed Git command now reports its exit code, and for worktree and branch creation, status and similar commands with fixed arguments, Git's own last lines. The step that creates the branch is no longer reported as "git worktree add failed".

## 2026-11-21 — Claude uses fewer tokens for one-off text generation

- On Claude versions that support safe mode, thread titles, commit messages and other one-off generations skip your personal `CLAUDE.md` and plugins. Account launch settings still apply.

## 2026-11-21 — Claude's held resets say what they clear, or why they cannot

- In `orchestrator_capabilities` with `usage`, every Claude banked reset, usable now or held back, names what it clears in `kind`. When Claude gave only a total because no reset can be used now, the reset has `kind: null` and `kindUnknownReason: "total_only"`.
- When Claude answers that resets wait while the account continues at lower priority, it reads none of them, so `bankedResets` is now `null` with `bankedResetsError: "low_priority"` instead of listing a reset that may not exist.
- Automatic redemption now uses a Claude reset kept for when the account reaches a limit as soon as the account is at a limit that reset clears, even if CodeShip read Claude's resets before that limit was reached. A reset Claude offers now still goes first, and a reset whose kind Claude did not name is never redeemed automatically.

## 2026-11-21 — Chats that resume by themselves wait for memory and start one at a time

- After a restart, every chat it cut resumed at once, which could overload the machine: one had 1.7 GiB free 13 minutes after it started. Chats that continue by themselves after a restart, a network outage or a usage limit now resume one at a time, the chat that stopped first first, each once the one before it has reached its agent, and none starts while memory is short (**Settings → Maintenance & about → Background activity**). A waiting chat says **Waiting for memory** and keeps its place through another restart; a message you send in it starts it at once. Chats you start are never held.

## 2026-11-21 — Landing flags overlapping local work

- Before a landing rebases and checks, it lists other local worktrees whose unmerged branches change the same files, with the branch, worktree path and shared files, so parallel designs get reconciled before they collide.

## 2026-11-21 — Parallel worktree launches on Windows no longer fail on a busy Git config

- On Windows, starting several worktrees in one repository at once could fail with "unknown error occurred while reading the configuration files" when one Git command read `.git/config` while another replaced it. Git now repeats a command that died at that point, since it had not done anything yet.

## 2026-11-21 — check:changed tests changed dependencies

- A changed dependency patch, `patchedDependencies` entry or lockfile version now selects the tests that run that package, so a patch can no longer pass the checks while it breaks a test.

## 2026-11-21 — A closed pull request settles only where the merge rule is on

- Turning on automatic settlement for one project no longer settles threads in a project that has both settlement rules off because their pull request was closed. A closed pull request now follows the project's "settle when merged" rule.

## 2026-11-21 — Thread details show what the agent is doing

- The thread details card now leads with information instead of buttons. A new **Agent status** section shows whether the agent is working, waiting for you (on its own approval or question, or a subagent's approval), waiting on another thread or a background task, queued, stopped, reverted or at a usage limit, for how long, on which model and effort, and the full command or the edit it is running now. Context and usage meters follow it.
- Subagent rows show the model and effort, and what each one is doing while it runs or how it ended.
- A new **Machine load** section shows CPU, memory, swap and disk for the machine the thread runs on, like the Machines page.
- The machine, branch and open-in controls stay folded until you open them, and fold again when you switch threads. **Git actions** and **Ask the agent** are off by default; turn them back on from **Choose what to show**.
- Manual steps no longer appear under Needs you or in the details card. They stay on the **Manual steps** page in the sidebar rail, which now has the **Sign in to all** button.

## 2026-11-21 — Release retries ignore runs from other branches

- A release started from another branch no longer replaces main's pending release or gets retried, and the catch-up checks look only at runs on main. A branch fast-forwarded onto main no longer gets a second release run.

## 2026-11-21 — Pin from more places, reopen archived threads, and see what needs you in the title

- Pin or unpin the open thread from a button in the chat header, and pin from a sidebar row on hover or focus. Select several threads and choose **Pin (N)** to pin them in the order you selected them. On mobile, the thread screen's header has Pin and Unpin.
- The window or tab title starts with how many threads need you, like `(3) Fix login - T3.CodeShip`, and drops the number at zero. It shows whatever your notification settings are.
- Press `mod+alt+shift+e` or choose **Reopen last archived thread** in the command palette to unarchive the most recently archived thread on any connected machine and open it.

## 2026-11-21 — Recovered commands are matched by their recorded identity

- After a restart, a command run by the agent is recognized by the identity its wrapper recorded at launch, so setting the system clock back can no longer make Stop signal an unrelated process. A command from an older version is reported lost and left running.

## 2026-11-21 — Release builds install only locked versions, before signing

- Release builds of the desktop app, its Windows server sidecar and the CLI archive install exactly the dependency versions in the repository's lockfile and fail on any it does not hold, instead of resolving new versions from the registry while building a release.
- Those installs now finish before any signing certificate or key reaches the build machine, and signing works only on what they staged.
- The Electron each release ships is downloaded while staging and checked against the SHA-256 that the locked Electron version lists, so packaging never downloads it with signing credentials loaded. When Electron's own install download did not finish, its fallback download is checked the same way.
- Code that runs while a release is signed gets only the environment it needs, and the relay tracing token reaches only the CLI executable build. A relay tracing token that ends in `=` keeps it.
- Dependency installs during a release build get only an allowlisted environment, without signing, notarization or registry credentials, and each platform's build receives only its own signing secrets.
- Each signing step deletes every certificate, key and keychain it or electron-builder made when it ends, even when one removal fails, and electron-builder starts from a fresh tool cache, so the checks that run the app afterwards never find them. Packaging still runs on the build machine that holds the signing material.

## 2026-11-21 — Start a worktree from a branch that exists only on the remote

- Creating a worktree on a new branch from a base that exists only on the remote, such as a branch pushed from another machine and never checked out here, now starts from the remote copy instead of failing with "git worktree add failed".

## 2026-11-21 — Relay install tests run on Windows

- The relay client install and version-selection tests build every path with the Path service and the host's PATH delimiter, so they run on Windows hosts instead of being skipped.

## 2026-11-21 — Auto mode review target keeps only supported options

- Auto mode's independent review target now lists only the options its model currently offers, so a stored option such as Codex `serviceTier` no longer makes the review delegate fail with "Unknown option".

## 2026-11-21 — A provider that stops answering no longer blocks new chats

- When a provider process sends nothing for the whole time a chat waits for it to start, CodeShip stops that process before the chat retries, so the retry and later chats start a new one. Before, a stuck Codex process failed every retry and every new chat on that account with "The provider did not load the conversation within 5 minutes" until the app restarted. A process still sending events for other chats keeps running.

## 2026-11-21 — A landing reads real git history and refuses marked files

- The landing turn, its checks receipt, the pre-push hook, `check:changed` and the upstream sync read git history past replace refs and grafts, so an invented ancestry can no longer let a push move main past a commit it never held.
- A landing and a checks run refuse files marked assume-unchanged or skip-worktree, whose edits `git status` hides. A rebase that conflicts is aborted, a worktree in a stopped rebase is refused, and the upstream sync counts a push whose reply was lost as landed when main holds it.

## 2026-11-21 — Commits no longer run knip beside check:changed

- The pre-commit hook ran `knip:check` on every commit that touched code, outside the memory budget that `check:changed` shares across a repository's worktrees. Each knip pass takes about 7 GB, so agents committing in several worktrees at once could use up a machine's memory. The hook now formats and lints the staged files only. `check:changed` still runs knip within that budget, and the standard landing on main (`landing-turn.cjs land`) runs `check:changed`. No change to the app.

## 2026-11-21 — Every checkout runs the tracked push gate again

- The machine configuration listed its Git settings twice, so only the second list applied and the machine check stopped pointing `core.hooksPath` at the tracked hooks in `.vite-hooks`. One list now holds both settings, so the check sets the hooks path and the one-day prune window on every machine.

## 2026-11-21 — Organize tasks into folders from Scheduled

- In **Scheduled**, open a task’s menu and choose **Move to folder** to file it in an existing or new folder. You can also create an empty folder from the **Scheduled tasks** page.

## 2026-11-21 — Search the release history offline

- On web and desktop, Release notes opens with the ten newest entries. Page through older changes or search the full history by date, title, or text, including offline.
- Pasting a file to restore a draft attachment no longer shows an error after the file is restored. If the draft rejects a duplicate or reaches its attachment limit, the error follows your language setting.
- The browser profile and device preview guides now point to **Settings → Browser & devices**.

## 2026-11-21 — Renew unattended provider credentials from 1Password

- CodeShip rereads credentials from Linux 1Password service accounts and applies rotated tokens after the provider's live sessions close. If the vault read fails, the provider keeps its last working credential.

## 2026-11-21 — Use 1Password tokens for MCP servers

- In a Claude or Codex MCP server's settings, point **Bearer token variable** at a provider variable backed by Secrets. New provider sessions use it for servers that accept bearer tokens.

## 2026-11-20 — The server test suite runs on Windows in CI

- Every CI run that touches the server now also runs its tests on Windows, in eight shards beside the Linux ones. Maintainers: the manual Windows Tests workflow is gone; its lane is the `Test Server Windows` job in `ci.yml`.
- Fixed on the way: a Grok or other ACP agent started through a `.cmd` launcher on Windows never received its input, because the session started it detached. Windows sessions now start it attached and still stop its whole process tree.
- Tests that emulate a POSIX host or need an executable shebang script skip themselves on Windows instead of hanging for two minutes each.

## 2026-11-20 — A chat that cannot read Claude's settings says where and how

- When a chat cannot start because Claude's settings could not be resolved, the failure now names the step (settings files, account worker, `--settings` check or organization policy) and the kind (timeout, could not start, non-zero exit, unreadable output or SDK error) instead of one generic sentence. It never includes settings, launch arguments, command output or other raw error text.

## 2026-11-20 — Turn items stop storing values their columns already hold

- Maintainers: a stored turn item no longer repeats its id, thread, run, node, provider ids, parent, ordinal, type, status and update time inside its JSON, since the row's columns hold them; every read puts them back. A resumable migration (098) converts existing rows in steps, and a test proves the rebuilt payload equals the original. The database and snapshot reads carry less data per item. No change to the app's behavior.

## 2026-11-20 — The machine check compares each machine's Node with the project's pin

- `machine-config.json` now declares `toolchain.node` as `package.json`, so `node ~/.agents/tools/machine-config.mjs check <checkout>` reports when a machine runs another Node than `engines.node`, and names the binary that answered. It now reports the mismatch before anyone runs `check:changed`, which refuses to run on the wrong Node. Zoro-PC, where CodeShip is developed, is now listed under `machines`, so the daily check of its checkout no longer reports it as unknown. No change to the app.

## 2026-11-20 — Storage cleanup reports a failed unmerged-work check instead of "not integrated"

- When Git could not count a worktree's unmerged commits (an unreadable branch, a damaged worktree, a timeout), storage cleanup treated it as one unmerged commit and kept the worktree with a misleading reason, logging nothing. The worktree is still kept, but the cleanup report now shows it as failed with Git's detail, and the failure is logged.

## 2026-11-20 — Use 1Password credentials with agent providers

- In **Settings → Secrets**, add a 1Password source and choose which fields to supply to Claude, Codex, or another provider. Linux hosts can use a read-only service account for unattended runs with an administrator grant for each field.

## 2026-11-20 — Shared schedules keep their fallback models

- Shared tasks carry their ordered fallback models when CodeShip syncs them between connected machines. A machine that already has the current task can fill in a missing fallback list from a complete copy.

## 2026-11-20 — Plain-language descriptions for scheduled tasks

- Add a description in a task’s editor to see its purpose on the Scheduled tasks page. Shared tasks carry the description across machines.

## 2026-11-20 — Completed scheduled threads settle automatically

- CodeShip settles threads started by a scheduled task after a successful run when no work is pending. You can turn this off in **Settings → Threads → Auto-settle**.

## 2026-11-20 — Settling and cleanup see commits a rewound default branch no longer holds

- The check for unmerged work trusted its last copy of the remote's default branch, and fetched a fresh one only after that copy showed commits ahead. When the remote's default branch had been rewound, the old copy still held a branch's commits, so the check counted none and settlement or cleanup could remove a worktree whose work was no longer on the default branch. It now fetches the default branch first, within the same 10-second limit, and counts against the result.

## 2026-11-20 — Client tests no longer depend on the machine's language

- Maintainers: the snooze-menu and usage-limit banner tests failed on a computer set to a non-English region, because they expected English dates and times from the system's own format. Web, desktop, mobile and client-runtime tests now start with English and US formatting active and a Ukrainian system locale, so they pass on every machine, and a new test that relies on the system's format fails everywhere, CI included.

## 2026-11-20 — Delegated tasks on linked machines survive a restart mid-launch

- A task delegated to a linked environment is recorded before its chat starts there, so a restart or lost reply no longer leaves a chat running on the other machine that nothing follows. A launch that never happened fails the task instead.

## 2026-11-20 — A command-runner test no longer waits forever for a file that already exists

- Maintainers: the command-runner tests could hang for two minutes under load while waiting for a file their command had already written, because the wait reported only changes from a baseline it read after the file appeared. It now looks at the file on a short timer. No change to the app.

## 2026-11-20 — A Windows command whose launcher fails after its wrapper started is no longer reported unstarted

- On Windows, when the launcher exited with an error or ran past its time limit after it had already started a background command, T3.CodeShip told the agent the command did not start and forgot it, while the command kept running with nothing watching or able to stop it, and an agent that retried ran it twice. The command is now watched and stopped like any other once the launcher printed its process id or the command's own process wrote its pid file.

## 2026-11-20 — A landing's tests may run as long as its lease allows

- The checks a landing runs under main's landing turn no longer stop their test step at one hour while the turn's lease lasts three. The test step now gets what the lease has left, less twenty minutes for the other checks and the push, so a slow day no longer fails a landing with nothing broken, and a landing still ends before its lease expires.

## 2026-11-20 — Checkouts clean up leftover git objects after a day

- Every machine's CodeShip checkout now deletes unreachable git objects after one day instead of two weeks, so automatic git cleanup can keep up with the objects agent worktrees, rebases and checkpoints leave behind. Before, a checkout could collect over 200,000 of them (2 GB) while cleanup only warned.
- Maintainers: `vp run check:changed` and the push gate no longer write the files of your uncommitted work into the repository as loose git objects just to compute a tree id. Every pass used to leave unreferenced blobs and trees behind.

## 2026-11-20 — The default branch comes from the repository's main remote, not only one named origin

- In a repository whose only remote has another name (for example `github`), a branch named `main` that was not the remote's default branch was treated as the default branch, so the unmerged-work check counted 0 commits and its work could be cleaned up as merged, while the real default branch was not recognized. Status now reads the default branch from the same main remote the rest of the unmerged-work check uses.

## 2026-11-20 — A replayed chat launch no longer prepares a worktree twice

- Replaying a launch while its workspace preparation was being retried could create a second worktree, or fail the run because the branch already existed. A launch, its replay and a retry now share one preparation per run, and a replay reuses the worktree the run already has.

## 2026-11-20 — Stopping a Windows command spares a program that took its process id

- When T3.CodeShip could not read when a background command's process started on Windows, stopping the command could end an unrelated program that had taken that process's id once the command ended, along with everything that program started. The stop now takes a program under that id for the command only if it started between the command's launch and the moment the launch returned, give or take a tenth of a second and allowing for a clock change in between, and never once the command's process was found gone, right after its launch or by a restarted T3.CodeShip. A start read that finds a program started after the launch no longer ties the stop to that program, and a restarted T3.CodeShip that finds under the id a program started more than a second outside that time reports the command lost. A command whose PowerShell ended before it started the command now fails to start with that reason, and one whose PowerShell ended right after is reported lost at once when another program holds its id, instead of looking like it still runs.

## 2026-11-20 — A clock change no longer makes a running command look lost

- Background commands are now recognized by their start in ticks since boot on Linux and by the creation time Windows stored, instead of a start time derived from the wall clock. A clock change after a command started no longer reports it lost or leaves it running unwatched, and on Windows a stop still reaches what the command started.

## 2026-11-20 — A thread opened as a reply streams in stays at the end

- Opening a running thread just as a new reply arrives no longer jumps the timeline to the top and stops following new replies, on web, desktop, mobile and the guest page.

## 2026-11-20 — Chats stopped by a rejected login continue once the account works

- A chat that stopped because its account's login was rejected continues on the same account once that account reads signed in again (after a sign-in, another chat's answer on it, or a restart), when **Resume when the limit resets** is on, including when the login was only unreadable for a moment. It sends the message again when the agent did no work and asks it to continue otherwise. **Resume** in an empty composer now also continues such a chat by hand once its agent had started working.
- Moving a chat whose login was rejected before any work to another signed-in account works again; the server had refused that continuation. Claude's sign-in hint now says to resume the chat, or send the message again, instead of starting a new one.

## 2026-11-20 — Settling and cleanup keep commits the default branch does not hold

- A Git failure could still make the check count no commits, so automatic settlement could settle a thread whose commits had not reached the default branch. The check counted commits only when the branch status showed some ahead, and status also shows none when Git cannot compare the branch; and a worktree whose `.git` Git no longer recognizes, such as one with a damaged `HEAD`, read as holding no repository. Now both report that the worktree could not be checked, and the thread stays active until a later check succeeds.
- A worktree checked out on a commit instead of a branch now has its commits counted against the default branch; before, it counted none. In a repository without a default branch, the check now says it could not count them. A merged pull request clears the count only when its host reports the pull request's last commit, that commit is the one checked out, and the pull request merged into the branch the worktree's branch was cut from, usually the default branch.
- Untracked files and changes inside submodules count as uncommitted work even where the `status.showUntrackedFiles` or `submodule.<name>.ignore` setting hides them, and each untracked file in a new folder counts on its own instead of the folder counting once.
- Automatic settlement settled a thread whose open pull request lacked commits made after its last update. Now T3.CodeShip pushes those commits to the pull request first, or keeps a thread you never wrote in active, and the thread settles once the pull request has every commit.
- Automatic settlement also settled a thread whose pull request was closed even when the worktree had commits or changes made after it. Such a thread now stays active, without a new pull request, until that work is shipped or discarded.
- A commit counted as merged when the default branch held a change that matched it except for whitespace, such as another indent, even though merging the branch would still change the default branch. Storage cleanup could then remove the only copy of that worktree's version. Now a branch counts as merged only when merging it would leave the default branch unchanged, which still covers work that reached it by cherry-pick or rebase.

## 2026-11-20 — Release notes merge an edited entry by entry

- Maintainers: when a rebase or merge of `docs/release-notes.md` meets an entry the incoming side edited, retitled, redated or removed, the merge driver now keeps that change and puts the other side's new entries around it by date. It still leaves the file to git's text merge when both sides changed existing entries, and when it cannot place a new entry or tell it apart from the other side's entries. Before, git merged the whole file as text in that case, so a branch whose later commit reworded its own entry could conflict with shipments that had landed meanwhile, and its landing then failed after it had waited for its turn. No change to the app.

## 2026-11-20 — Stopping a process tree on Windows no longer ends a program that took a process's id after the stop looked

- When T3.CodeShip stops a command, an agent's CLI or a worker on Windows together with what it started, it now opens each process it found, checks that it started at the moment the stop's look at the system saw, to the microsecond, ends it through that open handle and waits until it has ended. Before, it ended each one by its process id, so if a process exited and Windows gave its id to a new, unrelated program after the stop looked, that program was ended instead. The stop keeps every process it ended open until it is done, so their ids cannot pass to another program while it looks again for what they started. A program under the first process's id is taken for that process only if it started within a tenth of a second of the moment T3.CodeShip launched it, where a second was allowed before, and never once T3.CodeShip has seen that process end; when T3.CodeShip does not know the launch moment, it leaves alone a program under that id that started before the command did. If a process T3.CodeShip still counts as running has in fact exited, the stop ends nothing more under its id, still ends what it had already found that process started, waits up to 5 seconds for the exit to be reported, and then ends only what that process started before the earlier of its reported exit and the moment the stop saw it gone, so a missing report no longer leaves that unbounded. Each round of the stop ends the processes it finds together and waits at most 5 seconds for them. A process that already ended still counts as stopped, also when the program that took its id is one T3.CodeShip may not open. A process that cannot be stopped or still runs 5 seconds after its round ended it, and a tree in which the sixth look still finds new processes, is reported as an error once the rest of the tree is stopped, and the next stop of that process tries again, also on each process the failed stop found but did not end and on what those started, while it still runs with the start that stop saw. A stop cut short still passes on each process it already knew it could not end, and that it saw the first process gone.

## 2026-11-20 — On Windows, stopping a process no longer ends an unrelated program that took a reused process id

- Effect's process kill on Windows (`taskkill /T`) ended descendants by id from a snapshot, so a program that took a descendant's id in the meantime could be ended. It now ends only the process it started, and the checked process-tree stop that already follows ends its descendants.

## 2026-11-20 — Commands whose process check failed are re-checked

- A background command whose process identity could not be read when the server picked it up is now checked again on later passes. If another process has taken its pid, the command is reported lost instead of showing as running until its deadline.

## 2026-11-20 — Added Codex accounts keep their own sign-in

- A test now checks that chats on an added Codex account start in that account's own folder. Version 2026.1116 could run them under the default Codex login, which left a resumed chat waiting until it failed.

## 2026-11-20 — Push gate stays on after install

- Installing dependencies no longer repoints Git's hooks at generated shims, so the checked push gate on `main` keeps running in every checkout.
- Development and testing notes that lived only in agent memory are now in the docs.

## 2026-11-20 — Landings refuse a local merge rule that breaks the release notes

- Maintainers: a landing now stops before it waits for its turn when the checkout's own git attributes give `docs/release-notes.md` another merge than its merge driver, and it names the file to fix. Such an attribute in `.git/info/attributes` outranks the repository's own, so every rebase joined two entries without the blank line between them, and the landing failed its format check only after it had waited for its turn and run its checks. `vp i` warns about it too. No change to the app.

## 2026-11-20 — Landings wait through a passing network failure

- A landing that waits its turn for `main` no longer ends when one look at the landing lease meets a passing network or sign-in failure. It says so and tries again, and gives up when the failures go on for ten minutes or its six-hour wait runs out. A failed step that does not reach GitHub, such as writing the lease commit, still ends it at once; a failed call to GitHub is tried again even when a local git setting causes it. A landing that could not fetch the current holder's lease no longer takes the turn from that holder. A take of the turn that reached GitHub although git reported it failed or ran out of time now counts as taken instead of leaving the landing waiting hours for its own turn to expire, and one GitHub refused is reported instead of waited out. Each lease check gives up after a minute instead of hanging, and a landing that cannot give its turn back says so.

## 2026-11-20 — Thread creation retries survive a removed provider

- When an agent retries a thread creation that was already accepted, it gets back the thread it created even if that thread's provider instance has since been removed.

## 2026-11-19 — The upstream sync checks against its own base

- Maintainers: `node scripts/upstream-sync.ts check` runs the sync's `check:changed` against the base in the run's state file, with the 3600 s step timeout, so a held or hurried run no longer types a narrower range that skips files only the upstream merge changed. The scheduled task and the upstream-sync skill use it. No change to the app.

## 2026-11-19 — A helper in a linked environment can get its own worktree

- `delegate_task` with `isolation: "worktree"` and a linked environment as target now starts the helper in a new worktree there, branched from the commit your thread's checkout is on, instead of refusing. The commit has to be pushed so the other machine can fetch it; an unpushed one is refused with a message naming it. The helper's worktree is cleaned up with its thread there, as for a helper on this machine.

## 2026-11-19 — A daily scheduled task refused for a usage limit runs when the allowance returns

- A fixed-time scheduled task that catches up missed runs used to lose its whole day when its account was out of usage at its time. It now waits and runs once when the allowance returns, unless its next time comes first. Interval tasks are unchanged.

## 2026-11-19 — Windows Git driver checks

- The Git driver tests use local repositories to check SSH errors, nested paths and submodule checkouts on Windows. Related tests run in separate files within the existing time budget.

## 2026-11-19 — Fresh runs can switch providers when usage runs out

- A new chat or scheduled run can start on another provider when its primary provider has no room. Scheduled tasks can set ordered model alternatives and show which model last ran and whether a usage limit caused the switch.

## 2026-11-19 — Chats keep running during provider sign-in

- Claude, Codex, Cursor, and Antigravity browser sign-in keep chats on their current account until the replacement login is saved. Canceling or a failed save leaves those chats running.
- ACP agents that change credentials in place ask you to finish active work on the shared account before signing in.
- A separate sign-in history preserves timing, outcome, and session counts when the general server trace rotates.
- Codex uses the exact account folder set in `CODEX_HOME` for both chat continuation and usage history, including folder names that end in a space.

## 2026-11-19 — Environment tools can manage banked usage reset preferences

- Agents can read and set whether CodeShip redeems banked usage resets and how long it waits for a plan reset. Changes apply locally unless the agent explicitly requests sharing. A regression check requires read and update support for every shared preference or a documented exception.
- On Windows, the verification suite now handles escaped attachment paths, checks Claude settings against Windows filesystem behavior, and uses the simulated machine's paths in device evals.

## 2026-11-19 — A refused delegation on a machine short of memory points to a linked machine

- When `delegate_task` is refused because this machine is short of memory and a reachable linked machine has full access, the message now names it and its `environmentId` and says to delegate there with `target.environmentId`. Before, it always said to do the work inline, which kept heavy work such as test runs on the machine that was out of memory. Without such a machine, the advice is unchanged.

## 2026-11-19 — Attachment preview browser tests stop failing on a loaded machine

- Maintainers: the browser tests wait up to 10 seconds, not 1, for rendered output, and each may run 30 seconds, not 15. `AttachmentFilePreview.browser.test.tsx` failed 1 to 4 cases on a busy machine because pdf.js and the office workers outlasted those limits, which kept any change that selects the file from landing. No change to the app.

## 2026-11-19 — A Git failure no longer makes unmerged work read as none

- Settling a chat checks whether its branch has work the default branch lacks. Before, a Git failure while looking up refs (an unreadable ref store, a timed-out command) looked like "no default branch", so the check counted 0 and the chat settled or the settle dialog stayed quiet. Now the check fails and reports that it could not be checked, as it already does for other errors. A repository with no base to compare with still counts 0, and the branch status display is unchanged.

## 2026-11-19 — Main takes only changes whose checks passed, on Windows too

- Maintenance only, with no change in the app. A push to the fork's `main` is refused unless the lander holds the landing turn and `vp run check:changed` passed for exactly the files pushed, compared with the commit `main` is at. Each passing run records what it checked, and the tracked pre-push hook, which a checkout runs once the machine check sets `core.hooksPath`, refuses a push without that record. `landing-turn.cjs land` refuses to start in a worktree with uncommitted or untracked files, whose pass could not cover the commit it pushes.
- `vp run check:changed` passes on Windows. The agent context budget measures the Windows tool list, which adds the Visual Studio tools, beside the one other systems get, and test fixtures give Git `/dev/null`, which Git for Windows reads as its null device, and name only folders Windows can create. A list of changed files too long for one Windows command line runs in several steps. Its Node version check allows a loaded Windows machine more time to start Node. The lint rule that refuses an early return on the host platform also finds one on the shared host flags such as `isWindowsHost`, and leaves setup and cleanup hooks alone.
- Every push to the fork's `main` also runs `check:changed` on a GitHub-hosted Windows runner, so a change landed from macOS or Linux meets the Windows tests too.

## 2026-11-19 — Auto stops offering a model its account's login refuses

- When a Codex account's ChatGPT login refuses a model it lists (`The 'gpt-6.2-astra' model is not supported when using Codex with a ChatGPT account`), that model is now held on that account for a few hours, like a model-scoped usage limit. Auto's reviewer and the models it offers then come from another account that can run the model. Before, the refusal was recorded as a plain error, so Auto kept naming the same account and every review on it failed at once.

## 2026-11-19 — Codex installation tests cover native launchers again

- The Codex installation tests tell a native `volta-shim`, `mise` or `aqua-proxy` launcher apart from a script launcher again, and check both sides of the rule for a native Codex: with its code-mode host beside it, it is used; without it, the managed download replaces it. Since every test fixture became a script, losing either rule would have gone unnoticed. No change to the app.

## 2026-11-19 — Release notes keep their order when a rebase meets another shipment's notes

- Maintainers: when a rebase or merge meets new entries on both sides of `docs/release-notes.md`, a merge driver now places the other side's new entries by date. `vp i` sets it up, and the landing turn uses it on every machine. Before, git could splice an entry into the middle of another one's lines, or leave a conflict, so a landing failed its format check after waiting for its turn. An entry that was edited, dropped or reordered still merges as text. No change to the app.

## 2026-11-19 — Claude loads only the shared skills its own skills folder picks

- When a Claude account's skills folder links skills from `~/.agents/skills` itself, as a machine setup does for the shared skills it switches on, T3.CodeShip no longer adds the whole shared folder to Claude sessions. Before, every Claude session also listed the shared skills that folder leaves out, which cost context and let them be invoked. The composer's skill list follows the same rule. Without such links, Claude still gets every skill in `~/.agents/skills`, as before.

## 2026-11-19 — Monitoring shows where your chats' time went

- A new **Monitoring** page analyzes every settled chat: how its lifetime split between the model working, commands, tools, approvals, the queue, usage limits, helpers and waiting for you; its runs, failures, tokens, cost, cache reuse and how often it was reopened; and its weak points, such as slow, repeated or failing commands, usage-limit stops, restarts and long queues, each with advice. It ranks weak points across chats, groups shell commands by step (install, build, test, ship and so on), shows a daily trend and breakdowns by project, kind and model, and opens a deep dive for one chat with a timeline of its runs and helpers. Commands show as you would type them, without the shell wrapper, and steps started by a helper carry the helper's name. It updates by itself whenever a chat settles. Open it from the sidebar, the command palette or, on mobile, Settings.

## 2026-11-19 — Auto offers and runs every account's models

- In **Settings → Providers & models → Models**, a provider's coordinator model list under **Auto mode** now offers the models of every account of that provider that can run on this machine, each with that account's own custom and hidden models. Before, it listed only the first account's models, so a model only another account offers, such as GPT-6.2-Astra on a ChatGPT-connected Codex account while the managed Codex CLI is too old to be offered it, could not be picked.
- A new Auto thread now starts on the first account in the provider's account order that can run in its project and has its coordinator model, under the model id that account lists. Before, it started on the first enabled account whether or not it had the model, was signed in or was turned on for the project, so with account switching off, such a thread failed to start.
- The coordinator model list also offers the models of a provider whose accounts all report a warning, such as a Codex account whose model list did not load in time, since Auto still runs on them.
- When a new thread's Auto default is out of usage on its account, another account of that provider now counts as able to take the thread only when it offers that model and its provider check did not fail, the same as for an Auto fallback model. When no other account can run it, the thread now switches to the fallback model, if that can run, instead of waiting for the reset. Manual-step chats and a default model inherited from another machine also skip accounts whose provider check failed.

## 2026-11-19 — A turn whose worktree folder is gone no longer breaks checkout moves

- Moving a checkout while a turn names a worktree folder that has since been deleted failed with a git error. A folder that is gone now counts as no repository, so the move proceeds.

## 2026-11-18 — Node rows in the state database no longer repeat their columns

- About 800 of a node's 1.3 KB stored payload repeated ids and status that its row's columns already hold. New nodes store only the rest, reads put the values back, and a startup migration converts existing rows in steps while the server answers requests.

## 2026-11-18 — Dates and numbers follow the chosen language everywhere

- A few dates and numbers (access times in Connections settings, message times and snooze pickers on mobile, pull request additions and deletions) were formatted with the device's default locale, so a user who chose Ukrainian on an English system saw US formatting, and desktop always did. They now follow the chosen language, and a new `t3code/require-formatting-locale` lint rule fails client code that formats without a locale. Widget text stays in English formatting to match its copy.

## 2026-11-18 — `vp test run` inside a package uses the repo test settings

- Running `vp test run <files>` from `scripts/` or a package folder now loads the repo's test settings (60 s timeouts, fake-timer list, no retries) instead of Vitest defaults, so a test no longer passes or fails by how it was started. A check fails when a package's test script has no config beside it. No change to the app.

## 2026-11-18 — Finished subagents and delegated chats settle once their parent has the result

- A subagent, or a chat an agent handed a task to with `delegate_task` on this machine, now settles as soon as its parent has its result, as a task delegated to another machine already did. Before, it settled only after three days of inactivity, so finished children stayed active in the Agents list. One whose task failed or was interrupted, or that is waiting, queued, working again or still running background work, stays active, and a settled subagent its parent picks up again returns to the active list. This applies even with automatic settlement turned off. Children that had already finished settle at the first check after the update, at the time they finished.
- A subagent or side chat working in its parent's worktree now leaves that worktree to the parent: settling it no longer runs the project's settle action there, and the parent's unmerged work no longer keeps it active or opens a pull request from it.
- Maintainers: these settles carry the command id prefix `server:settle-delivered-child:`, and their `settledAt` is the time the child finished, so measure how long settling took from the `thread.settled` event's time.

## 2026-11-18 — Cleanup removes a worktree whose work reached the default branch under other commits

- Storage cleanup now removes a settled thread's unchanged worktree when its changes are already on the default branch, even if they got there by cherry-pick or a rebase shipped from another worktree. Before, only a worktree whose commits were themselves on the default branch was removed, so such worktrees piled up. The unmerged-work warning when settling a thread uses the same check, so it no longer counts those commits either.

## 2026-11-18 — Storage cleanup reports freed space and broken checkouts correctly on Windows

- On Windows, the storage cleanup report showed 0 bytes for every removed worktree, because Node reports no allocated blocks there. It now counts file sizes, so the freed space is right. A checkout whose `.git` file names a missing folder is now also treated as no longer a repository, as on other systems, so cleanup keeps it instead of reporting a Git error.

## 2026-11-18 — Script tests fit their time limit on a loaded machine

- The `scripts` cache test and Knip schema test each ran several slow subprocess steps in one test, 50 to 70 s on a busy machine against a 60 s limit. Each behaviour is now its own test with its own budget. No change to the app.

## 2026-11-18 — Full test suites share check:changed's machine budget

- `vp run check:changed --suites <package dir>` runs a package's full test suite on the same machine-wide slot budget as the fast checks, so suites started together no longer oversubscribe the cores and time out. Upstream syncs use it and, after landing merges main, recheck only what main added. No change to the app.

## 2026-11-18 — Lint rejects two tests with the same name in one file

- A merge that kept both sides of a test file could leave two tests with one name, and Vitest reports them together so a stale copy hid. The new `t3code/no-duplicate-test-title` lint rule fails a file with two same-named tests in one describe block, including `it.effect` and `it.live`, which the built-in rule skips. No change to the app.

## 2026-11-18 — Upstream syncs check conflict resolutions against both parents

- The upstream-sync skill now has every conflict resolution diffed against both parents, tests run through each package's own script with failures compared on the base, and protocol literals kept as upstream wrote them. No change to the app.

## 2026-11-18 — Server file locks always release

- The Claude and Codex config locks and the ChatGPT session lock now go through one helper that releases with no arguments, so a lock taken for a copy or an update is freed when it finishes and the next edit no longer waits for it to time out.

## 2026-11-18 — Background git work is counted and a run past its budget is logged

- The pull request refresh and the thread settlement sweep now count the git processes they start, and the server log records a warning with the count when a run passes 150. On Windows each git process blocks the server for about 130 ms, so a sweep that starts to fan out again shows in the log instead of freezing the app. No change to what either sweep does.

## 2026-11-18 — check:changed shows what a timed-out step printed and bounds its test step

- A `check:changed` step killed at its time limit now prints the output it had produced, so a hung run names where it stopped. The test step grows by 2 minutes per selected file up to one hour, or stops at `--timeout` / `CHECK_CHANGED_TIMEOUT` when you set one, so a sync-sized diff that selects every test file no longer runs for hours; it also says so and points to the packages' own test scripts. No change to the app.

## 2026-11-18 — Test runs from several worktrees no longer overload the machine

- Vitest started about one worker per core in every test run, so a machine with several chats testing at once ran several times its core count in workers. Every Vite config now takes its worker cap from `scripts/lib/test-workers.ts`: 2 locally, every core in CI, and `T3CODE_TEST_MAX_WORKERS` overrides both. A test checks that each config sets it. pnpm also runs at most 2 install scripts at once. No change to the app.

## 2026-11-18 — Landings on main take turns

- Landing on main now takes a turn: the lander holds a lease on the remote while it rebases, runs the checks and pushes, and a push without it is refused. A landing no longer reruns the full checks each time main moves, and its check run gets free slots before other runs. No change to the app.

## 2026-11-18 — The relay install tests pass on Windows

- The relay client install tests built lock paths with slashes that the Windows filesystem hooks never matched, and checked the simulated Linux executable bit on NTFS, which cannot hold one. They now build paths with the host's path rules and model the simulated platform's executable bits themselves, so the contended-lock, legacy-lock and staging cases run the same on every host. No change to the app.

## 2026-11-18 — The Codex installation tests run on Windows

- The tests that check how the server finds and verifies an installed Codex used a shell script as the fake `codex` program, which Windows cannot run. They now use a fake process starter instead, so they run the same on every host. The launcher-symlink case no longer compiles a C program. No change to the app.

## 2026-11-18 — Agents start long test runs and builds with t3_command_run

- The instructions agents get now tell them to start every test suite, build, install, push or deploy through `t3_command_run` unless it ends within seconds, instead of running it in their own shell. A run started in an agent's shell was lost when CodeShip restarted for an update, and the chat never heard its result.

## 2026-11-18 — The SQLite reader-fallback test passes on Windows

- The test that checks the server falls back to the writer when its database reader cannot open the file deleted the live database to force that, which Windows refuses while the file is open. It now makes the reader worker report the failure instead, so it runs the same on every host. No change to the app.

## 2026-11-18 — Symlink tests run on Windows without file-symlink privilege

- Tests that link a directory now use a junction, which Windows creates without privilege, through one shared `linkDirectory` fixture. Tests that need a real file symlink skip when the host cannot create one, as the other symlink tests already do.

## 2026-11-18 — The eval for setting a Claude account's Auto-compact after has run

- The `account-auto-compact-window` eval case failed on the tool text from before agents could set a provider account's shared settings and passes on the current text, on GPT-6 Luna and GPT-6 Astra. The results are in the MCP tool use eval's README.

## 2026-11-18 — A worktree fetch that times out starts from the last fetched base

- When a new worktree's fetch of its base branch got no answer in time (a sleeping or overloaded machine), the run failed in workspace preparation. If an earlier fetch left that branch's remote-tracking ref, the worktree now starts from it, possibly a little behind, and the server log records that. Without such a ref the timeout still fails and preparation retries it as before.

## 2026-11-16 — On Windows, an agent session also stops what its CLI left running

- On Windows, a Codex, Claude, OpenCode, Muse or ACP agent session (such as Antigravity) that ended left running what its CLI had started, such as MCP servers and the commands of a turn, once the CLI itself had exited, because Windows ends only the process it is told to. A session now also stops those processes when it ends, as Pi and Grok sessions already did, and closing a Claude or Muse session or quitting CodeShip waits for that stop to finish. Muse model and usage checks, which run no tools, stop what they left running only when they fail or keep their output open, so they stay as fast as before. A Muse host started through `muse.cmd` also no longer leaves Muse running after CodeShip closes it.
- The rest of the server's commands, such as provider version checks and maintenance probes, now stop what they left running when CodeShip kills or cancels them, or when their output is still held open as they end. A command that exits on its own and closes its output starts no extra PowerShell, so checks stay as fast as before.

## 2026-11-16 — A fork finds its project on another machine, and agents and mobile set the update interval

- A delegated task sent to another machine without a project, and a scheduled task shared with other machines, now find the project there by any remote either side knows, the fork's own `origin` first. A fork whose copy on the other machine has no `upstream` remote failed to find it before. A new shared task in a fork is keyed by the fork's own `origin`. Shared tasks this machine stored under a fork's upstream move to that key once, at the next start, and keep their machine order; a task another machine shared keeps its key when you edit it here, so it still finds its project there.
- Agents can read and set **Time between automatic updates** with `t3_environment_read` and `t3_environment_preferences_update` (`minHoursBetweenAutomaticUpdates`), and the mobile app shows it under Settings → Maintenance & about → Updates.
- A fixed-time scheduled task whose time passes while an automatic update waits for running chats to finish runs once right after the update, even when the wait outlasts the missed-run grace and **Catch up a missed run** is off, unless its next run is nearer. That still holds when a restart cuts its run condition, when it waits for another machine's turn and is reached late, or when this machine was still watching another machine's run of the time before. It was recorded as missed before.

## 2026-11-16 — On Windows, stopping a process also stops what it left running

- On Windows, a process that had started another and then exited left that child running when CodeShip stopped it, because `taskkill` finds a process's children only while the process runs. CodeShip now finds them from the parent process id and start time Windows records for each process, also after the parent exited. This covers the commands the server runs (git included), Pi and ACP agent sessions such as Grok, and the Antigravity installation check. The server does this for a command it kills or cancels, or one whose output is still held open when it ends; a command that exits on its own and closes its output skips it, since each stop starts PowerShell. A tree CodeShip cannot end is logged as an error in the server log.
- On macOS and Linux, a command whose own process had exited is stopped through its process group, and that group's number could by then belong to unrelated processes once the command's process id had been reused. CodeShip now leaves such a group alone: a process id is reused only after a group of that number has ended.
- Maintainers: `check:changed` on Windows also stops what its git and `vp` runs leave behind. The lint rule `t3code/no-raw-taskkill` refuses a `taskkill` call and points to the shared tree stop in `@t3tools/shared/windowsProcessTree`.

## 2026-11-16 — Scheduled tasks count every run and skip for 90 days

- `list_scheduled_tasks` now returns each task's runs on that machine over the last 7 and 30 days, by outcome and by skip reason, so the share of runs a run condition skipped can be measured. Run history keeps only the newest 10 skips of each kind, so on a task that runs every 30 minutes it covered a few hours. The counts are kept per task and day for 90 days, start from the runs history still holds, and are removed with the task.

## 2026-11-16 — A scheduled task shows a run condition that keeps failing

- A run condition that prints indented JSON, such as PowerShell's `ConvertTo-Json` output, now has its `reason` (or `error`) field recorded as the check's reason. Only the last line, often a lone `}`, was recorded before.
- When a task's last 3 scheduled checks on a machine all fail, its row in Settings, on linked machines and on mobile, and the thread's Automations panel, show a warning with the latest reason. Each of those runs started anyway, so nothing showed the check was broken. `list_scheduled_tasks` reports it as `failingCheck`.

## 2026-11-16 — Desktop app logs no longer carry e-mail addresses or credentials

- The desktop app's own log lines on screen now replace e-mail addresses with `[email]` and credentials with `[redacted]`, as the server's do. A value logged after its name, such as `"token:"` followed by the token, is now hidden on screen and in OTLP log exports too.

## 2026-11-16 — An agent's POSIX command runs unchanged on Windows

- `t3_command_run` takes `shell: "bash"`, which runs the command as written in bash on every OS. On Windows that is Git Bash, started with the command in a file, so PowerShell 5.1 no longer strips the double quotes from a command such as `grep -E "^# (pass|fail)" results.txt`, which then lost its file argument and waited on its input until the time limit. Without the option a Windows command still runs in PowerShell.
- A Windows command now reads its input from `NUL`, as a command elsewhere reads `/dev/null`, so one that reads input ends at once instead of waiting until its time limit.

## 2026-11-16 — Server logs and traces no longer carry e-mail addresses or credentials

- Server logs (on screen, in the relay log and exported over OTLP), provider event logs, the trace file and exported traces and metrics now replace e-mail addresses with `[email]` and credentials with `[redacted]`: auth headers, API tokens, private keys, sign-in details in URLs and connection tickets. A provider error that named the signed-in account could reach them before. Provider errors shown in a thread now leave out e-mail addresses too.

## 2026-11-16 — Automatic settlement opens pull requests only for threads you wrote in

- Automatic settlement used to open a pull request for any thread with unmerged worktree work, including a subagent's or a scheduled run's, so work that agents had not finished or that had failed review went up for merge. Now only a thread you wrote in from the app gets one; messages T3.CodeShip sends for you, such as the automatic "continue" after a stop, do not count. A thread you never wrote in, such as a scheduled run or a subagent, stays active with its work in view instead; once you write in it from the app, it can get one too.

## 2026-11-16 — `bash` in a Windows agent command runs Git Bash, not WSL

- On Windows, a `bash` or `sh` in a command an agent runs with `t3_command_run` now starts Git Bash, which reads `C:/` paths and finds node, instead of WSL's bash, which can do neither. CodeShip finds Git Bash through the `git` on the command's PATH or in the standard install folders, and leaves that PATH as it is, so `git` in the command is still the one it names. Without Git Bash, `bash` fails with an error that says where CodeShip looked; WSL's bash stays reachable through `wsl`. A program the command starts that runs `bash` itself can still get WSL's, so give it Git Bash's full path.

## 2026-11-16 — A lost agent command keeps a record of how it ended

- When CodeShip's check of a running command's process fails for a reason other than "no such process", it checks again on its next pass instead of reporting the command lost and stopping what the command started.
- A command reported lost (`t3_command_run`'s "Ended without an exit status") now keeps on its record why: its process ended without one, the machine restarted, or its process id now names a later process. The record also keeps when the command was last seen running, what the failed check reported, and its last output. When more than half the commands that ran in the minute up to a loss are lost (a lone lost command counts when it was the only one), CodeShip logs one warning and writes the lost commands to `logs/command-losses.ndjson` in its data folder. A command lost within a minute of the one before it joins the same entry. Both hold across a restart of CodeShip, however long it was stopped. An entry lasts as long as its commands' records, 14 days after each command's end reached its chat, and one CodeShip could not write is written once it can.
- On Windows, stopping a command no longer stops a process that an earlier holder of one of the command's process ids started.
- On Windows, a Ctrl+C, Ctrl+Break or close event in a command's console no longer ends the process that records its exit status, so the command is no longer reported lost: that process now has a console of its own, and the command's console has no window to close.

## 2026-11-16 — The server stays responsive while it looks up pull requests on Windows

- On Windows, every git process the server started froze it for about 130 ms, and the pull request lookups of a sweep started about 14 per thread. With many threads the server stalled for minutes: git commands timed out at 30 s, and Machine health runs and scheduled runs failed to register MCP or prepare their worktrees. The lookups now read a repository's configuration and refs once, with two git processes shared by all of its threads and worktrees, instead of per thread.
- `check:changed` no longer fails on Windows with `listen EACCES` when a checkout's web browser test port falls inside a block the system reserves; the port now comes from a range below the system's own.
- A pull request refresh still sees a branch pushed a moment ago, and an action that acts on the answer (settling a thread, removing a worktree) still reads git fresh.

## 2026-11-16 — A finished run no longer goes back to waiting and blocks its queue

- When a delegated task or command finished just after its parent's run completed, the parent could go back to waiting and lose its checkpoint, and the next queued message did not start until CodeShip restarted. A task result now changes only the parent's task bookkeeping, and the server refuses any write that would put a finished run back to an earlier state or drop its checkpoint. Checkpoint capture, a provider's final events and shutdown recovery now each read a run and write it while holding the thread, so none of them can write a state another change has already replaced.

## 2026-11-16 — The manual Windows server test run fits its time limit

- Maintainers: the Windows Tests workflow now splits a full `apps/server` run into eight shards, balanced by recorded duration, instead of one job that hit the 45-minute limit. Runs of other packages or of chosen files are unchanged.

## 2026-11-16 — Test lint catches early returns hidden behind a platform helper

- **Maintenance:** the `no-platform-early-return-in-tests` lint rule now also flags `if (yield* runsOnWindows) return;` when the helper wraps a host-platform check, and four tests that returned early on Linux now skip instead of reporting a pass.

## 2026-11-15 — Usage resets redeem by one rule on Claude and Codex

- **Redeem usage resets automatically** in **Settings → Recovery** now claims banked resets for every Claude and Codex account on the machine by one rule, with no model involved. When an account's limit is out, CodeShip waits if the limit's plan reset is at most **Wait at most N hours for a plan reset** away (48 by default) and otherwise redeems the banked reset that clears that limit and expires first: a full reset clears any limit, a weekly or 5-hour one its own, a Fable one only Fable's. A reset that would expire unused is redeemed when a limit it clears runs out for the last time before it expires, whatever the wait, and nothing is redeemed while the account can still be used. Claude's weekly 5-hour reset is left for **Use reset**. A claim is made once per limit and plan reset, on Codex even across machines on the same account; for a Claude account signed in on several machines, turn it on on one of them, since two machines could claim at the same moment. It is decided on a fresh, uncached reading of the account, after any **Use reset** on it finishes and with the settings as they are then, and Claude and Codex use nothing once the login holds another account. **Use reset** now spends only the account it was pressed for on Codex too. A claim that used nothing, because the provider refused it or it failed, is tried again after 15 minutes. After a redemption the account's holds lift and its usage is read again.
- The per-account **Use reset credits automatically** switch became this one setting, which starts off: turn it on if you want it. Agents see the outcome of the account's last claim in `usage`, and `maxWaitHours` and `redeemUsageResets` in `orchestrator_capabilities`.

## 2026-11-15 — Windows test runs no longer fail on POSIX-only command tests or drive-letter paths

- Five server tests still failed on Windows: four ran `printf` in a shell that has none, and one expected a Unix path where Windows adds a drive letter. The POSIX ones now skip and the path test follows the host. The remaining command-runner tests that returned early on Windows also skip, so a run reports them as skipped.

## 2026-11-15 — `check:changed` catches a dependency without a license notice

- Maintainers: `vp run check:changed` now checks the third-party license notices the web and mobile builds generate, so a new dependency without a license file fails there instead of in the release build. `vp run licenses:check` runs the same check on its own.

## 2026-11-15 — A cancelled terminal open no longer leaves its shell running

- When opening a terminal was cancelled just as its shell started, for example because the app disconnected, the shell could keep running with no terminal to reach it. It now always belongs to its terminal, which shows its output and can stop it.

## 2026-11-15 — Claude accounts show their banked resets

- **Usage → Limits** now shows how many banked resets a Claude account has and when the next one expires, and **Use reset** uses the one that expires first. Agents' `usage` lists each reset: its kind (5-hour, weekly, full or Fable), how many are left, when it expires, whether it can be used now or only at a limit, and whether it is paused, plus whether Claude offers the account its weekly 5-hour reset and when that is next available. CodeShip asks Claude's own `/limit-reset` in a hidden terminal, on macOS too, at most every six hours and again when the account reaches a limit, and asking never uses a reset.
- Accounts that share a Claude login take turns: a read waits for a reset in progress, and reads due meanwhile are made once. Resets read before one was used, or for a different account than the one signed in now, are not shown, and **Use reset** uses nothing once the login has switched to another account, even while Claude starts. After **Use reset** on a Claude or Codex account, CodeShip reads usage again even if the request was cancelled, and says so when that read did not confirm the new limits. A Claude terminal stopped while it starts is always closed, on Windows too, and one that does not start within a minute is closed so the login's other reads go on. CodeShip reads only answers Claude has finished drawing. A screen it does not recognize, or a Claude config it cannot read, gives agents' `usage` a reason code instead of a guess.

## 2026-11-15 — The Windows test lane runs on a runner this repository has

- The on-demand Windows tests waited forever for a runner that only upstream's account provides. They now run on GitHub's own Windows runner, so a Windows test run starts and finishes.

## 2026-11-15 — Agent commands on Windows no longer open a terminal window

- On Windows, every command an agent ran with `t3_command_run` (tests, builds, installs) opened a console window titled `C:\WINDOWS\system32\cmd.exe`, which Windows 11 shows in Windows Terminal, and it stayed open until the command ended. These commands now run in a hidden window. Their output still goes to the chat as before.

## 2026-11-15 — A failed usage check no longer counts as a full one

- An account whose usage check failed, and whose meters then came back during a turn, no longer looks as if its usage was fully read at the failed check. Only a successful check can free an account waiting out a limit.
- Maintainers: `vp run check:changed` also runs the test files beside each production file that imports a changed file, so a change to a shared helper runs the tests of the services built on it.

## 2026-11-15 — Webhook tasks can check Standard Webhooks signatures, such as ThreadPage's

- A webhook task's **Require signature** now offers a **Standard Webhooks** scheme next to the HMAC-SHA256 one. Enter the sender's `whsec_` secret; requests with a missing or forged `webhook-signature`, or a `webhook-timestamp` more than 5 minutes from when they arrived, are rejected, and a repeated `webhook-id` runs only once. Agents can choose it with `schedule_task` as `signature: { scheme: "standard-webhooks" }`.

## 2026-11-15 — The weekly upstream sync ends within three hours

- The scheduled "weekly sync from T3 Code" task no longer chases a busy main for hours. It merges upstream into the main it started from and, when main moves before it lands, merges main in at most twice more. When main conflicts with the sync, or the run passes 3 merges or 3 hours, it stops, pushes its branch, and names the conflicting files in its report and follow-up. `node scripts/upstream-sync.ts` keeps those bounds.

## 2026-11-15 — A one-machine task no longer runs twice when its machines run different versions

- A task shared with **One machine** could run on two machines in the same occurrence when one of them ran an older T3.CodeShip, because the two followed different rules for deciding who runs it. Machines now tell each other which rules they follow. When a machine that would run the task is on other rules, this one leaves the occurrence to it and records a skip that names that machine; the task row and **Run history** say to update T3.CodeShip on both machines.

## 2026-11-15 — Agents can read each account's usage

- Agents asking `orchestrator_capabilities` with `usage: true` now get each Claude and Codex account's usage: the plan, the 5-hour, weekly and model weekly meters (such as Fable's) with their resets, paid credits or extra usage, Codex's banked resets, and whether the account may be used now (never while it waits out a limit). With `environmentId` they read a linked machine's accounts. A reading older than 10 minutes is read again, at most once every 10 minutes. Paid credits Codex reports spent are dropped. An account whose usage cannot be read shows a reason code instead. Each account has a key that is the same on every machine and contains no account id or e-mail. Claude's banked resets are not read yet.
- A scheduled task that picks its account automatically now takes, among the accounts with room, the one whose weekly limit resets first, so usage that would reset unused goes first. A task chat whose account still has room stays on it.
- A Codex account waiting out a usage limit is used again as soon as Codex says it may be, for example after a banked reset was used, instead of at the limit's reset time, even while its meter still shows 100%. CodeShip checks a waiting account at most every 10 minutes; one Codex gives no answer for is checked hourly as before. Only a full usage check made after the limit counts, never a meter update sent during a turn. A Codex account that Codex says may not be used is skipped by automatic account choice even while its meters show room.

## 2026-11-15 — `t3_command_run` reports the shell it used

- The result of `t3_command_run` now names the shell that ran the command (`powershell`, `bash`, `zsh` or `sh`), so an agent that wrote bash syntax for a Windows PowerShell command sees why it failed. A test keeps the tool's description and the shell the runner picks in step.

## 2026-11-15 — Signing in to an account you just added no longer fails with "no longer available"

- Adding a provider account (**Settings → Providers → Add**) could stop at the sign-in step with "This provider instance is no longer available.", most often for a Claude account. The account had been saved, but the save answered before the server had loaded it, and the sign-in step asked for it in between. A save that adds, changes or removes an account now answers once the server has loaded it, so the sign-in step opens straight away. A finished sign-in likewise reports success once the server runs the account with its new sign-in, so a chat started right away uses it. An account added before this release can be signed in from its row in **Settings → Providers**.

## 2026-11-15 — A chat no longer keeps a queued message held after an old restart bug

- A message queued behind a run that a restart cut could stay held for days, with the chat showing as finished. With "continue threads after an update" on, the next server start now starts it, and a chat with a held queue is marked `queueHeld` in the thread list and the thread summary.

## 2026-11-15 — Agents on Windows are told that `bash` there is WSL

- `t3_command_run`'s description now says that on Windows `bash` reaches WSL's bash (no node, its own home folder) and gives the Git Bash path, so an agent no longer lands in the wrong environment.

## 2026-11-15 — A manual step is decided only on the machine whose list holds it

- Choosing a solution for a manual step starts its chat only on that step's own machine. When the app is not connected to it, the card says so and offers no choice, and the step stays on the machine's pending list instead of running on another machine.

## 2026-11-15 — Windows and POSIX-only tests now report a skip, not a pass

- 19 tests that returned early on the wrong platform reported a pass without running. They now skip, so a test run shows what ran on each platform, and a lint rule refuses new early returns on the host platform.

## 2026-11-15 — See every machine's CPU, memory and disk on the new Machines page

- New **Machines** page, at the bottom of the sidebar rail and in the command palette, and on mobile at the top of **Settings**. It shows each connected machine's CPU use, core count and load averages, memory, swap, free disk space and uptime, refreshing every 5 seconds while it is open. Values turn amber at 80% and red at 90%, and an offline machine offers to reconnect.
- Hover **Machines** in the rail for CPU, memory and disk on every machine at once.
- A machine on an older version shows only CPU and memory until it is updated.

## 2026-11-15 — Windows test runs no longer fail on POSIX-only command tests

- On Windows, 16 tests of commands run apart from their agent used `sh`, `kill` and process groups and failed or timed out there. They now skip on Windows, where their own tests cover the same stop and lost paths, so a real Windows failure is no longer hidden among them.

## 2026-11-15 — Agents are told which shell their commands run in

- The tool agents use to run a long command apart from the chat now names its shell: bash or zsh on macOS and Linux, Windows PowerShell 5.1 on Windows. It also says PowerShell 5.1 has no `&&` or `||` and how to chain steps there, so a Windows command no longer fails with "not a valid statement separator".

## 2026-11-15 — A scheduled run a restart cut before its prompt no longer leaves an empty chat

- When a restart cut a scheduled run after its chat was made but before the task's prompt reached it, the run was shown as failed but its empty chat stayed in the sidebar. The next startup now deletes that chat and shows the run as interrupted in its history; a recurring task runs again at its next time, as after any missed run. A chat you wrote in or moved to another folder is kept.
- A restart-cut run whose chat had only your own message in it was counted as succeeded. Startup now checks for the task's own prompt, so such a run is shown as interrupted.

## 2026-11-15 — Workspace preparation errors say why Git detection failed

- When a workspace could not be prepared because CodeShip could not tell whether a folder is a Git repository, the error only said "Failed to resolve the VCS driver". It now adds the cause: a timeout (and how long), or Git's exit code and its last error lines, such as a broken `.git/config`. A folder that is simply not a repository is still treated as one.

## 2026-11-15 — Pull request lookups start far fewer git commands

- A pull request lookup used to start about ten `git` commands, each re-reading the repository's remotes and configuration. On a machine short of memory with many open chats this added up to hundreds of commands and slowed the server. A lookup now reads the remotes and each configuration value once and shares them for the whole lookup.

## 2026-11-15 — Automatic updates no longer cut running scheduled runs

- A machine that always has a chat answering used to install an update after a fixed 2-hour wait, which cut every running turn and its delegated chats. Now, after the wait, the update holds new scheduled starts so the running turns can finish, installs when they end, and starts the held runs right after. A turn still running after a further 3 hours is cut and resumes as before, and the log names each chat it cut.
- New setting **Time between automatic updates** (**Settings → Maintenance**, default 4 hours): after a restart, automatic updates wait this long before installing the next release, so a machine that receives many releases a day restarts a few times instead of at every release. The setting is shared like the other update settings; agents do not set it yet.

## 2026-11-15 — `check:changed` installs the browser its web browser tests run in

- For contributors: on a machine without Playwright's Chromium for the current Playwright version, `vp run check:changed` failed every web browser test with "Executable doesn't exist". When a run includes web browser tests, it now first installs the Chromium build CI installs. Already installed, this takes about two seconds.

## 2026-11-15 — Pull request guides are written in your app's language

- A pull request's review guide is now written in the app's language (**Settings → General → Language**) on web, desktop and mobile. Its closing "Other files" stop is labelled in that language too. Before, it came in English whatever language you chose.
- Each language keeps its own guide. Guides written before this release stay as the English ones; in another language, choose **Write guide** to have one written in it.
- Agents writing guides with `write_pull_request_guides` and reading them with `read_pull_request_guide` can pass `language`, such as `uk`; without it they write and read the English guide. Apps that predate this release keep getting English guides.

## 2026-11-15 — Manual steps show in your app's language

- A manual step's AI review is now written in the app's language (**Settings → General → Language**). Before, it followed the language of the step's title, which agents write in English, so the review came in English whatever language you chose.
- Once its review is ready, a step's text and title show translated into the app's language too, in the thread list, the sidebar and the **Manual steps** page, on web, desktop and mobile. The chat that **Choose** starts still gets the step as it was written.
- Reviews written before this release are dropped and written again in your language the next time a step is shown. Apps that predate this release keep getting English reviews, and a server that predates it shows steps as written.

## 2026-11-15 — A restart no longer leaves a chat's next message waiting forever

- When a server restart cut a chat whose agent had already finished its turn, a message queued behind it stayed held for a resume that never came, so the chat never ran again. A message queued behind a run whose turn had finished now starts after the restart. A chat a restart already left in that state starts again on the next start. A chat that is snoozed, settled or archived still stays as it was.

## 2026-11-15 — A long database update no longer floods the server's trace files

- While a large database was updated at startup, the server wrote a trace entry for every stored row it rewrote, about 10 MB every 10 seconds, so the trace files lost everything from before the update within minutes. The update now writes one entry per step instead.

## 2026-11-15 — Tests check that `t3 doctor` removes old tool output before it compacts

- Maintenance only, with no change in behavior. A test now runs `t3 doctor`'s compaction on a database file and checks that it removes tool output older than the **Remove old tool output** setting allows, keeps newer output, and returns the removed space to disk.

## 2026-11-15 — Service updates no longer pile up launchers

- When T3.CodeShip runs as a service, each update handed the service to the new release's launcher but kept the previous launcher running, so every update left about 300 MB behind until the service restarted. A launcher that took over the service now hands it back to the one the service manager started, which starts the newest launcher, so a service runs at most two launchers. A service installed with an earlier release runs at most three until `t3 update` or `t3 service install` on that machine reinstalls it, and launchers that piled up before this release stay until the service restarts.
- If a new launcher fails after it took over, the service now restarts, so nothing that launcher started keeps running beside the next server. A service installed with this release or later then keeps its old launcher until the next release. Before, the old launcher took the service back on its own, could start the release it had handed over instead of the one the service had moved to, and could do so while the failed launcher's server was still running.
- Stopping the service while an update hands it to a new launcher now stops it at once, instead of starting the new launcher and waiting until the service manager forced the service down.

## 2026-11-15 — Skills page works for Codex accounts connected with ChatGPT

- On the Skills page you can now copy a skill to a Codex account connected with ChatGPT and turn its skills on or off, as you already could for a Codex account that uses an existing login.

## 2026-11-15 — Windows Codex accounts keep configuration changes

- Skill toggles and other Codex configuration changes made through an added account on Windows now survive provider refresh and reach the shared Codex home, including configurations linked to a dotfiles folder. Conflicting, unrecognized or oversized copies are kept as backups instead of being replaced.

## 2026-11-15 — Git commands that finished are no longer reported as timed out, and idle chats stop starting git

- When the server stalled, for example while agents loaded the computer, a git command or other command that had already finished could be reported as timed out, and the action that ran it failed. A command that finished before its time limit now counts as finished, and starting it no longer eats into its limit.
- Starting git no longer freezes the server. On a loaded Windows computer, starting each git process took seconds, and the server answered nothing meanwhile. Git and the server's other commands now start on a separate thread. A command cancelled while it waits to start stops at once, and if that thread fails, the commands it started end with the processes they left running.
- Idle chats no longer start git every minute. Branch and pull request checks reuse each worktree's git state for up to five minutes and read it again before acting on the answer, and a worktree whose unmerged work keeps its chat open is checked once per hold instead of every minute, even when several chats share it.
- **Settings → Source control → Git fetch interval** has a minimum of 15 seconds, the shortest time between fetches of a repository. A shorter value is raised to 15 seconds, and 0 still turns it off.

## 2026-11-15 — Agents can name a chat by the link T3.CodeShip gave them

- Every agent tool that takes a chat's thread id now also takes the chat's `link`, the `<t3-thread://v2/…>` form T3.CodeShip's tools return, with or without its angle brackets, as a Markdown link, or as the web address an outside client gets. A link to a chat on a linked machine goes to that machine, as `environmentId` would. Before, `t3_thread_read` answered such a link with "Thread … is no longer available" even for a running chat, so a machine inbox run could take the chat for stopped, clear its claim and start a second chat on the same work.
- A link the tool cannot follow now says so: one that names no chat, one for another machine passed to a tool that works only here, or one whose machine differs from the `environmentId` passed beside it. A link to a machine that is not linked names that machine. A chat that really cannot be found is reported as not found, without saying it was ever there.

## 2026-11-15 — The server stops rereading idle chats while it checks for an update

- With many Codex chats, the server reread every chat that had ever used Codex's shared session each time any chat's work changed, once for every open window and linked computer, to tell whether an update would stop anything. That kept the server and the disk busy and filled its trace log in seconds. It now reads only the chats with work a restart would stop, once for everyone who watches.

## 2026-11-15 — Claude chats try registering their MCP tools again

- When a Claude chat's MCP tools took longer than 90 seconds to register, its turn failed with "Claude timed out while registering its MCP tools". Registration is now tried once more before the turn fails, also in a new chat such as a scheduled task's, as long as Claude saved no conversation file on the first try.
- A stall of the server counts against that limit, and the other limits that already skip time the computer slept, for at most a second: a stall shorter than five seconds used to cost up to five.

## 2026-11-15 — The server keeps up while agents load the computer

- Agents, and the commands they run with `t3_command_run` or in a terminal, now run at a lower CPU priority than T3.CodeShip's server on Windows, macOS and Linux, so builds and tests that use every core no longer leave the server too slow to answer its chats or register a Claude chat's MCP tools.
- The background checks that look for chats to recover after a usage limit or a lost connection, pull requests to sync and runs to settle, along with storage cleanup and maintenance, now read the database on readers of their own, so a slow check no longer delays opening a chat or starting a turn.
- When a provider's start or a Claude chat's MCP tools time out because the server itself stalled, the error now says so and names the log of the server's stalls, and the same message runs again by itself, as it does when the computer slept.

## 2026-11-15 — The fork's shared tasks say which machines get no copy

- `machine-config.json` now says that the translation and upstream sync tasks exclude Zoro-PC in their settings and that the job machine gets no copy, because it is not linked to the machines that run them. Before, it said both were excluded in the task settings, which CodeShip refuses for a machine no copy can reach.

## 2026-11-15 — The fork's translation and upstream sync tasks are shared

- The fork's daily translation check and weekly sync from T3 Code read their instructions from `automations/` in this repository and run as shared one-machine scheduled tasks: Zoro-VPS first, the MacBook when the server is down. `machine-config.json` declares both tasks, so `machine-config.mjs check` on either machine reports a copy whose prompt, schedule, model or machines differ.

## 2026-11-15 — Claude Full access follows the settings Claude Code keeps

- Whether a Claude chat may use Full access now follows only the settings Claude Code itself keeps for the chat. Before, T3.CodeShip read your organization's cached settings, the `--settings` launch argument and, for a provider account with its own config folder, that folder's `settings.json` by itself, so a setting Claude Code ignores could still turn Full access off: one in a file with an invalid field, comments or trailing commas, a bypass switch value Claude Code does not accept, or an account `settings.json` Claude Code cannot read.
- Full access, tool search and a delegated chat's prompt cache lifetime now share one settings read when a Claude process opens. It is taken before a running process is replaced, so when a model change needs a new process whose settings cannot be read, such as a `--project-config-root` folder that no longer exists, the turn says why and the running chat keeps working.
- When the `--settings` launch argument has a field Claude Code rejects, a Claude chat still gets its thinking, fast mode and compact window choices and the tool search switch. Before, these went inside the rejected settings, so Claude Code dropped them too, or the tool search switch made the rejected settings valid again with their restrictions.

## 2026-11-15 — Delegated chats on another machine settle even when that machine is busy

- A task delegated to a linked machine settles its chat there once its parent has the result, but when that machine was too busy to answer or the connection dropped at that moment, the chat stayed active until it settled by itself after three quiet days. The settle is now tried again for about 20 minutes, and only while that chat still has nothing newer to show, such as a message sent to it since. Stopping the parent or cancelling the task ends those tries at once, so the stop reaches that machine without waiting and the chat there stays as the stop left it.

## 2026-11-15 — A scheduled run cut by a restart keeps its chat

- When a restart cut a scheduled task's run right after its chat started, **Run history** marked the run as failed and lost its chat. The chat went on working after the restart, but it did not count toward the task's **Live runs** limit, so the next time could start a second chat beside it, and the task's group did not file it. A run now records its chat before starting it, and after a restart a run whose chat got its prompt counts as started: it opens its chat, counts toward the limit and is filed with the task. A run whose chat never got its prompt still fails as interrupted. This holds whether T3.CodeShip was quit or crashed, and a **Run now** run goes on when the client that started it disconnects.
- The agent tool evals now check that an agent asked to let an interval task run two chats at once raises `maxLiveRuns` on that task instead of creating a second task.

## 2026-11-15 — Claude's skills and update channel follow every managed setting

- The Claude skills T3.CodeShip lists, the release channel it checks for Claude updates, the endpoint behind a Claude provider's status and the label Claude sessions report now come from your organization's managed settings wherever Claude Code finds them: `managed-settings.d` drop-ins, MDM and the account's server-managed settings. On Windows they are read from `C:\Program Files\ClaudeCode`, where Claude Code keeps them. A provider's `--setting-sources` and `--project-config-root` launch arguments now also apply to the settings read for its skills, and, as in Claude Code, a settings file with one invalid field counts for nothing there too. A delegated Claude chat's prompt cache lifetime also comes from the account's server-managed settings and the `--settings` launch argument.
- When your organization computes Claude's settings with a policy helper for your operating system, which T3.CodeShip cannot run, or Claude's cached copy of your organization's settings cannot be read, T3.CodeShip no longer guesses: Full access is unavailable, no Claude skills are listed, the update check is skipped, a delegated chat keeps Claude's own cache lifetime, `t3_command_run` tells the agent why it cannot run, and a provider without a login of its own shows a warning that its login cannot be confirmed instead of showing as signed out. A policy helper set only for another operating system no longer counts.
- A Claude message that names no skill no longer waits for Claude's skills and settings to be read before it is sent.

## 2026-11-15 — Releases publish again after notes landed out of date order

- A shipment whose release-notes entry landed above newer ones stopped every later release, since each release checks its notes against the one before. The entry is back in date order, the check now lets a shipment move an earlier entry back into place, and pushing to `main` from a T3.CodeShip checkout runs the same check first.

## 2026-11-15 — `t3_command_run` commands get the agent's shell environment

- A command an agent ran with `t3_command_run` got T3.CodeShip's own environment, so the variables the agent's own shell commands get were missing, such as a `NODE_OPTIONS` set in Claude's `settings.json` `env` or in Codex's `[shell_environment_policy.set]`. The command now gets them too, read for the chat's folder the way the agent's session reads them, along with the variables set on the provider account in **Providers**. A Codex `shell_environment_policy` applies whole, so `inherit`, `exclude`, `include_only`, `filters` and the default excludes also remove variables, as in Codex's own shell, Codex's own launch variables such as `NODE_REPL_AUTH_TOKEN` stay out even when the policy sets them, and Codex's `apply_patch_preserve_line_endings` feature reaches the command, so running Codex's `apply_patch` there keeps a file's line endings exactly when Codex would. A Muse Code command keeps out an inherited `META_API_KEY`, as Muse itself does, unless the provider sets its own. On Windows it also starts from T3.CodeShip's environment, as the agent's own shell commands do, instead of the variables Windows keeps for your account; values outside your system code page, such as a Cyrillic folder name, arrive intact, settings that change `PATH` or `SystemRoot` cannot change which PowerShell runs it, and a command still reports its real exit code when the agent's environment sets `ERRORLEVEL`. On macOS and Linux a shell option the agent's environment sets, such as `SHELLOPTS=errexit`, applies to the command without stopping T3.CodeShip from recording its exit code. When they cannot be read, for example because the agent's provider was turned off or removed or Codex does not start, Claude's `--settings` launch argument names a missing file, or your organization computes Claude's settings with a policy helper, the agent is told why and nothing runs.
- A Claude provider's `--setting-sources` launch argument now also limits the settings files T3.CodeShip reads for its chats, such as whether Full access is allowed. `ENABLE_TOOL_SEARCH` now also comes from your organization's managed settings wherever Claude Code finds them, including MDM and the account's server-managed settings. As in Claude Code, a repository root's `.claude/settings.local.json` counts only when you own that folder, its `.git` and its `.claude`; otherwise the one in the chat's folder does. A settings file or `--settings` value with one invalid field counts for nothing; `--settings` is judged as Claude Code receives it, so a `false` bypass switch T3.CodeShip leaves out, or a field T3.CodeShip sets for the turn's model options, does not count against it. `--project-config-root` moves the project and local settings to the folder it names, at its real path as Claude Code reads it; a turn whose `--project-config-root` is not the absolute path of an existing folder you can list now stops before Claude starts and says so.

## 2026-11-15 — Claude chats no longer stay working after a background task reports back

- When a Claude subagent or background command finished while the agent was still working, and you sent a message right then, Claude answered both in one go. T3.CodeShip still waited for a separate answer to the task's report, so the chat showed as working for hours and every message sent after that waited in the queue. That wait now ends as soon as Claude has answered, and it also ends when Claude is not working on the report two minutes later.
- When Claude's session closed while a message was being sent, the run could show as running with nothing sent to Claude. A message sent while the session restarts now goes to a new session, and a session that closes once the message is on its way ends the run instead of leaving it running.

## 2026-11-14 — Stopping a command on Windows also stops what it left running

- On Windows, stopping a command (cancelling its task, stopping the chat, a timeout) ended it only while its wrapper was still running. When the wrapper had ended, or a restart cut the stop, what the command had started kept running although the task was reported stopped or lost. A stop now also ends every process that descends from the wrapper's pid and started after the command did, including after a restart.

## 2026-11-14 — Auto no longer starts on a signed-out account when every account is limited

- With account switching on, Auto already took the first account with usage left, but when none had any it started a new chat on the first account in the order, even one whose login had failed, and kept a chat on a signed-out account. It now waits on a signed-in account instead: a chat stays on its own account while that account can still run, and otherwise starts on the signed-in account whose limit ends first. See [Auto](user/thread-sidebar.md).
- A chat whose login was rejected before the agent did any work moves to another account as soon as one gets usage back, instead of up to ten minutes later. It moves when its message had attachments too, and sends them again with the message instead of waiting for you.
- When a limited or signed-out Auto chat looks for another account, or for room on its own, it checks usage for the model Auto runs now, not the one the chat last ran, so changing a coordinator model no longer keeps it waiting on a limit that model does not have, and a banked usage reset is spent only when that model is used up.
- A Claude turn that the API refused with 401 now counts as a rejected login even when Claude sends no sign-in error first: the chat shows how to sign in again instead of ending as completed, the account reads as signed out, and the chat moves to another account.

## 2026-11-14 — Link errors say what answered at each address

- When linking an environment, or reaching a linked one, fails because nothing answers there as T3.CodeShip, the error now says what happened at each address: it did not answer in time, could not be reached, answered with an HTTP error status, answered as another environment, or sent an answer that is not a T3.CodeShip environment's. Before, it only listed the addresses.
- Test servers now listen on 127.0.0.1, the address their tests dial, so another program that opens the same port on 127.0.0.1 can no longer answer for them. This made the linked-environment tests fail now and then on a busy machine. A lint rule now reports a test server that listens on a port without naming its address.

## 2026-11-14 — Runs move off a Muse Code account whose login was rejected

- When Muse Code refuses a message because it rejected the account's login, the run now fails with "Muse Code rejected this account's login. Run `muse login` on this T3.CodeShip server host." and the account shows as signed out in **Providers** and **Manual steps**. Before, the run failed with Muse's own error, and Auto, account switching and scheduled tasks kept sending work to the account. While it is signed out they use the next Muse account, and with account switching on, a chat that failed this way before its agent did any work starts again there with the same message, as for Codex and Claude. The account counts as signed in again once you run `muse login` on the host and refresh provider status, or once a message sent after the new login completes; a chat still running on the old login does not clear it. A new `muse login` takes effect without restarting T3.CodeShip. When the provider instance sets its own `META_API_KEY`, the message says to replace that key instead, because the key outranks `muse login`. An MCP server that refuses its own credentials does not sign the account out.
- A chat on a Claude account whose login was rejected now moves to the next Claude account too. Claude's "Failed to authenticate" notice counted as a reply, so the chat never moved. The notice no longer shows as a message; the error below it already says how to sign in.

## 2026-11-14 — One-machine tasks no longer run twice across versions

- A one-machine scheduled task could run twice in the same slot when its machines ran different T3.CodeShip versions: the later machine could not read the first machine's answer, counted it as away, and started the run while the first machine was still running it. The check now reads only what it needs from the other machine's answer, so a newer version that changes anything else no longer hides its run.
- A machine ahead in the order that answers in a way this version still cannot read now counts as running the time: the later machine waits and checks again, as it does for a machine that is still running, and leaves that time to it when the next one is due. A machine that cannot be reached at all is still taken over from, as before.
- While watching another machine's run, a later machine now asks every machine in the order each time, so a run another one started meanwhile is no longer missed.
- When a linked machine's answer cannot be read, **Settings → Machines & access → Linked environments**, `t3 environment list` and the task's warnings now say which machine runs the older version and to update it, instead of asking you to update both, whenever the two versions compare. The warning has a line of its own and stays while that version runs there, also after a call that works or while that machine does not answer.

## 2026-11-14 — Local tools can read the folder each Claude account runs in

- T3.CodeShip now writes `providers/claudeAgent/accounts.json` in its state folder (`~/.t3/userdata` by default), listing each enabled Claude provider with the folder it runs Claude in, so a tool that reads Claude's login, such as a usage meter, no longer has to work the folder out from the settings and get it wrong. A folder set from a secret is listed without its path, and a provider that cannot start is listed with its reason. See [Separate accounts or configurations](user/providers-claude.md#separate-accounts-or-configurations).
- On Windows, provider **Environment variables** named in lower or mixed case now count as Windows reads them. A Claude provider's `claude_config_dir` runs it in that folder; it used to sign in to a folder T3.CodeShip made for it instead. A `claude_code_entrypoint` replaces T3.CodeShip's label, and a Codex account's `codex_home` that moves it to another login clears its usage-limit holds, as `CODEX_HOME` does.
- A Claude provider whose `CLAUDE_CONFIG_DIR` is a relative path now uses the same folder in every chat, resolved against the folder T3.CodeShip started in; each project used to get a folder of its own. Sign in to such a provider again, or set an absolute path.

## 2026-11-14 — Runs move off a Codex account whose login was rejected

- When Codex rejects an account's login (its saved sign-in no longer works, ChatGPT refuses a ChatGPT-sharing connection's token even after renewing it, the connection was removed, or it no longer allows token sharing), the run now fails with "This account's sign-in was rejected" and the account shows as signed out in **Providers** and **Manual steps**. Before, the run failed with Codex's own error, the account showed only a failed status check, and Auto, **Switch accounts at usage limits** and scheduled tasks kept sending work to it.
- While the account is signed out, they use the next Codex account that can run the model, and a chat that failed on it before its agent did any work starts again on that account with the same message, as for a Claude account. It counts as signed in again once you sign in (`codex login`, or reconnect ChatGPT in **Settings → Providers & models**).
- A ChatGPT-sharing connection refused that way keeps its saved sign-in, so it runs again by itself once ChatGPT accepts one of its tokens. Until then it stays signed out, also after T3.CodeShip restarts or when a later check fails for another reason, such as a network error. A new sign-in on that connection is not affected by the old refusal. An error that only mentions a 401 from something else, such as a required MCP server refusing its own credentials, does not sign the account out.

## 2026-11-14 — Commands agents wait on keep running through updates

- An agent that ran tests, a build or a push in its own shell and waited for it lost the result when T3.CodeShip restarted for an update, so updates sat on "waiting for background work". Agents now run such commands with `t3_command_run`. T3.CodeShip runs the command itself, outside the agent and the server, and keeps its log and exit status on disk. After a restart it picks the command up again, and it wakes the chat once when the command ends. Because the command runs without an approval prompt, `t3_command_run` works only in chats set to Full access and the default mode; elsewhere the agent runs the command in its own shell.
- On web and mobile, the chat's Working line and background-work list show each of these commands with its elapsed time, and stopping the chat ends them and everything they started, even when T3.CodeShip restarts while stopping them. Updates no longer wait for them. The Safe update dialog, Update everything and the update button's tooltip say which commands carry on through the update.
- `t3_background_wait` is removed. A chat that was waiting through it when this update installs gets its note with your next message.

## 2026-11-14 — An update that rewrites the database shows its progress instead of failing to start

- The update that shortens stored event ids rewrites every event, which takes minutes on a large database. The desktop app gave up on the backend after 3 minutes, reported that it could not start and restarted it, and each restart began the rewrite again. The rewrite now saves its progress as it goes and continues where it stopped after a restart or a quit, and the desktop app shows **Updating T3.CodeShip** with how much is done until it finishes. Scheduled tasks wait for it.
- A background service that updates itself now rolls an update back only when its migration stops making progress for 30 minutes, not after 30 minutes in total. This starts with the update after this one, because the version already running decides the deadline. The app that started the update waits as long, instead of reporting it failed after 32 minutes.
- When a migration stops making progress for 3 minutes, the desktop app reports that the server did not become ready and offers its recovery options, instead of showing the same progress forever.

## 2026-11-14 — Tool-use evals name the Codex login they run on

- The MCP tool-use evals ran on whichever Codex login `CODEX_HOME` held (by default `~/.codex`), which can be a different account from the one CodeShip runs Codex on, and nothing said which. An exhausted login then failed every sample after about four minutes of retries. The run summary now names the login, a login that is out of usage stops the run at once with its reset time, and the eval's README says how to run on a CodeShip account's login.
- The evals' own tests pass again after the Auto coordinator brief was reworded. They no longer copy the brief's wording, which its own tests cover.

## 2026-11-14 — Automated work waits while the machine is short of memory

- Scheduled runs, delegated tasks and the emulators agents open started no matter how little memory was left, and on a 24 GB Mac they filled it until the kernel panicked. They now wait while the machine that would run them is short of memory: a scheduled run is skipped and **Run history** names the reading (a **Once** task tries again 5 minutes later), a delegated task is refused so the agent works in its own chat, and an agent's emulator or simulator stays off. On macOS, memory is short once compressed memory takes 35% of it or macOS reports memory pressure; on Linux and Windows, once less than 2 GiB is available. Chats you start, **Run now** and webhook runs always start. Turn it off or change the limits in **Settings → Maintenance & about → Background activity**.

## 2026-11-14 — A scheduled-task check can change a ThreadPage thread's description and status

- A run condition can now set a thread's description, status or both with `PATCH $T3CODE_THREADPAGE_URL/threads/<thread id>`, through the machine's saved ThreadPage token, so a check can write a heartbeat itself instead of starting a chat for it. The change names the `revision` the check read, which the folder list now shows for each thread: CodeShip reads the thread right before changing it, and when it has changed since, the check gets 409 `stale_revision` with the thread as it is now instead of overwriting it. It needs **Can edit and organize** access and answers ThreadPage's refusals the same way as listing threads and adding notes. See [Read and write ThreadPage from a check](user/project-settings.md#read-and-write-threadpage-from-a-check).

## 2026-11-14 — New worktrees run the repository's `t3.json` setup action

- A worktree made for a chat that an agent, a scheduled task or an MCP launch starts could open with no `node_modules` and no `.t3/setup-*` marker, because the setup action only ran after someone imported it from `t3.json` in Settings. A project with no action list of its own now runs the setup action its `t3.json` declares. A project that edited its own actions keeps them as saved, including a list with no setup action.

## 2026-11-14 — Agents release a background wait with `clear: true`

- `t3_background_wait` keeps a Claude chat in Working until the tasks it names end. To release that hold early, an agent now passes `clear: true`. The old `waiting` flag read like a field for what the agent was waiting on, so agents filled it with text such as "integration lock" and the call failed. Leaving out `clear` holds the chat in Working, as before.

## 2026-11-14 — A restart no longer leaves a delegated chat uncontinued

- A chat started by another chat (a delegated task) that a server restart cut while its parent was also running could stay idle forever, because the parent's recovery marked the child's provider thread idle first. Recovery now leaves a delegated chat's provider thread to that chat's own recovery, and a test covers the decision that resumes it.

## 2026-11-14 — A chat whose provider is slow to resume is retried instead of left queued

- When a provider did not resume a chat in time, for example on a server starved of CPU, the run failed for good and the next message stayed queued for hours. The wait for a resume now also grows with the host load per CPU (up to 60 minutes), and a start that times out is retried automatically after 0, 1 and 5 minutes, each time with a longer wait, like a start cut by a lost connection. After the last retry the chat stays failed and Chat Doctor picks it up.

## 2026-11-14 — Chat folders

- You can now put chats in folders of your own, such as "Autopilot" or "Optimization". Create one with **New folder…** in the sidebar filter menu or the command palette, and move chats in with **Move to folder** in a chat's right-click menu, its header menu, the command palette, or the mobile chat menu. Folders sit at the top of the sidebar; right-click one to rename, delete or reorder it. Each machine keeps its folders, empty ones and their order included, so your desktop, browser and phone show the same list.
- A folder holds its settled chats too, also ones settled long ago: **Show N more** below a folder loads them, and **Settled** leaves out chats that are in a folder.
- A scheduled task's **Group** is now the folder of its chats: every chat a task starts lands in the folder named after its group, and changing the group moves the chats it already started. Agents can file chats with `t3_thread_organize`, and `t3_thread_list` shows each chat's folder.

## 2026-11-14 — The database stores event ids in a fraction of the space

- Every stored event carried an id of about 320 characters, because it spelled out the chat and provider session it belonged to, and each id is indexed. A new event now gets a short id, and an update rewrites the ids already stored, taking the event id column from 573 MB to 74 MB on a 14 GB database. Run, step and turn ids no longer re-escape the ids they contain, so those ids and the data that repeats them stay shorter too. The space returns to disk gradually as the database reuses it.

## 2026-11-14 — `t3 doctor` also removes old tool output and Settings sees fragmented space

- `t3 doctor` now removes command and tool output from idle chats with the same rule and **Remove old tool output** setting the server uses before it rebuilds the database, so a doctor run no longer keeps output the server would have removed.
- Removing that output leaves pages partly empty, and only `t3 doctor` returns them to disk. The database size shown in Settings → Maintenance & about → Storage & cleanup now estimates that space, measured after each cleanup pass (so it appears within hours of starting the server), and suggests `t3 doctor` when it reaches 1 GiB. `t3 doctor` reports it too.

## 2026-11-14 — Server updates that migrate the database no longer copy it

- An update that changes the database schema copied the whole database file for its rollback, which on a disk without copy-on-write (ext4) took minutes and could stall a busy disk. When the database is in WAL mode, as it always is here, the launcher now holds the database as it was and keeps the new version's changes in the write-ahead log, which a failed update deletes. The rollback needs free space only for what the migrations change. A failed update still restores the database before either version starts. The launcher picks this up after a local `t3 service update`.

## 2026-11-14 — A server update brings the background service its new launcher

- The launcher that runs the background service stayed on the release that installed it, so a launcher fix reached a machine only after someone ran `t3 service install` there. After an update commits, and whenever the service starts, the old launcher now checks that the newer release's launcher loads the service state and then hands the service to it. If that launcher fails the check or exits with an error, the old one keeps running the service. The one-time `t3 service install` is needed only once more, to put a service on a launcher that has this hand-off.

## 2026-11-14 — Large chats get more time to resume

- Resuming a chat gave the provider a fixed 5 minutes, however large the chat or busy the machine, and a retry waited the same 5 minutes, so a big chat on a loaded host failed every time. The wait now grows with the chat (one extra minute per MB of messages) and doubles after each earlier resume timeout, up to 60 minutes. Small chats on idle machines still wait 5 minutes.

## 2026-11-14 — A restart no longer strands a chat waiting on a finished helper

- When the server restarted while a chat had ended its turn to wait for a helper, the helper's result was held for a resume that never came, so the chat stayed queued and never ran again. A restart now holds a message that an agent, the server or a scheduled task queued only when it also resumes a cut run; otherwise it starts at once. Messages you queued are still held for you to resume.

## 2026-11-14 — The database stops growing with old tool output

- Every command and tool result stayed in the database forever, so it grew by about a gigabyte a day on a busy machine, and most of that was output nobody would open again. The server now removes command and tool output from a settled, archived or deleted chat once it and every fork of it have had 7 days without activity. Every step stays in the chat, and expanding one shows "Output is no longer available." A chat keeps its output while it or any fork of it is open, pinned or recently active, and MCP app results always keep theirs. Change or turn this off with **Remove old tool output** in Settings → Maintenance & about → Storage & cleanup; the space returns to disk gradually while the server runs.
- That page also shows how large each machine's database is and how much of it can be reclaimed, and the server logs the size after each cleanup pass.
- A server update that applies no database migration no longer copies the whole database for its rollback, so it needs no free space for a copy and no time to make one. An update that migrates still makes the copy. The launcher picks this up after a local `t3 service update`.

## 2026-11-14 — A scheduled chat no longer waits for hours on an approval nobody sees

- In a scheduled task with Full access, Claude still asks before touching files it protects even under bypass, such as its own settings. Nobody was watching to approve, so the chat waited for hours and the task skipped every time after it. Such a step, in the chat or in a delegated task with Full access it started, is now declined, with a reply from T3.CodeShip telling the agent to finish the rest and say what still needs you. A step in work you started yourself, such as a message you sent into one of those chats, still waits for you.
- A run's chat in which nothing has happened for 2 hours on Claude, or 5 hours on other providers, now counts as stalled, also when it waits on delegated tasks that have all gone that quiet, and no longer counts toward the task's live-run limit. The next scheduled time stops it and its delegated tasks with the reason, and **Run history** marks that chat's run as failed with the same reason. The limits sit above the longest quiet stretch real turns of each provider had while still working. A chat waiting on a task that runs on another machine is never treated as stalled.
- For a shared task set to **One machine**, a stalled chat no longer holds the other machines back: they no longer count it, and the machine it runs on stops it at the next time, even while it waits its turn.

## 2026-11-14 — `check:changed` checks against the dependencies the branch locks

- For contributors: after a rebase or pull onto a commit that added a dependency, `vp run check:changed` ran every step against the older install and failed late, on a module it could not find. It now installs `pnpm-lock.yaml` with `--frozen-lockfile` before any check, as CI does. When nothing changed this takes about a second, and a `package.json` the lockfile does not match fails at once.

## 2026-11-14 — A provider turned off for a project no longer keeps working on its own background work

- A notice from the agent's own background work, such as Claude's background task finishing, is a turn the agent has already started by itself. When its provider was turned off for the project, that notice was refused or waited with your queued messages, and the agent went on acting on it with no turn in the chat, so every T3.CodeShip tool refused it. T3.CodeShip now cancels the notice and closes that provider's session, so no turn runs on a provider the project turned off. A notice from a provider that is still on runs even when a message queued ahead of it waits on a provider turned off. Your own queued messages still wait for you to press **Resume**.

## 2026-11-14 — Scheduled tasks remember who last changed them

- A scheduled task said when and on which machine it last changed, but not who changed it, so a task switched off by surprise left no trace of whether a person or an agent did it. Each change now records whether it came from the app or from an agent, and for an agent the chat or scheduled run that made it, or the name of the outside client. `list_scheduled_tasks` returns this as `changedBy`, and a shared task's copies carry it to your other machines. Tasks last changed before this update show no author.

## 2026-11-14 — Windows and Linux updates no longer wait for the Mac build

- Each release waited until GitHub gave it a macOS machine to build the Mac app, which took up to 9 hours, so Windows and Linux updates waited too. Windows and Linux releases now publish as soon as they are built, and the Mac app is attached to the same release when its build finishes. Until then, Macs keep the version they have and their update check keeps working.

## 2026-11-14 — Auto reviews with both providers' configured primary models

- Auto's coordinator reviews implementation itself and requests an independent review from the other provider, using each provider's Auto model and effort from Settings. It reports an unavailable independent review as incomplete. Implementation can use whichever Claude or Codex model best suits the task.

## 2026-11-13 — Finished delegated chats on another machine settle by themselves

- When an agent handed a task to a linked machine with `delegate_task`, the chat it started there stayed in that machine's active list after the result came back, until it auto-settled days later. Once the result reaches the chat that delegated it, that chat now settles if it completed with no question or queued message waiting. A failed, stopped or waiting one stays active, and a new message there makes it active again.
- Chats an agent opens with `t3_thread_launch` stay as they are: those are chats someone asked for, so they settle when their own agent, you or auto-settlement settles them.

## 2026-11-13 — Scheduled tasks have a live-run limit

- A task that starts a new chat for each run could still pile up runs: a chat reads as finished between turns while the tasks it delegated to other agents still work, so the next scheduled time started another one. A task now has a **Live runs** limit, 1 unless you raise it in its editor (up to 10), and a scheduled time is skipped while that many of its runs are working. A run counts as working while its chat runs or waits, or while a task its chat delegated still runs. **Run history** says so ("Its live-run limit was reached: earlier runs were still working.").
- A shared task set to **One machine** counts its working runs on all of its machines, and **Run history** names the machine whose runs filled the limit.
- Agents set the limit with `schedule_task` (`maxLiveRuns`), and `list_scheduled_tasks` shows each task's limit and how many of its runs are working.
- Existing tasks keep the limit of 1. **Once** tasks, **Run now**, webhook runs and tasks that post into one thread are unchanged.

## 2026-11-13 — Browser tabs agents use keep drawing in chats nobody has open

- On Windows and Linux, a browser tab an agent drove in a chat you were not looking at, such as one a scheduled task started, drew no frames. Pages that wait for the next frame never got one: ChatGPT's message box never appeared, and the agent's clicks and typing waited until they timed out. The desktop app now keeps such a tab drawing while the agent uses it and through the rest of its turn, also while the window is minimized or hidden, and lets it rest again once the agent is done.

## 2026-11-13 — Agents can send a held queued message first

- **Send now** on a queued message in a stopped chat starts the queue from that message. Agents could only start a held queue in order. `t3_queue` `resume` now takes an optional `queuedRunId` and starts the queue from that message, the way **Send now** does.

## 2026-11-13 — Agents can resume a held queue

- After a failed or stopped turn, T3.CodeShip holds the chat's queued messages until you press **Resume**. Agents had no way to do the same, so a helper such as Chat Doctor had to send the chat a new message to get it going. The `t3_queue` tool now has a `resume` action that releases the held queue the way **Resume** does, and its `list` says whether the queue is held.

## 2026-11-13 — A scheduled task no longer starts a second chat while its last one is still working

- A task that starts a new chat for each run, such as **Machine inbox**, started the next one on schedule even when the chat from its last run was still working, so two chats did the same work side by side. A scheduled time is now skipped while that chat is still working, including one a restart cut that has not continued yet. **Run history** says so ("The chat its last run started was still working."), and the next time after that chat finishes runs as usual.
- A shared task set to **One machine** also skips the time while its last chat works on another of its machines, and **Run history** names that machine. A queued message someone cancelled in that chat no longer makes another machine run the time again.
- **Once** tasks, **Run now**, webhook runs and tasks that post into one thread are unchanged.

## 2026-11-13 — /ship settles a chat whose work is already on main

- When the work a chat was asked to ship was already on main, `/ship` left the chat unsettled, because the skill settled only after its own push. It now treats "nothing to land" as landed: it cleans up the branch and worktree and settles the chat.

## 2026-11-13 — The Mac app is built on macOS 26

- Releases now build the Mac app on GitHub's macOS 26 machines, the macOS version upstream T3 Code builds its releases on. GitHub's macOS 15 machines gave this repository none for hours, so no update had been published since this morning.

## 2026-11-13 — Manual steps are reviewed by a machine that is connected

- While one of your machines was reconnecting, it could stay the one that reviews **Manual steps**, so every step showed "Could not reach the machine that reads ThreadPage." even though your other machines read ThreadPage fine. Reviews and the chats that carry out your decisions now go to a machine that is connected, and a review that loses its machine says "Could not reach the machine that reviews steps."

## 2026-11-13 — A chat whose turn failed no longer goes on working without its tools

- When a turn failed on a provider error, such as a Claude API error behind a Cloudflare block page, a notice from the agent's own background work queued behind it was held with your messages. Claude went on acting on such notices anyway, with no turn in the chat, so every T3.CodeShip tool refused it ("The calling provider no longer owns an active thread run") and it was offered no later notices. The notice now starts as the next turn; your own queued messages still wait for you.

## 2026-11-13 — An account can use its banked reset credits automatically

- Codex and Claude accounts that bank reset credits have a new switch in **Settings → Providers & models**: **Use reset credits automatically**. When a thread stops on that account's usage limit, or Claude holds its turn until the reset, and no other account or model continues it, the server redeems one credit and continues the thread on the same account. Every thread waiting on the account continues on that one credit. A limit that resets within 30 minutes is waited out, nothing is spent while the account's own limits still show room (such as ChatGPT's app limit) or while the account is off for the thread's project, and threads you stopped, snoozed or whose auto-resume you cancelled are left alone. The setting follows the account to your other machines.
- **Use reset** now frees the account at once for new threads and account switching. Before, a thread stopped by the limit kept the account marked as limited until its old reset time, so new chats were still steered away from it.
- When a reset is redeemed but the new limits cannot be read back yet, **Use reset** now reports the reset with a note to refresh. Before, it reported a failure for a credit that had been spent.
- A limited thread hidden by **Hide limited threads until the limit resets** now also moves to another account that gets usage back, and shows again when it continues, including when limited threads do not resume at the reset. Before, hiding it kept it on the limited account until the reset.
- Hiding a limited thread no longer replaces a snooze you set on it yourself. Before, the hide moved your snooze to the limit's reset, and continuing the thread early woke it.
- **Stop** now keeps a thread stopped while it waits to resume after a lost connection or to set up its worktree again. Before, the automatic retry still continued it. The same goes for an automatic continuation the server was about to send at the moment you pressed **Stop**, including one after a usage limit.
- Snoozing a thread right as T3.CodeShip restarts now keeps it snoozed. Before, the turn the restart cut could still continue, or start again, a moment after you snoozed it.

## 2026-11-13 — Updates arrive soon after GitHub has Mac build machines again

- When GitHub ran short of Mac build machines, a new version was retried twice and then waited for a scheduled retry that GitHub can delay by hours, so installed apps went hours without an update after machines were free again. A release whose only failure is a build that never got a machine is now retried as soon as GitHub gives up on it, for up to 6 hours.

## 2026-11-13 — Agents can turn on automatic updates, and a busy machine now installs them

- `t3_environment_read` reports **Install updates automatically when idle** (`installUpdatesAutomatically`), and `t3_environment_preferences_update` sets it, on every machine with `allMachines`, under the same policy checks as the Settings toggle.
- A machine that always has a chat running, such as one with scheduled runs, never became idle, so it never installed a release. After 2 hours of waiting, an automatic update now installs as soon as no background work is listed; running chats resume after the restart.

## 2026-11-13 — A chat that was starting when the computer slept starts again by itself

- A chat or scheduled run that was starting when the computer went to sleep could fail seconds after it woke, for example with "Claude timed out while registering its MCP tools", and nothing ran it again. Startup deadlines now count only the time the computer is awake: Claude's MCP setup and wake start, the 5 minute limits on opening a session and loading or resuming a conversation, ACP agents such as Grok loading a session, OpenCode's server start, and Pi and Muse Code requests.
- When a start still fails before the agent got the message, because the computer slept or the connection dropped, the same message now runs again by itself once the network answers, on the delays a chat stopped by a lost connection resumes on. The agent sees it once, not as a "continue" note.

## 2026-11-13 — Development and CI use the same Node version

- Commands run inside the server package now use the repository's pinned Node version, keeping local database tests on the same SQLite version as CI. The supported Node versions for installed `t3` users are unchanged.
- Development checks catch packages that select a different Node version. CI also runs persistence and migration tests on the newest supported Node to catch SQLite changes before release.

## 2026-11-13 — Accounts that must sign in to an MCP server again are passed over, and run history says why a run moved

- Scheduled tasks and Auto chats no longer start on an account that must sign in to an MCP server (such as ThreadPage) again while another account with room is signed in. Before, a task naming that account ran for hours without the server's tools and did nothing, once the other account's usage limit ended. Delegates and agent launches prefer accounts whose sign-ins are in place too, even when the parent chat runs on the account that needs one. When every account needs a sign-in, the chat stays where it is. This follows **Switch accounts at usage limits**.
- **Run history** now says why a run started on another account: the task's account was out of usage, was signed out, or needs to sign in to a named MCP server again, on web, desktop and mobile.
- See [Switching accounts at usage limits](user/thread-sidebar.md#inspect-agent-work).

## 2026-11-13 — A one-machine task no longer skips a time because another machine ran the one before late

- A shared task set to **One machine** could skip a time on every machine. When the first machine was off, another machine could take the previous time over late and still be running it when the next time came due. The next machine in the order took that run for the new time's, so it waited for it or skipped, and nobody ran the new time.
- Machines now say which time each run, no-work skip and run-condition check is for, so another machine counts only a run of the same or a later time. **Run now** and webhook runs count for no time. A machine on an older version still counts by when its run started.
- A run names its time from the moment it starts, even when its run history could not be saved.
- Upgrading a database from a much older version on Node 26.13.1 or later no longer turns saved model options into text.

## 2026-11-13 — `t3 up` waits for the restarted server, so `t3 pair` works right after it

- `t3 up --lan` restarted the background service and told you to run `t3 pair` before the server was listening, so `t3 pair` run at once failed with "No running T3.CodeShip server found". `t3 up` now waits until the restarted server serves, and so do `t3 service install`, `t3 service restart`, `t3 update --yes` and `t3 doctor --fix`. Before, only turning on T3 Connect waited.
- When the server has not started within 2 minutes, these commands say so, name the log to read, and exit with an error instead of reporting success.

## 2026-11-13 — A scheduled task waits for the network before it gives up on its prompt file

- A scheduled task whose prompt comes from a file in the repository failed when it ran right after the machine woke, because Git could not reach the remote yet. It now waits for the network and reads the file again, on the same delays a chat stopped by a lost connection resumes on. It fails only when the network is not back after 5 minutes, or the read still fails once it is, and **Run history** says which. A missing, empty, binary or too long file still fails at once. The task still runs once: **Run now** reports it as running while it waits, and a task paused or deleted meanwhile does not run.
- When Git cannot fetch for a prompt file or a pull request's review guide, the error now names the cause, the step that hung and what Git said.

## 2026-11-13 — Codex chats no longer stall for minutes after a restart

- After T3.CodeShip restarted, every Codex chat on a machine could stop for one to three minutes at a time: resumed chats waited to start and running chats showed nothing new. When Codex sent an update about a turn from before the restart, such as its token use, T3.CodeShip waited for that turn to begin before it read Codex's next message, and all Codex chats on a machine share that reader. An update about a turn T3.CodeShip is not running is now set aside at once.
- The server log now warns, naming the message, when handling one Codex message holds up the others for a second or longer.

## 2026-11-13 — A provider's status says why its CLI failed

- When Claude's account check fails, **Settings → Providers & models** now shows the first line the CLI printed, such as an invalid settings file. Before, it said only that the CLI failed while checking account status. Pending Consumer Terms still say how to accept them.
- When Claude, Grok, Pi, Muse Code or fx is installed but `--version` fails, the status now ends with the CLI's own reason too.
- Codex and OpenCode statuses already showed the CLI's error, but in full. They now show the same single line, and an OpenCode server that exits while starting no longer puts all of its output in the status.
- The reason is one line of at most 240 characters, with home folder paths, emails, tokens, keys and sign-in links removed. The server log keeps the same redaction.

## 2026-11-13 — A linked machine on an older version refuses options it does not have

- An agent's call to a linked machine on an older version ran without the options that version does not have yet, such as a new thread setting, and reported success. The call now fails and names those options and the machine's version, so you know to update it. Calls that pass only options it has work as before.

## 2026-11-13 — Codex no longer shows as not installed after T3.CodeShip updates it

- When T3.CodeShip updated Codex or another provider CLI, a status check that ran while the installer had the CLI moved aside could leave the provider marked **not installed**. Agents and scheduled tasks then could not use it: `orchestrator_capabilities` reported it unusable and delegated tasks to it failed. The check after the update reused that result for 30 seconds. An update now drops it, so its own check finds the new CLI.
- A provider marked not installed, failing or signed out is now checked again when no window is open. The first check comes after the usual provider status interval, and later checks come less often, at most an hour apart, until it works. Before, a server with no window open never checked it again. OpenCode marked not installed is now checked again too, so an OpenCode CLI you install later is found without a manual refresh. A rejected OpenCode server password is still not retried in the background.
- Agents get a fresh answer. `orchestrator_capabilities` checks such a provider again before it reports the provider unusable. `delegate_task` with only `driverKind` checks that driver's accounts again before it refuses. Agents that ask at the same time share one check.

## 2026-11-13 — `check:changed` runs in several worktrees share the machine instead of overloading it

- `vp run check:changed` sized its parallel steps for the whole machine on every run, so several agents checking their worktrees at once ran many times that many typechecks and test workers. The machine ran out of memory and CPU, and tests that pass alone timed out or failed. Runs in every worktree of a repository now draw from one budget: a step starts once a slot is free, and a run that finds every slot taken says so and waits. The test step counts its workers against the budget too, and each package's typecheck is its own step.
- A step's time limit now counts from when it gets its slot, so time spent waiting for another run never ends it as `TIMEOUT`.
- The peer link request tests no longer race a three-second link check against the clock, which made "a link back the box does not make still links it" fail on a busy machine.

## 2026-11-13 — A Claude agent's background wait no longer fails while Claude is busy

- `t3_background_wait` in a Claude chat could fail with "Failed to update the awaited background work" when it marked running work while the chat was handling a burst of Claude messages or a slow one, such as reading a workflow member's transcript. The mark now takes effect at once, and the chat's list of running background work shows it as soon as those messages are handled.

## 2026-11-13 — Screen readers hear every status a pinned task row shows

- A pinned scheduled task in the sidebar, on web, desktop and mobile, now tells a screen reader when it runs next or last ran, alongside its run status and a skipped run with its reason. Before, the row showed "in 2h" or "5m ago" but its spoken label left the time out. The spoken label names the date and time, such as "Next run Nov 13, 3:00 PM", so it stays right while the row stays on screen.
- On mobile the spoken label also names the task's schedule, which the row shows under its title.

## 2026-11-13 — An account that works again stops being marked limited, and its stopped chats continue

- A Claude or Codex account stayed marked as usage-limited, and new threads, delegates and Auto avoided it, while runs on it were working again. Only a run that had finished cleared the hold, so a long run that started fine after the limit kept it until it ended or the five-hour hold ran out. A run on that account that started after the refusal now clears the hold as soon as it gets an answer. A refusal that is still true keeps holding the account.
- A chat stopped by the limit and set to **Resume at reset** now continues where it stopped, within a minute, once its account takes that model again before the reset: a later run there gets an answer, or you press **Try again**. No other account is needed. Before, it waited for the reset, or moved only when another model or account had room. A chat that already moved on since the stop is not resumed again.
- Agents that resume stopped chats with `t3_thread_send` can pass `continuationOfRunId`. The send then fails when the chat was already resumed from that run, so a chat is never continued twice.

## 2026-11-13 — A chat sent again after a restart starts, or fails with the reason

- After a restart, a chat whose message was sent again could stay in **Starting** for good, most often a delegated task. Every chat the restart cut starts at the same time, and a few agents that were slow to start held every worker, so the rest never reached their agent. The server now runs more starts at once and keeps workers free for other work while agents start.
- An agent that does not open its session, or load or resume its conversation, within 5 minutes now fails that message with the reason, as does a message whose last start attempt fails. Before, the chat stayed in **Starting**, and a parent waiting on that delegated task waited too.
- A delegated chat that the restart cut in the middle of its work now continues after the restart. Before, it stayed stopped whenever its parent chat recovered first, and its stopped background work was reported on the parent instead.
- A resumed agent is now told the delegated tasks its cut turn started, with their task and chat ids, so it checks on them instead of delegating the same work again.

## 2026-11-13 — An update you start waits for a chat's running tool calls and subagents

- **Update when it finishes** and the other updates you start from the update button, **Update everything** or a server's update now also wait while a chat is running tool calls or subagents, until that chat has none running. Before, a Safe update with no background work installed at once and cut those calls halfway, and the calls queued behind them never ran. A chat that keeps working holds the update only until its first moment between calls, and a chat that is only answering, waiting for your answer, or waiting for another chat does not hold it.
- The Safe update and the waiting update list these calls under **Waits for running tool calls**, apart from background work.
- When a restart still cuts a chat's tool calls, through **Update now** or a crash, the resumed chat is told which calls stopped or never started, so it checks them before running them again.

## 2026-11-13 — Scheduled tasks skip a run while every account they need is out of usage

- A scheduled run no longer starts when every account it could use is already out of usage, where before it started a chat that stopped at once or spent its tokens and then failed on the limit. **Run history** lists the time as skipped and says until when the accounts are limited, and the skip doesn't count as a run. A **Once** task moves to that time instead.
- A task that hands work to other providers, such as a Claude task that delegates to Codex, can name them under **Hands work to** in its editor, on web, desktop and mobile. Its runs are also skipped while every account of one of them is out of usage. Agents set it with `schedule_task` (`delegateProviders`).
- T3.CodeShip reads a limited account's usage again at most once an hour, so a limit that ends early frees the next run. A shared task set to **One machine** leaves such a time to the next machine in its order. **Run now** and webhook runs always start.
- See [Skip runs while accounts are out of usage](user/project-settings.md#skip-runs-while-accounts-are-out-of-usage).

## 2026-11-13 — A shared task that runs on one machine no longer runs on several at once

- A shared task set to **One machine** could run on every machine for the same time. When a project had no saved machine order, each machine counted itself first, so they all started together. A machine that could not reach the machines ahead of it also ran the task anyway, and so did one whose link only timed out while the machine ahead was still running it.
- A machine missing from the order now saves it with itself and its linked machines added, sorted by their ids, so every machine counts the same machines once the order has reached them all, within minutes. Each time is claimed on every machine a machine can reach, and a machine runs the task only when more than half of the machines recorded its claim (of two machines, the first alone is enough). When too few answer, the time runs nowhere instead of twice, and **Run history** says too few machines answered. A fixed time is claimed by its local hour, so machines in different time zones, which reach it at different moments, claim the same time, and every machine, the first included, also asks the others whether they already ran it.
- A machine takes over a time from another only when that machine's own claim agrees: once that machine gave the time up, or its run of it failed after its chat started. A machine that is slow to start the run, or stops answering while it runs it, keeps it, and a claim stays in place after a later time is claimed. Links between these machines need more than read-only access, since a claim is written there.
- The task editor now shows the machine order the machines actually use when the project has none saved.
- See [Shared scheduled tasks](user/project-settings.md#shared-scheduled-tasks).

## 2026-11-12 — An agent is told when its background subagents end with its process

- A Claude chat that waits on a background subagent is now told when the agent process running it ends: on its own, with **Stop**, **Stop and send**, **Edit from here** or **Retry**, or when its session is closed. Before, these closes recorded only the chat's background commands and monitors, so the chat could keep waiting for a subagent that would never report back, until the next server restart.
- The same rules apply as for a command it waits on: a process that ends on its own, or a session that fails or closes after a long time without activity, wakes the chat; in every other case the agent learns what stopped with your next message.
- The thread's notice about the stopped work lists the subagent too.
- A background subagent no longer shows as running after its agent's session was closed. Before, it stayed running until the next server restart.

## 2026-11-12 — Claude agents call `t3_background_wait` with the argument it takes

- Claude's instructions and the tool's description now tell agents to pass `taskIds: ["<task id>"]` to `t3_background_wait`. Before, they said to pass "its task ID", so agents sent `taskId` and every call was refused, leaving the thread out of Working while its tests or build ran.
- Three other agent texts named arguments their tools do not take, and now name the real ones: `device_open` takes `hostId` and `deviceId`, a prepared upload is sent to `t3_thread_send_attachments` as `attachments: [{ type, id, name, mimeType, sizeBytes }]`, and `preview_snapshot` no longer suggests it targets one element (`preview_act` takes `locator`).
- A test now fails when any agent instruction or tool description names an argument key its tool's schema lacks.

## 2026-11-12 — Scheduled runs retry a worktree fetch that timed out after a wake

- When a scheduled run started right after the machine woke from sleep, fetching the project's remote to prepare its worktree could get no answer within 30 seconds, and the run failed for good. A fetch that times out now counts as a lost connection, so the run waits for the network and tries again, as it already did when Git could not reach the remote.
- A failed fetch now says where the time went: how long each Git credential helper took or that it was still running, how long the transfer took, and Git's own last error lines with any credentials removed from URLs.

## 2026-11-12 — A failed background-work mark says why, and unknown ids no longer wait

- When `t3_background_wait` cannot update the awaited background work, the error now names the cause (for example a timeout) instead of only "Failed to update the awaited background work."
- Task ids that match no running background work come back as unmatched at once. Before, they queued behind whatever the agent's message stream was doing and could fail after 15 seconds.

## 2026-11-12 — Switch a Codex account's sign-in when ChatGPT's app limit stops it

- **Settings → Providers & models** now has a **Sign-in** choice for each Codex account: **ChatGPT sign-in** or **Codex's own login**, which ChatGPT's app limit does not stop. It works on any linked machine, from web, desktop and mobile. The first Codex account on a machine can turn on **Private login** to sign in apart from the Codex CLI's login there. Changing an account's sign-in releases its hold.
- **Usage → Limits** lists each held account under its provider with when the hold ends, **Try again**, and, for ChatGPT's app limit, **Switch sign-in**. The thread banner on web and the thread card on mobile show **Switch sign-in** too.
- **Manual steps** shows a Codex account the app limit stopped, with **Switch sign-in**, until a turn runs on it again.
- Agents can try a held account again with the new `t3_provider_retry_usage_limit` tool, on this machine or a linked one.
- See [ChatGPT's app limit](user/providers-codex.md#chatgpts-app-limit).

## 2026-11-12 — Agents can set a provider account's shared settings

- `t3_environment_preferences_update` takes `providerAccounts`, so an agent with full access can set the settings a provider account shares, such as a Claude account's **Auto-compact after**, without a manual step. It accepts only those fields (for Claude: **Auto-compact after**, **Compact idle threads** and custom models; for Codex, Cursor and Antigravity: custom models), checks each value the way the account's settings form does, and refuses a path, binary, home, launch argument or credential, an unknown account or an invalid value with a message that says why. A field's default value, such as an empty **Auto-compact after**, restores the default. Account settings and other preferences in one call are saved together or not at all.
- An added account's change reaches the machines that follow shared settings, as a change in the settings form does. A built-in account's settings stay on each machine, so `allMachines` refuses them and the agent sets each machine with `environmentId`.
- `t3_environment_read` lists each account with those settings and whether a change to it reaches the other machines.

## 2026-11-12 — Scheduled tasks can be grouped, paused by group and counted per group

- A scheduled task can have a **Group**, such as "Machine care" or "PolyBot delivery", set in its editor on web, desktop and mobile, or by an agent with `schedule_task` (`list_scheduled_tasks` returns it). A shared task's group reaches every machine.
- Once a task has a group, the **Scheduled tasks** page and the mobile **Tasks** tab list tasks under collapsible group headers, with tasks without one under **No group** last. Each header shows the task count, the next run, and the last 24 hours' runs, failures and usage-limited runs. Collapsed groups are remembered per device.
- **Pause group** turns off the group's running tasks, and **Resume group** turns back on only those, so tasks you had paused yourself stay paused. A group with shared tasks asks first, since they change on every machine.
- **Usage** has a **Scheduled task groups** section with each group's runs, failures, usage-limited runs and estimated cost for the selected period.
- Run history now keeps every run from the last 90 days, not only each task's last 50, so a frequent task's runs count in full over a long Usage period. Skipped runs are still trimmed as before.

## 2026-11-12 — An agent in a No-project chat can delegate to another machine

- `delegate_task` to a linked machine now starts the task in that machine's own **No project** when the chat it comes from is in No project. Before, it was refused with `target_required`, because a chat with no repository had nothing to match a project there.
- A target that names only `driverKind` now runs on the other machine's own account of that driver. Before, the task was sent with the calling chat's account id, which does not exist on the other machine. When the other machine has no account of that driver, the refusal lists the accounts it does have.

## 2026-11-12 — Prompt files: tests for binary and over-long files

- Maintenance only, with no change in behavior. Tests now check that a scheduled task whose prompt file is binary, or longer than a prompt can be, fails its run and names the file and the branch.

## 2026-11-12 — A turn whose checkpoint can't be saved no longer blocks the chat

- When a turn finished but T3.CodeShip could not save its checkpoint after every retry, the chat kept showing the agent as working and held every queued message until the server restarted, and the restart then marked the finished turn as cut. The turn now completes without a checkpoint and the next queued message starts. Going back to that turn is not offered, since it has no checkpoint.

## 2026-11-12 — Weekly and weekday scheduled tasks catch up a run missed while the machine was off

- A fixed-time task that runs on chosen weekdays, such as every Monday or Monday to Friday, now catches up a run it missed while the machine was off or asleep, as daily tasks already did: it runs once when the machine is back, unless its next run comes sooner. Before, such a task skipped the missed run, so a weekly task waited a whole week. Tasks where you turned **Catch up a missed run** off keep that choice.
- Agents can read **Catch up a missed run** with `list_scheduled_tasks` and set it with `schedule_task`.

## 2026-11-12 — Agents' thread and task lists use far fewer tokens

- `list_scheduled_tasks` now returns a short prompt preview and a hash for each task. Pass `includePrompt`, or a `scheduledTaskId` to read one task, for the full prompt. `schedule_task` no longer repeats the prompt you just sent.
- `t3_thread_list` returns a compact row per thread (id, title, link, status, model, last update, parent). Pass `fields: "full"` for every field.
- `t3_thread_read` returns `recentRuns` only on a thread's first page, or when `runLimit` is passed.

## 2026-11-12 — A scheduled task can read its prompt from a file in its project

- Under **Prompt** in a task's editor, **Read from a file** takes a path from the root of the project's git repository, such as `automations/daily.md`. Each run fetches the default branch of the project's remote and reads the file there, so a change pushed to that branch reaches the next run on every machine without editing the task. Saving reads the file once and shows the text it found and the commit it came from.
- A run that cannot read the file fails, and **Run history** names the file and the branch. It never runs text an earlier read found. Webhook tasks keep a typed prompt.
- Agents set it with `schedule_task` (`promptFile`, or `null` to type the prompt again), and `list_scheduled_tasks` returns it with the last read. `schedule_task` also takes `machineOrder`, so an agent can set the order in which a project's machines try its one-machine tasks.
- See [Prompt from a file](user/project-settings.md#prompt-from-a-file).

## 2026-11-12 — Screen readers hear when a pinned task's run was skipped

- A scheduled task pinned to the sidebar or the mobile thread list now tells a screen reader when its check found no work and skipped the last run, with the check's reason. Before, only the row's visible line and hover card said so.

## 2026-11-12 — Checks before landing run the tests that exercise a change

- Before T3.CodeShip work lands on main, its checks now also run the tests that reach a changed file through test helpers, such as an agent's recorded replay tests when that agent's adapter changes. Before, only the tests next to a changed file ran, so a replay test that no longer matched the adapter reached main unseen and failed on every later run.
- A check run whose changed files are edited while it runs now fails and asks to run again, instead of passing on code it never saw in its final state. Files the checks generate themselves only keep that run out of the cache.

## 2026-11-12 — A scheduled task's check can read and write ThreadPage

- A **Check before running** command can now use the machine's ThreadPage connection without seeing its token. While the check runs it gets `T3CODE_THREADPAGE_URL`, an address on the machine's own T3.CodeShip server, and `T3CODE_THREADPAGE_TOKEN`, a token that stops working when the check ends. With them it can list a folder's active threads with their status, description and last activity (`GET …/threads?folder_id=`) and add a note to a thread (`POST …/notes`). A check can now decide from ThreadPage whether there is work, and write a note on every run.
- The calls use the token saved in **Settings → Threads → ThreadPage** on the machine that runs the check, so save one on each machine whose checks use ThreadPage, with **Can add notes** access when a check adds notes. Refusals say why: no token on this machine, or ThreadPage's own status and error code, such as `write_not_allowed`, and how long to wait when it limits requests.
- See [Read and write ThreadPage from a check](user/project-settings.md#read-and-write-threadpage-from-a-check).
- A server started on one specific address (`t3 serve --host <address>`) is now reached on that address by Tailscale Serve and the managed tunnel. They used to point at 127.0.0.1, where nothing listened.

## 2026-11-12 — One rule decides which turn records stopped background work

- For contributors: a session that closes and a restarted turn now use the same rule to pick the turn that records the background work they stopped. Nothing changes in the app.

## 2026-11-12 — The updating guide says when a restarted turn hears about stopped work

- The [updating guide](user/updating.md) no longer says that **Stop and send** in a chat's first turn tells the agent about stopped background work only with your next message. The restarted turn is told in every chat.

## 2026-11-12 — A chat is told about stopped background work even when a turn starts at that moment

- An agent could miss the note about background work that stopped with its session when a new turn started while that session was still closing, or when the server had to retry saving what stopped. The note counted as told once any later turn finished, although no message had carried it. The server now records which message told the agent about each piece of stopped work, and keeps the note until a turn that carried it has finished.
- When you send a message while the agent's session is still closing, that message tells the agent about the work the session stopped. The server now records stopped work before it closes the session, which can take up to 30 seconds. If saving that record fails, the first message after it is saved tells the agent. Work recorded while a message is already being sent is told with the next one. It is not repeated once a turn that carried it has finished.
- A chat woken for stopped background work is now also told about work that was recorded after its wake was queued.
- A turn in which a running session only replays the output of a background task that reported sends the agent no message, so it no longer counts as telling it.
- When more than ten pieces of work stopped, each note names ten and later messages name the rest. Before, the rest were only counted.
- Stopped work recorded on a turn while it ran is no longer dropped when that turn finishes. A turn that starts again, after a steer or a restart, is told about the work recorded on it, so **Stop and send** in a chat's first turn now tells the agent in the restarted turn instead of with your next message.
- For contributors: `vp run check:changed` now runs an agent adapter's recorded replay tests when the adapter changes.

## 2026-11-12 — Several chats of one Claude account no longer sign it out of ThreadPage

- An MCP server whose sign-in renews every hour and replaces its refresh token each time, such as ThreadPage, could sign a Claude account out while several of the account's chats ran. Claude renews in the last five minutes, and when one chat's renewal was slow, another stopped waiting for it and renewed on its own with a token that had just been used, so the server ended the sign-in. T3.CodeShip now has Claude renew each account's MCP sign-ins four minutes before they end, while the old one still works, by running `claude mcp get` for the server, so the chats no longer renew one at the same moment. When a sign-in has already ended, for example after the computer slept, the chats that start then wait a few seconds for one renewal instead of each renewing it.
- An added Claude account's folder no longer links Claude's lock files from `~/.claude`. A linked lock was left pointing at nothing once the main account released it, and the account then renewed its sign-ins without Claude's lock. Links left by earlier versions are removed.

## 2026-11-12 — A scheduled task can check for work before it starts a chat

- A scheduled task can carry a **Check before running** command. T3.CodeShip runs it before each scheduled run, in the project's folder on the machine that would run the task. Exit code 0 starts the chat as before. Exit code 10 starts nothing: no chat and no thread, and **Run history** lists the time as skipped with the reason the command printed (its last line, or the `reason` field when that line is JSON). Any other exit code, no answer within the time limit (60 seconds unless you change it), or a command that cannot start still starts the chat and records that the check failed, so a broken check never hides work.
- The command is one program with its arguments and no shell, so the same text works on Windows, macOS and Linux, and a word that starts with `~/` is under the home folder: `node ~/scripts/has-work.mjs`. The task's row shows the last skipped time and its reason without opening a chat. **Run now** ignores the check, and webhook tasks have none.
- For a shared task that runs on **One machine**, a time one machine skipped for no work counts as done, so the next machine in the order does not run it, and its run history says that machine found no work. Moving or duplicating a task to a machine on an older version asks you to remove the check first instead of dropping it.
- Agents set and clear it with `schedule_task` (`runCondition: { command, timeoutSeconds }`, `null` to clear) from a chat with Full access that is not in Plan mode (a narrower agent can no longer change or delete a task that has one), and `list_scheduled_tasks` returns it with `lastSkipped` and, while it runs, `checkingSince`. The same list now returns a one-machine task's `machineOrder`, and for a shared task `definedOn` and `definedAt`: the machine whose save is its current definition, and when.
- See [Check before running](user/project-settings.md#check-before-running).

## 2026-11-12 — A restarted turn is told what background work its agent process lost

- **Stop and send** on a running Claude turn, and a turn moved to another account because of a usage limit, close the agent process with the chat's background commands and monitors. The restarted turn is now told which of them stopped. Before, that was recorded nowhere, and the agent could wait for a command that no longer existed. In a chat's first turn the agent is told with your next message instead.
- The thread shows it as a **Turn restarted** notice that lists the stopped work.

## 2026-11-12 — Going back in a chat never leaves a later turn behind

- **Edit from here** and **Retry** now go back past every later turn whose agent has finished, including a turn that has just ended and whose file snapshot is not saved yet. Before, such a turn could stay in the chat after the conversation and files went back past it, and going back to just before it said "The thread has changed. Select a message to rewind again."
- Going back while a later turn is still running is refused with "A later turn is still running. Stop the agent, then try again." The buttons are already off while the agent works, but a window that had not caught up yet could still send the request, and with some providers the conversation went back while the turn's work stayed in the chat.

## 2026-11-12 — Each stop of a chat's background work keeps its own notice

- When a chat's background work was stopped more than once before its next turn (for example its agent process ended, then its session was closed), the thread showed only the latest notice, and a scheduled task's run took that later time as when it stopped. Such a run could then resume although a newer run of its task had already replaced it. Each stop now keeps its own notice, listing the work it stopped, and a scheduled run is judged by when its work first stopped.

## 2026-11-12 — Shipping removes the chat's worktree for good

- When an agent lands finished work, it now removes the chat's worktree while it waits. Before, it removed the worktree in the background, and the notice that the removal had finished woke the chat, which rebuilt the worktree and its branch from main.

## 2026-11-12 — Auto-resume continues a thread as soon as its next model has room

- A thread stopped by a limit that holds only one model, such as Claude's weekly Fable window, now continues by itself as soon as its next turn can run a model the limit does not hold: an Auto thread whose Auto model is another one, or a thread you switched to another model. Before, **Resume at reset** waited for the stopped model's own reset, days away for a weekly window, although the thread could run on another model right away.
- When that model is limited too, the thread continues when that model's limit ends, if that comes before the stopped model's reset.
- A thread you moved to another account after it stopped is no longer resumed at the reset, which the server already refused; you continue it yourself, as before.

## 2026-11-12 — Finished T3.CodeShip work lands by itself

- Agents working on T3.CodeShip now land finished work on main once its checks pass, so fixes reach the next release without you typing `/ship`. This covers chats you start, follow-ups agents start, and requests sent from ThreadPage.
- Work stays on its branch when you asked for a pull request, a review first or no push, when a check keeps failing, or when it waits on a money decision. The agent's report says which.

## 2026-11-12 — An agent is told when Stop, a rewind or a crashed turn ends its background work

- **Stop** on a Claude chat closes its agent process, which ends the chat's background commands and monitors. The agent is now told what stopped with your next message, also when you stopped a chat that was only waiting on that work. Before, it could go on waiting for a command that no longer existed. Nothing starts by itself after a Stop.
- When a Claude agent process ends in the middle of a turn, the turn fails as before, and your next message now also tells the agent which background work went with it.
- **Edit from here** and **Retry** close the agent process too. The agent is now told about the stopped work it started before the point you returned to. Before, the thread could also keep showing that work as running until its next turn ended.
- After **Edit from here** or **Retry**, the agent is no longer told about lost background work that the removed messages had started. Before, a restart or a closed session during those messages could leave a note that asked it to start that work again.
- The thread shows each case as a notice that lists the stopped work: **Chat stopped**, **Conversation rewound** or **Agent process ended**.

## 2026-11-11 — Pick how to handle a manual step and a chat carries it out

- On the **Manual steps** page, each suggested solution of a step now has **Choose**, and **Other…** takes a decision in your own words. Either one starts a chat under **No project** whose first message is the step and your decision, and opens it, so the agent carries the decision out and records the result in the step's ThreadPage thread. The chat runs on the step's own machine when the app is connected to it, otherwise on the machine that reviews steps. On mobile, the step's sheet has the same buttons and a **Your decision** field. Before, a step's review could only be read, and acting on it meant replying in ThreadPage or starting a chat by hand.

## 2026-11-11 — A chat is told when its background work stops with its agent's session

- A chat that waits on background work (a command it marked as waited on, a background task, a monitor or a subagent) is now told when its agent's session fails or is closed after a long time without activity. With **Settings → Threads → Recovery → Continue threads after restarts** on it also continues by itself, once: if the work it restarts goes quiet for hours again, the chat waits for your next message instead of repeating. Before, the server dropped that work without a word and the chat waited for a result that never came.
- When you or an agent close the session, the stopped work is recorded without starting a turn, and the agent is told with its next message. That covers a forced stop, a sign-out, archiving or settling the thread, and a change of account, access mode, workspace or provider. After a move to another account the agent is told there too, since it continues the same conversation; after a switch to a different provider it is told when the thread returns to the first one.
- The thread shows it as a notice, **Agent session closed** or **Agent session failed**, that lists the stopped work.
- A chat whose latest turn was a `/compact` is now woken for lost background work like any other chat. Before, that wake was dropped and the chat waited for your next message.
- An agent process that ends on its own now always leaves the thread without stale background work, also when it ended at the same moment as another update from it. Before, the thread could keep showing work that no longer existed until the next restart.

## 2026-11-11 — ChatGPT's app limit is named, and a stopped Codex account is tried again

- When ChatGPT stops a Codex account that connects through ChatGPT while the plan still has room (the account's windows show none used up), the thread now says "ChatGPT's app limit stopped this account" with the plan's remaining percent, instead of a plain usage limit. No ChatGPT setting lifts this limit; the message points to signing the account in with Codex's own login.
- Such an account is held for an hour and then tried again by the next turn, instead of until the plan's weekly reset. **Try again** in the thread's banner releases the account at once.
- `orchestrator_capabilities` marks `limitedUntilEstimated` when an account's `limitedUntil` is T3.CodeShip's guess and not a reset ChatGPT or the provider reported.

## 2026-11-11 — Updates install when idle on a Mac with every window closed

- **Install updates automatically when idle** worked only while a CodeShip window was open. On a Mac the app keeps running after its last window closes, so a closed window meant no update installed until someone opened one. With every window closed, the app now downloads a found update and installs it once no chat is answering and no background work would be cut, checked again right before the restart. With a window open nothing changes, and the update button still shows the wait.

## 2026-11-11 — Codex's own sign-in works without `codex` on PATH

- A Codex account that uses Codex's own ChatGPT sign-in ("Use existing CLI") with an empty **Binary path** showed **Not found** on a machine with no `codex` on `PATH`, although T3.CodeShip had its own copy of Codex. Such an account now runs the `codex` on `PATH` when there is one and T3.CodeShip's own copy otherwise, for its status, chats, sign-in and sign-out, MCP servers and plugins, and generated titles and commit messages.
- When the machine has neither, the account's settings offer **Install Codex**, which downloads T3.CodeShip's copy; nothing is downloaded until you choose it.
- A **Binary path** you set yourself is used as before, and still reports **Could not start Codex CLI** with that path when it cannot run.

## 2026-11-11 — An agent can hand a child a worktree of another local repository

- `delegate_task` with `isolation: "worktree"` and `target.projectId` of another project on the same machine now starts the child in a new worktree of that project's repository, from its default branch. Before, such a task was refused and coordinators fell back to making checkouts in the shell. Without `isolation: "worktree"` the refusal now names this option.

## 2026-11-11 — A restart wakes a chat that waits on a background command

- A chat that ended its turn to wait on a background command it marked as waited on (or on a background task, monitor or subagent) is now told and continues after a restart even when the agent's process stopped a moment before the server did, as an update on Windows or a service restart can do. Before, the server forgot that work in its last moments, so the chat got no note and sat idle until someone sent it a message.
- The same now happens when only the agent's process ends while the server keeps running: the chat is told its background work stopped and continues, instead of waiting for a result that never comes.
- The thread shows what happened: a notice (**Server restarted**, **Server shut down** or **Agent process ended**) lists the background work that was stopped and says when the chat was waiting on it, so you can read it later without the server log. The note the agent gets now says the work stopped because the server restarted or its process ended.
- A scheduled chat that waits on background work is no longer skipped as "a newer run replaced this one" when the task started its next run while the chat was still waiting. It is skipped only when the task moved on after the work was stopped.
- Known limits: a restart that happens while this fix is not yet installed cannot be repaired afterwards, and background work stopped because a new turn replaced the agent's process is still not reported.

## 2026-11-11 — A linked machine can be added to the app's machine list

- Linking a machine for agents never put it in the machine list at the bottom-left of the sidebar, and nothing said so. The `t3 environment link` and `t3 environment list` output and the agent link tools now say it is linked for agents only. In **Settings → Machines & access → Linked environments**, a linked machine missing from the list is marked, with **Add to this app**: one click over T3 Connect, otherwise a pairing code from that machine.

## 2026-11-11 — Agent shells can open the app and `t3code://` links again

- Agents and the shells they start no longer inherit the desktop app's Electron-as-Node switch (`ELECTRON_RUN_AS_NODE`). Before, opening the desktop app, a `t3code://pair` link, or another Electron app such as VS Code from a chat started it as plain Node, which exited without showing anything. The `t3` command line is unaffected.

## 2026-11-11 — Accounts and device settings follow your machines

- **Add an account once.** On machines that follow shared settings, adding, renaming, recoloring, turning off or removing a Claude, Codex, Antigravity or Cursor account reaches your other following machines, where it shows **Sign in** in **Manual steps**. Sign-ins, keys, folders and other local details never travel. An account removed elsewhere is deleted here only when it holds nothing of this machine's own; otherwise it is turned off and kept.
- **Device settings follow you (optional).** Turn on **Use the same appearance and layout on all my devices** in **Settings → Appearance** on each desktop or browser. Fonts, sizes, sidebar layout, confirmations, diff and chat preferences, language and notifications then match across them. A device turning it on for the first time takes the settings the others already share.

## 2026-11-11 — The Tailscale HTTPS row says why it cannot set up

- **Settings → Connections** now tells a missing Tailscale CLI (**Tailscale CLI not found. Install Tailscale…**), a logged-out client (**Log in to Tailscale…**) and a stopped one (**Start Tailscale…**) apart. Before, all three read **Start Tailscale**, even when starting it could not help.

## 2026-11-11 — Tools installed after T3.CodeShip started are found on Windows

- On Windows, T3.CodeShip now reads the system and user `Path` from the registry whenever it prepares its environment, so a tool installed or upgraded while the app was already running (with winget, or by an agent) is found without signing out. Before, an app started after an upgrade could keep a `Path` without the tool until you signed out.
- The Tailscale HTTPS row finds a running Tailscale even when its folder is missing from `Path`, by also trying `Program Files\Tailscale\tailscale.exe`. Before, it kept saying **Start Tailscale** while Tailscale was connected.

## 2026-11-11 — Settings that follow your machines, and sign-ins in one pass

- **Shared settings work across your machines.** Turn on **Follow shared settings** in **Settings → Machines & access** on each of your machines. Settings saved for all environments then go only to the machines that follow, including ones that were off at the time, and a machine that never opted in, such as a work machine, is never changed. Changes pass through machines that have their own newer edit, the edited machine's server stamps each change, and mobile saves the same way as web.
- **Sign in to all.** When a machine has several sign-ins waiting in **Manual steps**, **Sign in to all** walks through them in one window, accounts before their MCP servers, on web and mobile.
- **Updates install themselves when idle (optional).** **Install updates automatically when idle** in **Maintenance & about → Updates** installs a new release once no chat is answering and no background work runs, on the desktop app and on servers run as a service.
- **Link machines both ways.** Linking a machine with full access can also let it reach this machine in the same step, from **Linked environments** or from an agent's link card.
- **Scheduled tasks leave machines out reliably.** Agents can set which machines a shared task skips, and changing a task no longer clears its excluded machines.
- **Development servers keep your logins safe.** A dev server uses its own provider folders, so it never refreshes your real Claude, Codex, Grok or Pi login.

## 2026-11-11 — Runs move off a Claude account whose login failed

- When Claude rejects an account's login, for example after a refresh token was refused while the PC was off, that account now shows as signed out in **Providers** with its `claude auth login` command, and in **Manual steps**, as soon as the first run fails. Before, it kept reading as signed in and every run sent to it failed at once until you signed in by hand.
- While an account is signed out, Auto, **Switch accounts at usage limits**, scheduled tasks and delegated tasks use the next Claude account that can run the model. A chat that failed on it before its agent did any work starts again on that account with the same message, unless the scheduled run's time has passed. It counts as signed in again after you sign in (in a terminal or in T3.CodeShip), or after a run on it works, with no restart.
- A scheduled run whose account is signed out, with no other Claude account that can run it, uses your **Fallback model** from **Models** when that can run it. Known limits: other chats and agents do not use the fallback model, and a chat whose message had attachments waits for you instead of moving. With no account or fallback able to run, the run still fails, but the sign-in is already listed in **Manual steps**.

## 2026-11-11 — A restart no longer loses a chat's first message

- When a restart cut a chat before its agent received the message, for example while its worktree was being prepared, a later message no longer starts without it. A message you or an agent send, **Resume** or **Send now** first sends the cut message again, in the worktree it asked for, and the new one follows. This works with **Continue threads after restarts** off too. Before, the agent got only the later message, worked in the project folder instead of the worktree, and could pick up another chat's task as its own.

## 2026-11-11 — Scheduled-task tools say a model needs a provider

- The `schedule_task` tool now advertises its `modelSelection` as it is decoded: `instanceId` (the provider instance, for example `codex`) and a non-empty `model` are required, `options` is a list of `{id, value}`, and `autoAccount` is a boolean. Agents no longer send a model without a provider and get the update rejected. The old `provider` field is no longer accepted in this tool's input; stored selections still read it.

## 2026-11-11 — Manual steps get an AI review with suggested solutions

- Every manual step from ThreadPage now gets an AI review on its own: whether it really needs you or an agent could do it, a short summary, and up to three ways to get it done, best first, with the exact command to copy when there is one. Open a step from the details column or the sidebar to see its review on the Manual steps page; on mobile, tap a step. A bot icon marks steps the review says an agent can do.
- A new note in the step's ThreadPage thread brings a fresh review. **Review again** asks for a new one. Reviews use your text generation model and are written once per step on one of your machines, so every device shows the same review.

## 2026-11-11 — Restarts resume every scheduled run they cut

- A scheduled task whose runs overlap, such as one that starts every 30 minutes while earlier runs are still working, no longer loses its older runs to a restart. A restart used to resume only the newest run and settle the rest with "Skipped: a newer run … replaced this one", which also stopped their delegated tasks. Now each run resumes unless a newer run of the task started, or its next scheduled time came, while it was stopped.
- After a crash, a cut run counts as stopped from the server's last activity, not from when it came back, so runs cut by a long outage still stay stopped.

## 2026-11-11 — Fewer settings and fewer sign-ins by hand

- **Links renew themselves.** Linked environments no longer expire every 30 days while both machines run this version and reach each other in the last 10 days before expiry. A renewed link keeps its access, and revoking it on the other machine still ends it.
- **Sign-ins you can see coming.** Each Claude account shows when its login ends, warns a week before, and offers **Sign in again**. Signed-out accounts, ending or expired logins and MCP servers that need sign-in appear in **Manual steps** on every machine, even without ThreadPage, each with a button that opens the fix. Mobile can sign an MCP server in.
- **One-year Claude token.** A Claude account can sign in with **One-year token** (`claude setup-token`): no renewals for a year and no lost refreshes, but no claude.ai connectors in its sessions. **Use regular sign-in instead** switches back.
- **Models in one place.** Every model role is on one **Models** list in **Providers & models**, with "Same as default" and "Same as titles" where a role follows another.
- **Fewer controls.** Usage limits are one choice plus a hide switch, inside one **Recovery** section on **Threads** with network and restart recovery. Provider updates are Off / Notify / Install automatically, and notifications are one row. Cleanup rules, background polling and Diagnostics each have one place on **Maintenance & about**, snooze options edit in a dialog, Appearance holds only appearance, and keybinding conditions read in words. Old links still land on the moved rows.

## 2026-11-11 — Agents run terminal commands on linked machines

- An agent can now type into a terminal on a linked machine, such as your PC from your Mac, to run commands there and get back what they print. It uses a thread on that machine, so you watch the terminal in that thread's terminal panel. It needs a link paired with **Full access**, an agent thread in Full access, and **Agent terminal access** set to **Read and run commands** on the other machine; otherwise the agent is told which of these is missing.
- An agent allowed to run commands no longer asks you to open a terminal first: when the thread has none running, it opens one in the thread's folder.

## 2026-11-11 — Restarts resume every chat they cut

- A chat a restart cut before its agent received the message, while its worktree was being prepared or its agent was starting, now starts again on its own with the same message, model and worktree, instead of staying cancelled. The thread notes that the message was sent again, and no copy of it appears. When the restart came while the message was being sent, the agent is told it may have it already, so it does not repeat work; a `/goal` command in that state is not sent again. A cut delegated-task result is offered again once, as before. Scheduled runs whose window has ended, and archived, settled, snoozed or stopped chats stay as they are.
- Messages queued behind a chat a restart cut never start ahead of its resumed turn, also when an older turn's bookkeeping finishes first. If the resumed turn fails, they wait for you, as after any failure.
- An approval or secret request the restart cancelled no longer keeps the chat from resuming: the agent asks again. A question stays open for your answer.
- If `settings.json` cannot be read, chats still resume after restarts unless the file sets **Continue threads after restarts** to off.

## 2026-11-11 — Queued messages run after a restart resumes the thread

- When the server restarts or shuts down mid-turn, messages you queued no longer wait for you to press **Resume**. The interrupted turn resumes first, and once it finishes the queue runs in order. With **Continue threads after restarts** off, or after you press Stop, the queue stays held as before.
- An interrupted `/compact` now compacts again after the restart instead of being dropped, so a message queued behind it still gets the compacted context.

## 2026-11-11 — Machines and projects stay in place

- Machines keep one order everywhere they are listed: this machine first on web and desktop, then the rest by name. A machine going offline or reconnecting no longer drops to the bottom and jumps back.
- Projects always keep the order you set by moving their folders, on web, desktop and mobile, in the sidebar, the Projects page, project filters, project pickers and the command palette. New activity no longer reshuffles them, and the project you are in no longer jumps to the top of a project picker. **Settings → General → Project order** is gone, since there is now only one order. Projects you have not moved show in the order they were added; drag a folder on web or desktop to arrange them.

## 2026-11-11 — Pinned threads get their own section

- Pinned threads now sit under a **Pinned** header with a count, like Scheduled tasks, and list one line each instead of full cards. Click the header to collapse or expand the section; the sidebar remembers your choice. While it is collapsed, the thread you have open still shows, and dragging a thread onto the header pins it after the others.
- A thin rule separates pinned threads from active ones. The pin icon on each row now appears on hover, where clicking it unpins the thread.

## 2026-11-11 — Old releases repository retired

- The temporary second releases repository used for a few builds on 2026-11-07 and 2026-11-08 is retired. Releases are published only to GigaZoro/CodeShip, and nothing changes for users.

## 2026-11-08 — Automatic recovery skips outdated scheduled runs

- Scheduled-task runs no longer restart after a newer occurrence has started or their scheduled window has ended. Automatic recovery settles those chats with an explanation, preventing old runs from competing with current work. The latest run can still recover within its window, and ordinary chats recover as before.

## 2026-11-08 — Usage-limit checks stay fast as failed turns pile up

- Auto turns, agent launches and account routing no longer slow down as your history of failed turns grows: checking which accounts are out of usage reads only the usage refusals that can still hold an account (a reset still ahead, or no known reset within the last five hours), not every failed turn ever recorded. Which accounts count as limited is unchanged.

## 2026-11-08 — Limited threads move as soon as another account's usage window ends

- With **Switch accounts at usage limits** on, a thread waiting because every other account was out of usage now moves to the first account whose used-up usage window resets or whose hold ends, within seconds. Before, an account limited only by its usage bars, with no refused turn, could leave the thread waiting up to ten more minutes.

## 2026-11-08 — Auto limit holds expire and briefs take less context

- A usage refusal without a reset holds the account for five hours, or its shortest reported usage window when that is shorter. Named launches respect the same hold; fresh snapshots do not erase a recent refusal. A used-up usage window without a reset holds from when it was first seen used up, for at most that long. Usage → Limits shows the hold's end as the return time and stops showing the account limited after it.
- Provider-attributed model limits exclude only that model family, in Auto's brief too. They last until their reset; a completed run of that family lifts them early, however many other models ran since, and a run of another model no longer does. A later Claude limit that names no window keeps a model limit to its family. Driver-only delegates keep the parent's usable account and effort, and API-key coordinators keep their native models.
- Auto briefs use Claude's native model aliases, share effort choices across models, and go with every top-level Auto turn. Claude gets the turn's brief back when it compacts the conversation mid-turn. Codex's brief states the `reasoning_effort` values its native subagents accept. A failed limits read no longer prevents an Auto turn.
- Agents cannot set an own scheduled-task model and follow the default in the same request.
- Auto turns, agent launches and account routing no longer slow down as run history grows: checking an account's usage limits reads only its runs since the refusal.

## 2026-11-08 — Updates no longer wait for hours on busy chats

- **Update when it finishes** now installs once the background work listed when you chose it is done. Before, every new command or subagent a chat started kept the update waiting, so a chat working in rounds could hold it for hours. Work started later stops in the restart, and its chat restarts it when it resumes.
- A chat that is only waiting for another chat or a delegated task no longer holds an update. It resumes after the restart and waits again; the other chat's own work still holds the update when it runs on the same machine.
- The Safe update confirmation says this, and a waiting update counts only the listed work still running. On web, desktop and mobile.

## 2026-11-08 — Auto respects account limits and reviews on your primary models

- Auto and delegated work skip exhausted subscription accounts, respect project account settings, and keep models available when only another model's allowance is exhausted. Auto considers all eligible accounts and shows each model's own effort choices.
- Auto reviews use the primary model and effort you chose for each provider in Settings, preferring the provider that did not implement the change.
- Agents cannot replace a scheduled task's model with an unknown account or an unverifiable model. Startup usage refusals keep exhausted accounts out of Auto. Unknown-reset refusals clear when a newer usage check shows room or a later run succeeds; a launch that names the account can retry an unknown-reset refusal even after failed usage checks. Inherited accounts, role defaults and provider-only requests keep skipping those refusals. Known future resets and exhausted usage windows still block launches.
- Retrying an accepted delegation keeps its chosen account and model. Linked machines running older versions also avoid accounts with an unknown usage reset.

## 2026-11-08 — Scheduled tasks take less room in the thread list

- Each task in the **Scheduled** section is now one line, the height of a settled thread, with its run status or the time to its next run (such as "in 2h 30m") at the end. Six tasks take about 220px instead of 360px.
- Hover a task to see its schedule, next and last run, project and machine. With more than one machine connected, a small machine badge shows which one runs it.
- On web and desktop.

## 2026-11-08 — A found update stays on offer when GitHub stops answering

- When the desktop app had found a new version and a later automatic check failed, because GitHub timed out or dropped the connection, the update button disappeared until a check succeeded again. During a GitHub outage that could be hours. The update now stays on offer, with its release notes, until a check that does answer says otherwise.

## 2026-11-08 — Claude usage no longer counts a resumed chat's history again

- After a Claude chat was stopped, failed, sat idle or switched settings, its next turn counted every token the chat had used before as subagent and compaction ("other") usage, sometimes hundreds of millions of tokens in a few seconds. That turn's other usage is now left out as unknown, and later turns count only their own. Turns already recorded keep their earlier numbers.

## 2026-11-08 — Updates arrive after GitHub outages

- When a new version fails to build because GitHub is down, it is now built again every half hour until it is released. Before, it was retried twice within minutes, so after a longer outage no update arrived until the next change shipped.

## 2026-11-08 — Limited threads move to an account as soon as it has usage again

- With **Switch accounts at usage limits** on, a thread that stopped while every other account of its provider was also out now moves to the first one that gets usage back, the moment its limit resets. Before, a thread with **Resume at reset** scheduled, which is every limit stop while **Resume after usage limits** is on, waited for its own account's reset even when another account had room again, up to a week for a weekly limit. A thread you snooze or whose auto-resume you cancel still waits.

## 2026-11-08 — Counters on the sidebar rail

- **Threads** keeps its Needs you count, and hovering it now lists failed chats, usage limits, approvals and questions separately.
- **Pull requests** counts open pull requests linked to your threads that have failing checks, conflicts or requested changes.
- **Scheduled tasks** shows how many tasks' latest run failed, instead of a dot.
- **Extensions** counts MCP servers that failed or need sign-in when last checked. It reads the last list you opened, so it never starts a provider.
- **Manual steps** shows how many steps wait, highlighted when one is a money decision, and a red dot when ThreadPage cannot be read.
- **Settings** counts installed providers with an error or signed out.
- On web and desktop.

## 2026-11-08 — Hide Manual steps beside your threads

- Right-click the **Manual steps** header under Needs you or in the thread list and choose **Hide Manual steps**. The toast has **Undo**.
- **Manual steps under Needs you** in the thread details' **Choose what to show** menu (or right-click the details card) turns it off and back on, as does **Settings → General → Manual steps**. The Manual steps page in the sidebar rail and the command palette still list every step.
- On web and desktop.

## 2026-11-08 — Auto chooses models for each piece of work

- Auto lists usable Claude and Codex models so the coordinator can pick the best fit for each piece of work and review the result. Its own model and effort remain the choices in Settings.
- Agents can choose a scheduled task's model, restore its default, and update default, scheduled-task, delegated-task and Auto models, including on linked machines paired with full access.
- An explicit model and effort in an agent's new-thread request now stay as requested, even when copied from an Auto thread.

## 2026-11-08 — Eval check for worktree launches without a base branch

- The MCP tool-use eval now confirms today's `t3_thread_launch` fix: told to launch with `workspaceStrategy {type: "worktree"}` and no `baseRef`, GPT-6 Luna and GPT-6 Astra had their launch refused on every try before the fix and launched it on every try after. A refused launch no longer counts as a launch, and a launch now answers with the new thread the way T3 does, so an agent that checks its launch no longer starts it a second time.

## 2026-11-08 — Open a manual step's chat

- A **Manual steps** row now has **Open chat** when the chat that set the step Waiting recorded itself in the ThreadPage thread, as a `Chat: <link>` line in its description. It opens that chat; clicking the row still opens the step in ThreadPage. On web, desktop and mobile. The chat must be on a machine this app is connected to.

## 2026-11-08 — Needs you rows no longer overlap

- In the sidebar's **Needs you** box, the **Later** button you see on hover no longer covers "This thread" or the end of a long title. The row keeps room for it, so nothing moves when it appears.

## 2026-11-08 — Codex accounts connected with ChatGPT switch at their limits by themselves

- **Limits kept by ChatGPT** under **Usage → Limits** now has **Read limits** for each account connected with ChatGPT, on each machine that cannot read its limits yet. Sign in as the account once: T3.CodeShip keeps that Codex login only for reading the account's limits and using its reset credits, and leaves your Codex CLI and Codex Desktop logins alone. Running threads keep going while you sign in. Signing in as a different account is refused, and disconnecting the account removes the login.
- When such an account stops on its ChatGPT usage limit, the thread now says so with the ChatGPT recovery options, and a machine that reads the account's limits knows when it resets. **Switch accounts at usage limits** then moves the thread to an account with room, auto-resume can wait for the reset, and new threads skip an account that is out. Before, these stops looked like a dropped connection and you had to switch accounts by hand.
- On web, desktop and mobile.

## 2026-11-08 — Open at login

- **Settings → Maintenance & about → Open at login** starts T3.CodeShip when you sign in on macOS and Windows. On Windows the entry follows the app across updates that rename it: the installer and the app keep it on the current executable, and a startup entry left on an older executable name in the install folder, including one added by hand, is moved over instead of starting a deleted file. Uninstalling removes it.

## 2026-11-08 — Worktree launches without a base branch

- An agent that starts a new thread in a new worktree with `t3_thread_launch` no longer has to name a base branch. Without `baseRef` the worktree starts from the project's default branch, fetched first, as a scheduled task's does. Before, leaving it out failed with "Missing key at workspaceStrategy.baseRef".
- T3's tool schemas now say which fields a choice needs, such as `worktreePath` for an existing worktree or `everyMs` for an interval schedule, so agents no longer leave them out.

## 2026-11-08 — A chat that archives itself ends completed

- When an agent archives its own chat during its turn, for example as the last step of a scheduled run, the chat is now archived when the turn ends and the run counts as completed. Before, archiving stopped the agent mid-turn, so the run ended failed with "The provider event stream closed unexpectedly". As with settling, a failed turn or a message someone queued leaves the chat unarchived.
- An agent can no longer archive another chat while its turn is running, the same as web, desktop and mobile already refuse. It gets an error asking it to stop the turn first, instead of ending that turn as failed.

## 2026-11-08 — More agents hear a finished background task after their session ended

- When background work finishes after the Grok, OpenCode, Pi, Muse or ACP registry agent session that started it has ended, for example because the agent process exited or the server restarted, the agent now gets the finish notice as a message and carries on. Before, that turn finished empty and the agent never heard the work had finished. Claude got the same fix earlier today.

## 2026-11-08 — Add, edit and delete project actions on mobile

- **Settings → Projects → Actions** on mobile lists the selected project's actions. Add one, tap one to edit or delete it, or import one from the checkout's `t3.json`; web and desktop see the change. A connection that can't change settings, or a server too old to save actions, still shows the list and the editor, with the reason. Deleting an action also removes its shortcut unless another project still has that action.
- With no actions yet, the terminal menu in a thread on iPhone and iPad offers **Add action** and opens the editor.
- Mobile saves actions the same way web does, so a new action gets the same kind of id and edits from both never overwrite each other.
- Adding an action to a project with two checkouts on one machine now adds it to both, on web too. Before, the second failed with "Another action with this name was just added".

## 2026-11-08 — Git action results speak your language, and the next step stays clickable

- Commit, push, pull request and pull results, and the progress steps while an action runs ("Committing…", "Pushing…", "Generating PR content…"), now show in the app's language on web, desktop and mobile. Before, they always came from the server in English.
- On web and desktop, after a commit the next action, such as **Push & create PR**, is clickable right away. The result ("Committed abc1234" and its subject) shows on a line under it for 10 seconds instead of replacing the button.

## 2026-11-08 — Claude hears a finished background command after its session closed

- When a background command or task finishes after the Claude session that started it has closed, for example after a network outage, the agent now gets the finish notice as a message and carries on. Before, that turn failed with "Send a message to continue" and the chat waited for you.

## 2026-11-08 — Muse and Codex replay tests pass again

- The Muse replay tests no longer keep their own copy of the instructions T3.CodeShip gives agents. They build the current text when they run, so they pass again and keep passing when that wording changes.
- The Codex replay tests no longer check the app name T3.CodeShip reports to Codex, the same way they already skip its version, so a fixture recorded under another name passes. Nothing changes in the app.

## 2026-11-08 — Branches stay put while an agent works, on mobile and for every client

- On mobile, **Branches & worktrees** now keeps a thread's branch while its agent is working, like web and desktop: switching, creating a branch and creating a worktree are disabled, and the sheet says why. Before, a switch moved the files the agent was editing, and picking a branch checked out in another worktree stopped the turn.
- The server now refuses a branch switch, a new branch that is checked out right away, or a pull request checked out in place in any folder where a turn is running, whichever client, agent or tool asks. The refusal shows as an error saying branches can't change while the agent is working. A turn in a separate worktree, even one inside the project's folder, doesn't block the main checkout, and commits stay available.

## 2026-11-08 — The Android app starts again

- The Android app crashed on launch with "undefined cannot be used as a constructor" since the language setting arrived, because Android's JavaScript engine has no plural-rules or locale API. The app now picks plural forms itself, so Ukrainian counts such as 1 файл, 3 файли and 5 файлів work there too.
- With **Language** on **System**, an Android phone set to Ukrainian now shows Ukrainian. Before, the phone's language was never recognised.

## 2026-11-08 — Project action saves no longer undo each other

- Adding, editing or deleting a project action now changes only that action, on the list the machine holds at that moment. Importing two actions from t3.json in quick succession, or editing actions from two devices at once, keeps every change. Before, the later save could drop the earlier one, and saving or resetting a project's actions could revert another of its settings changed elsewhere meanwhile. If another device adds an action with the same name first, you're asked to save again.
- A machine on an older server version asks you to update it before its actions can be changed.

## 2026-11-08 — A reply keeps its code blocks, selection and videos when it finishes

- When a reply finishes streaming, everything below its first paragraph now stays as it was: a code block's **Wrap lines** choice, text you selected, a playing video and a Mermaid diagram no longer reset or jump. A Markdown file preview now redraws only the part of the file that changed.
- Headings with the same name in a streaming reply now get different link targets, so its contents links jump to the right heading while it streams.
- An unclosed inline HTML tag such as `<b>` now formats the following paragraphs the same while a reply streams as after it finishes.

## 2026-11-08 — Updates wait for background work chats are waiting on

- An update no longer stops a long background command, task or subagent that a chat is waiting on, such as a test run or a CI replay. The update waits until that work finishes, then restarts, so the chat still gets the result. **Safe update** lists the work it waits for and offers **Update now** to restart right away. While it waits, the update button says how many tasks it is waiting for, and you can update now or stop waiting.
- Updating a server on another machine, including **Update everything** and from the mobile app, waits the same way for that machine's background work and shows it as **Waiting for background work**.
- The note a chat gets after a restart now also wakes it for a background command it said it was waiting on while that command's step still showed as running.

## 2026-11-08 — A git action no longer overwrites a branch the thread moved to

- When a git action creates a feature branch, the thread now switches to it only if its branch hasn't changed while the action ran, for example because another device or a finished agent turn moved it. The newer branch is kept. On mobile, the action still reports success in that case instead of "Git action failed". On web, desktop and mobile.

## 2026-11-08 — A finished background command no longer ends in an empty turn

- In an **Auto** chat whose account has run out of usage, the turn a finished background command starts now stays on the account that ran the command. Before, it moved to another account, ended within seconds without a reply, and left the chat idle as if the work were done. Now it either replies, or reaches the usage limit and the chat moves to the next account, as **Switch accounts at usage limits** does for any turn.
- If a Claude chat's follow-up turn still cannot reach the session that received the notice, for example after that session restarted, the turn now fails with a message saying so instead of showing as completed with no output.

## 2026-11-08 — Codex shows signed out as soon as ChatGPT revokes its connection

- When ChatGPT revokes the connection of a Codex account you connected with ChatGPT, T3.CodeShip now renews it once on the next model check or session start. If ChatGPT refuses the renewal, the account shows as signed out right away, and new chats, generated titles and branch names, and MCP lists say **Your ChatGPT connection was revoked. Sign in again.** Before, the account stayed signed in and everything failed with "Check your connection and retry" until the server restarted.
- If the renewal works, the request is retried once and nothing else changes.

## 2026-11-08 — Server browsers keep your profiles after a restart

- A server browser now remembers the browser profiles your apps reported and the recording frame rate you chose, after it restarts. Agents on an always-on server can open a tab in a custom profile, such as one signed in to a second ChatGPT account, before any app connects again. Before, they got "No browser profile is named …" until you opened an app on that environment.
- A signed-in profile stays available to agents when another device with different profiles connects. Removing a profile in an app's settings still removes it.
- When two devices each have a profile with the same name, an agent that opens it by name gets the one that holds a sign-in on that server. If both do, it is told both ids and asked to pick one.

## 2026-11-08 — Git, branch, markdown and project action fixes, and a tidier phone layout

- **Git actions** follow the same rules on web, desktop and mobile. A branch that is behind offers **Pull** first and in the menu, a clean default branch only pushes (it no longer commits changes an agent made meanwhile), and the feature-branch option appears only for actions that commit. Each disabled menu item says why, in the item itself. **Publish repository** can't be closed while it publishes, and names the provider it used. Commit file checkboxes are labelled for screen readers and easier to hit on touch.
- **Branch picker**: a refs list that fails to load says why, with **Try again**, instead of staying greyed out; an offline machine says so. Typing a branch name keeps the list and no longer offers to create a branch that exists. Branches can't change while the agent is working. **Run on** marks offline machines, and a draft in a previous worktree can go back to **Current checkout** in one step.
- **Chat replies**: long replies with HTML or regex code stream as smoothly as others. **Copy code** leaves out the trailing newline, so a pasted command doesn't run on its own. Failed copies and links that can't open now say so, and code shows as plain text while its colours load.
- **Project actions**: **Edit action** is its own menu entry, so it works on touch and keyboard. Shortcuts that clash with another command, or have no modifier key, are refused. The editor can't be closed mid-save, keeps your edits on an outside click, refuses duplicate names, and says which action an automatic run setting replaces. Without terminal access, **Run** is disabled with the reason.
- **Mobile**: a failed **Stop** or **Merge back** now says so. Git errors stay until you close them and show their full text, and git actions on a new-thread draft show progress. Thread rows read their status, time, project and PR to VoiceOver and TalkBack, with actions for settle, snooze and delete, and **Undo** waits while a screen reader is on. **Archived** stays reachable when no threads are left, first sync shows loading and **Retry** instead of "No threads yet", and filtered lists offer **Show all threads**. On Android the Undo notice no longer covers the New thread button.

## 2026-11-08 — Claude MCP sign-in no longer hangs after the browser returns

- Signing in to an MCP server for a Claude provider on another machine now finishes once you approve in the browser. Before, Claude saved the sign-in but the dialog stayed on "Waiting for approval…" for up to five minutes, and trying again showed "No active OAuth flow for server". The same fix applies when you paste the redirect address yourself.

## 2026-11-08 — Account switching moves Claude turns held at a usage limit

- With **Switch accounts at usage limits** on, a Claude turn that Claude holds open until its usage limit resets now continues on another account of the same provider that has usage left, instead of waiting for the reset. A reset less than five minutes away is still waited out, and with switching off or no account with room the turn keeps waiting as before.
- The account the turn was held on is skipped until its reset, also after the turn moves or you stop it, and a stopped held turn now says "Usage limit reached" with the reset time.

## 2026-11-08 — Updates come from GigaZoro/CodeShip again

- Desktop apps, `t3 update` and a server's update button get new versions from [GigaZoro/CodeShip](https://github.com/GigaZoro/CodeShip/releases) again. The repository stays public, so the separate releases repository is no longer needed. Your app moves back with this update; nothing to do.
- To install T3.CodeShip on a Linux server, use the `install.sh` attached to each release in GigaZoro/CodeShip.

## 2026-11-08 — Codex accounts connected with ChatGPT show their limits

- A Codex account you connected with ChatGPT now gets a limits bar on **Usage → Limits**, with its reset credits and **Use reset**, when a connected machine has a Codex CLI login for the same account. ChatGPT shares the limits only with the CLI login, and both spend the same allowance. If that CLI login is signed out, **Limits** now says so instead of a bare JSON-RPC error. Before, such an account only linked to ChatGPT, and its bar could be another machine's reading from hours ago.
- An account whose limits show in a bar is no longer also listed under **Limits kept by ChatGPT**, and that list now says how to get the remaining accounts' limits here. On web, desktop and mobile.

## 2026-11-08 — Agents learn early when a host's browser can't start

- On a Linux host that lacks the browser's libraries, blocks its sandbox, or runs T3.CodeShip as root, agents now see why when they first check the browser, with the command that fixes it. Before, they only found out when a tab failed to open, sometimes long after.
- At startup, the server now warns about missing libraries and a root server too, not only a blocked sandbox.
- The remote browser guide now explains why Google and Cloudflare-protected logins such as OpenAI's refuse a server's browser, and where to sign in instead.

## 2026-11-08 — Manual steps: every step only you can do, from all machines

- A new **Manual steps** list shows every step only you can do, from the pending lists agents keep for each machine in ThreadPage (**Work → Agent Maintenance → Machine inbox**): sign-ins, installs that need your password, and money decisions, which come first and are marked **Money**. Steps are grouped by machine and say how long ago they were last updated. Clicking one opens its ThreadPage thread, whose newest note says what to do.
- It sits under Needs you in a chat's details column, in the thread list on narrow windows and on mobile, and on its own page from the sidebar rail or **Manual steps** in the command palette. It refreshes when it opens, every 5 minutes, and from its refresh button. It never sends a notification or adds to the Needs you badge.
- To fill it, save a ThreadPage token in **Settings → Threads → ThreadPage** on one machine; every app connected to that machine then shows the list. The token stays on that machine's server and is never sent to apps.

## 2026-11-08 — Project order on every device

- A project order you set by moving folders on web or desktop is now saved on your machines instead of in one browser, so every device whose **Project order** is **Manual** shows the same order. An order saved only in a browser before this update isn't carried over; move a folder once to save it again.
- Mobile gets **Settings → General → Project order**. Choose **Manual** to see the order you set on web or desktop. Pinned projects now get the top folders on mobile too, and archived ones the last.
- Dragging a project folder near the top or bottom of the sidebar scrolls the list, and the drop line follows the rows when you scroll with the mouse wheel mid-drag.
- The project picker on a new draft follows the manual order too.

## 2026-11-08 — Panel tabs no longer slide under the top-right buttons

- With the right panel open on a wide window, its tabs and scroll arrows no longer run underneath the **Terminal**, **Panel** and maximize buttons. The tab strip now ends before those buttons at any width and language. On web and desktop.
- On desktop, the whole of those buttons is clickable again with the panel open. Before, clicking their left part could drag the window instead.

## 2026-11-08 — Chats that settle themselves stay settled

- When an agent settles its own chat at the end of its turn, the chat now settles even if a delegated task's result or a finished background command starts one more turn right as the first ends. The settle waits for that turn instead of being dropped. A message you send in the meantime still keeps the chat active.
- Cancelling a delegated task with `task_cancel` no longer wakes the agent later with an "interrupted" notice for a follow-up that was running in that task's chat. Before, that notice could reopen a chat the agent had already settled.

## 2026-11-08 — MCP sign-in finishes on its own for servers on another machine

- In the desktop app, **Sign in** on an MCP server of a Claude or Codex provider running on another machine now finishes without copying anything. The app catches the browser's return to `localhost` on your computer and hands it to the provider, instead of leaving the browser on "can't connect to server". Pasting the address stays as the fallback, and is still how it works from a web browser, or when the sign-in port is busy on your computer.

## 2026-11-08 — Importing conversations says what it brought in

- Turning on **Import conversations** for Claude Code and Codex now says how many conversations came in once the import finishes, such as "Imported 39 conversations · find them under Settled", instead of looking like nothing happened. Imported threads start settled, so on web and desktop **Show** opens the most recently active one and expands **Settled**. On mobile the same message appears as an alert.
- An import that finds nothing new says "No new conversations to import", and one that fails says so instead.

## 2026-11-08 — Reset covers the provider health check interval

- **Reset page** on **Settings → Providers** now restores the **Health check interval** too. It resets only that interval and keeps the rest of your Background activity policy.
- On **Settings → Source control**, the **Git fetch interval** reset and **Reset page** no longer offer to reset the interval when it already matches your Background activity profile, such as Battery saver. Before, the reset changed nothing and stayed on offer.

## 2026-11-08 — Thread shortcuts stay out of confirmation dialogs

- The archive and snooze shortcuts (⌥⌘E and ⌥⌘Z by default) no longer act on the thread behind a confirmation dialog, such as **Edit from here?**. Before, pressing them there archived the thread or opened the snooze list while the dialog was still open. On web and desktop.
- A two-finger swipe inside a confirmation dialog no longer goes back or forward a page on desktop.

## 2026-11-08 — A ship skill for T3.CodeShip contributors

- Agents working in a T3.CodeShip checkout get a `ship` skill: `/ship` or "ship it" commits the work, adds the release note, runs the pre-push checks, lands it on `main` without a PR, then deletes the branch and its worktree. Nothing changes in the app.

## 2026-11-08 — Updates come from a public releases repository

- Desktop apps, `t3 update` and a server's update button now get new versions from the public [GigaZoro/codeship-releases](https://github.com/GigaZoro/codeship-releases) repository. Your app moves there with this update; nothing to do.
- On mobile, **Check for updates** in an environment's settings looks for that server's own releases. Before, it checked upstream T3 Code's releases and never offered a T3.CodeShip update.
- To install T3.CodeShip on a Linux server, use the `install.sh` attached to each release (see the releases repository's README).

## 2026-11-08 — No Keychain prompt after desktop updates

- The Mac app no longer asks for "t3code Safe Storage" in your Keychain each time it starts after an update. T3.CodeShip's self-signed releases, which have no Apple Team ID, keep your saved connections in a file only your account can read, like the T3 account sign-in already was. The first start after this update asks one last time to move them out of the Keychain.

## 2026-11-07 — Claude asks for Anthropic's updated terms at sign-in

- When a Claude account hasn't reviewed Anthropic's updated Consumer Terms, Claude won't start for it. **Settings → Providers & models** now says so for that account instead of "Claude Agent CLI failed while checking account status", and a chat on it says the same instead of "Claude Code exited with code 1".
- Signing in to a Claude account, when you add it or select **Sign in** for it, now opens Claude in the sign-in terminal if the account still has the terms to review. Answer Claude's prompt there, then type `/exit`. The answer belongs to the account, so every machine signed in to it works again.

## 2026-11-07 — New scheduled tasks show in the Scheduled section

- The scheduled task place that adds a row to the **Scheduled** section of the thread list is now called **Scheduled section** instead of **Pinned**, in **Show in**, **Show all in** and **Settings → General → Show new scheduled tasks in**. It was easy to mistake for the pinned threads section. On web, desktop and mobile.
- New scheduled tasks go to the Scheduled section by default instead of showing as regular chats. Tasks you already have stay where they are. To keep new ones as regular chats, choose **Regular chat** in **Settings → General → Show new scheduled tasks in**.

## 2026-11-07 — Needs you keeps to what only you can act on

- Needs you lists a failed or usage-limited run only in a thread you started. Runs that failed in threads an agent started, scheduled task runs included, are left to agents to recover: they still show Failed in the thread list, but no longer wait in Needs you or count in its badges. On web, desktop and mobile.

## 2026-11-07 — Money questions reach Needs you

- Agents ask you only about money: spending it, real funds, or money being lost now. Everything else they decide themselves and say what they chose.
- Such a question stays open after the agent's turn ends, also in a scheduled task's run, so the thread shows under **Needs you** instead of only saying "Needs you" in its reply. Answer in the thread or from the Needs you box.
- A question that offers choices can be answered with one tap in the Needs you box on web and desktop, and in the Needs you rows on mobile. Your answer goes to the agent as your next message, and it carries on from there.

## 2026-11-07 — Clearer subscription limits

- **Usage → Limits** says which machine isn't connected when a provider's limits come from its last reading, such as "Zoro-PC not connected · read 6h ago", instead of a bare "Checked 6h ago". The account's details say so too, and its **Use reset** waits until the machine is back.
- Each window card shows when it resets ("Resets in 3d 11h" and the time) and whether you are ahead of or under pace, in words. Banked reset credits get their own row under the cards, with **Use reset** right there instead of only in the account popover.
- Codex accounts you connect with ChatGPT are listed under Codex in **Limits kept by ChatGPT**, once per account with every machine it is signed in on, instead of in a separate card at the bottom. Their limits still show only in ChatGPT. On web, desktop and mobile.

## 2026-11-07 — Agents can read and use the terminal panel

- Agents can read the recent output of their thread's terminals, such as a dev server you started in the terminal panel, instead of asking you to paste it.
- **Agent terminal access** in **Settings → Browser & devices** sets what agents may do: **No access**, **Read output** (the default) or **Read and run commands**. With the last, agents in Full access threads can type into the thread's terminal, such as to restart your dev server, and get back what it printed. You can set it for one project, and changes apply to running agents right away.
- After T3.CodeShip restarts, agents can read a terminal's saved output before you reopen the terminal panel.
- Agents won't type into a terminal you're using or where you left a command unsent, and a terminal an agent typed into last shows "· agent" after its name, also when it's the only terminal.

## 2026-11-07 — Answer from the Needs you box

- The **Needs you** box at the bottom of the chat always shows what waits on you, in compact rows that say what each thread asks. The header button and the option to move the box into the thread list are gone.
- Approve or decline an approval, or settle a failed run, without leaving the thread you're in. On mobile, Needs you rows offer allow and decline for an approval right in the thread list.
- **Later** puts a thread off until it asks something new, from the box, the thread's menu, or a long-press on mobile, with **Undo** right after. It is saved with the thread, so every device agrees: put-off threads sit under **Later** below the ones that need you now, stop counting in the Threads icon, dock and app-icon badges, and **Next thread that needs you** skips them. The thread you have open is marked **This thread**.
- The Needs you count on the Threads icon is amber, like the rest of Needs you, instead of red.

## 2026-11-07 — Agents more often hand you a runnable command

- When an agent stops because you need to run something, such as signing in, it now ends its reply with the command in a code block more often, so **Run in terminal** can run it.

## 2026-11-07 — Commands to run come as code blocks

- When an agent needs you to run a command, such as signing in with `gh auth login`, it gives the command in its own code block, so you can run it with **Run in terminal** on web and desktop instead of copying it.
- On mobile, tap a one-line shell code block in a finished reply to run it in the thread's terminal. The app shows the command and asks first.

## 2026-11-07 — Threads resume after a lost connection

- A thread whose turn stopped because the internet dropped now resumes on its own once the connection is back, on every machine and with every agent. It waits while the machine is offline instead of failing again, and gives up after three quick failures in a row. Turn it off with Retry threads after network errors in Settings → Maintenance & about, on web, desktop and mobile.
- A new thread whose worktree could not be set up because Git could not reach the remote now sets it up again once the connection is back, and then sends your message.
- Turns that could not reach the provider (DNS, refused or dropped connections, no route) now show as connection errors instead of provider errors, for Claude, OpenCode, Cursor, Grok, Antigravity, Pi, Muse and other ACP agents. **Resume** in the composer works on them.

## 2026-11-07 — One-machine tasks finish even when the first machine doesn't

- A one-machine scheduled task no longer gets lost when the machine running it fails partway. The next machine in the project's order keeps checking while that run is still going, and runs the task itself if the run fails or the machine stops answering (for example, it went to sleep or shut down), until the next run is due.
- A one-machine run that you or an agent stop stays stopped: the next machine doesn't start it again.

## 2026-11-07 — The fork's server runs on Linux servers

- Each release now includes the Linux x64 server (`t3`) and a `SHA256SUMS` file. Install it on a Linux server with `curl -fsSL https://raw.githubusercontent.com/GigaZoro/CodeShip/main/scripts/install.sh | T3CODE_RELEASE_REPOSITORY=GigaZoro/CodeShip sh`, then `t3 service install`.
- `t3 update`, a server's update button and adding a machine over SSH from the desktop app now install this fork's server instead of upstream T3 Code's.
- `install.sh` accepts `T3CODE_RELEASE_REPOSITORY` to install from another repository's releases.

## 2026-11-07 — Scheduled tasks show where they run

- Each scheduled task shows its machine and project, with their icons, so you can tell them apart without the machine headings.
- Scheduled tasks lists the tasks of machines your computer links to under **Linked machines**, even while one is offline. Each shows the tasks it last reported, whether it's online or when it was last seen, and **Add environment** when the app isn't connected to it. Your computer checks them every 5 minutes and when you open the page.

## 2026-11-07 — Needs you button only when something waits

- The **Needs you** button in the chat header shows only while a thread needs you.

## 2026-11-07 — One "Needs you" everywhere

- Needs you also lists runs that failed or hit a usage limit, the same ones that notify you. Retrying, settling or snoozing such a thread takes it off the list, and you can settle it right from the list.
- Needs you puts the longest wait first and shows how long each thread has waited, on web, desktop and mobile.
- Press Mod+Shift+U, or choose Next thread that needs you in the command palette, to step through the threads that need you. On mobile, a "N more need you" button above the composer does the same, and the iPad command palette has it too.
- The desktop dock and Windows taskbar badge, the Threads icon in the side rail and the mobile app icon now count the threads that need you. The badge no longer clears when you switch to the window.
- Thread statuses use the same words on every surface: the thread status pill says Starting instead of Connecting and Done instead of Completed, screen readers say "Approval needed" and "Input needed" as notifications do, and a pinned scheduled task says Limited or Request like its thread.
- Your phone no longer alerts when a snoozed thread finishes. A failure or a request for approval or input still does.

## 2026-11-07 — Settings, scheduled tasks, archive, usage and MCP servers

- Reset page now resets a setting that only another machine changed. The confirmation names the machines it writes to, and an Undo puts every machine's values back.
- **Settings → Machines & access** lists the settings that differ between your connected machines, with **Use everywhere** to copy one machine's value to the rest.
- Settings search finds Scheduled tasks, MCP servers, Plugins, Skills and Usage, and the differences between machines.
- **Show new scheduled tasks in** now applies to every machine.
- Scheduled tasks:
  - A task on several machines is listed once, with a line per machine and one run history across them.
  - Deleting a shared task says it deletes it on every machine, and names them.
  - **Last run** opens its thread, and the next run shows its time as well as how soon it is.
  - Sync warnings show under the row instead of only in a tooltip, and the editor names the machine instead of saying "This machine".
  - Tasks can be duplicated, and on web or desktop moved to another machine.
  - The Scheduled tasks rail item shows a red dot while a task's latest run failed.
- Archived threads:
  - Open an archived thread to read it before you unarchive it.
  - Search the archive.
  - Delete a thread from its row.
  - The archive loads 50 threads at a time instead of every archived thread from every machine at once.
- Usage → Limits says when each provider's limits were last checked, and whether switching accounts at usage limits is on and which account a limited thread continues on, with a link to the setting.
- The Projects page folds archived projects into their own **Archived** group, with **Archive project** and **Unarchive** in the menu.
- MCP servers:
  - Turn a Claude or Codex server off and on without removing it.
  - Edit its address, command or keys; stored keys are never sent to the app.
  - Compare the list with your other machines.
  - Remove now says it deletes the stored keys and offers **Turn off instead**.
  - Agents can manage these servers too.

## 2026-11-07 — Controlling a running agent

- Stop and send is a third Follow-up behavior next to Steer and Queue, on web, desktop and mobile. It stops the current turn and sends your message instead, on agents that can restart a turn such as Codex, OpenCode and Cursor; others steer.
- While the agent works, the arrow next to the send button picks Steer now, Queue or Stop and send for one message. On mobile, long-press the send button.
- A Stop and send that arrives just as the turn finishes starts a new turn with your message instead of failing, including one sent by an agent.
- The Stop button stays next to Send while you type a correction, on web, desktop and mobile. It has a shortcut, Cmd+. on macOS or Ctrl+. elsewhere, and one name, Stop agent.
- Approvals answer from the keyboard: Cmd+Option+Y approves, adding Shift always allows, and Cmd+Option+X declines (Ctrl+Alt on Windows and Linux). Change them in Settings → Keybindings.
- Scroll to end says when an approval or a question is waiting below.
- Removing a queued message offers Undo, which queues it again.
- On web and desktop, Retry no longer refuses when the message box has a draft. The draft moves to the stash, and the notice opens it.
- An approval whose agent process has ended offers Stop agent, on web and mobile, including approvals from child threads.
- The Edit from here and Retry dialogs explain in plain words what happens to the chat and your files.
- On mobile, the Steer option no longer says it interrupts the agent.

## 2026-11-07 — Offline machines shown honestly

- Threads on a machine you cannot reach show their last known status, dimmed, for example "Offline · Working", without a running timer. Hover one to see when the machine was last seen; Settle and Snooze wait until it is back.
- Machine folders say Reconnecting, Offline or Can't connect, with when the machine was last seen, and their right-click menu has Reconnect.
- Each machine gets its own colour and initial in thread rows, folders and the machine list, so two PCs with the same name look different. This also applies on mobile.
- With more than one machine, the bottom of the sidebar lists them. Click it for each machine's connection, last seen time, working and needs-you counts, tightest usage limit, and Reconnect.
- On web and desktop, a text message to a thread whose machine is offline now waits and sends when the machine is back, instead of being refused. Edit or Cancel waiting messages above the composer.
- Notifications name the project and the machine when you have more than one of each.
- On mobile, the title at the top names a machine you cannot reach even while another is connected, and pulling down on the thread list reconnects it.

## 2026-11-07 — Mobile app fixes

- Settings → Notifications on the phone has switches for which alerts reach it: approval requests, questions, finished tasks and failed tasks.
- Turning off Live Activities or Live Updates on the phone works without a T3 Connect sign-in or a connection, and the current one disappears right away.
- The approval card has a plain title, such as Command approval, and shows the command in monospace. A long command folds to six lines with Show more.
- In the Tasks tab, tapping a task opens its last run; Edit, Run history and Open last run are in its menu. Run now confirms the task started and offers to open the run.
- The composer's attachment menu has Take Photo next to the photo library.
- The app's Home Screen quick actions include Needs you, which opens the chat list on the Chats tab. iOS now offers New task and Needs you as quick actions too.
- On Android, the buttons on agent notifications say Open, since they open the thread. Tapping a stack of alerts opens the chat list instead of only the newest thread. Notification text follows the language chosen in the app, including Ukrainian.

## 2026-11-07 — Needs you joins the Details column

- On web and desktop, Needs you now sits at the bottom of the thread's Details column, inside the chat, instead of in its own strip at the edge of the window.
- Needs you stays beside the chat while the right panel is open, as long as the chat has room for the Details column. Otherwise, and on pages other than a thread, it appears in the thread list.

## 2026-11-07 — Desktop tray, File menu and window titles

- On Windows, closing the window keeps T3.CodeShip running in the notification area, so agents and scheduled tasks keep working. Click the tray icon or open the app again to bring the window back, and quit from the icon's menu or File → Exit. Turn this off in Settings → Keybindings → Keep running in the tray.
- The desktop File menu has New Thread and Command Palette.
- The window title, and the browser tab on the web, name the open thread and its project, so the taskbar and window switchers show which thread is which.
- Opening the desktop app again while it runs now always shows a window, opening a new one if none is left.

## 2026-11-07 — Timeline and diff review

- Expanded tool calls have Copy command, Copy output, Run in terminal and Add output to message buttons.
- Coming back to a thread shows a "New since your last visit" line where the work you have not seen begins. It follows the server's visit mark, so it works on every device, on web, desktop and mobile.
- Older turns load as you scroll toward the top of a long thread, without clicking Load earlier turns.
- Press Cmd+Option+Up and Cmd+Option+Down (Ctrl+Alt on Windows and Linux) to jump between your own prompts. They are also in the command palette.
- The Diff panel's Turn menu shows each turn's prompt and time instead of only "Turn N".
- Mark files as viewed in the Diff panel, the same way as in pull requests. A file that changes after you mark it shows as Changed. Press [ and ] to move between files.
- On mobile, Retry under the last reply and Edit from here under your messages rewind the conversation like they do on web.
- Threads with a Retry button no longer redraw every message when you open a fold or a new event arrives.

## 2026-11-06 — Interface fixes

- Snoozed threads no longer notify you when a run finishes. A question, an approval or a failure still wakes them as before.
- Select several threads in the sidebar to archive them together, next to Delete in the right-click menu.
- Undo for settle, snooze, archive and unpin shows as a notice while the sidebar is collapsed.
- Settling or snoozing the open thread moves to the next thread that is not still working, when there is one.
- The thread hover card shows the actual error instead of "Error occurred".
- The pairing page accepts a full pairing link as well as the token.
- Error messages use a darker red that is easier to read.
- The sidebar no longer redraws itself every time you press Shift or Cmd while typing.
- On macOS, Help → Check for Updates is gone, since the app menu already has it. Help → Keybindings opens the shortcuts page.
- In Ukrainian, a thread's waiting status, usage token types and the theme editor's input field each get their own correct word, the Windows taskbar badge is translated, and scheduled task countdowns no longer mix in English. In English, that thread status now reads Question.

## 2026-11-06 — MCP sign-ins on Windows

- On Windows, an added Claude account no longer hides an MCP server from your other accounts after its own sign-in fails. Signing one account in to a server such as ThreadPage now shows the server as connected on that account.

## 2026-11-06 — Scheduled task run history and catch-up

- Each scheduled task has a Run history in its menu on the Scheduled tasks page and in the sidebar. It lists every time the task fired, including runs that failed before a thread started and times that were missed or skipped, with the reason.
- A daily task whose time passed while the computer was off or asleep now runs once when it is back, unless the next run comes sooner. Turn this off or on per task with Catch up a missed run, on web, desktop and mobile.
- With Switch accounts at usage limits on, a scheduled task whose account is out of usage starts on another account of the same provider.
- A one-machine shared task that another machine already ran now keeps its usual local time for its next run.

## 2026-11-06 — Steadier agent browser sessions

- One slow browser step in a chat no longer cuts off the agent browser for every other chat on the machine.
- A browser call made while the agent browser reconnects now waits for it instead of failing.
- Waiting for a page condition stops on time even when the page is busy, and stops at once if the tab or browser closed.
- Agents no longer see occasional connection resets when they call T3.CodeShip tools after a short pause.

## 2026-11-06 — Second Codex accounts start reliably

- Fixed a second Codex account failing to start a session when its folder held its own `secrets` folder or SQLite log files. Each account keeps its own Codex secrets, and a file that would block sharing is renamed with a `.t3-backup-` suffix instead of stopping the launch.

## 2026-11-06 — Agents see usage limits before they delegate

- Agents now see which accounts hit a usage limit, and when each resets, before they start work on another thread.
- When an agent starts a thread on a limited account, it fails right away with the reset time instead of creating a thread that stops on the limit. Auto starts on an account with usage left when Switch accounts at usage limits is on.

## 2026-11-06 — Agents hand off attachments

- When an agent starts a new thread or messages another one, it can pass along the screenshots and files already in its conversation, including ones from the thread that delegated to it. The new thread gets its own copy.

## 2026-11-06 — Desktop language update

- Fixed desktop startup getting stuck while loading language preferences, allowing the English and Ukrainian interface update to ship.

## 2026-11-05 — Choose your language

- T3.CodeShip is now available in Ukrainian as well as English. Choose it in Settings → General → Language on web and desktop, or Settings → Appearance → Language on mobile.
- System default follows your browser, computer or phone language and falls back to English.
- Dates, times and counts follow the language you choose. Agent replies, your messages and names from your projects stay as they are.

## 2026-11-05 — Needs you steps aside for the panel

- Pinned scheduled tasks always appear in the Scheduled section at the top of the thread list.
- Show or hide the Needs you box on the right with the new Needs you button at the top of a thread, or move it into the thread list from the box itself.
- Opening the right panel moves Needs you into the thread list, so the panel reaches the edge of the window.
- Long thread titles now stop before the buttons at the top of the window.

## 2026-11-05 — Choose where scheduled tasks show

- Each scheduled task has a Show in choice: None, Regular chat or Pinned. Change it from the task's menu, its row, or the thread's Automations card.
- Show all in on the Scheduled tasks page moves every task listed there at once.
- Settings → General → Show new scheduled tasks in replaces Automatically pin scheduled tasks.
- Scheduled task rows name their machine when more than one is connected, and show when a task last ran if it has no next run.
- Agents can choose where a task they schedule shows.

## 2026-11-05 — Reorder pinned tasks

- Drag a pinned scheduled task in the sidebar to change its place, or right-click it and choose Move up or Move down.
- Every device connected to the environment shows the same order, and a newly pinned task goes to the bottom.

## 2026-11-05 — Release notes in the app

- Open Release notes beside Details at the top of the window to see what changed.
- Notes stay available offline and describe the version of T3.CodeShip you are using.
- Every shipment to main now includes a dated summary of its changes, with the newest notes first.
