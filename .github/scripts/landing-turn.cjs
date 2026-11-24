// The landing turn for origin's main. `node .github/scripts/landing-turn.cjs land` takes a lease on the remote
// (refs/heads/landing-lease/main), rebases onto main, runs the checks once and pushes while it holds the lease.
// Other landers wait in a first-come, first-served queue. The pre-push hook (`verify`) requires the lease for pushes
// to main, so main cannot move under the checked tree and one verification covers the landed tree.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { REAL_HISTORY_ENV, markedFiles } = require("./git-history.cjs");
const { createQueueWaiter } = require("./lease-queue.cjs");
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
// on this long while the machine is awake end the wait, so a remote that cannot be reached is not tried for hours.
const FAILING_MS = 10 * 60 * 1000;
// One lease or queue call; a remote that stops answering must not hold a wait past its limits.
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

/** One call to origin, bounded by `callMs`. */
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

/** Origin's lease commit (null: none) and the run id of a live one; an expired lease has no live holder. */
function readLease(lease, now) {
  const held = remoteLease(lease);
  if (!held) return { held, liveRunId: null };
  const holder = readHolder(lease, held);
  // A lease nobody can read is one nobody can release, so it expires like any other.
  const live = holder !== null && Date.parse(holder.expires_at) > now();
  return { held, liveRunId: live ? holder.run_id : null };
}

/**
 * Takes the lease when it is free or expired. Returns the lease commit, or null while another lander holds it.
 * `runId` names one wait: a live lease that carries it is that wait's own, as when a take reached origin although its
 * push reported a failure.
 */
function tryAcquire({ runId, now = Date.now, canTake = () => true, ...lease }) {
  const { held, liveRunId } = readLease(lease, now);
  if (liveRunId !== null) return liveRunId === runId ? held : null;
  if (!canTake() || (held && !moveLease(lease, held, null))) return null;
  const acquiredAt = now();
  const expiresAt = acquiredAt + LEASE_TTL_MS;
  const sha = landingCommit(lease.cwd, {
    run_id: runId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
  // A push that creates the ref is atomic: when two landers race, the remote takes one and refuses the other.
  if (!moveLease(lease, null, sha)) return null;
  // A take confirmed only after its lease ran out holds no turn; the next take goes through the queue again.
  return expiresAt > now() ? sha : null;
}

/** A commit of `data` on the empty tree, a child of `parent` when one is given. */
function landingCommit(cwd, data, parent) {
  const parents = parent ? ["-p", parent] : [];
  const message = `${JSON.stringify(data)}\n[skip ci]`;
  return git(cwd, ["commit-tree", EMPTY_TREE, ...parents, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "landing-turn",
      GIT_AUTHOR_EMAIL: "landing-turn@localhost",
      GIT_COMMITTER_NAME: "landing-turn",
      GIT_COMMITTER_EMAIL: "landing-turn@localhost",
    },
  }).stdout;
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

const UPTIME_SCRIPT = `ObjC.import("Foundation"); String(Math.floor($.NSProcessInfo.processInfo.systemUptime * 1000))`;

/**
 * NSProcessInfo.systemUptime in milliseconds: the time a Mac has been awake since boot. The read's timeout counts sleep,
 * so a read the Mac slept through times out when it wakes. One such read is read again; a second timeout ends the wait.
 */
function macAwakeMs(spawn = spawnSync) {
  const read = () =>
    spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", UPTIME_SCRIPT], {
      encoding: "utf8",
      timeout: 5000,
    });
  let result = read();
  if (result.error?.code === "ETIMEDOUT") result = read();
  const match = /^(\d+)\s*$/.exec(result.stdout ?? "");
  if (result.error || result.status !== 0 || !match) {
    const exit = result.signal ? `signal ${result.signal}` : `exit status ${result.status}`;
    const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || exit);
    throw new Error(`osascript NSProcessInfo.systemUptime failed: ${detail}`);
  }
  return Number(match[1]);
}

/**
 * Milliseconds the machine has been awake, for a span inside one process. On macOS performance.now() counts sleep, and a
 * Mac asleep with its lid closed wakes for seconds without a network. Linux's monotonic clock stops while it sleeps;
 * Windows' performance counter does not, so a Windows host that sleeps still counts its sleep.
 */
function awakeNow() {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime; tests pass awakeClock.
  return process.platform === "darwin" ? macAwakeMs() : performance.now();
}

/**
 * Waits for the turn on the monotonic clock, so a stepped wall clock cannot cut or stretch the wait. Failures of origin
 * count on `awakeClock`: a sleep is no time the lander tried. The wait makes its own run id, so no other wait can carry it.
 */
