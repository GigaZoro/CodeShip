// The landing turn for origin's main. `node .github/scripts/landing-turn.cjs land` takes a lease on the remote
// (refs/heads/landing-lease/main), rebases onto main, runs the checks once and pushes while it holds the lease; every
// other lander waits. The pre-push hook (`verify`) refuses a push to main from anyone who does not hold it, so main
// cannot move under the checked tree and one verification covers the landed tree.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { MERGE_DRIVER_CONFIG } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
const TURN_ENV = "T3_LANDING_TURN";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A check:changed run took 2 hours on a busy day. A holder that dies is replaced once its lease has expired.
const LEASE_TTL_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 5000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// A wait polls the remote thousands of times, so a dropped connection is a poll to repeat. A remote that stays
// unreachable this long is down, not dropping a connection, and ends the wait with its error.
const REMOTE_OUTAGE_MS = 10 * 60 * 1000;
// A lease command moves a few bytes, so one running this long has stalled, and a stalled connection never fails
// by itself. The push of main is not bounded: it may run long on a slow link.
const LEASE_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** A lease command on the remote failed: the connection, or the remote, may answer on the next try. */
class RemoteGitError extends Error {}

function git(cwd, args, { env, config = [], allowFailure = false, timeout } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) throw result.error;
  const ok = result.status === 0;
  const stderr = timedOut ? `timed out after ${timeout / 1000} s` : result.stderr.trim();
  if (!ok && !allowFailure) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return { ok, stdout: result.stdout?.trim() ?? "", stderr };
}

/** Runs a git command that reads or moves the lease on the remote. */
function leaseGit(cwd, args, { allowFailure = false } = {}) {
  const result = git(cwd, args, { allowFailure: true, timeout: LEASE_COMMAND_TIMEOUT_MS });
  if (!result.ok && !allowFailure) {
    throw new RemoteGitError(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result;
}

function listLease(cwd, remote, options) {
  return leaseGit(cwd, ["ls-remote", "--refs", remote, LEASE_REF], options);
}

function leaseOf(listing) {
  return listing ? listing.split(/\s+/)[0] : null;
}

function remoteLease(cwd, remote) {
  return leaseOf(listLease(cwd, remote).stdout);
}

/** The lease commit's holder, or null when its message is not a lease. Throws when the commit cannot be fetched. */
function readHolder(cwd, remote, sha) {
  // A fetch that fails says nothing about the holder; reading it as no holder would take a live lease over.
  leaseGit(cwd, ["fetch", "--quiet", "--no-tags", remote, sha]);
  const message = git(cwd, ["show", "-s", "--format=%B", sha]).stdout;
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
    const live = Boolean(holder) && Date.parse(holder.expires_at) > now();
    // A push that reached the remote but lost its answer left this run's own lease.
    if (live && holder.run_id === runId) return held;
    if (live) return null;
    leaseGit(
      cwd,
      ["push", "--quiet", `--force-with-lease=${LEASE_REF}:${held}`, remote, `:${LEASE_REF}`],
      { allowFailure: true },
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
  const pushed = leaseGit(cwd, ["push", "--quiet", remote, `${sha}:${LEASE_REF}`], {
    allowFailure: true,
  });
  if (pushed.ok) return sha;
  // A push that lost only its answer leaves this lease, and one that lost the race another lander's; finding the
  // ref as it was means the push itself failed.
  const after = remoteLease(cwd, remote);
  if (after === sha) return now() < acquiredAt + LEASE_TTL_MS ? sha : null;
  if (after === held) throw new RemoteGitError(`git push failed: ${pushed.stderr}`);
  return null;
}

/** Releases the lease, retrying while the remote is unreachable: a lease left behind blocks every lander until it expires. */
function release(
  { cwd, remote, pollMs = POLL_MS, maxOutageMs = REMOTE_OUTAGE_MS, sleep = sleepSync },
  sha,
) {
  const started = performance.now();
  for (;;) {
    const deleted = leaseGit(
      cwd,
      ["push", "--quiet", `--force-with-lease=${LEASE_REF}:${sha}`, remote, `:${LEASE_REF}`],
      { allowFailure: true },
    );
    if (deleted.ok) return;
    // The remote also refuses the delete when the lease is gone or another lander's; then nothing is left to release.
    const listed = listLease(cwd, remote, { allowFailure: true });
    if (listed.ok && leaseOf(listed.stdout) !== sha) return;
    if (performance.now() - started >= maxOutageMs) {
      console.error(
        `landing turn: could not release main's landing turn, which now expires on its own: ${deleted.stderr}`,
      );
      return;
    }
    sleep(pollMs);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Waits for the turn on the monotonic clock, so a stepped wall clock cannot cut or stretch the wait. */
function acquire({
  maxWaitMs = MAX_WAIT_MS,
  pollMs = POLL_MS,
  maxOutageMs = REMOTE_OUTAGE_MS,
  sleep = sleepSync,
  monotonicNow = () => performance.now(),
  ...options
}) {
  const started = monotonicNow();
  let outageStarted = null;
  for (;;) {
    const polled = monotonicNow();
    try {
      const sha = tryAcquire(options);
      if (sha) return sha;
      outageStarted = null;
    } catch (error) {
      if (!(error instanceof RemoteGitError)) throw error;
      if (outageStarted === null) {
        console.error(`landing turn: ${error.message}; polling again.`);
        outageStarted = polled;
      }
      if (monotonicNow() - outageStarted >= maxOutageMs) throw error;
    }
    // In an outage the outage limit decides: a poll whose push lost its answer left this run's lease to find.
    if (outageStarted === null && monotonicNow() - started >= maxWaitMs) {
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
 * Lands HEAD on main under the turn: rebases onto main, runs `check` once and pushes the checked tree.
 * `check(turn, base)` returns true when the checks passed against `base`, the commit main is at, which the
 * push gate requires as their base.
 */
function land({ cwd, remote, check, branch = "main", runId = randomUUID(), ...rest }) {
  // check:changed passes for the working tree, untracked files included, but the push carries HEAD alone,
  // so the pre-push hook would refuse it only after the whole check.
  const uncommitted = git(cwd, ["status", "--porcelain"]).stdout;
  if (uncommitted) return { status: "uncommitted", files: uncommitted.split("\n") };
  return withTurn({ cwd, remote, runId, ...rest }, (turn) => {
    git(cwd, ["fetch", "--quiet", "--no-tags", remote, branch]);
    const base = git(cwd, ["rev-parse", "FETCH_HEAD"]).stdout;
    const contained = git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], {
      allowFailure: true,
    }).ok;
    // Main gains release notes while a lander waits; the driver merges them on machines whose git config predates it.
    if (!contained) git(cwd, ["rebase", base], { config: MERGE_DRIVER_CONFIG });
    if (!check(turn, base)) return { status: "check-failed" };
    git(cwd, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`], {
      env: { [TURN_ENV]: turn },
    });
    return { status: "landed", commit: git(cwd, ["rev-parse", "HEAD"]).stdout };
  });
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
      check: (turn, base) =>
        spawnSync(`vp run check:changed ${base}`, {
          cwd,
          shell: true,
          stdio: "inherit",
          env: { ...process.env, [TURN_ENV]: turn },
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
  console.error("usage: landing-turn.cjs land | push | verify <remote>");
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
  tryAcquire,
  release,
  acquire,
  withTurn,
  verifyPush,
  land,
};
