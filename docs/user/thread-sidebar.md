# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory. Threads in the same checkout share its
branch, so T3.CodeShip refuses a branch switch there while one of them is working.

## Resize or hide the sidebar

On web and desktop, drag the sidebar's right edge to resize it. Continue left past its minimum
width to preview hiding it, then release to keep it hidden. Dragging back right before releasing
shows it again and continues resizing.

Move the mouse to the middle of the left window edge to find a handle. Drag it right or click
it to show the sidebar again. Dragging back to the edge before releasing hides the preview
and leaves it hidden. The sidebar toggle and shortcut still keep it open.

## Start a thread

On web and desktop, **New thread** opens the project picker when you have more than one
open project in the default or project-grouped sidebar. Archived projects don't count. **Shift-click** to start in
the current project, or use a project's own new-thread action. A new thread carries
your model and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.
While the sidebar is filtered to one project, the sidebar's **New thread** button
starts the thread in that project instead of asking which project to use.

On mobile, **New thread** starts in the current thread's project, or else in the
project the thread list is filtered to, or else in the last project you opened
or chose on that device. If none is available, the project picker opens. Turn
off **Settings → General → Use last project** to choose a project every time.
When you pick a project that is on more than one machine, the thread starts on
a connected one if any is connected.

When you change a new thread's project, T3.CodeShip stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.t3/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

When the work grows into something real, pick **Turn into project** from the
thread's menu. The thread's folder becomes a project where it is, so nothing
moves and the agent keeps working in the same place. Other threads in that folder
move with it. Rename the project in its settings, and use **Initialize Git** to
get branch and diff controls.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## Get back to work from a new thread

On web and desktop, a new thread's empty composer lists up to five threads to get back to,
each opening on click: first the ones that need you, longest wait first, then running threads,
latest started first, and the threads you last sent to. Recent threads follow the
sidebar's project and machine scope. The list goes away once you start typing.

## Background notices

On web and desktop, notices that need nothing from you, such as a slow request, a machine that
answered again or a clone in progress, go to **Background notices** at the top of the sidebar
instead of popping up. A dot on its button marks notices you have not opened yet. A clone that
stalls, finishes or fails still shows as a pop-up, and so does anything you can act on or undo.

The same message from the same place within a minute updates the open pop-up with a count
instead of stacking another one. **Settings > Diagnostics > Recent notices** lists which parts of
the app raised the last 200 notices in this window, how many you clicked or closed yourself, and
how many timed out.

## See what needs you

Threads waiting on you sit together under **Needs you** on web and desktop, in a box at the
bottom of the thread's **Details** column: an approval, an answer to a question, a subagent's
request, a guest's message, or a run that failed or hit a usage limit in a thread you started.
A question or failed run you snooze waits on the Snoozed shelf instead until its wake time.
A working thread whose agent has sent nothing for 10 minutes reads **Stalled**, in its row, the
thread's activity line and its **Details** status, with the time since its last event; a thread
you started that stalls also waits in Needs you. A tool that reports progress, such as a long
build, keeps it from stalling, and the next event clears it. Change the limit, or turn it off,
in **Settings → Threads → Mark stalled threads**. Failed and stalled runs in threads an agent
started, scheduled task runs included, are left to agents: they show in the thread list but don't
wait in Needs you. The longest wait comes
first, and each row shows how long it has waited and what the thread asks. Approve or decline an
approval, pick an answer to a question that offers choices, or settle a failed run, right in the
box; select a row to open its thread. When the chat is too narrow for the Details column, on pages
other than a thread, and on mobile, they appear at the top of the thread list, below scheduled
task rows. On mobile, an approval's row offers allow and decline, and a question's row its
choices, right in the list.

Agents ask you only about money: spending it, such as a paid plan, real funds, or money being
lost now. They decide everything else themselves and say what they chose. Such a question stays
open after the agent's turn ends, even in a scheduled task's run. It shows in the thread and under
**Needs you**; answer in either place, and the agent picks up from your answer. Settling the
thread, or dismissing the question, closes it unanswered.

To put one off, choose **Later** on its row in the box, or **Decide later** in the thread's menu
(on mobile, long-press the row). It moves under **Later**, below the threads that need you now,
until it asks something new; **Move back to Needs you**, or the back arrow in the box, returns it.
Threads you put off leave the Needs you counts on the Threads icon, the dock and the app icon, and
**Next thread that needs you** skips them. Later is saved with the thread, so it is the same on
every device.
It lists them from every machine and project, even when the list is filtered to one, the thread's
folder is closed, or the thread is pinned or settled. Once you answer, the thread returns to its
usual place. A failed run leaves when you retry it, settle it, or snooze it; a usage-limited run
set to resume on its own is not listed.

Triage the box from the keyboard: once a row has focus, `J` and `K` (or the arrow keys) move, `A`
approves, `D` declines, `L` puts the thread off until later, `E` settles a failed run, `Enter`
opens the thread and `Esc` returns to the chat. A hint row lists the keys while the box has focus,
and **Settings → Keybindings** lists them too. Settling shows **Undo** for 8 seconds.

