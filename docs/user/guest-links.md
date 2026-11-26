# Guest links

A guest link lets a teammate follow one thread in their browser and ask the agent questions, with no
account. They see your messages and the agent's replies as they stream. Each message they send waits
until you send or dismiss it, unless you make the link [read-only](#read-only-links).

## Share a thread

Guest links are a beta. Turn on **Settings → Machines & access → Guest sharing** for the machine that runs the
thread. They also need [T3 Connect](./remote-access.md): sign in and link that machine, because the
link points at its T3 Connect address. The machine must stay online while the guest uses it.
While the setting is off, every guest link on that machine stops working; links that have not
expired work again when you turn it back on.

1. Right-click the thread in the sidebar and choose **Share with guest**. It is also in the thread
   menu and the command palette. In the mobile app, long-press the thread in the list.
2. Under **Guest messages**, choose **Wait for me** to send or dismiss each message yourself, or
   **Read-only** to let them run at once (see below). Under **Link expires after**, choose 1 hour,
   1 day, 7 days, or 30 days. New links last 1 day unless you pick another.
3. Copy the link and send it to one person. It works in one browser until it expires. Opening it
   again in that browser takes them back to the thread.
4. On a **Wait for me** link, each message they send appears at the end of the thread and the
   sidebar shows **Request**. Choose **Send** to run it as a normal turn, or **Dismiss**. Files they
   attached show with the message, and **Send** includes them.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
unlinking the machine from T3 Connect also ends it. The mobile app can send, dismiss, and stop
sharing too.

## Read-only links

A read-only link lets the guest ask the agent to look at the project, for example to explain code
or find the cause of a bug, without you sending each message. Their messages run straight away, and
the agent cannot change files. While the agent works, the guest waits to send the next one.

- While the link exists, every turn on the thread runs read-only and never asks for approval,
  including yours, and plan mode is set aside. This lasts after the link expires: choose **Stop
  sharing** to give the thread its usual permission mode back. The share bar shows **Read-only**
  while it applies. A run that started read-only, and anything that continues it, stays read-only
  after you stop sharing.
- Opening a read-only link restarts the thread's agent session, so wait for the current run and
  any background work to finish, or stop them first. A watched pull request does not hold it up.
- Host the thread on a Mac and sign in to Claude locally with a personal Pro or Max account.
  The agent can search and read files. Connected tools, plugins, and hooks are disabled.
  CodeShip checks the account, managed settings, and the local sandbox before starting each guest turn.
- On other hosts or providers, choose **Wait for me** to review each guest message yourself.
  Switching to an unsupported provider during read-only sharing prevents new turns from starting.
- The agent can read files outside the project. The guest can see what the agent reads and
  includes in the thread.
- If CodeShip cannot create a turn for a guest message, it waits for you to send or dismiss.
  Once a turn exists, a provider refusal appears in the shared thread. For example, if Claude
  cannot verify the account, switch to an eligible account and have the guest send the prompt again.
  If the sandbox is unavailable, you can create a **Wait for me** link instead.

## What the guest sees

The guest sees the thread's recent history and everything after, in the same timeline you see, as
it streams: messages and their files, the agent's replies with the images they show from your
machine, its reasoning, plans, questions, and its work, with command output when they expand a
command. Their composer shows the thread's model, but they cannot change it. They do not see diffs, and they cannot act on the thread: no forking,
reverting, opening files on your machine, or answering the agent for you.

Anything the agent read or printed can show, such as a value from a file. Share only threads you
are comfortable showing.

## Guest attachments

Guests can attach images and other files to a message: use the paperclip, paste, or drop them on
the message box. A message holds up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or
WebP. While messages wait for you, their files can total 20 MB; the guest can attach more once you
send or dismiss some.

Dismissing a message, ending the link, or archiving the thread deletes the files of messages that
still wait. A sent message keeps its files, like any message in the thread.

On a **Wait for me** link, the guest's text and files run with the thread's current permission mode
once you send them. Check them before you choose **Send**, as you would anything pasted from a chat.
