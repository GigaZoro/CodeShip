const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  LEASE_CALL_MS,
  LEASE_REF,
  LEASE_RESERVE_MS,
  LEASE_TTL_MS,
  QUEUE_PREFIX,
  QUEUE_STALE_MS,
  TURN_ENV,
  checkBudgetSeconds,
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
  // A remote of `dir` that runs the sh script `body` for each call to origin. An ext:: URL splits its arguments on bare
  // spaces.
  const scriptRemote = (dir, name, body) => {
    const script = slash(path.join(root, `${name}.sh`));
    fs.writeFileSync(script, body);
    git(dir, "config", "protocol.ext.allow", "always");
    const url = `ext::sh ${script.replaceAll("%", "%%").replaceAll(" ", "% ")} %s`;
    git(dir, "config", `remote.${name}.url`, url);
  };
  return { root, origin, git, clone, commit, scriptRemote };
}

// Git for Windows' sh reads forward slashes.
const slash = (file) => file.replaceAll("\\", "/");

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
    // Waits that started before the holder's lease expires, which keeps that lease live to them.
    const start = Date.parse("2026-01-01T00:00:00.000Z");
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

test("a dead waiter's entry holds no place once it has gone unrenamed for the stale age, and is deleted", () => {
  const { root, origin, git, clone } = setup();
  try {
    const waiter = clone("waiter");
    // A waiter that died while it waited: its entry sorts first and is never renamed again. A branch under the queue's
    // prefix that is no entry holds no place either, and is not the waiters' to delete, even one named after an entry.
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
        if (minutes === 0) {
          const [, stem] = /\/(\d{15}-[\da-f-]{36})\.1$/m.exec(queue());
          git(waiter, "push", "-q", origin, `HEAD:${QUEUE_PREFIX}${stem}.backup`);
        }
        minutes += 1;
      },
    });

    // It waited behind the dead entry until that went stale, renaming its own each minute rather than adding names.
    const waits = Math.ceil(QUEUE_STALE_MS / 60_000);
    assert.deepEqual(
      [seen, git(origin, "rev-parse", "landing-lease/main"), names()],
      [
        [
          [dead, "own.1", "maintenance"],
          ...Array.from({ length: waits - 1 }, (_, wait) => [
            dead,
            `own.${wait + 2}`,
            "own.backup",
            "maintenance",
          ]),
        ],
        turn,
        ["own.backup", "maintenance"],
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
  const { root, origin, git, clone, scriptRemote } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    // Origin lists the lease and takes pushes but cannot send its commit, as when the fetch after the listing fails.
    scriptRemote(
      waiter,
      "unsent",
      `[ "$1" = upload-pack ] && exec git -c uploadpack.packObjectsHook=false upload-pack "${slash(origin)}"\nexec git "$1" "${slash(origin)}"\n`,
    );
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
    // Origin takes the push, but the connection drops before its status report reaches the lander. Pushes go through
    // a filter that passes receive-pack's ref advertisement, up to its flush packet, and drops what follows. A hook
    // cannot kill receive-pack under Git for Windows, whose sh sees no parent process.
    const dropped = path.join(root, "status-dropped");
    const filter = path.join(root, "drop-status.cjs");
    fs.writeFileSync(
      filter,
      `const { spawn } = require("node:child_process");
const fs = require("node:fs");
const pack = spawn("git", ["receive-pack", ${JSON.stringify(origin)}], { stdio: ["inherit", "pipe", "inherit"] });
let pending = Buffer.alloc(0);
let advertised = false;
pack.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  let end = 0;
  while (!advertised && pending.length - end >= 4) {
    const size = parseInt(pending.toString("latin1", end, end + 4), 16);
    if (size !== 0 && pending.length - end < size) break;
    advertised = size === 0;
    end += size === 0 ? 4 : size;
  }
  process.stdout.write(pending.subarray(0, end));
  if (advertised && end < pending.length) fs.writeFileSync(${JSON.stringify(dropped)}, "");
  pending = advertised ? Buffer.alloc(0) : pending.subarray(end);
});
`,
    );
    // An ext:: URL splits its arguments on bare spaces.
    const extArg = (value) => value.replaceAll("%", "%%").replaceAll(" ", "% ");
    git(lander, "config", "protocol.ext.allow", "always");
    git(lander, "config", "remote.unacknowledged.url", origin);
    git(
      lander,
      "config",
      "remote.unacknowledged.pushurl",
      `ext::${extArg(process.execPath)} ${extArg(filter)}`,
    );

    const turn = acquire({ cwd: lander, remote: "unacknowledged", maxWaitMs: 0 });
    assert.deepEqual(
      [fs.existsSync(dropped), git(origin, "rev-parse", "landing-lease/main")],
      [true, turn],
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

test("a landing hands its check what the lease leaves, less the reserve for the push", () => {
  assert.equal(checkBudgetSeconds(LEASE_TTL_MS), (LEASE_TTL_MS - LEASE_RESERVE_MS) / 1000);
  assert.equal(
    checkBudgetSeconds(LEASE_TTL_MS - 30 * 60 * 1000),
    (LEASE_TTL_MS - LEASE_RESERVE_MS) / 1000 - 1800,
  );
  assert.equal(checkBudgetSeconds(0), 1);
});

test("land's budget counts from the take, though the take reached origin a poll before the wait found it", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "budget.txt");
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const queue = () => git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX);
    // In the pause the lease becomes the one the wait's own take leaves when it reaches origin unacknowledged, ten
    // minutes before the wait's next poll finds it.
    const taken = Date.parse("2026-01-01T00:00:00.000Z");
    let wall = taken;
    const pauses = [
      () => {
        const [, waitId] = /\/\d{15}-([^.]+)\.1$/.exec(queue());
        release({ cwd: holder, remote: origin }, held);
        tryAcquire({ cwd: holder, remote: origin, runId: waitId, now: () => taken });
        wall = taken + 10 * 60 * 1000;
      },
    ];
    let budget;
    const result = land({
      cwd: dir,
      remote: origin,
      now: () => wall,
      sleep: () => pauses.shift()(),
      check: (_turn, _base, seconds) => ((budget = seconds), true),
    });
    assert.deepEqual(
      [result.status, budget],
      ["landed", (LEASE_TTL_MS - LEASE_RESERVE_MS) / 1000 - 600],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a replace ref cannot make main look contained in a commit that does not hold it", () => {
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

    const result = land({ cwd: lander, remote: origin, check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "merge-base", "--is-ancestor", newer, "main") ?? "", "");
    assert.equal(git(origin, "show", "main:newer.txt"), "newer.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander refuses files marked assume-unchanged or skip-worktree, whose edits status does not list", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git(dir, "update-index", flag, "base.txt");
      const result = land({
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

test("a rebase that conflicts is aborted, and a worktree in a stopped rebase is refused before the wait", () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    fs.writeFileSync(path.join(lander, "base.txt"), "mine\n");
    git(lander, "commit", "-qam", "mine");
    const mover = clone("mover");
    fs.writeFileSync(path.join(mover, "base.txt"), "theirs\n");
    git(mover, "commit", "-qam", "theirs");
    git(mover, "push", "-q", "origin", "HEAD:main");

    assert.throws(() => land({ cwd: lander, remote: origin, check: () => true }), /rebase/);
    assert.equal(git(lander, "status", "--porcelain"), "");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    // Stop a rebase by hand: the next landing must not start from it.
    git(lander, "fetch", "-q", "origin");
    spawnSync("git", ["-C", lander, "rebase", "origin/main"], { encoding: "utf8" });
    const stopped = land({ cwd: lander, remote: origin, check: () => assert.fail("checked") });
    assert.equal(stopped.status, "rebase-in-progress");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const slowWaits = [
  {
    lease: "a live lease",
    hold({ origin, holder }) {
      const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
      return (pauses) => pauses === 4 && release({ cwd: holder, remote: origin }, held);
    },
  },
  {
    // A take of an expired lease makes the most calls a poll can: it deletes that lease, and origin refuses the take.
    lease: "an expired lease whose take origin refuses",
    hold({ root, origin, holder }) {
      const past = Date.parse("2026-01-01T00:00:00Z");
      const expired = (runId) =>
        tryAcquire({ cwd: holder, remote: origin, runId, now: () => past });
      const refuse = path.join(root, "refuse-take");
      fs.writeFileSync(
        path.join(origin, "hooks/pre-receive"),
        `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = ${LEASE_REF} ] && [ "$old" = ${"0".repeat(40)} ] && [ -e "${slash(refuse)}" ]; then exit 1; fi\ndone\n`,
        { mode: 0o755 },
      );
      expired("dead");
      fs.writeFileSync(refuse, "");
      return (pauses) => {
        if (pauses === 1) {
          fs.rmSync(refuse);
          expired("dead-again");
          fs.writeFileSync(refuse, "");
        }
        if (pauses === 2) fs.rmSync(refuse);
      };
    },
  },
];

for (const { lease, hold } of slowWaits)
  test(`a waiter whose every call to origin takes as long as a call may still renames its entry before it looks dead, behind ${lease}`, () => {
    const { root, origin, git, clone, scriptRemote } = setup();
    try {
      const holder = clone("holder");
      const waiter = clone("waiter");
      const onPause = hold({ root, origin, holder });
      // Each call through this remote logs the queue as origin has it when the call starts, and takes LEASE_CALL_MS on
      // the waiter's clock; so does each pause, POLL_MS.
      const log = path.join(root, "calls.log");
      fs.writeFileSync(log, "");
      scriptRemote(
        waiter,
        "slow",
        `echo call $(git --git-dir="${slash(origin)}" for-each-ref --format='%(refname)' ${QUEUE_PREFIX}) >> "${slash(log)}"\nexec git "$1" "${slash(origin)}"\n`,
      );
      const pollMs = 5000;
      const lines = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
      const at = (count) =>
        lines()
          .slice(0, count)
          .reduce((ms, line) => ms + (line === "pause" ? pollMs : LEASE_CALL_MS), 0);
      let pauses = 0;

      const turn = acquire({
        cwd: waiter,
        remote: "slow",
        pollMs,
        // A refused take fails its poll, and at a minute a call two such polls outlast FAILING_MS.
        failingMs: Infinity,
        clock: () => at(Infinity),
        sleep: () => {
          fs.appendFileSync(log, "pause\n");
          pauses += 1;
          onPause(pauses);
        },
      });

      // A name appears during the call before the first one that lists it, and stays the newest at most until the end of
      // the last call that lists it as the newest. A reader's own listing may add one call to the age it measures.
      const calls = lines().flatMap((line, index) =>
        line === "pause" ? [] : [{ index, names: line.split(" ").slice(1) }],
      );
      const created = new Map();
      const rename = (name) => Number(name.split(".").pop());
      const listing = calls.map(({ index, names }, call) => {
        for (const name of names) if (!created.has(name)) created.set(name, calls[call - 1].index);
        if (names.length === 0) return null;
        const newest = names.reduce((a, b) => (rename(a) > rename(b) ? a : b));
        return at(index) + LEASE_CALL_MS - at(created.get(newest));
      });
      const listed = listing.flatMap((age, call) => (age === null ? [] : [call]));
      const oldest = Math.max(...listing.slice(listed[0], listed.at(-1) + 1));
      assert.deepEqual(
        [
          git(origin, "rev-parse", "landing-lease/main"),
          git(origin, "for-each-ref", QUEUE_PREFIX),
          listing.slice(listed[0], listed.at(-1) + 1).includes(null),
          oldest + LEASE_CALL_MS < QUEUE_STALE_MS || oldest,
        ],
        [turn, "", false, true],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
