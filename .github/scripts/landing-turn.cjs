// The landing turn for origin's main. `node .github/scripts/landing-turn.cjs land` takes a lease on the remote
// (refs/heads/landing-lease/main), rebases onto main, runs the checks once and pushes while it holds the lease; every
// other lander waits its turn in a first-come queue. The pre-push hook (`verify`) refuses a push to main from anyone who
// does not hold it, so main cannot move under the checked tree and one verification covers the landed tree.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { MERGE_DRIVER_CONFIG, notesMergeProblem } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
const TURN_ENV = "T3_LANDING_TURN";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A check:changed run took 2 hours on a busy day. A holder that dies is replaced once its lease has expired.
const LEASE_TTL_MS = 3 * 60 * 60 * 1000;
const POLL_MS = 5000;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000;
// A wait polls origin thousands of times, and one poll can meet a passing DNS or credential failure. Failures that go
// on this long end the wait, so a remote that cannot be reached is not tried for hours.
const FAILING_MS = 10 * 60 * 1000;
// One read or write of the lease; a remote that stops answering must not hold a wait past its limits.
const LEASE_CALL_MS = 60 * 1000;
// First come, first served, so a lander landing commit after commit cannot keep the turn from one waiting longer. A
// waiter publishes QUEUE_PREFIX<zero-padded wait start>-<run id>.<n>, names that sort in queue order, and only the head
// takes a free lease. It renames its entry every QUEUE_REFRESH_MS (no new object); a name a reader has seen for
// QUEUE_STALE_MS is a dead waiter's, which holds no place and is deleted.
const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";
const QUEUE_REFRESH_MS = 60 * 1000;
const QUEUE_STALE_MS = 3 * 60 * 1000;
const QUEUE_PRUNE_MAX = 10;
const QUEUE_NAME = /^(\d{15}-[^.]+)\.\d+$/;
const LANDER_IDENTITY = {
  GIT_AUTHOR_NAME: "landing-turn",
  GIT_AUTHOR_EMAIL: "landing-turn@localhost",
  GIT_COMMITTER_NAME: "landing-turn",
  GIT_COMMITTER_EMAIL: "landing-turn@localhost",
};

