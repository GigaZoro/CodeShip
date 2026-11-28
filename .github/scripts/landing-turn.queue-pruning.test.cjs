const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_TTL_MS,
  testing: { acquire, release, tryAcquire },
} = require("./landing-turn.cjs");
const { QUEUE_STALE_MS, createQueueWaiter } = require("./lease-queue.cjs");
const { QUEUE_PREFIX, ELSEWHERE, setup, stderrOf } = require("./landing-turn.testkit.cjs");

const QUEUE_REFRESH_MS = 60_000;
const QUEUE_FETCH_MAX = 100;

test("a waiter whose last read of the queue was cut short joins only once it has read it whole", () => {
  const { root, origin, clone, seedEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // The holder's lease ran out a whole lease ago, so a waiter that finds the queue empty reads it again before taking
    // over.
    tryAcquire({
      cwd: holder,
      remote: origin,
      runId: "holder",
      now: () => epoch - 2 * LEASE_TTL_MS,
      machine: ELSEWHERE,
    });
    // Between those reads, more landers join than one poll reads, on machines whose clocks run ahead.
    const ahead = Array.from({ length: QUEUE_FETCH_MAX + 10 }, (_, index) => [
      `ahead-${index}`,
      epoch + 60_000 + index,
    ]);
    const latest = epoch + 60_000 + ahead.length - 1;
    let wallReads = 0;
    let pauses = 0;
    const joined = new Error("joined");
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => pauses,
          awakeClock: () => pauses,
          // Its arrival reads the wall clock first, then the expiry check between the two reads of the queue.
          now: () => {
            wallReads += 1;
            if (wallReads === 2) seedEntries(ahead);
            return epoch;
          },
          sleep: () => {
            pauses += 1;
            const own = ticketsOn((name) => !name.startsWith("ahead-"));
            assert.ok(
              own.every((since) => since > latest),
              "joined ahead of entries it had seen",
            );
            if (own.length > 0) throw joined;
            assert.ok(pauses < 2, "never joined the queue");
          },
        }),
      (error) => error === joined,
    );
    assert.ok(wallReads >= 2, "the lease's expiry was never checked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale entry origin will not delete blocks no one, and the waiter says so once", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const crashed = clone("crashed");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}crashed.1`;
    git(crashed, "push", "-q", "origin", `${entryCommit(crashed, "crashed", epoch - 1)}:${ref}`);
    fs.writeFileSync(path.join(origin, `${ref}.lock`), "");

    let time = 0;
    const pauses = [QUEUE_STALE_MS - 1, QUEUE_STALE_MS];
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch,
        sleep: () => {
          time = pauses.shift();
          assert.notEqual(time, undefined, "waited after the entry went stale");
        },
      }),
    );

    assert.equal(time, QUEUE_STALE_MS);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), ref);
    assert.equal(
      written.filter((line) => line.includes("could not remove stale queue entries")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pruning moves past stale entries origin will not delete, with one warning however the batches differ", () => {
  const { root, origin, git, clone, seedEntries } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // Eleven entries origin will not delete, more than one batch, and one it will.
    const locked = Array.from(
      { length: 11 },
      (_, index) => `crashed-${String(index).padStart(2, "0")}`,
    );
    seedEntries([...locked, "crashed-11"].map((runId, index) => [runId, epoch - 100 + index]));
    for (const runId of locked)
      fs.writeFileSync(path.join(origin, `${QUEUE_PREFIX}${runId}.1.lock`), "");

    let time = 0;
    let polls = 0;
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch,
        sleep: () => {
          polls += 1;
          if (polls === 5) release({ cwd: holder, remote: origin }, held);
          assert.ok(polls <= 5, "kept waiting after the lease was free");
          time = QUEUE_STALE_MS + polls;
        },
      }),
    );

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.deepEqual(
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX).split("\n"),
      locked.map((runId) => `${QUEUE_PREFIX}${runId}.1`),
    );
    assert.equal(
      written.filter((line) => line.includes("could not remove stale queue entries")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a crashed lander blocks the next waiter until its entry is observed unchanged for the stale window", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const crashed = clone("crashed");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}crashed.1`;
    const sha = entryCommit(crashed, "crashed", epoch - 1);
    git(crashed, "push", "-q", "origin", `${sha}:${ref}`);

    let time = 0;
    const pauses = [QUEUE_STALE_MS - 1, QUEUE_STALE_MS];
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => time,
      awakeClock: () => time,
      // The other machine's wall clock is far behind, but the entry starts out fresh to this waiter.
      now: () => epoch + time,
      sleep: () => {
        assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
        assert.equal(git(origin, "rev-parse", ref), sha);
        time = pauses.shift();
        assert.notEqual(time, undefined, "waited after the entry went stale");
      },
    });

    assert.equal(time, QUEUE_STALE_MS, "took the turn before the stale window elapsed");
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(git(origin, "for-each-ref", QUEUE_PREFIX), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a heartbeat renames the entry with its commit, and while origin keeps the old names it renews the newest in place", () => {
  const { root, origin, git, clone, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const later = clone("later");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const names = () =>
      git(origin, "for-each-ref", "--format=%(refname) %(objectname)", QUEUE_PREFIX)
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split(" "));
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    let time = 0;
    // A lander that came later polls the queue on the same clock.
    const behind = createQueueWaiter({
      remote: origin,
      runId: "later",
      arrivedAt: Date.parse("2026-01-01T00:00:00Z"),
      clock: () => time,
      remoteGit: (args) => git(later, ...args),
      readMessage: (sha) => git(later, "show", "-s", "--format=%B", sha),
      makeCommit: () => assert.fail("the later lander joined"),
      warn: () => {},
    });
    let commit;
    let ticket;
    const counts = [];
    const { result: turn, written } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        sleep: () => {
          const tickets = ticketsOn(() => true);
          ticket ??= tickets[0];
          commit ??= names()[0]?.[1];
          assert.ok(ticket, "published an entry");
          assert.ok(
            tickets.every((since) => since === ticket),
            "a heartbeat changed the ticket",
          );
          counts.push(tickets.length);
          if (counts.length <= 3) {
            assert.ok(
              names().every(([, sha]) => sha === commit),
              "a renaming heartbeat changed the commit",
            );
          }
          assert.equal(behind.poll(), false, "the later lander went ahead of a live waiter");
          // From its first heartbeat on, origin refuses to delete any queue entry.
          if (counts.length === 1) {
            fs.writeFileSync(
              path.join(hooks, "update"),
              `#!/bin/sh\ncase "$1" in ${QUEUE_PREFIX}*) [ "$3" = ${"0".repeat(40)} ] && exit 1;; esac\nexit 0\n`,
              { mode: 0o755 },
            );
          }
          if (counts.length === 9) release({ cwd: holder, remote: origin }, held);
          assert.ok(counts.length <= 9, "kept waiting after the lease was free");
          time += QUEUE_REFRESH_MS;
        },
      }),
    );

    // One more name per heartbeat while origin keeps the old ones, until three; then the newest moves on.
    assert.deepEqual(counts, [1, 2, 3, 3, 3, 3, 3, 3, 3]);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const [newest] = names()
      .map(([ref]) => ref)
      .sort((a, b) => Number(b.split(".").pop()) - Number(a.split(".").pop()));
    // Six renewals in place, each a fast-forward from the commit before.
    assert.equal(git(origin, "rev-list", "--count", newest), "7");
    assert.equal(
      written.filter((line) => line.includes("renews the newest in place")).length,
      1,
      written.join(""),
    );
    assert.equal(
      written.filter((line) => line.includes("could not remove old names")).length,
      1,
      written.join(""),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter whose first entry origin refused joins again after the entries that came meanwhile", () => {
  const { root, origin, git, clone, entryCommit, dropEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const other = clone("other");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    fs.writeFileSync(
      path.join(hooks, "update"),
      `#!/bin/sh\ncase "$1" in ${QUEUE_PREFIX}*) [ -e refuse-entry ] && rm refuse-entry && exit 1;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(origin, "refuse-entry"), "");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ownTickets = () => ticketsOn((name) => !name.startsWith("other."));
    let time = 0;
    const pauses = [
      () => {
        assert.deepEqual(ownTickets(), [], "origin took the first entry");
        // Another lander joins, seeing no entry of the waiter's.
        const sha = entryCommit(other, "other", epoch + 60_000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        const [own] = ownTickets();
        assert.ok(own > epoch + 60_000, `joined ahead of an entry it had read: ${own}`);
        dropEntries(["other"]);
        release({ cwd: holder, remote: origin }, held);
        time = 2;
      },
    ];
    const { result: turn } = stderrOf(() =>
      acquire({
        cwd: waiter,
        remote: origin,
        clock: () => time,
        awakeClock: () => time,
        now: () => epoch + time,
        sleep: () => {
          const pause = pauses.shift();
          assert.ok(pause, "waited after the lease was free");
          pause();
        },
      }),
    );

    assert.equal(pauses.length, 0);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander removes its queue entry whether it takes the turn or ends its wait", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const refs = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const options = { cwd: waiter, remote: origin, now: () => epoch };
    const stopped = new Error("stopped waiting");
    const leaseLock = path.join(origin, `${LEASE_REF}.lock`);

    for (const outcome of ["timeout", "remote failure", "unexpected error", "acquired"]) {
      const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
      let time = 0;
      let queued;
      const wait = () =>
        acquire({
          ...options,
          clock: () => time,
          awakeClock: () => time,
          maxWaitMs: outcome === "timeout" ? 1 : undefined,
          failingMs: 0,
          sleep: () => {
            queued = refs();
            time += 1;
            if (outcome === "unexpected error") throw stopped;
            if (outcome === "remote failure") {
              release({ cwd: holder, remote: origin }, held);
              fs.writeFileSync(leaseLock, "");
            }
            if (outcome === "acquired") release({ cwd: holder, remote: origin }, held);
          },
        });

      if (outcome === "timeout") assert.throws(wait, /still holds/);
      if (outcome === "remote failure") {
        assert.throws(wait, /git push failed/);
        fs.rmSync(leaseLock);
      }
      if (outcome === "unexpected error") assert.throws(wait, (error) => error === stopped);
      if (outcome === "acquired") assert.equal(wait(), git(origin, "rev-parse", LEASE_REF));
      assert.ok(queued?.startsWith(QUEUE_PREFIX), outcome);
      assert.equal(refs(), "", outcome);
      if (outcome === "timeout" || outcome === "unexpected error")
        release({ cwd: holder, remote: origin }, held);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
