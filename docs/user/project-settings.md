# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

With a project selected, a provider's switch in **Settings → Providers & models** turns it on or off for
that project only, in either direction: a provider off on the machine can be used in one project,
and one on everywhere can be kept out of another. That project's model pickers follow the switch,
and no new turn there can start on a provider it turned off, including queued messages and
follow-ups from delegated tasks. A turn already running when the switch flips finishes. A delegated
task's result still lands in its parent thread, which sees it on its next turn. Reset returns the project to the
machine's setting. Every other provider setting stays per machine.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the server-setting pages, such as Threads, Source control and Worktrees, edit the selected
environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Models

**Settings → Providers & models → Models** lists every model role in one section, in this order. Each
row shows its role, the model and effort it runs, and an editor right there:

| Row                                 | What it sets                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Default for new threads**         | The model new threads start on, with **Use the last picked model** and a **Fallback model** under it. |
| **Scheduled tasks**                 | The model scheduled tasks use by default.                                                             |
| **Auto mode**                       | Auto's primary provider and the coordinator model each provider runs.                                 |
| **Titles and background text**      | Thread titles and other generated text.                                                               |
| **Commit and pull request writing** | Commit messages, pull request text, and branch or bookmark names.                                     |
| **Review guides**                   | The model that reads a pull request to write its review guide.                                        |
| **Final review**                    | Whether new threads are reviewed, the reviewers' models, and their instructions.                      |
| **Delegated tasks**                 | The model each role runs when an agent hands off work without naming one.                             |

A role you have not set shows the role it follows instead of a duplicate model: **Same as default**
for scheduled tasks, **Same as titles** for commit and pull request writing, and **Same as writing**
(or **Same as titles**, while writing is also unset) for review guides. Delegated tasks show **Same
as the thread**. Reset a row to return it to following. Titles and background text always has a model;
its reset restores the built-in one. Auto mode, Final review and Delegated tasks belong to one
machine's providers and accounts, so select a machine to edit them. The other rows follow the settings
scope picker: select a project to give it its own default model, titles, commit and pull request
writing, and review guide models. Scheduled tasks, Auto mode, Final review and Delegated tasks apply to
the whole machine.

Choose a provider and model for new threads in **Default for new threads** on web or desktop,
or **Settings → Threads → Default for new threads** on mobile. A machine with no saved choice uses the
default saved on another connected machine, with its effort level, when it has that provider;
otherwise T3.CodeShip automatically uses an available provider. Reset the web or desktop model
setting, or select **Automatic** on mobile, to restore that behavior. A saved choice stays selected
if its provider becomes unavailable; set up that provider again or choose another model.

Turn on **Use the last picked model** under the default model to start each new thread on the model you
last picked on that device, Auto included. Until you pick one there, new threads use the default
model. Scheduled tasks and threads that agents start are not affected.

Scheduled tasks have their own default in **Settings → Providers & models → Models → Scheduled tasks** on web or
desktop, or **Scheduled tasks** on mobile: Auto, a model, or **Same as default**, which
follows the model for new threads and its project overrides. A task with **Use default model** turned on,
which is how new tasks start, runs this model on every run, so changing it here changes all of
them. Turn the switch off in a task to pick a model for that task alone. Tasks an agent schedules
use the default too, unless you ask the agent to choose a model for that task. Agents
can also restore **Use default model** without losing the task's own choice. An agent
cannot set an own model and turn on **Use default model** in the same request. Before saving
an agent's model change, CodeShip checks the account and its advertised models and
options. An unknown account, unknown model or unavailable model catalog leaves the
saved task unchanged. When some tasks still run their own model, **Use default for all** under the
setting switches them over; **Undo** brings their own models back. A task that posts into an
existing thread always runs that thread's model.

