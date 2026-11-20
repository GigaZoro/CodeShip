# Monitoring

**Monitoring** shows where the time of your chats went and what slowed them down. Open it from
the sidebar or the command palette, or on mobile from **Settings → Monitoring**. Bind
`monitoring.open` in **Settings → Keybindings** for a shortcut; it has no default.

A chat appears once it has settled and been analyzed. The page updates by itself when a chat
settles, so there is nothing to refresh. A note at the top says how many settled chats are still
being analyzed, and when more chats settled in the period than can be shown.

## The overview

Choose 7, 30 or 90 days, then narrow by project, kind or model. The page reads every environment
you are connected to; if one cannot be read, a warning names it.

- **Where the time goes** splits each chat's lifetime, from creation to settling, into what it
  waited on: the model, commands, tools, approvals, the queue, usage limits, helpers, you, and
  the time before settling.
- **Weak points** ranks findings such as repeated or slow commands, failed runs and low cache
  reuse. Select one to list only the chats it hit. **Fix root cause** starts a chat that reads
  the chats it hit, up to 20 that lost the most time, traces the weak point to its cause and fixes
  it. The chat runs on the machine and in the project that lost the most time to it, and starts
  the way a new chat there would, in a worktree when the project uses them. The button shows
  only when that machine runs a version that can start these chats and your connection may start
  chats there.
- **Steps** groups shell commands by what they were for.
- **Daily trend**, the **breakdowns** and the **chat list** compare days, projects, kinds and
  models. Select a chat to open its deep dive.

## A single chat

The deep dive shows a timeline of the chat's runs and helpers, colored by model, with markers for
events such as restarts and usage limits. Below it are the steps, the slowest and most repeated
commands, and the findings with advice on what to change. **Fix root cause** on a finding starts
a chat that fixes its cause in this chat's project. **Open chat** returns to the conversation.
