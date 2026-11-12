# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in T3.CodeShip.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers & models**. For a remote machine,
select that environment first. T3.CodeShip handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3.CodeShip.
Codex's built-in subagents are unavailable with ChatGPT sharing. If a request uses
another feature that ChatGPT sharing does not support, use another provider for
that request.

When reconnecting, choose the same account in T3.CodeShip and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

T3.CodeShip can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

With **Binary path** left empty, T3.CodeShip runs the `codex` on that machine's `PATH`.
When there is none, it runs its own copy of Codex with the same login. If it has no
copy yet, the provider's settings offer **Install Codex**; then sign in there.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers & models**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Every account uses the `AGENTS.md`, skills, and configuration in `~/.codex`,
including its [MCP servers](./mcp.md); each added account signs in to those servers
on its own. Connecting accounts through T3.CodeShip leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers & models**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3.CodeShip prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home. If the shadow directory already has its own copy of something it shares,
T3.CodeShip renames that copy with a `.t3-backup-<time>` suffix rather than
deleting it.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3.CodeShip offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

An account you connected with ChatGPT can stop on its plan's limit or on the cap you set for
T3.CodeShip in ChatGPT's usage settings. T3.CodeShip knows when either resets only on a machine
that reads the account's limits, so choose **Read limits** for the account under
**Usage → Limits** on each machine that runs its threads. With the reset known, choose
**Switch to another account, else resume when the limit resets** under **Settings → Threads →
When a thread hits a usage limit**. A stopped thread moves to an account with room or resumes
at the reset.

### ChatGPT's app limit

ChatGPT can also stop an account you connected with ChatGPT while its plan still has room: a
limit on apps that use the plan, which no ChatGPT setting raises. The thread then says
**ChatGPT's app limit stopped this account**, and **Usage → Limits** lists the account as held.
The next turn tries a held account again after an hour; choose **Try again** in the thread or
under **Usage → Limits** to release it at once. An agent can do the same through T3.CodeShip's
tools.

The limit does not apply to Codex's own login. To keep working on the account, choose **Switch
sign-in**, or set the account's **Sign-in** to **Codex's own login** in **Settings → Providers &
models** on the machine that runs its threads, then sign in there as that account. The first
Codex account on a machine shares the Codex CLI's login unless you turn on **Private login**, which
signs it in on its own. Changing an account's sign-in releases its hold. Until a turn runs on the
account again, **Manual steps** lists it too.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
