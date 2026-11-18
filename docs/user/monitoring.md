# Monitoring

**Monitoring** shows where the time of your chats went and what slowed them down. Open it from
the sidebar or the command palette, or on mobile from **Settings → Monitoring**. Bind
`monitoring.open` in **Settings → Keybindings** for a shortcut; it has no default.

A chat appears once it has settled and been analyzed. The page updates by itself when a chat
settles, so there is nothing to refresh. A note at the top says how many settled chats are still
being analyzed.

## The overview

Choose 7, 30 or 90 days, then narrow by project, kind or model. The page reads every environment
you are connected to; if one cannot be read, a warning names it.

- **Where the time goes** splits each chat's lifetime, from creation to settling, into what it
  waited on: the model, commands, tools, approvals, the queue, usage limits, helpers, you, and
  the time before settling.
- **Weak points** ranks findings such as repeated or slow commands, failed runs and low cache
  reuse. Select one to list only the chats it hit.
- **Steps** groups shell commands by what they were for.
- **Daily trend**, the **breakdowns** and the **chat list** compare days, projects, kinds and
  models. Select a chat to open its deep dive. The list starts with the newest chats, and **Show
  more** adds more, up to 1,000; filter it to reach the rest of a busy period. Every figure on the
  page still counts all the chats that match the filters.

## A single chat

The deep dive shows a timeline of the chat's runs and helpers, colored by model, with markers for
events such as restarts and usage limits. Below it are the steps, the slowest and most repeated
commands, and the findings with advice on what to change. **Open chat** returns to the
conversation.
