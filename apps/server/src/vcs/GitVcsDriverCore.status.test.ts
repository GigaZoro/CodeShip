// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

it.layer(layerTest)("Git repository status", (it) => {
  it.effect("keeps large change sets available for status and commit preparation", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      const files = Array.from(
        { length: 6_000 },
        (_, index) => `file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
      );
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "before\n"), {
        concurrency: 16,
        discard: true,
      });
      yield* git(cwd, ["add", "."]);
      const unborn = yield* driver.statusDetailsLocal(cwd);
      assert.lengthOf(unborn.workingTree.files, files.length);
      assert.equal(unborn.workingTree.insertions, files.length);
      const initial = yield* driver.commit(cwd, "initial", "");
      assert.match(initial.commitSha, /^[a-f0-9]{40}$/);
      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasWorkingTreeChanges);
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "after\n"), {
        concurrency: 16,
        discard: true,
      });
      const status = yield* driver.statusDetailsLocal(cwd);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.lengthOf(status.workingTree.files, files.length);
      assert.equal(status.workingTree.insertions, files.length);
      assert.equal(status.workingTree.deletions, files.length);
      const context = yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false });
      assert.isNotNull(context);
      assert.isAbove(context!.stagedSummary.length, 1_000_000);
      assert.lengthOf(context!.stagedSummary.split("\n"), files.length);
    }),
  );

  it.effect("reads the current branch by name when a tag shares it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "release"]);
      yield* git(cwd, ["tag", "release"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
      assert.equal(remoteStatus.branch, "release");
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const branchRange = preview.sources.find((source) => source.kind === "branch-range");
      assert.equal(branchRange?.headRef, "release");
    }),
  );

  it.effect("counts unmerged work, and fails rather than reads 0 when a ref probe breaks", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const pathService = yield* Path.Path;
      // A repository with no base to compare with may itself be on the default branch.
      assert.equal(yield* driver.countUnmergedCommits({ cwd }), 0);

      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature work"]);
      assert.equal(yield* driver.countUnmergedCommits({ cwd }), 1);

      // Git exits 128 for the missing loose `main` once packed-refs is unreadable; that is not absence.
      yield* git(cwd, ["pack-refs", "--all"]);
      yield* writeTextFile(pathService.join(cwd, ".git"), "packed-refs", "garbage line\n");
      const exit = yield* Effect.exit(driver.countUnmergedCommits({ cwd }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("counts a commit as merged only when the base holds the same change", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      // A detached HEAD falls back to main, whatever init.defaultBranch says.
      const base = "main";
      yield* git(cwd, ["branch", "-M", base]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const commitFile = (name: string, contents: string) =>
        Effect.gen(function* () {
          yield* writeTextFile(cwd, name, contents);
          yield* git(cwd, ["add", name]);
          yield* git(cwd, ["commit", "-m", name]);
        });
      yield* commitFile("code.py", "def f():\n  return 1\n");

      yield* git(cwd, ["switch", "-c", "feature"]);
      yield* commitFile("picked.txt", "picked\n");
      // The base moves first, so the pick gets a SHA of its own.
      yield* git(cwd, ["switch", base]);
      yield* commitFile("other.txt", "other\n");
      yield* git(cwd, ["cherry-pick", "feature"]);
      yield* git(cwd, ["switch", "feature"]);
      assert.equal(yield* driver.countUnmergedCommits({ cwd, baseRef: base }), 0);

      // Patch-ids ignore whitespace, so they pair these two; in Python the indent is the change.
      yield* commitFile("code.py", "def f():\n    return 2\n");
      yield* git(cwd, ["switch", base]);
      yield* commitFile("code.py", "def f():\n  return 2\n");
      yield* git(cwd, ["switch", "feature"]);
      assert.equal(yield* driver.countUnmergedCommits({ cwd, baseRef: base }), 1);

      // A detached HEAD has no branch base, so its commits are compared with the default branch.
      yield* git(cwd, ["switch", "--detach"]);
      assert.equal(yield* driver.countUnmergedCommits({ cwd }), 1);

      // Without a default branch, nothing says which of a detached HEAD's commits are merged.
      yield* git(cwd, ["branch", "-m", base, "trunk"]);
      const error = yield* Effect.flip(driver.countUnmergedCommits({ cwd }));
      assert.equal(error.operation, "GitVcsDriver.countUnmergedCommits.base");
    }),
  );

  it.effect("does not open a project folder laid out as a bare repository", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      // Plain files a project save or a clone can hold. Git discovers them as a bare repository.
      const planted = pathService.join(cwd, "planted");
      yield* writeTextFile(planted, "HEAD", "ref: refs/heads/main\n");
      yield* writeTextFile(planted, "objects/info/keep", "");
      yield* writeTextFile(planted, "refs/heads/keep", "");
      yield* writeTextFile(
        planted,
        "config",
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n',
      );

      yield* Effect.exit(driver.statusDetailsLocal(planted));
      assert.isFalse(yield* fileSystem.exists(pathService.join(planted, "fsmonitor-runs")));
      assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isRepo);
    }),
  );

  it.effect("reads Changes totals without minimizing and keeps review diffs minimal", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["config", "diff.algorithm", "myers"]);
      // Repeated lines make the default and minimal algorithms choose different edits.
      const lines = Array.from({ length: 2000 }, (_, index) => index);
      yield* writeTextFile(
        cwd,
        "repeated.txt",
        lines.map((index) => `${(index ^ (index >> 3)) % 16}\n`).join(""),
      );
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "repeated lines"]);
      yield* git(cwd, ["checkout", "-b", "feature/totals"]);
      yield* writeTextFile(
        cwd,
        "repeated.txt",
        lines.map((index) => `${(index ^ (index >> 5)) % 16}\n`).join(""),
      );
      const defaultStat = yield* git(cwd, ["diff", "--numstat", "HEAD", "--"]);
      const minimalStat = yield* git(cwd, ["diff", "--minimal", "--numstat", "HEAD", "--"]);
      assert.notEqual(defaultStat, minimalStat);
      const [insertions, deletions] = defaultStat.split("\t");
      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepInclude(status.branchChanges, {
        baseRef: initialBranch,
        insertions: Number(insertions),
        deletions: Number(deletions),
      });

      const [additions, removals] = minimalStat.split("\t");
      const minimalPatch = yield* git(cwd, [
        "diff",
        "--minimal",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
      ]);
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      for (const source of preview.sources) {
        assert.deepStrictEqual(source.files, [
          {
            path: "repeated.txt",
            previousPath: null,
            additions: Number(additions),
            deletions: Number(removals),
          },
        ]);
        assert.strictEqual(source.diff.trim(), minimalPatch);
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "lists the real repository through a symlink when a decoy repo occupies the lexical common dir",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sandbox = yield* makeTmpDir("git-symlink-subdir-");
        yield* initRepoWithCommit(sandbox);
        yield* git(sandbox, ["branch", "-M", "decoy-only"]);
        const repo = pathService.join(sandbox, "repo");
        const link = pathService.join(sandbox, "nest", "link");
        yield* fileSystem.makeDirectory(pathService.join(repo, "sub", "dir"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(pathService.dirname(link), { recursive: true });
        yield* fileSystem.symlink(pathService.join(repo, "sub", "dir"), link);

        yield* initRepoWithCommit(repo);
        yield* git(repo, ["checkout", "-b", "real-only"]);

        // The decoy must exist before the first lookup, which caches repository paths.
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const refs = yield* driver.listRefs({ cwd: link });
        assert.isTrue(refs.isRepo);
        assert.isFalse(refs.refs.some((ref) => ref.name === "decoy-only"));
        assert.isTrue(refs.refs.some((ref) => ref.name === "real-only"));

        yield* driver.createWorktree({
          cwd: link,
          path: pathService.join(yield* makeTmpDir("git-worktrees-"), "real"),
          refName: "real-only",
          newRefName: "feature/real-created",
        });
        const createdRefs = yield* driver.listRefs({ cwd: link });
        assert.isFalse(createdRefs.isAtRepositoryRoot);
        assert.isFalse(createdRefs.refs.some((ref) => ref.name === "decoy-only"));
        assert.isTrue(createdRefs.refs.some((ref) => ref.name === "real-only" && ref.current));
        assert.isTrue(createdRefs.refs.some((ref) => ref.name === "feature/real-created"));
      }),
  );

  it.effect("reads Changes totals with untracked files when requested", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const pathService = yield* Path.Path;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/totals"]);
      yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
      yield* git(cwd, ["commit", "-am", "commit edit"]);
      yield* writeTextFile(cwd, "nested/untracked.txt", "one\ntwo\n");
      yield* writeTextFile(cwd, "src/code.ts", "export const value = 1;\n");
      yield* writeTextFile(cwd, "src/code.test.ts", "test\n");
      yield* writeTextFile(cwd, "__mocks__/value.ts", "mock\n");
      yield* writeTextFile(cwd, "pnpm-lock.yaml", "lock\n");
      yield* writeTextFile(cwd, "new [1].txt", "literal\n");

      const status = yield* driver.statusDetailsLocal(pathService.join(cwd, "nested"), {
        includeBranchChanges: true,
      });
      assert.deepInclude(status.branchChanges, {
        baseRef: "main",
        insertions: 8,
        deletions: 0,
      });
      assert.deepStrictEqual(status.branchChanges?.breakdown, {
        code: { additions: 1, deletions: 0 },
        tests: { additions: 1, deletions: 0 },
        mocks: { additions: 1, deletions: 0 },
        generated: { additions: 1, deletions: 0 },
        docs: { additions: 4, deletions: 0 },
      });
      assert.isUndefined((yield* driver.statusDetailsLocal(cwd)).branchChanges);
    }),
  );

  it.effect("Changes compares the default branch with its tracking upstream, not origin", () =>
    Effect.gen(function* () {
      // `origin` is a fork whose main is behind; the checkout tracks the
      // canonical repository through a second remote.
      const canonical = yield* makeTmpDir();
      yield* initRepoWithCommit(canonical);
      yield* git(canonical, ["branch", "-M", "main"]);
      const fork = yield* makeTmpDir();
      yield* git(fork, ["clone", "--quiet", canonical, "."]);
      yield* writeTextFile(canonical, "canonical.txt", "one\ntwo\nthree\n");
      yield* git(canonical, ["add", "canonical.txt"]);
      yield* git(canonical, ["commit", "-m", "canonical moves ahead"]);

      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init", "-b", "main"]);
      yield* git(cwd, ["remote", "add", "origin", fork]);
      yield* git(cwd, ["remote", "add", "upstream", canonical]);
      yield* git(cwd, ["fetch", "--quiet", "--all"]);
      yield* git(cwd, ["reset", "--hard", "--quiet", "upstream/main"]);
      yield* git(cwd, ["branch", "--set-upstream-to=upstream/main", "main"]);

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepInclude(status.branchChanges, {
        baseRef: "upstream/main",
        insertions: 0,
        deletions: 0,
      });
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.strictEqual(changes.baseRef, "upstream/main");
      assert.deepStrictEqual(changes.files, []);

      // Without an upstream the primary remote's copy stays the base.
      yield* git(cwd, ["branch", "--unset-upstream", "main"]);
      const untracked = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepInclude(untracked.branchChanges, {
        baseRef: "origin/main",
        insertions: 3,
        deletions: 0,
      });
    }),
  );

  it.effect("counts many untracked files exactly while collapsing their directory in status", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const untrackedScanRoots: string[][] = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (
          ChildProcess.isStandardCommand(command) &&
          command.args.includes("ls-files") &&
          command.args.includes("--others")
        ) {
          untrackedScanRoots.push(command.args.slice(command.args.indexOf("--") + 1));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/many-untracked"]);
      yield* writeTextFile(cwd, ".git/info/exclude", "ignored.txt\n");
      yield* writeTextFile(cwd, "bulk[1]/ignored.txt", "ignored\n");
      yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => `bulk[1]/${index}.txt`),
        (file) => writeTextFile(cwd, file, "one\ntwo\n"),
        { concurrency: 32, discard: true },
      );

      for (const scenario of ["normal", "all", "no", "long names"]) {
        if (scenario === "long names") {
          yield* Effect.forEach(
            Array.from({ length: 50 }, (_, index) => `${"a".repeat(180)}-${index}.txt`),
            (file) => writeTextFile(cwd, file, "long name\n"),
            { concurrency: 32, discard: true },
          );
        }
        const mode = scenario === "long names" ? "normal" : scenario;
        yield* git(cwd, ["config", "status.showUntrackedFiles", mode]);
        untrackedScanRoots.length = 0;
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, {
          baseRef: "main",
          insertions: scenario === "long names" ? 2_052 : 2_002,
          deletions: 0,
        });
        assert.deepStrictEqual(untrackedScanRoots, [
          scenario === "normal" ? [":(top,literal)bulk[1]/"] : [],
        ]);
        if (scenario === "normal") {
          assert.deepStrictEqual(
            status.workingTree.files.map((file) => file.path),
            ["bulk[1]/"],
          );
        }
      }
    }),
  );

  it.effect("reports changes to a file named HEAD", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "HEAD", "first line\n");
      yield* git(cwd, ["add", "HEAD"]);
      yield* git(cwd, ["commit", "-m", "add HEAD file"]);
      yield* writeTextFile(cwd, "HEAD", "first line\nsecond line\n");

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

      assert.equal(status.isRepo, true);
      assert.equal(status.hasWorkingTreeChanges, true);
      assert.deepInclude(status.workingTree.files, {
        path: "HEAD",
        insertions: 1,
        deletions: 0,
      });
    }),
  );

  it.effect("reports renamed and non-ASCII files by paths that can be committed", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "src/old.ts", "one\ntwo\nthree\n");
      yield* writeTextFile(cwd, "café notes.md", "draft\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "add files"]);
      yield* git(cwd, ["mv", "src/old.ts", "src/new.ts"]);
      yield* writeTextFile(cwd, "src/new.ts", "one\ntwo\nthree\nfour\n");
      yield* writeTextFile(cwd, "café notes.md", "draft\nedit\n");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const status = yield* driver.statusDetails(cwd);

      assert.deepEqual(status.workingTree.files, [
        { path: "café notes.md", insertions: 1, deletions: 0 },
        { path: "src/new.ts", insertions: 1, deletions: 0 },
        { path: "src/old.ts", insertions: 0, deletions: 0 },
      ]);
      yield* driver.commit(cwd, "Commit selection", "", {
        stage: { filePaths: status.workingTree.files.map((file) => file.path) },
      });
      assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
    }),
  );

  it.effect("commits selected files from a nested project directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // A root basename ending in whitespace catches a root lookup that trims Git's output.
      const cwd = path.join(yield* makeTmpDir(), isWindowsHost ? "nested repo" : "repo ");
      yield* (yield* FileSystem.FileSystem).makeDirectory(cwd);
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "add nested file"]);
      yield* writeTextFile(cwd, "nested/tracked.txt", "one\ntwo\n");
      yield* writeTextFile(cwd, "nested/new.txt", "new\n");
      yield* writeTextFile(cwd, "README.md", "# test\nleft out\n");
      const nestedCwd = path.join(cwd, "nested");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const status = yield* driver.statusDetails(nestedCwd);

      assert.deepEqual(status.workingTree.files, [
        { path: "nested/new.txt", insertions: 0, deletions: 0 },
        { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
        { path: "README.md", insertions: 1, deletions: 0 },
      ]);
      // The root is what the paths above are relative to, not the nested cwd, and it keeps
      // the trailing space so the resolved editor target is the file that exists.
      assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(cwd));
      assert.equal(
        NodeFS.existsSync(path.join(status.workingTree.rootPath!, "nested", "new.txt")),
        true,
      );
      yield* driver.commit(nestedCwd, "Commit nested selection", "", {
        stage: { filePaths: ["nested/new.txt", "nested/tracked.txt"] },
      });
      assert.equal(yield* git(cwd, ["status", "--porcelain"]), "M README.md");
    }),
  );

  it.effect("reports the linked worktree as the root of a nested directory in it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const worktreePath = yield* makeTmpDir("git-vcs-driver-linked-");
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "add nested file"]);
      yield* git(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* writeTextFile(worktreePath, "nested/tracked.txt", "one\ntwo\n");
      yield* writeTextFile(worktreePath, "nested/new.txt", "new\n");
      const nestedCwd = (yield* Path.Path).join(worktreePath, "nested");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const status = yield* driver.statusDetails(nestedCwd);

      assert.deepEqual(status.workingTree.files, [
        { path: "nested/new.txt", insertions: 0, deletions: 0 },
        { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
      ]);
      assert.equal(
        NodeFS.realpathSync.native(status.workingTree.rootPath!),
        NodeFS.realpathSync.native(worktreePath),
      );
    }),
  );

  it.effect("reports combined staged and unstaged edits to the same file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "feature.ts", "// line one\n");
      yield* git(cwd, ["add", "feature.ts"]);
      yield* git(cwd, ["commit", "-m", "add feature"]);
      yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n");
      yield* git(cwd, ["add", "feature.ts"]);
      yield* writeTextFile(cwd, "feature.ts", "// line one\n// line two\n// line three\n");

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

      assert.equal(status.isRepo, true);
      assert.equal(status.hasWorkingTreeChanges, true);
      const file = status.workingTree.files.find((f) => f.path === "feature.ts");
      assert.ok(file);
      assert.equal(file.insertions, 2);
      assert.equal(file.deletions, 0);
    }),
  );

  it.effect("reports staged file counts on unborn HEAD without failing", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "initial.ts", "// first file\n");
      yield* git(cwd, ["add", "initial.ts"]);

      const status = yield* driver.statusDetails(cwd);

      assert.equal(status.isRepo, true);
      assert.equal(status.workingTree.files.length, 1);
      const file = status.workingTree.files[0];
      if (file) {
        assert.equal(file.path, "initial.ts");
        assert.equal(file.insertions, 1);
      }
    }),
  );
});

it.layer(layerTest)("Git upstream status", (it) => {
  it.effect("reports default-branch delta separately from upstream delta", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["checkout", "-b", "feature/synced"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature commit"]);
      yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

      assert.equal(status.hasUpstream, true);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
      assert.equal(status.aheadOfDefaultCount, 1);
    }),
  );

  it.effect("reports remote status on unborn HEAD without failing", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

      const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

      assert.equal(status.isRepo, true);
      assert.equal(status.branch, initialBranch);
      assert.equal(status.hasUpstream, false);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
    }),
  );

  it.effect("can read cached remote divergence without fetching upstream", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const updater = yield* makeTmpDir("git-vcs-driver-updater-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);

      yield* git(updater, ["clone", remote, "."]);
      yield* git(updater, ["config", "user.email", "test@test.com"]);
      yield* git(updater, ["config", "user.name", "Test"]);
      yield* writeTextFile(updater, "remote.txt", "remote\n");
      yield* git(updater, ["add", "remote.txt"]);
      yield* git(updater, ["commit", "-m", "remote commit"]);
      yield* git(updater, ["push", "origin", initialBranch]);

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cachedStatus = yield* driver.statusDetailsRemote(cwd, {
        refreshUpstream: false,
      });
      const refreshedStatus = yield* driver.statusDetailsRemote(cwd);

      assert.equal(cachedStatus.behindCount, 0);
      assert.equal(refreshedStatus.behindCount, 1);
    }),
  );

  it.effect("does not start Git auto-maintenance from background upstream fetches", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["repack", "-d"]);
      yield* writeTextFile(cwd, "second.txt", "second\n");
      yield* git(cwd, ["add", "second.txt"]);
      yield* git(cwd, ["commit", "-m", "second commit"]);
      yield* git(cwd, ["push"]);
      yield* git(cwd, ["repack", "-d"]);
      yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
      yield* git(cwd, ["config", "gc.autoDetach", "false"]);
      yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
      const packCount = git(cwd, ["count-objects", "-v"]).pipe(
        Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
      );
      assert.equal(yield* packCount, "2");

      yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

      assert.equal(yield* packCount, "2");
    }),
  );

  it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const origin = yield* makeTmpDir("git-vcs-driver-origin-");
      const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
      yield* initRepoWithCommit(cwd);
      yield* git(origin, ["init", "--bare"]);
      yield* git(upstream, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(cwd, ["remote", "add", "origin", origin]);
      yield* git(cwd, ["remote", "add", "upstream", upstream]);
      yield* git(cwd, ["push", "origin", "main"]);
      yield* git(cwd, ["push", "upstream", "main"]);
      yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      yield* git(cwd, ["checkout", "-b", "release"]);
      yield* writeTextFile(cwd, "release.txt", "release\n");
      yield* git(cwd, ["add", "release.txt"]);
      yield* git(cwd, ["commit", "-m", "release commit"]);
      yield* git(cwd, ["push", "-u", "upstream", "release"]);
      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/upstream/HEAD",
        "refs/remotes/upstream/release",
      ]);

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

      assert.equal(status.branch, "release");
      assert.equal(status.upstreamRef, "upstream/release");
      assert.equal(status.isDefaultBranch, false);
    }),
  );

  it.effect("makes background upstream status fetches non-interactive", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
      const sshWrapperPath = yield* pathService.fromFileUrl(
        new URL("./testing/GitVcsDriverCore.fixture.sh", import.meta.url),
      );
      const envKeys = [
        "GCM_INTERACTIVE",
        "GIT_ASKPASS",
        "GIT_SSH",
        "GIT_TERMINAL_PROMPT",
        "SSH_ASKPASS",
        "SSH_ASKPASS_REQUIRE",
        "T3_TEST_SSH_ASKPASS_LOG",
      ] as const;
      const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

      yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
      yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

      yield* Effect.gen(function* () {
        process.env.GIT_SSH = sshWrapperPath;
        process.env.GCM_INTERACTIVE = "always";
        process.env.GIT_ASKPASS = "git-askpass";
        process.env.GIT_TERMINAL_PROMPT = "1";
        process.env.SSH_ASKPASS = "ssh-askpass";
        process.env.SSH_ASKPASS_REQUIRE = "force";
        process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
          "GCM_INTERACTIVE=never",
          "GIT_ASKPASS=",
          "GIT_TERMINAL_PROMPT=0",
          "SSH_ASKPASS=",
          "SSH_ASKPASS_REQUIRE=never",
        ]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const key of envKeys) {
              const previous = previousEnv.get(key);
              if (previous === undefined) {
                delete process.env[key];
              } else {
                process.env[key] = previous;
              }
            }
          }),
        ),
      );
    }),
  );

  it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature commit"]);

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

      assert.equal(status.hasUpstream, false);
      assert.equal(status.aheadCount, 1);
      assert.equal(status.behindCount, 0);
      assert.equal(status.aheadOfDefaultCount, 1);
    }),
  );
});
