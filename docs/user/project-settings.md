# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values. When a connected machine follows
[shared settings](remote-access.md#shared-settings), a shared setting saved for all environments
goes only to the machines that follow, including offline ones when they are back.

Choose a project to override settings for it on the selected environments. A layers icon beside
a server row's title appears when the value comes from somewhere other than the built-in default:
the environment, a project override, the repository's `t3.json`, or an administrator's policy.
Click it to see that chain on every selected environment. An override can
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
follow-ups from delegated tasks. A turn already running when the switch flips finishes. When the
agent's own background work later wakes it there, such as a background task finishing, its session
is closed instead of left working with no turn. A delegated
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
even for named launches. Fresh usage checks do not lift the hold early; a run on that account started after the
refusal that got an answer does. A limit Claude attributes to one model family holds only
that family, until its reset or until a run of that family gets an answer.
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
starts on for every fixed-time task, daily, weekly, or on chosen weekdays. **Run history** in a task's menu lists each time it
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

## Check before running

A task that polls for work, such as "review open pull requests", starts a full
chat on every run even when there is nothing to do. **Check before running** in
the task's editor takes a command that T3.CodeShip runs first, on the machine
that would run the task, in the project's folder:

| The command exits with                         | What happens                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0                                              | The chat starts as usual.                                                                       |
| 10                                             | Nothing starts. **Run history** lists the time as skipped, and the task's row shows the reason. |
| Anything else, no answer in time, cannot start | The chat starts anyway, and **Run history** says the check failed.                              |

The reason is the last line the command prints. If that line is JSON with a
`reason` field, such as `{"needsRun": false, "reason": "No open pull requests"}`,
the field is used.

The command is one program with its arguments, for example
`node ~/scripts/has-work.mjs --project app`. It does not run in a shell, so the
same text works on Windows, macOS and Linux: quotes group words, a word that
starts with `~/` is under your home folder, and pipes, redirects, `&&` and
variables are not available. Put those in a script and run the script. The
command gets the environment an agent's shell gets on that machine and must
answer within the time limit, 60 seconds unless you change it (600 at most).

Things to know:

- The check runs without asking for approval, whatever the task's permission
  mode. Only an agent in a chat with Full access (not in Plan mode) can set one,
  or change or delete a task that has one, and a managed policy that forbids
  Full access turns checks off.
- Anyone who can change the files the command runs can change what it does.
  Keep a check script outside the project folder when agents with less than
  Full access work in that project.
- **Run now** starts the chat without running the check.
- Webhook tasks have no check; their filters decide which requests run.
- On a shared task the same command runs on each machine. For **One machine**,
  a time one machine skipped for no work counts as done, so the next machine
  does not run it, and its **Run history** says that machine found no work. A
  machine on an older T3.CodeShip has no checks and always starts the chat.
- Moving or duplicating a task to a machine on an older T3.CodeShip would drop
  its check, so the editor asks you to remove it or pick another machine.
- **Run history** keeps the last 10 skipped times apart from the last 50 runs,
  so a task that skips often does not push its real runs out.
- Agents set it with `schedule_task` (`runCondition`) and read it, with the last
  skipped time and its reason, from `list_scheduled_tasks`.

### Read and write ThreadPage from a check

A check can use this machine's [ThreadPage](threadpage.md) connection without
seeing its token. While the check runs, it has two environment variables:
`T3CODE_THREADPAGE_URL`, an address on this machine's T3.CodeShip server, and
`T3CODE_THREADPAGE_TOKEN`, which works only until the check ends. Send the token
as `Authorization: Bearer <token>`.

| Request                                                                                                                        | Answer                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET $T3CODE_THREADPAGE_URL/threads?folder_id=<folder id>`                                                                     | 200 `{"threads": [...]}`: the folder's active threads, each with `id`, `title`, `description`, `status`, `status_name`, `revision`, `last_activity_at`, `url`. |
| `POST $T3CODE_THREADPAGE_URL/notes` with `{"thread_id": "…", "markdown": "…"}`                                                 | 201 `{"note_id": "…", "url": "…", "operation_id": "…"}`.                                                                                                       |
| `PATCH $T3CODE_THREADPAGE_URL/threads/<thread id>` with `{"expected_revision": <revision>, "description": "…", "status": "…"}` | 200 `{"revision": …, "status": "…", "operation_id": "…"}`: the thread's revision and status after the change.                                                  |

Add `"operation_id"`, a UUID, to a note or a thread change to retry it safely:
ThreadPage makes each change once per id. Adding a note to a thread needs
ThreadPage Pro; on other plans ThreadPage refuses it with `pro_required`.

A thread change sets its description (`""` clears it), its status (`active`,
`waiting`, `done` or another status key a listed thread shows), or both.
CodeShip reads the thread right before changing it and sends the change only
while it is still at `expected_revision`, the `revision` the check read from the
folder list; otherwise it answers 409 `stale_revision` with the thread as it is
now in `thread`. ThreadPage itself takes no revision, so a change made between
that read and the write can still be overwritten. A retry with the same `operation_id`
and body whose first try already landed answers 200 instead; a different body
under that id is refused with `operation_id_reused`. Changing a thread needs
**Can edit and organize** access.
Other answers:

- 400 `invalid_request`: no folder, a note body that is not that JSON or is over
  64 KiB, or a thread change without a thread id, `expected_revision`, or a
  description or status.
- 401 `unauthorized`: the token is missing, wrong, or its check has ended.
- 503 `not_connected`: this machine has no ThreadPage token. Save one in
  **Settings → Threads → ThreadPage**; adding notes needs **Can add notes**
  access.
- 502 `threadpage_failed`: ThreadPage refused or did not answer, or the folder
  has more than 500 active threads, more than a check can list. `status` is
  ThreadPage's HTTP status, `code` its error code, such as `write_not_allowed`,
  and `retry_after` the seconds to wait when it limits requests.

For example, a Node check that starts the chat only when a folder has a waiting
thread:

```js
const response = await fetch(
  `${process.env.T3CODE_THREADPAGE_URL}/threads?folder_id=${process.argv[2]}`,
  { headers: { Authorization: `Bearer ${process.env.T3CODE_THREADPAGE_TOKEN}` } },
);
if (!response.ok) process.exit(1);
const { threads } = await response.json();
if (!threads.some((thread) => thread.status === "waiting")) {
  console.log(JSON.stringify({ needsRun: false, reason: "Nothing is waiting" }));
  process.exit(10);
}
```

## Prompt from a file

A task can read its prompt from a file in its project's git repository instead
of keeping its own copy. Under **Prompt** in the task's editor, choose **Read
from a file** and give the file's path from the repository's root, such as
`automations/daily.md`.

- Each run fetches the default branch of the project's remote, usually
  `origin/main`, and reads the file there. A change pushed to that branch
  reaches the next run on every machine; edits that are not pushed are not used.
- Saving reads the file once, so a wrong path is refused right away. The editor
  shows the text the last read found and the commit it came from.
- A run that cannot read the file, because it is missing or empty, fails, and
  **Run history** names the file and the branch. It never runs text an earlier
  read found. For **One machine**, the next machine in the order tries.
- When the remote can't be reached, as right after the machine wakes, a
  scheduled run waits for the network and reads again, on the delays stopped
  chats resume on. It fails when the network is not back after 5 minutes, or
  the read still fails once it is, and **Run history** says which, with the
  step Git was stuck on. **Run now** does not wait.
- Anyone who can push to that branch decides what the task does, with the
  task's permissions.
- A shared task carries the path, and each machine reads the file through its
  own checkout of the project.
- Webhook tasks fill their prompt from each request, so they can't use a file.
- Moving or duplicating a task to a machine on an older T3.CodeShip would
  replace the file with the text it last read, so the editor asks you to use
  that text or pick another machine.
- Agents set it with `schedule_task` (`promptFile`, or `null` to type the prompt
  again) and read it, with the last read, from `list_scheduled_tasks`.

## Skip runs while accounts are out of usage

A scheduled run does not start when every account it could use is out of usage:
the account its model runs on, or, with **Switch to another account, else resume
when the limit resets** on, every account of that provider. **Run history** lists
the time as skipped and says until when the accounts are limited; the task's run
count and last run do not change. A **Once** task moves to that time instead.

- A task that hands work to other providers, such as a Claude task that
  delegates to Codex, names them under **Hands work to** in its editor. Its runs
  are also skipped while every account of one of those providers is out of
  usage.
- T3.CodeShip reads a limited account's usage again at most once an hour, so a
  limit that ends early frees the next run.
- A shared task set to **One machine** leaves a time it skips this way to the
  next machine in its order.
- **Run now** and webhook runs always start.
- Agents set it with `schedule_task` (`delegateProviders`).

## Limit how many runs work at once

A task that starts a new chat for each run skips a scheduled time while as many
of its runs as its **Live runs** limit allows are still working. The limit is 1
unless you raise it in the task's editor (up to 10). A run is working while its
chat runs or waits, including one a restart cut that has not continued yet, and
while a task its chat delegated to another agent still runs. **Run history**
lists the time as skipped, and the task's run count and last run do not change;
the next time after a run finishes starts as usual.

- A chat in which nothing has happened for 2 hours on Claude, or 5 hours on
  other providers, including one waiting for an answer, has stalled and no
  longer counts as working. Work in a delegated task it waits on, or in the
  tasks those wait on, counts as something happening, and a chat waiting on a
  task that runs on another machine never counts as stalled. The next time
  stops the chat and its delegated tasks, and **Run history** marks that chat's
  run as failed with the reason.
- In a task with Full access, when the provider still asks to approve a step
  (such as Claude editing its own settings), in the chat or in a delegated task
  with Full access it started, the step is declined, because
  nobody is watching to approve it. The agent finishes the rest and says what
  still needs you. A step in work you started yourself, such as a message you
  sent into one of those chats, still waits for you.
- A task that posts into one thread queues behind that thread's turn instead.
- A shared task set to **One machine** counts its working runs on all of its
  machines. A stalled chat counts on none of them: the machine it runs on stops
  it at the next time, even while it waits its turn.
- **Once** tasks, **Run now** and webhook runs always start.
- Agents set it with `schedule_task` (`maxLiveRuns`), and `list_scheduled_tasks`
  shows how many runs are working.

## Shared scheduled tasks

A task's **Runs** choice keeps a copy of it on each of your machines:

- **Every machine** runs it on each machine, on its own schedule, in its own
  time zone. Uncheck a machine to keep the task off it; a machine you connect
  later gets the task too.
- **One machine** runs each occurrence at most once, on the first machine in
  the project's machine order that is online. Each machine waits a few minutes
  per place in the order, asks the other machines whether one has the time, and
  claims it on every machine it reaches. It runs the task only when none of them
  has it, or their run failed (for example when a machine is offline or out of
  usage), and more than half of the machines recorded its claim. While another
  machine is still running it, the machine keeps asking every few minutes and
  runs the task itself if that run fails, until the next run is due. A run you
  or an agent stop stays stopped. A fixed time is the same time on machines in
  different time zones, each at its own local hour, so it still runs once. The
  order belongs to the project, so changing it in one task changes it for every
  one-machine task in that project. A machine missing from the order adds
  itself and its linked machines, sorted by their ids. Until a change to the
  order has reached every machine, which takes a few minutes, two machines may
  both run one time, so change it away from a run's time. Agents read the order
  from `list_scheduled_tasks` (`machineOrder`) and set it with `schedule_task`
  (`machineOrder`).

For **One machine**, link each machine to every other machine in the order, in
**Settings → Machines & access → Linked environments** on that machine (see
[Linked environments](remote-access.md)), with more than read-only access. The
editor and the task's badge warn about a missing, expired, or turned-off link.
When too few machines answer, the time runs nowhere rather than twice, and
**Run history** says so: with three or more machines, more than half must
reach each other; with two, the first runs alone and the second runs nothing
while the first is off. Remove a machine you no longer use from the order, or
it still counts.

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
`t3.json` actions can be imported there. A project that has no action list of its own still runs the
`runOnWorktreeCreate` action its `t3.json` declares when a worktree is created, so chats started by
agents or scheduled tasks get their setup too. On mobile, the same list is in **Settings → Projects →
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

Open **Settings → Maintenance & about → Storage & cleanup** to enable automatic cleanup on one machine or all connected
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

**Remove old tool output** removes command and tool output from settled and archived chats
after the chosen number of idle days (7 by default; turn it off to keep all output). The steps
stay in the chat and show "Output is no longer available." A chat keeps its output while it or
any fork of it is open or pinned. The Database section shows how large each machine's database
is.

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
