const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_TTL_MS,
  MAX_WAIT_MS,
  TURN_MAX_MS,
  testing: { acquire, release, tryAcquire },
} = require("./landing-turn.cjs");
const { QUEUE_STALE_MS, createQueueWaiter } = require("./lease-queue.cjs");
const { QUEUE_PREFIX, ELSEWHERE, setup, stderrOf } = require("./landing-turn.testkit.cjs");

const QUEUE_REFRESH_MS = 60_000;
const QUEUE_FETCH_MAX = 100;
// One lease or queue call's limit in landing-turn.cjs.
const LEASE_CALL_MS = 60_000;

// A lander in its own process. It reports each pause it begins on fd 3, as "released" once the RELEASED file exists.
// With GO, its first pause lasts until that file exists.
const LANDER_SCRIPT = `
const fs = require("node:fs");
const { acquire } = require(process.env.LANDING_TURN).testing;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const released = () => process.env.RELEASED && fs.existsSync(process.env.RELEASED);
process.stdout.write(
  acquire({
    cwd: process.env.LANDER,
    remote: process.env.ORIGIN,
    pollMs: 50,
    maxWaitMs: 60000,
    sleep: (ms) => {
      fs.writeSync(3, released() ? "released\\n" : "pause\\n");
      while (process.env.GO && !fs.existsSync(process.env.GO)) pause(50);
      pause(ms);
    },
  }),
);
`;

