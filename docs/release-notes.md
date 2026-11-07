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
