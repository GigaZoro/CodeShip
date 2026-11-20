const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TURN_ENV, acquire, land, release, tryAcquire, verifyPush } = require("./landing-turn.cjs");

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

    let checks = 0;
    const result = land({
      cwd: first,
      remote: origin,
      runId: "first",
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
    for (const file of [".github/scripts/release-notes.cjs", ".gitattributes"]) {
      fs.copyFileSync(path.join(__dirname, "../..", file), path.join(seed, file));
    }
    ship(seed, shipped);
    git(seed, "push", "-q", "origin", "HEAD:main");
    const lander = clone("lander");
    ship(lander, mine, shipped);
    const mover = clone("mover");
    ship(mover, newer, shipped);
    git(mover, "push", "-q", "origin", "HEAD:main");

    const result = land({ cwd: lander, remote: origin, runId: "lander", check: () => true });

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
      runId: "lander",
      check: () => assert.fail("checked a tree it cannot push"),
    });
    assert.equal(uncommitted.status, "uncommitted");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
    fs.rmSync(path.join(dir, "scratch.txt"));

    const result = land({ cwd: dir, remote: origin, runId: "lander", check: () => false });

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

    assert.ok(acquire({ cwd: waiter, remote: origin, runId: "waiter", maxWaitMs: 0 }));
    assert.throws(
      () =>
        acquire({ cwd: holder, remote: origin, runId: "holder", maxWaitMs: 0, sleep: () => {} }),
      /still holds/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander rides out a dropped connection while it waits and releases, and never takes over a lease it could not read", () => {
  const { root, origin, git, clone } = setup();
  try {
    const holder = clone("holder");
    const reader = clone("reader");
    const gone = path.join(root, "gone.git");
    const unplug = () => git(reader, "remote", "set-url", "origin", gone);
    const plugIn = () => git(reader, "remote", "set-url", "origin", origin);
    const stale = tryAcquire({
      cwd: holder,
      remote: origin,
      runId: "holder",
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    const held = tryAcquire({ cwd: holder, remote: origin, runId: "holder" });
    assert.notEqual(held, stale);
    // A run whose lease push reached the remote but lost its answer finds that lease its own.
    assert.equal(tryAcquire({ cwd: holder, remote: origin, runId: "holder" }), held);

    // The lease is listed but its commit cannot be fetched, as git cannot write FETCH_HEAD: the reader must not
    // read that as no holder. Listing and pushing still work, so a takeover would succeed.
    const fetchHead = path.join(reader, ".git", "FETCH_HEAD");
    unplug();
    const steps = [
      () => {
        plugIn();
        fs.mkdirSync(fetchHead);
      },
      () => {
        assert.equal(git(origin, "rev-parse", "refs/heads/landing-lease/main"), held);
        fs.rmdirSync(fetchHead);
      },
      () => release({ cwd: holder, remote: origin }, held),
    ];
    const turn = acquire({
      cwd: reader,
      remote: "origin",
      runId: "reader",
      sleep: () => steps.shift()(),
    });
    assert.equal(steps.length, 0);

    unplug();
    release({ cwd: reader, remote: "origin", sleep: plugIn }, turn);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");

    git(reader, "remote", "set-url", "--push", "origin", gone);
    assert.throws(
      () =>
        acquire({
          cwd: reader,
          remote: "origin",
          runId: "reader",
          maxOutageMs: 0,
          sleep: () => assert.fail("kept waiting on a remote that refused every push"),
        }),
      /push failed/,
    );

    unplug();
    assert.throws(
      () =>
        acquire({
          cwd: reader,
          remote: "origin",
          runId: "reader",
          maxOutageMs: 0,
          sleep: () => assert.fail("kept waiting on a remote that stayed down"),
        }),
      /ls-remote failed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
