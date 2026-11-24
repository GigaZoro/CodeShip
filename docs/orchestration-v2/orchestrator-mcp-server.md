# Orchestrator MCP Server

## Purpose

T3 exposes V2 orchestration through its app-owned MCP endpoint. A provider
agent can use this endpoint to:

- create an app-owned sub-agent on any supported provider instance;
- wait for or poll the sub-agent's durable result;
- cancel an active delegated task; and
- create one or more ordinary top-level T3 threads;
- list a project's threads and incrementally read any thread;
- rename threads, regenerate titles, and link or unlink pull requests;
- send or steer follow-up messages; and
- wait for or interrupt ordinary thread runs.

These are T3 orchestration operations, not provider-native sub-agent APIs.
Delegated tasks always create a T3 child thread and run. The child receives
only the supplied task prompt, plus an optional role instruction supplied in
the same tool call. Parent conversation history is not copied into the child.

`ThreadManagementService` is the shared server application boundary for V2
WebSocket commands and MCP. It owns thread lookup, listing, send-mode
selection, durable send postconditions, wait polling, and interrupt selection;
`OrchestratorV2` remains the lower-level command/event processor. Transport
adapters only authenticate, resolve transport-specific inputs, and shape
responses.

## Transport And Authentication

The orchestration tools share the existing authenticated HTTP MCP endpoint:

```text
http://127.0.0.1:<server-port>/mcp
```

The provider-visible server key is `t3-code`. The endpoint registers both the
preview toolkit and the orchestration toolkit.

Before `ProviderSessionManager` opens a new V2 provider session, it asks
`McpSessionRegistry` for a credential scoped to:

- the T3 environment;
- the parent T3 thread;
- the concrete provider instance; and
- the provider session.

The credential grants `preview` and `orchestration` capabilities. Credentials
expire after a maximum lifetime, expire when idle, and are revoked when the
provider session is released. The raw token is not persisted in orchestration
state.

The MCP HTTP server resolves the bearer token and supplies the resulting
`McpInvocationScope` to tool handlers. Orchestration handlers additionally
check the `orchestration` capability before reading or mutating state.

## Provider Injection

### Codex V2

Codex gets T3's MCP server in each thread's `thread/start`, `thread/resume`,
and `thread/fork` config, with the provider-session token in an
`Authorization` header. The same server is registered twice:

- `t3-code`: every tool except `t3_thread_wait`.
- `t3-code-direct`: only `t3_thread_wait`, with `omit_tools_from = ["code_mode", "deferred"]`.

Code Mode runs a nested call as part of a script, so the model keeps working
while a blocking wait runs. The second entry makes the wait a direct tool call,
like Codex's own wait tools. Codex reports calls as `<server>.<tool>`, so
`packages/shared/src/t3McpToolPresentation.ts` must resolve both server names.
Tool display and pending-work detection depend on it.

### Claude Agent SDK V2

Claude receives an HTTP MCP server in its query options:

```ts
{
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:<port>/mcp",
      headers: {
        Authorization: "Bearer <provider-session-token>",
      },
    },
  },
  allowedTools: [
    // existing allowed tools
    "mcp__t3-code__*",
  ],
}
```

The adapter logs only whether MCP configuration exists; it does not log the
server headers or token.

### Cursor Agent SDK V2

Cursor receives the same authenticated HTTP MCP endpoint through the SDK's
`mcpServers` agent and send options. The adapter passes the authorization header
to the SDK but projects only redacted option metadata into protocol diagnostics.

### Grok ACP V2

Grok receives the authenticated HTTP MCP endpoint through the ACP
`session/new`, `session/load`, and `session/fork` `mcpServers` field. The shared
ACP adapter owns standard protocol behavior; the Grok flavor adds xAI extension
requests such as structured user questions.

ACP does not define native subagents or active steering. Grok therefore uses
orchestrator-owned child threads and implements steering through
cancel-and-restart. Its current driver also lacks `session/fork`, so app forks
use portable context transfer. These are orchestrator policies, not
provider-specific MCP tools.

