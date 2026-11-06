## 2026-11-06 — Steadier agent browser sessions

- One slow browser step in a chat no longer cuts off the agent browser for every other chat on the machine.
- A browser call made while the agent browser reconnects now waits for it instead of failing.
- Waiting for a page condition stops on time even when the page is busy, and stops at once if the tab or browser closed.

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
