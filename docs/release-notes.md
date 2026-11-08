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