### ACP Registry V2

The `acpRegistry` driver is the generic flavor of the same shared ACP adapter.
Each provider instance names an agent from the official ACP Registry. Settings
searches the registry through the connected server, then prepares a compatible
distribution before persisting the provider instance. Binary distributions use
a managed, versioned cache; declared checksums are verified when present.
Version-pinned `npx` packages install globally through `npm`; `uvx` packages use
`uv tool install`. ACP launches the resulting global command directly, so the
same command is available for terminal authentication. A local executable may
override the installed command without changing the registry-declared arguments
or environment.

Search, preparation, provider status, and session startup share one
server-scoped catalog service. This keeps platform selection and registry
validation identical across settings and runtime use. Catalog inspection never
starts an ACP process, probes models, or performs authentication. The managed
provider snapshot creates a disposable `session/new` through the normal provider
refresh lifecycle, using success as the authentication-readiness proof and
projecting advertised models into the snapshot. Terminal-only login remains a
manual operation on the connected server.

Capabilities such as session loading, session forking, models, modes, and MCP
transport are enabled only when the selected agent advertises them. Missing
features degrade through V2 policy: steering uses interrupt-and-restart,
forking uses portable context when native `session/fork` is unavailable, and
subagents use orchestrator-owned child threads. Registry agents do not receive
provider-specific extensions; those remain in flavors such as Grok.

### Pi V2

T3 keeps a provider-session HTTP bridge even when Pi supports native MCP.
`mcp.json` entries override native registrations, and native MCP's default
60-second request timeout can interrupt long-running T3 tools. The bridge owns
the injected endpoint and credential and forwards Pi's cancellation signal.

When a provider session credential exists, the adapter writes a T3-owned
extension into the server cache and spawns
`pi --mode rpc --extension <cache>/pi-t3-mcp-extension.ts` with:

```text
T3_MCP_URL=http://127.0.0.1:<port>/mcp
T3_MCP_BEARER_TOKEN=<provider-session-token>
```

The extension preserves public names under `mcp__t3-code__` for saved loadouts
and tool selectors. Modern Pi also receives hidden `mcp__t3_code__` aliases,
which reserve the normalized namespace against configured MCP servers without
adding declarations or search results. On Pi 0.99+,
`orchestrator_capabilities`, `delegate_task`, and `task_status` remain directly
available; optional tools are discovered through Pi's builtin `tool_search`.
On older Pi or without builtin search, all tools remain directly available.
The bridge calls the original MCP tool name over HTTP. Follow-up requests send
`mcp-protocol-version: 2025-06-18`; Effect's MCP transport returns 400
without it. The first turn of a session also receives the shared T3
orchestration instructions.

Pi keeps ownership of native extension discovery. T3 does not replace Pi's
`subagent` tool or reproduce Pi's package and project-trust loader. Durable
delegation goes through the namespaced T3 MCP `delegate_task` tool and the
shared orchestration child-thread lifecycle. When Pi's example `subagent`
extension is installed, the adapter observes its documented `details.results`
shape and projects task cards with no child thread id. Unknown result shapes
remain ordinary dynamic tool output.

### Provider Support

A provider instance can run child tasks when its live `ProviderInstance`
exposes a V2 `orchestrationAdapter` — the same registration the orchestrator
resolves when a `delegated_task.request` executes. That covers Codex, Claude
Agent SDK, Cursor Agent SDK, Grok, generic registry agents over ACP, OpenCode,
OpenCode 2, Pi, Antigravity, and any future driver that builds an adapter.
Capability discovery still reports other registered provider instances, but
marks them unavailable for orchestration when no adapter resolves. This keeps
provider selection model-visible without allowing a request that cannot run.

## Tool Surface

The server exposes these orchestration tools.

### `orchestrator_capabilities`

Returns:

