// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A synchronous maintainer script over git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REAL_HISTORY_ENV, markedFiles } from "../../.github/scripts/git-history.cjs";

// A busy main moves every few minutes while a sync's checks take an hour, so a sync that chased
// it by re-merging never ended. These limits make a run land or hold within a working morning.
const MAX_MERGES = 3;
export const RUN_LIMIT_MS = 3 * 60 * 60 * 1000;
// A sync's check:changed covers the whole upstream merge, far past the 900 s default per step.
const CHECK_TIMEOUT_SECONDS = "3600";

const LANDING_TURN = NodePath.join(import.meta.dirname, "../../.github/scripts/landing-turn.cjs");
const STATE_FILE = "upstream-sync.json";
const RELEASE_NOTES = "docs/release-notes.md";
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

interface MergeAttempt {
  /** `upstream`: the sync's own merge. `main`: origin/main merged in to land. */
  readonly kind: "upstream" | "main";
  readonly commit: string;
  readonly at: string;
  readonly conflicts: ReadonlyArray<string>;
}

interface SyncState {
  readonly startedAt: string;
  /** The origin/main commit the branch was last verified against: frozen at begin, then each merged main. */
  readonly base: string;
  readonly upstream: string;
  readonly attempts: ReadonlyArray<MergeAttempt>;
}

type SyncResult =
  | { readonly status: "up-to-date"; readonly upstream: string }
  | {
      /** `resumed`: the branch has upstream merged already, as a follow-up of a held run finds it. */
      readonly status: "merged" | "conflicts" | "resumed";
      readonly base: string;
      readonly upstream: string;
      readonly conflicts: ReadonlyArray<string>;
    }
  | { readonly status: "landed"; readonly commit: string }
  | { readonly status: "verify"; readonly base: string }
  | {
      readonly status: "hold";
      readonly reason: "conflicts" | "merge-limit" | "time-limit";
      readonly conflicts: ReadonlyArray<string>;
    }
  | { readonly status: "push-failed"; readonly detail: string };

interface SyncStatus {
  readonly base: string;
  readonly mergesLeft: number;
  readonly minutesLeft: number;
  readonly attempts: ReadonlyArray<MergeAttempt>;
}

function run(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV },
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.trim() };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  const result = run(cwd, args);
  return { ...result, stdout: result.stdout.trim() };
}

