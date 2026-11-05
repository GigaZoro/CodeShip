# MCP servers

MCP servers give Claude and Codex tools from other apps and services, such as an issue tracker or a
documentation search. Open **Extensions** in the sidebar rail and choose the **MCP servers** tab, or **Open MCP servers** from the
command palette, to see every provider's servers on one page, add new ones, sign in to them, and
remove them. With more than one machine, pick the machine at the top right; the page remembers it.
Claude and Codex accounts on the same machine share their servers, so adding or removing a server on
one changes it on the others, unless you gave an account its own config directory. They share
sign-ins too: signing in to a server, or out of one, on one account does it on the others. Accounts
that share both are listed once. To have each added Claude or Codex account sign in on its own, turn
off **Share MCP sign-ins** in **Settings > Providers & models**; each account then gets its own
list. Antigravity accounts all load the servers in
`~/.gemini/config/mcp_config.json`.

New sessions load your changes. To use them in a thread that is already running, choose **Restart
agent session** in the command palette.

## Add a server

Choose **Add server**, give it a name, then pick a type:

- **Remote URL** for a server on the web. Most of these ask you to sign in once they are added;
  choose **Sign in** on the server's row. Add headers only for a server that takes an API key
  instead.
- **Local command** for a server that runs on the machine the provider runs on, such as
  `npx -y @upstash/context7-mcp`. Add environment variables for any keys it needs.

Claude adds the server for all of your projects. Both providers keep headers and environment
variables in their own config file, `~/.claude.json` for Claude and `config.toml` for Codex. Each
Claude account you add in CodeShip keeps a copy of those servers in its own folder.

## Sign in

**Sign in** opens the server's sign-in page in your browser. After you approve access, the browser
returns to the provider and the dialog finishes on its own. When CodeShip runs on another machine,
the browser shows a connection error after you approve instead. Copy the address from its address
bar, paste it into the dialog, and choose **Finish sign-in**.

**Sign out** removes the provider's saved sign-in for that server, on every account that shares
it.

## Things to know

- Servers marked **Plugin**, **claude.ai**, **Managed**, or **Built in** come from a plugin, your
  claude.ai connectors, your organization, or the provider itself. Manage plugins on the Plugins
  tab and connectors on claude.ai.
- A plugin server marked **Not set up** has no address. Some Claude plugins, such as Anthropic's
  `engineering`, leave Gmail and Google Calendar blank for claude.ai to fill. Choose **Connect on
  claude.ai**, connect them there, and they appear here as **claude.ai** servers.
- Some plugin servers need a key in an environment variable, such as the GitHub plugin's
  `GITHUB_PERSONAL_ACCESS_TOKEN`. **Add variable** opens the provider's settings, where you can add
  it and mark it sensitive. Each Claude or Codex account keeps its own variables.
- Servers in a project's own `.mcp.json` belong to that project and are not listed here.
- Changing servers needs permission to manage providers on that environment. Without it the page is
  read-only.
