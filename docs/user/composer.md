# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Formatting

The composer writes Markdown and shows it styled as you type. Markers such as
`**` stay in the text and show beside the styled words when your cursor is on
them. Lines starting with `- `, `1. `, `- [ ] `, `> `, `# ` or `---` become lists,
task lists, quotes, headings and rules; ` ``` ` followed by Enter opens a code
block. What you typed is what the agent receives, markers and numbering
included, and `#1234` without a space still looks up a pull request.

Enter sends. In a list or quote, **Shift+Enter** continues it, and Shift+Enter
on an empty line moves out one level, then leaves it; **Tab** nests a list item
under the one above and **Shift+Tab** moves it back out. In a code block, Enter
starts a new line at the current indentation, **Tab** and **Shift+Tab** indent
the selected lines, and a closing ` ``` ` followed by Enter, or two blank lines
at the end, leave the block. **Backspace** at the start of a code block turns it
back into plain lines. Choose the language in a code block's corner to change
it. Very large code blocks are shown without syntax highlighting.

## Attach files

Attach up to 100 files per message. Each image can be up to 10 MiB, with at most
80 MiB of images in one message. Other files, including videos, can be up to
50 MiB each, subject to the environment's upload support and limit. The agent
receives them on the environment's machine. Provider and model limits still
apply, including images already in the conversation. A video attachment gives
the agent a file path; only [Antigravity](./providers-antigravity.md#skills-and-attachments)
sends supported videos to Gemini models as video.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to T3.CodeShip through another app's system share sheet.
On Android, you can also drag images from another app into the message input
in split screen.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → Chat & diffs → Follow-up behavior** to decide
what a message sent while the agent works does: **Steer** adds it to the running turn,
**Queue** sends it when the turn ends, and **Stop and send** stops the turn and sends it
in its place. Stop and send needs an agent that can restart a turn, such as Codex,
OpenCode, or Cursor; with Claude and others it steers instead. The setting applies to
this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited or removed before they send.
When Enter sends, `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses
the alternate action: it steers when your default is Queue and queues otherwise.
To pick any of the three for one message, open the arrow next to the send button.
If your **Send shortcut** requires `Cmd+Enter` or `Ctrl+Enter`, that shortcut uses
your default follow-up behavior; add **Shift** to use the opposite action. This
applies only to multiline messages when you choose the multiline send option.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. If that shortcut sends the opposite
action for your draft, move focus outside the composer to steer the queued message. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Chat**. While a turn is
running the send button shows which action it will take. Long-press it to choose
another action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer, and Stop and send, when the running agent supports them.

## Queue messages for an offline machine

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

On web and desktop, a plain-text message to an existing thread whose machine is
offline waits in that browser or app: the send button reads **Queue until … reconnects**.
The waiting messages show above the composer, where **Edit** puts one back in the
composer and **Cancel** drops it. They send in order once the machine is back, behind
a run that is still going, and a message the machine refuses stays there with the
reason. Attachments and context still need the machine connected.

## Custom models

On web and desktop, use Settings → Providers & models → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

To rename a built-in model on every client, edit the server's `settings.json` in its `userdata`
directory. Add a custom model entry with the built-in model ID and a new name under that provider
instance:

```json
{
  "providerInstances": {
    "codex": {
      "driver": "codex",
      "config": { "customModels": [{ "slug": "gpt-5.5", "name": "Team GPT" }] }
    }
  }
}
```

## Model defaults