function acquire({
  maxWaitMs = MAX_WAIT_MS,
  failingMs = FAILING_MS,
  pollMs = POLL_MS,
  sleep = sleepSync,
  clock = () => performance.now(),
  now = Date.now,
  awakeClock = awakeNow,
  ...options
}) {
  const started = clock();
  const runId = randomUUID();
  const { cwd, remote, callMs = LEASE_CALL_MS } = options;
  const queue = createQueueWaiter({
    remote,
    runId,
    arrivedAt: now(),
    clock,
    remoteGit: (args) => remoteGit(cwd, args, callMs).stdout,
    readMessage: (sha) => git(cwd, ["show", "-s", "--format=%B", sha]).stdout,
    makeCommit: (data, parent) => landingCommit(cwd, data, parent),
    warn: (message) => process.stderr.write(`landing turn: ${message}\n`),
  });
  let waiting = false;
  let failingSince = null;
  // A take that failed partway may have reached origin, and the queue can put another entry first meanwhile.
  let tookMaybe = false;
  try {
    for (;;) {
      let failure = null;
      let firstInQueue = false;
      let polled = false;
      try {
        // A take of its own that origin applied is its turn while it lives; an expired one goes back through the queue.
        if (tookMaybe) {
          const { held, liveRunId } = readLease(options, now);
          tookMaybe = false;
          if (liveRunId === runId) return held;
        }
        firstInQueue = queue.poll();
        polled = true;
        if (firstInQueue) {
          // Only the head polls the lease. It checks its place again before swapping a free or expired lease.
          tookMaybe = true;
          const sha = tryAcquire({
            ...options,
            runId,
            now,
            canTake: () => (firstInQueue = queue.stillFirst()),
          });
          tookMaybe = false;
          if (sha) return sha;
        }
      } catch (error) {
        if (!(error instanceof RemoteFailure)) throw error;
        failure = error;
      }
      // Joining and renewing its entry follow the take, so a failed renewal never keeps it from a free lease.
      try {
        if (polled) queue.refresh();
      } catch (error) {
        if (!(error instanceof RemoteFailure)) throw error;
        failure ??= error;
      }
      if (clock() - started >= maxWaitMs) {
        throw (
          failure ??
          new Error(
            firstInQueue
              ? "landing turn: another lander still holds main's landing turn."
              : "landing turn: timed out waiting for main's landing queue.",
          )
        );
      }
      if (!waiting) {
        waiting = true;
        process.stderr.write("landing turn: waiting for its turn in main's landing queue.\n");
      }
      if (failure) {
        const checkedAt = awakeClock();
        const first = failingSince === null;
        failingSince ??= checkedAt;
        if (checkedAt - failingSince >= failingMs) throw failure;
        if (first) process.stderr.write(`landing turn: ${failure.message}\nTrying again.\n`);
      } else {
        failingSince = null;
      }
      sleep(pollMs);
    }
  } finally {
    try {
      queue.leave();
    } catch (error) {
      process.stderr.write(`landing turn: could not remove its queue entry: ${error.message}\n`);
    }
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
 * Seconds a check may spend on its longest step and still end, with the push, before the lease expires: `leftMs` is
 * what the lease had left when the turn started, `elapsedMs` the time since.
 */
function checkBudgetSeconds(leftMs, elapsedMs) {
  return Math.max(1, Math.floor((leftMs - LEASE_RESERVE_MS - elapsedMs) / 1000));
}

/** What the lease commit `sha` has left; a take recovered after its answer was lost started before this turn. */
function leaseLeftMs(cwd, sha, now) {
  const message = git(cwd, ["show", "-s", "--format=%B", sha]).stdout;
  return Date.parse(JSON.parse(message.split("\n")[0]).expires_at) - now();
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
  now = Date.now,
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
  return withTurn({ cwd, remote, now, ...rest }, (turn) => {
    const turnStarted = turnClock();
    const leftMs = leaseLeftMs(cwd, turn, now);
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
    if (!check(turn, base, checkBudgetSeconds(leftMs, turnClock() - turnStarted)))
      return { status: "check-failed" };
    git(cwd, ["push", "--quiet", remote, `HEAD:refs/heads/${branch}`], {
      env: { [TURN_ENV]: turn },
    });
    return { status: "landed", commit: git(cwd, ["rev-parse", "HEAD"]).stdout };
  });
}

// How many arguments each command takes: an argument `land` does not take, such as a mistyped flag, must not start
// a real landing.
const ARGUMENTS = { land: 0, push: 0, verify: 1 };

function main(argv, { cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(ARGUMENTS, command) || rest.length !== ARGUMENTS[command]) {
    console.error("usage: landing-turn.cjs land | push | verify <remote>");
    return 2;
  }
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
  // push: for a tree that was verified against main's current commit elsewhere (the upstream sync). The push is
  // a fast-forward, so the push takes the turn alone and a main that moved makes git refuse it.
  withTurn({ cwd, remote: "origin" }, (turn) => {
    git(cwd, ["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
      env: { [TURN_ENV]: turn },
    });
  });
  return 0;
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
  macAwakeMs,
  withTurn,
  verifyPush,
  land,
  overlappingWorktrees,
  main,
};
