// The landing turn for origin's main. `node .github/scripts/landing-turn.cjs land` takes a lease on the remote
// (refs/heads/landing-lease/main), rebases onto main, runs the checks once and pushes while it holds the lease; every
// other lander waits. The pre-push hook (`verify`) refuses a push to main from anyone who does not hold it, so main
// cannot move under the checked tree and one verification covers the landed tree.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MERGE_DRIVER_CONFIG } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
const TURN_ENV = "T3_LANDING_TURN";
/** The main commit a landing lands on, for a `--check` command to compare against. */
const MAIN_ENV = "T3_LANDING_TURN_MAIN";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A check:changed run took 2 hours on a busy day. A holder that dies is replaced once its lease has expired.
const LEASE_TTL_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 5000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// `ls-files -v` prints a line for every tracked file: 2 MB for this repository, past spawnSync's 1 MiB default.
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;
// A hooks folder no file can be in: /dev/null is no folder, and Git for Windows reads it as the null device.
const NO_HOOKS = [["core.hooksPath", "/dev/null"]];

function git(cwd, args, { env, config = [], allowFailure = false } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: GIT_OUTPUT_LIMIT,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function remoteLease(cwd, remote) {
  const listing = git(cwd, ["ls-remote", "--refs", remote, LEASE_REF]).stdout;
  return listing ? listing.split(/\s+/)[0] : null;
}

function readHolder(cwd, remote, sha) {
  git(cwd, ["fetch", "--quiet", "--no-tags", remote, sha], { allowFailure: true });
  const message = git(cwd, ["show", "-s", "--format=%B", sha], { allowFailure: true }).stdout;
  try {
    return JSON.parse(message.split("\n")[0]);
  } catch {
    return null;
  }
}

/** Takes the lease when it is free or expired. Returns the lease commit, or null while another lander holds it. */
function tryAcquire({ cwd, remote, runId, now = () => Date.now() }) {
  const held = remoteLease(cwd, remote);
  if (held) {
    const holder = readHolder(cwd, remote, held);
    // A lease nobody can read is one nobody can release, so it expires like any other.
    const expired = !holder || !(Date.parse(holder.expires_at) > now());
    if (!expired) return null;
    git(
      cwd,
      ["push", "--quiet", `--force-with-lease=${LEASE_REF}:${held}`, remote, `:${LEASE_REF}`],
      {
        allowFailure: true,
      },
    );
  }
  const acquiredAt = now();
  const message = JSON.stringify({
    run_id: runId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(acquiredAt + LEASE_TTL_MS).toISOString(),
  });
  const sha = git(cwd, ["commit-tree", EMPTY_TREE, "-m", `${message}\n[skip ci]`], {
    env: {
      GIT_AUTHOR_NAME: "landing-turn",
      GIT_AUTHOR_EMAIL: "landing-turn@localhost",
      GIT_COMMITTER_NAME: "landing-turn",
      GIT_COMMITTER_EMAIL: "landing-turn@localhost",
    },
  }).stdout;
  // A push that creates the ref is atomic: when two landers race, the remote takes one and refuses the other.
  const pushed = git(cwd, ["push", "--quiet", remote, `${sha}:${LEASE_REF}`], {
    allowFailure: true,
  });
  return pushed.ok ? sha : null;
}

function release({ cwd, remote }, sha) {
  git(cwd, ["push", "--quiet", `--force-with-lease=${LEASE_REF}:${sha}`, remote, `:${LEASE_REF}`], {
    allowFailure: true,
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Waits for the turn on the monotonic clock, so a stepped wall clock cannot cut or stretch the wait. */
function acquire({ maxWaitMs = MAX_WAIT_MS, pollMs = POLL_MS, sleep = sleepSync, ...options }) {
  const started = performance.now();
  for (;;) {
    const sha = tryAcquire(options);
    if (sha) return sha;
    if (performance.now() - started >= maxWaitMs) {
      throw new Error("landing turn: another lander still holds main's landing turn.");
    }
    sleep(pollMs);
  }
}

function withTurn(options, run) {
  const sha = acquire(options);
  try {
    return run(sha);
  } finally {
    release(options, sha);
  }
}

/** The pre-push check: a push to main must come from the lander whose lease the remote holds. */
function verifyPush({ cwd, remote, env = process.env, refs }) {
  const toMain = refs.some((ref) => ref === "refs/heads/main");
  if (!toMain) return;
  const turn = env[TURN_ENV];
  if (!turn || remoteLease(cwd, remote) !== turn) {
    throw new Error(
      "A push to main needs the landing turn: land with `node .github/scripts/landing-turn.cjs land`.",
    );
  }
}

/**
 * The steps of the rebase stopped in the worktree, those it did and those left, or null when none is stopped. HEAD is
 * then a part of the rebased stack, not the branch.
 */
function stoppedRebase(root) {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const dir = path.resolve(root, git(root, ["rev-parse", "--git-path", name]).stdout);
    if (!fs.existsSync(dir)) continue;
    return ["done", "git-rebase-todo"]
      .map((file) => path.join(dir, file))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
  }
  return null;
}

/**
 * Changes HEAD does not hold, untracked files included: the checks would run on them, but the push carries HEAD alone.
 * Status does not look at a file marked assume-unchanged or skip-worktree, so a marked file counts as changed.
 */
function uncommittedChanges(root) {
  const status = git(root, [
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]).stdout;
  // `ls-files -v` tags a file marked assume-unchanged in lowercase and one marked skip-worktree `S`.
  const marked = git(root, ["ls-files", "-v"])
    .stdout.split("\n")
    .filter((line) => /^[a-zS] /u.test(line))
    .map(
      (line) =>
        `${line.slice(2)} (marked assume-unchanged or skip-worktree; clear it with git update-index)`,
    );
  return [status, ...marked].filter(Boolean).join("\n");
}

/** The branch HEAD is on (empty when detached) and the commit it is at. */
function headOf(root) {
  return {
    branch: git(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true }).stdout,
    commit: git(root, ["rev-parse", "HEAD"]).stdout,
  };
}

const describeHead = ({ branch, commit }) => `${branch || "a detached HEAD"} at ${commit}`;

/** Throws unless HEAD is still on the branch and at the commit `expected` names. */
function requireHead(root, expected, during) {
  const current = headOf(root);
  if (current.branch !== expected.branch || current.commit !== expected.commit) {
    throw new Error(
      `landing turn: HEAD moved from ${describeHead(expected)} to ${describeHead(current)} ${during}; land again.`,
    );
  }
}

/**
 * A stopped rebase or a change HEAD does not hold is someone's unfinished work: a lander neither lands it, checks it
 * with its commit, nor aborts it.
 */
function refuseUnfinishedWork(root) {
  if (stoppedRebase(root) !== null) {
    throw new Error(
      "landing turn: a rebase is stopped in this worktree; finish or abort it, then land again.",
    );
  }
  const changes = uncommittedChanges(root);
  if (changes) {
    throw new Error(
      `landing turn: the worktree has changes HEAD does not hold, which the checks would run on but the push would not carry; commit or remove them, then land again:\n${changes}`,
    );
  }
}

/**
 * Rebases HEAD onto the commit `onto`. Main gains release notes while a lander waits, and the notes' merge driver
 * merges them, on machines whose git config predates it too. Any conflict it leaves, or any other failure, aborts the
 * rebase, leaving HEAD as it was.
 */
function rebaseOnto(root, onto, runId) {
  // Another process working in this worktree can start a rebase of its own, even one of the same commits onto the same
  // main. So this rebase carries a step naming its run, a no-op that stays in its list of steps, and the lander aborts
  // only a rebase that has it.
  const marker = `landing-turn ${runId}`;
  const ours = () => stoppedRebase(root)?.includes(marker) ?? false;
  // The worktree's hooks would run inside the rebase, where they could change its steps, its files or HEAD under the
  // lander; replaying the commits needs none of them.
  const step = git(root, ["rebase", "--exec", `true # ${marker}`, onto], {
    allowFailure: true,
    config: [...MERGE_DRIVER_CONFIG, ...NO_HOOKS],
  });
  if (step.ok) return;
  if (!ours()) {
    throw new Error(
      stoppedRebase(root) === null
        ? `landing turn: rebasing onto main failed: ${step.stderr}`
        : `landing turn: rebasing onto main failed, and a rebase this lander did not start is stopped in the worktree; it is left as it is: ${step.stderr}`,
    );
  }
  const conflicts = git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout;
  const failure = conflicts
    ? `landing turn: rebasing onto main conflicts in ${conflicts.split("\n").join(", ")}; rebase by hand and land again.`
    : `landing turn: rebasing onto main failed: ${step.stderr}`;
  const aborted = git(root, ["rebase", "--abort"], { allowFailure: true, config: NO_HOOKS });
  if (!aborted.ok) {
    throw new Error(
      `${failure}\nlanding turn: aborting the rebase failed too, so the worktree is still in it: ${aborted.stderr}`,
    );
  }
  throw new Error(failure);
}

/**
 * The commit `branch` is at on the remote. It is fetched into a ref of this run alone and read once: FETCH_HEAD is
 * the last fetch's in this worktree, such as an editor's background fetch of every branch.
 */
function fetchBranch(root, remote, branch, runId) {
  const ref = `refs/landing-turn/${runId}`;
  git(root, ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${ref}`]);
  try {
    return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout;
  } finally {
    git(root, ["update-ref", "-d", ref]);
  }
}

/**
 * Lands HEAD on main under the turn: rebases onto main, runs `check` once and pushes the checked commit.
 * `check(turn, root, main)` runs the checks on the worktree at `root` against the commit `main` it lands on, and
 * returns true when they passed.
 */
function land({ cwd, remote, check, branch = "main", runId = randomUUID(), ...rest }) {
  // Conflict listings, commit paths and the checks work from the worktree root, and a lander may start in any folder.
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).stdout;
  refuseUnfinishedWork(root);
  const started = headOf(root);
  const containsMain = (main) =>
    git(root, ["merge-base", "--is-ancestor", main, "HEAD"], { allowFailure: true }).ok;
  return withTurn({ cwd: root, remote, runId, ...rest }, (turn) => {
    const main = fetchBranch(root, remote, branch, runId);
    // The turn can take hours to come, and a rebase, change, commit or branch switch made here meanwhile is someone's
    // work: the lander lands the commit it was started on.
    refuseUnfinishedWork(root);
    requireHead(root, started, "while this lander waited for its turn");
    if (!containsMain(main)) {
      rebaseOnto(root, main, runId);
      // Another process working in this worktree may have changed it during the rebase.
      refuseUnfinishedWork(root);
    }
    const checked = headOf(root);
    if (checked.branch !== started.branch || !containsMain(main)) {
      throw new Error(
        `landing turn: HEAD is ${describeHead(checked)} after the rebase, not ${started.branch || "a detached HEAD"} on main; land again.`,
      );
    }
    if (!check(turn, root, main)) return { status: "check-failed" };
    requireHead(root, checked, "while the checks ran");
    const changed = uncommittedChanges(root);
    if (changed) {
      throw new Error(
        `landing turn: the worktree changed while the checks ran, so they did not check HEAD alone; land again:\n${changed}`,
      );
    }
    git(root, ["push", "--quiet", remote, `${checked.commit}:refs/heads/${branch}`], {
      env: { [TURN_ENV]: turn },
    });
    return { status: "landed", commit: checked.commit };
  });
}

function main(argv) {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  if (command === "verify") {
    // The pre-push hook passes the remote's URL, then git writes one `<local ref> <sha> <remote ref> <sha>` line per ref.
    const refs = fs
      .readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[2]);
    verifyPush({ cwd, remote: rest[0], refs });
    return 0;
  }
  if (command === "land") {
    const checkIndex = rest.indexOf("--check");
    // check:changed compares against main's commit, not against whichever remote's main is closest: another remote's
    // main may already hold the commits being landed, which would leave nothing to check.
    const checkCommand = (main) =>
      checkIndex >= 0 ? rest[checkIndex + 1] : `vp run check:changed ${main}`;
    const result = land({
      cwd,
      remote: "origin",
      check: (turn, root, main) =>
        spawnSync(checkCommand(main), {
          cwd: root,
          shell: true,
          stdio: "inherit",
          env: { ...process.env, [TURN_ENV]: turn, [MAIN_ENV]: main },
          windowsHide: true,
        }).status === 0,
    });
    console.log(JSON.stringify(result));
    return result.status === "landed" ? 0 : 1;
  }
  if (command === "push") {
    // For a tree that was verified against main's current commit elsewhere (the upstream sync): the push is
    // a fast-forward, so the push takes the turn alone and a main that moved makes git refuse it.
    withTurn({ cwd, remote: "origin", runId: randomUUID() }, (turn) => {
      git(cwd, ["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
        env: { [TURN_ENV]: turn },
      });
    });
    return 0;
  }
  console.error("usage: landing-turn.cjs land [--check <command>] | push | verify <remote>");
  return 2;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  LEASE_REF,
  TURN_ENV,
  MAIN_ENV,
  tryAcquire,
  release,
  acquire,
  withTurn,
  verifyPush,
  land,
};
