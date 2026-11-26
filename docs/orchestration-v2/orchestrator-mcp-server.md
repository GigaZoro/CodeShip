# CodeShip orchestrator tools

See [01 · architecture](../internals/01_architecture.md) for the shared architecture and procedures.

## `orchestrator_capabilities`

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task;
- `limitedUntil` for each account a usage limit stopped: the latest reset it
  reported; and
- feature flags for polling, cancellation, and batch thread creation.

`delegate_task`, `create_threads`, and `t3_thread_launch` refuse a new thread
whose first turn would start on such an account, Auto routing included, before
anything is created. A retry of an accepted launch still replays. Only a
provider's usage-limit failure marks an account; a usage window at 100% does
not, because extra usage can still run there.

## `delegate_task`

Set `target.options` using the options returned by `orchestrator_capabilities`, such as
`{effort: "max"}`. A child on its parent's provider instance and model, named by slug or alias,
inherits the parent's options that model still offers, and given `options`
override them one by one (`[]` or `{}` clears them; an option given twice fails
the call). An alias can name another model in a linked environment, so a child
there inherits them only on the parent's model named by its slug in this
environment, and an omitted model is sent as that slug. A role's model whose
account is gone, or no longer offers it, falls back to the parent's; one that
rejects the given options fails the call.

A child whose target names no provider, model or options runs as its parent
does, or on its role's model from Settings, and stays Auto when that selection
is Auto. A role's model set to Auto starts where Auto mode starts a new chat,
and on its saved model while Auto mode cannot run, as the Settings picker shows
it. Auto picks its own provider, account, model and options when a child
starts, so a target that names any of them runs exactly as named instead, even
in an Auto chat. Auto's saved options keep only the values the child's model
still offers. `auto: true` starts the child on Auto mode's pick, as for
`create_threads`; it cannot be combined with `target` and fails with
`auto_mode_unavailable` while Auto mode is off. `auto: false` turns Auto off
for the inherited selection: the child starts on that account and leaves it, as
any child that is not Auto does, only when usage-limit failover moves it to an
account with room, possibly on the other provider. A child in another project's
worktree uses that project's accounts and Auto settings. A child of an Auto
chat on a linked machine, whose target names only where it runs, stays Auto
there on that machine's Auto settings; while Auto mode is off there, the
refused launch made no thread, so the same request starts it on the parent's
model.

For local delegation, use `isolation: "worktree"` for a separate prepared checkout from
the parent's commit; the default `"shared"` uses the parent's checkout. Uncommitted parent
edits are not copied. A linked-environment target (`target.environmentId`) runs in the remote
project's checkout and rejects worktree isolation. To launch an isolated thread there, use
`t3_thread_launch` with `environmentId` and a worktree `workspaceStrategy`.

Each independent delegated review round uses a new `delegate_task` call with the
original brief, prior findings, responses, and unresolved objections. Track each
reviewer by its own `taskId` and give each reviewer call its own
`clientRequestId`, reused only to retry that call: parallel reviewers share a
round, and a repeated key returns the first reviewer instead of starting another.
The parent thread counts its `role: "review"` tasks in rounds, and the result's
`reviewRound` reports the task's round. Reviewers started while the latest round
is unanswered join that round, so parallel reviewers of one diff share it. A
review that would be round 4 is refused with `review_round_limit`, quoting the
review rule that a third round still finding blocking defects means re-plan or
split the change. A call with `newReviewPart`, one line saying how the change
was re-planned or split, starts round 1 of a new part instead. While that round
is unanswered, more reviewers of the part join it by repeating the same line or
leaving `newReviewPart` out; a different line starts another part. A round is
answered once a run in one of its reviewers' threads completes; a failed or
cancelled reviewer leaves it open for a retry, and follow-up work in a
reviewer's thread is not a round of its own.

## `t3_command_run`

