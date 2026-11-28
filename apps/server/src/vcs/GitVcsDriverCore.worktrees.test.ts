// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { WorktreeSubmodules } from "@t3tools/contracts/environment";
import { GitCommandError } from "@t3tools/contracts/git";
import {
  gitErrorLines,
  gitFailureFacts,
  makeGitVcsDriverCore,
  parseGitCheckoutProgressLine,
} from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerServerConfig,
  layerTest,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

const encodeGitCommandError = Schema.encodeEffect(Schema.fromJsonString(GitCommandError));

it.layer(layerTest)("Git worktree creation", (it) => {
  it.effect("starts a new branch from a branch that exists only on the remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/cs/remote-only"]);
      yield* git(cwd, ["fetch", "origin"]);
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "remote-only");

      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: "cs/remote-only",
        newRefName: "land/remote-only",
      });

      assert.equal(
        yield* git(worktreePath, ["rev-parse", "HEAD"]),
        yield* git(cwd, ["rev-parse", "origin/cs/remote-only"]),
      );
    }),
  );

  it.effect("uses parallel checkout without skipping filters or hooks", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["config", "filter.test.smudge", "sed s/original/filtered/g"]);
      yield* writeTextFile(cwd, ".gitattributes", "asset.txt filter=test\n");
      yield* writeTextFile(cwd, "asset.txt", "original\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "filtered asset"]);
      yield* writeTextFile(
        cwd,
        ".git/hooks/post-checkout",
        "#!/bin/sh\ngit config checkout.workers > checkout-workers\nexit 0\n",
      );
      yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "parallel");

      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/parallel",
        baseRefName: initialBranch,
      });

      assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "locked");
      assert.equal(yield* fs.readFileString(path.join(worktreePath, "checkout-workers")), "0\n");
      assert.equal(yield* fs.readFileString(path.join(worktreePath, "asset.txt")), "filtered\n");
      assert.equal(
        yield* git(worktreePath, ["rev-parse", "HEAD"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
      assert.equal(
        yield* git(cwd, ["config", "branch.feature/parallel.t3-merge-base"]),
        initialBranch,
      );
      for (const [configured, expected] of [
        ["1", "1"],
        ["", "0"],
      ] as const) {
        yield* git(cwd, ["config", "checkout.workers", configured]);
        const configuredPath = path.join(yield* makeTmpDir("git-worktrees-"), "configured");
        yield* driver.createWorktree({
          cwd,
          path: configuredPath,
          refName: initialBranch,
          newRefName: `feature/configured-${expected}`,
        });
        assert.equal(
          yield* fs.readFileString(path.join(configuredPath, "checkout-workers")),
          `${expected}\n`,
        );
      }
    }),
  );
  it.effect.each(["commit", "short-commit", "tag", "revision"] as const)(
    "creates a worktree from a %s without recording it as a PR base",
    (kind) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["tag", "v1"]);
        const baseRef =
          kind === "commit"
            ? commit
            : kind === "short-commit"
              ? commit.slice(0, 12)
              : kind === "tag"
                ? "v1"
                : "HEAD~0";
        const path = yield* Path.Path;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "revision");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: baseRef,
          newRefName: "feature/revision",
          baseRefName: baseRef,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), commit);
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/revision.t3-merge-base"),
          null,
        );
      }),
  );

  it.effect("creates parallel worktrees in one repository without racing on its config", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", initialBranch]);
      const path = yield* Path.Path;
      const worktrees = yield* makeTmpDir("git-worktrees-");

      // Git has no lock timeout for .git/config, which every worktree shares: a writer that
      // overlaps another fails, and a branch can then be left without its worktree.
      let configWriters = 0;
      let peakConfigWriters = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const countingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = ChildProcess.isStandardCommand(command) ? command.args : [];
          const writesConfig =
            (args.includes("worktree") && args.includes("add") && args.includes("-b")) ||
            (args[0] === "branch" &&
              (args[1] === "-m" || args[1]?.startsWith("--set-upstream-to"))) ||
            (args[0] === "config" && !args[1]?.startsWith("-"));
          if (!writesConfig) return yield* delegate.spawn(command);
          configWriters += 1;
          peakConfigWriters = Math.max(peakConfigWriters, configWriters);
          const handle = yield* delegate.spawn(command);
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: handle.exitCode.pipe(
              Effect.ensuring(Effect.sync(() => (configWriters -= 1))),
            ),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
        Effect.provide(layerServerConfig),
      );
      const branches = Array.from({ length: 8 }, (_, index) => `feature/parallel-${index}`);

      yield* Effect.forEach(
        branches,
        (branch) =>
          driver.createWorktree({
            cwd,
            path: path.join(worktrees, branch.replace("/", "-")),
            refName: `origin/${initialBranch}`,
            newRefName: branch,
            baseRefName: `origin/${initialBranch}`,
          }),
        { concurrency: "unbounded" },
      );
      // Launches rename their temporary branch from inside the new worktree.
      yield* Effect.forEach(
        branches,
        (branch) =>
          driver.renameBranch({
            cwd: path.join(worktrees, branch.replace("/", "-")),
            oldBranch: branch,
            newBranch: `${branch}-renamed`,
            exactName: true,
          }),
        { concurrency: "unbounded" },
      );

      assert.equal(peakConfigWriters, 1);
      for (const branch of branches) {
        const renamed = `${branch}-renamed`;
        assert.equal(yield* git(cwd, ["config", `branch.${renamed}.remote`]), "origin");
        assert.equal(
          yield* git(cwd, ["config", `branch.${renamed}.t3-merge-base-ref`]),
          `refs/remotes/origin/${initialBranch}`,
        );
      }
    }),
  );

  it.effect.each(["release/v2", "refs/heads/release/v2", "deadbeef"])(
    "records the branch name when creating a worktree from %s",
    (baseRef) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const baseBranch = baseRef.replace(/^refs\/heads\//, "");
        yield* git(cwd, ["branch", baseBranch]);
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "branch"),
          refName: baseRef,
          newRefName: "feature/branch",
          baseRefName: baseRef,
        });

        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/branch.t3-merge-base"),
          baseBranch,
        );
      }),
  );

  it.effect.each(["release/v2", "origin/release/v2", "refs/remotes/origin/release/v2"])(
    "records a remote-only PR base when creating a worktree from %s",
    (baseRef) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release/v2"]);
        const commit = yield* git(cwd, ["rev-parse", "origin/release/v2"]);
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "remote");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: commit,
          newRefName: "feature/remote",
          baseRefName: baseRef,
        });

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]), commit);
      }),
  );

  it("parses checkout progress lines from git's stderr", () => {
    assert.deepStrictEqual(parseGitCheckoutProgressLine("Updating files:  78% (2104/2700)"), {
      percent: 78,
      completed: 2104,
      total: 2700,
    });
    assert.deepStrictEqual(
      parseGitCheckoutProgressLine("Updating files: 100% (2700/2700), done."),
      { percent: 100, completed: 2700, total: 2700 },
    );
    assert.strictEqual(parseGitCheckoutProgressLine("Preparing worktree (new branch 'x')"), null);
  });

  // NTFS rejects a newline in a file name, so there is nothing to preserve there.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "preserves newline characters in worktree paths when listing refs",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

        const refs = yield* driver.listRefs({ cwd, refresh: true });
        const listedPath = refs.refs.find(
          (ref) => ref.name === "feature/newline-path",
        )?.worktreePath;

        if (typeof listedPath !== "string") {
          return assert.fail("expected the linked branch to include its worktree path");
        }
        assert.equal(
          NodeFS.realpathSync.native(listedPath),
          NodeFS.realpathSync.native(worktreePath),
        );
      }),
  );

  it.effect("keeps Git's exit code when the new branch already exists", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const error = yield* driver
        .createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "taken"),
          refName: initialBranch,
          newRefName: initialBranch,
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        operation: "GitVcsDriver.createWorktree.createBranch",
        reason: "branch_already_exists",
        exitCode: 128,
      });
      assert.include(error.message, "Exit code 128.");
      // A classified failure never quotes its stderr, which names refs and paths.
      assert.notInclude(error.message, "Git said");
    }),
  );

  it.effect("names Git's reason when the base commit is not in the repository", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const missingCommit = "0123456789abcdef0123456789abcdef01234567";
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "missing-base");

      const error = yield* driver
        .createWorktree({
          cwd,
          path: worktreePath,
          refName: missingCommit,
          newRefName: "t3/from-missing-commit",
        })
        .pipe(Effect.flip);

      // The failing step is `git branch`, not `git worktree add`, and the message must say so.
      assert.deepInclude(error, {
        operation: "GitVcsDriver.createWorktree.createBranch",
        detail: "git branch create failed",
        exitCode: 128,
      });
      assert.notProperty(error, "reason");
      assert.include(
        error.message,
        "Exit code 128. Git said: fatal: not a valid branch point: '…'",
      );
      assert.notInclude(error.message, missingCommit);
      assert.notProperty(error, "stderr");
    }),
  );

  it.effect("quotes the shape of the Git lines it knows, never a value in them", () =>
    Effect.gen(function* () {
      const email = "review-fixture@example.invalid";
      const stderr = [
        `fatal: empty ident name (for <${email}>) not allowed`,
        "fatal: unable to access 'https://user:token@example.com/repo.git?key=secret': Could not resolve host: example.com",
        `fatal: odd failure for ${email}`,
      ].join("\n");
      const facts = gitFailureFacts({ exitCode: 2, stdout: "", stderr }, { quoteGitLines: true });

      assert.equal(
        facts.diagnostics,
        "Exit code 2. Git said: fatal: empty ident name (for <…>) not allowed | fatal: unable to access '…': Could not resolve host: … | fatal: (message withheld)",
      );
      const error = new GitCommandError({
        operation: "GitVcsDriver.test",
        command: "git",
        cwd: "/repo",
        detail: "Git command exited with a non-zero status.",
        ...facts,
      });
      for (const text of [error.message, yield* encodeGitCommandError(error)]) {
        assert.include(text, "fatal: empty ident name (for <…>) not allowed");
        for (const value of [email, "token", "secret", "example.com"]) {
          assert.notInclude(text, value);
        }
      }
      assert.equal(facts.stderrLength, stderr.length);
      // Arguments can carry a secret that Git echoes, so the default keeps the exit code only.
      assert.equal(
        gitFailureFacts({ exitCode: 2, stdout: "", stderr }).diagnostics,
        "Exit code 2.",
      );
      assert.deepEqual(gitFailureFacts({ exitCode: null, stdout: "", stderr: "" }), {
        stdoutLength: 0,
        stderrLength: 0,
      });
    }),
  );

  it.effect.each([
    [
      "fatal: '/w/secret' contains modified or untracked files, use --force to delete it",
      "fatal: '…' contains modified or untracked files, use --force to delete it",
    ],
    [
      "fatal: cannot remove a locked working tree, lock reason: secret\nuse 'remove -f -f' to override or unlock first",
      "fatal: cannot remove a locked working tree, lock reason: …",
    ],
    [
      "fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first",
      "fatal: cannot remove a locked working tree;",
    ],
    [
      "fatal: working trees containing submodules cannot be moved or removed",
      "fatal: working trees containing submodules cannot be moved or removed",
    ],
    ["fatal: '/w/secret' is a main working tree", "fatal: '…' is a main working tree"],
    [
      "fatal: validation failed, cannot remove working tree: '/w/secret/.git' does not exist",
      "fatal: validation failed, cannot remove working tree: …",
    ],
    // die_errno appends `: <strerror>` to both.
    [
      "fatal: failed to run 'git status' on '/w/secret': No such file or directory",
      "fatal: failed to run 'git status' on '…': …",
    ],
    [
      "fatal: failed to run 'git status' on '/w/secret', code 128: No such file or directory",
      "fatal: failed to run 'git status' on '…', code …",
    ],
    ["error: failed to delete '/w/secret': Permission denied", "error: failed to delete '…': …"],
  ] as const)("keeps why Git refused to remove a worktree: %s", ([stderr, shape]) =>
    Effect.sync(() => {
      assert.equal(gitErrorLines(stderr), shape);
    }),
  );

  it.effect("creates worktrees under the configured worktrees directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const created = yield* driver.createWorktree(
        { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" },
        { worktreesDirectory },
      );
      const expected = pathService.join(
        worktreesDirectory,
        pathService.basename(cwd),
        "feature-custom-dir",
      );
      assert.equal(created.worktree.path, expected);
      assert.equal(yield* fileSystem.exists(expected), true);

      const error = yield* driver
        .createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/relative-dir" },
          { worktreesDirectory: "relative/worktrees" },
        )
        .pipe(Effect.flip);
      assert.match(error.detail, /must be an absolute folder on this machine/);

      const rootError = yield* driver
        .createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/root-dir" },
          { worktreesDirectory: "/" },
        )
        .pipe(Effect.flip);
      assert.match(rootError.detail, /not a drive root/);
    }),
  );

  it.effect("keeps generated worktree folders short without changing long branch names", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      // git lists real paths; macOS tmpdir sits behind /var -> /private/var.
      const worktreesDirectory = NodeFS.realpathSync.native(yield* makeTmpDir("custom-worktrees-"));
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const folders = new Set<string>();
      const branches = [
        `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}`,
        `feature/${"a".repeat(90)}/${"b".repeat(90)}/${"d".repeat(90)}`,
        `feature/${"a".repeat(40)}/5fac`,
        `feature/${"a".repeat(40)}/18828`,
        `${"a".repeat(22)}😀/${"b".repeat(30)}`,
        "z".repeat(40),
        "z".repeat(41),
      ];
      for (const branch of branches) {
        const created = yield* driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: branch },
          { worktreesDirectory },
        );
        const folder = pathService.basename(created.worktree.path);
        assert.isAtMost(folder.length, 40);
        if (branch.length <= 40) assert.equal(folder, branch);
        assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), branch);
        assert.include(
          (yield* git(cwd, ["worktree", "list", "--porcelain", "-z"])).split("\0"),
          `worktree ${created.worktree.path.split(pathService.sep).join("/")}`,
        );
        folders.add(folder);
      }
      assert.equal(folders.size, branches.length);
    }),
  );
});

