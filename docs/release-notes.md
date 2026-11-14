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
