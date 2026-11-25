// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A synchronous maintainer script over git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { requirePass } from "../../.github/scripts/check-changed-receipt.cjs";
import {
  GIT_OUTPUT_MAX_BYTES,
  REAL_HISTORY_ENV,
  markedFiles,
} from "../../.github/scripts/git-history.cjs";
import { MERGE_DRIVER_CONFIG, notesMergeProblem } from "../../.github/scripts/release-notes.cjs";
// Loaded with this script, so a checkout that moves while `land` runs cannot swap the push it runs.
import { pushChecked } from "../../.github/scripts/landing-turn.cjs";
import { gitPaths } from "./cached-tests.ts";

// A busy main moves every few minutes while a sync's checks take an hour, so a sync that chased
// it by re-merging never ended. These limits make a run land or hold within a working morning.
const MAX_MERGES = 3;
export const RUN_LIMIT_MS = 3 * 60 * 60 * 1000;
// A sync's check:changed covers the whole upstream merge, far past the 900 s default per step.
const CHECK_TIMEOUT_SECONDS = "3600";

const STATE_FILE = "upstream-sync.json";
const MAIN_MERGE_MESSAGE = "chore: merge main into upstream sync";
const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";

interface MergeAttempt {
  /** `upstream`: the sync's own merge. `main`: origin/main merged in to land. */
  readonly kind: "upstream" | "main";
  readonly commit: string;
  readonly at: string;
  readonly conflicts: ReadonlyArray<string>;
  /** A main merged without a conflict left open: the merge, which no branch holds until the sync fast-forwards to it. */
  readonly merge?: string;
}

/** What a pass of step 7a covered: the commit, and the base its check:changed ran against. */
interface CheckedCommit {
  readonly commit: string;
  readonly base: string;
}

interface SyncState {
  readonly startedAt: string;
  /**
   * The origin/main commit the run checks against: frozen at begin, or the main begin merges into a
   * resumed branch that lacks it, then each main `land` merged.
   */
  readonly base: string;
  readonly upstream: string;
  readonly attempts: ReadonlyArray<MergeAttempt>;
  /** Step 7a's last pass. `land` pushes that commit alone, and only while its base is still the run's. */
  readonly checked?: CheckedCommit;
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
  | {
      /** HEAD is not the commit step 7a last passed for against the run's base (`checked`, null when none did). */
      readonly status: "unchecked";
      readonly head: string;
      readonly checked: string | null;
    }
  | {
      /** Main merged into the checked commit as `commit`, which the sync fast-forwards to and checks against `base`. */
      readonly status: "verify";
      readonly base: string;
      readonly commit: string;
    }
  | {
      readonly status: "hold";
      readonly reason: "conflicts" | "merge-limit" | "time-limit";
      readonly conflicts: ReadonlyArray<string>;
    }
  | { readonly status: "push-failed"; readonly detail: string };

interface SyncStatus {
  readonly base: string;
  readonly checked: string | null;
  readonly mergesLeft: number;
  readonly minutesLeft: number;
  readonly attempts: ReadonlyArray<MergeAttempt>;
}

function run(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...REAL_HISTORY_ENV },
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr.toString().trim(),
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  const result = run(cwd, args);
  return { ...result, stdout: result.stdout.toString().trim() };
}

