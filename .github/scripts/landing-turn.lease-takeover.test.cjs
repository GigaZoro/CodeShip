const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
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
  signalServer,
  logTransactions,
  landingTransaction,
  stderrOf,
} = require("./landing-turn.testkit.cjs");

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