When the default model's provider is out of usage, new threads start on the **Fallback model**
instead, at the default model's effort level when the fallback model offers it. A default model
picked on one account switches even while another account of that provider has usage left; choose
[Auto](./thread-sidebar.md#inspect-agent-work) as the default to move to that account instead.
Auto can be the fallback model too: new threads then start on Auto's provider and model, on
whichever of its accounts has usage left.

Auto adds a compact model brief to every top-level Auto message. It lists native Claude
models by their supported family aliases. A usage refusal with no reset holds an
account for five hours, or its shortest reported usage window when that is shorter,
even for named launches. Fresh usage checks do not lift the hold early; a completed
run on that account started after the refusal does. A limit Claude attributes to one
model family holds only that family, until its reset or a completed run of that family.
A used-up usage window without a reset holds for at most the same time, counted from when
it was first seen used up, and so does the switch to the fallback model.

## Pin and archive projects

Pinned projects come first in the project pickers: the project picker on a new thread, the
new-thread list, the command palette, the sidebar project filter, and mobile. When threads are
grouped by project, pinned projects get the top folders, even with no active threads. Pin or unpin
a project from its row in any of those lists, or press the thread pin shortcut (`mod+shift+p` by
default) on the highlighted row. **Pin project** in the command palette and **Settings →
Projects** work too. A list keeps its order while it is open, so a new pin moves up the next time
you open it.

Archive a project you are done with in **Settings → Projects**, or with **Archive project** in its
menu on the **Projects** page. It leaves the project pickers. Its threads, settings, and files stay
as they are, and archived projects still show in the Settings project list, marked **Archived**,
and in the folded **Archived** group at the bottom of the Projects page. Select **Unarchive** in
either place to bring one back. On mobile, both are in **Settings → Projects → Organize**.

A project on several machines must have every machine connected to pin or archive it.

## Worktree branch names

In **Settings → Source control & worktrees → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open the **Tasks** tab to create scheduled tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's. Choose **Once**
to run a task a single time at a date and time in your own time zone. If the
environment is offline then, the task runs when it is back.

Deleting a thread also deletes tasks that post into that thread. Tasks that start
a new thread on each run survive deletion of their previous threads.

A fixed-time task whose time passed while its machine was off or asleep runs
once when the machine is back, if that is nearer the missed time than the next
run. **Catch up a missed run** in the task's editor turns this off or on; it
starts on for daily tasks. **Run history** in a task's menu lists each time it
fired: runs that started a thread, runs that failed before one existed, and
missed or skipped times, with the reason. Select a task's **Last run** to open
that run's thread. In the mobile Tasks tab, tapping a task opens its last run;
edit it from its menu. The **Scheduled tasks** item in the side rail shows a
red dot while any task's latest run failed; it clears when the next run starts,
or when you pause the task.

You can edit, duplicate, pause, resume, run immediately, change where it shows,
or delete a task from the list. See [Choose where scheduled tasks show](thread-sidebar.md#choose-where-scheduled-tasks-show).
On web or desktop, **Move to another machine** saves a task on the machine you
pick, then deletes it from the one it was on; its run history isn't moved. A
task that posts into a thread, has a webhook URL, or is shared can't be moved.
Webhook tasks only run when their URL is called, so they can't be run
immediately.
Leaving an edited form asks before discarding unsaved changes.

## Shared scheduled tasks

A task's **Runs** choice keeps a copy of it on each of your machines:

- **Every machine** runs it on each machine, on its own schedule, in its own
  time zone. Uncheck a machine to keep the task off it; a machine you connect
  later gets the task too.
- **One machine** runs each occurrence once, on the first machine in the
  project's machine order that is online and finishes it. Each later machine
  waits a few minutes per place in the order, then asks the machines ahead of
  it. It runs the task only when none of them ran it, or their run failed, for
  example when a machine is offline or out of usage. While a machine ahead is
  still running it, the later machine keeps asking every few minutes and runs
  the task itself if that run fails or the machine stops answering, until the
  next run is due. A run you or an agent stop stays stopped. The order belongs
  to the
  project, so changing it in one task changes it for every one-machine task in
  that project.

For **One machine**, each machine needs a link to every machine ahead of it in
the order, made in **Settings → Machines & access → Linked environments** on
that machine (see [Linked environments](remote-access.md)). The editor and the
task's badge warn about a missing, expired, or turned-off link. A machine that
can't reach one runs the task anyway, so you may get an extra run but never a
missed one.

Copies sync while T3.CodeShip on web, desktop, or mobile is connected to both
machines. A machine that links to another also fetches newer copies from it
every few minutes, even with no app open. Editing, pausing, or deleting a
shared task on one machine does the same on the others; pinning and **Run now**
stay on the machine where you use them. Choosing **Only** with the machine's name
keeps the task only on that machine.

A shared task is listed once, under **On more than one machine**, with a line
for each machine: when it runs there next, how its last run went, and anything
that stops it, such as a copy that didn't sync. Its **Run history** covers every
machine.

A shared task starts a new thread on each run and can't use a webhook. It runs
in **No project**, or in the project with the same git remote on each machine;
a machine without that project shows why its copy is missing. If a task's model
isn't set up on a machine, such as another account, that machine runs its
scheduled tasks model instead and the task's row says so.

## Webhook automations

On the **Scheduled tasks** page on web or desktop, or in the **Tasks** tab
on mobile, choose **On webhook** as a task's schedule to run it whenever another
service calls its URL, such as GitHub on a new pull request or a CI job that failed. A public URL needs a
[T3 Connect](remote-access.md) managed tunnel; after you save the task, copy
its URL from the editor. Without one, the editor shows only the URL's path.
**Rotate** replaces the URL and the old one stops working.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty.

Each value reaches the agent wrapped in `<webhook-data-…>` tags and marked as
untrusted request data. This helps the agent tell it apart from your
instructions, but it doesn't guarantee the agent ignores what the text says.
Inside a value, every `$`, other currency sign and `@`, and a `/` that starts
a lone word, gets an invisible character after it, so mentions like `$skill`,
`@file` and `/command` don't act. Text copied from a value, such as an email
address or a command, carries that character too. Without a signature, anyone
with the URL can start a run with any content. A signature only proves which
service sent the request: a GitHub payload still carries text written by any
GitHub user.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. Set this
up on desktop or web; mobile keeps an existing signature check but can't turn
one on.

To run only for some requests, add **Filters**. Each one tests a value named
like a placeholder, without the braces, such as `headers.x-github-event` equals
`pull_request` or `body.action` is one of `opened, reopened`. A task runs only
when every filter matches; other requests are answered normally, logged as
**Filtered** with the first filter that failed, and start nothing. Values
compare as text, and a value that is an object or a list only passes
**exists**. Separate **is one of** values with commas; a value can't contain
a comma or start or end with a space.

To suppress repeated deliveries, set a **Duplicate request key** template, such as
`{{headers.delivery-id}}`. The same key is ignored for seven days per task.
To combine a burst, set a **Coalesce key**, such as `{{body.id}}`, and a window
of 10–3600 seconds (120 by default). One run uses the latest body, headers,
and query when the window from the first delivery closes; later requests
do not extend it. Pending windows survive a server restart. Keys must contain
request placeholders; if any placeholder is missing, or the render is empty,
that key's rule is skipped. Clear the templates to turn dedupe off.

Duplicate and coalesced log entries share a limit of 10 per task per minute.
Additional deliveries are accepted without a log entry, and coalesced deliveries
always replace the persisted payload. Coalesced updates count toward a separate
60-per-minute validation limit; exceeding it receives HTTP 429.

On desktop and web, pick **Deliveries** from a task's menu to see recent
requests and the prompt each one produced.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. To have T3 Connect keep requests instead, turn on **Hold webhooks while
offline** in **Settings → Machines & access**. T3 Connect then stores requests to a
T3 Connect URL for up to 24 hours and delivers them when the environment
returns. Leave it off if you don't want request bodies stored outside your
machine. To skip requests that waited too long, set **Skip requests older
than** on the task.

## Defaults and inheritance

Threads contains the model and workspace for new threads. Browser controls agent browser
and terminal access. Source control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Projects category, under Code, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there. On mobile, the same list is in **Settings → Projects →
Actions**, and a thread's terminal menu offers **Add action** while the project has none. Action
shortcuts are set on desktop.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts; terminal access changes apply
right away.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → Source control & worktrees** under Advanced (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Worktree location

New worktrees go in the `worktrees` folder of the T3 home directory. To put them somewhere else,
such as another drive, set **Settings → Source control & worktrees → Worktree location** to an absolute path like
`D:\worktrees` or `~/worktrees`. The setting is per machine. Existing worktrees stay where they
are, and cleanup covers both the default folder and the custom one.

## Storage cleanup

Open **Settings → Source control & worktrees → Cleanup** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after a thread settles, after
merging, or when they have no commits beyond the default branch. Set settled retention to 0 days
to remove a worktree at the next cleanup after settlement. In repositories without remotes,
unchanged-worktree cleanup compares against the branch checked out in the project workspace;
if that checkout has a detached HEAD, the worktree is kept. Only T3-managed worktrees are eligible.
Active sessions and shared worktrees prevent removal. **Keep worktrees with local changes** defaults
to **Uncommitted changes**, which protects tracked edits and untracked files but deletes ignored
files such as `.env` and build output. **Any local files** also protects ignored files other than
`node_modules`. **Edited tracked files** protects only tracked edits and allows untracked and
ignored files to be deleted. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires a merged pull request whose commits are included in the remote default
branch. A squash or rebase merge on GitHub also counts when the pull request targeted the default
branch and the worktree is still at the pull request's last commit.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Choose **Delete now** to run the enabled rules immediately. The latest results show which
worktrees were removed or kept and why, plus any failures.
Results also list folders in the worktree folder that no thread uses, with their sizes; cleanup never removes them, so remove them manually if you want.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
T3.CodeShip detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

T3.CodeShip only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Import Claude Code and Codex conversations

In **Settings → Projects**, enable **Import conversations** to bring Claude Code and Codex conversations from that
computer into T3.CodeShip. Choose an environment to set the default or a project to override it. The
project's settings page has the same switch. On mobile, use **Settings → Threads**.

While it is on, T3.CodeShip imports a project's whole history, then picks up new conversations when the
server starts, when you add the project, and every few minutes. Conversations from while T3.CodeShip was
closed appear the next time it starts. Only conversations started in a project's own folder are
imported, so add a project to manage its conversations in T3.CodeShip. Codex app chats that have no
project go to **No project** on that computer. Imported threads start settled. When you turn the
switch on, T3.CodeShip says how many conversations it brought in once the import finishes. On web and
desktop, **Show** opens the most recently active one and expands **Settled**.
Conversations T3.CodeShip already owns, and imported threads you deleted, are not imported again.
Imports follow the limits described in [Import your projects](welcome-wizard.md#import-your-projects),
except that there is no 30-day window and no per-run file cap.