T3.CodeShip remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection. [Auto](./thread-sidebar.md#inspect-agent-work)
runs the provider and model you choose in **Settings → Providers & models** and picks the
account for you.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

On mobile, long-press an assistant response, adjust the text selection, and choose
**Cite** to insert a quote at the composer cursor. Tap a quote in a draft to add
or edit its comment, or to remove it. To open the source message, tap a quote in
a draft or sent message, then choose **Go to message**.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

Choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. On mobile it is the pencil button under the message. Choose **Edit and keep files** to
leave workspace files as they are, or **Edit and undo file changes** to put the workspace back
to its checkpoint from before that message. That also undoes edits you made yourself.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

Voice input depends on Apple's on-device speech transcription. On a device without
it, the composer has no microphone button and **Settings → Microphone** says voice
input isn't available.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Voice input records from the first connected microphone in **Settings → Microphone**.
The list mixes kinds (built-in, other wired, other Bluetooth, CarPlay) with wired and
Bluetooth devices you have dictated with, listed by name. Drag to rank them together:
for example, put **Other Bluetooth** above your AirPods so a new headset is preferred
while the AirPods microphone stays low. By default, CarPlay comes after the built-in
microphone. Swipe a device left to forget it.

Transcription runs on your device. T3.CodeShip deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Stop agent** while the agent is working (`Cmd+.` on macOS,
`Ctrl+.` on Windows and Linux). It stays while you type, next to a send button that shows your
[Follow-up behavior](#send-while-the-agent-is-working): a queue icon for Queue, a steer arrow for
Steer, or a restart arrow for Stop and send. Click it or press your send shortcut to use that action. Hold `Cmd` on macOS or `Ctrl` on
Windows and Linux to switch the button to the opposite action, then click, or use the opposite-action
shortcut described above.

On web and desktop, queued messages appear at the end of the thread as dashed messages that have
not been sent yet. On mobile they appear above the composer. Each shows its text and any attached
images. **Send now** sends a message right away, into the running turn if there is one. You can
also edit or remove it. On web and desktop, **Undo** in the notice after removing a message
queues it again, at the end of the queue.

If you stop the agent, queued messages keep their order and are held. After a server
restart they are held until the interrupted turn resumes and finishes, then they run in
order; with **Continue threads after restarts** off, they stay held. When a turn fails, queued
messages are held too, but a notice from the agent's own background work still runs, because the
agent has already started acting on it.
Press **Resume** in an empty composer to continue. **Resume** also continues a stopped
run or one that hit a usage limit or lost its connection, even with nothing queued. Sending a new message also resumes the queue, unless it steers a turn that is already
running. You can edit or remove held messages without starting them.

When a turn stops because the machine lost its internet connection, T3.CodeShip resumes it on
its own once the connection is back, for failures up to a day old. A new thread whose worktree
could not be set up because Git could not reach the remote is set up again the same way, and
then your message is sent. So is a message whose agent failed to start, because the connection
dropped or the computer slept, before it received the message: the agent gets the message once,
as you wrote it. If it fails again right away three times, the thread stays failed
for you to look at. Press **Stop** to keep a waiting thread from resuming. Turn this off with
**Retry threads after network errors** in
**Settings → Threads → Recovery**.

The pencil on a queued message opens it in the composer for editing. The original message
stays in the queue until you save, and it is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** next to it leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment. On
mobile, both are also available before starting a thread on **New task**.

**Settings → Chat & diffs → Skill availability** (or **Settings → Chat** on
mobile) defaults to **By provider**. Choose **Shared across models** to use skills
from other enabled, installed providers on the same environment. This can also be
set for a project. The selected provider wins when names overlap; disabled and
agent-only skills are not offered. Skills that require tools the selected model
cannot use may not work.

Put skills you want in every provider in `~/.agents/skills` on the environment's
machine. Codex, Cursor, and fx read that folder themselves, and T3.CodeShip adds it
to Claude. Keep skills for one provider in its own folder, such as
`~/.claude/skills` or `~/.codex/skills`. Keep each skill in only one of these
folders, because Codex lists both copies of a duplicate. All accounts of a
provider use the same folders, unless you gave an account its own config
directory.

The slash menu also includes skills unless you turn off **Settings → Chat & diffs →
Show skills in slash menu**, under Advanced. This follows the same skill availability setting.

On web and desktop, the **Skills** tab of **Extensions** in the sidebar rail lists every provider's skills
on each connected machine, with what each one does and where its `SKILL.md`
lives. Project skills appear once a thread has used that project with the
provider. With several machines, each gets its own column, and a skill that the
same provider lacks on another shown machine is marked **Not on** that machine; choose
**Copy to** that machine to copy the skill to the same agent there. Skills that are
linked from another folder, such as ones kept in a synced `agent-config`, are not
copied; pull that repository on the other machine instead.
**Filters** narrows the page by provider, source, status, and machine, or to
just those differences.

After you add or change skills, plugins, or MCP servers, use **Restart agent
session** in the command palette on web and desktop. The conversation continues,
and your next message starts the agent again with the new setup.

Provider commands must start the message to run. T3.CodeShip commands such as
`/model`, and skill mentions, work on any line.

Choose **Retry** under the last assistant reply to rewind and send your last message again,
on web, desktop and mobile. A retry whose turn changed no files skips the question about files.
On web and desktop, an unsent draft moves to the [prompt stash](#prompt-stash) first; restore it
from there afterwards. On mobile, clear the message box before retrying.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it, even before the context meter appears.

On web and desktop, the context meter appears once the provider reports usage. Open it
for usage details and **Compact context** when the provider supports compaction.

Claude instances can also compact idle threads for you. See
[compact long conversations](./providers-claude.md#compact-long-conversations).

## Goals

With Codex and Claude, send `/goal` followed by what "done" means, for example
`/goal all tests in packages/api pass`. The agent keeps working across turns
until it judges the goal met. The thread shows **Goal** while it works, and a
line at the end of the thread (above the composer on mobile) shows the goal and
its progress.

- `/goal` alone shows the current goal. `/goal clear` removes it.
- Codex also supports `/goal pause` and `/goal resume`. Stopping a Codex goal
  pauses it, and so does Codex ending its work without meeting the goal.
- Stopping Claude ends the current turn, but the goal stays set. Claude checks it
  again at the end of your next message.
- Sending a new goal, or `/goal resume`, while the agent works stops the current
  turn and starts the goal, unless you queue it. `/goal clear` and `/goal pause`
  stop the turn only when it is working on the goal. Other goal commands wait for
  the turn to end.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Pull requests linked to the thread are included
from any repository and listed first, after any exact number match. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or from a machine it links to while the Linked environments beta is on; those
show the machine's name. On web and desktop you can also drag a thread out of the sidebar and
drop it on the composer; a multi-selection drops together. On any client, **Copy thread** puts a
thread on the clipboard that pastes into a composer as its chip. The chip shows the thread's
current title and opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

A thread from a linked machine, picked, pasted or dropped, stays a reference that the agent reads
on that machine. Dropping a thread from any other environment attaches a saved transcript file. The source
environment must be connected and up to date. The transcript includes the visible history and
saved text context at the time of the drop; later messages and the contents of attached files
are not copied. The agent can read the saved transcript after the source disconnects. Normal
file attachment limits apply.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete T3.CodeShip tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere. A ZIP up to
50 MB opens as a folder list on every surface; on mobile, select a file inside it to preview,
save, or add it to chat.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
For absolute paths outside the workspace, a file missing there can open in your
local editor if it exists on your computer and the app has a local connection.
Paths starting with `~/` always refer to the environment's home directory.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3.CodeShip session.

The file viewer recognizes images, HTML, and PDF files by their filename extension,
including filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
