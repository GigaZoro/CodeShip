// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
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
  layerServerConfig,
  makeSuccessfulHandle,
} from "./GitVcsDriverCore.testkit.ts";

it.layer(layerTest)("Git repository status", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills a timed-out git command that ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const markerPath = pathService.join(yield* makeTmpDir(), "outlived-timeout");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const trapped = yield* Deferred.make<void>();

        const command = yield* driver
          .execute({
            operation: "GitVcsDriver.test.ignoresSigterm",
            cwd,
            args: [
              "-c",
              `alias.hang=!trap '' TERM; echo trapped; sleep 3; touch '${markerPath}'`,
              "hang",
            ],
            progress: {
              onStdoutLine: (line) =>
                line === "trapped" ? Deferred.succeed(trapped, undefined) : Effect.void,
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(trapped);
        // The driver's timeout ends a command the same way: by interrupting it.
        yield* Fiber.interrupt(command);

        assert.isFalse(
          yield* fileSystem.exists(markerPath),
          "the timed-out git command kept running until it finished on its own",
        );
      }),
  );

  it.effect("keeps large change sets available for status and commit preparation", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      // Selected paths add up to more than Linux's default 2 MiB argument limit.
      const dir = "d".repeat(200);
      yield* fs.makeDirectory(path.join(cwd, dir));
      const files = Array.from(
        { length: 6_000 },
        (_, index) => `${dir}/file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
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
      const selected = files.slice(1);
      yield* driver.commit(cwd, "selected", "", { stage: { filePaths: selected } });
      assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "selected");
      assert.equal(yield* git(cwd, ["status", "--porcelain"]), `M ${files[0]}`);
    }),
  );

  it.effect("reads the current branch and upstream by name when other refs share them", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["checkout", "-b", "release"]);
      yield* git(cwd, ["push", "-u", "origin", "release"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "unpushed"]);
      yield* git(cwd, ["branch", "origin/release"]);
      yield* git(cwd, ["tag", "release"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
      assert.equal(remoteStatus.branch, "release");
      assert.equal(remoteStatus.upstreamRef, "origin/release");
      assert.equal(remoteStatus.aheadCount, 1);
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const branchRange = preview.sources.find((source) => source.kind === "branch-range");
      assert.equal(branchRange?.headRef, "release");
    }),
  );

  it.effect("reports a local upstream without a slash and its divergence", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
      yield* git(cwd, ["branch", "feature"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "advance base"]);
      yield* git(cwd, ["checkout", "feature"]);
      yield* git(cwd, ["branch", `--set-upstream-to=${initialBranch}`]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
      assert.equal(remoteStatus.upstreamRef, initialBranch);
      assert.equal(remoteStatus.hasUpstream, true);
      assert.equal(remoteStatus.aheadCount, 0);
      assert.equal(remoteStatus.behindCount, 1);
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
            changeType: "change",
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

  it.effect("reads Changes totals without rewriting the real index for stat-dirty files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeTextFile(cwd, "tracked.txt", "same content\n");
      yield* git(cwd, ["add", "tracked.txt"]);
      yield* git(cwd, ["commit", "-m", "add tracked file"]);
      yield* fileSystem.utimes(path.join(cwd, "tracked.txt"), 1_000_000_000, 1_000_000_000);
      const indexPath = path.join(cwd, ".git", "index");
      const originalIndex = yield* fileSystem.readFile(indexPath);

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.strictEqual(status.branchChanges?.insertions, 0);
      assert.strictEqual(status.branchChanges?.deletions, 0);
      // Writing the index takes index.lock, which makes concurrent user Git writes fail.
      assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
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
          untrackedScanRoots.push(command.args.slice(command.args.indexOf("--") + 1).map(String));
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
      const clean = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepInclude(clean.branchChanges, {
        baseRef: "main",
        insertions: 0,
        deletions: 0,
      });
      assert.deepStrictEqual(untrackedScanRoots, []);
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
          scenario === "normal" || scenario === "no" ? [":(top,literal)bulk[1]/"] : [],
        ]);
        if (scenario === "normal" || scenario === "no") {
          assert.deepStrictEqual(
            status.workingTree.files.map((file) => file.path),
            ["bulk[1]/"],
          );
        } else if (scenario === "all") {
          assert.lengthOf(status.workingTree.files, 1_001);
        }
      }
    }),
  );

  it.effect("reports a new repository without waiting on a huge untracked file's line count", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init", "-b", "main"]);
      yield* writeTextFile(cwd, "small.txt", "line\n");
      yield* writeTextFile(cwd, "large.data", "");
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* fileSystem.truncate(pathService.join(cwd, "large.data"), 8 * 1024 * 1024 * 1024);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const totalsDiffSettled = yield* Deferred.make<void>();
      const largeFileDiffAbandonedAt = yield* Deferred.make<number>();
      // Stands in for `git diff --numstat` reading gigabytes of untracked file content.
      const readsLargeFile = (command: ChildProcess.Command) => {
        const indexFile =
          ChildProcess.isStandardCommand(command) &&
          command.args.includes("--numstat") &&
          command.options.env?.GIT_INDEX_FILE;
        return (
          typeof indexFile === "string" &&
          NodeFS.readFileSync(indexFile).includes(Buffer.from("large.data"))
        );
      };
      const spawner = ChildProcessSpawner.make((command) =>
        readsLargeFile(command)
          ? Deferred.succeed(totalsDiffSettled, undefined).pipe(
              Effect.as(
                ChildProcessSpawner.makeHandle({
                  ...makeSuccessfulHandle(""),
                  isRunning: Effect.succeed(true),
                  exitCode: Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      Clock.currentTimeMillis.pipe(
                        Effect.flatMap((now) => Deferred.succeed(largeFileDiffAbandonedAt, now)),
                      ),
                    ),
                  ),
                }),
              ),
            )
          : delegate.spawn(command),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const startedAt = yield* Clock.currentTimeMillis;

      const status = yield* driver
        .statusDetailsLocal(cwd, { includeDivergence: false, includeBranchChanges: true })
        .pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(totalsDiffSettled), Fiber.await(status));
      // Git's default command timeout, which is what releases the status on main.
      yield* TestClock.adjust("30 seconds");
      const reported = yield* Fiber.join(status);

      const statusHeldForMs = (yield* Deferred.isDone(largeFileDiffAbandonedAt))
        ? (yield* Deferred.await(largeFileDiffAbandonedAt)) - startedAt
        : 0;
      assert.isAtMost(statusHeldForMs, 5_000, "status waited on the untracked line count");
      assert.isTrue(reported.isRepo);
      assert.strictEqual(reported.branch, "main");
    }).pipe(Effect.provide(layerServerConfig)),
  );

  it.effect("counts totals when a large unstaged copy of a removed file stays on disk", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "asset.data", "old\n");
      yield* git(cwd, ["add", "asset.data"]);
      yield* git(cwd, ["commit", "-m", "add asset"]);
      yield* git(cwd, ["rm", "--cached", "asset.data"]);
      yield* fileSystem.truncate(pathService.join(cwd, "asset.data"), 257 * 1024 * 1024);
      yield* writeTextFile(cwd, "ordinary.txt", "new\n");

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.deepInclude(status.branchChanges, {
        baseRef: null,
        insertions: 1,
        deletions: 1,
      });
      const preview = yield* driver.getReviewDiffPreview({ cwd, metadataOnly: true });
      assert.deepStrictEqual(
        preview.sources.find((source) => source.kind === "working-tree")?.files,
        [
          {
            path: "asset.data",
            previousPath: null,
            changeType: "deleted",
            additions: 0,
            deletions: 1,
          },
          {
            path: "ordinary.txt",
            previousPath: null,
            changeType: "new",
            additions: 1,
            deletions: 0,
          },
        ],
      );
    }),
  );

  it.effect("keeps an oversized untracked file out of the review diff", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "README.md", "# tracked change\n");
      yield* writeTextFile(cwd, "ordinary.txt", "new\n");
      yield* writeTextFile(cwd, "large.data", "");
      // Sparse: the logical size is over the budget without allocating it.
      yield* fileSystem.truncate(pathService.join(cwd, "large.data"), 257 * 1024 * 1024);

      const preview = yield* driver.getReviewDiffPreview({ cwd, metadataOnly: true });

      const source = preview.sources.find((source) => source.kind === "working-tree")!;
      assert.isUndefined(source.files);
      assert.isUndefined(source.patchesDeferred);
      assert.isTrue(source.truncated);
      assert.include(source.diff, "+# tracked change");
      assert.include(source.diff, "b/ordinary.txt");
      assert.notInclude(source.diff, "large.data");
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

  it.effect("reports net file counts from the empty tree on unborn HEAD", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* writeTextFile(cwd, "initial.ts", "// first file\n");
      yield* git(cwd, ["add", "initial.ts"]);
      yield* writeTextFile(cwd, "initial.ts", "// edited after staging\n");

      const status = yield* driver.statusDetailsLocal(cwd);

      assert.equal(status.isRepo, true);
      assert.deepStrictEqual(status.workingTree.files, [
        { path: "initial.ts", insertions: 1, deletions: 0 },
      ]);
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

  it.effect("reports status on unborn HEAD without failing or dropping its upstream", () =>
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

      const seed = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(seed);
      yield* git(remote, ["init", "--bare"]);
      yield* git(seed, ["push", remote, `HEAD:refs/heads/${initialBranch}`]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["fetch", "origin"]);
      yield* git(cwd, ["config", `branch.${initialBranch}.remote`, "origin"]);
      yield* git(cwd, ["config", `branch.${initialBranch}.merge`, `refs/heads/${initialBranch}`]);
      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasUpstream, true);
    }),
  );

  it.effect("reports no branch while a clone has not checked out HEAD yet", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      // `git clone` points HEAD here until checkout; status then prints `branch.head (unknown)`.
      yield* (yield* FileSystem.FileSystem).writeFileString(
        NodePath.join(cwd, ".git", "HEAD"),
        "ref: refs/heads/.invalid\n",
      );

      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, null);
    }),
  );

  it.effect("records no failed span reading status of a repository without a remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const traced = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          spans.length = 0;
          const exit = yield* effect.pipe(Effect.withTracer(tracer), Effect.exit);
          const failedSpans = spans.flatMap((span) =>
            span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? [span.name] : [],
          );
          return { exit, failedSpans };
        });

      const status = yield* traced(driver.statusDetailsRemote(cwd));
      assert.isTrue(Exit.isSuccess(status.exit));
      assert.deepStrictEqual(status.failedSpans, []);

      // A caller that needs a remote still fails, in its own span.
      const fetch = yield* traced(driver.fetchRefCommit({ cwd, ref: "refs/pull/1/head" }));
      assert.include(
        Exit.isFailure(fetch.exit) ? Cause.pretty(fetch.exit.cause) : "",
        "No git remote is configured for this repository.",
      );
      assert.deepStrictEqual(fetch.failedSpans, ["GitVcsDriver.fetchRefCommit"]);
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

  it.effect("a ref snapshot detects branch identity, ref and ancestry changes", () =>
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
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const snapshot = driver.readRefSnapshot(cwd);

      // Newer Git can create origin/HEAD on the first fetch.
      yield* git(cwd, ["fetch", "origin"]);
      const initial = yield* snapshot;
      assert.isNotNull(initial);
      yield* git(cwd, ["fetch", "origin"]);
      assert.equal(yield* snapshot, initial);

      yield* git(cwd, ["branch", "same-commit"]);
      const beforeCheckout = yield* snapshot;
      const refsBeforeCheckout = yield* git(cwd, ["show-ref", "--head"]);
      yield* git(cwd, ["checkout", "same-commit"]);
      assert.equal(yield* git(cwd, ["show-ref", "--head"]), refsBeforeCheckout);
      const afterCheckout = yield* snapshot;
      assert.isNotNull(afterCheckout);
      assert.notEqual(afterCheckout, beforeCheckout);
      yield* git(cwd, ["checkout", "--detach"]);
      assert.equal(yield* git(cwd, ["show-ref", "--head"]), refsBeforeCheckout);
      const detached = yield* snapshot;
      assert.isNotNull(detached);
      assert.notEqual(detached, beforeCheckout);
      assert.notEqual(detached, afterCheckout);
      assert.equal(yield* snapshot, detached);
      yield* git(cwd, ["checkout", initialBranch]);
      assert.equal(yield* snapshot, beforeCheckout);
      yield* git(cwd, ["branch", "-d", "same-commit"]);

      yield* writeTextFile(updater, "remote.txt", "remote\n");
      yield* git(updater, ["add", "remote.txt"]);
      yield* git(updater, ["commit", "-m", "remote commit"]);
      yield* git(updater, ["push", "origin", initialBranch]);
      assert.equal(yield* snapshot, initial);
      yield* git(cwd, ["fetch", "origin"]);
      const fetched = yield* snapshot;
      assert.notEqual(fetched, initial);

      const shallow = yield* makeTmpDir("git-vcs-driver-shallow-");
      yield* git(shallow, ["clone", "--depth=1", NodeURL.pathToFileURL(remote).href, "."]);
      const shallowRefs = yield* git(shallow, ["show-ref", "--head"]);
      const shallowSnapshot = yield* driver.readRefSnapshot(shallow);
      assert.isNotNull(shallowSnapshot);
      const shallowWorktree = yield* makeTmpDir("git-vcs-driver-shallow-worktree-");
      yield* git(shallow, ["worktree", "add", "--detach", shallowWorktree]);
      const worktreeSnapshot = yield* driver.readRefSnapshot(shallowWorktree);
      assert.isNotNull(worktreeSnapshot);
      yield* git(shallow, ["fetch", "--unshallow", "origin"]);
      assert.equal(yield* git(shallow, ["show-ref", "--head"]), shallowRefs);
      const unshallowSnapshot = yield* driver.readRefSnapshot(shallow);
      const unshallowWorktreeSnapshot = yield* driver.readRefSnapshot(shallowWorktree);
      assert.isNotNull(unshallowSnapshot);
      assert.isNotNull(unshallowWorktreeSnapshot);
      assert.notEqual(unshallowSnapshot, shallowSnapshot);
      assert.notEqual(unshallowWorktreeSnapshot, worktreeSnapshot);

      yield* git(cwd, ["checkout", "--detach"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "detached"]);
      assert.notEqual(yield* snapshot, fetched);

      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* driver.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["update-ref", "--stdin"],
        stdin: Array.from(
          { length: 16_000 },
          (_, index) => `create refs/heads/snapshot-${String(index).padStart(5, "0")} ${head}\n`,
        ).join(""),
      });
      yield* git(cwd, ["pack-refs", "--all"]);
      const large = yield* snapshot;
      assert.isNotNull(large);
      assert.isAbove(Buffer.byteLength(large ?? "", "utf8"), 1_000_000);
      assert.equal(yield* snapshot, large);
      yield* git(cwd, ["update-ref", "refs/heads/snapshot-00000", "HEAD~1"]);
      assert.notEqual(yield* snapshot, large);

      assert.isNull(yield* driver.readRefSnapshot(yield* makeTmpDir()));
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

  it.effect("leaves FETCH_HEAD to the user's own pulls in background upstream fetches", () =>
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
      const fetchHeadPath = (yield* Path.Path).join(cwd, ".git", "FETCH_HEAD");
      assert.equal(NodeFS.existsSync(fetchHeadPath), false);

      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

      assert.equal(status.behindCount, 1);
      assert.equal(
        NodeFS.existsSync(fetchHeadPath),
        false,
        "background status fetch wrote .git/FETCH_HEAD, which an overlapping `git pull` merges from",
      );
    }),
  );

  it.effect("reads the default branch from the primary remote when it is not named origin", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-github-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "trunk"]);
      yield* git(cwd, ["remote", "add", "github", remote]);
      yield* git(cwd, ["push", "github", "trunk"]);
      yield* git(cwd, ["symbolic-ref", "refs/remotes/github/HEAD", "refs/remotes/github/trunk"]);
      yield* git(cwd, ["checkout", "-b", "main"]);
      yield* writeTextFile(cwd, "main.txt", "main\n");
      yield* git(cwd, ["add", "main.txt"]);
      yield* git(cwd, ["commit", "-m", "work on a branch named main"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const onMain = yield* driver.statusDetailsLocal(cwd);
      assert.isFalse(onMain.isDefaultBranch);
      assert.equal(yield* driver.countUnmergedCommits({ cwd }), 1);

      yield* git(cwd, ["checkout", "trunk"]);
      const onTrunk = yield* driver.statusDetailsLocal(cwd);
      assert.isTrue(onTrunk.isDefaultBranch);
      assert.isTrue((yield* driver.statusDetails(cwd)).isDefaultBranch);
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

  it.effect("does not report a default branch the remote deleted after the clone", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-origin-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "development"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "development", "development:main"]);
      yield* git(cwd, ["remote", "set-head", "origin", "development"]);
      yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", "refs/heads/main"]);
      yield* git(cwd, ["push", "origin", "--delete", "development"]);
      yield* git(cwd, ["fetch", "--prune", "origin"]);

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const defaultBranch = yield* driver.resolveDefaultBranchName(cwd, "origin");

      assert.notEqual(defaultBranch, "development");
      for (const refName of ["origin/HEAD", "HEAD~1", "main^", "@{-1}", "-", ":/fix"])
        assert.isNull(yield* driver.resolveWorktreeBaseRemote({ cwd, refName }));
      assert.deepEqual(
        yield* driver.resolveWorktreeBaseRemote({ cwd, refName: "feature/a\u00a0b" }),
        { remoteName: "origin", branchName: "feature/a\u00a0b" },
      );
    }),
  );

  it.effect.each(["checkout", "bare-backed worktree"] as const)(
    "uses the only remote's HEAD for default-branch detection without origin in a %s",
    (layout) =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const path = yield* Path.Path;
        const source = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-github-");
        yield* initRepoWithCommit(source);
        yield* git(remote, ["init", "--bare"]);
        yield* git(source, ["branch", "-M", "trunk"]);
        yield* git(source, ["remote", "add", "github", remote]);
        yield* git(source, ["push", "-u", "github", "trunk"]);
        let cwd = source;
        if (layout === "bare-backed worktree") {
          const container = yield* makeTmpDir("git-vcs-driver-bare-");
          const gitDirArgs = ["--git-dir", path.join(container, "repo.git")];
          cwd = path.join(container, "trunk");
          yield* git(container, ["init", "--bare", "repo.git"]);
          yield* git(container, [...gitDirArgs, "config", "user.email", "test@test.com"]);
          yield* git(container, [...gitDirArgs, "config", "user.name", "Test"]);
          yield* git(container, [...gitDirArgs, "remote", "add", "github", remote]);
          yield* git(container, [...gitDirArgs, "fetch", "github"]);
          yield* git(container, [
            ...gitDirArgs,
            "worktree",
            "add",
            "--track",
            "-b",
            "trunk",
            cwd,
            "github/trunk",
          ]);
        }
        yield* git(cwd, ["symbolic-ref", "refs/remotes/github/HEAD", "refs/remotes/github/trunk"]);

        assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isDefaultBranch);
        const remoteStatus = yield* driver.statusDetailsRemote(cwd);
        assert.equal(remoteStatus.defaultBranch, "trunk");
        assert.isTrue(remoteStatus.isDefaultBranch);

        yield* git(cwd, ["remote", "add", "origin", remote]);
        assert.isNull((yield* driver.statusDetailsRemote(cwd)).defaultBranch);
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

      yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
      yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
      yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

      yield* Effect.gen(function* () {
        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.deepEqual((yield* fileSystem.readFileString(sshLogPath)).trim().split(/\r?\n/), [
          "GCM_INTERACTIVE=never",
          "GIT_ASKPASS=",
          "GIT_TERMINAL_PROMPT=0",
          "SSH_ASKPASS=",
          "SSH_ASKPASS_REQUIRE=never",
        ]);
      }).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...(yield* HostProcess.Environment),
          GIT_SSH: sshWrapperPath,
          GCM_INTERACTIVE: "always",
          GIT_ASKPASS: "git-askpass",
          GIT_TERMINAL_PROMPT: "1",
          SSH_ASKPASS: "ssh-askpass",
          SSH_ASKPASS_REQUIRE: "force",
          T3_TEST_SSH_ASKPASS_LOG: sshLogPath,
        }),
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