- the inherited provider instance and model;
- the parent runtime and interaction modes;
- registered provider instances and advertised models;
- whether each provider can run a child task;
- `limitedUntil` for each account a usage limit stopped: the latest reset it
  reported; and
- feature flags for polling, cancellation, and batch thread creation.

Unavailable providers include model-visible constraints such as missing V2
adapter support, disabled state, missing executable, or missing authentication.

`delegate_task`, `create_threads`, and `t3_thread_launch` refuse a new thread
whose first turn would start on such an account, Auto routing included, before
anything is created. A retry of an accepted launch still replays. Only a
provider's usage-limit failure marks an account; a usage window at 100% does
not, because extra usage can still run there.

The model list is short on purpose: catalogs such as OpenCode can hold hundreds
of models, and every call lands in the agent's context. Each provider lists
custom, favorite, and the caller's own models, plus all current (non-legacy)
models for Codex, Claude, Muse, and Grok, or the first 8 current models in the
user's model order for other providers. `omittedModels` counts the rest, and the
`search` input finds them, legacy models included. `delegate_task` still accepts
any catalog model.

### `delegate_task`

Creates a T3-owned child thread and immediately dispatches the supplied task
prompt.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
    options?: Array<{ id: string; value: string | boolean }> | Record<string, string | boolean>;
  };
  title?: string;
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  auto?: boolean;
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
  interactionMode?: "inherit" | "plan" | "default";
};
```

Provider, model, runtime mode, and interaction mode inherit from the parent
when omitted. A driver-only target inherits the parent's provider instance
when it can run child tasks, and otherwise selects an available instance of
that driver; an explicit `providerInstanceId` is honored exactly and fails
when unavailable. Selecting a different provider without a model uses that
provider's first advertised model.

A child on its parent's provider instance and model, named by slug or alias,
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

A provider runs a runtime mode it does not offer as `approval-required`, so a
child would ask for approval on every command. `orchestrator_capabilities`
lists `runtimeModes` only for a provider that offers some of the modes, and
omits it for a provider that offers all of them. When the target lists
`runtimeModes`, an explicit `runtimeMode` outside that list is refused, and an
inherited mode steps down to the broadest mode the target offers.

Each independent delegated review round uses a new `delegate_task` call with the
original brief, prior findings, responses, and unresolved objections. Track each
round by its own `taskId` and use a distinct `clientRequestId` per round, stable
across retries of that round.
A follow-up that needs the same child's conversation goes through `t3_thread_send`
on its `childThreadId`. After the original task completes, that follow-up runs as a
fresh task in the child thread; it does not reopen the completed task or change its
published result.

Delegation requires an active parent run owned by the MCP credential's
provider session. The request becomes the V2 command
`delegated_task.request`.

`mode: "async"` returns the current durable state immediately.
`mode: "wait"` waits for the task result, including nested work and completion follow-ups, or until
the timeout expires. A wait timeout does not cancel the child; the result sets
`waitTimedOut: true`, and the caller can continue with `task_status`. A pending blocking
question also ends the wait with `hasPendingQuestion: true` and `waitTimedOut: false`.
If `hasPendingQuestion`, pass `threadId=childThreadId` to `t3_pending_request` with
action `list`, `read` (with `requestId`), or `respond`, or ask the user; the task's completion still wakes this thread. A pending live approval for the
task's own unfinished work also ends the wait. Its identity appears in `pendingApproval`;
it grants no approval authority. Read the fresh full request in the child thread before
responding, since the durable record can outlive its provider callback. Async questions
do not end the wait.

```ts
type DelegateTaskResult = {
  taskId: string;
  childThreadId: string;
  childRunId: string | null;
  childNodeId: string;
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted";
  workState: "working" | "waiting_for_children" | "result_available";
  hasPendingChildRuns: boolean;
  providerInstanceId: string;
  model: string | null;
  summary: string | null;
  resultContextTransferId: string | null;
  latestTerminalRunId: string | null;
  latestTerminalStatus: "completed" | "failed" | "cancelled" | "interrupted" | null;
  latestTerminalSummary: string | null;
  latestTerminalResultContextTransferId: string | null;
  hasPendingQuestion: boolean;
  pendingApproval: {
    requestId: string;
    kind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission";
    runId: string;
  } | null;
  waitTimedOut: boolean;
};
```

### `task_status`

Reads a delegated task from the parent thread's durable projection. A task ID
from another parent thread is rejected. `childRunId` identifies the original
run. `workState` distinguishes active work, a finished turn waiting for children,
and an available result. The task remains nonterminal until its known work
finishes. Its published `summary` and result transfer then remain stable across
later follow-ups. `hasPendingChildRuns` reports later queued or executing turns;
`latestTerminal*` exposes later executed, non-monitor results without replacing
the published task result.

### `task_cancel`

Stops the child thread with the internal `thread.stop` command, then stops every
task the child delegated, and disposes automatic parent delivery. Like a user Stop,
`thread.stop` interrupts the running turn, holds queued turns, and ends pull request
watches. A nonterminal task with no interruptible run is rejected. A terminal task
returns its existing status, and its child thread still stops, including later
runs and watch wakes. Published task results remain available. It accepts an
optional cancellation reason.

### `t3_command_run`

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

### `create_threads`

Creates between one and twenty ordinary top-level T3 threads:

```ts
type CreateThreadsInput = {
  threads: Array<{
    prompt?: string;
    title?: string;
    target?: {
      providerInstanceId?: string;
      driverKind?: string;
      model?: string;
      options?: Record<string, string | boolean>;
    };
    auto?: boolean;
    runtimeMode?: "inherit" | "approval-required" | "auto-accept-edits" | "full-access";
    interactionMode?: "inherit" | "plan" | "default";
  }>;
  clientRequestId?: string;
};
```

Each entry independently resolves provider, model, and modes. The new threads
inherit the parent's project, branch, and worktree path, but they have no
sub-agent lineage. Entries with a prompt immediately dispatch a run; entries
without a prompt remain idle.

### `t3_thread_launch`

Launches one ordinary top-level thread through the app's launch service. Use an
explicit `workspaceStrategy` to create a new worktree (`worktree` from `baseRef`;
without one it starts where a scheduled task does, from the project's default
branch, fetched first),
attach an existing checkout (`existing_worktree` with `worktreePath`), or use the
project root (`root`, also the default). The thread is bound to that workspace
before the agent starts. Creating a worktree in the task prompt does not update
this binding.

Pass the task in `message`. Project, model, and modes inherit when omitted;
workspace does not. `scratch: true` launches without a project, in a folder of
its own under the environment's Scratch project. For stacked PRs, use the parent branch as `baseRef` with
`startFromOrigin: false`. The new thread may not run with broader runtime or
interaction modes than the caller. As for `delegate_task`, a runtime mode the
provider does not offer is refused, and an inherited or default one steps down
to the broadest mode it offers. Launch has no retry key, so inspect existing threads after a failed or lost response before
launching again. `create_threads` remains the batch option for a shared checkout.

### `t3_thread_list`

Lists durable thread shells in one project, newest first: `projectId` when
given, else the calling thread's project. Callers can filter by title, run
status, and whether app-owned sub-agent threads are included. Results are
bounded and offset-paginated. Deleted threads are never listed.

### `t3_thread_read`

Reads the durable state, recent runs, and visible timeline of any thread in
the environment by thread ID. A deleted thread returns `thread_not_found`. The
default `messages` view returns user messages, assistant
messages, and proposed plans. The `activity` view also returns summarized tool,
reasoning, checkpoint, handoff, and runtime-request items. Large item text is
bounded and reports whether it was truncated. `afterPosition` and
`nextPosition` support incremental reads.

Thread and message results include required `createdBy` and `creationSource`
provenance. MCP-created threads and user-role messages use `createdBy: "agent"`
and `creationSource: "mcp"`; provider output uses `creationSource: "provider"`.
Actor and ingress are separate so agent-authored user-role messages remain
distinguishable from human-authored messages.

Agents mention another thread by the `link` its result carries,
`<t3-thread://v2/<environmentId>/<threadId>>`, so they never format an id or
write a title, which goes stale when the user renames the thread. The
environment that owns the thread builds the link, so forwarded results and tasks
delegated to a linked environment name that environment. Clients open only that
environment's thread and show its current title; a link to a thread they do not
know renders as a label that opens nothing. Older `t3-thread://v1/<threadId>`
links name no environment: clients resolve them in the message's environment,
then by a unique match in another enabled environment. An outside OAuth client,
one that is not a linked environment, cannot render `t3-thread://` links, so it
gets a web URL on the origin it reached, `<origin>/<environmentId>/<threadId>`,
for threads in this environment.