const stageLocalSubmodule = (cwd: string, name: string, source: string) =>
  Effect.gen(function* () {
    const head = yield* git(source, ["rev-parse", "HEAD"]);
    yield* writeTextFile(
      cwd,
      ".gitmodules",
      `[submodule "${name}"]\n\tpath = ${name}\n\turl = ${NodeURL.pathToFileURL(source).href}\n`,
    );
    yield* git(cwd, ["add", ".gitmodules"]);
    yield* git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${head},${name}`]);
    return head;
  });

it.layer(layerTest)("Git worktree submodules", (it) => {
  it.effect.each([
    ["recursive", false],
    ["recursive", true],
    ["top-level", false],
    ["top-level", true],
  ] as const)("finishes a slow submodule checkout (%s, progress: %s)", ([submodules, progress]) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;

      // Git blocks file submodule transports (CVE-2022-39253) despite repo config; local fixtures need env permission.
      const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
      process.env.GIT_ALLOW_PROTOCOL = "file";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousAllowedProtocol === undefined) {
            delete process.env.GIT_ALLOW_PROTOCOL;
          } else {
            process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
          }
        }),
      );

      const submoduleRepo = yield* makeTmpDir("git-submodule-");
      yield* initRepoWithCommit(submoduleRepo);
      yield* writeTextFile(submoduleRepo, ".gitattributes", "* text eol=lf\n");
      yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
      yield* git(submoduleRepo, ["add", "."]);
      yield* git(submoduleRepo, ["commit", "-m", "shared"]);

      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const recordedHead = yield* stageLocalSubmodule(cwd, "shared", submoduleRepo);
      yield* git(cwd, ["commit", "-m", "add submodule"]);
      yield* writeTextFile(submoduleRepo, "SHARED.md", "# newer remote default\n");
      yield* git(submoduleRepo, ["commit", "-am", "advance remote default"]);

      const updateStarted = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args[0] === "submodule" &&
            command.args[1] === "update"
          ) {
            yield* Deferred.succeed(updateStarted, undefined);
            yield* Deferred.await(releaseUpdate);
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
      const lines = yield* Ref.make<ReadonlyArray<string>>([]);

      const worktreePath = pathService.join(
        yield* makeTmpDir("git-worktrees-"),
        "submodule-worktree",
      );
      const creation = yield* driver
        .createWorktree(
          {
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/submodules",
          },
          {
            submodules,
            progress: {
              onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
              ...(progress
                ? {
                    onSubmoduleLine: (line: string) =>
                      Ref.update(lines, (items) => [...items, line]),
                  }
                : {}),
            },
          },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(updateStarted);
      yield* TestClock.adjust("6 minutes");
      yield* Deferred.succeed(releaseUpdate, undefined);
      yield* Fiber.join(creation);

      assert.deepEqual(yield* Ref.get(finished), [{ ok: true, detail: null }]);
      assert.equal(
        yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
        true,
      );
      assert.equal(
        yield* git(pathService.join(worktreePath, "shared"), ["rev-parse", "HEAD"]),
        recordedHead,
      );
      assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
      assert.equal(
        yield* git(pathService.join(worktreePath, "shared"), ["status", "--porcelain"]),
        "",
      );
      if (progress) assert.isNotEmpty(yield* Ref.get(lines));
    }),
  );

  it.effect("still creates the worktree when submodule checkout fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;

      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* writeTextFile(
        cwd,
        ".gitmodules",
        '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
      );
      yield* git(cwd, ["add", "."]);
      const gitlink = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["update-index", "--add", "--cacheinfo", `160000,${gitlink},missing`]);
      yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

      const worktreePath = pathService.join(
        yield* makeTmpDir("git-worktrees-"),
        "broken-submodule-worktree",
      );
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const finished = yield* Ref.make<ReadonlyArray<{ ok: boolean; detail: string | null }>>([]);
      const created = yield* driver.createWorktree(
        {
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        },
        {
          progress: {
            onSubmodulesFinished: (result) => Ref.update(finished, (items) => [...items, result]),
          },
        },
      );

      assert.equal(created.worktree.path, worktreePath);
      assert.equal(yield* fileSystem.exists(worktreePath), true);
      const results = yield* Ref.get(finished);
      assert.lengthOf(results, 1);
      assert.isFalse(results[0]!.ok);
      assert.include(results[0]!.detail, "GitVcsDriver.createWorktree.updateSubmodules");
    }),
  );

  it.effect("resolves the submodule mode from the option, then t3.json", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;

      const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
      process.env.GIT_ALLOW_PROTOCOL = "file";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousAllowedProtocol === undefined) {
            delete process.env.GIT_ALLOW_PROTOCOL;
          } else {
            process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
          }
        }),
      );

      const nestedRepo = yield* makeTmpDir("git-nested-");
      yield* initRepoWithCommit(nestedRepo);
      yield* writeTextFile(nestedRepo, "NESTED.md", "# nested\n");
      yield* git(nestedRepo, ["add", "."]);
      yield* git(nestedRepo, ["commit", "-m", "nested"]);
      const innerRepo = yield* makeTmpDir("git-inner-");
      yield* initRepoWithCommit(innerRepo);
      yield* writeTextFile(innerRepo, "INNER.md", "# inner\n");
      yield* git(innerRepo, ["add", "INNER.md"]);
      yield* stageLocalSubmodule(innerRepo, "nested", nestedRepo);
      yield* git(innerRepo, ["commit", "-m", "inner"]);

      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* stageLocalSubmodule(cwd, "inner", innerRepo);
      yield* git(cwd, ["commit", "-m", "add submodule"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreesDir = yield* makeTmpDir("git-worktrees-");

      const createWithMode = Effect.fn(function* (
        fileMode: WorktreeSubmodules,
        branch: string,
        submodules: WorktreeSubmodules | null = null,
      ) {
        yield* writeTextFile(cwd, "t3.json", `{ "worktreeSubmodules": "${fileMode}" }`);
        yield* git(cwd, ["add", "t3.json"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", `submodules: ${fileMode}`]);
        const worktreePath = pathService.join(worktreesDir, branch);
        const disabled = yield* Ref.make<"settings" | "t3.json" | false>(false);
        yield* driver.createWorktree(
          { cwd, path: worktreePath, refName: initialBranch, newRefName: branch },
          {
            submodules,
            progress: { onSubmodulesDisabled: ({ source }) => Ref.set(disabled, source) },
          },
        );
        return {
          disabled: yield* Ref.get(disabled),
          inner: yield* fileSystem.exists(pathService.join(worktreePath, "inner", "INNER.md")),
          nested: yield* fileSystem.exists(
            pathService.join(worktreePath, "inner", "nested", "NESTED.md"),
          ),
        };
      });

      assert.deepEqual(yield* createWithMode("recursive", "recursive"), {
        disabled: false,
        inner: true,
        nested: true,
      });
      assert.deepEqual(yield* createWithMode("top-level", "top-level"), {
        disabled: false,
        inner: true,
        nested: false,
      });
      assert.deepEqual(yield* createWithMode("recursive", "setting-none", "none"), {
        disabled: "settings",
        inner: false,
        nested: false,
      });
      assert.deepEqual(yield* createWithMode("none", "setting-wins", "top-level"), {
        disabled: false,
        inner: true,
        nested: false,
      });
      assert.deepEqual(yield* createWithMode("none", "none"), {
        disabled: "t3.json",
        inner: false,
        nested: false,
      });
    }),
  );
});

it.layer(layerTest)("Git worktree locks and removal", (it) => {
  it.effect("still creates the worktree when the base-ref config stays locked", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const pathService = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "locked-config");
      yield* writeTextFile(cwd, ".git/config.lock", "");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      // The base-ref write retries on the real clock before giving up.
      const created = yield* TestClock.withLive(
        driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/locked-config",
          baseRefName: initialBranch,
        }),
      );

      assert.deepEqual(created.worktree, {
        path: worktreePath,
        refName: "feature/locked-config",
      });
      assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/locked-config");
      assert.equal(
        yield* fileSystem.readFileString(pathService.join(worktreePath, "README.md")),
        "# test\n",
      );
      assert.equal(
        yield* driver.readConfigValue(worktreePath, "branch.feature/locked-config.t3-merge-base"),
        null,
      );
      assert.equal(yield* fileSystem.exists(pathService.join(cwd, ".git/config.lock")), true);
    }),
  );

  it.effect.each([false, true])(
    "cleans up links left by successful worktree removal, preserving ordinary files: %s",
    (keepFile) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        yield* writeTextFile(outside, "keep.txt", "external target\n");
        const worktreePath = pathService.join(cwd, "leftover");
        const nested = pathService.join(worktreePath, "node_modules");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.makeDirectory(pathService.join(worktreePath, "empty"));
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "linked"), "junction");
        NodeFS.symlinkSync(outside, pathService.join(nested, "pkg"), "junction");
        if (keepFile) {
          yield* writeTextFile(worktreePath, "notes/draft.txt", "new work\n");
        }

        // Git removes symlinks on Unix; simulate its successful Windows removal
        // leaving junctions behind so the cleanup is exercised on every platform.
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) &&
          command.args.join(" ").includes("worktree remove")
            ? Effect.succeed(makeSuccessfulHandle(""))
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        yield* driver.removeWorktree({ cwd, path: worktreePath });

        assert.equal(
          yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
          "external target\n",
        );
        if (keepFile) {
          assert.deepEqual(yield* fileSystem.readDirectory(worktreePath), ["notes"]);
          assert.equal(
            yield* fileSystem.readFileString(pathService.join(worktreePath, "notes/draft.txt")),
            "new work\n",
          );
        } else {
          assert.equal(yield* fileSystem.exists(worktreePath), false);
        }
      }),
  );

  it.effect("keeps a worktree whose untracked files status is configured to hide", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "hidden");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/hidden",
      });
      yield* git(cwd, ["config", "status.showUntrackedFiles", "no"]);
      yield* writeTextFile(worktreePath, "notes.txt", "draft\n");
      assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");

      const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

      assert.isTrue(Result.isFailure(result));
      const fileSystem = yield* FileSystem.FileSystem;
      assert.equal(
        yield* fileSystem.readFileString(pathService.join(worktreePath, "notes.txt")),
        "draft\n",
      );
    }),
  );

  it.effect("leaves a folder alone that only shares the worktree's short name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const pathService = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "short");
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/short",
      });
      // Unrelated to the worktree, but resolving "short" against cwd lands here.
      const outside = yield* makeTmpDir("git-worktree-link-target-");
      const unrelated = pathService.join(cwd, "short");
      NodeFS.mkdirSync(unrelated);
      NodeFS.symlinkSync(outside, pathService.join(unrelated, "linked"), "junction");

      yield* Effect.result(driver.removeWorktree({ cwd, path: "short" }));

      assert.isTrue(NodeFS.lstatSync(pathService.join(unrelated, "linked")).isSymbolicLink());
      assert.equal(yield* fileSystem.exists(worktreePath), true);
    }),
  );

  it.effect("force-removes a worktree without deleting what its junctions point to", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
      yield* git(cwd, ["add", ".gitignore"]);
      yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const outside = yield* makeTmpDir("git-worktree-link-target-");
      yield* writeTextFile(outside, "keep.txt", "keep\n");
      const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/linked",
      });
      // Junctions on Windows, the way pnpm links packages; symlinks elsewhere.
      NodeFS.mkdirSync(pathService.join(worktreePath, "node_modules"));
      NodeFS.symlinkSync(
        outside,
        pathService.join(worktreePath, "node_modules", "dep"),
        "junction",
      );
      NodeFS.symlinkSync(outside, pathService.join(worktreePath, "shared"), "junction");

      yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });

      assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), []);
      assert.equal(
        yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
        "keep\n",
      );
    }),
  );

  it.effect("keeps the junctions of a worktree that git refuses to remove", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
      yield* git(cwd, ["add", ".gitignore"]);
      yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
      const pathService = yield* Path.Path;
      const outside = yield* makeTmpDir("git-worktree-link-target-");
      const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/linked",
      });
      const link = pathService.join(worktreePath, "node_modules");
      NodeFS.symlinkSync(outside, link, "junction");
      yield* writeTextFile(worktreePath, "notes.txt", "draft\n");

      const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

      assert.isTrue(Result.isFailure(result));
      assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
      assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), ["linked"]);
    }),
  );

  it.effect("prunes stale registrations when removing an already-gone worktree", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const pathService = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const worktreesRoot = yield* makeTmpDir("git-worktrees-");
      const stalePath = pathService.join(worktreesRoot, "stale");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      yield* driver.createWorktree({
        cwd,
        path: stalePath,
        refName: initialBranch,
        newRefName: "feature/stale",
      });
      yield* fileSystem.remove(stalePath, { recursive: true });

      yield* driver.removeWorktree({
        cwd,
        path: pathService.join(worktreesRoot, "never-registered"),
      });

      const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
      assert.notInclude(registered, "stale");
    }),
  );
});
