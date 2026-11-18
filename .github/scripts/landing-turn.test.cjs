const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MAIN_ENV, TURN_ENV, acquire, land, tryAcquire, verifyPush } = require("./landing-turn.cjs");

// Every git here, the lander's own included, reads the fixture's settings alone: a hook's GIT_DIR, or a user's
// identity, signing, rerere, rebase backend or ignore file (which git reads from ~/.config/git/ignore without any
// config), would change what a landing does. Git reads /dev/null as an empty file on Windows too.
for (const name of Object.keys(process.env)) {
  if (name.toUpperCase().startsWith("GIT_")) delete process.env[name];
}
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
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
  const edit = (dir, content) => {
    fs.writeFileSync(path.join(dir, "base.txt"), content);
    git(dir, "commit", "-qam", content.trim());
  };
  const hook = (dir, name, script) =>
    fs.writeFileSync(path.join(dir, ".git", "hooks", name), script, { mode: 0o755 });
  /**
   * Makes `script` the merge driver of base.txt on main, through the release-notes driver config the lander passes
   * to its rebase, which runs it from the worktree: it runs inside the lander's rebase.
   */
  const driver = (script) => {
    fs.mkdirSync(path.join(seed, ".github/scripts"), { recursive: true });
    fs.writeFileSync(path.join(seed, ".github/scripts/release-notes.cjs"), script);
    fs.writeFileSync(path.join(seed, ".gitattributes"), "base.txt merge=release-notes\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "driver");
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { root, origin, git, clone, commit, edit, hook, driver };
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
      check: (turn) => {
        checks += 1;
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

test("a lander whose rebase conflicts gives the turn back with its branch as it was", () => {
  const { root, origin, git, clone, edit } = setup();
  try {
    const lander = clone("lander");
    edit(lander, "lander\n");
    const before = git(lander, "rev-parse", "HEAD");
    const mover = clone("mover");
    edit(mover, "mover\n");
    git(mover, "push", "-q", "origin", "HEAD:main");

    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: origin,
          runId: "lander",
          check: () => assert.fail("a lander that could not rebase ran its checks"),
        }),
      /conflicts in base\.txt/,
    );

    assert.equal(git(lander, "rev-parse", "HEAD"), before);
    assert.equal(git(lander, "status", "--porcelain"), "");
    assert.equal(fs.existsSync(path.join(lander, ".git", "rebase-merge")), false);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander stopped in the middle of a rebase is refused before it takes the turn, and its rebase is kept", () => {
  const { root, origin, git, clone, edit } = setup();
  try {
    const lander = clone("lander");
    edit(lander, "lander\n");
    const mover = clone("mover");
    edit(mover, "mover\n");
    git(mover, "push", "-q", "origin", "HEAD:main");
    git(lander, "fetch", "-q");
    assert.throws(() => git(lander, "rebase", "origin/main"));
    fs.writeFileSync(path.join(lander, "base.txt"), "resolved by hand\n");

    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: origin,
          runId: "lander",
          check: () => assert.fail("a lander in the middle of a rebase ran its checks"),
        }),
      /rebase is stopped in this worktree/,
    );

    assert.equal(fs.existsSync(path.join(lander, ".git", "rebase-merge")), true);
    assert.equal(fs.readFileSync(path.join(lander, "base.txt"), "utf8"), "resolved by hand\n");
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander that waited for its turn neither lands nor aborts a rebase someone stopped in its worktree meanwhile", () => {
  const { root, origin, git, clone, edit } = setup();
  try {
    const lander = clone("lander");
    edit(lander, "lander\n");
    const mover = clone("mover");
    edit(mover, "mover\n");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const main = git(origin, "rev-parse", "main");
    const holder = clone("holder");
    assert.ok(tryAcquire({ cwd: holder, remote: origin, runId: "holder" }));

    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: origin,
          runId: "lander",
          maxWaitMs: 60_000,
          // While the lander waits, someone rebases its worktree by hand and stops on the conflict; then the turn frees.
          sleep: () => {
            git(lander, "fetch", "-q");
            assert.throws(() => git(lander, "rebase", "origin/main"));
            fs.writeFileSync(path.join(lander, "base.txt"), "resolved by hand\n");
            git(holder, "push", "-q", "origin", ":refs/heads/landing-lease/main");
          },
          check: () => assert.fail("a lander ran its checks on a rebase it did not start"),
        }),
      /rebase is stopped in this worktree/,
    );

    assert.equal(fs.existsSync(path.join(lander, ".git", "rebase-merge")), true);
    assert.equal(fs.readFileSync(path.join(lander, "base.txt"), "utf8"), "resolved by hand\n");
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander leaves a rebase it did not start where it stopped, even one of the same commits onto the same main", () => {
  const { root, origin, git, clone, edit, driver } = setup();
  try {
    // While the lander's rebase runs, another process takes it over: its steps lose the lander's mark, as another
    // rebase of the same HEAD onto the same main would have them, and it stops on base.txt.
    driver(
      [
        'const { execFileSync } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const dir = execFileSync("git", ["rev-parse", "--git-path", "rebase-merge"], { encoding: "utf8" }).trim();',
        'for (const name of ["done", "git-rebase-todo"]) {',
        "  const file = path.join(dir, name);",
        '  if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^exec .*\\n/gmu, ""));',
        "}",
        "process.exitCode = 1;",
        "",
      ].join("\n"),
    );
    const lander = clone("lander");
    edit(lander, "lander\n");
    const mover = clone("mover");
    edit(mover, "mover\n");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const main = git(origin, "rev-parse", "main");

    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: origin,
          runId: "lander",
          check: () => assert.fail("a lander that could not rebase ran its checks"),
        }),
      /a rebase this lander did not start is stopped/,
    );

    assert.equal(fs.existsSync(path.join(lander, ".git", "rebase-merge")), true);
    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander with changes its HEAD does not hold is refused, before it waits for the turn and once it has it", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "change.txt");
    const main = git(origin, "rev-parse", "main");
    const holder = clone("holder");
    assert.ok(tryAcquire({ cwd: holder, remote: origin, runId: "holder" }));
    const refused = (options) =>
      assert.throws(
        () =>
          land({
            cwd: lander,
            remote: origin,
            runId: "lander",
            check: () => assert.fail("a lander ran its checks on changes it would not push"),
            ...options,
          }),
        /changes HEAD does not hold/,
      );

    // A changed file or an untracked one is refused at once, without waiting for the turn the holder has.
    fs.writeFileSync(path.join(lander, "change.txt"), "edited\n");
    refused({ maxWaitMs: 0, sleep: () => {} });
    git(lander, "checkout", "--", "change.txt");
    fs.writeFileSync(path.join(lander, "untracked.txt"), "untracked\n");
    refused({ maxWaitMs: 0, sleep: () => {} });
    fs.rmSync(path.join(lander, "untracked.txt"));
    // Status does not look at a file marked assume-unchanged or skip-worktree, whatever it holds.
    git(lander, "update-index", "--assume-unchanged", "change.txt");
    fs.writeFileSync(path.join(lander, "change.txt"), "hidden edit\n");
    refused({ maxWaitMs: 0, sleep: () => {} });
    git(lander, "update-index", "--no-assume-unchanged", "change.txt");
    git(lander, "checkout", "--", "change.txt");
    git(lander, "update-index", "--skip-worktree", "base.txt");
    refused({ maxWaitMs: 0, sleep: () => {} });
    git(lander, "update-index", "--no-skip-worktree", "base.txt");
    // One written while the lander waits is refused once the turn comes.
    refused({
      maxWaitMs: 60_000,
      sleep: () => {
        fs.writeFileSync(path.join(lander, "late.txt"), "late\n");
        git(holder, "push", "-q", "origin", ":refs/heads/landing-lease/main");
      },
    });

    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose index lists more than spawnSync's default 1 MiB buffer lands", () => {
  const { root, origin, git, clone } = setup();
  try {
    const lander = clone("lander");
    // 9,000 empty files whose `ls-files -v` lines take 129 bytes each: 1.1 MB, as this repository's 30,000 take 2 MB.
    const folder = `many/${"d".repeat(60)}`;
    fs.mkdirSync(path.join(lander, folder), { recursive: true });
    const blob = execFileSync("git", ["-C", lander, "hash-object", "-w", "--stdin"], {
      input: "",
      encoding: "utf8",
    }).trim();
    const files = Array.from(
      { length: 9000 },
      (_, index) => `${folder}/${String(index).padStart(4, "0")}${"f".repeat(56)}`,
    );
    for (const file of files) fs.writeFileSync(path.join(lander, file), "");
    execFileSync("git", ["-C", lander, "update-index", "--add", "--index-info"], {
      input: files.map((file) => `100644 ${blob}\t${file}\n`).join(""),
    });
    git(lander, "commit", "-qm", "many");
    const listing = execFileSync("git", ["-C", lander, "ls-files", "-v"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(listing.length > 1024 * 1024);

    const result = land({ cwd: lander, remote: origin, runId: "lander", check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "rev-parse", "main"), git(lander, "rev-parse", "HEAD"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose HEAD moves to another branch or commit while it waits for the turn lands neither", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "wanted.txt");
    const main = git(origin, "rev-parse", "main");
    const holder = clone("holder");
    const waitThen = (move) =>
      assert.throws(
        () =>
          land({
            cwd: lander,
            remote: origin,
            runId: "lander",
            maxWaitMs: 60_000,
            sleep: () => {
              move();
              git(holder, "push", "-q", "origin", ":refs/heads/landing-lease/main");
            },
            check: () => assert.fail("a lander checked a HEAD it was not started on"),
          }),
        /HEAD moved .* while this lander waited for its turn/,
      );

    // Another branch at the same commit, then a commit on the lander's own branch.
    assert.ok(tryAcquire({ cwd: holder, remote: origin, runId: "holder" }));
    waitThen(() => git(lander, "switch", "-q", "-c", "other"));
    git(lander, "switch", "-q", "main");
    assert.ok(tryAcquire({ cwd: holder, remote: origin, runId: "holder" }));
    waitThen(() => commit(lander, "other.txt"));

    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the worktree's hooks do not run inside a lander's rebase, so none can stop it, write files or switch its branch", () => {
  const { root, origin, git, clone, commit, hook } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "wanted.txt");
    const mover = clone("mover");
    commit(mover, "mover.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    git(lander, "branch", "unrelated", "origin/main");
    hook(lander, "pre-rebase", "#!/bin/sh\nexit 1\n");
    hook(lander, "post-rewrite", "#!/bin/sh\necho input > input.txt\ngit switch -q unrelated\n");

    const result = land({ cwd: lander, remote: origin, runId: "lander", check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "log", "--format=%s", "main"), "wanted.txt\nmover.txt\nbase");
    assert.equal(git(lander, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(fs.existsSync(path.join(lander, "input.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose rebase leaves changes behind gives the turn back unchecked", () => {
  const { root, origin, git, clone, edit, driver } = setup();
  try {
    // The merge driver runs inside the rebase, as another process working in the worktree can, and writes a file.
    driver(
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync("input.txt", "input\\n");',
        "fs.copyFileSync(process.argv[5], process.argv[4]);",
        "",
      ].join("\n"),
    );
    const lander = clone("lander");
    edit(lander, "lander\n");
    const mover = clone("mover");
    edit(mover, "mover\n");
    git(mover, "push", "-q", "origin", "HEAD:main");
    const main = git(origin, "rev-parse", "main");

    assert.throws(
      () =>
        land({
          cwd: lander,
          remote: origin,
          runId: "lander",
          check: () => assert.fail("a lander ran its checks on a file the push would not carry"),
        }),
      /changes HEAD does not hold[\s\S]*input\.txt/,
    );

    assert.equal(git(origin, "rev-parse", "main"), main);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander rebases onto the main it fetched, whatever another fetch leaves in FETCH_HEAD", () => {
  const { root, origin, git, clone, commit, hook } = setup();
  try {
    const lander = clone("lander");
    commit(lander, "change.txt");
    // A commit main never had, as a background fetch of every branch can leave first in FETCH_HEAD.
    const other = git(
      lander,
      "commit-tree",
      "-p",
      "origin/main",
      "-m",
      "other",
      "origin/main^{tree}",
    );
    const mover = clone("mover");
    commit(mover, "mover.txt");
    git(mover, "push", "-q", "origin", "HEAD:main");
    hook(
      lander,
      "reference-transaction",
      `#!/bin/sh\n[ "$1" = committed ] || exit 0\nwhile read old new ref; do\n  printf '%s\\t\\tbranch other\\n' ${other} > "$(git rev-parse --git-path FETCH_HEAD)"\ndone\n`,
    );

    const result = land({ cwd: lander, remote: "origin", runId: "lander", check: () => true });

    assert.equal(result.status, "landed");
    assert.equal(git(origin, "log", "--format=%s", "main"), "change.txt\nmover.txt\nbase");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the land command runs check:changed from the worktree root, wherever it starts, against the main it lands on", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const lander = clone("lander");
    fs.mkdirSync(path.join(lander, "docs"));
    commit(lander, "docs/readme.md");
    const main = git(origin, "rev-parse", "main");
    // A `vp` that records how the default check ran it, for the shell the command runs in: cmd.exe finds vp.cmd.
    const bin = path.join(root, "bin");
    const written = path.join(root, "check.json");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "vp.js"),
      `require("fs").writeFileSync(${JSON.stringify(written)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), main: process.env.${MAIN_ENV} }));\n`,
    );
    fs.writeFileSync(
      path.join(bin, "vp"),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "vp.js")}" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "vp.cmd"),
      `@"${process.execPath}" "${path.join(bin, "vp.js")}" %*\r\n`,
    );
    const pathName = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");

    execFileSync(process.execPath, [path.join(__dirname, "landing-turn.cjs"), "land"], {
      cwd: path.join(lander, "docs"),
      env: { ...process.env, [pathName]: `${bin}${path.delimiter}${process.env[pathName]}` },
      stdio: "pipe",
    });

    const ran = JSON.parse(fs.readFileSync(written, "utf8"));
    assert.equal(fs.realpathSync(ran.cwd), lander);
    assert.deepEqual(ran.args, ["run", "check:changed", main]);
    assert.equal(ran.main, main);
    assert.equal(git(origin, "rev-parse", "main"), git(lander, "rev-parse", "HEAD"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose HEAD or worktree changes while its checks run gives the turn back without pushing", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const before = git(origin, "rev-parse", "main");
    const landWith = (check) => () => land({ cwd: dir, remote: origin, runId: "lander", check });

    assert.throws(
      landWith(() => {
        commit(dir, "unchecked.txt");
        return true;
      }),
      /HEAD moved .* while the checks ran/,
    );
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    // Another branch at the checked commit is not the branch the lander was started on.
    assert.throws(
      landWith(() => {
        git(dir, "switch", "-q", "-c", "other");
        return true;
      }),
      /HEAD moved .* while the checks ran/,
    );
    git(dir, "switch", "-q", "main");
    assert.throws(
      landWith(() => {
        fs.writeFileSync(path.join(dir, "change.txt"), "rewritten\n");
        return true;
      }),
      /worktree changed while the checks ran/,
    );

    assert.equal(git(origin, "rev-parse", "main"), before);
    assert.equal(git(origin, "for-each-ref", "refs/heads/landing-lease"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lander whose checks fail gives the turn back without pushing", () => {
  const { root, origin, git, clone, commit } = setup();
  try {
    const dir = clone("lander");
    commit(dir, "change.txt");
    const before = git(origin, "rev-parse", "main");

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
