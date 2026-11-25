// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeDriverReleasingLock,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
  gitHasReftable,
  commitInitialRepo,
} from "./GitVcsDriverCore.testkit.ts";

it.layer(layerTest)("Git commit context", (it) => {
  it.effect("reads history through a chain of shared clones", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const seed = `${root}/clone-0`;
      yield* fileSystem.makeDirectory(seed);
      yield* initRepoWithCommit(seed);
      let previous = seed;
      for (let index = 1; index <= 6; index += 1) {
        const next = `${root}/clone-${index}`;
        yield* git(root, ["clone", "--quiet", "--shared", previous, next]);
        previous = next;
      }
      // Six shared clones deep is within Git's alternate limit, not one level deeper.
      yield* writeTextFile(previous, "README.md", "changed\n");
      const chained = yield* driver.prepareCommitContext(previous, ["README.md"]);
      assert.include(chained?.stagedSummary ?? "", "M\tREADME.md");
      assert.include(chained?.stagedPatch ?? "", "-# test");
    }),
  );

  it.effect("leaves no objects behind when no commit follows, in a linked worktree too", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir();
      yield* initRepoWithCommit(repo);
      const linked = `${repo}/linked`;
      yield* git(repo, ["worktree", "add", "--quiet", linked]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      for (const cwd of [repo, linked]) {
        yield* writeTextFile(cwd, "README.md", `changed in ${cwd}\n`);
        yield* writeTextFile(cwd, "draft.txt", `drafted in ${cwd}\n`);
        const blobs = [
          yield* git(cwd, ["hash-object", "draft.txt"]),
          yield* git(cwd, ["hash-object", "README.md"]),
        ];
        const context = yield* driver.prepareCommitContext(cwd);
        assert.include(context?.stagedPatch ?? "", `+drafted in ${cwd}`);
        assert.include(context?.stagedPatch ?? "", "-# test");
        for (const blob of blobs) {
          const probe = yield* driver.execute({
            operation: "GitVcsDriver.test.git",
            cwd,
            args: ["cat-file", "-e", blob],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(probe.exitCode, 0, `${blob} stayed in the repository`);
        }
      }
    }),
  );

  it.effect("prepares source patches without running textconv", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["config", "diff.probe.textconv", "touch textconv-ran; echo converted"]);
      yield* writeTextFile(cwd, ".gitattributes", "*.doc diff=probe\n");
      yield* writeTextFile(cwd, "notes.doc", "original source\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "source document"]);
      yield* writeTextFile(cwd, "notes.doc", "updated source\n");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;

      const context = yield* driver.prepareCommitContext(cwd, ["notes.doc"]);

      assert.include(context?.stagedPatch ?? "", "-original source");
      assert.include(context?.stagedPatch ?? "", "+updated source");
      assert.notInclude(context?.stagedPatch ?? "", "converted");
      assert.include(context?.stagedSummary ?? "", "notes.doc");
      assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));
    }),
  );

  it.effect("can omit the patch while preserving change detection and the real index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
      yield* writeTextFile(cwd, "selected.txt", "selected content\n");
      yield* writeTextFile(cwd, "other.txt", "other content\n");
      yield* git(cwd, ["add", "other.txt"]);
      const before = yield* git(cwd, ["diff", "--cached"]);
      const summaryOnly = yield* driver.prepareCommitContext(cwd, ["selected.txt"], {
        includePatch: false,
      });
      assert.include(summaryOnly?.stagedSummary ?? "", "selected.txt");
      assert.notInclude(summaryOnly?.stagedSummary ?? "", "other.txt");
      assert.equal(summaryOnly?.stagedPatch, "");
      const full = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
      assert.equal(full?.stagedSummary, summaryOnly?.stagedSummary);
      assert.include(full?.stagedPatch ?? "", "+selected content");
      assert.equal(yield* git(cwd, ["diff", "--cached"]), before);
    }),
  );

  it.effect.each(["root", "aliased-nested"] as const)(
    "prepares selected files without staging and commits only those files from %s",
    (location) =>
      Effect.gen(function* () {
        const sandbox = yield* makeTmpDir();
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const repository = path.join(sandbox, "repo");
        const nested = path.join(repository, "sub", "dir");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* initRepoWithCommit(repository);
        const cwd = location === "aliased-nested" ? path.join(sandbox, "link") : repository;
        if (location === "aliased-nested") NodeFS.symlinkSync(nested, cwd, "junction");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const selected = "sub/dir/a.txt";
        yield* writeTextFile(repository, selected, "a\n");
        yield* writeTextFile(repository, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, [selected]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");
        assert.equal(yield* git(repository, ["diff", "--cached", "--name-only"]), "");

        const commit = yield* driver.commit(cwd, "Add a", "", {
          stage: { filePaths: [selected] },
        });
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(repository, ["log", "-1", "--pretty=%s"]), "Add a");
        assert.equal(
          yield* git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
          selected,
        );
        const status = yield* git(repository, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
  );

  it.effect("stops a selected-file commit when another process holds the index lock", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* writeTextFile(cwd, "a.txt", "a\n");
      yield* writeTextFile(cwd, "staged.txt", "staged\n");
      yield* git(cwd, ["add", "staged.txt"]);
      const lockPath = (yield* Path.Path).join(cwd, ".git", "index.lock");
      yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
      const { driver } = yield* makeDriverReleasingLock((args) => args.includes("reset"), lockPath);

      const error = yield* driver
        .commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } })
        .pipe(Effect.flip);

      assert.equal(error.operation, "GitVcsDriver.commit.reset");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
      assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
    }),
  );

  it.effect.each([
    { location: "root", ref: "refs/heads/MERGE_HEAD" },
    { location: "nested", ref: "refs/heads/MERGE_HEAD" },
    { location: "worktree", ref: "refs/heads/MERGE_HEAD" },
    { location: "root", ref: "refs/tags/MERGE_HEAD" },
    { location: "nested", ref: "refs/tags/MERGE_HEAD" },
    { location: "worktree", ref: "refs/tags/MERGE_HEAD" },
  ])(
    "commits selected files with a MERGE_HEAD ref and no merge ($location, $ref)",
    ({ location, ref }) =>
      Effect.gen(function* () {
        let cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["update-ref", ref, originalHead]);
        if (location === "worktree") {
          const linked = path.join(yield* makeTmpDir(), "linked");
          yield* git(cwd, ["worktree", "add", "-b", "linked", linked]);
          cwd = linked;
        }
        const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
        yield* fs.makeDirectory(commitCwd, { recursive: true });
        yield* writeTextFile(cwd, "selected.txt", "selected\n");
        yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
        const mergePath = yield* git(commitCwd, ["rev-parse", "--git-path", "MERGE_HEAD"]);
        assert.isFalse(yield* fs.exists(path.resolve(commitCwd, mergePath)));

        yield* driver.commit(commitCwd, "Selected without merge", "", {
          stage: { filePaths: ["selected.txt"] },
        });

        assert.equal(yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]), originalHead);
        assert.equal(yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]), "selected.txt");
        assert.equal(yield* git(cwd, ["rev-parse", ref]), originalHead);
        assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? unrelated.txt");
      }),
  );

  it.effect.each([
    { location: "root", conflict: false, encoding: "utf8" },
    { location: "nested", conflict: false, encoding: "utf8" },
    { location: "worktree", conflict: false, encoding: "utf8" },
    { location: "root", conflict: true, encoding: "utf8" },
    { location: "nested", conflict: true, encoding: "utf8" },
    { location: "worktree", conflict: true, encoding: "utf8" },
    { location: "root", conflict: true, encoding: "utf16le" },
    { location: "root", conflict: true, encoding: "utf16le", large: true },
  ])(
    "rejects selected-file merge commits without mutation ($location, conflict: $conflict, $encoding)",
    ({ location, conflict, encoding, large }) =>
      Effect.gen(function* () {
        let cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const writeReadme = (text: string) =>
          Effect.sync(() =>
            NodeFS.writeFileSync(
              NodePath.join(cwd, "README.md"),
              encoding === "utf16le" ? Buffer.from(`\ufeff${text}`, "utf16le") : text,
            ),
          );
        if (encoding === "utf16le") {
          yield* writeTextFile(
            cwd,
            ".gitattributes",
            "README.md text working-tree-encoding=UTF-16\n",
          );
          yield* writeReadme("base\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Declare UTF-16 encoding"]);
        }
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        if (conflict) yield* writeReadme("feature version\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        const featureHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "main.txt", "main\n");
        if (conflict) yield* writeReadme("main version\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Main"]);
        const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        if (location === "worktree") {
          const worktree = path.join(yield* makeTmpDir(), "linked");
          yield* git(cwd, ["worktree", "add", "-b", "linked", worktree]);
          cwd = worktree;
        }
        const merge = yield* driver.execute({
          operation: "test.merge",
          cwd,
          args: ["merge", "--no-commit", "--no-ff", "feature"],
          allowNonZeroExit: true,
        });
        assert.equal(merge.exitCode, conflict ? 1 : 0);
        yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
        const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
        yield* fs.makeDirectory(commitCwd, { recursive: true });
        const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));
        const files = ["README.md", "feature.txt", "main.txt", "unrelated.txt"];
        const contents = files.map((name) => NodeFS.readFileSync(path.join(cwd, name)));
        const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

        const result = yield* driver
          .commit(commitCwd, "Partial merge", "", { stage: { filePaths: ["feature.txt"] } })
          .pipe(Effect.result);
        if (Result.isSuccess(result)) {
          const parents = yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]);
          assert.fail(
            `Selected merge commit succeeded with parents ${parents}; MERGE_HEAD exists: ${NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD"))}`,
          );
        } else {
          assert.include(result.failure.detail, "Cannot commit selected files during a merge");
          assert.include(result.failure.detail, "Commit all files");
        }
        assert.deepEqual(
          names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
          before,
        );
        assert.deepEqual(
          files.map((name) => NodeFS.readFileSync(path.join(cwd, name))),
          contents,
        );
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

        const resolvedText = `Heading\n=======\n\nresolved${large ? "x".repeat(17 * 1024 * 1024) : ""}\n`;
        if (conflict) {
          const unresolved = yield* driver
            .commit(commitCwd, "Unresolved merge", "", { stage: {} })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(unresolved), "committed an unresolved conflict");
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
          // A lone "=======" is a heading underline, not a conflict boundary.
          yield* writeReadme(resolvedText);
          assert.isNotNull(
            yield* driver.prepareCommitContext(commitCwd, undefined, { includePatch: false }),
          );
        }
        yield* driver.commit(commitCwd, "Finish merge", "", { stage: {} });
        assert.equal(
          yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
          `${mainHead} ${featureHead}`,
        );
        assert.isFalse(NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD")));
        assert.equal(yield* git(cwd, ["show", "HEAD:feature.txt"]), "feature");
        assert.equal(yield* git(cwd, ["show", "HEAD:unrelated.txt"]), "unrelated");
        if (large) {
          assert.equal(
            yield* git(cwd, ["cat-file", "-s", "HEAD:README.md"]),
            String(Buffer.byteLength(resolvedText)),
          );
        } else if (conflict)
          assert.equal(yield* git(cwd, ["show", "HEAD:README.md"]), "Heading\n=======\n\nresolved");
      }),
  );

  it.effect("reports a merge resolved to HEAD's tree as committable", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // A branch named MERGE_HEAD is not a merge in progress.
      yield* git(cwd, ["branch", "MERGE_HEAD"]);
      assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
      yield* git(cwd, ["branch", "-D", "MERGE_HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "README.md", "feature version\n");
      yield* git(cwd, ["commit", "-am", "Feature"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "README.md", "main version\n");
      yield* git(cwd, ["commit", "-am", "Main"]);
      const merge = yield* driver.execute({
        operation: "test.merge",
        cwd,
        args: ["merge", "feature"],
        allowNonZeroExit: true,
      });
      assert.equal(merge.exitCode, 1);
      yield* writeTextFile(cwd, "README.md", "main version\n");

      assert.isNotNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
    }),
  );

  it.effect.each([
    { operation: "cherry-pick", head: "CHERRY_PICK_HEAD", refs: "files" },
    { operation: "revert", head: "REVERT_HEAD", refs: "files" },
    // Reftable keeps CHERRY_PICK_HEAD and REVERT_HEAD as refs with no file under .git.
    { operation: "cherry-pick", head: "CHERRY_PICK_HEAD", refs: "reftable" },
    { operation: "revert", head: "REVERT_HEAD", refs: "reftable" },
  ])(
    "rejects selected-file commits during a $operation ($refs)",
    ({ operation, head, refs }, ctx) =>
      Effect.gen(function* () {
        if (refs === "reftable" && !gitHasReftable)
          return ctx.skip("Needs Git 2.45 or later for reftable.");
        const cwd = yield* makeTmpDir();
        if (refs === "reftable") yield* commitInitialRepo(cwd, ["--ref-format=reftable"]);
        else yield* initRepoWithCommit(cwd);
        // Reftable leaves .git/HEAD as a stub, so ask Git for the branch.
        const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["checkout", "-b", "other"]);
        yield* writeTextFile(cwd, "README.md", "other version\n");
        yield* writeTextFile(cwd, "picked.txt", "picked\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Other"]);
        if (operation === "cherry-pick") yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "README.md", "main version\n");
        yield* git(cwd, ["commit", "-am", "Main"]);
        const originalHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["branch", head]);
        const result = yield* driver.execute({
          operation: `test.${operation}`,
          cwd,
          args: [operation, operation === "cherry-pick" ? "other" : "HEAD~1"],
          allowNonZeroExit: true,
        });
        assert.equal(result.exitCode, 1);
        yield* writeTextFile(cwd, "README.md", "resolved version\n");
        yield* git(cwd, ["add", "README.md"]);
        const selected = operation === "cherry-pick" ? "picked.txt" : "README.md";

        const commit = yield* driver
          .commit(cwd, "Partial", "", { stage: { filePaths: [selected] } })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(commit), `Selected-file ${operation} commit succeeded`);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), originalHead);
        assert.equal(
          yield* git(cwd, [
            "-c",
            "core.warnAmbiguousRefs=false",
            "rev-parse",
            "--verify",
            "--symbolic-full-name",
            head,
          ]),
          head,
        );
      }),
  );

  it.effect("rejects selected-file commits during a multi-commit no-commit cherry-pick", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const path = yield* Path.Path;
      yield* writeTextFile(cwd, "a.txt", "base a\n");
      yield* writeTextFile(cwd, "b.txt", "base b\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Base"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "a.txt", "feature a\n");
      yield* writeTextFile(cwd, "b.txt", "feature b\n");
      yield* git(cwd, ["commit", "-am", "Feature one"]);
      yield* writeTextFile(cwd, "later.txt", "later\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Feature two"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "a.txt", "main a\n");
      yield* writeTextFile(cwd, "b.txt", "main b\n");
      yield* git(cwd, ["commit", "-am", "Main"]);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const started = yield* driver.execute({
        operation: "test.sequencer",
        cwd,
        args: ["cherry-pick", "--no-commit", "feature~1", "feature"],
        allowNonZeroExit: true,
      });
      assert.equal(started.exitCode, 1);
      yield* writeTextFile(cwd, "a.txt", "resolved a\n");
      const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
      assert.isFalse(NodeFS.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")));
      const names = ["index", "sequencer/todo", "sequencer/head"];
      const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));

      const error = yield* driver
        .commit(cwd, "Partial", "", { stage: { filePaths: ["a.txt"] } })
        .pipe(Effect.flip);
      assert.include(error.detail, "Cannot commit selected files during a cherry-pick or revert");
      assert.deepEqual(
        names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
        before,
      );
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
    }),
  );

  it.effect("treats selected file paths literally", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
      yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

      const context = yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

      assert.include(context?.stagedSummary ?? "", "selected[1].txt");
      assert.notInclude(context?.stagedSummary ?? "", "selected1.txt");
      assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
      yield* driver.commit(cwd, "Add literal path", "", {
        stage: { filePaths: ["selected[1].txt"] },
      });
      assert.equal(
        yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
        "selected[1].txt",
      );

      const status = yield* git(cwd, ["status", "--porcelain"]);
      assert.include(status, "?? selected1.txt");
    }),
  );

  const commitWithHooks = (hooks: Record<string, string>) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const [name, script] of Object.entries(hooks)) {
        yield* writeTextFile(cwd, `.git/hooks/${name}`, `#!/bin/sh\n${script}\n`);
        yield* fs.chmod(path.join(cwd, ".git/hooks", name), 0o755);
      }
      yield* writeTextFile(cwd, "a.txt", "a\n");
      const events: string[] = [];
      const result = yield* (yield* GitVcsDriver.GitVcsDriver)
        .commit(cwd, "Add a", "", {
          stage: { filePaths: ["a.txt"] },
          progress: {
            onHookStarted: (hookName) => Effect.sync(() => void events.push(`start ${hookName}`)),
            onHookFinished: ({ hookName, exitCode }) =>
              Effect.sync(() => void events.push(`finish ${hookName} ${exitCode}`)),
          },
        })
        .pipe(Effect.result);
      return { events, committed: Result.isSuccess(result) };
    });

  it.effect("reports each commit hook finishing with its exit code", () =>
    Effect.gen(function* () {
      // The pre-commit hook runs git, whose own children reuse child_id 0 in the shared trace.
      const { events, committed } = yield* commitWithHooks({
        "pre-commit": "git -c alias.noop='!false' noop\nexit 0",
        "commit-msg": "exit 0",
      });
      assert.isTrue(committed);
      assert.deepEqual(events, [
        "start pre-commit",
        "finish pre-commit 0",
        "start commit-msg",
        "finish commit-msg 0",
      ]);
    }),
  );

  it.effect("reports the exit code of a commit hook that rejects the commit", () =>
    Effect.gen(function* () {
      const { events, committed } = yield* commitWithHooks({ "commit-msg": "exit 3" });
      assert.isFalse(committed);
      assert.deepEqual(events, ["start commit-msg", "finish commit-msg 3"]);
    }),
  );

  it.effect.each([false, true])(
    "preserves partial staging and split-index files (split: %s)",
    (split) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        if (split) yield* git(cwd, ["config", "core.splitIndex", "true"]);
        yield* writeTextFile(cwd, "README.md", "# test\nstaged\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* writeTextFile(cwd, "README.md", "# test\nstaged\nunstaged\n");
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
        const before = NodeFS.readFileSync(`${cwd}/.git/index`);
        const shared = NodeFS.readdirSync(`${cwd}/.git`).filter((name) =>
          name.startsWith("sharedindex."),
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const paths of [undefined, ["README.md"]]) {
          const context = yield* driver.prepareCommitContext(cwd, paths);
          assert.include(context?.stagedPatch ?? "", "unstaged");
          assert.notInclude(context?.stagedSummary ?? "", "ignored.txt");
          assert.deepEqual(NodeFS.readFileSync(`${cwd}/.git/index`), before);
          assert.deepEqual(
            NodeFS.readdirSync(`${cwd}/.git`).filter((name) => name.startsWith("sharedindex.")),
            shared,
          );
        }
      }),
  );

  it.effect("prepares an unborn repository without creating a real index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "initial.txt", "initial\n");
      for (const paths of [undefined, ["initial.txt"]]) {
        const context = yield* driver.prepareCommitContext(cwd, paths);
        assert.include(context?.stagedSummary ?? "", "initial.txt");
        assert.isFalse(NodeFS.existsSync(`${cwd}/.git/index`));
      }
      yield* driver.commit(cwd, "Initial", "", { stage: { filePaths: ["initial.txt"] } });
      assert.equal(yield* git(cwd, ["show", "HEAD:initial.txt"]), "initial");
    }),
  );

  it.effect("preserves merge metadata while preparing selected and all files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Feature"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* git(cwd, ["merge", "--no-commit", "--no-ff", "feature"]);
      yield* writeTextFile(cwd, "README.md", "# test\nmerge edit\n");
      const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
      const before = names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`));
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const paths of [undefined, ["README.md"]]) {
        yield* driver.prepareCommitContext(cwd, paths);
        assert.deepEqual(
          names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`)),
          before,
        );
      }
    }),
  );
});
