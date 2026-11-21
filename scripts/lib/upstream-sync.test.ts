// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A synchronous maintainer script over git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { recordPass } from "../../.github/scripts/check-changed-receipt.cjs";
import { begin, checkCommand, land, recordCheck, RUN_LIMIT_MS, status } from "./upstream-sync.ts";

const START = new Date("2026-11-16T07:00:00Z");
// The repository's merge driver, which keeps release notes in date order in every fixture merge.
const NOTES_DRIVER = {
  ".gitattributes": "docs/release-notes.md merge=release-notes\n",
  ...Object.fromEntries(
    ["release-notes.cjs", "git-history.cjs"].map((script) => [
      `.github/scripts/${script}`,
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "../../.github/scripts", script),
        "utf8",
      ),
    ]),
  ),
};
/** Release notes with one bullet per `YYYY-MM-DD — Title` entry. */
const notes = (...entries: Array<string>) =>
  entries.map((entry) => `## ${entry}\n\n- ${entry.split(" — ")[1]}\n`).join("\n");
const later = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config can sign or ignore fixture files.
// Git for Windows maps /dev/null to its null device but cannot open NodeOS.devNull (\\.\nul).
function isolateGit() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_AUTHOR_NAME", "Fixture");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "fixture@example.invalid");
  vi.stubEnv("GIT_COMMITTER_NAME", "Fixture");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "fixture@example.invalid");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commitFiles(cwd: string, files: Record<string, string>, message: string) {
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", message);
}

/** origin and upstream share a first commit, with `seed` in it; upstream adds `upstream` (`upstream.txt`) unless `upToDate`. */
function fixture(
  options: {
    readonly upToDate?: boolean;
    readonly seed?: Record<string, string>;
    readonly upstream?: Record<string, string>;
  } = {},
) {
  isolateGit();
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-")));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const path = (name: string) => NodePath.join(root, name);
  for (const bare of ["origin.git", "upstream.git"]) {
    git(root, "init", "-q", "--bare", "-b", "main", bare);
  }
  git(root, "init", "-q", "-b", "main", "seed");
  commitFiles(
    path("seed"),
    {
      ...NOTES_DRIVER,
      "docs/release-notes.md": notes("2026-11-01 — Old"),
      "shared.txt": "a\n",
      ...options.seed,
    },
    "A",
  );
  git(path("seed"), "push", "-q", path("origin.git"), "main");
  git(path("seed"), "push", "-q", path("upstream.git"), "main");
  if (options.upToDate !== true) {
    commitFiles(path("seed"), options.upstream ?? { "upstream.txt": "upstream\n" }, "U");
    git(path("seed"), "push", "-q", path("upstream.git"), "main");
  }
  git(root, "clone", "-q", path("origin.git"), "checkout");
  git(path("checkout"), "remote", "add", "upstream", path("upstream.git"));
  git(
    path("checkout"),
    "worktree",
    "add",
    "-q",
    path("sync"),
    "-b",
    "sync/upstream-x",
    "origin/main",
  );
  git(root, "clone", "-q", path("origin.git"), "dev");
  const sync = path("sync");
  return {
    sync,
    originMain: () => git(path("origin.git"), "rev-parse", "main"),
    head: () => git(sync, "rev-parse", "HEAD"),
    /** Another change lands on main while the sync runs. */
    advanceMain: (files: Record<string, string>) => {
      git(path("dev"), "pull", "-q", "--ff-only");
      commitFiles(path("dev"), files, "elsewhere");
      git(path("dev"), "push", "-q", "origin", "main");
    },
  };
}

/** The receipt check:changed records when it passes for `covers`. */
function recordReceipt(worktree: string, covers: ReturnType<typeof checkCommand>["covers"]) {
  recordPass(worktree, git(worktree, "rev-parse", `${covers.commit}^{tree}`), covers.base);
}

/** Step 7a passes for the checkout as it is. */
function passCheck(worktree: string) {
  const { covers } = checkCommand(worktree, {});
  recordReceipt(worktree, covers);
  recordCheck(worktree, covers);
}

/** Step 8's answer to `verify`: the sync branch fast-forwards to the merge `land` made. */
function fastForward(worktree: string, result: ReturnType<typeof land>): string {
  if (result.status !== "verify") throw new Error(`land answered ${result.status}, not verify`);
  git(worktree, "merge", "-q", "--ff-only", result.commit);
  return result.commit;
}

