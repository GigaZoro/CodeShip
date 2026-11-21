# Monitoring

**Monitoring** shows where the time of your chats went and what slowed them down. Open it from
the sidebar or the command palette, or on mobile from **Settings → Monitoring**. Bind
`monitoring.open` in **Settings → Keybindings** for a shortcut; it has no default.

A chat appears once it has settled and been analyzed. The page updates by itself when a chat
settles. A period ends with today, so after midnight press **Refresh**, or pull down on mobile, to
move it to the new day. A note at the top says how many settled chats are still being analyzed,
and how many could not be analyzed, in the chosen project when you narrow by one. A chat you
rename or move shows its new name and project at once.

Totals, the trend and the breakdowns count every analyzed chat that settled in the period,
however many there are; a chat still being analyzed joins them once its analysis is done. Days
follow your device's clock, and every environment counts a chat on the same day.

## The overview

Choose 7, 30 or 90 days, then narrow by project, kind or model. The page reads every environment
you are connected to. Once one has answered or failed, a note names each environment whose
chats are missing from the sums: those still answering, and those that cannot be read, with the
reason. When one of those can be asked again, **Retry** does that, and reconnects one that is
offline. An environment that runs an older T3.CodeShip server is named too until you update it.

- **Where the time goes** splits each chat's lifetime, from creation to settling, into what it
  waited on: the model, commands, tools, approvals, the queue, usage limits, helpers, you, and
  the time before settling.
- **Weak points** ranks findings such as repeated or slow commands, failed runs and low cache
  reuse. Select one to list only the chats it hit.
- **Steps** groups shell commands by what they were for.
- **Daily trend**, the **breakdowns** and the **chat list** compare days, projects, kinds and
  models. On the web, select a column heading to sort the list; mobile lists the newest settled
  chats first. **Show more** reaches every chat of the period. Select a chat to open its deep dive.

## A single chat

The deep dive shows a timeline of the chat's runs and helpers, colored by model, with markers for
events such as restarts and usage limits. Below it are the steps, the slowest and most repeated
commands, and the findings with advice on what to change. **Open chat** returns to the
conversation.
