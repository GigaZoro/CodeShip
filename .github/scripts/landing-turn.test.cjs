const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  LEASE_REF,
  QUEUE_PREFIX,
  TURN_ENV,
  acquire,
  land,
  release,
  tryAcquire,
  verifyPush,
} = require("./landing-turn.cjs");

// `land` runs git itself, so its rebase needs an identity on a runner without one. A hook exports GIT_DIR
// and GIT_INDEX_FILE. Git for Windows opens /dev/null, not os.devNull (\\.\nul).
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "landing-turn-")));
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-b", "main", origin);
  const clone = (name) => {
    const dir = path.join(root, name);
    git(root, "clone", "-q", origin, dir);
    return dir;
  };
  const seed = clone("seed");
  fs.copyFileSync(path.join(__dirname, "../../.gitattributes"), path.join(seed, ".gitattributes"));
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "base");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const commit = (dir, file) => {
    fs.writeFileSync(path.join(dir, file), `${file}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", file);
  };
  return { root, origin, git, clone, commit };
}

test("a second lander cannot push to main while the first holds the turn, and the first lands after one check", () => {
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
    // no turn ref behind and gives the turn back.
    const lock = path.join(first, ".git/refs/remotes/origin/main.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    assert.throws(
      () => land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
      /git fetch failed/,
    );
    assert.deepEqual(
      [
        git(first, "for-each-ref", "refs/worktree"),
        git(origin, "for-each-ref", "refs/heads/landing-lease"),
      ],
      ["", ""],
    );
    fs.rmSync(lock);

    let checks = 0;
    const result = land({
      cwd: first,
      remote: "origin",
      check: (turn, base) => {
        checks += 1;
        assert.equal(base, git(mover, "rev-parse", "HEAD"));
        assert.equal(tryAcquire({ cwd: second, remote: origin, runId: "second" }), null);
        assert.throws(
          () => verifyPush({ cwd: second, remote: origin, env: {}, refs: ["refs/heads/main"] }),
          /landing turn/,
        );
        assert.throws(
          () =>
            verifyPush({
              cwd: second,
              remote: origin,
              env: { [TURN_ENV]: "0".repeat(40) },
              refs: ["refs/heads/main"],
            }),
          /landing turn/,
        );
        verifyPush({
          cwd: first,
          remote: origin,
          env: { [TURN_ENV]: turn },
          refs: ["refs/heads/main"],
        });
        return true;
      },
    });

    assert.equal(result.status, "landed");
    assert.equal(checks, 1);
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

test("a lander's release notes go among the ones main gained meanwhile by date, with no merge config set up", () => {
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
    fs.copyFileSync(
      path.join(__dirname, "release-notes.cjs"),
      path.join(seed, ".github/scripts/release-notes.cjs"),
    );
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
      assert.throws(
        () => land({ cwd: lander, remote: origin, check: () => true, sleep: waited }),
        /instead of its driver/,
      );
    }
    release({ cwd: mover, remote: origin }, held);
    fs.rmSync(local);

    // From a subdirectory too: the attribute is the notes' own, not one of a path below it.
    const result = land({ cwd: path.join(lander, "docs"), remote: origin, check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(
      fs.readFileSync(notesOf(lander), "utf8"),
      `${[newer, mine, shipped].join("\n\n")}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander with uncommitted files or failing checks does not push and holds no turn afterwards", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const before = git(origin, "rev-parse", "main");

    fs.writeFileSync(path.join(dir, "scratch.txt"), "scratch\n");
    const uncommitted = land({
      cwd: dir,
      remote: origin,
      check: () => assert.fail("checked a tree it cannot push"),
    });
    assert.equal(uncommitted.status, "uncommitted");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    fs.rmSync(path.join(dir, "scratch.txt"));

    const result = land({ cwd: dir, remote: origin, check: () => false });

    assert.equal(result.status, "check-failed");
    assert.equal(git(origin, "rev-parse", "main"), before);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
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
    assert.ok(tryAcquire({ cwd: holder, remote: origin, runId: "holder", now: () => past }));

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

test("a lander that starts waiting later takes the turn only after the waiter ahead of it, whichever polls first", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const early = clone("early");
    const late = clone("late");
    const queue = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const start = Date.now();
    let lateQueue = null;
    const pauses = [
      () => {
        // The turn comes free, and a lander that started later polls before the early one does.
        release({ cwd: holder, remote: origin }, held);
        let minutes = 0;
        assert.throws(
          () =>
            acquire({
              cwd: late,
              remote: origin,
              now: () => start + 1,
              maxWaitMs: 60_000,
              clock: () => minutes * 60_000,
              sleep: () => {
                minutes += 1;
                lateQueue = queue().split("\n").length;
              },
            }),
          /still holds/,
        );
      },
    ];

    const turn = acquire({
      cwd: early,
      remote: origin,
      now: () => start,
      sleep: () => pauses.shift()(),
    });

    // The late lander queued behind the early one, and each left the queue when it gave up or took the turn.
    assert.deepEqual(
      [lateQueue, git(origin, "rev-parse", "landing-lease/main"), queue()],
      [2, turn, ""],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dead waiter's entry holds no place once it has gone three minutes unrenamed, and is deleted", () => {
  const { root, origin, git, clone } = setup();
  try {
    const waiter = clone("waiter");
    // A waiter that died while it waited: its entry sorts first and is never renamed again. A branch under the queue's
    // prefix that is no entry holds no place either, and is not the waiters' to delete.
    const dead = "000000000000001-dead.1";
    git(
      waiter,
      "push",
      "-q",
      origin,
      `HEAD:${QUEUE_PREFIX}${dead}`,
      `HEAD:${QUEUE_PREFIX}maintenance`,
    );
    const queue = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    const names = () =>
      queue()
        .split("\n")
        .map((ref) => ref.slice(QUEUE_PREFIX.length).replace(/^\d{15}-[\da-f-]{36}/, "own"));
    let minutes = 0;
    const seen = [];

    const turn = acquire({
      cwd: waiter,
      remote: origin,
      clock: () => minutes * 60_000,
      sleep: () => {
        seen.push(names());
        minutes += 1;
      },
    });

    // It waited three minutes behind the dead entry, renaming its own each minute rather than adding names.
    assert.deepEqual(
      [seen, git(origin, "rev-parse", "landing-lease/main"), queue()],
      [
        [
          [dead, "own.1", "maintenance"],
          [dead, "own.2", "maintenance"],
          [dead, "own.3", "maintenance"],
        ],
        turn,
        `${QUEUE_PREFIX}maintenance`,
      ],
    );
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
    // Each pause between polls takes 6 minutes. Origin cannot be reached for the second and the fourth poll: failures
    // 12 minutes apart, with a poll between them that saw the holder. Then the holder gives the turn back.
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
      sleep: () => {
        minutes += 6;
        pauses.shift()();
      },
    });

    assert.deepEqual([pauses.length, git(origin, "rev-parse", "landing-lease/main")], [0, turn]);
    fs.renameSync(origin, away);
    assert.throws(
      () => acquire({ cwd: holder, remote: origin, failingMs: 0 }),
      /git ls-remote failed/,
    );
    fs.renameSync(away, origin);
    release({ cwd: waiter, remote: origin }, turn);

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

test("a waiting lander that cannot fetch the holder's lease leaves it in place, and keeps its place in the queue", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    // Origin lists the lease and takes pushes but cannot send its commit, as when the fetch after the listing fails.
    // Git for Windows' sh reads forward slashes, and an ext:: URL splits its arguments on bare spaces.
    const slash = (file) => file.replaceAll("\\", "/");
    const unsent = slash(path.join(root, "unsent.sh"));
    fs.writeFileSync(
      unsent,
      `[ "$1" = upload-pack ] && exec git -c uploadpack.packObjectsHook=false upload-pack "${slash(origin)}"\nexec git "$1" "${slash(origin)}"\n`,
    );
    git(waiter, "config", "protocol.ext.allow", "always");
    const script = unsent.replaceAll("%", "%%").replaceAll(" ", "% ");
    git(waiter, "config", "remote.unsent.url", `ext::sh ${script} %s`);
    const queue = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    let minutes = 0;
    const renames = [];

    assert.throws(
      () =>
        acquire({
          cwd: waiter,
          remote: "unsent",
          failingMs: 3 * 60_000,
          clock: () => minutes * 60_000,
          sleep: () => {
            renames.push(queue().split(".").pop());
            minutes += 1;
          },
        }),
      /git fetch failed/,
    );
    // It renamed its entry each minute while the reads failed, so other waiters saw it alive, and left when it gave up.
    assert.deepEqual(
      [renames, git(waiter, "ls-remote", "--refs", origin, LEASE_REF).split("\t")[0], queue()],
      [["1", "2", "3"], held, ""],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose push fails or times out is the lander's when origin took it, and a failed poll when it did not", async () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    // Origin commits the take, then its receive-pack dies before it acknowledges the push.
    const hooks = path.join(origin, "hooks");
    git(origin, "config", "core.hooksPath", hooks);
    fs.writeFileSync(
      path.join(hooks, "reference-transaction"),
      '#!/bin/sh\n[ "$1" = committed ] && [ -e drop-ack ] && rm drop-ack && kill -9 "$PPID"\nexit 0\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(origin, "drop-ack"), "");

    const turn = acquire({ cwd: lander, remote: origin, maxWaitMs: 0 });
    assert.deepEqual(
      [
        fs.existsSync(path.join(origin, "drop-ack")),
        git(origin, "rev-parse", "landing-lease/main"),
      ],
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
    release({ cwd: lander, remote: path.join(root, "missing.git") }, turn);
    release({ cwd: lander, remote: origin }, turn);

    // A take that reached origin unacknowledged is found by the wait's next poll even when a waiter ahead of it has
    // appeared by then, and that waiter keeps its place. A live holder keeps the first poll from taking the lease; in
    // the pause the lease becomes the one such a take leaves, carrying the run id of the wait's queue entry.
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const queue = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    const ahead = `${QUEUE_PREFIX}000000000000001-ahead.1`;
    const pauses = [
      () => {
        const [, waitId] = /\/\d{15}-([^.]+)\.1$/.exec(queue());
        release({ cwd: holder, remote: origin }, held);
        tryAcquire({ cwd: holder, remote: origin, runId: waitId });
        git(holder, "push", "-q", origin, `HEAD:${ahead}`);
      },
    ];
    const ownTurn = acquire({
      cwd: lander,
      remote: origin,
      clock: () => 0,
      sleep: () => pauses.shift()(),
    });
    assert.deepEqual([git(origin, "rev-parse", "landing-lease/main"), queue()], [ownTurn, ahead]);
    release({ cwd: lander, remote: origin }, ownTurn);
    git(origin, "update-ref", "-d", ahead);

    // Origin stops answering pushes and never takes the lease: the push runs out of time, which is a failed poll. A
    // git:// listener stalls it with no process of its own, which on Windows would keep the fixture from being deleted
    // while it outlived the push; its connection is closed only after the push, which blocks this process, has ended.
    const silent = net.createServer((socket) => socket.destroy());
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    try {
      git(lander, "config", "remote.stall.url", origin);
      git(
        lander,
        "config",
        "remote.stall.pushurl",
        `git://127.0.0.1:${silent.address().port}/origin.git`,
      );
      assert.throws(
        () => acquire({ cwd: lander, remote: "stall", maxWaitMs: 0, callMs: 2000 }),
        /git push failed: did not finish within 2 seconds/,
      );
    } finally {
      silent.close();
    }

    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    assert.throws(
      () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 }),
      /git push failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