function git(cwd, args, { env, config = [], allowFailure = false, timeoutMs } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
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
 * push reported a failure. With `take` false it only finds that wait's own lease.
 */
function tryAcquire({ runId, now = () => Date.now(), take = true, ...lease }) {
  const held = remoteLease(lease);
  if (held) {
    const holder = readHolder(lease, held);
    // A lease nobody can read is one nobody can release, so it expires like any other.
    const expired = !holder || !(Date.parse(holder.expires_at) > now());
    if (!expired) return holder.run_id === runId ? held : null;
  }
  if (!take) return null;
  if (held && !moveLease(lease, held, null)) return null;
  const acquiredAt = now();
  const sha = markerCommit(lease.cwd, {
    run_id: runId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(acquiredAt + LEASE_TTL_MS).toISOString(),
  });
  // A push that creates the ref is atomic: when two landers race, the remote takes one and refuses the other.
  return moveLease(lease, null, sha) ? sha : null;
}

function markerCommit(cwd, fields) {
  const message = `${JSON.stringify(fields)}\n[skip ci]`;
  return git(cwd, ["commit-tree", EMPTY_TREE, "-m", message], { env: LANDER_IDENTITY }).stdout;
}

/** One wait's entry in main's landing queue. `clock` is the wait's monotonic clock. */
function joinQueue({ cwd, remote, callMs = LEASE_CALL_MS, runId, waitingSince, clock }) {
  const stem = `${String(waitingSince).padStart(15, "0")}-${runId}`;
  const firstSeen = new Map();
  let ownNames = [];
  let commit = null;
  let renames = 0;
  let publishedAt = null;
  const list = (pattern) => {
    const listing = remoteGit(cwd, ["ls-remote", "--refs", remote, pattern], callMs).stdout;
    return listing ? listing.split("\n").map((line) => line.split(/\s+/)[1]) : [];
  };
  const stemOf = (ref) => QUEUE_NAME.exec(ref.slice(QUEUE_PREFIX.length))?.[1] ?? null;
  return {
    /** Whether no live waiter is ahead of this one. Deletes some of the dead ones' names. */
    atHead() {
      // Only entry names: any other ref under the prefix is no waiter's, and is neither waited for nor deleted.
      const refs = list(`${QUEUE_PREFIX}*`).filter(
        (ref) => ref.startsWith(QUEUE_PREFIX) && stemOf(ref) !== null,
      );
      const now = clock();
      for (const ref of firstSeen.keys()) if (!refs.includes(ref)) firstSeen.delete(ref);
      const others = refs.filter((ref) => stemOf(ref) !== stem);
      for (const ref of others) if (!firstSeen.has(ref)) firstSeen.set(ref, now);
      const dead = others.filter((ref) => now - firstSeen.get(ref) >= QUEUE_STALE_MS);
      if (dead.length) {
        // Another waiter may delete a name first, which fails this push; the next read lists what is left.
        const deletes = dead.slice(0, QUEUE_PRUNE_MAX).map((ref) => `:${ref}`);
        remoteGit(cwd, ["push", "--quiet", remote, ...deletes], callMs, { allowFailure: true });
      }
      ownNames = refs.filter((ref) => stemOf(ref) === stem);
      return !others.some((ref) => !dead.includes(ref) && stemOf(ref) < stem);
    },
    /** Publishes the entry, or renames it once it is due, so readers see this waiter alive. */
    refresh() {
      if (ownNames.length && clock() - publishedAt < QUEUE_REFRESH_MS) return;
      commit ??= markerCommit(cwd, {
        run_id: runId,
        waiting_since: new Date(waitingSince).toISOString(),
      });
      renames += 1;
      remoteGit(
        cwd,
        ["push", "--quiet", remote, `${commit}:${QUEUE_PREFIX}${stem}.${renames}`],
        callMs,
      );
      publishedAt = clock();
      // A name left behind goes stale, and other waiters delete it.
      if (ownNames.length) {
        const deletes = ownNames.map((ref) => `:${ref}`);
        remoteGit(cwd, ["push", "--quiet", remote, ...deletes], callMs, { allowFailure: true });
      }
    },
    /** Removes the entry; one left behind holds no place once other waiters find it stale. */
    leave() {
      if (commit === null) return;
      try {
        const own = list(`${QUEUE_PREFIX}${stem}.*`);
        if (own.length)
          remoteGit(cwd, ["push", "--quiet", remote, ...own.map((ref) => `:${ref}`)], callMs);
      } catch (error) {
        process.stderr.write(
          `landing turn: this wait's queue entry stays until other waiters find it stale: ${error.message}\n`,
        );
      }
    },
  };
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
 * Waits for the turn on the monotonic clock, so a stepped wall clock cannot cut or stretch the wait, and takes it once
 * no earlier waiter is left in the queue. The wait makes its own run id, so no other wait can carry it.
 */
function acquire({
  maxWaitMs = MAX_WAIT_MS,
  failingMs = FAILING_MS,
  pollMs = POLL_MS,
  sleep = sleepSync,
  clock = () => performance.now(),
  now = () => Date.now(),
  ...options
}) {
  const started = clock();
  const runId = randomUUID();
  const queue = joinQueue({ ...options, runId, waitingSince: now(), clock });
  let failingSince = null;
  try {
    for (;;) {
      let failure = null;
      // A step that cannot reach origin fails the poll but not the steps after it, so a waiter that cannot read the
      // lease still renames its entry and keeps its place.
      const step = (run) => {
        try {
          return run();
        } catch (error) {
          if (!(error instanceof RemoteFailure)) throw error;
          failure ??= error;
          return null;
        }
      };
      // Behind other waiters, a wait still looks for its own lease: its take may have reached origin unacknowledged.
      const sha = step(() => tryAcquire({ ...options, runId, now, take: queue.atHead() }));
      if (sha) return sha;
      if (clock() - started < maxWaitMs) step(() => queue.refresh());
      const waited = clock();
      if (waited - started >= maxWaitMs) {
        throw (
          failure ??
          new Error("landing turn: another lander still holds main's landing turn or waits ahead.")
        );
      }
      if (failure) {
        const first = failingSince === null;
        if (first) failingSince = waited;
        if (waited - failingSince >= failingMs) throw failure;
        if (first) process.stderr.write(`landing turn: ${failure.message}\nTrying again.\n`);
      } else {
        failingSince = null;
      }
      sleep(pollMs);
    }
  } finally {
    queue.leave();
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

/**
 * Lands HEAD on main under the turn: rebases onto main, runs `check` once and pushes the checked tree.
 * `check(turn, base)` returns true when the checks passed against `base`, the commit main is at, which the
 * push gate requires as their base.
 */
function land({ cwd, remote, check, branch = "main", ...rest }) {
  // check:changed passes for the working tree, untracked files included, but the push carries HEAD alone,
  // so the pre-push hook would refuse it only after the whole check.
  const uncommitted = git(cwd, ["status", "--porcelain"]).stdout;
  if (uncommitted) return { status: "uncommitted", files: uncommitted.split("\n") };
  // Found before the wait, not after a rebase that breaks the notes and checks that fail on them.
  const problem = notesMergeProblem(cwd);
  if (problem) throw new Error(problem);
  return withTurn({ cwd, remote, ...rest }, (turn) => {
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
    withTurn({ cwd, remote: "origin" }, (turn) => {
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
  QUEUE_PREFIX,
  TURN_ENV,
  tryAcquire,
  release,
  acquire,
  withTurn,
  verifyPush,
  land,
};
