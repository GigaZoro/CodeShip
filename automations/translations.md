Keep CodeShip's interface translation complete on main without being asked: find UI text that landed untranslated, make it translatable, translate it, and land the fix. Most days there is nothing to do; then say so and stop quickly.

## Context

- This is a CodeShip shared task that runs on one machine per run (Zoro-VPS first, the MacBook as its backup). Every step below works on both.
- Local checkout: `~/Projects/CodeShip`, the CodeShip project's folder on this machine. Do not switch branches, commit, stash, or edit files in it: on the Mac, the user's CodeShip (Dev).app runs from it. Work in a separate git worktree next to it.
- `origin` = https://github.com/GigaZoro/CodeShip.git, the fork's home. Every push to `origin/main` publishes a release. There is no Azure DevOps remote; ignore any instruction that mentions one.
- GitHub credentials: pushing to `origin` over HTTPS uses the credentials this machine saved for github.com, through git's credential helper. On Linux that helper is the GitHub CLI (`gh auth status` shows the signed-in account); on the Mac it is the macOS Keychain. Use no other credentials, and never print or read stored ones. If a push fails on authentication, stop: add a Hands-on item "Sign in to GitHub on <this machine> (CodeShip: keep translations up to date could not push)" to this machine's pending list as the machine-inbox skill describes (on Linux the step is `gh auth login`; on the Mac, signing in to GitHub again so the Keychain holds a valid credential), and say so in the report.
- How translation works and the rules for UI text: docs/internals/i18n.md. Read AGENTS.md first and follow it (no repo-wide checks, no dev servers, never kill processes by name pattern, never touch ~/.t3/userdata).

## Steps

1. In `~/Projects/CodeShip` run `git fetch origin`. Create a worktree from origin/main on a new branch named after today's local date: `git worktree add ../CodeShip-i18n-YYYY-MM-DD -b i18n/YYYY-MM-DD origin/main` (add a suffix such as -2 if it exists).
2. Run `vp i`, then `node scripts/i18n-catalog.ts check` and `vp lint apps/web/src apps/mobile/src apps/desktop/src packages/client-runtime/src`. If the check passes and lint reports no `t3code/no-untranslated-text` findings, remove the worktree and branch, report "Translations are up to date at <origin/main short sha>", and stop.
3. Fix each `t3code/no-untranslated-text` finding as docs/internals/i18n.md describes: text a person reads goes through `t()`, `tn()`, `tx()`, or `msg()` in module-level tables (typed `Message`, translated where shown); text that isn't copy (stored defaults, text sent to the server, agents or git, log-only labels, names) gets `// oxlint-disable-next-line t3code/no-untranslated-text -- <why>`. Keep the English text exactly as written.
4. Follow the `translate-ui` skill (`.agents/skills/translate-ui/SKILL.md`) until `node scripts/i18n-catalog.ts check` passes. Add glossary rows for new recurring terms.
5. Verify in the worktree: `vp run typecheck` in each package you touched (always `apps/web`, `apps/mobile`, `apps/desktop` when you edited them); `vp lint` and `vp fmt --check` on changed files; `vp test run` for the test files beside the files you edited; `node scripts/i18n-catalog.ts check`.
6. Prepend a dated entry to docs/release-notes.md as AGENTS.md describes (`## YYYY-MM-DD — More of the app in Ukrainian`, or a unique title if today's date already has one, with a bullet on what now shows in Ukrainian): every push to main needs one, or its release fails. Commit as `fix(i18n): translate new UI text` and land it on main with the `ship` skill (fast-forward only). Leave `~/Projects/CodeShip` as it is: skip the ship skill's fast-forward of the main checkout. If main moved meanwhile, rebase onto origin/main, keep every release-notes entry with yours on top, repeat step 2's checks and any fixes, and try again. Never force-push.
7. If checks still fail after a reasonable attempt, or a finding needs a product decision, do not push. Leave the worktree in place and report its path, the open findings, and the failing checks.

## Report

Keep it short: the machine it ran on; up to date, landed (the commit sha), or blocked (and why); how many lint findings were translated or suppressed; how many messages were translated; anything left in English on purpose.

## Finish

Whatever the outcome, archive this chat as your last action: call the `t3_thread_organize` tool with action `archive` and no `threadId`, after the report is written.
