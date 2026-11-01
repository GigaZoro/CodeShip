# Claude

CodeShip uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Each Claude provider is one account. To add another, add a Claude instance in
**Settings > Providers** and choose **Sign in**. CodeShip runs `claude auth login`
in a terminal on the environment's machine; sign in with the other account in your
browser. Each provider then shows its account's email and plan.

The first Claude provider uses the Claude CLI's own login. Every other Claude
provider keeps its login in a folder CodeShip creates for it, and that folder links
to everything else in `~/.claude`: CLAUDE.md, skills, settings, plugins, and past
sessions, so threads can move between accounts. MCP servers you added with
`claude mcp add --scope user` are saved with the login, so add them again for each
account. **Sign out** signs that account out; sign the first provider out with
`claude auth logout` in a terminal.

A provider signed in to the same account as another provider is unavailable until
you sign it in to a different account. A Claude provider signed in with a
`CLAUDE_CODE_OAUTH_TOKEN` shows as **Claude token**, because a token cannot read the
account's email or plan. Claude uses a token ahead of a sign-in, so a
`CLAUDE_CODE_OAUTH_TOKEN` set on the machine applies only to the first Claude
provider. To give another provider a token, add it to that provider's
**Environment variables**. Remove the token to sign that provider in instead.

To keep an account's settings and local conversation state separate too, give the
instance its own **CLAUDE_CONFIG_DIR path** and sign that directory in on the
environment's machine. CodeShip then leaves that directory as it is:

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
CodeShip uses the Claude configuration on the connected server.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after Claude's prompt cache expires, a **Compact** chip with the thread's token count shows
next to the send button. While it is on, Enter summarizes the history first, then
sends your message. Click the chip to switch it to **Full** and keep the full
history for that message. The cache lasts about an hour on a Claude
subscription and 5 minutes with an API key, Bedrock, or Vertex. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

**Compact idle threads** in **Settings > Providers > Advanced** controls this for threads
over 200,000 tokens. Each Claude provider's settings can override it:

- **When you return** shows the **Compact** chip described above. This is the default.
- **Before the cache expires (beta)** compacts an idle thread shortly before its
  prompt cache expires, so coming back does not reprocess the whole conversation.
  The compaction appears in the thread as a `/compact` turn sent by CodeShip.
- **Never** skips idle compaction and Claude's resume prompt. **Auto-compact after**
  still applies, and you can still compact by hand.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started. With a second Claude account,
[account switching](./thread-sidebar.md#inspect-agent-work) moves
threads that Claude stops on a limit; a turn it is still holding stays put.

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
**Environment** section in **Settings > Providers**. Each update shows as a Tasks
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

Select the model you want in CodeShip. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in CodeShip. Custom models may have
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