function gitBytesOrThrow(cwd: string, ...args: ReadonlyArray<string>): Buffer {
  const result = run(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function gitOrThrow(cwd: string, ...args: ReadonlyArray<string>): string {
  return String(gitBytesOrThrow(cwd, ...args)).trim();
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
  // Without -z, Git quotes a path that holds a quote, backslash, control or non-ASCII character,
  // and trimming would drop a leading space.
  const listed = gitBytesOrThrow(worktree, "diff", "--name-only", "-z", "--diff-filter=U");
  return gitPaths(listed).filter(Boolean);
}

function allConflicts(state: SyncState): ReadonlyArray<string> {
  return [...new Set(state.attempts.flatMap((attempt) => attempt.conflicts))];
}

/** The commit `land` may push: a pass against an older base does not cover main's merged commits. */
function checkedCommit(state: SyncState): string | null {
  return state.checked?.base === state.base ? state.checked.commit : null;
}

/** HEAD, when the worktree holds nothing else: check:changed reads uncommitted, untracked and marked files too. */
function cleanHead(worktree: string): string {
  // Explicit, since `status.showUntrackedFiles=no` hides the untracked files check:changed reads.
  const changes = gitOrThrow(worktree, "status", "--porcelain", "--untracked-files=normal");
  if (changes !== "" || markedFiles(worktree).length > 0) {
    throw new Error(
      "Commit or resolve every change, untracked files included, so check:changed covers HEAD alone.",
    );
  }
  return gitOrThrow(worktree, "rev-parse", "HEAD");
}

/** `-c` options that merge the release notes with the repository's driver, as a landing does. */
function notesDriver(worktree: string): ReadonlyArray<string> {
  const problem = notesMergeProblem(worktree);
  if (problem !== null) throw new Error(problem);
  return MERGE_DRIVER_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

/**
 * Merges upstream into the sync branch made from origin/main, freezing that commit as the base, or
 * starts a new run's bounds on a branch that has it merged already, merging the main it lacks.
 */
export function begin(worktree: string, now: Date): SyncResult {
  if (!git(worktree, "remote", "get-url", "upstream").ok) {
    gitOrThrow(worktree, "remote", "add", "upstream", UPSTREAM_URL);
    gitOrThrow(worktree, "remote", "set-url", "--push", "upstream", "no-push");
  }
  if (NodeFS.existsSync(statePath(worktree))) throw new Error("This sync has begun already.");
  gitOrThrow(worktree, "fetch", "-q", "origin");
  gitOrThrow(worktree, "fetch", "-q", "upstream");
  // HEAD itself on a new branch; on a held one, the last main merged into it.
  const base = gitOrThrow(worktree, "merge-base", "HEAD", "origin/main");
  const upstream = gitOrThrow(worktree, "rev-parse", "upstream/main");
  if (git(worktree, "merge-base", "--is-ancestor", upstream, base).ok) {
    return { status: "up-to-date", upstream };
  }
  // A held branch carries upstream that main lacks; it lands what it merged, even if upstream moved on.
  const synced = gitOrThrow(worktree, "merge-base", "HEAD", upstream);
  if (!git(worktree, "merge-base", "--is-ancestor", synced, base).ok) {
    const main = gitOrThrow(worktree, "rev-parse", "origin/main");
    const resumed: SyncState = {
      startedAt: now.toISOString(),
      base,
      upstream: synced,
      attempts: [],
    };
    if (main === base) {
      writeState(worktree, resumed);
      return { status: "resumed", base, upstream: synced, conflicts: [] };
    }
    // Land held on this main or main moved on; merging it here keeps chats from merging it by hand.
    // The merge stays in the checkout with its conflicts, for the chat to resolve and commit.
    const merged = run(worktree, [
      ...notesDriver(worktree),
      "merge",
      "--no-ff",
      main,
      "-m",
      MAIN_MERGE_MESSAGE,
    ]);
    const conflicts = merged.ok ? [] : conflictedFiles(worktree);
    if (!merged.ok && conflicts.length === 0) throw new Error(`git merge failed: ${merged.stderr}`);
    writeState(worktree, {
      ...resumed,
      base: main,
      attempts: [{ kind: "main", commit: main, at: now.toISOString(), conflicts }],
    });
    return { status: "resumed", base: main, upstream: synced, conflicts };
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
    checked: checkedCommit(state),
    mergesLeft: Math.max(0, MAX_MERGES - state.attempts.length),
    minutesLeft: Math.max(0, Math.floor(left / 60_000)),
    attempts: state.attempts,
  };
}

/**
 * The check:changed command for step 7a, and what its pass covers. The base comes from the run's
 * state file, so no chat types a narrower range that skips files only the upstream merge changed.
 */
export function checkCommand(worktree: string, env: NodeJS.ProcessEnv) {
  const state = readState(worktree);
  const commit = cleanHead(worktree);
  // A checkout reset to main, or a commit with the merge's tree on main, would land without upstream's history.
  if (!git(worktree, "merge-base", "--is-ancestor", state.upstream, commit).ok) {
    throw new Error(
      `HEAD ${commit} does not hold upstream ${state.upstream}: check the sync's merge.`,
    );
  }
  // check:changed compares with the merge base, so a commit without the base would pass against an older main.
  if (!git(worktree, "merge-base", "--is-ancestor", state.base, commit).ok) {
    throw new Error(
      `HEAD ${commit} does not hold the run's base ${state.base}: after \`land\` answered verify, fast-forward to its merge (the last attempt's \`merge\` in \`status\`); after aborting the merge \`begin\` left to resolve, merge the base again.`,
    );
  }
  const covers: CheckedCommit = { commit, base: state.base };
  return {
    args: ["run", "check:changed", state.base],
    env: { ...env, CHECK_CHANGED_TIMEOUT: env.CHECK_CHANGED_TIMEOUT ?? CHECK_TIMEOUT_SECONDS },
    covers,
  };
}

/** Records a pass of `checkCommand`'s command, which covers its commit only if the checkout is still on it. */
export function recordCheck(worktree: string, covers: CheckedCommit): void {
  const head = cleanHead(worktree);
  if (head !== covers.commit) {
    throw new Error(
      `The checkout moved from ${covers.commit} to ${head} during the check: check again.`,
    );
  }
  // The receipt the push gate will ask for when main is still at the base.
  try {
    requirePass(worktree, covers.commit, covers.base);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`check:changed left no pass the push gate takes for this commit: ${detail}`, {
      cause: error,
    });
  }
  writeState(worktree, { ...readState(worktree), checked: covers });
}

/**
 * `git merge-tree --write-tree --name-only -z` output: the tree, each conflicted path, an empty
 * field, then each message as `<count>`, that many paths, its type and its text. Conflicts are the
 * listed paths and every path a CONFLICT message names.
 */
function parseMergeTree(output: Buffer) {
  const fields = gitPaths(output);
  const field = (index: number) => fields[index] ?? "";
  const conflicts = new Set<string>();
  let index = 1;
  for (; field(index) !== ""; index += 1) conflicts.add(field(index));
  for (index += 1; field(index) !== "";) {
    const count = Number(field(index));
    // A conflict without stages, such as a directory rename split, shows only in its CONFLICT message.
    if (field(index + 1 + count).startsWith("CONFLICT")) {
      for (const path of fields.slice(index + 1, index + 1 + count)) conflicts.add(path);
    }
    index += count + 3;
  }
  return { tree: field(0), conflicts: [...conflicts] };
}

/**
 * Main merged into the checked commit away from the checkout: the merge commit, the checked commit
 * when it holds main already, or null when Git leaves anything to decide. The release notes merge
 * by date with the repository's driver, as in a landing.
 */
function mergeMain(
  worktree: string,
  checked: string,
  main: string,
): { readonly commit: string | null; readonly conflicts: ReadonlyArray<string> } {
  if (git(worktree, "merge-base", "--is-ancestor", main, checked).ok) {
    return { commit: checked, conflicts: [] };
  }
  // Main as ours and the sync as theirs, the sides a landing's rebase gives them, so the driver
  // puts the sync's entries above main's of one date.
  const merged = run(worktree, [
    ...notesDriver(worktree),
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    main,
    checked,
  ]);
  if (merged.status !== 0 && merged.status !== 1) {
    throw new Error(`git merge-tree failed: ${merged.stderr}`);
  }
  const { tree, conflicts } = parseMergeTree(merged.stdout);
  if (conflicts.length > 0 !== (merged.status === 1)) {
    throw new Error(`git merge-tree exited ${merged.status} with ${conflicts.length} conflicts.`);
  }
  if (conflicts.length > 0) return { commit: null, conflicts };
  const commit = gitOrThrow(
    worktree,
    "commit-tree",
    tree,
    "-p",
    checked,
    "-p",
    main,
    "-m",
    MAIN_MERGE_MESSAGE,
  );
  return { commit, conflicts };
}

/** True when the fetched main already holds `candidate`, the commit this run would push. */
function holdsCandidate(worktree: string, candidate: string): boolean {
  return git(worktree, "merge-base", "--is-ancestor", candidate, "origin/main").ok;
}

/**
 * Pushes the commit step 7a passed for to main when that is a fast-forward of the base it was checked
 * against. When main moved, merges it into that commit once and returns the merge, for the sync to
 * fast-forward to and check again, holding instead when the merge conflicts or the run is out of
 * merges or time. It moves no branch and leaves the checkout as it is.
 */
export function land(worktree: string, now: Date, push = pushChecked): SyncResult {
  const state = readState(worktree);
  const hold = (reason: "conflicts" | "merge-limit" | "time-limit", from = state): SyncResult => ({
    status: "hold",
    reason,
    conflicts: allConflicts(from),
  });
  const checked = checkedCommit(state);
  gitOrThrow(worktree, "fetch", "-q", "origin");
  // A push whose reply was lost, or one cut by the time limit, may have landed.
  if (checked !== null && holdsCandidate(worktree, checked)) {
    return { status: "landed", commit: checked };
  }
  if (now.getTime() >= Date.parse(state.startedAt) + RUN_LIMIT_MS) return hold("time-limit");
  // As `check` required: a change beside the commit would not land with it.
  let head = cleanHead(worktree);
  if (checked === null || head !== checked) return { status: "unchecked", head, checked };
  const landed: SyncResult = { status: "landed", commit: checked };
  let main = gitOrThrow(worktree, "rev-parse", "origin/main");
  let failure: string | null = null;
  if (main === state.base) {
    try {
      // Main refuses a push from anyone who does not hold its landing turn (.github/scripts/landing-turn.cjs).
      push({ cwd: worktree, remote: "origin", head: checked });
      return landed;
    } catch (error) {
      // Origin decides: a push whose reply was lost may have landed, and one git refused may mean main moved.
      failure = error instanceof Error ? error.message : String(error);
    }
    gitOrThrow(worktree, "fetch", "-q", "origin");
    if (holdsCandidate(worktree, checked)) return landed;
    main = gitOrThrow(worktree, "rev-parse", "origin/main");
  }
  if (failure !== null) {
    // The push stops when its checkout leaves the commit, which says nothing about main.
    head = gitOrThrow(worktree, "rev-parse", "HEAD");
    if (head !== checked) return { status: "unchecked", head, checked };
    if (main === state.base) return { status: "push-failed", detail: failure };
  }
  if (state.attempts.length >= MAX_MERGES) return hold("merge-limit");
  const merged = mergeMain(worktree, checked, main);
  const attempt: MergeAttempt = {
    kind: "main",
    commit: main,
    at: now.toISOString(),
    conflicts: merged.conflicts,
  };
  if (merged.commit === null) {
    const next = { ...state, attempts: [...state.attempts, attempt] };
    writeState(worktree, next);
    return hold("conflicts", next);
  }
  const merge = merged.commit;
  writeState(worktree, {
    ...state,
    base: main,
    attempts: [...state.attempts, { ...attempt, merge }],
  });
  return { status: "verify", base: main, commit: merge };
}
