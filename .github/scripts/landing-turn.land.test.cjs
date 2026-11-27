const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  LEASE_REF,
  LEASE_RESERVE_MS,
  TURN_ENV,
  TURN_MAX_MS,
  checkBudgetSeconds,
  keepAwake,
  land,
  overlappingWorktrees,
  main,
  pushChecked,
  testing: { acquire, release, tryAcquire },
  verifyPush,
} = require("./landing-turn.cjs");
const {
  ELSEWHERE,
  ZERO,
  LANDING_UPDATES,
  setup,
  signalServer,
  logTransactions,
} = require("./landing-turn.testkit.cjs");

/** Copies the lander's record when origin receives its push to main, which is what a waiter reads then. */
function watchPushRecord(git, origin, lander) {
  const hooks = path.join(origin, "hooks");
  const seen = path.join(origin, "seen-record");
  const records = path.join(lander, ".git", "landing-turn");
  fs.mkdirSync(hooks, { recursive: true });
  git(origin, "config", "core.hooksPath", hooks);
  fs.writeFileSync(
    path.join(hooks, "pre-receive"),
    "#!/bin/sh\nwhile read old new ref; do\n" +
      `  [ "$ref" = refs/heads/main ] && cat "${records.replaceAll("\\", "/")}"/* > "${seen.replaceAll("\\", "/")}"\n` +
      "done\nexit 0\n",
    { mode: 0o755 },
  );
  return () => JSON.parse(fs.readFileSync(seen, "utf8"));
}

