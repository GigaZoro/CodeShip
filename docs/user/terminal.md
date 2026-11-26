# Terminal

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the environment that launches the T3.CodeShip server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
T3.CodeShip tries its usual fallback shells.

On Windows, to use Git Bash from a standard Git for Windows installation, run
this in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit T3.CodeShip, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart T3.CodeShip.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3.CodeShip removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3.CodeShip restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

While a terminal is focused, use `Cmd+Shift+]` for the next terminal and `Cmd+Shift+[` for
the previous one on macOS. On Windows and Linux, use `Ctrl+Alt+]` and `Ctrl+Alt+[`. Cycling
wraps through tabs and split panes in the focused drawer or right panel. Rebind these
shortcuts in Settings > Keybindings.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## Agent access

Agents can read the recent output of their thread's terminals, such as a dev
server you started or a command that failed, so you can ask about it instead of
pasting it. They see plain text, as the terminal shows it.

**Agent terminal access** in **Settings → Browser & devices** sets what they
may do:

- **No access**: agents can't see terminals.
- **Read output** (the default): agents read output but can't type.
- **Read and run commands**: agents can also type into a thread's terminal,
  such as to restart your dev server, and see what it prints. You see what
  they type. When the thread has no terminal running, the agent opens one in
  the thread's folder. This works only in threads with Full access permissions,
  since a command typed there skips approval. An agent won't type into a
  terminal you typed in during the last few seconds, or where you left a
  command unsent; it asks you instead. While an agent typed last, the
  terminal's name ends in "· agent".

After T3.CodeShip restarts, agents can read a terminal's saved output before
you open the terminal panel again.

### Terminals on another machine

An agent can also run commands in a terminal on a
[linked machine](./remote-access.md#link-another-environment), such as your PC
from your Mac. It types into the terminal of a thread on that machine, so you
can watch it in that thread's terminal panel. Both have to allow it:

- the link from this machine was paired with **Full access**, and the agent's
  thread here runs in Full access;
- the other machine's **Agent terminal access** is **Read and run commands**.

Reading a linked machine's terminals needs only **Read output** there.

Pick a project in the "Applying settings for …" sentence to change it for that
project only. Changes apply right away, including to agents that are already
running.

## fish

T3.CodeShip starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3.CodeShip's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3.CodeShip. A shell export applies
when you launch T3.CodeShip from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
