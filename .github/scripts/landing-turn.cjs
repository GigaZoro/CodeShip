// The landing turn for origin's main. `node .github/scripts/landing-turn.cjs land` takes a lease on the remote
// (refs/heads/landing-lease/main), rebases onto main, runs the checks once and pushes while it holds the lease; every
// other lander waits. The pre-push hook (`verify`) refuses a push to main from anyone who does not hold it, so main
// cannot move under the checked tree and one verification covers the landed tree.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { REAL_HISTORY_ENV, markedFiles } = require("./git-history.cjs");
const path = require("node:path");
const { MERGE_DRIVER_CONFIG, notesMergeProblem } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
const TURN_ENV = "T3_LANDING_TURN";
const TEST_STEP_MAX_ENV = "CHECK_CHANGED_TEST_STEP_MAX";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A check:changed run took 2 hours on a busy day. A holder that dies is replaced once its lease has expired.
const LEASE_TTL_MS = 3 * 60 * 60 * 1000;
// What a landing keeps back from its lease for the checks that are not the test step, and for the push.
const LEASE_RESERVE_MS = 20 * 60 * 1000;
const POLL_MS = 5000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// A wait polls origin thousands of times, and one poll can meet a passing DNS or credential failure. Failures that go
// on this long end the wait, so a remote that cannot be reached is not tried for hours.
const FAILING_MS = 10 * 60 * 1000;
// One read or write of the lease; a remote that stops answering must not hold a wait past its limits.
const LEASE_CALL_MS = 60 * 1000;

function git(cwd, args, { env, config = [], allowFailure = false, timeoutMs } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV, ...env },
    timeout: timeoutMs,
    // Default 1 MiB: another worktree's branch can change tens of thousands of files, and an overflow aborts the landing.
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  // A call that ran out of time is a failed one; like any failed push, it may still have changed origin.
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) throw result.error;
  const ok = !timedOut && result.status === 0;
  const stderr = timedOut
    ? `did not finish within ${timeoutMs / 1000} seconds.`
    : result.stderr.trim();
  if (!ok && !allowFailure) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return { ok, stdout: result.stdout.trim(), stderr };
}

/**
 * A failed git call to origin. It may pass, so a wait tries again; only git's translated message would tell apart a
 * local setting that fails every call. A failed step that does not reach origin ends the wait at once.
 */
class RemoteFailure extends Error {}

