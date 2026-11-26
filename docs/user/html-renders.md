# Visual replies and MCP apps

Agents can render self-contained HTML visuals (charts, diagrams, tables, image collages, mockups) and interactive MCP Apps inline in a thread on web, desktop, and mobile.

## Visual replies (HTML renders)

Ask an agent for a visual (e.g. "show this as a chart" or "make a collage of these screenshots"). The rendered page appears above the agent's reply, adapts to your light/dark theme, and runs sandboxed away from your T3.CodeShip session.

- **Local images**: Embedded when published so they stay intact even if the original files move or are deleted.
- **Preview browser**: Before publishing, agents verify their visual with T3.CodeShip's bundled headless Chromium (~120 MB one-time download, shared with [remote browser tabs](./remote-access.md#browser-host-setup)).
- **Network restrictions**: Previews can load public CDN assets but block private/local-network IPs. If Clash/Mihomo fake-IP DNS causes CDN loads to fail, inline the resource, add the host to `fake-ip-filter`, or switch proxy DNS to `redir-host`.

Ask for a change to a page ("sort the bars", "use a line chart instead") and the agent publishes a new version with its reply. The earlier version collapses to one line in the thread. Click it to show that version again, or on mobile, tap it to open it full screen.

On web and desktop, **Artifacts** in the sidebar rail lists the pages from all your threads on every connected machine, newest first. Only the newest version of each page is listed. Search by page, thread, or project title, and use **Open thread** to go back to the conversation. **Copy link** copies a link that opens the page in the app, and **Delete** removes it from the list; the thread keeps showing it. On mobile, **Artifacts** in the thread list's menu opens the same list.

## MCP apps

MCP servers supporting the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard render interactive UIs directly below their tool calls (supported on Codex and Claude Code 2.1.301+ on up-to-date T3 servers).

- **Safety**: T3.CodeShip asks before an MCP app runs non-read-only server tools, posts messages to the thread, opens links (mobile), or saves files. Navigating away from its own page stops the app.
- **Session requirement**: Apps remain viewable after a turn ends, but interacting with them requires the thread's agent session to be running.
- **Full screen**: Expand an app full screen and press `Esc` (or the corner button) to return to the thread.
