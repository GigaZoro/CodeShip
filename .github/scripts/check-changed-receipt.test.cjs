const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  alternateObjectDirectory,
  recordPass,
  requirePass,
  workingTree,
} = require("./check-changed-receipt.cjs");
const { TURN_ENV, tryAcquire } = require("./landing-turn.cjs");

const repoRoot = path.resolve(__dirname, "../..");
const FIRST_NOTE = "## 2026-11-14 — First\n\n- First.\n";
const SECOND_NOTE = "## 2026-11-15 — Second\n\n- Second.\n";

// The receipt module and the hook run git themselves, apart from the caller's: a hook exports GIT_DIR and
// GIT_INDEX_FILE, and a runner may have no identity. Git for Windows opens /dev/null, not os.devNull (\\.\nul).
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

// A checkout with this repository's pre-push hook and the scripts it runs, whose main is on a bare remote.
// `push` pushes main holding the landing turn, so only the check:changed pass decides.
const fixture = (root) => {
  const work = path.join(root, "work");
  const git = (...args) =>
    execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: "pipe" }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), text);
  };
  const commit = (...files) => {
    git("add", "--", ...files);
    git("-c", "core.hooksPath=", "commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  execFileSync("git", ["init", "--bare", "remote.git"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", "work"], { cwd: root, stdio: "pipe" });
  for (const file of [
    ".vite-hooks/pre-push",
    ".github/scripts/release-notes.cjs",
    ".github/scripts/git-history.cjs",
    ".github/scripts/check-changed-receipt.cjs",
    ".github/scripts/landing-turn.cjs",
    ".github/scripts/lease-queue.cjs",
  ]) {
    write(file, fs.readFileSync(path.join(repoRoot, file), "utf8"));
  }
  fs.chmodSync(path.join(work, ".vite-hooks/pre-push"), 0o755);
  write("docs/release-notes.md", FIRST_NOTE);
  write("app.txt", "one\n");
  git("add", "--chmod=+x", ".vite-hooks/pre-push");
  const base = commit(".");
  git("remote", "add", "origin", path.join(root, "remote.git"));
  git("push", "origin", "main");
  git("config", "core.hooksPath", ".vite-hooks");
  const turn = tryAcquire({ cwd: work, remote: "origin", runId: "fixture" });
  const push = (refspec = "main", env = { [TURN_ENV]: turn }) =>
    spawnSync("git", ["push", "origin", refspec], {
      cwd: work,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
  // workingTree's scratch object directory, which reads of its tree name as an alternate.
  const objects = path.join(root, "objects");
  fs.mkdirSync(objects);
  const show = (object) =>
    execFileSync("git", ["cat-file", "-p", object], {
      cwd: work,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectory(objects) },
    }).trim();
  return { work, git, write, commit, push, base, objects, show };
};

const withRoot = (run) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-receipt-")));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test("reads the working tree where the checkout and scratch objects hold the path delimiter", () =>
  withRoot((root) => {
    // Windows, whose delimiter is `;`, forbids `"` in a name; there its root's backslashes are escaped.
    const named = path.join(root, path.delimiter === ";" ? "a;b" : 'a:"b');
    fs.mkdirSync(named);
    const { write, objects, show, work } = fixture(named);
    write("app.txt", "two\n");
    assert.equal(show(`${workingTree(work, objects)}:app.txt`), "two");
  }));

test("main refuses a push until check:changed passed for the exact tree it pushes", () =>
  withRoot((root) => {
    const { work, write, commit, push, base, objects } = fixture(root);
    write("docs/release-notes.md", `${SECOND_NOTE}\n${FIRST_NOTE}`);
    write("app.txt", "two\n");
    write("helper.txt", "read by app.txt\n");
    commit("docs/release-notes.md", "app.txt");

    const unchecked = push();
    assert.notEqual(unchecked.status, 0);
    assert.match(unchecked.stderr, /check:changed` has not passed/);
    // Git gives the hook a source revision as it was typed, spaces included.
    const spelled = push("HEAD^{/fixtur[e ]}:refs/heads/main");
    assert.notEqual(spelled.status, 0);
    assert.match(spelled.stderr, /check:changed` has not passed/);

    // The pass covered helper.txt while it was untracked, so it does not describe a commit without it.
    recordPass(work, workingTree(work, objects), base);
    assert.notEqual(push().status, 0);

    commit("helper.txt");
    // With the pass recorded, only the landing turn refuses the spelled source.
    const unturned = push("HEAD^{/fixtur[e ]}:refs/heads/main", { [TURN_ENV]: undefined });
    assert.notEqual(unturned.status, 0);
    assert.match(unturned.stderr, /needs the landing turn/);
    const checked = push();
    assert.equal(checked.status, 0, checked.stderr);
  }));

