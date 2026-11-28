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
  processHost,
  testing: { acquire, release, tryAcquire },
} = require("./landing-turn.cjs");
const { setup, stderrOf } = require("./landing-turn.testkit.cjs");

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
