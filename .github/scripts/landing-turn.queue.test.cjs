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
const { QUEUE_STALE_MS } = require("./lease-queue.cjs");
const { QUEUE_PREFIX, ELSEWHERE, setup } = require("./landing-turn.testkit.cjs");

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
