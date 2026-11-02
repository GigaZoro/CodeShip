# ThreadPage notes

[ThreadPage](https://thread.page) is a separate note-taking app that keeps one thread of notes per
project, task or question. CodeShip opens it from **ThreadPage** in the sidebar rail or from
**Open ThreadPage** in the command palette.

The desktop app shows ThreadPage in place. In a web browser it opens in a new tab, because
thread.page does not allow other sites to embed it. ThreadPage links in chat, such as the note links
agents reply with, open the same way instead of in the thread's browser, which is not signed in to
ThreadPage.

## Where your notes live

Without a ThreadPage account, notes stay in the browser you write them in. In the desktop app that
is CodeShip's own ThreadPage storage on that machine, which is separate from your regular browser,
your other machines, and the in-app browser of your threads. Clearing a thread browser profile does
not remove them.

To see the same notes on every machine, sign in with ThreadPage Pro in each place you use it. Pro
also lets agents read your notes. To back up local notes, use ThreadPage's own export.

## Let agents use your notes

Agents reach ThreadPage through its MCP server, configured in each provider on each machine that
runs them. For example, `claude mcp add --transport http --scope user threadpage
https://thread.page/mcp` for Claude Code, or `codex mcp add threadpage --url https://thread.page/mcp`
for Codex. See ThreadPage's [assistant guide](https://thread.page/help/connections/agents) for
access levels and its suggested work-log conventions.