test("a second lander cannot push to main while the first holds the turn, and the first checks under it only against a main that moved during its wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const first = clone("first");
    const second = clone("second");
    commit(first, "first.txt");
    commit(second, "second.txt");
    // Main moved after both started, so landing has to rebase and the earlier clone's checks would be stale.
    const mover = clone("mover");
    commit(mover, "mover.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");

    // Main from the named remote, as the CLI fetches it, also updates origin/main. A fetch that fails on that leaves
    // no turn ref behind, before the wait and in the turn, which it gives back.
    const lock = path.join(first, ".git/refs/remotes/origin/main.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const noTurnRefs = () =>
      assert.deepEqual(
        [
          git(first, "for-each-ref", "refs/worktree"),
          git(origin, "for-each-ref", "refs/heads/landing-lease"),
        ],
        ["", ""],
      );
    fs.writeFileSync(lock, "");
    await assert.rejects(
      () => land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
      /git fetch failed/,
    );
    noTurnRefs();
    fs.rmSync(lock);

    // The lander rebases before it waits, and lands again from the rebased tree.
    const rebases = async () => {
      assert.deepEqual(
        await land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
        {
          status: "rebased",
          base: git(mover, "rev-parse", "HEAD"),
          head: git(first, "rev-parse", "HEAD"),
        },
      );
      noTurnRefs();
      git(first, "merge-base", "--is-ancestor", git(mover, "rev-parse", "HEAD"), "HEAD");
    };
    await rebases();

    // Main moves while it waits behind the second lander's turn.
    const held = tryAcquire({ cwd: second, remote: origin, runId: "second" });
    await assert.rejects(
      () =>
        land({
          cwd: first,
          remote: "origin",
          check: (turn) => turn === null || assert.fail("checked under the turn"),
          sleep: () => {
            commit(mover, "moved.txt");
            git(mover, "push", "-q", "origin", "HEAD:main");
            fs.writeFileSync(lock, "");
            release({ cwd: second, remote: origin }, held);
          },
        }),
      /git fetch failed/,
    );
    noTurnRefs();
    fs.rmSync(lock);
    await rebases();

    // Checked before the wait against the main it rebased onto, and under the turn against the one main moved to.
    const rebasedOnto = git(mover, "rev-parse", "HEAD");
    const now = () => Date.UTC(2026, 0, 1);
    const again = tryAcquire({ cwd: second, remote: origin, runId: "second", now });
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    const checks = [];
    const result = await land({
      cwd: first,
      remote: "origin",
      now,
      turnClock: () => ticks.shift(),
      sleep: () => {
        commit(mover, "during.txt");
        git(mover, "push", "-q", "origin", "HEAD:main");
        release({ cwd: second, remote: origin }, again);
      },
      check: (turn, base, seconds) => {
        checks.push([base, seconds]);
        if (turn === null) return true;
        assert.equal(tryAcquire({ cwd: second, remote: origin, runId: "second", now }), null);
        assert.throws(
          () => verifyPush({ cwd: second, remote: origin, env: {}, updates: LANDING_UPDATES, now }),
          /landing turn/,
        );
        assert.throws(
          () =>
            verifyPush({
              cwd: second,
              remote: origin,
              env: { [TURN_ENV]: "0".repeat(40) },
              updates: LANDING_UPDATES,
              now,
            }),
          /landing turn/,
        );
        verifyPush({
          cwd: first,
          remote: origin,
          env: { [TURN_ENV]: turn },
          updates: LANDING_UPDATES,
          now,
        });
        // A push of main that keeps the lease could move main after the lease ran out, so the holder too is refused.
        assert.throws(
          () =>
            verifyPush({
              cwd: first,
              remote: origin,
              env: { [TURN_ENV]: turn },
              updates: LANDING_UPDATES.slice(0, 1),
              now,
            }),
          /gives back its lease/,
        );
        return true;
      },
    });

    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [
      [rebasedOnto, undefined],
      [git(mover, "rev-parse", "HEAD"), checkBudgetSeconds(TURN_MAX_MS, 10 * 60 * 1000)],
    ]);
    assert.equal(git(origin, "rev-parse", "main"), git(first, "rev-parse", "HEAD"));
    assert.equal(git(first, "merge-base", "--is-ancestor", "origin/main", "HEAD") === "", true);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    // Main came through the turn's own ref, which is gone; FETCH_HEAD is left to the checkout's other fetches.
    assert.deepEqual(
      [
        fs.existsSync(path.join(first, ".git/FETCH_HEAD")),
        git(first, "for-each-ref", "refs/worktree"),
      ],
      [false, ""],
    );
    assert.ok(tryAcquire({ cwd: second, remote: origin, runId: "second" }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander's release notes go among the ones main gained meanwhile by date, with no merge config set up", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const entry = (date, title) => `## ${date} — ${title}\n\n- ${title}.`;
    const shipped = entry("2026-11-18", "Shipped");
    const mine = entry("2026-11-18", "Mine");
    const newer = entry("2026-11-19", "Newer");
    const notesOf = (dir) => path.join(dir, "docs/release-notes.md");
    const ship = (dir, ...entries) => {
      fs.writeFileSync(notesOf(dir), `${entries.join("\n\n")}\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "notes");
    };
    const seed = path.join(root, "seed");
    fs.mkdirSync(path.join(seed, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(seed, "docs"));
    for (const file of ["release-notes.cjs", "git-history.cjs"]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(seed, ".github/scripts", file));
    }
    ship(seed, shipped);
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    ship(lander, mine, shipped);
    const mover = clone("mover");
    ship(mover, newer, shipped);
    git(mover, "push", "-q", "origin", "HEAD:main");
    // A local attribute outranks .gitattributes. The lander refuses before it waits behind another one's turn.
    const local = path.join(lander, ".git/info/attributes");
    fs.mkdirSync(path.dirname(local), { recursive: true });
    const held = tryAcquire({ cwd: mover, remote: origin, runId: "mover" });
    const waited = () => assert.fail("waited for the turn");
    for (const rule of ["merge=union", "!merge"]) {
      fs.writeFileSync(local, `docs/release-notes.md ${rule}\n`);
      await assert.rejects(
        () => land({ cwd: lander, remote: origin, check: () => true, sleep: waited }),
        /instead of its driver/,
      );
    }
    release({ cwd: mover, remote: origin }, held);
    fs.rmSync(local);

    // From a subdirectory too: the attribute is the notes' own, not one of a path below it.
    const landFromDocs = () =>
      land({ cwd: path.join(lander, "docs"), remote: origin, check: () => true });
    assert.equal((await landFromDocs()).status, "rebased");
    const result = await landFromDocs();

    assert.equal(result.status, "landed");
    assert.equal(
      fs.readFileSync(notesOf(lander), "utf8"),
      `${[newer, mine, shipped].join("\n\n")}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander adds its tool text bytes to the ones main gained meanwhile, with no merge config set up", async () => {
  const { root, git, clone } = setup();
  try {
    const file = "apps/server/src/provider/agentContextBudget.json";
    const ship = (dir, claude, mcp) => {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), `${JSON.stringify({ claude, mcp }, null, 2)}\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "budget");
    };
    const seed = path.join(root, "seed");
    // The whole folder, so the copied lander finds every script it comes to require.
    fs.cpSync(__dirname, path.join(seed, ".github/scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../../.gitattributes"),
      path.join(seed, ".gitattributes"),
    );
    ship(seed, 100, 1000);
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    ship(lander, 100, 1430);
    const mover = clone("mover");
    ship(mover, 105, 1050);
    git(mover, "push", "-q", "origin", "HEAD:main");

    const remote = git(lander, "remote", "get-url", "origin");
    assert.equal((await land({ cwd: lander, remote, check: () => true })).status, "rebased");

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lander, file), "utf8")), {
      claude: 105,
      mcp: 1480,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing keeps a Mac awake until it exits, and starts nothing elsewhere", () => {
  const started = [];
  const run = (command, args) => {
    started.push([command, ...args]);
    return { on: () => {}, unref: () => {} };
  };
  for (const platform of ["linux", "win32", "darwin"]) keepAwake({ platform, pid: 42, run });
  assert.deepEqual(started, [["/usr/bin/caffeinate", "-i", "-w", "42"]]);
});

test("a lander with uncommitted files, failing checks or a conflict with main does not push and holds no turn afterwards", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const before = git(origin, "rev-parse", "main");

    // Status lists each file, which takes these past spawnSync's 1 MiB default.
    const scratch = Array.from(
      { length: 8000 },
      (_, index) => `scratch-${String(index).padStart(4, "0")}-${"x".repeat(140)}.txt`,
    );
    for (const file of scratch) fs.writeFileSync(path.join(dir, file), "scratch\n");
    const uncommitted = await land({
      cwd: dir,
      remote: origin,
      check: () => assert.fail("checked a tree it cannot push"),
    });
    assert.equal(uncommitted.status, "uncommitted");
    assert.deepEqual(
      uncommitted.files,
      scratch.map((file) => `?? ${file}`),
    );
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    for (const file of scratch) fs.rmSync(path.join(dir, file));

    // Before it waits behind another lander's turn.
    const holder = clone("holder");
    const holding = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const result = await land({
      cwd: dir,
      remote: origin,
      check: () => false,
      sleep: () => assert.fail("waited for the turn"),
    });

    assert.equal(result.status, "check-failed");
    assert.equal(git(origin, "rev-parse", "main"), before);
    release({ cwd: holder, remote: origin }, holding);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // A branch that moves during the wait is not what the checks passed for.
    const waiting = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const moved = await land({
      cwd: dir,
      remote: origin,
      check: () => true,
      sleep: () => {
        commit(dir, "later.txt");
        release({ cwd: holder, remote: origin }, waiting);
      },
    });
    assert.equal(moved.status, "head-moved");
    assert.equal(git(origin, "rev-parse", "main"), before);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    git(dir, "reset", "-q", "--hard", "HEAD~1");

    // Before it waits behind another lander's turn.
    const mover = clone("mover");
    fs.writeFileSync(path.join(mover, "change.txt"), "main's change\n");
    git(mover, "add", ".");
    git(mover, "commit", "-qm", "main's change");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const held = tryAcquire({ cwd: mover, remote: origin, runId: "mover" });
    await assert.rejects(
      () =>
        land({
          cwd: dir,
          remote: origin,
          check: () => assert.fail("checked"),
          sleep: () => assert.fail("waited for the turn"),
        }),
      /git rebase failed/,
    );
    assert.equal(git(origin, "rev-parse", "landing-lease/main"), held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI continues with main's copy of the script after it rebases before the wait, and refuses an earlier copy's relaunch", () => {
  const { root, git, clone, commit } = setup();
  try {
    const seed = path.join(root, "seed");
    const scripts = path.join(seed, ".github/scripts");
    fs.mkdirSync(scripts, { recursive: true });
    for (const file of [
      "landing-turn.cjs",
      "bounded-git.cjs",
      "lease-queue.cjs",
      "process-tree.cjs",
      "git-history.cjs",
      "release-notes.cjs",
    ]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    }
    const windowsTree = "packages/shared/src/windowsProcessTreeScript.ts";
    fs.cpSync(path.resolve(__dirname, "../..", windowsTree), path.join(seed, windowsTree));
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "scripts");
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    commit(lander, "change.txt");
    fs.writeFileSync(
      path.join(scripts, "landing-turn.cjs"),
      'console.log(`main\'s copy: ${process.argv.slice(2).join(" ")}`);\n',
    );
    git(seed, "commit", "-qam", "main's script");
    git(seed, "push", "-q", "origin", "HEAD:main");

    const cli = (...args) =>
      spawnSync(
        process.execPath,
        [path.join(lander, ".github/scripts/landing-turn.cjs"), ...args],
        {
          cwd: lander,
          encoding: "utf8",
        },
      );
    // An earlier copy relaunched with `land --base --head`, before it listed the overlaps: refused, not continued.
    const before = git(lander, "rev-parse", "HEAD");
    const earlier = cli("land", "--base", git(seed, "rev-parse", "HEAD"), "--head", before);
    assert.deepEqual([earlier.status, earlier.stdout], [2, ""], earlier.stderr);
    assert.equal(git(lander, "rev-parse", "HEAD"), before);

    const run = cli("land");

    assert.deepEqual(
      [run.status, run.stdout],
      [
        0,
        `main's copy: land-rebased --base ${git(seed, "rev-parse", "HEAD")} --head ${git(lander, "rev-parse", "HEAD")}\n`,
      ],
      run.stderr,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a waiting lander takes the turn over from a holder whose lease expired, and gives up after its wait", () => {
  const { root, origin, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const past = Date.parse("2026-01-01T00:00:00Z");
    assert.ok(
      tryAcquire({
        cwd: holder,
        remote: origin,
        runId: "holder",
        now: () => past,
        machine: ELSEWHERE,
      }),
    );

    assert.ok(acquire({ cwd: waiter, remote: origin, maxWaitMs: 0 }));
    // A poll every few seconds leaves FETCH_HEAD to the checkout's other fetches.
    assert.equal(fs.existsSync(path.join(waiter, ".git/FETCH_HEAD")), false);
    assert.throws(
      () => acquire({ cwd: holder, remote: origin, maxWaitMs: 0, sleep: () => {} }),
      /still holds/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the turn is held only for a callback in one process: the module exports no way to take it or give it back", () => {
  const exported = require("./landing-turn.cjs");
  assert.deepEqual(
    ["acquire", "tryAcquire", "release"].filter((name) => name in exported),
    [],
  );
});

test("a landing and a push of a commit checked elsewhere each move main and give the turn back in one push", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    const transactions = logTransactions(origin);
    commit(dir, "landed.txt");
    assert.equal((await land({ cwd: dir, remote: origin, check: () => true })).status, "landed");
    const landed = git(dir, "rev-parse", "HEAD");
    commit(dir, "synced.txt");
    const synced = git(dir, "rev-parse", "HEAD");
    await pushChecked({ cwd: dir, remote: origin, head: synced });

    assert.equal(git(origin, "rev-parse", "main"), synced);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    // One transaction each: origin never holds the new main beside the lease, nor drops the lease while main stays.
    // HEAD names main in origin, so it appears beside main for its reflog alone.
    assert.deepEqual(
      transactions()
        .filter((updates) => updates.some(({ ref }) => ref === "refs/heads/main"))
        .map((updates) =>
          updates
            .filter(({ ref }) => ref !== "HEAD")
            .map(({ newSha, ref }) => [ref, newSha])
            .sort(),
        ),
      [landed, synced].map((head) => [
        [LEASE_REF, ZERO],
        ["refs/heads/main", head],
      ]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing's git calls leave the event loop free, so its renewals run while it rebases", async () => {
  const { root, origin, git, clone, commit } = setup();
  let renew;
  let renewed = null;
  // The rebase waits in its pre-rebase hook until the test renewed the lease.
  const signals = await signalServer(root, (name, answer) => {
    if (name !== "rebasing") return;
    const before = git(origin, "rev-parse", LEASE_REF);
    renew();
    renewed = git(origin, "rev-parse", `${LEASE_REF}^`) === before;
    answer();
  });
  try {
    const dir = clone("lander");
    commit(dir, "mine.txt");
    const mover = clone("mover");
    const hooks = path.join(root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(
      path.join(hooks, "pre-rebase"),
      `#!/bin/sh\n${signals.command("rebasing")}\n`,
      {
        mode: 0o755,
      },
    );
    git(dir, "config", "core.hooksPath", hooks);
    const result = await land({
      cwd: dir,
      remote: origin,
      every: (_ms, tick) => ((renew = tick), () => {}),
      check: (turn) => {
        // Main moves after the check before the wait, so the lander rebases under the turn.
        if (turn === null) {
          commit(mover, "mover.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
        }
        return true;
      },
    });
    assert.equal(result.status, "landed");
    assert.equal(renewed, true, "the lease was not renewed while the rebase ran");
  } finally {
    await signals.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing hands its check what the turn leaves, less the reserve for the push", () => {
  const full = (TURN_MAX_MS - LEASE_RESERVE_MS) / 1000;
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, 0), full);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, 30 * 60 * 1000), full - 1800);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS - 60 * 60 * 1000, 0), full - 3600);
  assert.equal(checkBudgetSeconds(TURN_MAX_MS, TURN_MAX_MS), 1);
});

test("land passes the budget the turn has left, measured from the turn's start", async () => {
  const { root, origin, clone, commit, git } = setup();
  try {
    const dir = clone("lander");
    const mover = clone("mover");
    commit(dir, "budget.txt");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    let budget;
    const result = await land({
      cwd: dir,
      remote: origin,
      now: () => wall,
      // An hour of the turn is gone when it starts, as when a take whose answer was lost is confirmed later.
      turnClock: () => {
        wall = epoch + 60 * 60 * 1000;
        return ticks.shift();
      },
      check: (turn, _base, seconds) => {
        if (turn) budget = seconds;
        else {
          assert.equal(seconds, undefined);
          commit(mover, "new-main.txt");
          git(mover, "push", "-q", "origin", "HEAD:main");
        }
        return true;
      },
    });
    assert.equal(result.status, "landed");
    assert.equal(budget, (TURN_MAX_MS - LEASE_RESERVE_MS) / 1000 - 3600 - 600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose main stays still checks once, before its wait, and holds the turn for the push alone", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "still.txt");
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const checks = [];
    const pushRecord = watchPushRecord(git, origin, dir);
    const result = await land({
      cwd: dir,
      remote: origin,
      check: (turn, base) => (checks.push([turn, base]), true),
      sleep: () => {
        assert.equal(checks.length, 1);
        release({ cwd: holder, remote: origin }, held);
      },
    });
    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [[null, git(holder, "rev-parse", "HEAD")]]);
    // A waiter that read the record while git pushed saw the push in flight.
    assert.equal(pushRecord().pushing, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the checks read a private checkout of the landed commit, not the lander's worktree", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const landed = git(dir, "rev-parse", "HEAD");
    let seen;
    let checkout;

    const result = await land({
      cwd: dir,
      remote: origin,
      check: (_turn, _base, _budget, directory) => {
        checkout = directory;
        // An edit made and undone while the checks run leaves the worktree clean again.
        fs.writeFileSync(path.join(dir, "base.txt"), "transient\n");
        seen = fs.readFileSync(path.join(directory, "base.txt"), "utf8");
        fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
        assert.equal(git(directory, "rev-parse", "HEAD"), landed);
        assert.notEqual(path.resolve(directory), path.resolve(dir));
        return true;
      },
    });

    assert.equal(seen, "base\n");
    assert.equal(result.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), landed);
    assert.equal(fs.existsSync(checkout), false);
    assert.equal(git(dir, "worktree", "list", "--porcelain").includes(checkout), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing continued after its rebase checks against the main it rebased onto, and stops if its branch left it", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const mover = clone("mover");
    commit(mover, "first.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const first = git(mover, "rev-parse", "HEAD");
    const rebased = await land({
      cwd: lander,
      remote: origin,
      check: () => assert.fail("checked"),
    });
    assert.deepEqual(rebased, {
      status: "rebased",
      base: first,
      head: git(lander, "rev-parse", "HEAD"),
    });
    commit(mover, "second.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    // A checkout switched to another branch after the rebase holds the base, but is not what was rebased.
    git(lander, "switch", "-q", "-c", "other", first);
    const switched = await land({
      cwd: lander,
      remote: origin,
      rebased,
      check: () => assert.fail("checked"),
    });
    assert.equal(switched.status, "head-moved");
    git(lander, "switch", "-q", "-");

    const checks = [];
    const result = await land({
      cwd: lander,
      remote: origin,
      rebased,
      check: (turn, base) => (checks.push([turn !== null, base]), true),
    });

    assert.equal(result.status, "landed");
    assert.deepEqual(checks, [
      [false, first],
      [true, git(mover, "rev-parse", "HEAD")],
    ]);
    // The mover's branch is behind the commit that landed, as a rebased branch that was reset would be.
    git(mover, "fetch", "-q", "origin");
    const left = await land({
      cwd: mover,
      remote: origin,
      rebased: { base: result.commit, head: git(mover, "rev-parse", "HEAD") },
      check: () => assert.fail("checked"),
    });
    assert.equal(left.status, "head-moved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it fetches main before the wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // The fetch runs this transport, which moves the checkout as another process could, then serves main.
    const transport = path.join(root, "switching-transport.sh");
    fs.writeFileSync(
      transport,
      `git -C "${lander}" switch -q -c elsewhere HEAD~1\nexec git upload-pack "${origin}"\n`,
    );
    git(lander, "config", "protocol.ext.allow", "always");
    // ext:: splits its command at spaces; `% ` and `%%` keep the path whole.
    const quoted = transport.replaceAll("%", "%%").replaceAll(" ", "% ");
    git(lander, "remote", "add", "switching", `ext::sh ${quoted}`);
    const result = await land({
      cwd: lander,
      remote: "switching",
      check: () => assert.fail("checked"),
    });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it inspects the working tree", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // Another commit with the same tree, so the working tree stays clean after the switch.
    const other = git(lander, "commit-tree", "HEAD^{tree}", "-p", "HEAD~1", "-m", "other");
    git(lander, "branch", "elsewhere", other);
    // `git status` runs this fsmonitor hook from the worktree, so no path of the fixture goes through a shell.
    const script = "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/elsewhere\nexit 1\n";
    fs.writeFileSync(path.join(lander, ".git", "switching-fsmonitor.sh"), script, { mode: 0o755 });
    git(lander, "config", "core.fsmonitor", ".git/switching-fsmonitor.sh");
    const result = await land({ cwd: lander, remote: origin, check: () => assert.fail("checked") });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it fetches a main that moved under the turn", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const racer = clone("racer");
    let started = false;
    const result = await land({
      cwd: lander,
      remote: origin,
      check: () => true,
      turnClock: () => {
        if (!started) {
          started = true;
          git(lander, "switch", "-q", "-c", "elsewhere", "HEAD~1");
          commit(racer, "raced.txt");
          git(racer, "push", "-q", "origin", "HEAD:main");
        }
        return 0;
      },
    });
    assert.equal(result.status, "head-moved");
    assert.equal(git(origin, "rev-parse", "main"), git(racer, "rev-parse", "HEAD"));
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a push of a commit checked elsewhere lands that commit while its record shows the push, and stops when its checkout left it", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const sync = clone("sync");
    commit(sync, "synced.txt");
    const checked = git(sync, "rev-parse", "HEAD");
    const main = git(sync, "rev-parse", "HEAD~1");
    // The checked tree on main's commit, so a pass for the checked tree covers it too.
    const sibling = git(sync, "commit-tree", "HEAD^{tree}", "-p", main, "-m", "sibling");
    const push = () => pushChecked({ cwd: sync, remote: origin, head: checked });
    // Git hands pre-push each ref as `<source> <sha> <destination> <sha>`: a source of `HEAD` would push
    // whatever the checkout is on when git reads it, after the check above.
    const hooks = path.join(root, "sync-hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\ncat >> ../pre-push.txt\n", {
      mode: 0o755,
    });
    git(sync, "config", "core.hooksPath", hooks);
    git(sync, "reset", "-q", "--hard", sibling);
    await assert.rejects(push, /the checkout moved off/);
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    git(sync, "reset", "-q", "--hard", checked);
    const pushRecord = watchPushRecord(git, origin, sync);
    // Once main took the push, a record the lander cannot write must not turn the landing into a failure.
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (fs.existsSync(to) && JSON.parse(fs.readFileSync(to, "utf8")).pushing) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return rename(from, to);
    });
    await push();
    t.mock.restoreAll();
    assert.deepEqual(
      [
        git(origin, "rev-parse", "main"),
        pushRecord().pushing,
        fs.readdirSync(path.join(sync, ".git", "landing-turn")),
      ],
      [checked, true, []],
    );
    const pushedToMain = fs
      .readFileSync(path.join(root, "pre-push.txt"), "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .filter((fields) => fields[2] === "refs/heads/main");
    assert.deepEqual(
      pushedToMain.map((fields) => fields[0]),
      [checked],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a replace ref cannot make main look contained in a commit that does not hold it", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const mover = clone("mover");
    commit(mover, "newer.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const newer = git(mover, "rev-parse", "HEAD");
    // A commit with HEAD's tree on top of main's newer commit, shown in HEAD's place.
    git(lander, "fetch", "-q", "origin");
    const fake = git(lander, "commit-tree", "HEAD^{tree}", "-p", newer, "-m", "fake");
    git(lander, "replace", "HEAD", fake);
    assert.equal(git(lander, "merge-base", "--is-ancestor", newer, "HEAD"), "");

    const rebased = await land({ cwd: lander, remote: origin, check: () => true });
    assert.equal(rebased.status, "rebased");
    const result = await land({ cwd: lander, remote: origin, rebased, check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "merge-base", "--is-ancestor", newer, "main") ?? "", "");
    assert.equal(git(origin, "show", "main:newer.txt"), "newer.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a command given an argument it does not take is refused before it takes the turn or pushes", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const main_ = git(origin, "rev-parse", "main");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(line));
    // `land` first: a mistyped flag there once started a real landing. `verify` would wait on stdin.
    const refused = [
      ["land", "--quick-precheck"],
      ["land", "--finalize"],
      ["land", "--finalize", ""],
      ["land", "--finalize", "echo ok", "extra"],
      ["push"],
      ["push", "HEAD"],
      ["precheck"],
      [],
      ["verify"],
    ];
    for (const argv of [
      ...refused,
      ["push", git(dir, "rev-parse", "HEAD"), "extra"],
      ["verify", "origin", "extra"],
    ]) {
      assert.equal(await main(argv, { cwd: dir }), 2, JSON.stringify(argv));
    }
    assert.deepEqual(
      errors,
      Array(11).fill(
        "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote> | merge-budget <base> <ours> <theirs> | land --finalize <command>",
      ),
    );
    assert.equal(git(origin, "rev-parse", "main"), main_);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("`push` reports the commit it names as landed only once main holds it", async (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("upgrade");
    commit(dir, "upgraded.txt");
    const head = git(dir, "rev-parse", "HEAD");
    const reports = [];
    // What origin's main is when the command reports, so a report ahead of the push shows.
    t.mock.method(console, "log", (line) => reports.push([line, git(origin, "rev-parse", "main")]));

    assert.equal(await main(["push", head], { cwd: dir }), 0);
    assert.deepEqual(reports, [[JSON.stringify({ status: "landed", commit: head }), head]]);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander refuses files marked assume-unchanged or skip-worktree, whose edits status does not list", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git(dir, "update-index", flag, "base.txt");
      const result = await land({
        cwd: dir,
        remote: origin,
        check: () => assert.fail("checked a tree it cannot push"),
      });
      assert.deepEqual(result, { status: "marked-files", files: ["base.txt"] });
      git(dir, "update-index", flag.replace("--", "--no-"), "base.txt");
    }
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rebase that conflicts is aborted after the overlap listing, and a worktree in a stopped rebase is refused before the wait", async () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    fs.writeFileSync(path.join(lander, "base.txt"), "mine\n");
    git(lander, "commit", "-qam", "mine");
    const overlapping = path.join(root, "overlapping");
    git(lander, "worktree", "add", "-q", "-b", "overlapping", overlapping, "origin/main");
    commit(overlapping, "base.txt");
    const mover = clone("mover");
    fs.writeFileSync(path.join(mover, "base.txt"), "theirs\n");
    git(mover, "commit", "-qam", "theirs");
    git(mover, "push", "-q", "origin", "HEAD:main");

    // A conflict is when the listing helps most: it names the work to reconcile with.
    const reports = [];
    const report = (text) => reports.push(text);
    await assert.rejects(
      () => land({ cwd: lander, remote: origin, check: () => true, report }),
      /rebase/,
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*base\.txt/);
    assert.equal(git(lander, "status", "--porcelain"), "");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // Stop a rebase by hand: the next landing must not start from it.
    git(lander, "fetch", "-q", "origin");
    spawnSync("git", ["-C", lander, "rebase", "origin/main"], { encoding: "utf8" });
    const stopped = await land({
      cwd: lander,
      remote: origin,
      check: () => assert.fail("checked"),
    });
    assert.equal(stopped.status, "rebase-in-progress");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing lists other worktrees with unmerged work on the same files, and none that share nothing", async () => {
  const { root, git, clone, commit } = setup();
  try {
    const mine = clone("mine");
    commit(mine, "shared.txt");
    const base = git(mine, "rev-parse", "origin/main");
    const add = (name, file) => {
      const dir = path.join(root, name);
      git(mine, "worktree", "add", "-q", "-b", name, dir, base);
      commit(dir, file);
    };
    add("overlapping", "shared.txt");
    add("unrelated", "other.txt");
    // A branch with more changed file names than spawnSync's default 1 MiB buffer holds.
    const bulk = path.join(root, "bulk");
    git(mine, "worktree", "add", "--no-checkout", "-q", "-b", "bulk", bulk, base);
    const blob = git(bulk, "rev-parse", base + ":base.txt");
    const names = Array.from({ length: 6000 }, (_, i) => "x".repeat(200) + i);
    assert.ok(Buffer.byteLength(names.join("\n")) > 1024 * 1024);
    const tree = execFileSync("git", ["-C", bulk, "mktree"], {
      input:
        [
          git(bulk, "ls-tree", base),
          ...names.map((name) => "100644 blob " + blob + "\t" + name),
        ].join("\n") + "\n",
      encoding: "utf8",
    }).trim();
    git(bulk, "update-ref", "HEAD", git(bulk, "commit-tree", tree, "-p", base, "-m", "bulk"), base);
    const found = overlappingWorktrees({ cwd: mine, base });
    assert.deepEqual(
      found.map(({ branch, files }) => ({ branch, files })),
      [{ branch: "overlapping", files: ["shared.txt"] }],
    );
    // Git for Windows lists `C:/…`; the landing names the path as the system writes it.
    assert.equal(found[0].worktree, path.join(root, "overlapping"));

    // Main moved, so the landing rebases and lands from a relaunch, which does not list the overlaps again.
    const mover = clone("mover");
    commit(mover, "newer.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const reports = [];
    const options = {
      cwd: mine,
      remote: "origin",
      check: () => true,
      report: (text) => reports.push(text),
    };
    const rebased = await land(options);
    assert.equal(rebased.status, "rebased");
    assert.equal((await land({ ...options, rebased })).status, "landed");
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*shared\.txt/);
    assert.doesNotMatch(reports[0], /unrelated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
