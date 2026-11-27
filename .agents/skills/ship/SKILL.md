---
name: ship
description: Finish a T3.CodeShip branch end to end without a PR. Commit the work, land it on main under the landing turn (`vp run check:changed` runs before the wait), confirm it landed, verify the requested delivery, then release its disposable worktree and retire its topic branch. Use for "commit, push, merge to main", "ship it", "land this", "merge and delete the branch", "finish this branch" or "/ship", and when a task in this repository is done (AGENTS.md, "Ship finished work"). Not for when the developer asked for a PR or review first, or asked only to commit.
---

# Ship

Invoking `/ship` is the developer's go-ahead to commit and push to the default branch, and so is finishing a task in this repository ([AGENTS.md, "Ship finished work"](../../../AGENTS.md#ship-finished-work)). Do not ask again.
`$ARGUMENTS` may carry a commit title or a branch to land on. Default to the remote's default branch.

On a resumed handoff with a confirmed landing SHA, start at step 6. Use the recorded results to identify the next outstanding check. For a completed handoff from the primary checkout with no owned topic checkout or ref left to retire, call `t3_thread_organize` with `{"action":"settle"}` before the final report.

## 1. Orient

- `git status --short --untracked-files=all`, `git branch --show-current`, `git worktree list`, `git remote -v`.
- Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to `main`.
- The first `git worktree list` entry is the main checkout. Note whether you are in a separate worktree.
- Fetch origin. If the tree is clean and `git merge-base --is-ancestor HEAD origin/<default>` succeeds, go directly to step 6 with the delivered SHA. This also covers a clean default branch at its remote tip.
- Otherwise, stage and land the outstanding work in steps 2–5. Identify any disposable topic branch owned by this shipment separately from the primary checkout and default branch.

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

A branch behind main is rebased onto it first, and the landing then starts again from the rebased tree, so it waits with the rebased copy of the script, which holds main's changes to it. It runs `vp run check:changed` against main before the wait, in a private checkout of the commit so nothing in your worktree can reach it, like any other run (at most two landings from the worktrees of one clone check before their wait at once, so it may first report that it waits for one), then takes the turn (a lease on `refs/heads/landing-lease/main` on origin, which it renews while it holds it), pushes `HEAD` to `main` as a fast-forward and gives the turn back in the same atomic push. When main moved during the wait, it rebases and runs the checks again under the turn first, where they get the next free check slot ahead of other runs. A pass records the tree it checked, uncommitted and untracked files included, so `land` refuses to start in a worktree with anything uncommitted or untracked. Main refuses a push from anyone who does not hold the turn, or for a tree no `check:changed` pass covers (`.vite-hooks/pre-push`), so never push to main any other way, never pass `--no-verify`, and never use `--force` or `--force-with-lease`.

- A check that fails ends the landing with exit status 1, before it waits or with the turn released: fix the cause, commit, and land again.
- A rebase that conflicts stops the landing, before it waits or with the turn released: resolve it, then land again.
- `head-moved`: the checkout moved to another commit while the landing ran, so it pushed nothing: land again from the commit you mean to land. A landing owns its checkout until it ends, so nothing else switches, commits or edits there meanwhile.
- `lost-turn`: the landing could not renew its lease in time, as when the machine slept, and another lander took it, so it pushed nothing: land again.
- If a fallback lease release cannot be confirmed after retries, the command exits nonzero while still printing any landed commit (`releaseConfirmed: false`). Confirm that commit on `origin/main`; once confirmed, no retry is needed and the lease lapses within ten minutes.
- A fetch or push of main that stops answering ends the landing after ten minutes, with the turn released. A push whose answer was lost counts as landed when main holds its commit. `git push failed, and whether it landed is unknown`: fetch main; if `git merge-base --is-ancestor HEAD origin/main` succeeds, it landed, otherwise land again.
- Branch protection that refuses the push: stop and offer a PR instead.
- Confirm with `git fetch origin && git merge-base --is-ancestor HEAD origin/<default>`.

## 6. Verify the requested delivery

Use the SHA printed by the landing turn, or the previously confirmed SHA when resuming. Reconcile the developer's original request with the results for that commit. A request to verify a release or installed package stays open until the published artifact and its requested behavior have been checked. Retain the checkout and verifier until the check finishes. Record the SHA, hosted run and artifact identifiers. Preserve any unique local inputs in a durable location before a long idle wait so the verifier can resume even if storage cleanup runs.

- If a hosted run is active, start an awaited check, such as `gh run watch <run-id> --repo <owner/repo> --exit-status` in `t3_command_run`. Its completion wakes this thread. Resume the requested verification on that wake, including after a timeout.
- If an external dependency prevents verification and there is no running check to await, call `t3_thread_organize` with `{"action":"unsettle"}` on the current thread, even when it already appears active. Without this override it can settle during an idle wait. Use an existing retry for this delivery or register a one-time `schedule_task` with `bindToCurrentThread: true` at the next useful retry time. Copy the landed commit SHA or release tag from the handoff into the retry prompt. Identify what to verify in that installed artifact and where the verifier or evidence lives. Read the saved task before yielding. Check its prompt for that same SHA or tag, its owning thread ID, its enabled state and its next run time. Correct the saved task if any of these is missing. Recheck on wake and renew the active state and retry while the dependency is pending. A turn start clears the earlier active override.
- With every requested result verified, go to step 7 if there is an owned disposable checkout or topic branch to retire. Go straight to step 8 from a clean primary default checkout only when this shipment has no owned topic checkout or ref left to retire.

## 7. Release the topic checkout

Preserve the full delivery ref and verify that it contains the delivered tip. Keep primary, reusable and shared checkouts. Stop only the processes this task started and remove its disposable scratch data once all verification has finished.

- For a CodeShip-managed checkout, read the owning thread's registered path and finishing run ID. The release worker checks the worktree’s `HEAD`, `ORIG_HEAD`, every entry in `FETCH_HEAD`, and both commit IDs from each entry in the HEAD reflog. Verify that the delivery ref covers those tips. For uncovered history, verify an existing durable ref or create and verify an archive ref that covers it. Pass each additional full ref with `--also-durable-ref`.
- From a stable directory on the server host, use the matching released CLI to queue `t3 thread release-worktree <thread-id> --run <run-id> --worktree <registered-path> --durable-ref refs/remotes/origin/<default>` with any additional verified refs. For a custom home, pass the owning server's `--base-dir <base-dir>`. Verify the printed request path is in that server’s state directory under `worktree-releases` before reporting it as **queued**. If release is unavailable or unconfirmed, retain the checkout and identify its owner and blocker. After handoff, confirm directory absence and Git deregistration from outside the owning thread.
- For another disposable checkout, establish exclusive ownership, preserve local data, and run the worktree handoff preflight. From the primary checkout, remove the verified worktree and confirm both directory absence and deregistration. Preserve any checkout with other owners, pending writes or an unresolved preflight.
- After confirmed release, retire only the delivered local and remote topic refs this task owned. Preserve the default branch and the durable ref. Use a fast-forward-only update if the primary checkout is clean, on the expected branch and needs the delivered commit.

## 8. Report and settle

Report the landed SHA and title, the requested checks and their observed results, and the disposition of any checkout or topic branch. When the full request is complete, settle this thread with `t3_thread_organize` using action `settle` and no `threadId`, if available. Honor an explicit request to close the thread.