Agents pass those links back as readily as ids, so every `threadId` and
`<role>ThreadId` parameter takes either. `McpToolAccess.toLayer` swaps a link
for its thread id before the handler runs, and the link's environment routes the
call as `environmentId` would. A tool that never leaves this environment, or a
call whose `environmentId` names another environment, refuses the link with the
id to pass. Name a new thread parameter by that rule; the contract test in
`McpToolAccess.test.ts` holds every tool to it.

List and read results report `snoozed` and `snoozedUntil`, and
`t3_thread_list` filters on `snoozed`. The server's `isSnoozed` follows the
client's `effectiveSnoozed`, so agents and the sidebar agree: a snoozed thread
wakes early only when it has a pending request or fails after snoozing. Completed
runs, background wakes, and delegated completions keep it snoozed.

### `t3_thread_update`

Updates metadata for the calling thread or any other thread in the environment.
The typed actions are `rename`, `regenerate_title`, `link_pull_request`, and
`unlink_pull_request`. A link input supplies the repository, number, and URL;
the server records the target thread's project ID. Branch and workspace changes
are outside this tool.

The result includes the command ID and durable event sequence together with the
resultant title, title-regeneration marker, and linked pull request. Reusing a
`clientRequestId` for the same action and thread replays the same command
receipt. Thread list and read results expose the linked pull request, and thread
detail also exposes an in-flight title regeneration.

