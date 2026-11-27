const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  TURN_ENV,
  TURN_MAX_MS,
  land,
  testing: { acquire, release, tryAcquire },
  verifyPush,
  withTurn,
} = require("./landing-turn.cjs");
const {
  ELSEWHERE,
  ZERO,
  LANDING_UPDATES,
  setup,
  loseNextAnswer,
  signalServer,
  logTransactions,
  landingTransaction,
  stderrOf,
} = require("./landing-turn.testkit.cjs");

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

test("a renewal that applies during the next lease update keeps the same holder's turn", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    // Save the commit from quarantine so origin can apply it after readback has seen the old lease.
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        "read -r old new ref || exit 1",
        `[ "$ref" = ${LEASE_REF} ] || exit 0`,
        "if [ -f delayed-renewal ]; then",
        "  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "  delayed=$(git hash-object -t commit -w delayed-renewal) || exit 1",
        '  git update-ref "$ref" "$delayed" "$old" || exit 1',
        "  mv delayed-renewal applied-renewal || exit 1",
        "  exit 1",
        "fi",
        "[ -f stall-renewal ] || exit 0",
        'git cat-file commit "$new" > delayed-renewal || exit 1',
        "rm stall-renewal || exit 1",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await withTurn(
      {
        cwd: holder,
        remote: origin,
        failingMs: 0,
        now: () => wall,
        every: (_ms, tick) => ((renew = tick), () => {}),
      },
      async (turn, signal) => {
        fs.writeFileSync(path.join(origin, "stall-renewal"), "");
        wall += LEASE_RENEW_MS;
        stderrOf(renew);
        assert.equal(git(origin, "rev-parse", LEASE_REF), turn);

        wall += LEASE_RENEW_MS;
        const { written } = stderrOf(renew);
        assert.ok(fs.existsSync(path.join(origin, "applied-renewal")));
        assert.equal(signal.aborted, false, written.join(""));

        wall = epoch + LEASE_TTL_MS;
        renew();
        verifyPush({
          cwd: holder,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now: () => wall,
        });
      },
    );

    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose turn another lander took during its check pushes nothing", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const mover = clone("mover");
    commit(lander, "mine.txt");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let renew;
    let taken;
    const result = await land({
      cwd: lander,
      remote: origin,
      now: () => wall,
      every: (_ms, tick) => ((renew = tick), () => {}),
      check: async (turn, _base, _seconds, _directory, signal) => {
        if (turn === null) {
          // Main moves after the check before the wait, so the lander checks again under the turn.
          commit(mover, "mover.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
          return true;
        }
        // The lander's machine sleeps through its renewals, and a lander on another machine takes the lease that ran out.
        wall += 2 * LEASE_TTL_MS;
        taken = acquire({
          cwd: other,
          remote: origin,
          now: () => wall,
          machine: ELSEWHERE,
          maxWaitMs: 0,
        });
        stderrOf(renew);
        assert.equal(signal.aborted, true, "the check was not told the turn was lost");
        return true;
      },
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease after it ran out.",
    });
    assert.equal(git(origin, "rev-parse", "main"), git(mover, "rev-parse", "HEAD"));
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander that slept between its check and its push learns at the push's renewal that it lost the turn, and pushes nothing", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let taken;
    const result = await land({
      cwd: lander,
      remote: origin,
      now: () => wall,
      every: () => () => {},
      check: () => true,
      // Main stays still, so the check before the wait is the only one. Under the turn, its renewals never run, as when
      // its machine sleeps before the push, and a lander on another machine takes the lease.
      turnClock: () => {
        wall += 2 * LEASE_TTL_MS;
        taken = acquire({
          cwd: other,
          remote: origin,
          now: () => wall,
          machine: ELSEWHERE,
          maxWaitMs: 0,
        });
        return 0;
      },
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease after it ran out.",
    });
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "rev-parse", LEASE_REF), taken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose lease another lander takes while its push is under way pushes nothing: main moves only with its lease", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const othersLease = tryAcquire({ cwd: other, remote: origin, runId: "other" });
    release({ cwd: other, remote: origin }, othersLease);
    // Origin has the push to main in hand when the other lander takes the lease, after the push's renewal.
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        'grep -q " refs/heads/main$" || exit 0',
        "unset GIT_QUARANTINE_PATH",
        `git update-ref ${LEASE_REF} ${othersLease}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = await land({
      cwd: lander,
      remote: origin,
      every: () => () => {},
      check: () => true,
    });

    assert.deepEqual(result, {
      status: "lost-turn",
      reason: "another lander took the lease before the push.",
    });
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "rev-parse", LEASE_REF), othersLease);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost has landed, even once another lander holds the lease it gave back", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    const other = clone("other");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    // The lease commit of another lander, which takes the lease the push gave back.
    const othersLease = tryAcquire({ cwd: other, remote: origin, runId: "other" });
    release({ cwd: other, remote: origin }, othersLease);
    // Origin applies the push to main, the other lander takes the lease, and the push's answer never comes.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        `  git -C "$1" update-ref ${LEASE_REF} ${othersLease} || return 1`,
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    const result = await land({
      cwd: lander,
      remote: "origin",
      every: () => () => {},
      // Stopped once origin applied it, as when its limit runs out.
      after: (_ms, stop) => ((stopPush = stop), () => {}),
      mainCallMs: 5000,
      check: () => true,
    });

    const head = git(lander, "rev-parse", "HEAD");
    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(
      git(origin, "rev-parse", LEASE_REF),
      othersLease,
      "gave back the other lander's lease",
    );
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost has landed when main holds it, though another landing moved main on", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    // Origin applies the push to main, another landing moves main on top of it, and the push's answer never comes.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        '  next=$(git -C "$1" commit-tree -p refs/heads/main -m next "refs/heads/main^{tree}") || return 1',
        '  git -C "$1" update-ref refs/heads/main "$next" || return 1',
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    const result = await land({
      cwd: lander,
      remote: "origin",
      every: () => () => {},
      after: (_ms, stop) => ((stopPush = stop), () => {}),
      mainCallMs: 5000,
      check: () => true,
    });

    const head = git(lander, "rev-parse", "HEAD");
    assert.deepEqual(result, { status: "landed", commit: head });
    assert.equal(git(origin, "rev-parse", "main^"), head);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost has landed when origin applies it during lease release", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const head = git(lander, "rev-parse", "HEAD");
    git(origin, "fetch", "-q", lander, "HEAD");
    git(
      lander,
      "config",
      "remote.origin.uploadpack",
      [
        "upload() {",
        '  git-upload-pack "$1" || return $?',
        '  [ ! -f "$1/delayed-landing" ] || touch "$1/read-delayed-landing"',
        "}; upload",
      ].join("\n"),
    );
    // A second push reaches origin after readback, while the original atomic update can still win.
    fs.writeFileSync(
      path.join(origin, "hooks", "pre-receive"),
      [
        "#!/bin/sh",
        "if [ -f delayed-landing ]; then",
        "  [ -f read-delayed-landing ] || exit 1",
        "  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "  git update-ref --stdin < delayed-landing || exit 1",
        "  mv delayed-landing applied-landing || exit 1",
        "  exit 1",
        "fi",
        "updates=$(cat) || exit 1",
        'printf "%s\\n" "$updates" | grep -q " refs/heads/main$" || exit 0',
        'printf "%s\\n" "$updates" | while read -r old new ref; do',
        `  if [ "$new" = ${ZERO} ]; then`,
        '    printf "delete %s %s\\n" "$ref" "$old"',
        "  else",
        '    printf "update %s %s %s\\n" "$ref" "$new" "$old"',
        "  fi",
        "done > delayed-landing",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await land({
      cwd: lander,
      remote: "origin",
      every: () => () => {},
      failingMs: 0,
      check: () => true,
    }).catch((error) => error);

    assert.ok(fs.existsSync(path.join(origin, "applied-landing")));
    assert.equal(git(origin, "rev-parse", "main"), head);
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
    assert.deepEqual(result, { status: "landed", commit: head });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push to main whose answer was lost, where origin then cannot be read, says whether it landed is unknown", async () => {
  const { root, origin, git, clone, commit } = setup();
  let stopPush = () => {};
  const signals = await signalServer(root, (name) => name === "pushed" && stopPush());
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const main = git(origin, "rev-parse", "main");
    const unreadable = JSON.stringify(path.join(root, "unreadable"));
    // Origin applies the push to main, then answers no read, and the push's answer never comes. The turn's release
    // after it pushes nothing.
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      [
        "receive() {",
        '  git-receive-pack "$1" || return $?',
        `  [ "$(git -C "$1" rev-parse refs/heads/main)" = ${main} ] && return 0`,
        `  [ -f ${unreadable} ] && return 0`,
        `  : > ${unreadable} || return 1`,
        `  ${signals.command("pushed")}`,
        "}; receive",
      ].join("\n"),
    );
    git(
      lander,
      "config",
      "remote.origin.uploadpack",
      [
        "upload() {",
        `  [ -f ${unreadable} ] && { echo "origin cannot be read" >&2; return 1; }`,
        '  git-upload-pack "$1"',
        "}; upload",
      ].join("\n"),
    );
    await assert.rejects(
      land({
        cwd: lander,
        remote: "origin",
        every: () => () => {},
        after: (_ms, stop) => ((stopPush = stop), () => {}),
        mainCallMs: 5000,
        // The release after it retries no read of origin, which stays unreadable.
        failingMs: 0,
        check: () => true,
      }),
      /git push failed, and whether it landed is unknown: [\s\S]*origin cannot be read/,
    );

    assert.equal(git(origin, "rev-parse", "main"), git(lander, "rev-parse", "HEAD"));
    assert.equal(git(origin, "for-each-ref", LEASE_REF), "");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PUSH_LIMITS = [
  ["while the turn has long to go", LEASE_RENEW_MS, LEASE_TTL_MS],
  ["near the turn's end", TURN_MAX_MS - 2 * 60_000, 2 * 60_000],
];
for (const [when, pushAt, limit] of PUSH_LIMITS) {
  test(`a push ${when} gives back a lease renewed for it, and is stopped before that lease runs out`, async () => {
    const { root, origin, git, clone, commit } = setup();
    try {
      const lander = clone("lander");
      commit(lander, "mine.txt");
      const transactions = logTransactions(origin);
      const epoch = Date.parse("2026-01-01T00:00:00Z");
      let wall = epoch;
      const limits = [];
      const result = await land({
        cwd: lander,
        remote: "origin",
        now: () => wall,
        every: () => () => {},
        mainCallMs: 3 * LEASE_TTL_MS,
        after: (ms) => (limits.push(ms), () => {}),
        check: () => true,
        // The turn, taken at the epoch, comes to its push at `pushAt`.
        turnClock: () => {
          wall = epoch + pushAt;
          return 0;
        },
      });

      assert.equal(result.status, "landed");
      // Each fetch of main, before the wait and under the turn, may take the whole limit of a call to main; the push
      // only what the lease renewed for it lasts.
      assert.deepEqual(limits, [3 * LEASE_TTL_MS, 3 * LEASE_TTL_MS, limit]);
      const givenBack = landingTransaction(transactions).find(({ ref }) => ref === LEASE_REF);
      assert.equal(givenBack.newSha, ZERO);
      const lease = git(origin, "show", "-s", "--format=%B", givenBack.oldSha).split("\n")[0];
      assert.equal(JSON.parse(lease).renewed_at, new Date(epoch + pushAt).toISOString());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
