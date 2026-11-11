# Claude

T3.CodeShip uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Each Claude provider is one account. To add another, add a Claude instance in
**Settings > Providers & models** and choose **Sign in**. T3.CodeShip runs `claude auth login`
in a terminal on the environment's machine; sign in with the other account in your
browser. Each provider then shows its account's email and plan.

The first Claude provider uses the Claude CLI's own login. Every other Claude
provider keeps its login in a folder T3.CodeShip creates for it, and that folder links
to everything else in `~/.claude`: CLAUDE.md, skills, settings, plugins, and past
sessions, so threads can move between accounts. Claude saves MCP servers with the
login, so before Claude starts, T3.CodeShip copies the servers in `~/.claude.json`, such
as ones added with `claude mcp add --scope user`, into each account. Each account
signs in to those servers on its own. **Sign out** signs that account out; sign the
first provider out with `claude auth logout` in a terminal.

A Claude sign-in expires on a schedule: the access token renews by itself, but the login stops
working a few weeks after you last signed in, and every request then fails with "Login expired".
Under **Account**, T3.CodeShip shows **Signed in until** the date the saved login ends, a warning in
the last 7 days, and **Login expired** after that, each with **Sign in again**. It also lists the
account under **Manual steps**. A token you paste yourself has no known expiry date.

A provider signed in to the same account as another provider is unavailable until
you sign it in to a different account. A Claude provider signed in with a
`CLAUDE_CODE_OAUTH_TOKEN` shows as **Claude token**, because a token cannot read the
account's email or plan. Claude uses a token ahead of a sign-in, so a
`CLAUDE_CODE_OAUTH_TOKEN` set on the machine applies only to the first Claude
provider. To give another provider a token, add it to that provider's
**Environment variables**. Choose **Use regular sign-in instead** under **Account** to
sign that provider in instead. For the first provider, switching back adds a blank
`CLAUDE_CODE_OAUTH_TOKEN` to its environment so it ignores a machine-wide token.
Deleting that blank variable uses the machine's token again.

To keep an account's settings and local conversation state separate too, give the
instance its own **CLAUDE_CONFIG_DIR path** and sign that directory in on the
environment's machine. T3.CodeShip then leaves that directory as it is:

```bash
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

The custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Setting `HOME` instead can put credentials where this provider will
not find them. Threads on an instance with its own **CLAUDE_CONFIG_DIR path** can
switch only to instances that use the same directory.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3.CodeShip uses the Claude configuration on the connected server.

## One-year token

For an account that runs scheduled tasks, choose **One-year token** as its sign-in method,
then **Sign in** (or **Change account**). T3.CodeShip runs `claude setup-token` for that
account and opens the usual browser approval. This requires Pro, Max, Ultra, Team or
Enterprise. It saves the token in the environment's secret store, never in plain text in
settings or the sign-in terminal, and uses it only for that provider.

The token stays valid for one year without renewals or competing refreshes. T3.CodeShip
records its issue date and shows the same expiry warnings and manual steps before the
year ends. Choose **One-year token** again to replace it. Sessions using this token cannot
use Remote Control or claude.ai connectors; MCP servers configured on the environment's
machine still work.

Choose **Use regular sign-in instead** and complete the browser sign-in to remove the
saved token and its secret. If sign-in fails or is cancelled, the existing token stays in
place. For added accounts, **Sign out** also removes the saved token and the CLI login.
A machine-wide token is ignored for this provider when switching back, without changing
other accounts.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. The meter is off by default; see
[commands and skills](./composer.md#commands-and-skills) to enable it. Claude Code
compacts automatically whether the meter is on or off.

When you return to a large thread after Claude's prompt cache expires, a
**Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Keep** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Threads > Behavior** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** tries to compact an idle thread shortly before its
  prompt cache expires, while the history is still cached.
  The compaction appears in the thread as a `/compact` turn sent by T3.CodeShip.
  If the window is missed, such as when you enable this mode after the cache has
  expired or the server restarts before compaction runs, it falls back to
  **When you return**. Switch the chip to **Keep** to keep the full history for that message.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started. With a second Claude account,
[account switching](./thread-sidebar.md#inspect-agent-work) stops a held turn
and continues it on an account with usage left, unless the reset is less than
five minutes away.

## Skills

Claude skills come from the config directory's `skills` folder, the project's
`.claude/skills` folder, and `~/.agents/skills`, the
[folder every provider shares](./composer.md#commands-and-skills). If two define
the same name, the config-directory copy wins, then the project's. Skills disabled
in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Enabled installed Claude plugins also
contribute skills under names such as `plugin:review`. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## Task lists

To show Claude task lists in the web and desktop apps, add
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` under **Variables** in the Claude instance's
**Environment** section in **Settings > Providers & models**. Each update shows as a Tasks
row in the thread; open it to see every step.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3.CodeShip. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers & models** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3.CodeShip. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
