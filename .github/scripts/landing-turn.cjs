// Landers check before joining the queue and recheck under the lease if main moved.
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GIT_OUTPUT_MAX_BYTES, REAL_HISTORY_ENV, markedFiles } = require("./git-history.cjs");
const { createQueueWaiter } = require("./lease-queue.cjs");
const { MERGE_DRIVER_CONFIG, notesMergeProblem } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
const TURN_ENV = "T3_LANDING_TURN";
const TEST_STEP_MAX_ENV = "CHECK_CHANGED_TEST_STEP_MAX";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
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
// One fetch or push of main; a remote that stops answering must not hold a lander, or its turn, until the lease expires.
const MAIN_CALL_MS = 10 * 60 * 1000;

function git(cwd, args, { env, config = [], allowFailure = false, timeoutMs } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV, ...env },
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
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

/** The landers of the leases taken from this clone, in its own Git folder, so no machine or path reaches origin. */
function holderDir(cwd) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  return path.join(common, "landing-turn");
}

function holderFile(cwd, sha) {
  return path.join(holderDir(cwd), sha);
}

const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const BOOT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** What /proc gives where it is missing or locked down: nothing to prove a process gone by, so leases only expire. */
const NO_PROC = new Set(["ENOENT", "EACCES", "EPERM"]);

/**
 * This hostname, kernel boot and PID namespace, or null when /proc cannot tell the last two, including a boot id that
 * is not one. A process id recorded under another one says nothing about this one: two machines can share a hostname,
 * a clone and a namespace's inode number.
 */
function processHost() {
  try {
    const boot = fs.readFileSync(BOOT_ID, "utf8").trim();
    if (!BOOT_UUID.test(boot)) return null;
    return `${os.hostname()} ${boot} ${fs.readlinkSync("/proc/self/ns/pid")}`;
  } catch (error) {
    if (NO_PROC.has(error?.code)) return null;
    throw error;
  }
}

/** `pushing`: the lander's push to main may be in flight, and a git push goes on after its lander dies. */
function recordHolder(cwd, sha, { pushing = false } = {}) {
  const file = holderFile(cwd, sha);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Without /proc, the hostname alone: `holder` shows it, and no waiter takes the lease over.
  const record = { pid: process.pid, host: processHost() ?? os.hostname(), checkout: cwd, pushing };
  // Renamed into place, so a waiter never reads half a record.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);
}

/** Recursive, so whatever stands at the record's path, a folder included, cannot keep a lease from being taken. */
function forgetHolder(cwd, sha) {
  fs.rmSync(holderFile(cwd, sha), { recursive: true, force: true });
}

/**
 * Removes the records of leases past their lifetime, such as one a waiter in another clone took over or a take whose
 * outcome origin never showed. A record is written before its lease, so a live lease's record is never this old.
 */
function pruneHolders(cwd, now) {
  const dir = holderDir(cwd);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.mtimeMs < now - LEASE_TTL_MS)
      fs.rmSync(file, { recursive: true, force: true });
  }
}

/** The record at `file`: null when there is none, `problem` when it cannot be read or names no process. */
function readRecord(file) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { problem: `cannot read ${file}: ${error.message}` };
  }
  if (!Number.isInteger(record?.pid) || record.pid <= 0 || typeof record.host !== "string") {
    return { problem: `${file} names no process` };
  }
  return record;
}

/** A lander this waiter may prove gone: recorded under the waiter's own processHost, with no push to main in flight. */
function provable(record, here) {
  return here !== null && !record.problem && record.pushing === false && record.host === here;
}

/**
 * The lander of lease `sha` when a worktree of this clone took it, else null. `gone` is true only for a lander in this
 * Linux boot and PID namespace that has exited with no push to main in flight; a record this waiter cannot read, or one
 * from elsewhere, leaves the lease to expire.
 */
function localHolder(cwd, sha) {
  const file = holderFile(cwd, sha);
  const record = readRecord(file);
  if (record === null) return null;
  const here = processHost();
  if (!provable(record, here)) return { ...record, gone: false };
  try {
    // The pre-push hook loads this script without packages, so it keeps @t3tools/shared/processProbe's rule here:
    // only ESRCH proves the lander gone. A reused process id makes a waiter wait for the lease to expire instead.
    // oxlint-disable-next-line t3code/no-raw-process-probe -- a CommonJS script that loads no package
    process.kill(record.pid, 0);
    return { ...record, gone: false };
  } catch (error) {
    if (error?.code !== "ESRCH") return { ...record, gone: false };
  }
  // The lander may have marked a push between the read and the probe. Gone now, it writes no more.
  const final = readRecord(file);
  const gone = final !== null && provable(final, here) && final.pid === record.pid;
  return { ...(final ?? record), gone };
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
  const live =
    holder !== null &&
    Date.parse(holder.expires_at) > now() &&
    localHolder(lease.cwd, held)?.gone !== true;
  return { held, liveRunId: live ? holder.run_id : null };
}

