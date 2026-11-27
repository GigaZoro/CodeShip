const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BOOT_ID,
  LEASE_REF,
  LEASE_TTL_MS,
  macAwakeMs,
  land,
  main,
  processHost,
  testing: { acquire, release, tryAcquire },
} = require("./landing-turn.cjs");
const { QUEUE_STALE_MS } = require("./lease-queue.cjs");
const {
  QUEUE_PREFIX,
  ZERO,
  setup,
  loseNextAnswer,
  stderrOf,
  running,
} = require("./landing-turn.testkit.cjs");

// Only Linux's /proc tells a lander's kernel boot and PID namespace, so only there does a waiter take a lease over.
const TAKES_OVER = processHost() !== null;

// Takes the lease in a process of its own, which exits without giving it back.
function takeAndExit(cwd, remote) {
  const taken = spawnSync(
    process.execPath,
    [
      "-e",
      "const [script, cwd, remote] = process.argv.slice(1);" +
        'process.stdout.write(require(script).testing.tryAcquire({ cwd, remote, runId: "gone" }) ?? "");',
      path.join(__dirname, "landing-turn.cjs"),
      cwd,
      remote,
    ],
    { encoding: "utf8" },
  );
  assert.equal(taken.status, 0, taken.stderr);
  return taken.stdout;
}

