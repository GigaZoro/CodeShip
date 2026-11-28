const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");

const {
  LEASE_REF,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  TURN_ENV,
  TURN_MAX_MS,
  testing: { acquire, tryAcquire },
  verifyPush,
  withTurn,
} = require("./landing-turn.cjs");
const { LANDING_UPDATES, setup, loseNextAnswer, stderrOf } = require("./landing-turn.testkit.cjs");

const SKEWS = [
  [0, "runs with the holder's"],
  [11 * 60_000, "runs 11 minutes ahead"],
  [-11 * 60_000, "runs 11 minutes behind"],
];
for (const [skew, clockRuns] of SKEWS) {
  test(`a holder keeps the turn while it renews its lease, and a waiter whose clock ${clockRuns} takes it LEASE_TTL_MS after renewals stop`, async () => {
    const { root, origin, git, clone } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      const epoch = Date.parse("2026-01-01T00:00:00Z");
      let wall = epoch;
      const pushes = (turn) =>
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
      const renewals = [];
      let taken;
      let comeBack;
      await withTurn(
        {
          cwd: holder,
          remote: origin,
          now: () => wall,
          every: (ms, renew) => {
            renewals.push({ ms, renew });
            return () => renewals.splice(0);
          },
        },
        async (turn, signal) => {
          const [{ ms, renew }] = renewals;
          assert.equal(ms, LEASE_RENEW_MS);
          // The waiter polls once per renewal. Renewals keep the turn past LEASE_TTL_MS after the take, and the push
          // gate traces each one back to it. Then the holder stops renewing, as when its process dies.
          let renewing = 4;
          let time = 0;
          let stoppedAt = 0;
          taken = acquire({
            cwd: waiter,
            remote: origin,
            clock: () => time,
            awakeClock: () => time,
            now: () => wall + skew,
            pollMs: LEASE_RENEW_MS,
            random: () => 0.5,
            sleep: (pause) => {
              time += pause;
              wall += pause;
              if (renewing > 0) {
                renewing -= 1;
                renew();
                pushes(turn);
                stoppedAt = time;
              }
              assert.ok(time - stoppedAt <= LEASE_TTL_MS, "kept waiting after the lease ran out");
            },
          });
          assert.equal(time - stoppedAt, LEASE_TTL_MS, "took the lease before it ran out");
          assert.ok(wall - epoch > LEASE_TTL_MS);
          assert.throws(() => pushes(turn), /landing turn/);
          // A holder that comes back finds the turn gone.
          const { written } = stderrOf(renew);
          comeBack = { aborted: signal.aborted, written: written.join("") };
        },
      );

      assert.equal(comeBack.aborted, true);
      assert.match(comeBack.written, /lost main's landing turn: another lander took the lease/);
      assert.deepEqual(renewals, [], "renewals went on after the turn");
      assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a waiter on its holder's machine leaves the lease alone through a sleep they share, and takes it once renewals stop for a lease of awake time", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    let wall = Date.parse("2026-01-01T00:00:00Z");
    const renewals = [];
    let taken;
    let comeBack;
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, renew) => {
          renewals.push(renew);
          return () => renewals.splice(0);
        },
      },
      async (_turn, signal) => {
        const [renew] = renewals;
        // On a Mac the monotonic clock counts sleep, as the wall clock does; the awake clock does not.
        let time = 0;
        let awake = 0;
        let awakeReads = 0;
        let renewedAt = null;
        const pass = (ms, asleepMs = 0) => {
          time += asleepMs + ms;
          wall += asleepMs + ms;
          awake += ms;
        };
        const steps = [
          // The machine sleeps half an hour, holder and waiter alike: three leases of wall time with no renewal.
          (pause) => pass(pause, 30 * 60_000),
          // The holder wakes after the waiter has polled once, and renews; then it renews no more.
          (pause) => {
            pass(pause);
            renew();
            renewedAt = awake;
          },
        ];
        taken = acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => {
            awakeReads += 1;
            return awake;
          },
          now: () => wall,
          pollMs: LEASE_RENEW_MS,
          random: () => 0.5,
          sleep: (pause) => {
            (steps.shift() ?? pass)(pause);
            assert.ok(
              renewedAt === null || awake - renewedAt <= LEASE_TTL_MS,
              "kept waiting after the lease ran out",
            );
          },
        });
        assert.equal(steps.length, 0, "took the lease of a holder that slept with it");
        assert.equal(awake - renewedAt, LEASE_TTL_MS, "took the lease before it ran out awake");
        // A Mac reads its awake clock through osascript: as each lease commit first shows, and once a lease of the
        // monotonic clock passed since, not at every poll.
        assert.equal(awakeReads, 4);
        const { written } = stderrOf(renew);
        comeBack = { aborted: signal.aborted, written: written.join("") };
      },
    );

    assert.equal(comeBack.aborted, true);
    assert.match(comeBack.written, /lost main's landing turn: another lander took the lease/);
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lease names the machine and process that renew it, and when they last did", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    const leaseOf = (ref) =>
      JSON.parse(git(origin, "show", "-s", "--format=%B", ref).split("\n")[0]);
    const leases = [];
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn) => {
        leases.push(leaseOf(turn));
        wall += LEASE_RENEW_MS;
        renew();
        leases.push(leaseOf(LEASE_REF));
      },
    );

    // Origin is public, so the lease names its machine by a hash of the machine's name.
    const tag = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12);
    const at = (ms) => new Date(ms).toISOString();
    assert.deepEqual(
      leases.map(({ host, pid, acquired_at, renewed_at, expires_at }) => ({
        host,
        pid,
        acquired_at,
        renewed_at,
        expires_at,
      })),
      [
        {
          host: tag,
          pid: process.pid,
          acquired_at: at(epoch),
          renewed_at: at(epoch),
          expires_at: at(epoch + LEASE_TTL_MS),
        },
        {
          host: tag,
          pid: process.pid,
          acquired_at: at(epoch),
          renewed_at: at(epoch + LEASE_RENEW_MS),
          expires_at: at(epoch + LEASE_RENEW_MS + LEASE_TTL_MS),
        },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter whose clock runs 11 minutes ahead leaves a lease that renews alone, also once the turn's end cuts it short", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    const taken = [];
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (_turn, signal) => {
        // The last renewal before the turn ends lasts 30 seconds, then a waiter comes that never saw the lease.
        wall = epoch + TURN_MAX_MS - 30_000;
        renew();
        const lease = JSON.parse(
          git(origin, "show", "-s", "--format=%B", LEASE_REF).split("\n")[0],
        );
        assert.equal(Date.parse(lease.expires_at), epoch + TURN_MAX_MS);
        const ahead = () => wall + 11 * 60_000;
        taken.push(tryAcquire({ cwd: waiter, remote: origin, runId: "waiter", now: ahead }));
        assert.equal(signal.aborted, false);
      },
    );

    assert.deepEqual(taken, [null], "a waiter took a lease its holder had just renewed");
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renewals end with the turn: the last lasts only until the turn ends, and the next loses the turn", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    let lost;
    await withTurn(
      {
        cwd: holder,
        remote: origin,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (_turn, signal) => {
        wall = epoch + TURN_MAX_MS - LEASE_RENEW_MS;
        renew();
        const lease = git(origin, "show", "-s", "--format=%B", LEASE_REF).split("\n")[0];
        assert.equal(Date.parse(JSON.parse(lease).expires_at), epoch + TURN_MAX_MS);
        wall = epoch + TURN_MAX_MS;
        const { written } = stderrOf(renew);
        lost = { aborted: signal.aborted, written: written.join("") };
      },
    );

    assert.equal(lost.aborted, true);
    assert.match(lost.written, /lost main's landing turn: the turn reached its end/);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a renewal whose answer was lost keeps the turn, and the turn gives back the lease origin took", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    // Origin takes a renewal, but neither its answer nor the next read of the lease gets back.
    const renewUnheard = () => {
      const { reconnect } = loseNextAnswer(holder, origin, git, true);
      const before = git(origin, "rev-parse", LEASE_REF);
      wall += LEASE_RENEW_MS;
      stderrOf(renew);
      reconnect();
      assert.notEqual(git(origin, "rev-parse", LEASE_REF), before, "origin did not take it");
    };
    await withTurn(
      {
        cwd: holder,
        remote: "origin",
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn, signal) => {
        renewUnheard();
        wall += LEASE_RENEW_MS;
        renew();
        assert.equal(signal.aborted, false, "lost the turn to its own renewal");
        assert.equal(git(origin, "rev-list", "--count", LEASE_REF), "3");
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
        renewUnheard();
      },
    );

    assert.equal(
      git(origin, "for-each-ref", LEASE_REF),
      "",
      "kept the lease of the unheard renewal",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