Below the threads that need you, **Finished, not seen** lists threads you started that finished
since you last opened them. They don't count toward the Needs you badges. Open one, settle it with
`E`, or choose **Settle all** to settle them together, with **Undo** for 8 seconds. Mobile shows the
same section with **Settle all** at the top of the thread list.

When you come back after at least 15 minutes away and threads finished, or recovered on their own
after a usage limit reset, **While you were away** at the top of the box says how many, and how
many need you now. **Caught up** clears it until the next time you are away.

Press `Mod+Shift+U`, or choose **Next thread that needs you** in the command palette, to open each
waiting thread in turn. On mobile, the **N more need you** button above the composer does the same.
The count also shows on the **Threads** icon in the side rail, the desktop dock or taskbar icon,
and the mobile app icon. On web and desktop the window or tab title starts with it, like
`(3) Fix login - T3.CodeShip`, and drops it at zero, whatever your notification settings.

On web and desktop the rail's **Threads** count also includes money decisions waiting in
**Manual steps**. Failures share one **Problems** icon, which appears at the bottom of the rail only
while something has failed: installed providers with an error or signed out, MCP servers that failed
or need sign-in when last checked, open pull requests with failing checks or conflicts, scheduled
tasks whose latest run failed, and Manual steps when ThreadPage cannot be read. Its count is the
total; click it to see each failure and open the page that fixes it.

## Choose where scheduled tasks show

Each scheduled task has a place in the app:

- **None** keeps the task out of the thread list, along with the thread it runs in (for a task
  that starts a new thread each run, its latest one). That thread still appears under
  **Needs you** when it needs an approval or answer.
- **Regular chat** lists the task's run threads like any other chat.
- **Scheduled section** adds a row for the task in the collapsible **Scheduled** section at the
  top of the thread list, so you can watch its runs and next scheduled start. This is the default.

To file a task from **Scheduled**, right-click its row (long-press on mobile) and choose
**Move to folder**. Pick a folder, choose **New folder…**, or use **Remove from folder**.
On web and desktop, drag a task within its folder or choose **Move up** or **Move down** to
change its order. Tasks without a folder can be reordered together.

Change a task's choice with **Show in** in its menu on the **Scheduled tasks** page, in the
**Automations** card of its thread, in the right-click menu of its row, or in its menu on mobile.
**Show all in** at the top of the **Scheduled tasks** page moves every task shown there at once.
The choice is saved on the environment, so every device connected to it shows the same place.

CodeShip automatically settles chats started by a scheduled task after a successful run with no
pending work. To keep those chats in the active list after completion, turn off **Auto-settle
completed scheduled threads** under **Settings → Threads → Auto-settle**.

The **Scheduled tasks** page lists tasks from every environment this app is connected to, and
each task shows its machine and project. Machines your computer links to (see
[Remote access](remote-access.md)) that the app can't reach directly appear under **Linked
machines**, with the tasks each one last reported, even while it is offline. They are read-only
there and refresh every few minutes. To change them, add the machine under
**Settings → Machines & access**.

### Group scheduled tasks

