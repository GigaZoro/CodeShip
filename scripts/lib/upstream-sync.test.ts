// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A synchronous maintainer script over git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { begin, land, RUN_LIMIT_MS, status } from "./upstream-sync.ts";

const START = new Date("2026-11-16T07:00:00Z");
const later = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config can sign or ignore fixture files.
function isolateGit() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) vi.stubEnv(name, undefined);
  }
  vi.stubEnv("GIT_CONFIG_GLOBAL", NodeOS.devNull);
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

/** origin and upstream share a first commit; upstream adds `upstream.txt` unless `upToDate`. */
function fixture(options: { readonly upToDate?: boolean } = {}) {
  isolateGit();
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-")));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const path = (name: string) => NodePath.join(root, name);
  for (const bare of ["origin.git", "upstream.git"]) {
    git(root, "init", "-q", "--bare", "-b", "main", bare);
  }
  git(root, "init", "-q", "-b", "main", "seed");
  commitFiles(path("seed"), { "docs/release-notes.md": "## old\n", "shared.txt": "a\n" }, "A");
  git(path("seed"), "push", "-q", path("origin.git"), "main");
  git(path("seed"), "push", "-q", path("upstream.git"), "main");
  if (options.upToDate !== true) {
    commitFiles(path("seed"), { "upstream.txt": "upstream\n" }, "U");
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
    /** Upstream moves on after the sync merged it. */
    advanceUpstream: (files: Record<string, string>) => {
      commitFiles(path("seed"), files, "upstream later");
      git(path("seed"), "push", "-q", path("upstream.git"), "main");
    },
  };
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
    expect(land(repo.sync, later(60))).toEqual({ status: "landed", commit: repo.head() });
    expect(repo.originMain()).toBe(repo.head());
  });

  it("merges a main that moved once and asks for the checks again before landing", () => {
    const repo = fixture();
    begin(repo.sync, START);
    repo.advanceMain({ "other.txt": "other\n" });
    const moved = repo.originMain();
    expect(land(repo.sync, later(60))).toEqual({ status: "verify", base: moved });
    expect(repo.originMain()).toBe(moved);
    expect(NodeFS.readFileSync(NodePath.join(repo.sync, "other.txt"), "utf8")).toBe("other\n");
    expect(land(repo.sync, later(120))).toEqual({ status: "landed", commit: repo.head() });
  });

  it("holds without merging when main conflicts with the sync, naming the files", () => {
    const repo = fixture();
    begin(repo.sync, START);
    const synced = repo.head();
    repo.advanceMain({ "upstream.txt": "ours\n" });
    const main = repo.originMain();
    expect(land(repo.sync, later(60))).toEqual({
      status: "hold",
      reason: "conflicts",
      conflicts: ["upstream.txt"],
    });
    expect(repo.head()).toBe(synced);
    expect(git(repo.sync, "status", "--porcelain")).toBe("");
    expect(repo.originMain()).toBe(main);
    expect(status(repo.sync, later(60)).mergesLeft).toBe(1);
  });

  it("keeps the sync's release notes above main's new ones, dated no older than main's", () => {
    const repo = fixture();
    begin(repo.sync, START);
    const sync = "## 2026-11-19 — Newer\n\n- a\n\n## 2026-11-16 — Older\n\n- b\n\n";
    commitFiles(repo.sync, { "docs/release-notes.md": `${sync}## old\n` }, "notes");
    repo.advanceMain({ "docs/release-notes.md": "## 2026-11-18 — Main\n\n- c\n\n## old\n" });
    expect(land(repo.sync, later(60))).toMatchObject({ status: "verify" });
    expect(NodeFS.readFileSync(NodePath.join(repo.sync, "docs/release-notes.md"), "utf8")).toBe(
      "## 2026-11-19 — Newer\n\n- a\n\n## 2026-11-18 — Older\n\n- b\n\n## 2026-11-18 — Main\n\n- c\n\n## old\n",
    );
  });

  it("holds when re-dating the sync's release notes would repeat a heading main has", () => {
    const repo = fixture();
    begin(repo.sync, START);
    commitFiles(
      repo.sync,
      { "docs/release-notes.md": "## 2026-11-16 — Updates\n\n- a\n\n## old\n" },
      "notes",
    );
    const synced = repo.head();
    repo.advanceMain({ "docs/release-notes.md": "## 2026-11-18 — Updates\n\n- b\n\n## old\n" });
    expect(land(repo.sync, later(60))).toEqual({
      status: "hold",
      reason: "conflicts",
      conflicts: ["docs/release-notes.md"],
    });
    expect(repo.head()).toBe(synced);
  });

  it("holds after three merges while main keeps moving", () => {
    const repo = fixture();
    begin(repo.sync, START);
    for (const [index, minutes] of [30, 60].entries()) {
      repo.advanceMain({ [`main-${index}.txt`]: "main\n" });
      expect(land(repo.sync, later(minutes))).toMatchObject({ status: "verify" });
    }
    repo.advanceMain({ "main-last.txt": "main\n" });
    const main = repo.originMain();
    expect(land(repo.sync, later(90))).toEqual({
      status: "hold",
      reason: "merge-limit",
      conflicts: [],
    });
    expect(repo.originMain()).toBe(main);
  });

  it("starts new bounds on a held branch, keeping the upstream it merged when upstream moved on", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    const merged = git(repo.sync, "rev-parse", "upstream/main");
    repo.advanceUpstream({ "upstream-later.txt": "later\n" });
    const followUp = NodePath.join(NodePath.dirname(repo.sync), "follow-up");
    git(repo.sync, "worktree", "add", "-q", followUp, "-b", "follow-up", "sync/upstream-x");
    expect(begin(followUp, later(600))).toEqual({
      status: "resumed",
      base: frozen,
      upstream: merged,
      conflicts: [],
    });
    expect(git(followUp, "rev-parse", "HEAD")).toBe(repo.head());
    expect(status(followUp, later(600))).toMatchObject({ mergesLeft: 3, minutesLeft: 180 });
    expect(land(followUp, later(610))).toEqual({ status: "landed", commit: repo.head() });
  });

  /** A sync whose land held on a conflict with main, and a worktree of its branch to resume it in. */
  function heldOnMain() {
    const repo = fixture();
    begin(repo.sync, START);
    commitFiles(
      repo.sync,
      { "docs/release-notes.md": "## 2026-11-16 — Sync\n\n- a\n\n## old\n" },
      "notes",
    );
    repo.advanceMain({
      "upstream.txt": "ours\n",
      "docs/release-notes.md": "## 2026-11-18 — Main\n\n- b\n\n## old\n",
    });
    expect(land(repo.sync, later(60))).toMatchObject({ status: "hold", reason: "conflicts" });
    const followUp = NodePath.join(NodePath.dirname(repo.sync), "follow-up");
    git(repo.sync, "worktree", "add", "-q", followUp, "-b", "follow-up", "sync/upstream-x");
    return { repo, followUp };
  }

  it("merges the main a held branch conflicted with when it resumes, leaving only the real conflicts", () => {
    const { repo, followUp } = heldOnMain();
    // Only begin's own fetch sees this commit; land's fetch before the hold did not.
    repo.advanceMain({ "later.txt": "later\n" });
    const main = repo.originMain();
    expect(begin(followUp, later(600))).toEqual({
      status: "resumed",
      base: main,
      upstream: git(followUp, "rev-parse", "upstream/main"),
      conflicts: ["upstream.txt"],
    });
    expect(NodeFS.readFileSync(NodePath.join(followUp, "docs/release-notes.md"), "utf8")).toBe(
      "## 2026-11-18 — Sync\n\n- a\n\n## 2026-11-18 — Main\n\n- b\n\n## old\n",
    );
    commitFiles(followUp, { "upstream.txt": "resolved\n" }, "resolve");
    expect(status(followUp, later(600)).mergesLeft).toBe(2);
    const resolved = git(followUp, "rev-parse", "HEAD");
    expect(land(followUp, later(610))).toEqual({ status: "landed", commit: resolved });
    expect(repo.originMain()).toBe(resolved);
  });

  it("merges main again instead of pushing when the chat aborted the merge begin left to resolve", () => {
    const { repo, followUp } = heldOnMain();
    const main = repo.originMain();
    expect(begin(followUp, later(600))).toMatchObject({ base: main, conflicts: ["upstream.txt"] });
    git(followUp, "merge", "--abort");
    const aborted = git(followUp, "rev-parse", "HEAD");
    expect(land(followUp, later(610))).toMatchObject({ status: "hold", reason: "conflicts" });
    expect(git(followUp, "rev-parse", "HEAD")).toBe(aborted);
    expect(repo.originMain()).toBe(main);
    expect(status(followUp, later(610)).mergesLeft).toBe(1);
  });

  it("holds once three hours have passed, even when it could land", () => {
    const repo = fixture();
    const frozen = repo.originMain();
    begin(repo.sync, START);
    const deadline = new Date(START.getTime() + RUN_LIMIT_MS);
    expect(status(repo.sync, later(170)).minutesLeft).toBe(10);
    expect(land(repo.sync, deadline)).toEqual({
      status: "hold",
      reason: "time-limit",
      conflicts: [],
    });
    expect(repo.originMain()).toBe(frozen);
  });
});
