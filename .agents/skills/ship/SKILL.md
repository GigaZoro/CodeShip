---
name: ship
description: Finish a T3.CodeShip branch end to end without a PR. Commit the work, run `vp run check:changed`, land it on main with a fast-forward push, confirm it landed, then delete the branch locally and on the remote and remove its worktree. Use for "commit, push, merge to main", "ship it", "land this", "merge and delete the branch", "finish this branch" or "/ship", and when a task in this repository is done (AGENTS.md, "Ship finished work"). Not for when the developer asked for a PR or review first, or asked only to commit.
---

# Ship

Invoking `/ship` is the developer's go-ahead to commit and push to the default branch, and so is finishing a task in this repository ([AGENTS.md, "Ship finished work"](../../../AGENTS.md#ship-finished-work)). Do not ask again.
`$ARGUMENTS` may carry a commit title or a branch to land on. Default to the remote's default branch.

## 1. Orient

- `git status --short --untracked-files=all`, `git branch --show-current`, `git worktree list`, `git remote -v`.
- Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`.
- The first `git worktree list` entry is the main checkout. Note whether you are in a separate worktree.
- Already on the default branch: do steps 2-5, push it, report, and skip cleanup.

## 2. Stage deliberately

- Read the diff. Stage paths by name, never `git add -A`.
- Leave out plans, scratch files, screenshots, logs, `.env`, `.t3/`, and secrets. Leave out untracked files you cannot place too, and name them in your report.
- Prepend a dated entry to `docs/release-notes.md` (`## YYYY-MM-DD — Title`, then user-facing bullets), even for docs or maintenance. See [Release notes](../../../docs/operations/release.md#release-notes-for-every-shipment).

## 3. Verify

- For code changes, run the harness's pre-commit step (such as `/simplify`) first when it has one. Skip it when only docs or tests changed.
- Run `vp run check:changed`. Fix failures. Never land red.

## 4. Commit

- Conventional title in plain language (`fix(web): new threads no longer spike CPU`). In the body, give the problem in a sentence or two, then the fix.
- End with the attribution trailer the harness gives. Pass the message through a heredoc.

## 5. Sync

- `git fetch origin`, then `git rev-list --left-right --count HEAD...origin/<default>`.
- If the branch is behind, `git rebase origin/<default>`, resolve conflicts, and rerun step 3.

## 6. Land

- `git push origin HEAD:<default>`. This is a fast-forward push. Never use `--force` or `--force-with-lease`.
- If the push is rejected because the default branch moved, go back to step 5.
- If it is rejected by branch protection, stop and offer a PR instead.
- Confirm with `git fetch origin && git merge-base --is-ancestor HEAD origin/<default>`.

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

Only when step 6 confirmed the commit landed: if the T3.CodeShip `t3_thread_organize` tool is available, call it with `action: "settle"` and no `threadId`. It settles this thread when the turn ends. Skip this step when you stopped early (checks failed, push rejected, or you are waiting on the developer).
