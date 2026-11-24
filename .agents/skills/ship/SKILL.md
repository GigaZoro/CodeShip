---
name: ship
description: Finish a T3.CodeShip branch end to end without a PR. Commit the work, land it on main under the landing turn (`vp run check:changed` runs before the wait), confirm it landed, then delete the branch locally and on the remote and remove its worktree. Use for "commit, push, merge to main", "ship it", "land this", "merge and delete the branch", "finish this branch" or "/ship", and when a task in this repository is done (AGENTS.md, "Ship finished work"). Not for when the developer asked for a PR or review first, or asked only to commit.
---

# Ship

Invoking `/ship` is the developer's go-ahead to commit and push to the default branch, and so is finishing a task in this repository ([AGENTS.md, "Ship finished work"](../../../AGENTS.md#ship-finished-work)). Do not ask again.
`$ARGUMENTS` may carry a commit title or a branch to land on. Default to the remote's default branch.

## 1. Orient

- `git status --short --untracked-files=all`, `git branch --show-current`, `git worktree list`, `git remote -v`.
- Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`.
- The first `git worktree list` entry is the main checkout. Note whether you are in a separate worktree.
- Already on the default branch: do steps 2-5, push it, report, and skip cleanup.
- Nothing to land: the tree is clean and, after `git fetch origin`, `git merge-base --is-ancestor HEAD origin/<default>` holds. The work is already on the default branch, so skip to step 7, then report and settle.

## 2. Stage deliberately

- Read the diff. Stage paths by name, never `git add -A`.
- Leave out plans, scratch files, screenshots, logs, `.env`, `.t3/`, and secrets. Move untracked files you cannot place out of the worktree, to your scratchpad, and name them in your report. The push gate accepts only the tree `check:changed` checked, and that tree includes untracked files.
- Prepend a dated entry to `docs/release-notes.md` (`## YYYY-MM-DD — Title`, then user-facing bullets), even for docs or maintenance. See [Release notes](../../../docs/operations/release.md#release-notes-for-every-shipment).

## 3. Pre-check

- For code changes, run the harness's pre-commit step (such as `/simplify`) first when it has one. Skip it when only docs or tests changed.
- Fix what it finds before you commit. The check that counts runs in step 5.

## 4. Commit

- Conventional title in plain language (`fix(web): new threads no longer spike CPU`). In the body, give the problem in a sentence or two, then the fix.
- End with the attribution trailer the harness gives. Pass the message through a heredoc.

## 5. Land

Main grants its landing turn in arrival order, so a pass of `vp run check:changed` covers the tree that is pushed against the commit main is at when it lands. Run the landing with `t3_command_run` (`timeoutMinutes: 720`; it may wait for the turn behind other landers):

`node .github/scripts/landing-turn.cjs land`

A branch behind main is rebased onto it first, and the landing then starts again from the rebased tree, so it waits with the rebased copy of the script, which holds main's changes to it. It runs `vp run check:changed` against main before the wait, in a private checkout of the commit so nothing in your worktree can reach it, like any other run, then takes the turn (a lease on `refs/heads/landing-lease/main` on origin), pushes `HEAD` to `main` as a fast-forward and gives the turn back. When main moved during the wait, it rebases and runs the checks again under the turn first, where they get the next free check slot ahead of other runs. A pass records the tree it checked, uncommitted and untracked files included, so `land` refuses to start in a worktree with anything uncommitted or untracked. Main refuses a push from anyone who does not hold the turn, or for a tree no `check:changed` pass covers (`.vite-hooks/pre-push`), so never push to main any other way, never pass `--no-verify`, and never use `--force` or `--force-with-lease`.

- A check that fails ends the landing with exit status 1, before it waits or with the turn released: fix the cause, commit, and land again.
- A rebase that conflicts stops the landing, before it waits or with the turn released: resolve it, then land again.
- `head-moved`: the checkout moved to another commit while the landing ran, so it pushed nothing: land again from the commit you mean to land. A landing owns its checkout until it ends, so nothing else switches, commits or edits there meanwhile.
- A fetch or push of main that stops answering ends the landing after ten minutes, with the turn released. A push that ran out of time may still have landed: land again, and an unchanged commit lands as a no-op.
- Branch protection that refuses the push: stop and offer a PR instead.
- Confirm with `git fetch origin && git merge-base --is-ancestor HEAD origin/<default>`.

## 6. Verify the landing

The command prints the landed commit. The rebase may have changed your commit's id, so use the printed one in your report.

## 7. Clean up

Touch only the branch and worktree you just landed. Never touch another session's.

1. Stop the dev servers you started, by the PIDs you recorded. Never kill by pattern.
2. Main checkout: if `git -C <main> status --short` is empty, run `git -C <main> merge --ff-only origin/<default>`. If it is dirty, leave it alone, because another agent may be working there.
3. Remote branch: only if `git ls-remote --exit-code --heads origin <branch>` finds it, run `git push origin --delete <branch>`.
4. Local branch: `git switch --detach`, then `git branch --delete <branch>`. Never use `-D`.
5. Delete the scratch files you created: temp dirs, database copies, logs.
6. Worktree, last, because it is usually your cwd: `git -C <main> worktree remove <path>`. Run it in the foreground with a 600000 ms timeout, never in the background: deleting `node_modules` takes minutes, a background command's completion notice starts another turn on this thread, and a turn start rebuilds the thread's missing worktree. Ignored files such as `node_modules` and `.t3` do not block it. If it refuses because of modified or untracked files, stop and report them. Never use `--force`.

## 8. Report

Give the commit SHA and title, the checks you ran and their results, and what the push triggers (CI, releases). Then list what you cleaned up and anything you skipped, with the reason.

## 9. Settle the thread

Only when the work is on the default branch, because step 6 confirmed the commit landed or step 1 found nothing to land: if the T3.CodeShip `t3_thread_organize` tool is available, call it with `action: "settle"` and no `threadId`. It settles this thread when the turn ends. Skip this step when you stopped early (checks failed, push rejected, or you are waiting on the developer).