function gitOrThrow(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = git(cwd, ...args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function statePath(worktree: string): string {
  return gitOrThrow(worktree, "rev-parse", "--path-format=absolute", "--git-path", STATE_FILE);
}

function readState(worktree: string): SyncState {
  const path = statePath(worktree);
  if (!NodeFS.existsSync(path)) throw new Error(`No sync started in ${worktree}; run begin first.`);
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as SyncState;
}

function writeState(worktree: string, state: SyncState): void {
  NodeFS.writeFileSync(statePath(worktree), `${JSON.stringify(state, null, 2)}\n`);
}

function conflictedFiles(worktree: string): ReadonlyArray<string> {
  const out = gitOrThrow(worktree, "diff", "--name-only", "--diff-filter=U");
  return out === "" ? [] : out.split("\n");
}

function allConflicts(state: SyncState): ReadonlyArray<string> {
  return [...new Set(state.attempts.flatMap((attempt) => attempt.conflicts))];
}

/**
 * Merges upstream into the sync branch made from origin/main, freezing that commit as the base, or
 * starts a new run's bounds on a branch that has it merged already.
 */
export function begin(worktree: string, now: Date): SyncResult {
  if (!git(worktree, "remote", "get-url", "upstream").ok) {
    gitOrThrow(worktree, "remote", "add", "upstream", UPSTREAM_URL);
    gitOrThrow(worktree, "remote", "set-url", "--push", "upstream", "no-push");
  }
  if (NodeFS.existsSync(statePath(worktree))) throw new Error("This sync has begun already.");
  gitOrThrow(worktree, "fetch", "-q", "upstream");
  // HEAD itself on a new branch; on a held one, the last main merged into it.
  const base = gitOrThrow(worktree, "merge-base", "HEAD", "origin/main");
  const upstream = gitOrThrow(worktree, "rev-parse", "upstream/main");
  if (git(worktree, "merge-base", "--is-ancestor", upstream, base).ok) {
    return { status: "up-to-date", upstream };
  }
  if (git(worktree, "merge-base", "--is-ancestor", upstream, "HEAD").ok) {
    writeState(worktree, { startedAt: now.toISOString(), base, upstream, attempts: [] });
    return { status: "resumed", base, upstream, conflicts: [] };
  }
  const short = gitOrThrow(worktree, "rev-parse", "--short", upstream);
  const merged = git(
    worktree,
    "merge",
    "--no-ff",
    upstream,
    "-m",
    `chore: sync with upstream t3code (${short})`,
  );
  const conflicts = merged.ok ? [] : conflictedFiles(worktree);
  if (!merged.ok && conflicts.length === 0) throw new Error(`git merge failed: ${merged.stderr}`);
  writeState(worktree, {
    startedAt: now.toISOString(),
    base,
    upstream,
    attempts: [{ kind: "upstream", commit: upstream, at: now.toISOString(), conflicts }],
  });
  return { status: conflicts.length === 0 ? "merged" : "conflicts", base, upstream, conflicts };
}

export function status(worktree: string, now: Date): SyncStatus {
  const state = readState(worktree);
  const left = Date.parse(state.startedAt) + RUN_LIMIT_MS - now.getTime();
  return {
    base: state.base,
    mergesLeft: Math.max(0, MAX_MERGES - state.attempts.length),
    minutesLeft: Math.max(0, Math.floor(left / 60_000)),
    attempts: state.attempts,
  };
}

/**
 * The check:changed command for step 7a. The base comes from the run's state file, so no chat
 * types a narrower range that skips files only the upstream merge changed.
 */
export function checkCommand(worktree: string, env: NodeJS.ProcessEnv) {
  return {
    args: ["run", "check:changed", readState(worktree).base],
    env: { ...env, CHECK_CHANGED_TIMEOUT: env.CHECK_CHANGED_TIMEOUT ?? CHECK_TIMEOUT_SECONDS },
  };
}

/** Both sides only prepend entries, so the result is this branch's new entries above main's file. */
function resolveReleaseNotes(worktree: string): boolean {
  // Untrimmed: the stages are compared and written byte for byte.
  const [base, ours, theirs] = [1, 2, 3].map((index) =>
    run(worktree, ["show", `:${index}:${RELEASE_NOTES}`]),
  );
  if (!base?.ok || !ours?.ok || !theirs?.ok) return false;
  const [baseText, oursText, theirsText] = [base.stdout, ours.stdout, theirs.stdout];
  if (!oursText.endsWith(baseText) || !theirsText.endsWith(baseText)) return false;
  const added = oursText.slice(0, oursText.length - baseText.length);
  NodeFS.writeFileSync(NodePath.join(worktree, RELEASE_NOTES), added + theirsText);
  gitOrThrow(worktree, "add", RELEASE_NOTES);
  return true;
}

/** True when the fetched main already holds HEAD, the commit this run would push. */
function holdsCandidate(worktree: string): boolean {
  return git(worktree, "merge-base", "--is-ancestor", "HEAD", "origin/main").ok;
}

function landed(worktree: string): SyncResult {
  return { status: "landed", commit: gitOrThrow(worktree, "rev-parse", "HEAD") };
}

/**
 * Pushes the branch to main when that is a fast-forward of the commit it was verified against.
 * When main moved, merges it in once and asks for the checks again, holding instead when the
 * merge conflicts or the run is out of merges or time.
 */
export function land(worktree: string, now: Date): SyncResult {
  const state = readState(worktree);
  const hold = (reason: "conflicts" | "merge-limit" | "time-limit", from = state): SyncResult => ({
    status: "hold",
    reason,
    conflicts: allConflicts(from),
  });
  gitOrThrow(worktree, "fetch", "-q", "origin");
  // A push whose reply was lost, or one cut by the time limit, may have landed.
  if (holdsCandidate(worktree)) return landed(worktree);
  if (now.getTime() >= Date.parse(state.startedAt) + RUN_LIMIT_MS) return hold("time-limit");
  if (
    gitOrThrow(worktree, "status", "--porcelain", "--untracked-files=no") !== "" ||
    markedFiles(worktree).length > 0
  ) {
    throw new Error("Commit or resolve every change before landing.");
  }
  let main = gitOrThrow(worktree, "rev-parse", "origin/main");
  if (main === state.base) {
    // Main refuses a push from anyone who does not hold its landing turn (.github/scripts/landing-turn.cjs).
    const pushRun = NodeChildProcess.spawnSync(process.execPath, [LANDING_TURN, "push"], {
      cwd: worktree,
      encoding: "utf8",
    });
    const pushed = { ok: pushRun.status === 0, stderr: pushRun.stderr.trim() };
    if (pushed.ok) return landed(worktree);
    gitOrThrow(worktree, "fetch", "-q", "origin");
    if (holdsCandidate(worktree)) return landed(worktree);
    main = gitOrThrow(worktree, "rev-parse", "origin/main");
    if (main === state.base) return { status: "push-failed", detail: pushed.stderr };
  }
  if (state.attempts.length >= MAX_MERGES) return hold("merge-limit");
  const merged = git(
    worktree,
    "merge",
    "--no-ff",
    main,
    "-m",
    "chore: merge main into upstream sync",
  );
  const conflicts = merged.ok ? [] : conflictedFiles(worktree);
  if (!merged.ok && conflicts.length === 0) throw new Error(`git merge failed: ${merged.stderr}`);
  const next: SyncState = {
    ...state,
    attempts: [...state.attempts, { kind: "main", commit: main, at: now.toISOString(), conflicts }],
  };
  const unresolved = conflicts.filter(
    (file) => file !== RELEASE_NOTES || !resolveReleaseNotes(worktree),
  );
  if (unresolved.length > 0) {
    gitOrThrow(worktree, "merge", "--abort");
    writeState(worktree, next);
    return hold("conflicts", next);
  }
  if (conflicts.length > 0) gitOrThrow(worktree, "commit", "-q", "--no-edit");
  writeState(worktree, { ...next, base: main });
  return { status: "verify", base: main };
}