Runs a shell command that ends (tests, a build, an install, a push, a deploy, a long script) as an app-owned task of
the calling thread, started outside the provider and the server so a restart does not cut it.
It takes `command`, an optional `cwd` (the thread's checkout by default), `label`,
`timeoutMinutes` (default 60, at most 720), and `shell`, whose one value `bash` runs the command
unchanged in bash on every OS: the user's shell when it is bash, else `bash` from `PATH`, and Git
Bash on Windows. It returns the `taskId`, the log path and the timeout. The command gets the whole environment the calling agent's own shell commands get in
the thread's folder: the host environment without the server's own variables, then the
variables set on the agent's provider account, which every provider starts its agent with, then
its provider's rules. For Claude that is
the `env` of the settings its launch arguments load, its organization's settings last; for
Codex it is the whole `shell_environment_policy` (`inherit`, the default excludes, `exclude`,
`set`, `include_only`, `filters`), so a policy also removes variables, then Codex's own last
steps: its launch context, such as `NODE_REPL_AUTH_TOKEN`, goes even when the policy sets it,
a Windows command without `PATHEXT` gets Codex's default, and
`CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS` is `1` exactly when the
`apply_patch_preserve_line_endings` feature is on (from `configRequirements/read` when a managed
requirement pins it, from the folder's config otherwise). `T3CODE_THREAD_ID` comes
last. T3.CodeShip's own launch variables, such as the account folder from its settings, and
those a CLI adds for itself, such as `CODEX_THREAD_ID`, are not shell settings and stay out;
because Codex replaces `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_VERSION` and
`CODEX_PERMISSION_PROFILE` with its own session's, an inherited one does not reach a Codex
thread's command either.
Claude's settings files and its `--settings` launch argument go through the SDK's
`resolveSettings`, `--settings` as the project settings of a scratch folder only the server's
user can open, since `resolveSettings` takes no flag tier; so settings Claude Code rejects for
one invalid field add nothing, as in Claude Code. Full access restrictions, tool search and the
subagent prompt cache TTL read this same result, never a raw file, so none of them counts a
setting Claude Code drops. `--settings` is judged as the object Claude
Code receives in the calling thread's active run (`claudeFlagSettings`): the launch argument's
in the SDK's shape, with the run's model selection, the compact window and the thinking
summaries switch replacing their fields. A launch leaves `fastMode` as a live switch to the
same selection would, so whether Claude Code accepts that object never depends on the
selections a retained query ran before. For an account whose config folder is
not the server's, that runs in the Claude history worker, because `resolveSettings` reads
`CLAUDE_CONFIG_DIR` from its process. On POSIX the launcher keeps the host environment, whose
`PATH`, or the shell's default search when it has none, finds the tools of the wrapper that
records the end, and starts the command through
`env`, which removes each variable the command must not get and sets its `PATH`. The variables
bash, the `/bin/sh` of macOS and many Linux systems, reads as its own options and functions
(`SHELLOPTS`, `BASHOPTS`, `EXECIGNORE`, `BASH_FUNC_*`) never reach the wrapper's shell and are
set by `env` too, so an option such as `errexit` cannot stop the wrapper recording the end; no
other value reaches an argument. On Windows, where a later spelling of a name replaces any other case of
it, the launcher passes the command's whole environment to `Win32_Process.Create` over stdin,
never through a file, as a Unicode block (`Create_Unicode_Environment`), so a value outside the
host's ANSI code page survives. T3.CodeShip merges only spellings that differ in ASCII case, as
Codex's `set` does, and moves each name it sets to the end; Windows folds other letters by a
table only it has and that can change between versions, so the launcher keeps the last of the
spellings Windows reads as one name with .NET's `OrdinalIgnoreCase`, and `Straße` and `STRASSE`
stay two variables. The wrapper is a hidden PowerShell process and reads no
variable: it takes cmd and PowerShell from the system directory, so neither the agent's `PATH`
nor a `SystemRoot` its settings move or drop can change which ones run. It runs the command in
a console of its own with no window and writes the exit status once the command ends, so a Ctrl+C,
Ctrl+Break or close event in that console can end the command but never the wrapper. The
command reads its input from `NUL`, as from `/dev/null` elsewhere, so a command that reads input
ends instead of waiting on a console nobody can type in. A `shell: "bash"` command goes unchanged
into a file, and its script starts Git Bash's `bash.exe` through `Process.Start` with that file's
path, in double quotes and with forward slashes, as its only argument: PowerShell 5.1 drops every
`"` inside an argument it passes to a program, while Cygwin reads a double-quoted path literally
and a forward slash never as an escape. Any other command's script first makes `bash` and `sh`,
with or without `.exe`, PowerShell aliases of Git
Bash's and not System32's `bash.exe`, which is WSL's and has no node or `C:/` paths. An alias,
unlike a function, passes every argument as written, `--` included.
It leaves `PATH` alone: Git's `bin` folder also holds a `git.exe`, which would take the place of
the `git` the command names, such as a wrapper or a package manager's shim. It finds Git Bash
itself, with the command's environment and folder: through `git --exec-path` of the `git` on that
`PATH`, which also sees past a shim and is stopped, with what it started, when it does not answer
within 10 s, then in the standard install folders. Without Git Bash a `shell: "bash"` command
fails, and `bash` and `sh` are an error, each naming where it looked. A program the command starts that runs `bash` itself still
gets WSL's. When the
provider is turned off or not running, or cannot read them, including
Claude settings an organization's policy helper computes (a `policyHelper` or a per-OS
`policyHelpers` entry, neither of which `resolveSettings` applies), the call fails and nothing
runs. The command's end completes the task through the same durable delivery as a delegated
task's result, which wakes the thread once with the exit code and the last output.
`task_status` reads the task, and `task_cancel` kills the command's process tree. Native
background shells stay for work left running, such as dev servers and watchers; the update hold
lists neither. [Server updates](../internals/server-updates.md) describes how the command
survives a restart.

## `t3_thread_launch`

Launches one ordinary top-level thread through the app's launch service. Use an
explicit `workspaceStrategy` to create a new worktree (`worktree` from `baseRef`;
without one it starts where a scheduled task does, from the project's default
branch, fetched first),
attach an existing checkout (`existing_worktree` with `worktreePath`), or use the
project root (`root`, also the default). The thread is bound to that workspace
before the agent starts. Creating a worktree in the task prompt does not update
this binding.

## `t3_thread_read`

Agents pass those links back as readily as ids, so every `threadId` and
`<role>ThreadId` parameter takes either. `McpToolAccess.toLayer` swaps a link
for its thread id before the handler runs, and the link's environment routes the
call as `environmentId` would. A tool that never leaves this environment, or a
call whose `environmentId` names another environment, refuses the link with the
id to pass. Name a new thread parameter by that rule; the contract test in
`McpToolAccess.test.ts` holds every tool to it.

## Policy And Idempotency

```text
capability_denied
parent_not_active
provider_unavailable
model_unavailable
runtime_mode_escalation_denied
interaction_mode_escalation_denied
task_not_found
task_not_cancellable
thread_not_found
run_not_found
thread_not_sendable
thread_not_interruptible
invalid_request
orchestration_error
thread_credential_required
target_required
memory_short
auto_mode_unavailable
no_answer
unreachable
version_mismatch
```

`no_answer` means a linked environment's answer did not arrive, so whether it
acted is unknown; the same call sent again with its `clientRequestId` is
recorded there once. An address that answers with a server error (HTTP 5xx)
gives `no_answer` too, since a gateway can answer that after the call ran.
`unreachable` means no address of the linked environment answered as it, so
this call was not sent there; a call sent earlier with the same
`clientRequestId` may still have arrived.
