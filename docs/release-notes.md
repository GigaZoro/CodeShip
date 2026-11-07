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
