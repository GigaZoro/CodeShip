# ThreadPage notes

[ThreadPage](https://thread.page) is a separate note-taking app that keeps one thread of notes per
project, task or question. T3.CodeShip opens it from **ThreadPage** in the sidebar rail or from
**Open ThreadPage** in the command palette.

The desktop app shows ThreadPage in place. In a web browser it opens in a new tab, because
thread.page does not allow other sites to embed it. ThreadPage links in chat, such as the note links
agents reply with, open the same way instead of in the thread's browser, which is not signed in to
ThreadPage.

## Where your notes live

Without a ThreadPage account, notes stay in the browser you write them in. In the desktop app that
is T3.CodeShip's own ThreadPage storage on that machine, which is separate from your regular browser,
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

## Manual steps

**Manual steps** lists the steps only you can do, from every machine: what agents put on each
machine's pending list in ThreadPage. Each list is a folder under a folder named **Machine inbox**
(such as `Work/Agent Maintenance/Machine inbox/<machine>`), and each step is a thread there with
the status **Waiting** whose description starts with `Hands-on:` or, for a money decision,
`Needs you:`. Money decisions come first. Open a step to read its newest note, which says what to
do; reply there when you are done.

To fill the list, create a token in ThreadPage under **Settings → Connections → Connect an
automation → Script or API**, with **Read only** access to the Machine inbox folder or all threads.
Save it in **Settings → Threads → ThreadPage** on one machine. The token stays on that machine and
is never sent to apps, and every app connected to it shows the list: under Needs you in a chat's
details column, in the thread list on narrow windows and on mobile, and on the **Manual steps**
page in the sidebar rail and the command palette. The list never sends notifications.
