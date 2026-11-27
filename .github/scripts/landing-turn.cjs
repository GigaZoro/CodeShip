// The landing turn for origin's main. `land` rebases onto main and checks before it waits, then takes a lease on the
// remote (refs/heads/landing-lease/main) and renews it while it holds the turn, so a dead lander frees main within
// LEASE_TTL_MS; under the turn it checks again only if main moved. Main moves only in the atomic push that gives back
// the lander's lease commit. Others wait in a first-come, first-served queue; the pre-push hook (`verify`) checks too.
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TIMED_OUT_STATUS } = require("./bounded-git.cjs");
const { GIT_OUTPUT_MAX_BYTES, REAL_HISTORY_ENV, markedFiles } = require("./git-history.cjs");
const { startLandingRecord } = require("./landing-record.cjs");
const { QUEUE_STALE_MS, createQueueWaiter, machineTag } = require("./lease-queue.cjs");
const { STOP_TREE_MS, spawnChild, spawnTree } = require("./process-tree.cjs");
const { MERGE_DRIVER_CONFIG, notesMergeProblem } = require("./release-notes.cjs");

const LEASE_REF = "refs/heads/landing-lease/main";
// .gitattributes names this driver. Only a landing's own rebase configures it; a manual one merges the file as text.
const BUDGET_MERGE_CONFIG = [
  [
    "merge.agent-context-budget.driver",
    "node .github/scripts/landing-turn.cjs merge-budget %O %A %B",
  ],
];
const TURN_ENV = "T3_LANDING_TURN";
// What a landing's relaunch after its rebase gets of the first process's record.
const RECORD_ENV = "T3_LANDING_RECORD";
const TEST_STEP_MAX_ENV = "CHECK_CHANGED_TEST_STEP_MAX";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// A check:changed run took 2 hours on a busy day. A turn ends this long after its take, on the wall clock, a holder's
// sleep included: other machines wait on it.
const TURN_MAX_MS = 3 * 60 * 60 * 1000;
// The holder renews its lease three times per lease, so a holder that dies frees main within LEASE_TTL_MS, and a
// renewal origin did not answer is tried again before the lease runs out.
const LEASE_TTL_MS = 10 * 60 * 1000;
const LEASE_RENEW_MS = LEASE_TTL_MS / 3;
// What a landing keeps back from its turn for the checks that are not the test step, and for the push.
const LEASE_RESERVE_MS = 20 * 60 * 1000;
const POLL_MS = 5000;
// A wait polls origin thousands of times, and one poll can meet a passing DNS or credential failure. Failures that go
// on this long while the machine is awake end the wait, so a remote that cannot be reached is not tried for hours.
const FAILING_MS = 10 * 60 * 1000;
// One lease or queue call; a remote that stops answering must not hold a wait past its limits.
const LEASE_CALL_MS = 60 * 1000;
// A wait ends once nothing moved for this long: neither the first entry of its queue nor, for the first waiter, the
// lease's holder. A working queue moves within a whole turn, a dead holder's lease running out and a dead first
// waiter's entry going stale.
const MAX_WAIT_MS = TURN_MAX_MS + LEASE_TTL_MS + QUEUE_STALE_MS + LEASE_CALL_MS;
// One fetch or push of main. Renewals go on through it, so a call that hangs would otherwise hold main until the
// turn's end.
const MAIN_CALL_MS = 10 * 60 * 1000;
const BOUNDED_GIT = path.join(__dirname, "bounded-git.cjs");
// How long past a call's limit the landing waits for bounded-git.cjs to end the call: its stop's limit, and the start
// of its processes. A bounded-git.cjs it ends after that still has the call's processes ended.
const STOP_GRACE_MS = STOP_TREE_MS + 5 * 1000;
// A fetch of named objects that leaves tags and FETCH_HEAD, which the checkout's other fetches use, alone.
const FETCH_OBJECTS = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head"];

function gitCommand(cwd, args, { env, config = [] }) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  return [
    ["-C", cwd, ...flags, ...args],
    { env: { ...process.env, ...REAL_HISTORY_ENV, ...env }, windowsHide: true },
  ];
}

function gitResult(args, { status, stdout, stderr, timeoutMs, allowFailure }) {
  // A call that ran out of time is a failed one; like any failed push, it may still have changed origin.
  const timedOut = timeoutMs !== undefined;
  const ok = !timedOut && status === 0;
  const message = timedOut ? `did not finish within ${timeoutMs / 1000} seconds.` : stderr.trim();
  if (!ok && !allowFailure) throw new Error(`git ${args[0]} failed: ${message}`);
  return { ok, timedOut, status, stdout: stdout.trim(), stderr: message };
}

function git(cwd, args, { allowFailure = false, timeoutMs, ...options } = {}) {
  const [argv, spawnOptions] = gitCommand(cwd, args, options);
  const bounded = timeoutMs !== undefined;
  const result = spawnSync(
    bounded ? process.execPath : "git",
    bounded ? [BOUNDED_GIT, String(timeoutMs), ...argv] : argv,
    {
      ...spawnOptions,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
      timeout: bounded ? timeoutMs + STOP_GRACE_MS : undefined,
    },
  );
  const timedOut =
    result.error?.code === "ETIMEDOUT" || (bounded && result.status === TIMED_OUT_STATUS);
  if (result.error && !timedOut) throw result.error;
  return gitResult(args, { ...result, timeoutMs: timedOut ? timeoutMs : undefined, allowFailure });
}