function startLander({ name, cwd, origin, go = "", released = "" }) {
  const child = spawn(process.execPath, ["-e", LANDER_SCRIPT], {
    env: {
      ...process.env,
      LANDING_TURN: require.resolve("./landing-turn.cjs"),
      LANDER: cwd,
      ORIGIN: origin,
      GO: go,
      RELEASED: released,
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const begun = { pause: 0, released: 0 };
  let partial = "";
  const waiters = new Set();
  child.stdio[3].on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) begun[line] += 1;
    for (const waiter of waiters) {
      if (waiter.count(begun) < waiter.target) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  });
  const until = (count, target) =>
    count(begun) >= target
      ? Promise.resolve()
      : new Promise((resolve) => waiters.add({ count, target, resolve }));
  const lander = {
    name,
    result: null,
    /** Settles once the lander has begun `count` pauses. */
    paused: (count) => until(({ pause, released }) => pause + released, count),
    /** Settles once `count` pauses began after RELEASED existed; from the second, a whole poll began after it. */
    pausedSinceRelease: (count) => until(({ released }) => released, count),
    closed: new Promise((resolve) =>
      child.on("close", (code) => resolve((lander.result = { code, stdout, stderr }))),
    ),
    stop: () => child.kill(),
  };
  return lander;
}

/** Waits for `milestone`, failing at once when a lander in `running` ends first. */
async function reach(milestone, message, running) {
  const ended = await Promise.race([
    milestone.then(() => null),
    ...running.map((lander) => lander.closed.then(() => lander)),
  ]);
  if (ended) assert.fail(`${message}: the ${ended.name} lander ended: ${ended.result.stderr}`);
}

test("a wait goes on while its queue or the lease moves, and ends once neither has moved for its limit", () => {
  const { root, origin, clone, seedEntries, dropEntries } = setup();
  try {
    const holder = clone("holder");
    const other = clone("other");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder", now: () => epoch });
    const ahead = (runId) => seedEntries([[runId, epoch - 1000]]);
    ahead("ahead-0");
    let time = 0;
    const moves = [
      // Another waiter goes first in place of the one before it, twice.
      () => {
        dropEntries(["ahead-0"]);
        ahead("ahead-1");
      },
      () => {
        dropEntries(["ahead-1"]);
        ahead("ahead-2");
      },
      // The waiter comes first, then the lease changes hands.
      () => dropEntries(["ahead-2"]),
      () => {
        release({ cwd: holder, remote: origin }, held);
        tryAcquire({ cwd: other, remote: origin, runId: "other", now: () => epoch });
      },
    ];
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          now: () => epoch,
          maxWaitMs: 10,
          sleep: () => {
            time += 6;
            moves.shift()?.();
          },
        }),
      /still holds/,
    );

    // The last move was seen at 24, and the poll at 36 was the first one 10 or more after it.
    assert.deepEqual([moves.length, time], [0, 36]);
    // A wait outlasts a turn, the lease a holder left behind, a queue entry that stopped renewing and one call to origin.
    assert.equal(MAX_WAIT_MS, TURN_MAX_MS + LEASE_TTL_MS + QUEUE_STALE_MS + LEASE_CALL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a wait counts the queue moving while its head checks its place before a take", () => {
  const { root, origin, clone, seedEntries } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    tryAcquire({
      cwd: holder,
      remote: origin,
      runId: "holder",
      now: () => epoch,
      machine: ELSEWHERE,
    });
    let wall = epoch;
    let time = 0;
    let pauses = 0;
    let joinAtRead = false;
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          maxWaitMs: 5,
          // In the third poll the holder's lease has run out, and an older entry joins as the waiter reads the lease.
          now: () => {
            if (joinAtRead) {
              joinAtRead = false;
              seedEntries([["older", epoch - 1000]]);
              wall = epoch + 2 * LEASE_TTL_MS;
            }
            return wall;
          },
          sleep: () => {
            pauses += 1;
            joinAtRead = pauses === 2;
            time += 5;
          },
        }),
      /timed out waiting for main's landing queue/,
    );

    // The head moved at 10, as the waiter checked its place, so its wait ended at 15.
    assert.equal(time, 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waiting landers take the turn in arrival order while both stay in the queue", async () => {
  const { root, origin, git, clone } = setup();
  const landers = [];
  try {
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const entries = () =>
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX).split("\n").filter(Boolean);
    // The first lander stays in its pause after it joins, while the later one polls the free lease.
    const go = path.join(root, "go");
    const first = startLander({ name: "first", cwd: clone("first"), origin, go });
    landers.push(first);
    await reach(first.paused(1), "the first lander never waited", landers);
    const released = path.join(root, "released");
    const later = startLander({ name: "later", cwd: clone("later"), origin, released });
    landers.push(later);
    // Each lander joins the queue in the poll before its first pause.
    await reach(later.paused(1), "the later lander never waited", landers);
    assert.equal(entries().length, 2, "the later lander joined the queue");
    release({ cwd: holder, remote: origin }, held);
    fs.writeFileSync(released, "");
    await reach(later.pausedSinceRelease(2), "the later lander stopped polling", landers);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "", "the later lander took the turn");

    fs.writeFileSync(go, "");
    await reach(first.closed, "the first lander never took the turn", [later]);
    assert.equal(first.result.code, 0, first.result.stderr);
    assert.equal(git(origin, "rev-parse", LEASE_REF), first.result.stdout);
    assert.equal(entries().length, 1, "the later lander left the queue");
    release({ cwd: holder, remote: origin }, first.result.stdout);
    await reach(later.closed, "the later lander never took the turn", []);
    assert.equal(later.result.code, 0, later.result.stderr);
    assert.equal(git(origin, "rev-parse", LEASE_REF), later.result.stdout);
    assert.deepEqual(entries(), []);
  } finally {
    for (const lander of landers) if (lander.result === null) lander.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter that joins after another comes after it, however far ahead the other's clock runs", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const ahead = clone("ahead");
    const waiter = clone("waiter");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const ref = `${QUEUE_PREFIX}ahead.1`;
    git(
      ahead,
      "push",
      "-q",
      "origin",
      `${entryCommit(ahead, "ahead", epoch + 60 * 60_000)}:${ref}`,
    );

    let time = 0;
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => time,
          awakeClock: () => time,
          now: () => epoch,
          maxWaitMs: 1,
          sleep: () => (time += 1),
        }),
      /timed out waiting for main's landing queue/,
    );
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
    assert.equal(git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX), ref);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a queue longer than one poll reads still gives the turn to its first waiter", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const holder = clone("holder");
    const others = clone("others");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // More waiters join after it than the queue prunes in bulk for, each with its own entry commit.
    const laterCount = 210;
    let time = 0;
    let pauses = 0;
    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => time,
      awakeClock: () => time,
      now: () => epoch,
      sleep: () => {
        time += 1;
        pauses += 1;
        assert.ok(pauses <= 10, "never took the turn");
        if (pauses > 1) return;
        const later = Array.from({ length: laterCount }, (_, index) => [
          entryCommit(others, `later-${index}`, epoch + 1000 + index),
          `${QUEUE_PREFIX}later-${index}.1`,
        ]);
        git(others, "push", "-q", "origin", ...later.map(([sha, ref]) => `${sha}:${ref}`));
        release({ cwd: holder, remote: origin }, held);
      },
    });

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    // One pause behind the holder, then one per bounded batch it reads; the poll reading the last batch takes the turn.
    assert.equal(pauses, Math.ceil(laterCount / QUEUE_FETCH_MAX));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiter that finds a long queue reads one bounded batch per poll and joins while later landers come and go", () => {
  const { root, origin, clone, seedEntries, dropEntries, ticketsOn } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    // Already waiting when it starts, on machines whose clocks run ahead of its own.
    const waitingCount = 250;
    const known = seedEntries(
      Array.from({ length: waitingCount }, (_, index) => [`a-${index}`, epoch + 60_000 + index]),
    );
    const latest = epoch + 60_000 + waitingCount - 1;
    // More landers than one poll reads join between its polls and leave before the next.
    const passing = (round) =>
      Array.from({ length: QUEUE_FETCH_MAX + 1 }, (_, index) => `z-${round}-${index}`);
    known.push(...seedEntries(passing(0).map((runId) => [runId, epoch + 120_000])));
    const fetched = () =>
      execFileSync("git", ["-C", waiter, "cat-file", "--batch-check"], {
        input: `${known.join("\n")}\n`,
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line && !line.endsWith(" missing")).length;
    const isOwn = (name) => !/^[az]-/.test(name);
    let pauses = 0;
    let read = 0;
    const joined = new Error("joined");
    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: origin,
          clock: () => pauses,
          awakeClock: () => pauses,
          now: () => epoch,
          sleep: () => {
            pauses += 1;
            const total = fetched();
            assert.ok(
              total - read <= QUEUE_FETCH_MAX,
              `poll ${pauses} read ${total - read} entries`,
            );
            read = total;
            const own = ticketsOn(isOwn);
            if (own.length > 0) {
              assert.ok(
                own.every((since) => since > latest),
                "joined ahead of entries it had seen",
              );
              throw joined;
            }
            // Its first poll reads a batch and the next ones what is left of the entries it found.
            assert.ok(pauses < Math.ceil(waitingCount / QUEUE_FETCH_MAX), "never joined the queue");
            dropEntries(passing(pauses - 1));
            known.push(...seedEntries(passing(pauses).map((runId) => [runId, epoch + 120_000])));
          },
        }),
      (error) => error === joined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
