# Running T3.CodeShip in the background

On Linux, macOS, and Windows, T3.CodeShip can run as a service for your user so you
do not need to keep a terminal open.

## Manage the service

Install the `t3` CLI first ([Install T3.CodeShip](./install.md#command-line)), then
run these commands on the machine that will host T3.CodeShip:

| Task                                  | Command                |
| ------------------------------------- | ---------------------- |
| Set up access from your other devices | `t3 up`                |
| See how your other devices reach it   | `t3 status`            |
| Install and start                     | `t3 service install`   |
| Inspect status and log location       | `t3 service status`    |
| Move to a newer release               | `t3 update`            |
| Restart                               | `t3 service restart`   |
| Stop and remove from startup          | `t3 service uninstall` |

The service never writes a pairing code to its log. To connect a device, run
`t3 pair` on the host, or `t3 up` to set up access from your other devices.

Uninstalling the service leaves your projects, threads, and settings intact.
Running `t3 service install` again repairs a service that `t3 service status`
reports as broken.

A command that starts or restarts the service, such as `t3 up`, returns once
T3.CodeShip is serving, so `t3 pair` works right after it. When T3.CodeShip has
not started within 2 minutes, the command says so and names the log to read.

`t3 update` downloads the newest release on your channel and switches `t3`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `t3 service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3.CodeShip](./updating.md).

Pass an exact version (`t3 update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `t3 update` ask for confirmation before
installing one.

`t3 uninstall` removes the background service, the `t3` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.t3/userdata` are kept, along with `service.env`
under T3 home. Pass `--yes` from a script.

## Local network access

A new service answers only on this machine. Other devices reach it through
T3 Connect, or directly once you choose the local network in `t3 up` (or run
`t3 up --lan`, which sets `T3CODE_LAN=true` in `service.env`). It then listens on
your local network and Tailscale addresses, so the desktop and mobile apps on
the same network connect directly instead of through T3 Connect. It still does
not answer on public addresses. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. The hosted web app at app.t3.codes
stays on T3 Connect, because browsers block plain HTTP from an HTTPS page.

A service installed before `T3CODE_LAN` existed keeps listening on the local
network. `t3 status` says so, and `t3 up --no-lan` turns it off. Any
`T3CODE_HOST` value replaces this setting.

## Configure the service environment

Put custom environment variables in `service.env` under the service's T3 home
directory, normally `~/.t3/service.env`. This file survives service installation
and updates. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `T3CODE_HOME`,
`T3_BOOT_SERVICE_UNIT`, `T3_SERVICE_LAUNCHER_CONTEXT`, and
`T3_SERVICE_LAUNCHER_DELEGATE` (including case variants).

Run `t3 service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `t3 service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default T3 home, `chmod 600 ~/.t3/service.env`).

## Use 1Password for provider variables

In **Settings → Secrets**, select the environment that runs the provider and add
a 1Password source. Then open that instance in **Settings → Providers & models**.
In **Environment variables**, select the source for a sensitive value and enter
its `op://` field reference. T3.CodeShip saves the reference and resolves it on
the environment's host for that provider instance. The provider process receives
the resolved value.

### Mac desktop integration

Install 1Password CLI on the Mac, sign in to the 1Password app, and turn on
**Settings → Developer → Integrate with 1Password CLI** in that app. Confirm
`op --version` works for the user who runs T3.CodeShip, then select
**Desktop integration** and enter your 1Password account when adding the source. Keep the
Mac logged in and approve the app prompt when a provider needs to read a secret.
[1Password CLI setup](https://www.1password.dev/cli/get-started)

### Linux service account

Use a dedicated custom vault with just this host's automation credentials. Create
a 1Password service account with only `read_items` on that vault and install
1Password CLI 2.18 or later at `/usr/bin/op` from the vendor's signed package.
Keep the CLI executable and its parent directories root-owned and writable only
by root. A 1Password desktop app and interactive unlock are unnecessary.
CodeShip checks instances whose secret references all allow unattended reads
about every five minutes. It applies changed values after the provider has no
live sessions and keeps the last working value if the vault cannot be read.
A running session keeps the credentials it started with.
[Install 1Password CLI](https://www.1password.dev/cli/get-started),
[set up a 1Password service account](https://www.1password.dev/service-accounts/get-started).

Have a host administrator create a dedicated unprivileged `codeship-op` OS
account with a locked password, a non-login shell, and a private home owned by
`codeship-op`. Give that account no other workloads or sudo privileges. Put the
service account token in an `OP_SERVICE_ACCOUNT_TOKEN` assignment in
`/etc/codeship-op.env`, owned by root with mode `0600`. Provision the file through
a protected administrative session and keep the token out of shell history,
terminal recordings, `service.env`, and T3.CodeShip settings.

Edit `/etc/sudoers.d/codeship-op` with `sudo visudo -f /etc/sudoers.d/codeship-op`.
Replace `codeship-host-user` with the OS user running T3.CodeShip. To use this
example, create the `Setup` item in the `CodeShip` vault with a `check` field
containing a harmless nonempty value.

```sudoers
Cmnd_Alias CODESHIP_OP_READ = /usr/bin/op --cache=false read --no-newline op\://CodeShip/Setup/check
Defaults!CODESHIP_OP_READ env_reset, !env_keep, !env_check, always_set_home, !use_pty, env_file=/etc/codeship-op.env
codeship-host-user ALL=(codeship-op) NOPASSWD: NOSETENV: NOLOG_INPUT: NOLOG_OUTPUT: CODESHIP_OP_READ
```

List each allowed reference as a separate exact command in the alias. Use stable
vault, item, section, or field IDs when the names contain spaces or punctuation
the source does not accept. Escape the colon in sudoers as shown and enter the
ordinary `op://` reference in T3.CodeShip. Keep this grant free of wildcards,
extra flags, and `SETENV`. Keep the sudoers fragment root-owned with mode
`0440`, run `sudo visudo -c`, and review the effective rules with
`sudo -l -U codeship-host-user`. Check that the T3.CodeShip user has no broader
grant to run commands as root or `codeship-op` and that PAM or other sudo
configuration does not supply competing `OP_*` values. Ordinary sudo audit
events can record the reference. Keep command input and output out of logs.
[Ubuntu sudoers manual](https://manpages.ubuntu.com/manpages/noble/man5/sudoers.5.html)

Run this in Bash as the OS user running T3.CodeShip. It checks that the read
succeeded and returned a value while discarding the field output. Use a shell
without tracing or terminal recording.

```bash
(
  set -o pipefail
  bytes=$(
    /usr/bin/sudo -n -u codeship-op -- /usr/bin/op --cache=false read --no-newline \
      'op://CodeShip/Setup/check' </dev/null | wc -c
  ) && test "$bytes" -gt 0
)
```

Select **Linux service account** when adding the source, then map only
the approved fields to the provider instances that need them. Any process running
as the T3.CodeShip OS user can ask sudo for those same fields, so use a dedicated
host user when that access needs isolation. Sudo passes the token to `op` under
`codeship-op` without placing it in the T3.CodeShip process environment. After
rotating the token, replace the protected file, rerun the check, and refresh
provider status. Restart any running provider session that needs a newly resolved
field value.

## Platform support

Linux needs systemd user services. Setup enables lingering so T3.CodeShip starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows starts the service when you log in and stops it when you sign out. It
runs without a window as the `t3code-<domain>-<user name>` task in Task Scheduler, and Task
Scheduler starts it again within a minute if it exits. Lock the screen instead
of signing out, and keep the PC awake, for unattended remote access. Installing
over SSH while nobody is signed in at the PC can fail at the final start step;
the service is still installed and will start at the next sign-in.

### Host-managed agent memory on Linux

By default, T3.CodeShip applies automatic memory limits to the systemd user slice
`app-t3code-agents.slice`. If you manage that slice's memory budget yourself, set
`T3CODE_AGENT_SLICE_MEMORY_POLICY=host-managed` in the server's environment (or
its `service.env`) and restart the server. T3.CodeShip then leaves `MemoryHigh` and
`MemoryMax` untouched while keeping per-thread scopes, cleanup and OOM reporting.
Unset the variable or set it to `automatic` to restore automatic limits on restart.

The slice is shared by T3 servers running as the same OS user, so configure all
of them consistently. This option does not remove runtime overrides written by
earlier starts. Apply your intended limits with `systemctl --user set-property
--runtime app-t3code-agents.slice MemoryHigh=… MemoryMax=…`. Restarting the server
or user manager does not clear those runtime configuration files; they can remain
until the next reboot.

`t3 up` installs the service when you set up T3 Connect, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Keep the server responsive when agents use all memory

Agents and the commands they run already have a lower CPU priority than the
server. When they fill a Linux machine's memory, though, the kernel may still
slow down or stop the server, because only an administrator can reserve memory
for it. Run, as your normal user:

```sh
t3 service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `t3 service restart`. `t3 service status` reports whether
the protection is in place, and `t3 service protect --undo` removes it.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3.CodeShip as root creates a separate installation and Connect
identity. Without administrator access, run `t3 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and, on Linux, `systemctl --user status t3code.service`, then use the repair command printed by T3.CodeShip.      |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `t3 service restart`.                            |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `t3` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

T3.CodeShip removes internal history older than a day on its own while it runs;
your conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

When the desktop app or the background service runs T3.CodeShip on that machine,
select **Reclaim** in Settings on web or desktop. T3.CodeShip checks for free disk
space, then stops, repairs the database, and starts again. It is offline while
the repair runs, and running agents stop. If the repair fails, Settings shows
why.

In other cases, such as a server you started by hand, run `t3 doctor` on the
machine that hosts the environment. It reports the database size and the
space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use, and names the server
process that holds it when it can tell. While the repair runs, a server started
for the same data directory, for example by a desktop app connecting over SSH,
is refused until the repair ends. Use `--base-dir` for a different data
directory.

The repair's time grows with the size of the whole database, not only the
space it reclaims, and can exceed an hour on a large database or a slow disk;
`t3 doctor` shows each step as it runs. It rebuilds the database through a
temporary copy, so it needs free space of about twice the data still in use
(the database size minus the reclaimable space): once in the system temporary
directory (on Linux and macOS, `TMPDIR`, or `/var/tmp` when it is not set) and
once next to the database for its write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `t3 doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings. It does
not offer to delete it while any project or thread you have not deleted is
missing from the current database, so the old file stays available for
recovery.
