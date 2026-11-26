# CodeShip releases

See [03 · release](03_release.md) for the shared architecture and procedures.

## Releasing from a fork

`release.yml` only runs in `pingdotgg/t3code`. A fork ships its own installers with
`.github/workflows/release-fork.yml` on every push to `main`, or by hand from `main` to set a
version (**Actions → Release (fork) → Run workflow**). It packages Windows x64 (NSIS) through the
same `release-desktop.yml` on GitHub-hosted runners. A Linux x64 job also runs: the Windows app
embeds its CLI archive as the WSL runtime, and the release publishes that archive with `SHA256SUMS`
and `install.sh` for Linux servers. Its Linux installers are not published.

The macOS arm64 app (DMG and the zip updates use) comes from `release-fork-macos.yml` (**Release
(fork) macOS**), which the release starts once it is published, because GitHub can run short of
hosted macOS runners for hours and Windows and Linux do not need one. Until it attaches the app and
its `latest-mac.yml`, the release serves the previous release's `latest-mac.yml` with its file
links pointing back at that release, so Macs stay on the build they have instead of failing their
update check. Only one macOS build runs at a time; a newer release's waiting build replaces an
older one's.

The release is marked latest in the fork's own repository, with the updater manifests, so
desktop apps built by that workflow offer each new release through the update button. The server,
web and desktop bundles read the same repository at build time (`T3CODE_DESKTOP_UPDATE_REPOSITORY`,
else `GITHUB_REPOSITORY`), so `t3 update`, a server's update button and Desktop-managed SSH install
the fork's CLI, not upstream's. The server also reports it to clients (`releaseRepository` in its
environment descriptor), and the mobile app checks a server's updates there. Updates are read
without credentials, so the repository must stay public. To install a Linux server:

```bash
curl -fsSL https://github.com/GigaZoro/CodeShip/releases/latest/download/install.sh \
  | T3CODE_RELEASE_REPOSITORY=GigaZoro/CodeShip sh
t3 service install
```

Builds use the public T3 Connect identifiers in `.env.example`. Releases also fail for reasons
outside the build: a job waiting for a GitHub-hosted runner is cancelled after about 15 minutes
without one, and GitHub outages make downloads such as Electron's time out for hours.
`release-fork-retry.yml` retries a failed release while its commit remains the head of `main`.
Jobs that never got a runner can retry immediately, up to 24 attempts. Other failures get two
immediate retries followed by the half-hourly schedule. The schedule also starts a missing release.

For the latest macOS release, the initial build, reruns and replacement dispatches share a budget
of three immediate attempts and 24 attempts in total. Before reusing a run, recovery checks that
its JS bundle came from the publishing run. If only attachment failed and the signed app artifact
is available, it retries attachment even after the JS bundle expires. When it cannot verify an
older run’s source, recovery starts a fresh build with the publisher’s bundle if available.
To repair a release by hand, run **Release (fork) macOS** from the published tag and enter its
version. Older tags also require the publishing run ID.

Main also prepares the macOS Codex metadata package in a separate workflow. A release tag can reuse the verified archive from main when its native build recipe matches. A cold cache can build the tag’s own recipe. Windows and Linux publication run independently of the Mac runner.

- **One-time setup.** Forks start with Actions disabled; enable them in the fork's Actions tab.
  Most other workflows ask for upstream's Blacksmith runners, which a fork does not have, so their
  jobs wait in the queue until GitHub cancels them. Disable the ones that run on push or pull
  request (such as CI) in the Actions tab.
- **Versions.** An empty `version` input releases `<year>.<MMDD>.<n>`, such as `2026.1030.1`. Clones
  of a fork also fetch upstream's `v0.x` tags, and a fork tag with the same name as one of them
  makes every later fetch fail with "would clobber existing tag". An explicit version must be
  higher than the installed one, or the update button never offers it. The committed
  `package.json` versions stay upstream's, and stamping the release version keeps the replaced
  one as `t3CodeVersion`: the model manifest's provider compatibility policies name T3 Code
  versions, so the server matches their `t3CodeRange` against it.
- **Windows signing.** Windows builds are unsigned unless the fork has the Azure Trusted Signing
  secrets described below. SmartScreen warns on the first install (**More info → Run anyway**);
  updates install without it.
