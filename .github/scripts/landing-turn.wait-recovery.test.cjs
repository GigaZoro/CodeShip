const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_TTL_MS,
  macAwakeMs,
  land,
  main,
  testing: { acquire, release, tryAcquire },
} = require("./landing-turn.cjs");
const { QUEUE_STALE_MS } = require("./lease-queue.cjs");
const {
  QUEUE_PREFIX,
  ZERO,
  setup,
  loseNextAnswer,
  running,
} = require("./landing-turn.testkit.cjs");

test("a Mac's awake clock is read again when the Mac slept through a read, and a reader that fails again throws", () => {
  const timedOut = {
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync /usr/bin/osascript ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  };
  const reads =
    (...results) =>
    () =>
      results.shift() ?? assert.fail("read the clock once more than expected");
  assert.equal(
    macAwakeMs(reads(timedOut, { status: 0, stdout: "153885715\n", stderr: "" })),
    153885715,
  );
  // A child can still print and exit 0 when the timeout kills it: the timeout decides.
  const killedLate = { ...timedOut, status: 0, stdout: "153885715\n" };
  assert.throws(() => macAwakeMs(reads(timedOut, killedLate)), /systemUptime failed: .*ETIMEDOUT/);
  assert.throws(
    () => macAwakeMs(reads({ status: 1, stdout: "", stderr: "execution error: -2700" })),
    /systemUptime failed: execution error: -2700/,
  );
  assert.throws(
    () => macAwakeMs(reads({ status: 1, signal: null, stdout: "", stderr: "" })),
    /systemUptime failed: exit status 1$/,
  );
  assert.throws(
    () => macAwakeMs(reads({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })),
    /systemUptime failed: signal SIGKILL$/,
  );
});

