const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BOOT_ID,
  LEASE_REF,
  LEASE_RESERVE_MS,
  LEASE_TTL_MS,
  TURN_ENV,
  checkBudgetSeconds,
  acquire,
  land,
  overlappingWorktrees,
  main,
  pushChecked,
  processHost,
  release,
  tryAcquire,
  verifyPush,
} = require("./landing-turn.cjs");
const { createQueueWaiter } = require("./lease-queue.cjs");

const QUEUE_PREFIX = "refs/heads/landing-lease/queue/";
const QUEUE_REFRESH_MS = 60_000;
const QUEUE_STALE_MS = 3 * 60_000;
const QUEUE_FETCH_MAX = 100;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  const entryMessage = (runId, waitingSince) =>
    JSON.stringify({
      kind: "land",
      host: "fixture",
      run_id: runId,
      waiting_since: new Date(waitingSince).toISOString(),
    });
  // A queue entry's commit as another lander writes it.
  const entryCommit = (dir, runId, waitingSince) =>
    git(dir, "commit-tree", EMPTY_TREE, "-m", entryMessage(runId, waitingSince));
  const updateRefs = (lines) =>
    execFileSync("git", ["-C", origin, "update-ref", "--stdin"], { input: lines.join("") });
  // The entries of many other landers, `[runId, waitingSince]` each, put on origin in a few git calls.
  const seedEntries = (entries) => {
    const folder = fs.mkdtempSync(path.join(root, "entries-"));
    const files = entries.map(([runId, waitingSince], index) => {
      const file = path.join(folder, String(index));
      const author = "Fixture <fixture@example.invalid> 1767225600 +0000";
      fs.writeFileSync(
        file,
        `tree ${EMPTY_TREE}\nauthor ${author}\ncommitter ${author}\n\n${entryMessage(runId, waitingSince)}\n`,
      );
      return file;
    });
    execFileSync("git", ["-C", origin, "hash-object", "-t", "tree", "-w", "--stdin"], {
      input: "",
    });
    const shas = execFileSync(
      "git",
      ["-C", origin, "hash-object", "-t", "commit", "-w", "--stdin-paths"],
      { input: `${files.join("\n")}\n`, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    fs.rmSync(folder, { recursive: true });
    updateRefs(
      entries.map(([runId], index) => `create ${QUEUE_PREFIX}${runId}.1 ${shas[index]}\n`),
    );
    return shas;
  };
  const dropEntries = (runIds) =>
    updateRefs(runIds.map((runId) => `delete ${QUEUE_PREFIX}${runId}.1\n`));
  // The tickets of the queue entries on origin whose names `own` picks.
  const ticketsOn = (own) =>
    git(origin, "for-each-ref", "--format=%(refname) %(objectname)", QUEUE_PREFIX)
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split(" "))
      .filter(([ref]) => own(ref.slice(QUEUE_PREFIX.length)))
      .map(([, sha]) =>
        Date.parse(
          JSON.parse(git(origin, "show", "-s", "--format=%B", sha).split("\n")[0]).waiting_since,
        ),
      );
  return { root, origin, git, clone, commit, entryCommit, seedEntries, dropEntries, ticketsOn };
}

