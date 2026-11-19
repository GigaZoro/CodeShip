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

function git(cwd, args, { env, config = [], allowFailure = false } = {}) {
  const flags = config.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  const result = spawnSync("git", ["-C", cwd, ...flags, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
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
 * Lands HEAD on main under the turn: rebases onto main, runs `check` once and pushes the checked tree.
 * `check(turn)` returns true when the checks passed.
 */
function land({ cwd, remote, check, branch = "main", runId = randomUUID(), ...rest }) {
  return withTurn({ cwd, remote, runId, ...rest }, (turn) => {
    git(cwd, ["fetch", "--quiet", "--no-tags", remote, branch]);
    const contained = git(cwd, ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], {
      allowFailure: true,
    }).ok;
    // Main gains release notes while a lander waits; the driver merges them on machines whose git config predates it.
    if (!contained) git(cwd, ["rebase", "FETCH_HEAD"], { config: MERGE_DRIVER_CONFIG });
    if (!check(turn)) return { status: "check-failed" };
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
    const checkIndex = rest.indexOf("--check");
    const checkCommand = checkIndex >= 0 ? rest[checkIndex + 1] : "vp run check:changed";
    const result = land({
      cwd,
      remote: "origin",
      check: (turn) =>
        spawnSync(checkCommand, {
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

module.exports = { LEASE_REF, TURN_ENV, tryAcquire, release, acquire, withTurn, verifyPush, land };