/** One read or write of origin's lease, bounded by `callMs`. */
function remoteGit(cwd, args, callMs, { allowFailure = false } = {}) {
  const result = git(cwd, args, { allowFailure: true, timeoutMs: callMs });
  if (!result.ok && !allowFailure) {
    throw new RemoteFailure(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result;
}

/** The lease calls take `{ cwd, remote, callMs }`; `callMs` bounds each git call to origin. */
function remoteLease({ cwd, remote, callMs = LEASE_CALL_MS }) {
  const listing = remoteGit(cwd, ["ls-remote", "--refs", remote, LEASE_REF], callMs).stdout;
  return listing ? listing.split(/\s+/)[0] : null;
}

function readHolder({ cwd, remote, callMs = LEASE_CALL_MS }, sha) {
  // A lease commit this lander could not fetch is unknown, not unreadable: it may be another lander's live turn. A poll
  // every few seconds leaves FETCH_HEAD to the checkout's other fetches.
  remoteGit(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, sha], callMs);
  const message = git(cwd, ["show", "-s", "--format=%B", sha]).stdout;
  try {
    return JSON.parse(message.split("\n")[0]);
  } catch {
    return null;
  }
}

/**
 * Moves origin's lease from `from` to `to` (null: no lease). A push git reports failed may still have reached origin,
 * or lost the race to another lander, so origin's lease afterwards decides. False when another lander moved it.
 */
function moveLease(lease, from, to) {
  const { cwd, remote, callMs = LEASE_CALL_MS } = lease;
  const expected = from ? [`--force-with-lease=${LEASE_REF}:${from}`] : [];
  const pushed = remoteGit(
    cwd,
    ["push", "--quiet", ...expected, remote, `${to ?? ""}:${LEASE_REF}`],
    callMs,
    { allowFailure: true },
  );
  if (pushed.ok) return true;
  const after = remoteLease(lease);
  if (after === to) return true;
  if (after !== from) return false;
  throw new RemoteFailure(`git push failed: ${pushed.stderr}`);
}

/**
 * Takes the lease when it is free or expired. Returns the lease commit, or null while another lander holds it.
 * `runId` names one wait: a live lease that carries it is that wait's own, as when a take reached origin although its
 * push reported a failure.
 */
function tryAcquire({ runId, now = () => Date.now(), ...lease }) {
  const held = remoteLease(lease);
  if (held) {
    const holder = readHolder(lease, held);
    // A lease nobody can read is one nobody can release, so it expires like any other.
    const expired = !holder || !(Date.parse(holder.expires_at) > now());
    if (!expired) return holder.run_id === runId ? held : null;
    if (!moveLease(lease, held, null)) return null;
  }
  const acquiredAt = now();
  const message = JSON.stringify({
    run_id: runId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(acquiredAt + LEASE_TTL_MS).toISOString(),
  });
  const sha = git(lease.cwd, ["commit-tree", EMPTY_TREE, "-m", `${message}\n[skip ci]`], {
    env: {
      GIT_AUTHOR_NAME: "landing-turn",
      GIT_AUTHOR_EMAIL: "landing-turn@localhost",
      GIT_COMMITTER_NAME: "landing-turn",
      GIT_COMMITTER_EMAIL: "landing-turn@localhost",
    },
  }).stdout;
  // A push that creates the ref is atomic: when two landers race, the remote takes one and refuses the other.
  return moveLease(lease, null, sha) ? sha : null;
}

function release(lease, sha) {
  try {
    moveLease(lease, sha, null);
  } catch (error) {
    // Thrown from withTurn's finally block, it would replace the landing's own result.
    process.stderr.write(
      `landing turn: the turn may stay held until its lease expires: ${error.message}\n`,
    );
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Waits for the turn on the monotonic clock, so a stepped wall clock cannot cut or stretch the wait. The wait makes its
 * own run id, so no other wait can carry it.
 */
function acquire({
  maxWaitMs = MAX_WAIT_MS,
  failingMs = FAILING_MS,
  pollMs = POLL_MS,
  sleep = sleepSync,
  clock = () => performance.now(),
  ...options
}) {
  const started = clock();
  const runId = randomUUID();
  let failingSince = null;
  for (;;) {
    let failure = null;
    try {
      const sha = tryAcquire({ ...options, runId });
      if (sha) return sha;
      failingSince = null;
    } catch (error) {
      if (!(error instanceof RemoteFailure)) throw error;
      failure = error;
    }
    const now = clock();
    if (now - started >= maxWaitMs) {
      throw failure ?? new Error("landing turn: another lander still holds main's landing turn.");
    }
    if (failure) {
      const first = failingSince === null;
      if (first) failingSince = now;
      if (now - failingSince >= failingMs) throw failure;
      if (first) process.stderr.write(`landing turn: ${failure.message}\nTrying again.\n`);
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
  if (!turn || remoteLease({ cwd, remote }) !== turn) {
    throw new Error(
      "A push to main needs the landing turn: land with `node .github/scripts/landing-turn.cjs land`.",
    );
  }
}

/** Seconds a check may spend on its longest step and still end, with the push, before the lease expires. */
function checkBudgetSeconds(elapsedMs) {
  return Math.max(1, Math.floor((LEASE_TTL_MS - LEASE_RESERVE_MS - elapsedMs) / 1000));
}

function stoppedRebase(cwd) {
  return ["rebase-merge", "rebase-apply"].some((name) =>
    fs.existsSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout),
  );
}

/** A conflict must not leave the worktree in the middle of the rebase: the next landing would refuse it. */
function rebaseOnto(cwd, base) {
  try {
    git(cwd, ["rebase", base], { config: MERGE_DRIVER_CONFIG });
  } catch (error) {
    if (stoppedRebase(cwd)) git(cwd, ["rebase", "--abort"], { allowFailure: true });
    throw error;
  }
}

/**
 * Other local worktrees whose branch is ahead of `base` and changes a file HEAD changes, with the shared files.
 * Agents search main before building something, so work parked on another worktree's branch stays invisible until
 * two designs collide at landing.
 */
function overlappingWorktrees({ cwd, base }) {
  const changed = (ref) =>
    git(cwd, ["diff", "--name-only", `${base}...${ref}`], { allowFailure: true })
      .stdout.split("\n")
      .filter(Boolean);
  const mine = new Set(changed("HEAD"));
  if (mine.size === 0) return [];
  const self = git(cwd, ["rev-parse", "--show-toplevel"]).stdout;
  const overlaps = [];
  for (const block of git(cwd, ["worktree", "list", "--porcelain"]).stdout.split("\n\n")) {
    const fields = Object.fromEntries(
      block.split("\n").map((line) => {
        const space = line.indexOf(" ");
        return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
      }),
    );
    if (!fields.worktree || fields.bare !== undefined || fields.prunable !== undefined) continue;
    if (path.resolve(fields.worktree) === path.resolve(self)) continue;
    if (!fields.HEAD) continue;
    const shared = changed(fields.HEAD).filter((file) => mine.has(file));
    if (shared.length > 0) {
      overlaps.push({
        branch:
          fields.branch?.replace(/^refs\/heads\//, "") ?? `(detached ${fields.HEAD.slice(0, 10)})`,
        worktree: fields.worktree,
        files: shared,
      });
    }
  }
  return overlaps;
}

/** The overlap listing a lander reads before the rebase and checks, so it can reconcile first. */
function formatOverlaps(overlaps) {
  if (overlaps.length === 0) return "";
  const lines = [
    `Other local worktrees have unmerged work on files this change also changes (a report, not a refusal):`,
  ];
  for (const { branch, worktree, files } of overlaps) {
    lines.push(`- ${branch} (${worktree})`, ...files.map((file) => `    ${file}`));
  }
  return lines.join("\n");
}

/**
 * Lands HEAD on main under the turn: rebases onto main, runs `check` once and pushes the checked tree.
 * `check(turn, base, budgetSeconds)` returns true when the checks passed against `base`, the commit main is at, which
 * the push gate requires as their base; `budgetSeconds` is what the lease leaves its longest step.
 */
function land({
  cwd,
  remote,
  check,
  branch = "main",
  turnClock = () => performance.now(),
  report = (text) => console.error(text),
  ...rest
}) {
  // check:changed passes for the working tree, untracked files included, but the push carries HEAD alone,
  // so the pre-push hook would refuse it only after the whole check.
  if (stoppedRebase(cwd)) return { status: "rebase-in-progress" };
  const uncommitted = git(cwd, ["status", "--porcelain"]).stdout;
  if (uncommitted) return { status: "uncommitted", files: uncommitted.split("\n") };
  // `status` does not list edits to files marked assume-unchanged or skip-worktree, which the checks would read.
  const marked = markedFiles(cwd);
  if (marked.length > 0) return { status: "marked-files", files: marked };
  // Found before the wait, not after a rebase that breaks the notes and checks that fail on them.
  const problem = notesMergeProblem(cwd);
  if (problem) throw new Error(problem);
  return withTurn({ cwd, remote, ...rest }, (turn) => {
    const turnStarted = turnClock();
    // Into this turn's own ref: any other fetch in this checkout can rewrite FETCH_HEAD before it is read. Atomic,
    // because a named remote's fetch also updates its tracking ref, and a failure there must not leave this one behind.
    const fetched = `refs/worktree/landing-turn/${turn}`;
    git(cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--atomic",
      remote,
      `+refs/heads/${branch}:${fetched}`,
    ]);
    const base = git(cwd, ["rev-parse", fetched]).stdout;
    git(cwd, ["update-ref", "-d", fetched]);
    const overlap = formatOverlaps(overlappingWorktrees({ cwd, base }));
    if (overlap) report(overlap);
    const contained = git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], {
      allowFailure: true,
    }).ok;
    // Main gains release notes while a lander waits; the driver merges them on machines whose git config predates it.
    if (!contained) rebaseOnto(cwd, base);
    if (!check(turn, base, checkBudgetSeconds(turnClock() - turnStarted)))
      return { status: "check-failed" };
    git(cwd, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`], {
      env: { [TURN_ENV]: turn },
    });
    return { status: "landed", commit: git(cwd, ["rev-parse", "HEAD"]).stdout };
  });
}

/**
 * Pushes `commit` to main under the turn, for a tree that was checked against main's current commit elsewhere (the
 * upstream sync, the dependency upgrade). The commit is resolved before the wait, so what lands is the commit the
 * caller checked, whatever its checkout does while the push waits; a main that moved makes git refuse the fast-forward.
 */
function push({ cwd, remote, commit, branch = "main", ...rest }) {
  if (!commit) throw new Error("usage: landing-turn.cjs push <commit>");
  const sha = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).stdout;
  withTurn({ cwd, remote, ...rest }, (turn) => {
    git(cwd, ["push", "--quiet", remote, `${sha}:refs/heads/${branch}`], {
      env: { [TURN_ENV]: turn },
    });
  });
  return sha;
}

function main(argv) {
  const [command, ...rest] = argv;
  const cwd = process.cwd();
  if (command === "verify") {
    // The pre-push hook passes the remote's URL, then git writes one `<local ref> <sha> <remote ref> <sha>` line per ref.
    const refs = require("node:fs")
      .readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ")[2]);
    verifyPush({ cwd, remote: rest[0], refs });
    return 0;
  }
  if (command === "land") {
    const result = land({
      cwd,
      remote: "origin",
      check: (turn, base, budgetSeconds) =>
        spawnSync(`vp run check:changed ${base}`, {
          cwd,
          shell: true,
          stdio: "inherit",
          env: {
            ...process.env,
            [TURN_ENV]: turn,
            [TEST_STEP_MAX_ENV]: String(budgetSeconds),
          },
        }).status === 0,
    });
    console.log(JSON.stringify(result));
    return result.status === "landed" ? 0 : 1;
  }
  if (command === "push") {
    console.log(
      JSON.stringify({
        status: "landed",
        commit: push({ cwd, remote: "origin", commit: rest[0] }),
      }),
    );
    return 0;
  }
  console.error("usage: landing-turn.cjs land | push <commit> | verify <remote>");
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
  LEASE_TTL_MS,
  LEASE_RESERVE_MS,
  checkBudgetSeconds,
  tryAcquire,
  release,
  acquire,
  withTurn,
  verifyPush,
  land,
  push,
  overlappingWorktrees,
};