test("computing the working tree writes no objects to the repository", () =>
  withRoot((root) => {
    const { work, git, write, objects } = fixture(root);
    write("app.txt", "edited but never committed\n");
    write("untracked.txt", "new\n");
    const before = git("count-objects", "-v");
    const tree = workingTree(work, objects);
    assert.equal(git("count-objects", "-v"), before);
    // The id is what a commit of this tree would get.
    git("add", "--all");
    assert.equal(git("write-tree"), tree);
  }));

test("the working tree is computed when git add warns about each file, past 1 MiB in all", () =>
  withRoot((root) => {
    const { work, git, write, objects } = fixture(root);
    // With autocrlf, add warns about each file with LF line ends in its working copy.
    git("config", "core.autocrlf", "true");
    for (let index = 0; index < 5000; index += 1) {
      write(`lf/${String(index).padStart(4, "0")}-${"x".repeat(140)}.txt`, "lf\n");
    }
    const tree = workingTree(work, objects);
    git("-c", "core.safecrlf=false", "add", "--all");
    assert.equal(git("write-tree"), tree);
  }));

test("the checked tree holds a same-size edit made in the second the index was written", (t) =>
  withRoot((root) => {
    const { work, git, write, objects, show } = fixture(root);
    // Whole-second stats without ctime let the edit below match the index's cached stat, as a
    // same-size edit in the index's second does.
    git("config", "core.checkStat", "minimal");
    git("config", "core.trustctime", "false");
    const stamp = (file) => fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    const app = path.join(work, "app.txt");
    stamp(app);
    git("add", "app.txt");
    const index = git("rev-parse", "--path-format=absolute", "--git-path", "index");
    stamp(index);
    write("app.txt", "two\n");
    stamp(app);
    assert.equal(show(`${workingTree(work, objects)}:app.txt`), "two");

    // Node cannot set this time: the index's second, whose milliseconds round up to the next one.
    const statSync = fs.statSync;
    t.mock.method(fs, "statSync", (file, options) =>
      file !== index
        ? statSync(file, options)
        : options?.bigint
          ? { mtimeNs: 1_700_000_000_999_999_999n, mtimeMs: 1_700_000_000_999n }
          : { mtimeMs: 1_700_000_001_000 },
    );
    write("app.txt", "six\n");
    stamp(app);
    assert.equal(show(`${workingTree(work, objects)}:app.txt`), "six");
  }));

test("a pass covers the push only when it compared against the commit main is at", () =>
  withRoot((root) => {
    const { work, git, write, commit, base } = fixture(root);
    write("app.txt", "two\n");
    const main = commit("app.txt");
    git("-c", "core.hooksPath=", "push", "origin", "main");
    write("app.txt", "one\n");
    const head = commit("app.txt");
    const tree = git("rev-parse", "HEAD^{tree}");

    // `vp run check:changed HEAD` on a clean tree sees no changes and still passes.
    recordPass(work, tree, head);
    // Against an older main the diff misses app.txt: main changed it and this commit changes it back.
    recordPass(work, tree, base);
    assert.throws(() => requirePass(work, head, main), /not main's current commit/);

    recordPass(work, tree, main);
    requirePass(work, head, main);
  }));

test("a pass is never recorded for a tree computed while files are marked assume-unchanged or skip-worktree", () =>
  withRoot((root) => {
    const { work, git, write, objects } = fixture(root);
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git("update-index", flag, "app.txt");
      write("app.txt", "edited behind the mark\n");
      assert.throws(() => workingTree(work, objects), /app\.txt/);
      git("update-index", flag.replace("--", "--no-"), "app.txt");
      git("checkout", "--", "app.txt");
    }
  }));

test("a push that moves only the landing lease or a topic passes the hook from a working tree whose scripts do not load", () =>
  withRoot((root) => {
    const { git, write, commit, push } = fixture(root);
    write(".github/scripts/landing-turn.cjs", "<<<<<<< a rebase stopped here\n");
    // Only the pushed ref decides, not a source revision that names main.
    git("-c", "core.hooksPath=", "commit", "--allow-empty", "-m", "names refs/heads/main once");
    const topic = push("HEAD^{/ refs/heads/main }:refs/heads/topic", {});
    assert.equal(topic.status, 0, topic.stderr);
    write("app.txt", "two\n");
    commit("app.txt");
    const toMain = push();
    assert.notEqual(toMain.status, 0);
    assert.match(toMain.stderr, /SyntaxError/);

    git("push", "origin", ":refs/heads/landing-lease/main");
    assert.equal(git("ls-remote", "origin", "refs/heads/landing-lease/main"), "");
  }));