### `t3_thread_send`

Sends a message to any ordinary or delegated thread in the environment:

- `auto` starts an idle thread, steers a fully active turn, or queues behind a
  turn that is not yet steerable;
- `queue` creates a separate follow-up run after active work;
- `steer` requires a steerable active provider turn; and
- `restart` requires an active provider turn and uses the orchestrator's
  interrupt-and-restart path.

The target runtime and interaction modes may not be broader than the caller's.
Stable command and message IDs are derived from `clientRequestId` for
idempotent retries.

### `t3_thread_wait`

Waits for a selected run to become `completed`, `failed`, `cancelled`,
`interrupted`, or `rolled_back`. Without `runId`, it pins the latest run at call
time; an idle thread returns immediately. A timeout reports the latest durable
status and does not cancel work.

### `t3_thread_interrupt`

Interrupts a selected active run through the normal V2 `run.interrupt` command.
Without `runId`, it selects the newest interruptible run. A terminal run is
returned unchanged, and a thread with no active provider turn returns
`no_active_run`.

## Delegated Task Lifecycle

The MCP server is a command ingress into V2. It does not call provider adapters
directly.

```text
provider model
  -> MCP tools/call delegate_task
  -> authenticated OrchestratorMcpService
  -> shared ThreadManagementService
  -> V2 delegated_task.request command
  -> child thread + child run
  -> parent app_owned subagent projection
  -> parent/child execution nodes
  -> consumed subagent_spawn context transfer
  -> normal provider effect and runtime ingestion
  -> child run reaches a terminal state
  -> parent subagent/node/turn item finalized
  -> consumed subagent_result context transfer
  -> wait result or later task_status result
```

