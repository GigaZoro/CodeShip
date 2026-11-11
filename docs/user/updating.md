# Updating T3.CodeShip

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Machines & access** offer to update it. The desktop
app checks for new releases on its own, so the update button appears only when
there is something to update.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel. Hover the button to see what
it will update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Each server checks that it can install the release before it restarts. If the
release is not available to a server yet, its update fails, the server keeps
running, and you can retry. The confirmation lists each machine it skips and
why, such as a machine that is offline or needs a manual update. Use
**Settings → Machines & access** for those.

If a desktop app restarts on its old version, T3.CodeShip tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Safe update with running chats

When chats are running on the desktop app's own server, installing its update
from the update button or **Settings → Maintenance & about** becomes a **Safe update**. The
confirmation lists the chats that resume after the restart, and any waiting for
your answer, which stop and need a reply. T3.CodeShip saves where each running chat
is, installs the update, restarts, and resumes them, even when **Continue
threads after restarts** is off. An update another device starts follows that
setting instead.

A restart stops background work: a command, task or subagent a chat started and
is waiting on, such as a test run. When chats are waiting on such work, the Safe
update lists it, and **Update when it finishes** installs the update once the
listed work is done, so the chats still get its results. Work the chats start
after you choose this does not delay the update: the restart stops it, and the
chats restart it when they resume. While it waits, the update button shows how
many of the listed tasks are still running; open it to **Update now** or **Stop
waiting**. A dev server or watcher left running does not hold the update, and
neither does a chat that is only waiting for another chat or a delegated task:
it resumes after the restart and waits again, while the other chat's own work
holds the update if it runs on this server.

Updating a server on another machine waits the same way for the work its chats
are waiting on, and shows **Waiting for background work** with **Update now**
and **Cancel**.

## Switch between Stable and Nightly

In the desktop app, change **Settings → Maintenance & about → Update track**. T3.CodeShip shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last. Your threads,
settings, and data stay.

A background service cannot move to an older release remotely. When Stable is
older than its Nightly, run `t3 update --channel stable --allow-downgrade` on
that machine.

A switch is blocked for a machine whose database already has changes the
target release does not support, or when T3.CodeShip cannot confirm that it does.
The dialog says why: update a machine on its current track first when its
release is too old to check, or wait until the target track includes the
changes. A Mac running the desktop app must switch on that Mac.

Each machine keeps the new track even if its switch did not finish, but it
moves to that track only through a switch. **Update track** shows how many
machines still run the other track. **Review** opens the same dialog with fresh
checks.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance & about → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3.CodeShip must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message. Scheduled-task runs also stay stopped when
a newer occurrence has started or their scheduled window has ended.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3.CodeShip versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3.CodeShip on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

### macOS app does not reopen after an Alpha update

Updating an older **T3.CodeShip (Alpha)** installation can replace it with
**T3.CodeShip (Beta)** without reopening the app. Open **T3.CodeShip (Beta)** from
Applications, or run:

```sh
open "/Applications/T3.CodeShip (Beta).app"
```

If an old Dock shortcut no longer opens the app, remove it and add the Beta app
from Applications again.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, T3.CodeShip shows a "T3.CodeShip
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Registries and proxies

Each server checks T3.CodeShip releases, and providers installed with npm, through
its own npm, so the checks use npm's configured registry, authentication, and
proxy settings. Providers installed with Homebrew or pnpm check through those
tools.
Configure npm on the server's machine. If that registry cannot be reached, the
release shows as unavailable; T3.CodeShip does not try the public registry instead.
Machines without npm check the public npm registry directly.

## Update providers

**Settings → Providers & models** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, T3.CodeShip refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. In **Settings → Maintenance &
about → Provider updates**, choose **Off**, **Notify me**, or **Install automatically**.
Automatic installation also enables checks and updates provider CLIs when the server
starts. **Notify me** and **Install automatically** both download the latest model
catalog; **Off** leaves manual updates available.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider updates and restart continuation preferences are in
**Settings → Maintenance & about**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
T3.CodeShip downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