test("a waiting lander that cannot fetch the holder's lease leaves it in place", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    // Origin lists the lease but cannot send its commit, as when the fetch after the listing fails.
    fs.rmSync(path.join(origin, "objects", held.slice(0, 2), held.slice(2)));

    assert.throws(() => acquire({ cwd: waiter, remote: origin, maxWaitMs: 0 }), /git fetch failed/);
    assert.equal(git(waiter, "ls-remote", "--refs", origin, LEASE_REF).split("\t")[0], held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting lander staggers its polls and fetches an unchanged lease once", () => {
  const { root, origin, git, clone } = setup();
  const trace = path.join(root, "git-trace.jsonl");
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const pauses = [];
    const samples = [0, 0.75];
    let clock = 0;
    process.env.GIT_TRACE2_EVENT = trace;

    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          pollMs: 5_000,
          // Poll 2 observes this waiter's own entry as the queue head and resets movedAt to 4_000; poll 3 runs at 9_500.
          maxWaitMs: 5_500,
          clock: () => clock,
          awakeClock: () => clock,
          random: () => {
            assert.ok(samples.length > 0, "polled past maxWaitMs");
            return samples.shift();
          },
          sleep: (ms) => {
            clock += ms;
            pauses.push(ms);
          },
        }),
      /still holds/,
    );
    assert.deepEqual(pauses, [4_000, 5_500]);
    const commands = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ event }) => event === "start")
      .map(({ argv }) => argv);
    assert.equal(
      commands.filter((argv) => argv.includes("ls-remote") && argv.at(-1) === LEASE_REF).length,
      3,
    );
    assert.equal(
      commands.filter((argv) => argv.includes("fetch") && argv.at(-1) === held).length,
      1,
    );
    assert.equal(git(waiter, "ls-remote", "--refs", origin, LEASE_REF).split("\t")[0], held);
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing reports an unconfirmed lease release without throwing from finally, and exits nonzero", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    fs.writeFileSync(
      path.join(hooks, "update"),
      `#!/bin/sh\n[ "$1 $3" != '${LEASE_REF} ${ZERO}' ]\n`,
      { mode: 0o755 },
    );

    // Non-push exit under the turn: release fails in finally without throwing, and land surfaces releaseConfirmed: false.
    const lander = clone("lander");
    const mover = clone("mover");
    commit(lander, "change.txt");
    let checks = 0;
    const failedCheck = await land({
      cwd: lander,
      remote: origin,
      failingMs: 0,
      every: () => () => {},
      check: () => {
        checks += 1;
        if (checks === 1) {
          commit(mover, "other.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
          return true;
        }
        return false;
      },
    });
    assert.deepEqual(failedCheck, { status: "check-failed", releaseConfirmed: false });
    const [record] = fs
      .readFileSync(path.join(lander, ".git", "t3-landing", "landings.jsonl"), "utf8")
      .split("\n")
      .map((line) => line && JSON.parse(line));
    assert.deepEqual([record.status, record.releaseConfirmed], ["check-failed", false]);
    assert.ok(git(origin, "rev-parse", LEASE_REF));

    // Clear the lease directly on the bare remote before exercising the CLI land and push paths.
    git(origin, "update-ref", "-d", LEASE_REF);

    // When main already holds the commit while fallback release fails, CLI land prints the landed commit and exits 1.
    const cliLander = clone("cli-lander");
    const head = git(cliLander, "rev-parse", "HEAD");
    const reports = [];
    t.mock.method(console, "log", (line) => reports.push(line));
    const landExitCode = await main(["land"], { cwd: cliLander, failingMs: 0, check: () => true });
    assert.equal(landExitCode, 1);
    assert.deepEqual(reports, [
      JSON.stringify({ status: "landed", commit: head, releaseConfirmed: false }),
    ]);
    assert.ok(git(origin, "rev-parse", LEASE_REF));

    // Clear the lease directly on the bare remote before exercising the CLI push path.
    git(origin, "update-ref", "-d", LEASE_REF);
    reports.length = 0;

    // When main already holds the commit while fallback release fails, CLI push prints the landed commit and exits 1.
    const pusher = clone("pusher");
    const pushExitCode = await main(["push", head], { cwd: pusher, failingMs: 0 });
    assert.equal(pushExitCode, 1);
    assert.deepEqual(reports, [
      JSON.stringify({ status: "landed", commit: head, releaseConfirmed: false }),
    ]);
    assert.ok(git(origin, "rev-parse", LEASE_REF));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose push fails or times out is the lander's when origin took it, and a failed poll when it did not", () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    const { marker } = loseNextAnswer(lander, origin, git);

    const turn = acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 });
    assert.deepEqual(
      [fs.existsSync(marker), git(origin, "rev-parse", "landing-lease/main")],
      [false, turn],
    );
    // The lease is its wait's by the run id that wait made: another wait that names the same id does not get it.
    const { run_id: runId } = JSON.parse(
      git(origin, "show", "-s", "--format=%B", turn).split("\n")[0],
    );
    assert.equal(tryAcquire({ cwd: lander, remote: origin, runId }), turn);
    assert.throws(
      () => acquire({ cwd: lander, remote: origin, runId, maxWaitMs: 0 }),
      /still holds/,
    );
    // A release tries a passing failure of origin again, and logs one that goes on instead of throwing it.
    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    assert.equal(release({ cwd: lander, remote: "origin", failingMs: 0 }, turn), false);
    assert.equal(git(origin, "rev-parse", "landing-lease/main"), turn);
    let retries = 0;
    assert.equal(
      release(
        {
          cwd: lander,
          remote: "origin",
          awakeClock: () => 0,
          sleep: () => {
            assert.ok(++retries <= 2, "continued retrying after the push URL was restored");
            if (retries === 2) git(lander, "config", "--unset", "remote.origin.pushurl");
          },
        },
        turn,
      ),
      true,
    );
    assert.equal(retries, 2);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    const stall = path.join(origin, "stall");
    fs.writeFileSync(stall, "");
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      'stall() { echo $$ > "$1/stall.pid"; cd / && while [ -f "$1/stall" ]; do sleep 0.1; done; exit 1; }; stall',
    );
    try {
      assert.throws(
        () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0, callMs: 2_000 }),
        /git push failed: did not finish within 2 seconds/,
      );
      // A lease call gives up together with its transport.
      const transport = Number(fs.readFileSync(path.join(origin, "stall.pid"), "utf8"));
      assert.equal(running(transport), false, "transport still runs");
    } finally {
      fs.rmSync(stall);
      git(lander, "config", "--unset", "remote.origin.receivepack");
    }

    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    assert.throws(
      () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 }),
      /git push failed/,
    );
    // Either take may have reached origin, so its record stays until a later take finds it past the turn's end.
    const records = path.join(lander, ".git", "landing-turn");
    assert.equal(fs.readdirSync(records).length, 2);
    git(lander, "config", "--unset", "remote.origin.pushurl");
    const later = Date.parse("2100-01-01T00:00:00Z");
    const taken = tryAcquire({ cwd: lander, remote: origin, runId: "later", now: () => later });
    assert.deepEqual(fs.readdirSync(records), [taken]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take that reached origin but lost its answer is the lander's although another entry is now first", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const pauses = [
      () => {
        reconnect();
        // An entry older than the lander's own joins while the lander cannot tell whether its take applied.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
      },
    ];
    let time = 0;
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      now: () => epoch,
      maxWaitMs: 2,
      sleep: () => {
        time += 1;
        const pause = pauses.shift();
        assert.ok(pause, "waited behind its own lease");
        pause();
      },
    });

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX),
      `${QUEUE_PREFIX}other.1`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose answer was lost goes back through the queue when its lease expired before it was confirmed", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        reconnect();
        lost = git(origin, "rev-parse", LEASE_REF);
        // The lease runs out before the lander can tell its take applied, and an older entry joins meanwhile.
        wall = epoch + LEASE_TTL_MS;
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      now: () => wall,
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), wall + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose lost answer is confirmed only after its lease expired goes back through the queue", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { marker } = loseNextAnswer(lander, origin, git);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const expired = epoch + LEASE_TTL_MS + 1000;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        lost = git(origin, "rev-parse", LEASE_REF);
        // An older entry joins while the lease that take left is expired.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      awakeClock: () => time,
      // The lease runs out between the take and the read that confirms it.
      now: () => (fs.existsSync(marker) ? epoch : expired),
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), expired + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