/** Runs `run` once `ms` passed; the function it returns cancels that. */
function runAfter(ms, run) {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

/**
 * `git` that leaves the event loop free, so the lease's renewals go on through a long fetch, rebase or push. A call
 * given `timeoutMs` is stopped once that passed, with every process it started, such as its transport to origin;
 * `after` schedules that stop. Its output has git's shared limit, as `git`'s has.
 */
async function gitAsync(
  cwd,
  args,
  { allowFailure = false, timeoutMs, after = runAfter, ...options } = {},
) {
  const [argv, spawnOptions] = gitCommand(cwd, args, options);
  const limited = timeoutMs !== undefined;
  const { child, stop, done } = (limited ? spawnTree : spawnChild)("git", argv, spawnOptions);
  const output = { stdout: [], stderr: [] };
  let bytes = 0;
  const collect = (chunks) => (chunk) => {
    bytes += chunk.length;
    if (bytes <= GIT_OUTPUT_MAX_BYTES) chunks.push(chunk);
    else child.kill();
  };
  child.stdout.on("data", collect(output.stdout));
  child.stderr.on("data", collect(output.stderr));
  const cancel = limited ? after(timeoutMs, stop) : () => {};
  try {
    const { code, stopped } = await done;
    if (bytes > GIT_OUTPUT_MAX_BYTES) {
      throw new Error(`git ${args[0]} failed: it wrote more than ${GIT_OUTPUT_MAX_BYTES} bytes.`);
    }
    const [stdout, stderr] = [output.stdout, output.stderr].map((chunks) =>
      Buffer.concat(chunks).toString("utf8"),
    );
    const ranOut = stopped ? timeoutMs : undefined;
    return gitResult(args, { status: code, stdout, stderr, timeoutMs: ranOut, allowFailure });
  } finally {
    cancel();
  }
}

/**
 * A fetch from origin's main, given `timeoutMs` of `awakeClock`. A call's limit counts a Mac's sleep, so a fetch that
 * ran out of it with less time awake runs again.
 */
async function fetchAwake(cwd, args, { timeoutMs, awakeClock, after }) {
  const started = awakeClock();
  for (;;) {
    const result = await gitAsync(cwd, args, { timeoutMs, after, allowFailure: true });
    if (result.ok) return result;
    if (!result.timedOut || awakeClock() - started >= timeoutMs) {
      throw new Error(`git ${args[0]} failed: ${result.stderr}`);
    }
  }
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

/** The commit origin's `ref` is at, or null. The lease calls take `{ cwd, remote, callMs }`; `callMs` bounds each one. */
function remoteRef({ cwd, remote, callMs = LEASE_CALL_MS }, ref) {
  const listing = remoteGit(cwd, ["ls-remote", "--refs", remote, ref], callMs).stdout;
  return listing ? listing.split(/\s+/)[0] : null;
}

function remoteLease(lease) {
  return remoteRef(lease, LEASE_REF);
}

/** The first line of a lease commit's message, which holds its data as JSON. */
function leaseLine(cwd, sha) {
  return git(cwd, ["show", "-s", "--format=%B", sha]).stdout.split("\n")[0];
}

function readHolder({ cwd, remote, callMs = LEASE_CALL_MS }, sha) {
  // A lease commit this lander could not fetch is unknown, not unreadable: it may be another lander's live turn.
  remoteGit(cwd, [...FETCH_OBJECTS, remote, sha], callMs);
  try {
    return JSON.parse(leaseLine(cwd, sha));
  } catch {
    return null;
  }
}

/**
 * The turn lease commit `held` belongs to: the take's own commit, which each renewal names. Null when the data names
 * no commit, so nothing from origin becomes a path here.
 */
function turnOf(held, holder) {
  const turn = holder?.turn ?? held;
  return typeof turn === "string" && OBJECT_ID.test(turn) ? turn : null;
}

/** The Git folder every worktree of this clone shares. */
function commonGitDir(cwd) {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
}

/** The landers of the turns taken from this clone, in its own Git folder, so no machine or path reaches origin. */
function holderDir(cwd) {
  return path.join(commonGitDir(cwd), "landing-turn");
}

function holderFile(cwd, turn) {
  return path.join(holderDir(cwd), turn);
}

const BOOT_ID = "/proc/sys/kernel/random/boot_id";
const BOOT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** What /proc gives where it is missing or locked down: nothing to prove a process gone by, so leases only lapse. */
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
function recordHolder(cwd, turn, { pushing = false } = {}) {
  const file = holderFile(cwd, turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Without /proc, the hostname alone: `holder` shows it, and no waiter takes the lease over.
  const record = { pid: process.pid, host: processHost() ?? os.hostname(), checkout: cwd, pushing };
  // Renamed into place, so a waiter never reads half a record.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record));
  fs.renameSync(`${file}.tmp`, file);
}

/** Recursive, so whatever stands at the record's path, a folder included, cannot keep a lease from being taken. */
function forgetHolder(cwd, turn) {
  fs.rmSync(holderFile(cwd, turn), { recursive: true, force: true });
}

/**
 * Removes the records of turns past their end, such as one a waiter in another clone took over or a take whose outcome
 * origin never showed. A record is written before its take, so a live turn's record is never this old.
 */
function pruneHolders(cwd, now) {
  const dir = holderDir(cwd);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.mtimeMs < now - TURN_MAX_MS) fs.rmSync(file, { recursive: true, force: true });
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
 * The lander of `turn` when a worktree of this clone took it, else null. `gone` is true only for a lander in this
 * Linux boot and PID namespace that has exited with no push to main in flight; a record this waiter cannot read, or one
 * from elsewhere, leaves the lease to lapse.
 */
function localHolder(cwd, turn) {
  if (turn === null) return null;
  const file = holderFile(cwd, turn);
  const record = readRecord(file);
  if (record === null) return null;
  const here = processHost();
  if (!provable(record, here)) return { ...record, gone: false };
  try {
    // The pre-push hook loads this script without packages, so it keeps @t3tools/shared/processProbe's rule here:
    // only ESRCH proves the lander gone. A reused process id makes a waiter wait for the lease to lapse instead.
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

/**
 * Whether a lease is live to the wait `runId` on `machine`, by the wait's own clock: one it watched unchanged for its
 * `ttl_ms` awake missed three renewals. One renewed two `ttl_ms` ago by the wall clock is dead at once, unless its
 * holder is on `machine` and slept whenever the wait did. Leases with no `ttl_ms` or `renewed_at` predate them.
 */
function leaseLive(holder, { now, runId, machine, watched }) {
  const ttl = holder.ttl_ms;
  const renewedAt = Date.parse(holder.renewed_at);
  if (
    holder.run_id === runId ||
    !(Number.isFinite(ttl) && ttl > 0) ||
    !Number.isFinite(renewedAt)
  ) {
    return Date.parse(holder.expires_at) > now();
  }
  if (watched(ttl) >= ttl) return false;
  return holder.host === machine || renewedAt + 2 * ttl > now();
}

/**
 * Origin's lease commit (null: none), its turn, and the run id of a live one; a lease that lapsed, or whose lander
 * `localHolder` finds gone, has no live holder. `watched(sha, ttl)` answers how long the wait has been awake since it
 * first read the lease commit `sha`, and needs to be exact only from `ttl` on.
 */
function readLease(
  { readLeaseHolder = readHolder, ...lease },
  { now, runId = null, machine = machineTag(), watched = () => 0 },
) {
  const held = remoteLease(lease);
  if (!held) return { held, turn: null, liveRunId: null };
  const holder = readLeaseHolder(lease, held);
  const turn = turnOf(held, holder);
  // A lease nobody can read is one nobody can release, so it lapses like any other.
  const live =
    holder !== null &&
    leaseLive(holder, { now, runId, machine, watched: (ttl) => watched(held, ttl) }) &&
    localHolder(lease.cwd, turn)?.gone !== true;
  return { held, turn, liveRunId: live ? holder.run_id : null };
}

/**
 * Takes the lease when it is free, lapsed, or held by a lander `localHolder` finds gone; returns it, or null while
 * another lander holds it. A live lease that carries the wait's `runId` is its own, as when a take reached origin
 * although its push reported a failure. `machine` names this machine as the lease does; `onHolder` hears a live lease's
 * run id, and `watched` is readLease's.
 */
function tryAcquire({
  runId,
  now = Date.now,
  machine = machineTag(),
  watched,
  canTake = () => true,
  onHolder = () => {},
  ...lease
}) {
  const { held, turn, liveRunId } = readLease(lease, { now, runId, machine, watched });
  if (liveRunId !== null) {
    onHolder(liveRunId);
    if (liveRunId !== runId) return null;
    recordHolder(lease.cwd, held);
    return held;
  }
  if (!canTake() || (held && !moveLease(lease, held, null))) return null;
  if (turn) forgetHolder(lease.cwd, turn);
  const acquiredAt = now();
  const expiresAt = acquiredAt + LEASE_TTL_MS;
  const sha = landingCommit(lease.cwd, {
    run_id: runId,
    // Who to look for when a turn stays held: the machine and process that renew it.
    host: machine,
    pid: process.pid,
    acquired_at: new Date(acquiredAt).toISOString(),
    renewed_at: new Date(acquiredAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    ttl_ms: LEASE_TTL_MS,
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
 * Gives the lease `sha` of `turn` back unless another lander took it; `pending` is a renewal of `sha` whose answer was
 * lost. A passing failure of origin is tried again as `acquire` does, for `failingMs` of `awakeClock`: a turn left held
 * stalls every lander. True once neither lease can still be used to push main.
 */
function release(
  { failingMs = FAILING_MS, pollMs = POLL_MS, sleep = sleepSync, awakeClock = awakeNow, ...lease },
  sha,
  { pending = null, turn = sha } = {},
) {
  let failingSince = null;
  for (let first = true; ; first = false) {
    let failure;
    try {
      // Deleting the old lease fences a delayed renewal. If the renewal won, only its own commit may be deleted.
      if (!moveLease(lease, sha, null) && pending !== null) moveLease(lease, pending, null);
      forgetHolder(lease.cwd, turn);
      return true;
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
        `landing turn: could not confirm release (the turn may stay held until its lease expires): ${failure.message}\n`,
      );
      return false;
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
 * It ends after `maxWaitMs` in which nothing moved.
 */
function acquire({
  maxWaitMs = MAX_WAIT_MS,
  failingMs = FAILING_MS,
  pollMs = POLL_MS,
  random = Math.random,
  sleep = sleepSync,
  clock = () => performance.now(),
  now = Date.now,
  awakeClock = awakeNow,
  ...options
}) {
  const runId = randomUUID();
  const { cwd, remote, callMs = LEASE_CALL_MS } = options;
  let observedSha;
  let observedHolder;
  const lease = {
    ...options,
    readLeaseHolder(leaseOptions, sha) {
      if (sha !== observedSha) {
        // readHolder throws RemoteFailure if git fetch fails, so only a fetched commit's immutable payload is cached.
        observedHolder = readHolder(leaseOptions, sha);
        observedSha = sha;
      }
      return observedHolder;
    },
  };
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
  let movedAt = clock();
  const last = { head: null, holder: null };
  const moved = (what, value) => {
    if (value === undefined || value === last[what]) return;
    last[what] = value;
    movedAt = clock();
  };
  // The lease commit the wait read last, and when it first did: each renewal is a new commit. A sleep is no time the
  // wait watched. Less than `ttl` on the monotonic clock is less awake, so the awake clock, which on a Mac costs an
  // osascript call, is read again only past that.
  let watch = { sha: null, since: 0, awakeSince: 0 };
  const watched = (sha, ttl) => {
    if (sha !== watch.sha) watch = { sha, since: clock(), awakeSince: awakeClock() };
    const span = clock() - watch.since;
    return span < ttl ? span : awakeClock() - watch.awakeSince;
  };
  // A take that failed partway may have reached origin, and the queue can put another entry first meanwhile.
  let tookMaybe = false;
  try {
    for (;;) {
      let failure = null;
      let firstInQueue = false;
      let polled = false;
      try {
        // A take of its own that origin applied is its turn while it lives; one that lapsed goes back through the queue.
        if (tookMaybe) {
          const { held, liveRunId } = readLease(lease, { now, runId });
          tookMaybe = false;
          if (liveRunId === runId) {
            recordHolder(cwd, held);
            return held;
          }
        }
        firstInQueue = queue.poll();
        polled = true;
        moved("head", queue.head());
        if (firstInQueue) {
          // Only the head polls the lease. It checks its place again before swapping a free or lapsed lease.
          tookMaybe = true;
          const sha = tryAcquire({
            ...lease,
            runId,
            now,
            watched,
            canTake: () => {
              firstInQueue = queue.stillFirst();
              moved("head", queue.head());
              return firstInQueue;
            },
            onHolder: (holder) => moved("holder", holder),
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
      if (clock() - movedAt >= maxWaitMs) {
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
        const failingFor = checkedAt - failingSince;
        if (failingFor >= failingMs) {
          // Only a streak's first failure is logged; this tells the error that ends the wait from a passing one.
          process.stderr.write(
            `landing turn: origin kept failing for ${Math.floor(failingFor / 60_000)} minutes awake; the wait ends.\n`,
          );
          throw failure;
        }
        if (first) process.stderr.write(`landing turn: ${failure.message}\nTrying again.\n`);
      } else {
        failingSince = null;
      }
      sleep(Math.round(pollMs * (0.8 + 0.4 * random())));
    }
  } finally {
    try {
      queue.leave();
    } catch (error) {
      process.stderr.write(`landing turn: could not remove its queue entry: ${error.message}\n`);
    }
  }
}

function repeatEvery(ms, tick) {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

/** When the turn whose lease data is `data` ends; a take recovered after its answer was lost started before its turn. */
function turnEnd(data) {
  return Date.parse(data.acquired_at) + TURN_MAX_MS;
}

/**
 * Holds main's landing turn while `run(turn, signal, pushMain)` runs, in this process alone. `turn` is the first lease
 * commit, renewed every LEASE_RENEW_MS for LEASE_TTL_MS more up to the turn's end. `signal` aborts once the turn is
 * lost, as when this machine slept and another lander took the lease, or at the turn's end. `pushMain(branch, commit)`
 * pushes `commit` there; `every` schedules the renewals and `after` the stops of calls to origin that ran out of time.
 */
async function runWithTurn(
  { every = repeatEvery, after = runAfter, mainCallMs = MAIN_CALL_MS, ...options },
  run,
) {
  const now = options.now ?? Date.now;
  const awakeClock = options.awakeClock ?? awakeNow;
  const turn = acquire(options);
  const lost = new AbortController();
  // The last confirmed lease. Null once the push or the release has finished handling it.
  let current = turn;
  // A renewal of `current` whose answer was lost, which origin may hold instead.
  let pending = null;
  let cancel = () => {};
  let releaseConfirmed = true;
  const lose = (reason) => {
    if (lost.signal.aborted) return;
    process.stderr.write(`landing turn: lost main's landing turn: ${reason}\n`);
    lost.abort(new Error(reason));
  };
  const loseTaken = () => lose("another lander took the lease after it ran out.");
  const forgetTurn = () => {
    current = null;
    forgetHolder(options.cwd, turn);
  };
  /** Resends the same conditional renewal: reading the old commit alone cannot rule out a late write. */
  const settle = () => {
    if (pending === null) return true;
    const took = moveLease(options, current, pending);
    if (took) current = pending;
    else forgetTurn();
    pending = null;
    return took;
  };
  const releaseTurn = () => {
    if (current === null) return true;
    const released = release(options, current, { pending, turn });
    current = null;
    if (!released) releaseConfirmed = false;
    return released;
  };
  /**
   * Whether origin's `branch` is at `candidate` or descends from it: once a push that gave back the lease reached
   * origin, other landers may move main on before this one reads it.
   */
  const mainHolds = async (branch, candidate) => {
    const tip = remoteRef(options, `refs/heads/${branch}`);
    if (tip === null || tip === candidate) return tip === candidate;
    await fetchAwake(options.cwd, [...FETCH_OBJECTS, options.remote, tip], {
      timeoutMs: mainCallMs,
      awakeClock,
      after,
    });
    const ancestry = ["merge-base", "--is-ancestor", candidate, tip];
    const { status, stderr } = await gitAsync(options.cwd, ancestry, { allowFailure: true });
    if (status === 0 || status === 1) return status === 0;
    throw new Error(`git merge-base failed: ${stderr}`);
  };
  let result;
  try {
    const data = JSON.parse(leaseLine(options.cwd, turn));
    let failing = false;
    /** Renews the lease. False when origin holds no lease of the turn any more, which its caller decides on. */
    const renew = () => {
      if (lost.signal.aborted) return true;
      const at = now();
      if (at >= turnEnd(data)) {
        lose("the turn reached its end.");
        return true;
      }
      try {
        if (!settle()) return false;
        const expiresAt = Math.min(at + LEASE_TTL_MS, turnEnd(data));
        pending = landingCommit(
          options.cwd,
          {
            ...data,
            // The take's commit, under which a worktree of this clone records its lander.
            turn,
            renewed_at: new Date(at).toISOString(),
            expires_at: new Date(expiresAt).toISOString(),
          },
          current,
        );
        if (!settle()) return false;
        failing = false;
      } catch (error) {
        if (!(error instanceof RemoteFailure)) {
          lose(error.message);
          return true;
        }
        if (!failing) {
          process.stderr.write(
            `landing turn: could not renew the lease: ${error.message}\nTrying again at the next renewal.\n`,
          );
        }
        failing = true;
      }
      return true;
    };
    const renewHeld = () => {
      if (!renew()) loseTaken();
    };
    // Main moves only in the push that gives back the exact lease commit the turn holds, so origin refuses the push of a
    // holder whose lease another lander took, however late the holder would learn of it. No renewal may move the lease
    // under the push, so the push starts on a fresh lease and is stopped before that lease runs out. A call's limit counts
    // a Mac's sleep, so a push that ran out of it with less time awake runs again, on a renewed lease.
    const pushMain = async (branch, commit) => {
      cancel();
      let sent = false;
      let pushMessage = "";
      let failure;
      try {
        while (renew() && !lost.signal.aborted && settle()) {
          const started = awakeClock();
          const expiresAt = Date.parse(JSON.parse(leaseLine(options.cwd, current)).expires_at);
          const leftMs = Math.min(mainCallMs, expiresAt - now());
          if (leftMs <= 0) {
            lose("the lease ran out before the push.");
            break;
          }
          // A failed push can still land. Keep local waiters from taking this turn until its lease is given back.
          recordHolder(options.cwd, turn, { pushing: true });
          sent = true;
          const pushed = await gitAsync(
            options.cwd,
            [
              "push",
              "--quiet",
              "--atomic",
              `--force-with-lease=${LEASE_REF}:${current}`,
              options.remote,
              `${commit}:refs/heads/${branch}`,
              `:${LEASE_REF}`,
            ],
            { env: { [TURN_ENV]: turn }, allowFailure: true, timeoutMs: leftMs, after },
          );
          if (pushed.ok) {
            forgetTurn();
            return true;
          }
          pushMessage = pushed.stderr;
          if (remoteLease(options) !== current) {
            // A different lease already rules out this delayed write. Only main still needs checking.
            forgetTurn();
            break;
          }
          if (!pushed.timedOut || awakeClock() - started >= leftMs) {
            failure = new Error(`git push failed: ${pushMessage}`);
            break;
          }
        }
      } catch (error) {
        if (!sent) throw error;
        failure = error;
      }
      if (!sent) {
        loseTaken();
        return false;
      }
      // A failed push can win after the first readback. Once its conditional release finishes, the push can no
      // longer change main, so this read decides even when another turn has already advanced main.
      const released = releaseTurn();
      try {
        if (await mainHolds(branch, commit)) return true;
        if (!released) throw new Error("could not confirm the release of the push's lease.");
      } catch (error) {
        throw new Error(
          `git push failed, and whether it landed is unknown: ${pushMessage || failure?.message || ""}\n${error.message}`,
          { cause: error },
        );
      }
      if (failure) throw failure;
      lose("another lander took the lease before the push.");
      return false;
    };
    // A take confirmed late, after a lost answer, has already spent part of its lease.
    if (Date.parse(data.expires_at) - now() < LEASE_TTL_MS - LEASE_RENEW_MS) renewHeld();
    cancel = every(LEASE_RENEW_MS, renewHeld);
    result = await run(turn, lost.signal, pushMain);
  } finally {
    cancel();
    releaseTurn();
  }
  return { result, releaseConfirmed };
}

async function withTurn(options, run) {
  return (await runWithTurn(options, run)).result;
}

/**
 * Pushes `head`, a commit verified against main's current commit elsewhere (the upstream sync, the weekly dependency
 * upgrade). The push is a fast-forward, so it takes the turn alone and a main that moved makes git refuse it.
 */
async function pushChecked({ cwd, remote, head, ...options }) {
  const { releaseConfirmed } = await runWithTurn(
    { cwd, remote, ...options },
    async (_turn, _signal, pushMain) => {
      // A checkout that left the commit during the wait is being changed by something else.
      if (git(cwd, ["rev-parse", "HEAD"]).stdout !== head) {
        throw new Error(
          `landing turn: the checkout moved off ${head} while it waited for the turn.`,
        );
      }
      if (!(await pushMain("main", head))) {
        throw new Error("landing turn: lost main's landing turn before the push.");
      }
    },
  );
  return releaseConfirmed;
}

/**
 * The pre-push check: a push to main must come from the lander whose turn origin's lease is, and give that lease back.
 * The lease must be live, and be the turn's first lease commit or a renewal of it, which descends from it. `updates`
 * are the push's `{ localSha, remoteRef }`. The hook cannot see `--atomic`, and GitHub runs no hook of the repository's
 * own, so a push that names both refs without it passes; `land` pushes them atomically.
 */
function verifyPush({ cwd, remote, env = process.env, updates, now = Date.now }) {
  if (!updates.some(({ remoteRef }) => remoteRef === "refs/heads/main")) return;
  const givesBack = updates.some(
    ({ localSha, remoteRef }) => remoteRef === LEASE_REF && /^0+$/.test(localSha),
  );
  const turn = OBJECT_ID.test(env[TURN_ENV] ?? "") ? env[TURN_ENV] : null;
  const lease = { cwd, remote };
  const held = givesBack && turn ? remoteLease(lease) : null;
  const holder = held ? readHolder(lease, held) : null;
  const ours =
    holder !== null &&
    Date.parse(holder.expires_at) > now() &&
    (held === turn ||
      git(cwd, ["merge-base", "--is-ancestor", turn, held], { allowFailure: true }).ok);
  if (!ours) {
    throw new Error(
      "A push to main needs the landing turn and gives back its lease: land with `node .github/scripts/landing-turn.cjs land`.",
    );
  }
}

/**
 * Seconds a check may spend on its longest step and still end, with the push, before the turn ends: `leftMs` is what
 * the turn had left when it started, `elapsedMs` the time since. The check counts them awake, so a Mac that sleeps
 * under it can outlast the turn; the turn's end then stops it (withTurn).
 */
function checkBudgetSeconds(leftMs, elapsedMs) {
  return Math.max(1, Math.floor((leftMs - LEASE_RESERVE_MS - elapsedMs) / 1000));
}

function stoppedRebase(cwd) {
  return ["rebase-merge", "rebase-apply"].some((name) =>
    fs.existsSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]).stdout),
  );
}

/**
 * Main's commit. Into a ref of this landing's own: any other fetch in this checkout can rewrite FETCH_HEAD before it is
 * read. Atomic, because a named remote's fetch also updates its tracking ref, and a failure there must not leave this
 * one behind. It leaves the event loop free, so a fetch under the turn does not hold back its renewals.
 */
async function fetchMain(cwd, remote, branch, name, call) {
  const fetched = `refs/worktree/landing-turn/${name}`;
  const args = [...FETCH_OBJECTS, "--atomic", remote, `+refs/heads/${branch}:${fetched}`];
  await fetchAwake(cwd, args, call);
  const base = git(cwd, ["rev-parse", fetched]).stdout;
  git(cwd, ["update-ref", "-d", fetched]);
  return base;
}

/** Remote commit of `refs/heads/${branch}`, keeping the event loop free for lease renewals. */
async function remoteBranchSha(cwd, remote, branch, call) {
  const listing = (
    await fetchAwake(cwd, ["ls-remote", "--refs", remote, `refs/heads/${branch}`], call)
  ).stdout;
  const sha = listing ? listing.split(/\s+/)[0] : null;
  return sha && OBJECT_ID.test(sha) ? sha : null;
}

function holds(cwd, base) {
  return git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], { allowFailure: true }).ok;
}

/**
 * Merges agentContextBudget.json: each value keeps what both sides added to the base. AgentContextBudget.test.ts wants
 * the measured values, so a sum that is wrong fails the checks and nothing lands. Exits 1, a conflict, when it cannot.
 */
function mergeBudgetFiles(baseFile, oursFile, theirsFile) {
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const [base, ours, theirs] = [baseFile, oursFile, theirsFile].map(read);
  const shape = (value) => Object.keys(value).sort().join("\n");
  const mergeable =
    [ours, theirs].every((side) => shape(side) === shape(base)) &&
    [base, ours, theirs].every((side) => Object.values(side).every(Number.isInteger));
  if (!mergeable) return 1;
  const keys = Object.keys(base);
  const merged = Object.fromEntries(keys.map((key) => [key, ours[key] + theirs[key] - base[key]]));
  fs.writeFileSync(oursFile, `${JSON.stringify(merged, null, 2)}\n`);
  return 0;
}

/**
 * A Mac on battery idle-sleeps after a minute, and check:changed's time limits count the time asleep, so a landing
 * left alone failed on timeouts. macOS holds idle sleep off until `pid` exits; closing the lid still sleeps it.
 */
function keepAwake({
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
  platform = process.platform,
  pid = process.pid,
  run = spawn,
} = {}) {
  if (platform !== "darwin") return;
  const holder = run("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
  // A landing without the hold still works while someone keeps the machine awake.
  holder.on("error", () => {});
  holder.unref();
}

/**
 * Rebases HEAD onto `base` unless HEAD holds it already. A conflict must not leave the worktree in the middle of the
 * rebase: the next landing would refuse it.
 */
async function rebaseOnto(cwd, base) {
  if (holds(cwd, base)) return;
  try {
    // Main gains release notes and tool text while a lander waits; the drivers merge them, whatever git config says.
    await gitAsync(cwd, ["rebase", base], {
      config: [...MERGE_DRIVER_CONFIG, ...BUDGET_MERGE_CONFIG],
    });
  } catch (error) {
    if (stoppedRebase(cwd)) {
      error.landingStatus = "conflict";
      await gitAsync(cwd, ["rebase", "--abort"], { allowFailure: true });
    }
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
 * outside the landing knows this directory, so the checks read exactly the commit. Its git calls leave the event loop
 * free, so the lease's renewals go on meanwhile.
 */
async function withPrivateCheckout({ cwd, commit }, run) {
  const directory = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  await gitAsync(cwd, ["worktree", "add", "--quiet", "--detach", directory, commit]);
  try {
    return await run(directory);
  } finally {
    await gitAsync(cwd, ["worktree", "remove", "--force", directory], { allowFailure: true });
    await fs.promises.rm(directory, { recursive: true, force: true });
    await gitAsync(cwd, ["worktree", "prune"], { allowFailure: true });
  }
}

/**
 * Lands HEAD on main: checks before the wait, again under the turn only if main moved. `finalize` runs under the turn
 * on that candidate first, and drift afterwards aborts. Every end appends one record (landing-record.cjs) but a rebase
 * before the wait: `onRebased` gets its state, which the relaunch takes as `carried`.
 */
async function land({
  now = Date.now,
  recordClock = () => performance.now(),
  carried,
  onRebased = () => {},
  ...options
}) {
  const record = startLandingRecord({ now, clock: recordClock, carried });
  let status;
  try {
    const result = await runLanding({ ...options, now }, record);
    status = result.status;
    if (status === "rebased") onRebased(record.carry());
    return result;
  } catch (error) {
    status = error?.landingStatus ?? "error";
    throw error;
  } finally {
    if (status !== "rebased") record.write(() => commonGitDir(options.cwd), status);
  }
}

async function runLanding(
  {
    cwd,
    remote,
    check,
    finalize,
    rebased,
    branch = "main",
    mainCallMs = MAIN_CALL_MS,
    after = runAfter,
    turnClock = () => performance.now(),
    now,
    awakeClock = awakeNow,
    report = (text) => console.error(text),
    ...rest
  },
  record,
) {
  const mainCall = { timeoutMs: mainCallMs, awakeClock, after };
  // Read first, so the checks below, these on the working tree included, are for this commit.
  let tip = git(cwd, ["rev-parse", "HEAD"]).stdout;
  const { stdout: topic } = git(cwd, ["branch", "--show-current"], { allowFailure: true });
  record.note({ branch: topic || null, head: tip });
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
  const checked = rebased?.base ?? (await fetchMain(cwd, remote, branch, randomUUID(), mainCall));
  record.note({ base: checked });
  // Before the rebase, so a conflict still shows it; the relaunch after a rebase listed it already.
  if (!rebased) {
    const overlap = formatOverlaps(overlappingWorktrees({ cwd, base: checked }));
    if (overlap) report(overlap);
  }
  // Another process can move the checkout at any moment; each check below covers what it is now.
  if (git(cwd, ["rev-parse", "HEAD"]).stdout !== tip) return { status: "head-moved" };
  if (!holds(cwd, checked)) {
    if (rebased) return { status: "head-moved" };
    await record.time("rebase", () => rebaseOnto(cwd, checked));
    return { status: "rebased", base: checked, head: git(cwd, ["rev-parse", "HEAD"]).stdout };
  }
  // Before the wait too, so a failure holds no turn and the turn lasts for the push alone while main stays still.
  const checkTip = (turn, base, budgetSeconds, signal) =>
    withPrivateCheckout({ cwd, commit: tip }, (directory) =>
      check(turn, base, budgetSeconds, directory, signal),
    );
  if (!(await record.time("preWaitCheck", () => checkTip(null, checked)))) {
    return { status: "check-failed" };
  }
  record.note({ stage: "waiting" });
  const waited = record.begin("waitForTurn");
  const { result, releaseConfirmed } = await runWithTurn(
    { cwd, remote, now, mainCallMs, after, awakeClock, ...rest },
    async (turn, signal, pushMain) => {
      waited();
      record.note({ stage: "under-turn" });
      const turnStarted = turnClock();
      const leftMs = turnEnd(JSON.parse(leaseLine(cwd, turn))) - now();
      const lostTurn = () => ({ status: "lost-turn", reason: signal.reason.message });
      const base = await fetchMain(cwd, remote, branch, turn, mainCall);
      record.note({ base });
      // The checks passed for this commit, not for one checked out during the wait or this fetch.
      const headAfterFetch = git(cwd, ["rev-parse", "HEAD"]).stdout;
      if (headAfterFetch !== tip) {
        return { status: "head-moved", expected: tip, actual: headAfterFetch };
      }
      const rebasedUnderTurn = base !== checked;
      if (rebasedUnderTurn) {
        await record.time("rebase", () => rebaseOnto(cwd, base));
        tip = git(cwd, ["rev-parse", "HEAD"]).stdout;
        record.note({ head: tip });
      }
      if (signal.aborted) return lostTurn();
      const verifyUnchanged = async (expectedTip, expectedBase) => {
        const currentHead = git(cwd, ["rev-parse", "HEAD"]).stdout;
        if (currentHead !== expectedTip) {
          return { status: "head-moved", expected: expectedTip, actual: currentHead };
        }
        const currentBase = await remoteBranchSha(cwd, remote, branch, mainCall);
        if (signal.aborted) return lostTurn();
        if (currentBase !== expectedBase) {
          return { status: "base-moved", expected: expectedBase, actual: currentBase };
        }
        return null;
      };
      if (finalize) {
        const finalizedTip = tip;
        const finalizedBase = base;
        const budget = checkBudgetSeconds(leftMs, turnClock() - turnStarted);
        const approved = await record.time("finalize", () =>
          withPrivateCheckout({ cwd, commit: finalizedTip }, (directory) =>
            finalize({
              turn,
              commit: finalizedTip,
              base: finalizedBase,
              rebased: rebasedUnderTurn,
              budgetSeconds: budget,
              directory,
              signal,
            }),
          ),
        );
        if (signal.aborted) return lostTurn();
        if (!approved) {
          return { status: "finalize-failed", commit: finalizedTip, base: finalizedBase };
        }
        const drift = await verifyUnchanged(finalizedTip, finalizedBase);
        if (drift) return drift;
      }
      if (rebasedUnderTurn) {
        const budget = checkBudgetSeconds(leftMs, turnClock() - turnStarted);
        const passed = await record.time("underTurnCheck", () =>
          checkTip(turn, base, budget, signal),
        );
        if (signal.aborted) return lostTurn();
        if (!passed) return { status: "check-failed" };
        const drift = await verifyUnchanged(tip, base);
        if (drift) return drift;
      }
      if (!(await record.time("push", () => pushMain(branch, tip)))) return lostTurn();
      return { status: "landed", commit: tip };
    },
  );
  record.note({ releaseConfirmed });
  return releaseConfirmed ? result : { ...result, releaseConfirmed };
}

const FINAL_COMMIT_ENV = "T3_LANDING_FINAL_COMMIT";
const FINAL_BASE_ENV = "T3_LANDING_FINAL_BASE";
const FINAL_REBASED_ENV = "T3_LANDING_REBASED";

/**
 * Installs and runs `vp run check:changed` against `base` in the private checkout `directory`, under the turn when
 * `turn` is one. A lost turn stops them and every process they started, since their pass could no longer be pushed,
 * and resolves to false once those are gone; a lander that dies ends them too. `command`, `stdio` and `onSpawn` are
 * for tests.
 */
async function runCheck(
  directory,
  turn,
  base,
  budgetSeconds,
  signal,
  {
    // The private checkout has no node_modules; the store's hardlinks make this install cheap.
    command = `vp i --frozen-lockfile --offline && vp run check:changed ${base}`,
    stdio = "inherit",
    onSpawn = () => {},
  } = {},
) {
  const { child, stop, done } = spawnTree(command, [], {
    cwd: directory,
    shell: true,
    stdio,
    env: {
      ...process.env,
      // Unset before the wait: only the holder's checks take slots ahead of other runs.
      [TURN_ENV]: turn ?? undefined,
      [TEST_STEP_MAX_ENV]: budgetSeconds === undefined ? undefined : String(budgetSeconds),
    },
  });
  onSpawn(child);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const { code, stopped } = await done;
    return !stopped && code === 0;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * Runs a user-supplied finalization command (such as exact-SHA review and build) in the private checkout `directory`
 * once the final candidate commit and base are established under the turn. A lost turn stops its whole process tree.
 */
async function runFinalize(
  directory,
  { turn, commit, base, rebased, budgetSeconds, signal },
  { command, stdio = "inherit", onSpawn = () => {} },
) {
  const { child, stop, done } = spawnTree(command, [], {
    cwd: directory,
    shell: true,
    stdio,
    env: {
      ...process.env,
      [TURN_ENV]: turn,
      [TEST_STEP_MAX_ENV]: budgetSeconds === undefined ? undefined : String(budgetSeconds),
      [FINAL_COMMIT_ENV]: commit,
      [FINAL_BASE_ENV]: base,
      [FINAL_REBASED_ENV]: rebased ? "1" : "0",
    },
  });
  onSpawn(child);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    const { code, stopped } = await done;
    return !stopped && code === 0;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

// How many arguments each command takes: an argument `land` does not take, such as a mistyped flag, must not start
// a real landing.
const USAGE =
  "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote> | merge-budget <base> <ours> <theirs> | land --finalize <command>";
const ARGUMENTS = { push: 1, holder: 0, verify: 1, "merge-budget": 3 };

function parseLandArgs(command, rest) {
  if (command === "land") {
    if (rest.length === 0) return { rebased: undefined, finalizeCommand: undefined };
    if (rest.length === 2 && rest[0] === "--finalize" && rest[1].trim().length > 0) {
      return { rebased: undefined, finalizeCommand: rest[1] };
    }
    return null;
  }
  if (command === "land-rebased") {
    if (rest.length !== 4 && rest.length !== 6) return null;
    const [baseFlag, base, headFlag, head, finalizeFlag, finalizeCommand] = rest;
    if (
      baseFlag !== "--base" ||
      headFlag !== "--head" ||
      !OBJECT_ID.test(base) ||
      !OBJECT_ID.test(head)
    ) {
      return null;
    }
    if (rest.length === 6) {
      if (finalizeFlag !== "--finalize" || finalizeCommand.trim().length === 0) return null;
      return { rebased: { base, head }, finalizeCommand };
    }
    return { rebased: { base, head }, finalizeCommand: undefined };
  }
  return null;
}

async function main(argv, { cwd = process.cwd(), failingMs, check, finalize } = {}) {
  const [command, ...rest] = argv;
  if (command === "land" || command === "land-rebased") {
    const parsed = parseLandArgs(command, rest);
    if (!parsed) {
      console.error(USAGE);
      return 2;
    }
    const { rebased, finalizeCommand } = parsed;
    // Taken out of the environment, so no child process inherits it.
    const carried = rebased ? process.env[RECORD_ENV] : undefined;
    delete process.env[RECORD_ENV];
    keepAwake();
    let carry;
    const result = await land({
      cwd,
      remote: "origin",
      ...(failingMs === undefined ? {} : { failingMs }),
      rebased,
      carried,
      onRebased: (state) => (carry = state),
      finalize:
        finalize ??
        (finalizeCommand
          ? (details) => runFinalize(details.directory, details, { command: finalizeCommand })
          : undefined),
      check:
        check ??
        ((turn, base, budgetSeconds, directory, signal) =>
          runCheck(directory, turn, base, budgetSeconds, signal)),
    });
    if (result.status === "rebased") {
      return (
        spawnSync(
          process.execPath,
          [
            __filename,
            "land-rebased",
            "--base",
            result.base,
            "--head",
            result.head,
            ...(finalizeCommand ? ["--finalize", finalizeCommand] : []),
          ],
          {
            cwd,
            stdio: "inherit",
            env: { ...process.env, [RECORD_ENV]: carry },
          },
        ).status ?? 1
      );
    }
    console.log(JSON.stringify(result));
    return result.status === "landed" && result.releaseConfirmed !== false ? 0 : 1;
  }
  if (!Object.hasOwn(ARGUMENTS, command) || rest.length !== ARGUMENTS[command]) {
    console.error(USAGE);
    return 2;
  }
  if (command === "merge-budget") return mergeBudgetFiles(...rest);
  if (command === "verify") {
    // The pre-push hook passes the remote's URL, then git writes one `<local ref> <sha> <remote ref> <sha>` line per ref.
    // Git gives the local ref as it was typed, which may hold spaces; a ref name and an object name cannot.
    const updates = fs
      .readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [localSha, remoteRef, remoteSha] = line.split(" ").slice(-3);
        if (!OBJECT_ID.test(localSha ?? "") || !OBJECT_ID.test(remoteSha ?? "") || !remoteRef) {
          throw new Error(`landing turn: cannot read the pushed ref in "${line}"`);
        }
        return { localSha, remoteRef };
      });
    verifyPush({ cwd, remote: rest[0], updates });
    return 0;
  }
  if (command === "push") {
    // A full id, never a ref: the commit is fixed before the wait, so nothing the checkout does meanwhile can land.
    const [head] = rest;
    if (!OBJECT_ID.test(head)) {
      console.error(USAGE);
      return 2;
    }
    const releaseConfirmed = await pushChecked({
      cwd,
      remote: "origin",
      head,
      ...(failingMs === undefined ? {} : { failingMs }),
    });
    const result = { status: "landed", commit: head };
    console.log(JSON.stringify(releaseConfirmed ? result : { ...result, releaseConfirmed }));
    return releaseConfirmed ? 0 : 1;
  }
  if (command === "holder") {
    // `local` is null when no worktree of this clone took the lease, and `gone` says whether a waiter here takes it.
    const sha = remoteLease({ cwd, remote: "origin" });
    const lease = sha && readHolder({ cwd, remote: "origin" }, sha);
    const local = sha && localHolder(cwd, turnOf(sha, lease));
    console.log(JSON.stringify({ lease: sha, ...lease, local }));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  BOOT_ID,
  LEASE_REF,
  TURN_ENV,
  RECORD_ENV,
  FINAL_COMMIT_ENV,
  FINAL_BASE_ENV,
  FINAL_REBASED_ENV,
  TURN_MAX_MS,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
  LEASE_RESERVE_MS,
  MAX_WAIT_MS,
  checkBudgetSeconds,
  keepAwake,
  macAwakeMs,
  withTurn,
  pushChecked,
  verifyPush,
  land,
  overlappingWorktrees,
  main,
  processHost,
  // For tests alone: a turn taken outside withTurn is never renewed, and outlives a process that leaves it held.
  testing: { tryAcquire, acquire, release, runCheck, runFinalize },
};