- **macOS signing.** An ad hoc signed app cannot apply an update, because Squirrel.Mac only accepts
  a new version whose signature satisfies the running app's designated requirement, and an ad hoc
  requirement is that one build's hash. **Release (fork) macOS** stops in preflight without a
  signing identity, so Macs stay on the build they have.
  Without a Developer ID, use a self-signed one: every build signed with one certificate shares a
  requirement. Create it once, keep the folder, and add the base64 text and the password as the
  `MACOS_SELF_SIGNED_CERTIFICATE` and `MACOS_SELF_SIGNED_CERTIFICATE_PASSWORD` repository
  secrets. Losing it means installing the next build by hand.

  ```bash
  mkdir -m 700 codeship-signing && cd codeship-signing
  openssl rand -hex 16 > password.txt
  openssl req -x509 -newkey rsa:2048 -nodes -days 7300 -subj "/CN=T3.CodeShip Self-Signed" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout signing.key -out signing.crt
  openssl pkcs12 -export -inkey signing.key -in signing.crt -name "T3.CodeShip Self-Signed" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout file:password.txt -out signing.p12
  rm signing.key && base64 -i signing.p12 > signing.p12.base64.txt
  ```

  Self-signed builds are not notarized. The first time a Mac opens a downloaded build, macOS
  blocks it: open it from **System Settings → Privacy & Security → Open Anyway**. A Mac running an
  ad hoc build installs the first self-signed one by hand; later releases update in place, and
  privacy permissions carry over between them. Keychain access does not, because macOS tracks it
  by Apple Team ID, so builds without one never use the Keychain: they save the T3 account sign-in
  and the saved connections unencrypted, in files only the user can read
  (`apps/desktop/src/app/DesktopKeychain.ts`).

## Release notes for every shipment

Before shipping any change to `main`, prepend an entry to
[`docs/release-notes.md`](../release-notes.md) in the same commit or delivery. Use
`## YYYY-MM-DD — Short title`, followed by concise bullets describing what changed
for users. Include fixes, maintenance, and documentation-only shipments; use a new
title when shipping several times on one day. Preserve previous entries unchanged. Entries
stay newest first by date. A rebase or merge keeps that order by itself: `.gitattributes` gives
the file a merge driver, which `vp i` configures and the landing turn passes to its rebase, that
puts one side's new entries into the other side's notes when only that other side edited,
retitled, removed or reordered existing entries. Each entry the driver inserts goes between the
entries around it on its own side, in date order, and the incoming side's entries go above the other side's of the
same date where the entries around them allow either order. Landings on main keep every entry word
for word, so a branch can still reword its own entry in a later commit. The driver leaves the file
to git's text merge, which can conflict, when both sides changed existing entries, when the entries
around a new entry leave it no place, when both sides added one heading with different text or one
entry while one of them also rewrote or removed an existing entry, or when a new entry shares its
title or text with an entry only the other side added or changed: that can be one shipment under
two dates. The check matches earlier entries by content, so a shipment may also move one back into
date order.

The web and desktop header's Release notes dialog bundles this history with the
client, so an older install never presents newer changes as already installed.
`vp run check:changed` compares notes against the branch base, a push to `main` runs the same
check against the remote's `main` (`.vite-hooks/pre-push`, which also requires a check:changed
pass for the pushed tree), and fork release preflight rejects a
push without new notes before building installers. The GitHub
release uses the same notes, adding all entries since the previous published release
when several pushes were combined. Rebuilding the same source uses its latest entry.

## Every push to `main` releases

Every push to `main` on the fork publishes a signed desktop release (`.github/workflows/release-fork.yml`) so installed apps offer it through the update button. Add no path filters, approval steps or other conditions that let a push skip it; a manual `workflow_dispatch` run is only an extra way to set a version.

A release run can stay `queued` for an hour while later commits release first, so do not watch a commit's own run. Fetch tags and test `git merge-base --is-ancestor <commit> <tag>` against `gh release list -R GigaZoro/CodeShip`. `t3_environment_read` shows the `serverVersion` a machine runs; the desktop app installs an update only from its update button unless `installUpdatesAutomatically` is on.