/**
 * Takes the lease when it is free, expired, or held by a lander `localHolder` finds gone. Returns the lease commit,
 * or null while another lander holds it.
 * `runId` names one wait: a live lease that carries it is that wait's own, as when a take reached origin although its
 * push reported a failure.
 */
function tryAcquire({ runId, now = Date.now, canTake = () => true, ...lease }) {
  const { held, liveRunId } = readLease(lease, now);
  if (liveRunId !== null) {
    if (liveRunId !== runId) return null;
    recordHolder(lease.cwd, held);
    return held;
  }
  if (!canTake() || (held && !moveLease(lease, held, null))) return null;
  if (held) forgetHolder(lease.cwd, held);
  const acquiredAt = now();
  const expiresAt = acquiredAt + LEASE_TTL_MS;
  const sha = landingCommit(lease.cwd, {
    run_id: runId,
    acquired_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
  // A push that creates the ref is atomic: when two landers race, the remote takes one and refuses the other.
  pruneHolders(lease.cwd, acquiredAt);
  recordHolder(lease.cwd, sha);
  if (!moveLease(lease, null, sha)) {
    forgetHolder(lease.cwd, sha);
    return null;
  }
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

/**
 * Gives the lease back. A passing failure of origin is tried again as `acquire` does, for `failingMs` of `awakeClock`: a
 * turn left held stalls every lander.
 */
function release(
  { failingMs = FAILING_MS, pollMs = POLL_MS, sleep = sleepSync, awakeClock = awakeNow, ...lease },
  sha,
) {
  let failingSince = null;
  for (let first = true; ; first = false) {
    let failure;
    try {
      // False when a waiter took over a lease that had expired; either way it is no longer this lander's.
      moveLease(lease, sha, null);
      forgetHolder(lease.cwd, sha);
      return;
    } catch (error) {
      failure = error;
    }
    let spent = true;
    if (failure instanceof RemoteFailure) {
      try {
        const checkedAt = awakeClock();
        failingSince ??= checkedAt;
        spent = checkedAt - failingSince >= failingMs;
      } catch (error) {
        failure = new Error(`${failure.message}\n${error.message}`);
      }
    }
    if (spent) {
      // Thrown from withTurn's finally block, it would replace the landing's own result.
      process.stderr.write(
        `landing turn: the turn may stay held until its lease expires: ${failure.message}\n`,
      );
      return;
    }
    if (first) process.stderr.write(`landing turn: ${failure.message}\nTrying again.\n`);
    sleep(pollMs);
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
      windowsHide: true,
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
          if (liveRunId === runId) {
            recordHolder(cwd, held);
            return held;
          }
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

/**
 * Pushes `ref` under `turn`. A git push goes on after its lander dies, and one that failed may still land, so the
 * lander's record shows the push in flight until it gives the turn back, and no waiter takes the turn over meanwhile.
 */
function pushUnderTurn({ cwd, remote, ref, turn, timeoutMs }) {
  recordHolder(cwd, turn, { pushing: true });
  git(cwd, ["push", "--quiet", remote, ref], { env: { [TURN_ENV]: turn }, timeoutMs });
}

/**
 * Pushes `head`, a commit verified against main's current commit elsewhere (the upstream sync, the weekly dependency
 * upgrade). The push is a fast-forward, so it takes the turn alone and a main that moved makes git refuse it.
 */
function pushChecked({ cwd, remote, head }) {
  withTurn({ cwd, remote }, (turn) => {
    // A checkout that left the commit during the wait is being changed by something else.
    if (git(cwd, ["rev-parse", "HEAD"]).stdout !== head) {
      throw new Error(`landing turn: the checkout moved off ${head} while it waited for the turn.`);
    }
    pushUnderTurn({ cwd, remote, ref: `${head}:refs/heads/main`, turn, timeoutMs: MAIN_CALL_MS });
  });
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

/**
 * Main's commit. Into a ref of this landing's own: any other fetch in this checkout can rewrite FETCH_HEAD before it is
 * read. Atomic, because a named remote's fetch also updates its tracking ref, and a failure there must not leave this
 * one behind.
 */
function fetchMain(cwd, remote, branch, name, callMs) {
  const fetched = `refs/worktree/landing-turn/${name}`;
  git(
    cwd,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--atomic",
      remote,
      `+refs/heads/${branch}:${fetched}`,
    ],
    { timeoutMs: callMs },
  );
  const base = git(cwd, ["rev-parse", fetched]).stdout;
  git(cwd, ["update-ref", "-d", fetched]);
  return base;
}

function holds(cwd, base) {
  return git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], { allowFailure: true }).ok;
}

/**
 * Rebases HEAD onto `base` unless HEAD holds it already. A conflict must not leave the worktree in the middle of the
 * rebase: the next landing would refuse it.
 */
function rebaseOnto(cwd, base) {
  if (holds(cwd, base)) return;
  try {
    // Main gains release notes while a lander waits; the driver merges them on machines whose git config predates it.
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
  const self = path.resolve(git(cwd, ["rev-parse", "--show-toplevel"]).stdout);
  const overlaps = [];
  for (const block of git(cwd, ["worktree", "list", "--porcelain"]).stdout.split("\n\n")) {
    const fields = Object.fromEntries(
      block.split("\n").map((line) => {
        const space = line.indexOf(" ");
        return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
      }),
    );
    if (!fields.worktree || fields.bare !== undefined || fields.prunable !== undefined) continue;
    // Git for Windows lists `C:/…`: the lander reads the path as this system writes it.
    const worktree = path.resolve(fields.worktree);
    if (worktree === self) continue;
    if (!fields.HEAD) continue;
    const shared = changed(fields.HEAD).filter((file) => mine.has(file));
    if (shared.length > 0) {
      overlaps.push({
        branch:
          fields.branch?.replace(/^refs\/heads\//, "") ?? `(detached ${fields.HEAD.slice(0, 10)})`,
        worktree,
        files: shared,
      });
    }
  }
  return overlaps;
}

/** The overlap listing a lander reads before its rebase, checks and wait, so it can reconcile first. */
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
 * Runs `run(directory)` in a private detached checkout of `commit`. The lander's own worktree stays writable by
 * editors and other agents while the checks run, and an edit made and undone in it would leave no trace; nothing
 * outside the landing knows this directory, so the checks read exactly the commit.
 */
function withPrivateCheckout({ cwd, commit }, run) {
  const directory = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  git(cwd, ["worktree", "add", "--quiet", "--detach", directory, commit]);
  try {
    return run(directory);
  } finally {
    git(cwd, ["worktree", "remove", "--force", directory], { allowFailure: true });
    fs.rmSync(directory, { recursive: true, force: true });
    git(cwd, ["worktree", "prune"], { allowFailure: true });
  }
}

/**
 * Lands HEAD on main: checks before the wait, again under the turn only if main moved. `check(turn, base,
 * budgetSeconds, directory)` is true when the checks passed in `directory`, a private checkout of the commit,
 * against `base`; `turn` is null before the wait. `rebased` continues a landing that returned `rebased`.
 */
function land({
  cwd,
  remote,
  check,
  rebased,
  branch = "main",
  mainCallMs = MAIN_CALL_MS,
  turnClock = () => performance.now(),
  now = Date.now,
  report = (text) => console.error(text),
  ...rest
}) {
  // Read first, so the checks below, these on the working tree included, are for this commit.
  let tip = git(cwd, ["rev-parse", "HEAD"]).stdout;
  if (rebased && tip !== rebased.head) return { status: "head-moved" };
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
  // Before the wait, so a conflict stops the landing with no turn held. The CLI then lands the rebased commit again
  // from its tree, so the wait runs that tree's copy of this script, checking against the base it rebased onto.
  const checked = rebased?.base ?? fetchMain(cwd, remote, branch, randomUUID(), mainCallMs);
  // Before the rebase, so a conflict still shows it; the relaunch after a rebase listed it already.
  if (!rebased) {
    const overlap = formatOverlaps(overlappingWorktrees({ cwd, base: checked }));
    if (overlap) report(overlap);
  }
  // Another process can move the checkout at any moment; each check below covers what it is now.
  if (git(cwd, ["rev-parse", "HEAD"]).stdout !== tip) return { status: "head-moved" };
  if (!holds(cwd, checked)) {
    if (rebased) return { status: "head-moved" };
    rebaseOnto(cwd, checked);
    return { status: "rebased", base: checked, head: git(cwd, ["rev-parse", "HEAD"]).stdout };
  }
  // Before the wait too, so a failure holds no turn and the turn lasts for the push alone while main stays still.
  if (
    !withPrivateCheckout({ cwd, commit: tip }, (directory) =>
      check(null, checked, undefined, directory),
    )
  ) {
    return { status: "check-failed" };
  }
  return withTurn({ cwd, remote, now, ...rest }, (turn) => {
    const turnStarted = turnClock();
    const leftMs = leaseLeftMs(cwd, turn, now);
    const base = fetchMain(cwd, remote, branch, turn, mainCallMs);
    // The checks passed for this commit, not for one checked out during the wait or this fetch.
    if (git(cwd, ["rev-parse", "HEAD"]).stdout !== tip) return { status: "head-moved" };
    if (base !== checked) {
      rebaseOnto(cwd, base);
      tip = git(cwd, ["rev-parse", "HEAD"]).stdout;
      const budgetSeconds = checkBudgetSeconds(leftMs, turnClock() - turnStarted);
      if (
        !withPrivateCheckout({ cwd, commit: tip }, (directory) =>
          check(turn, base, budgetSeconds, directory),
        )
      ) {
        return { status: "check-failed" };
      }
    }
    pushUnderTurn({ cwd, remote, ref: `${tip}:refs/heads/${branch}`, turn, timeoutMs: mainCallMs });
    return { status: "landed", commit: tip };
  });
}

// How many arguments each command takes: an argument `land` does not take, such as a mistyped flag, must not start
// a real landing.
const USAGE =
  "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote>";
const ARGUMENTS = { land: 0, "land-rebased": 4, push: 1, holder: 0, verify: 1 };

function main(argv, { cwd = process.cwd() } = {}) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(ARGUMENTS, command) || rest.length !== ARGUMENTS[command]) {
    console.error(USAGE);
    return 2;
  }
  if (command === "verify") {
    // The pre-push hook passes the remote's URL, then git writes one `<local ref> <sha> <remote ref> <sha>` line per ref.
    // Git gives the local ref as it was typed, which may hold spaces; a ref name and an object name cannot.
    const refs = require("node:fs")
      .readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [localSha, remoteRef, remoteSha] = line.split(" ").slice(-3);
        if (!OBJECT_ID.test(localSha ?? "") || !OBJECT_ID.test(remoteSha ?? "") || !remoteRef) {
          throw new Error(`landing turn: cannot read the pushed ref in "${line}"`);
        }
        return remoteRef;
      });
    verifyPush({ cwd, remote: rest[0], refs });
    return 0;
  }
  // `land-rebased` is the run a `land` relaunches from its rebased tree, after it fetched main and listed the overlaps.
  // A command of its own, so a copy of this script that cannot continue such a landing refuses it.
  if (command === "land" || command === "land-rebased") {
    const [baseFlag, base, headFlag, head] = rest;
    if (
      command === "land-rebased" &&
      (baseFlag !== "--base" ||
        headFlag !== "--head" ||
        !OBJECT_ID.test(base) ||
        !OBJECT_ID.test(head))
    ) {
      console.error(USAGE);
      return 2;
    }
    const result = land({
      cwd,
      remote: "origin",
      rebased: command === "land-rebased" ? { base, head } : undefined,
      check: (turn, base, budgetSeconds, directory) =>
        // The private checkout has no node_modules; the store's hardlinks make this install cheap.
        ["vp i --frozen-lockfile --offline", `vp run check:changed ${base}`].every(
          (command) =>
            spawnSync(command, {
              cwd: directory,
              shell: true,
              stdio: "inherit",
              env: {
                ...process.env,
                // Unset before the wait: only the holder's checks take slots ahead of other runs.
                [TURN_ENV]: turn ?? undefined,
                [TEST_STEP_MAX_ENV]:
                  budgetSeconds === undefined ? undefined : String(budgetSeconds),
              },
            }).status === 0,
        ),
    });
    if (result.status === "rebased") {
      return (
        spawnSync(
          process.execPath,
          [__filename, "land-rebased", "--base", result.base, "--head", result.head],
          {
            cwd,
            stdio: "inherit",
          },
        ).status ?? 1
      );
    }
    console.log(JSON.stringify(result));
    return result.status === "landed" ? 0 : 1;
  }
  if (command === "push") {
    // A full id, never a ref: the commit is fixed before the wait, so nothing the checkout does meanwhile can land.
    const [head] = rest;
    if (!OBJECT_ID.test(head)) {
      console.error(USAGE);
      return 2;
    }
    pushChecked({ cwd, remote: "origin", head });
    console.log(JSON.stringify({ status: "landed", commit: head }));
    return 0;
  }
  if (command === "holder") {
    // `local` is null when no worktree of this clone took the lease, and `gone` says whether a waiter here takes it.
    const sha = remoteLease({ cwd, remote: "origin" });
    const lease = sha && readHolder({ cwd, remote: "origin" }, sha);
    console.log(JSON.stringify({ lease: sha, ...lease, local: sha && localHolder(cwd, sha) }));
    return 0;
  }
  console.error(USAGE);
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
  BOOT_ID,
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
  pushChecked,
  verifyPush,
  land,
  overlappingWorktrees,
  main,
  processHost,
};
