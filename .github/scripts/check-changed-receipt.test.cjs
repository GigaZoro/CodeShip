const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { recordPass, requirePass, workingTree } = require("./check-changed-receipt.cjs");
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
  const push = () =>
    spawnSync("git", ["push", "origin", "main"], {
      cwd: work,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, [TURN_ENV]: turn },
    });
  return { work, git, write, commit, push, base };
};

const withRoot = (run) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "check-changed-receipt-")));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test("main refuses a push until check:changed passed for the exact tree it pushes", () =>
  withRoot((root) => {
    const { work, write, commit, push, base } = fixture(root);
    write("docs/release-notes.md", `${SECOND_NOTE}\n${FIRST_NOTE}`);
    write("app.txt", "two\n");
    write("helper.txt", "read by app.txt\n");
    commit("docs/release-notes.md", "app.txt");

    const unchecked = push();
    assert.notEqual(unchecked.status, 0);
    assert.match(unchecked.stderr, /check:changed` has not passed/);

    // The pass covered helper.txt while it was untracked, so it does not describe a commit without it.
    recordPass(work, workingTree(work), base);
    assert.notEqual(push().status, 0);

    commit("helper.txt");
    const checked = push();
    assert.equal(checked.status, 0, checked.stderr);
  }));

test("computing the working tree writes no objects to the repository", () =>
  withRoot((root) => {
    const { work, git, write } = fixture(root);
    write("app.txt", "edited but never committed\n");
    write("untracked.txt", "new\n");
    const before = git("count-objects", "-v");
    const tree = workingTree(work);
    assert.equal(git("count-objects", "-v"), before);
    // The id is what a commit of this tree would get.
    git("add", "--all");
    assert.equal(git("write-tree"), tree);

    // An edit of the same size in the second git wrote the index, which only content shows. Times are set, and ctime,
    // which cannot be, is not compared, so the edit and the index share their second on any machine.
    git("config", "core.trustctime", "false");
    const second = 1_600_000_000;
    const app = path.join(work, "app.txt");
    write("app.txt", "staged\n");
    fs.utimesSync(app, second, second);
    git("add", "app.txt");
    write("app.txt", "edited\n");
    fs.utimesSync(app, second, second);
    const index = git("rev-parse", "--path-format=absolute", "--git-path", "index");
    fs.utimesSync(index, second, second);
    const racy = workingTree(work);
    git("add", "--all");
    assert.equal(git("write-tree"), racy);
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
    const { work, git, write } = fixture(root);
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git("update-index", flag, "app.txt");
      write("app.txt", "edited behind the mark\n");
      assert.throws(() => workingTree(work), /app\.txt/);
      git("update-index", flag.replace("--", "--no-"), "app.txt");
      git("checkout", "--", "app.txt");
    }
  }));