Choose **New folder** on the **Scheduled tasks** page to create an empty folder. To add a task,
choose **Move to folder** in its menu or set **Group** in the task editor. Agents can set the
same field with `schedule_task`. Folder names match regardless of case. The page lists tasks
under a header per folder, with tasks
without one under **No group** at the end. Each header shows how many tasks the group has, its
next run, and its runs, failures and usage-limited runs in the last 24 hours. Click a header to
collapse it; each device remembers which groups you collapsed. The machine and project filter
still applies inside groups. The chats each task starts go in a sidebar folder with the group's
name; see [Put chats in folders](#put-chats-in-folders).

**Pause group** turns off every task of the group that is on, and **Resume group** turns back on
only those, so a task you had already paused stays paused. Switching a task on or off yourself
takes it out of that resume. A shared task's group and pause reach every machine, so the page asks
first when the group has shared tasks. The mobile **Tasks** tab groups tasks the same way.

**Usage** shows what each group cost and how its runs went over the selected period, under
**Scheduled task groups**. See [Usage and limits](usage.md#scheduled-task-groups).

**Show new scheduled tasks in** in **Settings → General** sets the place for tasks created from
then on. Scheduled section is the default. Changing it leaves existing tasks where they are, and
editing or running a task does not move it.

A task with a row shows whether its latest run is still working or needs your input, and counts
down to its next run, or shows when it last ran if it has none. With more than one machine
connected, the row also names its machine. Tasks that repeat on an interval also show a bar for
the time left.
Select the task to open the thread its last run used, or its settings if it has not run yet.
Right-click the row on web and desktop, or long-press it on mobile, to run the task now or
change where it shows.

Wherever the task shows, a thread it runs in shows a calendar icon in the thread list. On web
and desktop, hover it for the schedule and next run, or click it to open the task. A task that
starts a new thread for each run marks only the thread from its latest run.

## Filter the thread list

Open the sidebar’s filter menu on web and desktop, or the thread list filters on
mobile. Under **Status**, choose **All**, **Needs you**, **Working**, **Unread**,
or **Failed**. **Needs you** uses the same status rules as Projects, and **Unread**
shows completed work you have yet to read. The device remembers your choice.
Choose **All** or clear the filter to see every status again.

Choose tags in the same filter menu to show threads with **any** of those tags.
Status and tag filters can be combined. Clear the filters to return to the full list.
While a filter is on, **Settled** counts only the matches already loaded.
In **Settled** and chat folders, **Show more** reveals another batch of matches.
If there are too few matches already loaded, the press reads one more page
from each available machine at the current cutoff. A page may contain no matches.
In chat folders on web and desktop, **Show less** returns to the preview and releases the pages
that folder loaded. Changing filters also resets folder paging. If a page read fails, use
**Could not load older threads. Retry** to try it again.

## Tag threads

Open a thread’s menu, choose **Tags** (**Tags…** on mobile), then select an existing tag to add or
remove it. Choose **Add tag…** to enter a new tag of up to 64 characters on one line.
On web and desktop, select several threads to apply tags from the selection menu.
A tag already on every selected thread is removed from all of them. Otherwise it
is added to all of them.

Tags follow the thread across devices. When an environment is set to hide tagged
threads, its hidden threads stay out of the list and the app prevents applying
its hidden tags there while hiding is on.

## Sort threads

Open the thread list filters and choose **Sort by**. **Last activity** puts the
most recently updated threads first, **Created** puts the newest first, and
**Name** sorts alphabetically. Sorting works within the existing shelves and
folders. Pinned threads keep their manual order, **Needs you** still lists
the longest waits first, and **Settled** keeps the most recently settled first
because older settled threads load in that order. Select **Default** to return to the usual order and
drag to reorder active threads where manual ordering is available. The sort
choice is saved on each device.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work. The command palette offers the same
actions for the open thread: Pin or Unpin, Settle or Un-settle, Snooze, Rename, and Archive.

On web and desktop, the chat header has a pin button for the open thread; hover a pinned thread's
button to see it turn into unpin. Hover or focus an unpinned sidebar row to pin it from the row
itself, and select several threads to **Pin (N)** them together in the order you selected them. On
mobile, the thread screen's header has Pin and Unpin too.

On web and desktop, pinned threads list one line each under a **Pinned** header with their count,
like scheduled tasks. Click the header to collapse or expand the section; the sidebar remembers
your choice, and a collapsed section still shows the thread you have open. Hover a pinned row and
click its pin to unpin it.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
The **Active** boundary label appears only while dragging, as does the **Pinned** label when
there are no pins. Dropping a thread on a collapsed **Pinned** header pins it after the others. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. With a sort other than **Default**, the sheet still moves threads between sections
and reorders **Pinned**. Reordering within **Active** requires manual ordering.
The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the T3.CodeShip server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** under **Advanced** in **Settings → Providers & models →
Models**, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through T3.CodeShip can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests with checks still running, Claude monitors and `sleep` timers, and background commands or other monitors the agent
says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes or fails, and moves to
**Needs you** when it needs an approval or answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
the pinned section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project or machine

On web and desktop, open the filter button next to the sidebar search and pick **Group by**
**Project**, or set **Settings → General → Group threads**. Turn on **Group by machine** in the
same menu or under **Settings → General → Group threads by machine**. On mobile, use the **Group**
filter above the thread list or its filter menu, or **Settings → General → Group threads**.
Active threads then sit in a folder for each project, or for each machine they run on. With both,
each machine's folder holds a folder for each of its projects, so a project on two machines
appears under each. A working thread shows in its folder and in the Working section, so you can
see what is running in one place and per project. Pinned threads stay above the folders, and
Snoozed and Settled stay below them, shared across every folder. **Group by machine** is offered
once you have more than one machine. Each device keeps its own choice.

**Combine matching projects**, in the same settings, decides what counts as one project: on, the
same repository on different machines or paths is one project, with one folder and one filter
entry; off, each checkout is its own project. Machine folders still list a project under each
machine, so with them on, this mostly decides the filter and the project picker, and whether a new
thread can switch to another machine that has the project.

Click or tap a folder to open or close it. A closed folder shows how many threads it holds; a
thread that needs you is listed under **Needs you** instead. A machine you cannot reach shows
**Reconnecting**, **Offline** or **Can't connect**, with how long ago it was last seen, and starts
closed. On web and desktop, right-click its folder and choose **Reconnect** to try again now.
Machine folders keep one order: this machine first on web and desktop, then the rest by name, so a
machine going offline or reconnecting never moves. When two machines share a name, their folders
add the address. While threads are grouped, active
threads are ordered by their latest message, so you cannot move them by hand.

Pinned projects get the top folders, and an archived project's folder comes last and shows only
while it has active threads. On web and desktop, a pinned project keeps its folder even with no
active threads. Pin or unpin a project by right-clicking its folder; see
[Pin and archive projects](project-settings.md#pin-and-archive-projects) for the other ways.

On web and desktop, an open folder lists its five most recent threads. Choose **Show N more** below
them for the rest, and **Show less** to fold them again. Threads that are working, failed, hit a
usage limit, woke from a snooze, or finished since you last opened them always stay listed. Alt-click a folder
(Option-click on macOS) to open or close every folder beside it, or right-click a project folder
and choose **Collapse others**, **Collapse all**, or **Expand all**. Right-click a machine folder to
do the same for all machines or all projects. **Collapse all** and **Expand all** in the filter
menu next to the search open or close every folder at once, as do **Collapse all sidebar folders**
and **Expand all sidebar folders** in the command palette.

On web and desktop, drag a project folder up or down to reorder your projects, or right-click it and
choose **Move up** or **Move down**. The list scrolls while you hold the folder near its top or
bottom edge. Inside a machine folder, a project moves among that machine's projects, and pinned
projects stay above the rest. Projects stay where you put them: new activity never reshuffles
them. Projects you have not moved keep the order they were added in, and new projects join the
bottom.

The order is saved on the machines that have the projects, so every device, mobile included, shows
the same order in its folders, project filters, project pickers and the command palette. The
project you are in stays in its place in a picker instead of moving to the top. Folders can be
moved only on web and desktop. A project on a machine whose server is too old to save the order stays below
the projects you moved.

Use the pen button on a project folder to start a thread in that project; inside a machine folder
it starts on that machine. The pen button on a machine folder lists that machine's projects to
start in. On web and desktop, you can also right-click a project folder. **New thread** and its
shortcut start in the current project when folders are by project, and otherwise ask which project
unless only one project is open. In project folders, threads on another machine show that
machine's initial on its own colour, so two machines with the same name still look different. You can drag a grouped thread onto the composer to mention it, but not within the
sidebar.

The same menu filters the sidebar. Click a machine or project to show only its threads, or
shift-click to add more. Machines appear when you have more than one. Choosing both a machine
and a project shows that project's threads on that machine. Archived projects are not listed. A
project or machine you filter to keeps its folder even with no active threads, so you can start
one there.

### Put chats in folders

Folders hold the chats you want together, such as "Autopilot" or "Optimization". On web and
desktop, choose **New folder…** in the filter menu next to the sidebar search or in the command
palette, or right-click a chat and choose **Move to folder → New folder…**. Move a chat in with
**Move to folder** in its right-click menu, the chat's header menu, or the command palette, and out
with **Remove from folder**. With several chats selected, the right-click menu moves them all. On
mobile, open a chat's menu and choose **Move to folder**.

Folders sit at the top of the active list, above project and machine folders, and hold their
chats' active threads first and their settled ones after, so **Settled** leaves out chats that are
in a folder. **Show N more** below a folder lists the rest of its chats, loading ones settled long
ago from their machine. Pinned and snoozed chats stay in
**Pinned** and **Snoozed**, and a chat that needs you or is working also shows in those sections,
as with project folders. Folder names match regardless of case.

Right-click a folder to rename it, delete it, or move it up or down; on mobile, its **…** button
renames or deletes it. Renaming or deleting a folder
changes every connected machine: deleting it takes its chats out of it, and scheduled tasks in the
group of the same name lose their group. A folder you make stays while empty. Each machine keeps
its folders and their order, so every device connected to it shows the same list. Agents can file a chat with
`t3_thread_organize`, using `move_to_folder` or `remove_from_folder`.

A scheduled task's **Group** is the folder its chats go in, so every chat a task in the
"Autopilot" group starts lands in the **Autopilot** folder. Changing a task's group moves the chats
it already started and the chat it sends to, except those you moved to another folder yourself. See
[Group scheduled tasks](#group-scheduled-tasks).

## Mute, follow, or color-code a thread

On web and desktop, use the thread’s action menu or search for **Notifications** or **Color** in the command palette while the thread is open. On mobile, long-press its row or open **Thread preferences** from the thread header.
Under **Notifications**, choose **Mute** to silence that thread or **Follow** to
get alerts when it finishes or needs your input, even when your usual notification
settings would skip the alert. Choose **Default** to use your usual settings.
Mobile push requires notification permissions on the device and for its environment connection.

Under **Color**, pick a marker for the thread row or choose **None** to remove it.
The notification choice and color sync to clients connected to the same environment.

## When a machine is offline

When a machine sleeps or loses its connection, its threads stay in the list with the last status
it reported, dimmed, for example **Offline · Working**. That status cannot change until the machine
is back, so the time stops counting and Settle and Snooze wait too; hover a thread to see when the
machine was last seen.

With more than one machine, the bottom of the web and desktop sidebar lists them by initial. Click
it to see each machine's connection, when it was last seen, how many threads are working or need
you, its tightest usage limit, and **Reconnect**. On mobile, the title at the top names a machine
you cannot reach; pull down on the thread list to reconnect. Notifications name the project and the
machine when you have more than one of each.

## See every project

On web and desktop, choose **Projects** in the sidebar rail, or **Open projects** from the command
palette, to see all your projects side by side with their open threads. With **Group by machine**
on, they are listed under each machine. Filter to threads that need you, which here also counts
threads that failed or hit a usage limit and snoozes that woke; to threads that are working; or to
threads that finished since you last opened them. Search finds projects by name and
threads by title. Projects with no open threads move to a compact list below the others, with when
they were last active.

Each project's menu starts a new thread there and, while the sidebar groups threads by project,
opens or closes its sidebar folder. **Settle finished threads** settles the project's idle threads
in one step. Pinned threads and threads that finished since you last opened them (shown with a small dot)
are left alone, and **Undo** brings the settled ones back.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open unless its action has **Stop this action
when the thread settles** enabled in Settings > Projects > Actions. You can also set
`"stopOnSettle": true` on a `t3.json` action and import it there. Start the command through
that action so T3 can stop its terminal and child processes. Commands started through an
agent's own shell tools are managed by the provider.

When a thread has its own worktree, settling it asks first if that worktree has
uncommitted or untracked files, or commits its base branch does not have yet, so
unshipped work does not slip out of view. The base branch is the one the
worktree's branch was cut from, usually the default branch. Commits count as
merged once they or the same changes reach the base branch, for example by
cherry-pick or a rebase shipped from another worktree, or the branch's pull
request merges into it. When Git cannot read the worktree, settling says its work
could not be checked, and automatic settlement leaves the thread active until a
later check succeeds.

Automatic settlement keeps that work in view too. Before such a thread you wrote
in settles on its own, T3.CodeShip commits its changes and opens a pull request,
then settles it. With **Keep threads with a PR** on, the thread stays active with
its new pull request. Turn off **Open a PR for unmerged work** in **Settings →
Threads** to keep these threads active instead. A thread also stays active when
its pull request cannot be opened, for example in a repository without a remote.
A thread with an open or closed pull request settles once that pull request has
all of its commits and nothing is left uncommitted. Newer work goes to an open
pull request first. A thread whose pull request was closed gets no new one: it
stays active until you ship or discard that work.

A thread you never wrote in, such as a scheduled run, a subagent or a chat an
agent started, never gets a pull request this way: where a thread you wrote in
would get one, it stays active instead, because the task or agent that started
it decides how that work lands. Once you write in it from the app, it is treated
like any thread you wrote in. Messages T3.CodeShip sends for you, such as the
automatic "continue" after a network or usage-limit stop, do not count. A
subagent or side chat working in its parent's worktree leaves that work to the
parent and settles without this check, and so does a subagent whose parent is done.

You can settle or snooze a thread while its environment is offline. The thread shows
**Pending** (**Waiting to sync** on mobile), and the change is sent when the environment
reconnects. Undo, Un-settle, or Wake before then cancels it. If the thread changed there in
the meantime, the environment's state wins and your change is dropped. A thread with a
pending settle cannot be snoozed until it syncs.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it, and so do
subagents and side chats working in their parent's worktree. Its terminal closes when the
command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after seven days and settle
threads whose pull request merged. With the merge rule on, a closed pull request
settles an idle thread too; with it off, a closed pull request does not. An empty
thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Your own messages count as resuming, and so does a
message an agent sends with `t3_thread_send` or `t3 thread send`. A turn that finished
background work or a pull request watch starts on its own does not.

A subagent, including a chat an agent hands a task to with `delegate_task`, settles as soon as
its parent has its result, even with these rules turned off. One whose task failed or was
interrupted, or that ran again since, settles once its parent settles, is archived or is
deleted. A subagent that is pinned, snoozed, set to **Never**, or still working, queued,
waiting on you or running background work stays active. A settled subagent its parent picks
up again returns to the active list.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Never**. The current option is checked. Pick
**Follow settings** to return to the rules in **Settings → Threads**. While those rules are off,
a thread on **Follow settings** does not settle automatically either, except a subagent whose
parent has its result or is done. Manual settle, snooze, and
archive still work while it is set to **Never**.

Change these rules in **Settings → Threads**.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

### Settle or archive

Settle is for work that is done for now. A settled thread stays in the sidebar's Settled
section and in search, and a message to it, from you, an agent, or a scheduled task, makes it
active again. Archive is for work you want out of the way. An archived thread leaves the
sidebar and search and shows only in **Settings → Archive**, where you can unarchive or
delete it. It refuses new messages, including ones from agents and scheduled tasks, until you
unarchive it. Removing a project deletes its threads either way.

A scheduled task that posts into one thread keeps running after you archive that thread, and
each run fails. Settle the thread instead, or move or pause the task in **Settings → Scheduled
tasks**.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments by title, branch, pull request, or project.
Threads you open often or recently rank higher, and for three weeks the thread
you last picked for a query ranks higher when you type that query again.
Threads whose messages contain all your words appear below, under **In
messages**, and open at the matching message. Message search needs at least
one word of three or more letters, or two for Chinese, Japanese, and Korean.
`Cmd/Ctrl+E` opens the palette straight to your recent threads.

Put a search in double quotes, such as `"missing position files"`, to find only
titles and messages that hold those words together, exactly as typed.
On mobile, the thread list search also lists message matches and opens them at
the matching message; on an iPad with a keyboard, `Cmd+K` opens the same
palette.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise a link to the thread, which opens it from anywhere
you paste it and pastes into a composer as a thread chip (see
[sharing a thread](./prompt-links.md#share-a-thread)). To copy the thread even
when it has a PR, choose **Copy → Thread** from its context menu, or **Copy
thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `t3` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn,
or one a rejected login stopped after its agent started working, when the provider
supports native continuation; otherwise send a message to continue. Do this when
the provider reports no reset time, because nothing continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. When the limit holds only one model,
such as Claude's weekly Fable window, the thread continues sooner if its next turn runs
another model with room: Auto's model for an Auto thread, or a model you picked since. It
also continues where it stopped, within a minute, once that account takes its model again
before the reset: a later run there gets an answer, or you press **Try again**. In **Settings → Threads →
When a thread hits a usage limit**, choose **Resume when the limit resets** to
schedule limit stops by default.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Scheduled-task runs recover automatically unless their task moved on while they were
stopped: a newer run started, or the next interval or fixed time came. Runs of a task
that overlap, such as one started every 30 minutes while earlier ones still work, all
recover. Account switching, reset recovery and restart recovery leave a notice when
they skip a run. You can still resume a skipped run manually.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Turn on **Hide limited threads until the limit resets** in
**Settings → Threads** to hide limit stops by default; a thread you snoozed yourself keeps
your snooze. Choose their recovery action
separately under **When a thread hits a usage limit**: **Do nothing** keeps the
agent stopped; **Resume when the limit resets** also continues it. Providers without
a reset time offer manual retry and the normal snooze choices.

With two or more accounts for one provider, choose **Switch to another account,
else resume when the limit resets** in **Settings → Threads → When a thread hits
a usage limit**. Arrange the tie-break account order in **Settings → Providers & models**. When
an account stops a turn on a limit with a reset time, or Claude holds the turn
open until that reset, the thread avoids accounts near their limit (soft-draining)
and continues on the other signed-in account of that provider with the most
remaining quota headroom (preferring accounts with a live usage reading over
unread ones, and breaking ties by soonest weekly reset and then the saved account
order). A reset less than
five minutes away is waited out instead. An account that hit a limit is skipped
until it resets. When the provider gives no reset, CodeShip holds the account for five
hours from the refusal, or for its shortest reported usage window when that is shorter.
Five hours is the session window for Claude and ChatGPT subscriptions. A newer usage
check showing room does not shorten this hold; a run on that account that started
after the refusal and got an answer does, even while it is still working. A held Codex account
is freed early, from a hold with a reset time too, as soon as Codex itself says it may be used
again, such as after a banked reset was used; CodeShip asks Codex at most every 10 minutes. When Claude
attributes the limit to one model family's weekly window, such as Opus, only that family
is held. A run of a model in that family that got an answer lifts it early; a run of
another model, or a newer usage check, does not. Agent launches (`t3_thread_launch`,
`delegate_task`, `create_threads`), Auto and named, respect the hold; a thread you create
in the app is not refused. Used-up usage windows still block until the last of them
resets. A used-up window that reports no reset blocks for at most the same hold, counted
from when CodeShip first saw it used up. A Codex account that Codex says may not be used now
is skipped, even while its meters show room, until its fullest usage window resets. If none is free, the thread waits as above, and moves to the first
account that gets usage back unless you stop it, snooze it or cancel its auto-resume; a thread
hidden by **Hide limited threads until the limit resets** moves too, with or without
**Resume when the limit resets**, and shows again. It moves when that account's last
limit ends, whether a reset or a hold, with no usage check needed. Each provider is one account: a provider
signed in to an account another provider already uses is unavailable until you
sign it in to a different account. Some providers' terms forbid using extra
accounts to get around limits. With this on, a scheduled task whose account has hit
its limit avoids soft-draining accounts and starts its new thread on the other
healthy account whose weekly limit resets soonest (breaking ties by remaining
headroom and then the saved account order), and
its **Run history** says which account it used and why. **Usage → Limits** shows which
account a limited thread continues on right now. When no other account has room, a
thread waiting on an account whose banked reset was just redeemed continues there; see
[Track subscription limits](usage.md#track-subscription-limits). When an
account's login is rejected before the agent does any work, the thread sends its message
again on the healthiest other signed-in account with usage left (avoiding soft-draining
accounts and preferring the most remaining headroom, then soonest weekly reset and
the saved order), right away or as soon as one gets usage back within a day.

An account that must sign in to an MCP server again (such as ThreadPage, shown as a
manual step on the provider) would start the chat without that server's tools. With
account switching on, Auto, scheduled tasks and agent launches therefore prefer an
account whose sign-ins are in place: a scheduled task that names such an account
starts on the best other account with room and none to redo, an Auto chat moves
the same way, and a delegate whose parent chat runs on such an account starts on
another one. When every account needs a sign-in, the chat stays where it is. Plugin
servers and servers that can't be signed in to from CodeShip don't count.

An account whose login Codex, Claude or Muse Code rejected shows as signed out in
**Providers** and **Manual steps**, and Auto and scheduled tasks skip it until you sign in
again. With account switching on, a chat that failed this way in the last day, before its
agent did any work, starts again with the same message on the next account of that
provider. With **Resume when the limit resets** (alone or with switching), a chat that failed
this way in the last day and stayed on its account continues there once that account reads
signed in again: after you sign in, after another chat on it gets an answer, or after a
restart. It sends the message again when the agent did no work, and asks it to continue
otherwise. By hand, press **Resume** in an empty composer when the agent had started working,
or send the message again when it had not.

**Auto** picks the model and the account for you. Set it up in **Settings →
Providers & models → Models** on web or desktop: pick a primary provider under **Auto mode**, and
choose the coordinator model and effort for each provider. The list offers the models of every
account of that provider that can run on this machine. Auto uses these choices as the ceiling for the
coordinator, starting light requests (short lookups, utility slash commands, and tiny mechanical edits) on a faster model at low effort and tuning effort per turn without downgrading a thread's model once it upgrades. Then pick **Auto** at the top of the model picker, or turn on **Auto** under
the default model in settings for new threads. A scheduled task's model can be Auto
too, and an agent you ask to start a thread in Auto, or `t3 thread start --auto`,
starts it there. A new thread starts on the first account in the primary provider's account
order that can run in its project and has its coordinator model. With account switching enabled in **Settings → Threads**, a new Auto thread avoids soft-draining accounts and starts on the healthy
signed-in account with the most remaining quota headroom (preferring accounts with a live usage
reading over unread ones, and breaking ties by soonest weekly reset and then the saved account
order), or, when none has room, on the signed-in one whose limit ends
first, and switches accounts at usage limits. Once started, an Auto thread stays on its current
account to preserve prompt caches unless it hits a hard limit, would spend prepaid credits, or
needs an MCP sign-in. A scheduled task on Auto avoids soft-draining accounts and starts its new
thread on the healthy account whose weekly limit resets soonest (breaking ties by remaining
headroom and then the saved account order), so usage that would reset unused
is spent first. A thread whose account signed out moves the
same way on its next message. The turn a
finished background command starts stays on the account that ran the command,
because only that session has its result; if that account is out of usage, the
thread moves on at that limit as described above. A thread that
already ran stays with its provider and runs that provider's coordinator. Changing
a coordinator model moves Auto threads to it on their next message. Picking a model
in the picker turns Auto off for that thread.

On Claude and Codex, the coordinator does small requests itself. For larger requests,
it sees usable models from both providers and chooses the best model for each task,
using cheaper capable models for straightforward work. It uses subscription accounts enabled for the project, skipping
accounts at their usage limit, including exhausted usage windows even before a turn
fails. A limit on one model family excludes only that family. Each model uses the first
account in failover order that can run it; native subagents use the coordinator's
own account. The short model list points the agent to the full catalog when needed.
For non-trivial code changes, the coordinator reviews the diff itself and requests an independent
review in a fresh chat (skipping independent review only for trivial, low-risk edits such as typos, docs, or comments; never auth, data, money, or concurrency changes). Each review uses its provider's Auto model and effort from Settings,
with the options that model still offers. The independent review runs on the other provider
while one of its accounts can run that provider's Auto model, and on the coordinator's own
provider when none can, or when the other's reviewer fails to start. When no account can run a
reviewer, the coordinator's own review is the only one, and its report says so.
When the other provider cannot run, it delegates routine work to cheaper models of
its own provider.

To run delegated work on other models, set **Delegated tasks** in **Settings →
Providers & models → Models** on web or desktop. Each role, such as implementation or review, can
have its own model, including Auto. When an agent hands off a task
without naming a model, the task runs on the model set for its role; unset roles
use the thread's model.

**Final review** has other models check what a request changed. Add reviewers
under **Final review** in **Settings → Providers & models → Models** on web or desktop, and turn on
**Review new threads** to review every thread. Turn it on or off for one thread
from the thread's menu on web and desktop, or its settings sheet on mobile. After
a request you send changes files, the thread's agent starts one read-only review
task per reviewer, then checks their findings and fixes the ones that hold up.
Those fixes are not reviewed again. **Review instructions** are added to every
reviewer's brief. Reviews use turns on the reviewers' accounts. A reviewer set to
Auto runs where Auto mode starts a new chat, and on its saved model while Auto mode
is off.

On web and desktop, use **Agents** to follow work delegated to subagents. Click
a subagent there or on its conversation card to open it in the right panel,
beside the thread you are in. See
[Open a thread beside the one you are in](#open-a-thread-beside-the-one-you-are-in).
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.
Before archiving the parent, wait for its delegated tasks to finish or cancel them.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

A finished turn's tool calls fold into one summary row, such as "Worked for 8m · 14 tools ·
6 files · 2 failed", so its final answer is in view; select the row to expand it. **Fold
finished work** in **Settings → Chat & diffs** folds every finished turn (**Always**), every
turn before your latest prompt (**Older turns**, the default), or none (**Never**). The turn
still running and a turn that failed stay open. Mobile folds every finished turn.

When you come back to a thread, a **New since your last visit** line marks where the work you
have not seen begins, and says what changed meanwhile, such as "2 turns · finished · PR #88
opened". On web and desktop, a dot on the conversation minimap marks the same place. The line
follows the visit mark the server keeps, so reading a thread on one device
moves it on the others. Older turns load as you scroll toward the top of a long thread; **Load
earlier turns** loads them right away. Press `mod+alt+arrowup` and `mod+alt+arrowdown` to jump
between your own prompts.

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and T3.CodeShip running. Stop needs terminal
access to the environment and is not available on Windows.

In the desktop app, the card can also open a ChatGPT dot or Claude Duet in the
browser panel. A browser profile holds one account's sign-in, so add one profile per
account in **Settings → Browser & devices → Browser profiles** and sign in to ChatGPT or
Claude there. Then pair each assistant with its profile under **Web assistants**
on the same page. Duet opens at claude.ai, where Anthropic hosts it.

The Details column is closed until you open it with **Details** in the chat header; that choice
holds for every thread. While it is closed, the header shows the thread in one line: the machine,
the branch, how much changed and the pull request, plus failing checks and the context window once
it passes 75%. Select that line to open the details over the chat; Esc closes them. A new thread
keeps its column open to choose where it runs.

The thread details card shows what is going on rather than a set of buttons. At the top, once a
thread has started, a summary names the machine, the branch and its pull request, and how much
changed; select it to show the workspace and Git controls, and again to fold them. They are folded
whenever you open a thread. **Agent status** shows whether the agent is working, waiting for you
(its own request or a subagent's approval), waiting on another thread or a background task,
stopped, reverted or idle, how long the run has taken, the model
it uses, and what it is doing now, with the full command it runs. Below it
sit the context window, the agent's to-do list for the turn it is on, and lineage. Usage limits,
side chats, **Your prompts**, **Machine load** (CPU, memory and disk of the machine the chat runs
on), servers, automations, editor and script buttons are there to turn on. **Your prompts** lists the messages you sent, as far back as the conversation has loaded; the
one on screen is marked, and selecting one scrolls back to it. A new thread shows only the controls
for choosing where it runs: the environment and the branch.

**Ask the agent** sends a common request
as your message: commit and open a pull request, run the tests, or review the changes. Add your own
requests, and set their order, in **Settings → Chat & diffs → Ask the agent**; the command palette
lists them all as **Ask the agent** items for the open thread. While the agent is working, the
request waits until it finishes. If you are writing a message, the request is added to it instead,
for you to send.

To choose what the thread details card shows, right-click the card or open
**Settings → Chat & diffs → Thread details**. **Essentials** is the standard set, **Review** keeps
the branch, changes and Git actions, and **Debug** shows everything. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts.

## Open a thread beside the one you are in

On web and desktop, a subagent, a side chat, and a
[thread on a linked machine](remote-access.md#read-a-linked-machines-threads)
all open the same way. Click one to open it as a tab in the right panel, so the
thread you are in stays in view. Hold ⌘ (Ctrl on Windows and Linux) while you
click, or middle-click, to open it in the main view instead. With the keyboard,
Enter and ⌘/Ctrl + Enter do the same. Right-click for **Open in side panel** and
**Open in main view**.

To make the main view the place a plain click opens them, set **Settings → Chat →
Open subagents and side chats in** to **Main view**. The modifier then opens
the side panel.

From a tab, **Open in main view** at the top of the tab, or in the tab's
right-click menu, moves it to the main view. The bottom of the view depends on
the thread: a side chat or a subagent you delegated has a composer, a subagent
the agent started is read-only, and a thread on a linked machine is read-only
with **Connect to interact**.

Other thread links open in the main view as before.

On mobile these threads open in the inspector on layouts that have one, where
Maximize fills the screen, and full screen everywhere else.

## Side chats

A side chat lets you ask a question about a thread without adding to it. It starts
with what the thread knows, and the thread keeps working while you ask.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also press `mod+;`, choose **Side chat** from the **+** menu in the right panel, or run **Start side chat** from the command palette. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details, where it opens
[like a subagent does](#open-a-thread-beside-the-one-you-are-in).

To read an existing thread alongside the current one, right-click its sidebar row and choose
**Open in side panel**, or Alt-click (Option-click on Mac). In the command palette, highlight a
thread and press **Alt+Enter** (**Option+Enter** on Mac). Choose **Open in main view** to move
it out of the panel. Use `mod+shift+t` to reopen a closed tab. Opening a file, browser tab, pull
request or side chat from a thread in the side panel moves that thread to the main view with it
open.

A side chat works in the same folder as the thread and starts with the permissions,
model, and reasoning level shown in the thread's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Add to chat** at the top of the side chat, or type
`@` and a word from its title in the thread's composer. The thread's message gets a
link to the side chat, and the agent reads as much of it as it needs. This works
while the thread is busy, once you have sent a message in the side chat. An agent on
an external OpenCode server cannot read the link, so put the details in your message
instead.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats. Archiving a thread also archives its side chats and stops their work, and
unarchiving the thread brings them back.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze → Edit**.

To bring back the thread you archived last, press `mod+alt+shift+e` or choose **Reopen last archived thread** in the command palette on web and desktop. It
unarchives the most recently archived thread on any connected machine and opens it.

Archived threads are not a Settings page. Open them from **Archived threads** in the thread list's filter menu, **Open archived threads** in the command palette, or **View archived** in **Settings → Threads → Behavior**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early for an approval,
a new question, a failed run, or a message or answer you send. You can snooze an existing
question and answer when the thread wakes; the question stays unanswered.