describe("upstream sync", () => {
  it("does nothing when main already has upstream", () => {
    const repo = fixture({ upToDate: true });
    expect(begin(repo.sync, START)).toMatchObject({ status: "up-to-date" });
  });

  it("merges upstream into the frozen base and lands it while main has not moved", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    expect(begin(repo.sync, START)).toMatchObject({ status: "merged", base: frozen });
    passCheck(repo.sync);
    expect(land(repo.sync, later(60))).toEqual({ status: "landed", commit: repo.head() });
    expect(repo.originMain()).toBe(repo.head());
  });

  it("merges a main that moved into the checked commit without moving the checkout, and lands the merge once the sync fast-forwards to it and checks it", () => {
    const repo = fixture();
    begin(repo.sync, START);
    passCheck(repo.sync);
    const checked = repo.head();
    repo.advanceMain({ "other.txt": "other\n" });
    const moved = repo.originMain();
    const result = land(repo.sync, later(60));
    expect(result).toMatchObject({ status: "verify", base: moved });
    expect([repo.head(), NodeFS.existsSync(NodePath.join(repo.sync, "other.txt"))]).toEqual([
      checked,
      false,
    ]);
    expect(land(repo.sync, later(90))).toEqual({
      status: "unchecked",
      head: checked,
      checked: null,
    });
    const merge = fastForward(repo.sync, result);
    expect([
      git(repo.sync, "rev-parse", "HEAD", "HEAD^1", "HEAD^2"),
      status(repo.sync, later(90)).attempts.at(-1),
      repo.originMain(),
    ]).toMatchObject([[merge, checked, moved].join("\n"), { commit: moved, merge }, moved]);
    passCheck(repo.sync);
    expect(land(repo.sync, later(120))).toEqual({ status: "landed", commit: repo.head() });
  });

  it("asks for the checks against a main the checked commit already holds, without merging", () => {
    const repo = fixture();
    begin(repo.sync, START);
    repo.advanceMain({ "other.txt": "other\n" });
    git(repo.sync, "fetch", "-q", "origin");
    git(repo.sync, "merge", "-q", "--no-ff", "origin/main", "-m", "main by hand");
    const checked = repo.head();
    passCheck(repo.sync);
    expect(land(repo.sync, later(60))).toEqual({
      status: "verify",
      base: repo.originMain(),
      commit: checked,
    });
    expect(repo.head()).toBe(checked);
  });

  it.each([
    { report: "a short conflict report", paths: [] },
    // merge-tree names each conflict's path five times, so these take its report to 1.4 MB, past spawnSync's 1 MiB
    // default.
    {
      report: "a conflict report past 1 MiB",
      paths: Array.from(
        { length: 1500 },
        (_, index) => `conflicts/${String(index).padStart(4, "0")}-${"x".repeat(150)}.txt`,
      ),
    },
  ])(
    "holds without merging when main conflicts with the sync, naming the files from $report",
    ({ paths }) => {
      const both = (content: string) =>
        Object.fromEntries(["upstream.txt", ...paths].map((file) => [file, content]));
      const repo = fixture({ upstream: both("upstream\n") });
      begin(repo.sync, START);
      passCheck(repo.sync);
      const synced = repo.head();
      repo.advanceMain(both("ours\n"));
      const main = repo.originMain();
      expect(land(repo.sync, later(60))).toEqual({
        status: "hold",
        reason: "conflicts",
        conflicts: [...paths, "upstream.txt"],
      });
      expect(repo.head()).toBe(synced);
      expect(git(repo.sync, "status", "--porcelain")).toBe("");
      expect(repo.originMain()).toBe(main);
      expect(status(repo.sync, later(60)).mergesLeft).toBe(1);
    },
  );

  it.each([
    {
      when: "above main's of the same date",
      sync: "2026-11-21 — Sync",
      main: "2026-11-21 — Main",
      merged: ["2026-11-21 — Sync", "2026-11-21 — Main"],
    },
    {
      when: "below main's newer ones",
      sync: "2026-11-15 — Sync",
      main: "2026-11-21 — Main",
      merged: ["2026-11-21 — Main", "2026-11-15 — Sync"],
    },
  ])("merges the sync's release notes $when", ({ sync, main, merged }) => {
    const repo = fixture();
    begin(repo.sync, START);
    commitFiles(repo.sync, { "docs/release-notes.md": notes(sync, "2026-11-01 — Old") }, "notes");
    passCheck(repo.sync);
    repo.advanceMain({ "docs/release-notes.md": notes(main, "2026-11-01 — Old") });
    fastForward(repo.sync, land(repo.sync, later(60)));
    expect(NodeFS.readFileSync(NodePath.join(repo.sync, "docs/release-notes.md"), "utf8")).toBe(
      notes(...merged, "2026-11-01 — Old"),
    );
  });

  it("refuses to merge main where a local rule keeps the release notes from their driver", () => {
    const repo = fixture();
    begin(repo.sync, START);
    passCheck(repo.sync);
    repo.advanceMain({ "main.txt": "main\n" });
    const rules = git(
      repo.sync,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/attributes",
    );
    NodeFS.mkdirSync(NodePath.dirname(rules), { recursive: true });
    NodeFS.writeFileSync(rules, "docs/release-notes.md merge=text\n");
    expect(() => land(repo.sync, later(60))).toThrow("instead of its driver");
    expect(status(repo.sync, later(60)).mergesLeft).toBe(2);
  });

  it("holds when merging main leaves a decision Git names only in its messages", () => {
    const repo = fixture({ seed: { "z/b": "b\n", "z/c": "c\n" } });
    begin(repo.sync, START);
    git(repo.sync, "rm", "-q", "-r", "z");
    commitFiles(repo.sync, { "y/b": "b\n", "w/c": "c\n" }, "split z");
    passCheck(repo.sync);
    const checked = repo.head();
    repo.advanceMain({ "z/d": "d\n" });
    expect(land(repo.sync, later(60))).toEqual({
      status: "hold",
      reason: "conflicts",
      conflicts: ["z"],
    });
    expect(repo.head()).toBe(checked);
  });

  it("holds after three merges while main keeps moving", () => {
    const repo = fixture();
    begin(repo.sync, START);
    for (const [index, minutes] of [30, 60].entries()) {
      passCheck(repo.sync);
      repo.advanceMain({ [`main-${index}.txt`]: "main\n" });
      fastForward(repo.sync, land(repo.sync, later(minutes)));
    }
    passCheck(repo.sync);
    repo.advanceMain({ "main-last.txt": "main\n" });
    const main = repo.originMain();
    expect(land(repo.sync, later(90))).toEqual({
      status: "hold",
      reason: "merge-limit",
      conflicts: [],
    });
    expect(repo.originMain()).toBe(main);
  });

  it("starts new bounds on a held branch that already has upstream merged", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    const followUp = NodePath.join(NodePath.dirname(repo.sync), "follow-up");
    git(repo.sync, "worktree", "add", "-q", followUp, "-b", "follow-up", "sync/upstream-x");
    expect(begin(followUp, later(600))).toEqual({
      status: "resumed",
      base: frozen,
      upstream: git(repo.sync, "rev-parse", "upstream/main"),
      conflicts: [],
    });
    expect(status(followUp, later(600))).toMatchObject({ mergesLeft: 3, minutesLeft: 180 });
    passCheck(followUp);
    expect(land(followUp, later(610))).toEqual({ status: "landed", commit: repo.head() });
  });

  it("checks against the base in the run's state, which moves with each merged main, and records only a pass the push gate takes", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    expect(checkCommand(repo.sync, {})).toEqual({
      args: ["run", "check:changed", frozen],
      env: { CHECK_CHANGED_TIMEOUT: "3600" },
      covers: { commit: repo.head(), base: frozen },
    });
    expect(() => recordCheck(repo.sync, checkCommand(repo.sync, {}).covers)).toThrow(
      "no pass the push gate takes",
    );
    passCheck(repo.sync);
    expect(status(repo.sync, later(30)).checked).toBe(repo.head());
    repo.advanceMain({ "other.txt": "other\n" });
    const result = land(repo.sync, later(60));
    expect(status(repo.sync, later(60)).checked).toBeNull();
    expect(() => checkCommand(repo.sync, {})).toThrow("does not hold the run's base");
    fastForward(repo.sync, result);
    expect(checkCommand(repo.sync, { CHECK_CHANGED_TIMEOUT: "60" })).toEqual({
      args: ["run", "check:changed", repo.originMain()],
      env: { CHECK_CHANGED_TIMEOUT: "60" },
      covers: { commit: repo.head(), base: repo.originMain() },
    });
  });

  it("holds once three hours have passed, even when it could land", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    passCheck(repo.sync);
    const deadline = new Date(START.getTime() + RUN_LIMIT_MS);
    expect(status(repo.sync, later(170)).minutesLeft).toBe(10);
    expect(land(repo.sync, deadline)).toEqual({
      status: "hold",
      reason: "time-limit",
      conflicts: [],
    });
    expect(repo.originMain()).toBe(frozen);
  });

  it("reports a landing whose push reply was lost as landed, past the time limit too", () => {
    const repo = fixture();
    begin(repo.sync, START);
    passCheck(repo.sync);
    git(repo.sync, "push", "-q", "origin", "HEAD:main");
    expect(land(repo.sync, new Date(START.getTime() + RUN_LIMIT_MS + 60_000))).toEqual({
      status: "landed",
      commit: repo.head(),
    });
  });

  it("reports the checked commit as landed when its checkout moves during a push whose reply was lost", () => {
    const repo = fixture();
    begin(repo.sync, START);
    passCheck(repo.sync);
    const merged = repo.head();
    const lostReply = ({ head }: { readonly head: string }) => {
      git(repo.sync, "push", "-q", "origin", `${head}:main`);
      git(repo.sync, "reset", "-q", "--hard", "HEAD~1");
      throw new Error("the push's reply was lost");
    };
    expect(land(repo.sync, later(60), lostReply)).toEqual({ status: "landed", commit: merged });
  });

  it("lands only the commit the checks passed for, not a checkout that left it for a commit main holds", () => {
    const repo = fixture();
    begin(repo.sync, START);
    const synced = repo.head();
    commitFiles(repo.sync, { "fix.txt": "fix\n" }, "fix");
    passCheck(repo.sync);
    const checked = repo.head();
    git(repo.sync, "push", "-q", "origin", `${synced}:main`);
    git(repo.sync, "reset", "-q", "--hard", synced);
    expect(land(repo.sync, later(60))).toEqual({ status: "unchecked", head: synced, checked });
    const during = checkCommand(repo.sync, {}).covers;
    recordReceipt(repo.sync, during);
    commitFiles(repo.sync, { "late.txt": "late\n" }, "late");
    expect(() => recordCheck(repo.sync, during)).toThrow("during the check");
    expect(status(repo.sync, later(60)).checked).toBe(checked);
  });

  it("reports a checkout that leaves the checked commit while it lands, and neither pushes it nor merges main into it", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    passCheck(repo.sync);
    const checked = repo.head();
    const moveCheckout = () => {
      git(repo.sync, "reset", "-q", "--hard", frozen);
      throw new Error("the checkout moved off");
    };
    // Main moved too, so a merge of the checked commit would be offered for a checkout that left it.
    const switchedWhileMainMoved = () => {
      repo.advanceMain({ "elsewhere.txt": "elsewhere\n" });
      git(repo.sync, "switch", "-q", "-c", "topic", frozen);
      throw new Error("the checkout moved off");
    };
    for (const push of [moveCheckout, switchedWhileMainMoved]) {
      git(repo.sync, "reset", "-q", "--hard", checked);
      expect(land(repo.sync, later(60), push)).toEqual({
        status: "unchecked",
        head: frozen,
        checked,
      });
    }
    expect([
      git(repo.sync, "rev-parse", "topic"),
      git(repo.sync, "rev-parse", "sync/upstream-x"),
      status(repo.sync, later(60)).attempts.length,
    ]).toEqual([frozen, checked, 1]);
  });

  it("refuses to check a checkout without the upstream merge, such as main or a commit with its tree on main", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    const sibling = git(repo.sync, "commit-tree", "HEAD^{tree}", "-p", frozen, "-m", "same tree");
    for (const commit of [frozen, sibling]) {
      git(repo.sync, "reset", "-q", "--hard", commit);
      expect(() => checkCommand(repo.sync, {})).toThrow("does not hold upstream");
    }
    expect(land(repo.sync, later(60))).toEqual({
      status: "unchecked",
      head: sibling,
      checked: null,
    });
    expect(repo.originMain()).toBe(frozen);
  });

  it("refuses to check or land a worktree with untracked files or files marked assume-unchanged", () => {
    const repo = fixture();
    begin(repo.sync, START);
    passCheck(repo.sync);
    git(repo.sync, "config", "status.showUntrackedFiles", "no");
    NodeFS.writeFileSync(NodePath.join(repo.sync, "untracked.txt"), "new\n");
    expect(() => checkCommand(repo.sync, {})).toThrow("untracked files included");
    expect(() => land(repo.sync, later(60))).toThrow("untracked files included");
    NodeFS.rmSync(NodePath.join(repo.sync, "untracked.txt"));
    git(repo.sync, "update-index", "--assume-unchanged", "shared.txt");
    expect(() => checkCommand(repo.sync, {})).toThrow("untracked files included");
    expect(() => land(repo.sync, later(60))).toThrow("untracked files included");
  });
});