The child thread has lineage relationship `subagent` and points back to the
parent node. The parent gets an `app_owned` sub-agent projection and a
sub-agent turn item so the existing debug UI can render progress.

Terminal provider events trigger finalization. The event stream first replays
persisted events and then follows live events, so finalization also runs after
a server restart. An existing `subagent_result` transfer makes finalization
idempotent.

Users rarely watch child threads, so a child question would otherwise go
unanswered. When a child opens a pending `user_input` request, the parent gets
a notification message telling it to answer with the pending request tools or
ask the user. The message says whether the child is blocked or, for a Codex
async question, still working. If the question is answered or dismissed before
the notification starts a turn, that queued turn is cancelled. Approvals are not
routed, because those tools cannot answer them.
A parent still blocked in a `delegate_task` wait gets the blocking question
through that wait instead.
If the provider cuts that wait short, a still-pending live question wakes the
parent when its launching run completes, fails, or waits for post-turn work.
Stopping or interrupting the parent prevents this catch-up.

A failed run exposes its provider error before any progress text. Successful
results use the latest assistant content from the final work turn.

## Policy And Idempotency

- A child runtime mode may stay equal to or become narrower than the parent
  mode. It may not escalate privileges.
- A child interaction mode may stay equal to or narrow from `default` to
  `plan`. It may not escalate from `plan` to `default`.
- Thread tools take any thread in the environment as a target. For a thread
  caller, list and search cover one project: its own unless `projectId` is given.
- A tool that changes another thread needs the calling thread's live run, and
  the target's runtime and interaction modes may not be broader than the
  caller's. This is the same privilege ceiling as child creation.
- Provider instances must be enabled, installed, available, authenticated, and
  backed by a V2 adapter.
- A requested model must be advertised by the selected provider when the
  provider publishes a model list.
- `clientRequestId` derives stable command, thread, and message IDs within the
  provider session. Retrying the same call returns the same durable work.
- Calls without `clientRequestId` receive a generated request key and create
  new work.

Expected denials use the typed `OrchestratorMcpFailure` result:

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
version_mismatch
```

`no_answer` means a linked environment's answer did not arrive, so whether it
acted is unknown; the same call sent again with its `clientRequestId` is
recorded there once.

## Code Ownership

- Shared schemas: `packages/contracts/src/orchestratorMcp.ts` and
  `packages/contracts/src/threadMetadataMcp.ts`
- MCP services: `apps/server/src/mcp/OrchestratorMcpService.ts` and the focused
  `apps/server/src/mcp/ThreadMetadataMcpService.ts`
- Tool definitions and handlers:
  `apps/server/src/mcp/toolkits/orchestrator/`
- HTTP registration and authentication:
  `apps/server/src/mcp/McpHttpServer.ts`
- Credential lifecycle: `apps/server/src/mcp/McpSessionRegistry.ts`
- Provider injection:
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` and V2 adapters
- Durable delegated-task command and finalization:
  `apps/server/src/orchestration-v2/Orchestrator.ts`

## Verification

The integration test uses the real MCP toolkit registration, V2 orchestrator,
SQL persistence, event ingestion, projections, and checkpoints. Only the
external provider adapters are deterministic test implementations.

Coverage includes:

- capability discovery;
- cross-provider delegated completion;
- prompt-only child context;
- parent and child lineage projections;
- spawn and result context transfers;
- async status polling;
- cancellation;
- batch ordinary-thread creation;
- thread listing and timeline reads, including another project's threads;
- ordinary-thread send, wait, steering, and interruption;
- inheritance and per-thread provider overrides; and
- idempotent retries.

Provider adapter tests separately verify Codex, Claude, Cursor, Grok, and ACP
Registry behavior and MCP injection. The provider-session manager test verifies
that credentials exist before an adapter opens and are revoked when it closes.
