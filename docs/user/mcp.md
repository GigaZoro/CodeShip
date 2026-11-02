# MCP servers

MCP servers give Claude and Codex tools from other apps and services, such as an issue tracker or a
documentation search. Open **MCP servers** in the sidebar rail, or **Open MCP servers** from the
command palette, to see each provider's servers, add new ones, sign in to them, and remove them.
With more than one Claude or Codex account or machine, pick which one to change at the top of the
page; each keeps its own servers.

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
variables in their own config file, `~/.claude.json` for Claude and `config.toml` for Codex.

## Sign in

**Sign in** opens the server's sign-in page in your browser. After you approve access, the browser
returns to the provider and the dialog finishes on its own. When CodeShip runs on another machine,
the browser shows a connection error after you approve instead. Copy the address from its address
bar, paste it into the dialog, and choose **Finish sign-in**.

**Sign out** removes the provider's saved sign-in for that server.

## Things to know

- Servers marked **Plugin**, **claude.ai**, **Managed**, or **Built in** come from a plugin, your
  claude.ai connectors, your organization, or the provider itself. Manage plugins on the Plugins
  page and connectors on claude.ai.
- Servers in a project's own `.mcp.json` belong to that project and are not listed here.
- Changing servers needs permission to manage providers on that environment. Without it the page is
  read-only.