// A lander in its own process. It reports each pause it begins on fd 3, as "released" once the RELEASED file exists.
// With GO, its first pause lasts until that file exists.
const LANDER_SCRIPT = `
const fs = require("node:fs");
const { acquire } = require(process.env.LANDING_TURN);
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

/** Apply one real lease push before reporting transport failure, optionally making the next read fail too. */
function loseNextAnswer(lander, origin, git, disconnect = false) {
  const marker = path.join(origin, "drop-ack");
  fs.writeFileSync(marker, "");
  git(
    lander,
    "config",
    "remote.origin.receivepack",
    [
      "receive() {",
      '  git-receive-pack "$1" || return $?',
      '  if [ -f "$1/drop-ack" ] && git -C "$1" show-ref --verify --quiet refs/heads/landing-lease/main; then',
      '    rm "$1/drop-ack" || return 1',
      disconnect ? '    mv "$1/HEAD" "$1/HEAD-away" || return 1' : "",
      "    return 1",
      "  fi",
      "  return 0",
      "}; receive",
    ].join("\n"),
  );
  return {
    marker,
    reconnect: () => fs.renameSync(path.join(origin, "HEAD-away"), path.join(origin, "HEAD")),
  };
}

/** Collects what the lander writes to stderr while `run` runs. */
function stderrOf(run) {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => written.push(String(chunk)) > 0;
  try {
    return { result: run(), written };
  } finally {
    process.stderr.write = write;
  }
}

// Only Linux's /proc tells a lander's kernel boot and PID namespace, so only there does a waiter take a lease over.
const TAKES_OVER = processHost() !== null;

// Takes the lease in a process of its own, which exits without giving it back.
function takeAndExit(cwd, remote) {
  const taken = spawnSync(
    process.execPath,
    [
      "-e",
      "const [script, cwd, remote] = process.argv.slice(1);" +
        'process.stdout.write(require(script).tryAcquire({ cwd, remote, runId: "gone" }) ?? "");',
      path.join(__dirname, "landing-turn.cjs"),
      cwd,
      remote,
    ],
    { encoding: "utf8" },
  );
  assert.equal(taken.status, 0, taken.stderr);
  return taken.stdout;
}

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

test("a second lander cannot push to main while the first holds the turn, and the first checks under it only against a main that moved during its wait", () => {
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
    assert.throws(
      () => land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
      /git fetch failed/,
    );
    noTurnRefs();
    fs.rmSync(lock);

    // The lander rebases before it waits, and lands again from the rebased tree.
    const rebases = () => {
      assert.deepEqual(
        land({ cwd: first, remote: "origin", check: () => assert.fail("checked") }),
        {
          status: "rebased",
          base: git(mover, "rev-parse", "HEAD"),
          head: git(first, "rev-parse", "HEAD"),
        },
      );
      noTurnRefs();
      git(first, "merge-base", "--is-ancestor", git(mover, "rev-parse", "HEAD"), "HEAD");
    };
    rebases();

    // Main moves while it waits behind the second lander's turn.
    const held = tryAcquire({ cwd: second, remote: origin, runId: "second" });
    assert.throws(
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
    rebases();

    // Checked before the wait against the main it rebased onto, and under the turn against the one main moved to.
    const rebasedOnto = git(mover, "rev-parse", "HEAD");
    const now = () => Date.UTC(2026, 0, 1);
    const again = tryAcquire({ cwd: second, remote: origin, runId: "second", now });
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    const checks = [];
    const result = land({
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
    assert.deepEqual(checks, [
      [rebasedOnto, undefined],
      [git(mover, "rev-parse", "HEAD"), checkBudgetSeconds(LEASE_TTL_MS, 10 * 60 * 1000)],
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
      assert.throws(
        () => land({ cwd: lander, remote: origin, check: () => true, sleep: waited }),
        /instead of its driver/,
      );
    }
    release({ cwd: mover, remote: origin }, held);
    fs.rmSync(local);

    // From a subdirectory too: the attribute is the notes' own, not one of a path below it.
    const landFromDocs = () =>
      land({ cwd: path.join(lander, "docs"), remote: origin, check: () => true });
    assert.equal(landFromDocs().status, "rebased");
    const result = landFromDocs();

    assert.equal(result.status, "landed");
    assert.equal(
      fs.readFileSync(notesOf(lander), "utf8"),
      `${[newer, mine, shipped].join("\n\n")}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander with uncommitted files, failing checks or a conflict with main does not push and holds no turn afterwards", () => {
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
    const uncommitted = land({
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
    const result = land({
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
    const moved = land({
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
    assert.throws(
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
      "lease-queue.cjs",
      "git-history.cjs",
      "release-notes.cjs",
    ]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    }
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
    // The holder's lease has expired, so a waiter that finds the queue empty reads it again before taking over.
    tryAcquire({ cwd: holder, remote: origin, runId: "holder", now: () => epoch - LEASE_TTL_MS });
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
      const blocked = path.join(records, takeAndExit(checkout, origin));
      fs.rmSync(blocked);
      fs.mkdirSync(blocked);
      fs.mkdirSync(path.join(records, "other"));
      assert.equal(wait(), null);
      const future = Date.parse("2100-01-01T00:00:00Z");
      const late = tryAcquire({ cwd: sibling, remote: origin, runId: "waiter", now: () => future });
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

test("a waiting lander that cannot fetch the holder's lease leaves it in place", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const waiter = clone("waiter");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    // Origin lists the lease but cannot send its commit, as when the fetch after the listing fails.
    fs.rmSync(path.join(origin, "objects", held.slice(0, 2), held.slice(2)));

    assert.throws(() => acquire({ cwd: waiter, remote: origin, maxWaitMs: 0 }), /git fetch failed/);
    assert.equal(git(waiter, "ls-remote", "--refs", origin, LEASE_REF).split("\t")[0], held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose push fails or times out is the lander's when origin took it, and a failed poll when it did not", () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    const { marker } = loseNextAnswer(lander, origin, git);

    const turn = acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 });
    assert.deepEqual(
      [fs.existsSync(marker), git(origin, "rev-parse", "landing-lease/main")],
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
    // A release tries a passing failure of origin again, and logs one that goes on instead of throwing it.
    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    release({ cwd: lander, remote: "origin", failingMs: 0 }, turn);
    assert.equal(git(origin, "rev-parse", "landing-lease/main"), turn);
    release(
      {
        cwd: lander,
        remote: "origin",
        sleep: () => git(lander, "config", "--unset", "remote.origin.pushurl"),
      },
      turn,
    );
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    const stall = path.join(origin, "stall");
    fs.writeFileSync(stall, "");
    git(
      lander,
      "config",
      "remote.origin.receivepack",
      'stall() { cd / && while [ -f "$1/stall" ]; do sleep 0.1; done; exit 1; }; stall',
    );
    try {
      assert.throws(
        () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0, callMs: 10_000 }),
        /git push failed: did not finish within 10 seconds/,
      );
    } finally {
      fs.rmSync(stall);
      git(lander, "config", "--unset", "remote.origin.receivepack");
    }

    git(lander, "config", "remote.origin.pushurl", path.join(root, "missing.git"));
    assert.throws(
      () => acquire({ cwd: lander, remote: "origin", maxWaitMs: 0 }),
      /git push failed/,
    );
    // Either take may have reached origin, so its record stays until a later take finds it past the lease's lifetime.
    const records = path.join(lander, ".git", "landing-turn");
    assert.equal(fs.readdirSync(records).length, 2);
    git(lander, "config", "--unset", "remote.origin.pushurl");
    const later = Date.parse("2100-01-01T00:00:00Z");
    const taken = tryAcquire({ cwd: lander, remote: origin, runId: "later", now: () => later });
    assert.deepEqual(fs.readdirSync(records), [taken]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take that reached origin but lost its answer is the lander's although another entry is now first", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const pauses = [
      () => {
        reconnect();
        // An entry older than the lander's own joins while the lander cannot tell whether its take applied.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
      },
    ];
    let time = 0;
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      now: () => epoch,
      maxWaitMs: 2,
      sleep: () => {
        time += 1;
        const pause = pauses.shift();
        assert.ok(pause, "waited behind its own lease");
        pause();
      },
    });

    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    assert.equal(
      git(origin, "for-each-ref", "--format=%(refname)", QUEUE_PREFIX),
      `${QUEUE_PREFIX}other.1`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose answer was lost goes back through the queue when its lease expired before it was confirmed", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { reconnect } = loseNextAnswer(lander, origin, git, true);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        reconnect();
        lost = git(origin, "rev-parse", LEASE_REF);
        // The lease runs out before the lander can tell its take applied, and an older entry joins meanwhile.
        wall = epoch + LEASE_TTL_MS;
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      now: () => wall,
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), wall + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a take whose lost answer is confirmed only after its lease expired goes back through the queue", () => {
  const { root, origin, git, clone, entryCommit } = setup();
  try {
    const lander = clone("lander");
    const other = clone("other");
    const { marker } = loseNextAnswer(lander, origin, git);
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    const expired = epoch + LEASE_TTL_MS + 1000;
    let time = 0;
    let lost;
    const pauses = [
      () => {
        lost = git(origin, "rev-parse", LEASE_REF);
        // An older entry joins while the lease that take left is expired.
        const sha = entryCommit(other, "other", epoch - 1000);
        git(other, "push", "-q", "origin", `${sha}:${QUEUE_PREFIX}other.1`);
        time = 1;
      },
      () => {
        assert.equal(git(origin, "rev-parse", LEASE_REF), lost, "went ahead of the older entry");
        // The older entry stops renewing.
        time = 1 + QUEUE_STALE_MS;
      },
    ];
    const turn = acquire({
      cwd: lander,
      remote: "origin",
      clock: () => time,
      // The lease runs out between the take and the read that confirms it.
      now: () => (fs.existsSync(marker) ? epoch : expired),
      sleep: () => {
        const pause = pauses.shift();
        assert.ok(pause, "waited after the older entry went stale");
        pause();
      },
    });

    assert.equal(pauses.length, 0, "kept the lease that had expired");
    assert.notEqual(turn, lost);
    assert.equal(git(origin, "rev-parse", LEASE_REF), turn);
    const holder = JSON.parse(git(origin, "show", "-s", "--format=%B", turn).split("\n")[0]);
    assert.equal(Date.parse(holder.expires_at), expired + LEASE_TTL_MS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a landing hands its check what the lease leaves, less the reserve for the push", () => {
  const full = (LEASE_TTL_MS - LEASE_RESERVE_MS) / 1000;
  assert.equal(checkBudgetSeconds(LEASE_TTL_MS, 0), full);
  assert.equal(checkBudgetSeconds(LEASE_TTL_MS, 30 * 60 * 1000), full - 1800);
  assert.equal(checkBudgetSeconds(LEASE_TTL_MS - 60 * 60 * 1000, 0), full - 3600);
  assert.equal(checkBudgetSeconds(LEASE_TTL_MS, LEASE_TTL_MS), 1);
});

test("land passes the budget the lease has left, measured from the turn's start", () => {
  const { root, origin, clone, commit, git } = setup();
  try {
    const dir = clone("lander");
    const mover = clone("mover");
    commit(dir, "budget.txt");
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    let wall = epoch;
    const ticks = [1_000, 1_000 + 10 * 60 * 1000];
    let budget;
    const result = land({
      cwd: dir,
      remote: origin,
      now: () => wall,
      // An hour of the lease is gone when the turn starts, as when a take whose answer was lost is confirmed later.
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
    assert.equal(budget, (LEASE_TTL_MS - LEASE_RESERVE_MS) / 1000 - 3600 - 600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose main stays still checks once, before its wait, and holds the turn for the push alone", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "still.txt");
    const holder = clone("holder");
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    const checks = [];
    const pushRecord = watchPushRecord(git, origin, dir);
    const result = land({
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

test("a landing continued after its rebase checks against the main it rebased onto, and stops if its branch left it", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const mover = clone("mover");
    commit(mover, "first.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const first = git(mover, "rev-parse", "HEAD");
    const rebased = land({ cwd: lander, remote: origin, check: () => assert.fail("checked") });
    assert.deepEqual(rebased, {
      status: "rebased",
      base: first,
      head: git(lander, "rev-parse", "HEAD"),
    });
    commit(mover, "second.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    // A checkout switched to another branch after the rebase holds the base, but is not what was rebased.
    git(lander, "switch", "-q", "-c", "other", first);
    const switched = land({
      cwd: lander,
      remote: origin,
      rebased,
      check: () => assert.fail("checked"),
    });
    assert.equal(switched.status, "head-moved");
    git(lander, "switch", "-q", "-");

    const checks = [];
    const result = land({
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
    const left = land({
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

test("a lander stops when its checkout is switched while it fetches main before the wait", () => {
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
    const result = land({ cwd: lander, remote: "switching", check: () => assert.fail("checked") });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it inspects the working tree", () => {
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
    const result = land({ cwd: lander, remote: origin, check: () => assert.fail("checked") });
    assert.equal(result.status, "head-moved");
    assert.equal(git(lander, "branch", "--show-current"), "elsewhere");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stops when its checkout is switched while it fetches a main that moved under the turn", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    const racer = clone("racer");
    let started = false;
    const result = land({
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

test("a push of a commit checked elsewhere lands that commit while its record shows the push, and stops when its checkout left it", (t) => {
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
    assert.throws(push, /the checkout moved off/);
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
    push();
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

test("a lander gives up on a fetch of main that stops answering", () => {
  const { root, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "mine.txt");
    // A remote that never answers: git waits for the transport's first line.
    git(lander, "config", "protocol.ext.allow", "always");
    git(lander, "remote", "add", "stalled", "ext::sleep 5");
    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: "stalled",
          mainCallMs: 100,
          check: () => assert.fail("checked"),
        }),
      /git fetch failed: did not finish within 0\.1 seconds/,
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

    const rebased = land({ cwd: lander, remote: origin, check: () => true });
    assert.equal(rebased.status, "rebased");
    const result = land({ cwd: lander, remote: origin, rebased, check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "merge-base", "--is-ancestor", newer, "main") ?? "", "");
    assert.equal(git(origin, "show", "main:newer.txt"), "newer.txt");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a command given an argument it does not take is refused before it takes the turn or pushes", (t) => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const main_ = git(origin, "rev-parse", "main");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(line));
    // `land` first: a mistyped flag there once started a real landing. `verify` would wait on stdin.
    const refused = [["land", "--quick-precheck"], ["push", "HEAD"], ["precheck"], [], ["verify"]];
    for (const argv of [...refused, ["verify", "origin", "extra"]]) {
      assert.equal(main(argv, { cwd: dir }), 2, JSON.stringify(argv));
    }
    assert.deepEqual(
      errors,
      Array(6).fill(
        "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | holder | verify <remote>",
      ),
    );
    assert.equal(git(origin, "rev-parse", "main"), main_);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
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

test("a rebase that conflicts is aborted after the overlap listing, and a worktree in a stopped rebase is refused before the wait", () => {
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
    assert.throws(() => land({ cwd: lander, remote: origin, check: () => true, report }), /rebase/);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*base\.txt/);
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

test("a landing lists other worktrees with unmerged work on the same files, and none that share nothing", () => {
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
    assert.equal(path.normalize(found[0].worktree), path.join(root, "overlapping"));

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
    const rebased = land(options);
    assert.equal(rebased.status, "rebased");
    assert.equal(land({ ...options, rebased }).status, "landed");
    assert.equal(reports.length, 1);
    assert.match(reports[0], /overlapping[\s\S]*shared\.txt/);
    assert.doesNotMatch(reports[0], /unrelated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