test(
  "a waiter in a worktree of the lander's clone takes over a lease whose lander exited, and waits out one it cannot prove abandoned",
  {
    skip: !TAKES_OVER,
  },
  (t) => {
    const { root, origin, git, clone } = setup();
    try {
      const checkout = clone("checkout");
      // Another worktree of the same clone, as each landing in CodeShip has.
      const sibling = path.join(root, "sibling");
      git(checkout, "worktree", "add", "-q", "--detach", sibling);
      const records = path.join(checkout, ".git", "landing-turn");
      const lease = () => git(origin, "for-each-ref", "--format=%(objectname)", LEASE_REF);
      const wait = () => tryAcquire({ cwd: sibling, remote: origin, runId: "waiter" });

      takeAndExit(checkout, origin);
      const taken = wait();
      assert.equal(lease(), taken);
      assert.deepEqual(fs.readdirSync(records), [taken]);
      release({ cwd: sibling, remote: origin }, taken);
      assert.deepEqual(fs.readdirSync(records), []);

      // A lander that runs, one whose push to main may be in flight, one in another machine, boot or PID namespace, and
      // one whose record cannot be read may each still push.
      const live = tryAcquire({ cwd: checkout, remote: origin, runId: "live" });
      assert.equal(wait(), null);
      release({ cwd: checkout, remote: origin }, live);
      const exited = takeAndExit(checkout, origin);
      const record = path.join(records, exited);
      const written = fs.readFileSync(record, "utf8");
      const { host } = JSON.parse(written);
      const boot = fs.readFileSync(BOOT_ID, "utf8").trim();
      for (const unproven of [
        JSON.stringify({ ...JSON.parse(written), pushing: true }),
        JSON.stringify({ ...JSON.parse(written), host: "another machine" }),
        JSON.stringify({ ...JSON.parse(written), host: host.replace(boot, "another boot") }),
        "{",
      ]) {
        fs.writeFileSync(record, unproven);
        assert.equal(wait(), null, unproven);
      }
      // The lander marks a push and exits between the waiter's read of its record and the probe.
      fs.writeFileSync(record, written);
      const probe = process.kill;
      t.mock.method(process, "kill", (pid, signal) => {
        fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(written), pushing: true }));
        return probe.call(process, pid, signal);
      });
      assert.equal(wait(), null);
      t.mock.restoreAll();
      fs.writeFileSync(record, written);
      const retaken = wait();
      assert.equal(lease(), retaken);
      assert.deepEqual(fs.readdirSync(records), [retaken]);
      release({ cwd: sibling, remote: origin }, retaken);

      // A folder where the record should be leaves the lease to expire, and neither it nor another folder stops a take.
      const unreadable = takeAndExit(checkout, origin);
      const blocked = path.join(records, unreadable);
      fs.rmSync(blocked);
      fs.mkdirSync(blocked);
      fs.mkdirSync(path.join(records, "other"));
      assert.equal(wait(), null);
      const future = Date.parse("2100-01-01T00:00:00Z");
      const waiter = { cwd: sibling, remote: origin, runId: "waiter", now: () => future };
      assert.equal(tryAcquire(waiter), null);
      assert.equal(lease(), unreadable);
      const late = tryAcquire({
        ...waiter,
        watched: (sha) => (sha === unreadable ? LEASE_TTL_MS : 0),
      });
      assert.ok(late);
      assert.deepEqual([lease(), fs.readdirSync(records)], [late, [late]]);
      release({ cwd: sibling, remote: origin }, late);

      const away = takeAndExit(clone("elsewhere"), origin);
      assert.deepEqual([wait(), lease()], [null, away]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a waiter whose /proc shows no boot id it can use waits for the lease to expire, and still takes a free one",
  {
    skip: !TAKES_OVER,
  },
  (t) => {
    const { root, origin, git, clone } = setup();
    try {
      const checkout = clone("checkout");
      const sibling = path.join(root, "sibling");
      git(checkout, "worktree", "add", "-q", "--detach", sibling);
      const records = path.join(checkout, ".git", "landing-turn");
      const lease = () => git(origin, "for-each-ref", "--format=%(objectname)", LEASE_REF);
      const wait = () => tryAcquire({ cwd: sibling, remote: origin, runId: "waiter" });
      const read = fs.readFileSync;
      const bootReads = (boot) =>
        t.mock.method(fs, "readFileSync", (file, ...rest) =>
          file === BOOT_ID ? boot() : read.call(fs, file, ...rest),
        );
      const locked = () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${BOOT_ID}'`), {
          code: "EACCES",
        });
      };

      // An exited lander that, like this waiter, read an empty boot id.
      const exited = takeAndExit(checkout, origin);
      const record = path.join(records, exited);
      const blank = `${os.hostname()}  ${fs.readlinkSync("/proc/self/ns/pid")}`;
      fs.writeFileSync(
        record,
        JSON.stringify({ ...JSON.parse(read(record, "utf8")), host: blank }),
      );
      for (const boot of [() => "", () => "not a boot id", locked]) {
        bootReads(boot);
        assert.equal(wait(), null);
        t.mock.restoreAll();
      }
      release({ cwd: checkout, remote: origin }, exited);

      bootReads(locked);
      const free = wait();
      t.mock.restoreAll();
      const { host } = JSON.parse(read(path.join(records, free), "utf8"));
      assert.deepEqual([lease(), host], [free, os.hostname()]);
      release({ cwd: sibling, remote: origin }, free);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the holder command shows the lease and, when a worktree of this clone took it, its lander and whether it is gone", () => {
  const { root, origin, git, clone } = setup();
  try {
    const checkout = clone("checkout");
    const sibling = path.join(root, "sibling");
    git(checkout, "worktree", "add", "-q", "--detach", sibling);
    const holderOf = (cwd) => {
      const shown = spawnSync(
        process.execPath,
        [path.join(__dirname, "landing-turn.cjs"), "holder"],
        {
          cwd,
          encoding: "utf8",
        },
      );
      assert.equal(shown.status, 0, shown.stderr);
      return JSON.parse(shown.stdout);
    };

    assert.deepEqual(holderOf(sibling), { lease: null, local: null });
    const live = tryAcquire({ cwd: checkout, remote: origin, runId: "live" });
    const running = holderOf(sibling);
    assert.deepEqual(
      [
        running.lease,
        running.run_id,
        running.local.pid,
        running.local.checkout,
        running.local.gone,
      ],
      [live, "live", process.pid, checkout, false],
    );
    release({ cwd: checkout, remote: origin }, live);

    const exited = takeAndExit(checkout, origin);
    const gone = holderOf(sibling);
    assert.deepEqual(
      [gone.lease, gone.local.checkout, gone.local.gone],
      [exited, checkout, TAKES_OVER],
    );
    release({ cwd: checkout, remote: origin }, exited);

    const away = takeAndExit(clone("elsewhere"), origin);
    const elsewhere = holderOf(checkout);
    assert.deepEqual([elsewhere.lease, elsewhere.local], [away, null]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting lander waits through failed reads of origin, and only failures that go on or come from its checkout end its wait", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const away = `${origin}-away`;
    // Each pause between polls takes 2 minutes. Origin cannot be reached for the second and the fourth poll: failures
    // 4 minutes apart, longer than failingMs, with a poll between them that saw the holder. Then the holder gives the
    // turn back.
    let minutes = 0;
    const pauses = [
      () => fs.renameSync(origin, away),
      () => fs.renameSync(away, origin),
      () => fs.renameSync(origin, away),
      () => {
        fs.renameSync(away, origin);
        release({ cwd: holder, remote: origin }, held);
      },
    ];
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => minutes * 60_000,
      awakeClock: () => minutes * 60_000,
      failingMs: 3 * 60_000,
      sleep: () => {
        minutes += 2;
        pauses.shift()();
      },
    });

    assert.deepEqual([pauses.length, git(origin, "rev-parse", "landing-lease/main")], [0, turn]);
    release({ cwd: waiter, remote: origin }, turn);

    // A Mac asleep with its lid closed wakes for a few seconds every half hour, without a network. The failures span an
    // hour of the clock that counts sleep, but under a minute awake, so the wait goes on, and so does the release that
    // meets the same wakes; failures the lander meets for as long as failingMs awake end the wait.
    const again = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    let asleepMs = 0;
    let awakeMs = 0;
    const darkWake = (after) => () => {
      asleepMs += 30 * 60_000;
      awakeMs += 10_000;
      after.shift()();
    };
    const dark = [
      () => fs.renameSync(origin, away),
      () => {},
      () => {},
      () => {
        fs.renameSync(away, origin);
        release({ cwd: holder, remote: origin }, again);
      },
    ];
    const afterSleep = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => asleepMs + awakeMs,
      awakeClock: () => awakeMs,
      sleep: darkWake(dark),
    });
    assert.deepEqual(
      [dark.length, git(origin, "rev-parse", "landing-lease/main")],
      [0, afterSleep],
    );
    fs.renameSync(origin, away);
    const darkRelease = [() => {}, () => {}, () => fs.renameSync(away, origin)];
    release(
      {
        cwd: waiter,
        remote: origin,
        clock: () => asleepMs + awakeMs,
        awakeClock: () => awakeMs,
        sleep: darkWake(darkRelease),
      },
      afterSleep,
    );
    assert.deepEqual(
      [darkRelease.length, git(origin, "for-each-ref", "refs/heads/landing-lease/main")],
      [0, ""],
    );
    const stillHeld = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    fs.renameSync(origin, away);
    let awakeMinutes = 0;
    const { written } = stderrOf(() =>
      assert.throws(
        () =>
          acquire({
            cwd: waiter,
            remote: origin,
            clock: () => 0,
            awakeClock: () => awakeMinutes * 60_000,
            sleep: () => {
              awakeMinutes += 6;
              if (awakeMinutes > 12) assert.fail("waited on after 10 minutes of failures awake");
            },
          }),
        /git ls-remote failed/,
      ),
    );
    assert.equal(awakeMinutes, 12);
    assert.ok(
      written.includes("landing turn: origin kept failing for 12 minutes awake; the wait ends.\n"),
      written.join(""),
    );
    fs.renameSync(away, origin);
    release({ cwd: holder, remote: origin }, stillHeld);

    fs.renameSync(origin, away);
    assert.throws(
      () => acquire({ cwd: holder, remote: origin, failingMs: 0 }),
      /git ls-remote failed/,
    );
    fs.renameSync(away, origin);

    // Origin answers, but this checkout cannot write the lease commit: waiting does not change that.
    const broken = clone("broken");
    git(broken, "config", "core.repositoryformatversion", "1");
    git(broken, "config", "extensions.landingTurnTest", "true");
    assert.throws(
      () =>
        acquire({
          cwd: broken,
          remote: origin,
          sleep: () => assert.fail("retried a local failure"),
        }),
      // git translates its own message, but not the extension's name.
      /git commit-tree failed: .*landingturntest/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
        () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0, callMs: 10_000 }),
        /git push failed: did not finish within 10 seconds/,
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
