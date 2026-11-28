// @effect-diagnostics nodeBuiltinImport:off - Git clone URLs use the host file URL encoding.
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GitCommandError } from "@t3tools/contracts/git";
import {
  ReviewDiffPreviewInput,
  type ReviewDiffFileContentsInput,
  type ReviewDiffPreviewResult,
} from "@t3tools/contracts/review";
import { makeGitVcsDriverCore, splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import {
  layerServerConfig,
  layerTest,
  makeNonRepositoryHandle,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

const makeReviewDiffFileContentsInput = (
  cwd: string,
  overrides: Partial<Omit<ReviewDiffFileContentsInput, "cwd">> = {},
): ReviewDiffFileContentsInput => ({
  cwd,
  sourceKind: "working-tree",
  changeType: "change",
  baseRef: "HEAD",
  headRef: null,
  oldPath: "README.md",
  newPath: "README.md",
  ...overrides,
});

it.layer(layerTest)("Git review previews", (it) => {
  it.effect("diffs a root commit against the empty tree but rejects a shallow boundary", () =>
    Effect.gen(function* () {
      const upstream = yield* makeTmpDir();
      yield* initRepoWithCommit(upstream);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const emptyTree = yield* git(upstream, ["hash-object", "-t", "tree", "/dev/null"]);
      const root = yield* git(upstream, ["rev-parse", "HEAD"]);
      const rootSource = (yield* driver.getReviewDiffPreview({ cwd: upstream, commitSha: root }))
        .sources[0]!;
      assert.equal(rootSource.baseRef, emptyTree);
      assert.include(rootSource.diff, "+# test");

      yield* writeTextFile(upstream, "README.md", "# boundary\n");
      yield* git(upstream, ["commit", "-am", "boundary"]);
      const sha = yield* git(upstream, ["rev-parse", "HEAD"]);
      const cwd = yield* makeTmpDir();
      yield* git(upstream, ["clone", "--depth=1", NodeURL.pathToFileURL(upstream).href, cwd], {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      });
      assert.equal(yield* git(cwd, ["rev-parse", "--is-shallow-repository"]), "true");
      for (const request of [
        driver.getReviewDiffPreview({ cwd, commitSha: sha }),
        driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "commit",
            changeType: "new",
            headRef: sha,
            baseRef: emptyTree,
          }),
        ),
      ]) {
        const error = yield* Effect.asVoid<unknown, GitCommandError, never>(request).pipe(
          Effect.flip,
        );
        assert.include(error.detail, "parent");
      }
    }),
  );

  it.effect("lists the branch's commits newest first, at most 100, and flags the rest", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const branch = "feature/commits";
      const history = Array.from({ length: 102 }, (_, index) => {
        const subject = `feature ${index}\n`;
        return [
          `commit refs/heads/${branch}`,
          `committer Test User <test@example.com> ${index + 1} +0000`,
          `data ${Buffer.byteLength(subject)}`,
          subject,
          ...(index === 0 ? [`from refs/heads/${initialBranch}^0`] : []),
          "",
        ].join("\n");
      }).join("\n");
      yield* driver.execute({
        operation: "GitVcsDriver.test.importBranchCommits",
        cwd,
        args: ["fast-import", "--quiet"],
        stdin: history,
      });
      yield* git(cwd, ["checkout", branch]);

      const result = yield* driver.getReviewBranchCommits({ cwd, baseRef: initialBranch });
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.commits.length, 100);
      assert.strictEqual(result.commits[0]?.sha, yield* git(cwd, ["rev-parse", "HEAD"]));
      assert.deepStrictEqual(
        [result.commits[0]?.subject, result.commits[99]?.subject],
        ["feature 101", "feature 2"],
      );
    }),
  );

  it.effect("previews one selected commit, a merge against its first parent", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "-b", "feature/merge-preview"]);
      yield* git(cwd, ["checkout", "-b", "feature/side"]);
      yield* writeTextFile(cwd, "README.md", "# side commit\n");
      yield* git(cwd, ["add", "README.md"]);
      yield* git(cwd, ["commit", "-m", "side change"]);
      yield* git(cwd, ["checkout", "feature/merge-preview"]);
      yield* writeTextFile(cwd, "feature.txt", "feature commit\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature change"]);
      const firstParent = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["merge", "--no-ff", "--no-edit", "feature/side"]);
      const mergeSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature/elsewhere", initialBranch]);
      yield* writeTextFile(cwd, "elsewhere.txt", "elsewhere\n");
      yield* git(cwd, ["add", "elsewhere.txt"]);
      yield* git(cwd, ["commit", "-m", "elsewhere change"]);
      const elsewhereSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["checkout", "feature/merge-preview"]);
      yield* writeTextFile(cwd, "README.md", "# dirty tree\n");

      const elsewhere = yield* driver.getReviewDiffPreview({ cwd, commitSha: elsewhereSha });
      assert.deepStrictEqual(
        elsewhere.sources
          .find((candidate) => candidate.kind === "commit")
          ?.files?.map((file) => file.path),
        ["elsewhere.txt"],
      );

      const preview = yield* driver.getReviewDiffPreview({
        cwd,
        baseRef: initialBranch,
        commitSha: mergeSha,
      });
      const source = preview.sources.find((candidate) => candidate.kind === "commit")!;
      assert.strictEqual(source.baseRef, firstParent);
      assert.strictEqual(source.headRef, mergeSha);
      assert.deepStrictEqual(
        source.files?.map((file) => file.path),
        ["README.md"],
      );
      assert.include(source.diff, "+# side commit");
      assert.notInclude(source.diff, "dirty tree");
      assert.notInclude(source.diff, "feature.txt");

      const patch = yield* driver.getReviewDiffPreview({
        cwd,
        baseRef: initialBranch,
        commitSha: mergeSha,
        file: { path: "README.md", previousPath: null, sourceKind: "commit" },
      });
      assert.include(
        patch.sources.find((candidate) => candidate.kind === "commit")!.diff,
        "+# side commit",
      );
      const contents = yield* driver.getReviewDiffFileContents(
        makeReviewDiffFileContentsInput(cwd, {
          sourceKind: "commit",
          baseRef: source.baseRef,
          headRef: source.headRef,
        }),
      );
      assert.deepStrictEqual(contents, {
        oldContents: "# test\n",
        newContents: "# side commit\n",
      });
    }),
  );

  it.effect("loads repository-relative files from a nested project directory", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature/nested"]);
      yield* writeTextFile(cwd, "nested/tracked.txt", "committed\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "nested file"]);
      yield* writeTextFile(cwd, "nested/tracked.txt", "changed\n");
      yield* writeTextFile(cwd, "untracked.txt", "new\n");
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const nestedCwd = path.join(cwd, "nested");
      const preview = yield* driver.getReviewDiffPreview({
        cwd: nestedCwd,
        baseRef: initialBranch,
      });
      assert.equal(
        preview.sources.find((source) => source.kind === "working-tree")!.files!.length,
        2,
      );
      for (const source of preview.sources) {
        for (const file of source.files ?? []) {
          const scoped = yield* driver.getReviewDiffPreview({
            cwd: nestedCwd,
            baseRef: initialBranch,
            file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
          });
          const patch = scoped.sources.find((item) => item.kind === source.kind)!;
          assert.deepStrictEqual(patch.files, [file]);
          assert.include(patch.diff, `b/${file.path}`);
        }
      }
    }),
  );

  it.effect("reads complete tracked and untracked manifests beyond 1 MB", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const mergeBase = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* writeTextFile(cwd, "untracked.txt", "untracked content\n");
      const paths = Array.from({ length: 5000 }, (_, index) => `${"a".repeat(220)}-${index}.txt`);
      const stats = paths.map((path) => `1\t0\t${path}\0`).join("");
      const untracked = [...paths, "untracked.txt"].join("\0") + "\0";
      assert.isAbove(stats.length, 1024 * 1024);
      assert.isAbove(untracked.length, 1024 * 1024);
      let readLargeUntracked = false;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) {
          if (command.args.includes("--numstat") && command.args.includes(mergeBase)) {
            return Effect.succeed(makeSuccessfulHandle(stats));
          }
          if (command.args.includes("ls-files") && command.args.includes("--others")) {
            return Effect.succeed(makeSuccessfulHandle(readLargeUntracked ? untracked : ""));
          }
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const branch = yield* driver.getReviewDiffPreview({
        cwd,
        baseRef: initialBranch,
      });
      const files = branch.sources.find((source) => source.kind === "branch-range")!.files!;
      assert.equal(files.length, paths.length);
      assert.equal(files.at(-1)?.path, paths.at(-1));
      assert.equal(
        files.reduce((total, file) => total + file.additions, 0),
        paths.length,
      );
      readLargeUntracked = true;
      const dirty = yield* driver.getReviewDiffPreview({
        cwd,
        file: { path: "untracked.txt", previousPath: null, sourceKind: "working-tree" },
      });
      const source = dirty.sources.find((source) => source.kind === "working-tree")!;
      assert.deepStrictEqual(source.files, [
        { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.include(source.diff, "+untracked content");
    }),
  );

  it.effect("propagates patch failures instead of reporting an empty complete diff", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "README.md", "changed\n");
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.args.includes("--patch")
          ? Effect.succeed(makeNonRepositoryHandle())
          : delegate.spawn(command),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const result = yield* driver.getReviewDiffPreview({ cwd }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure.operation, "GitVcsDriver.getReviewDiffPreview.patch");
      }
    }),
  );

  it.effect("drops an unterminated path from truncated NUL-separated git output", () =>
    Effect.sync(() => {
      const paths = splitNullSeparatedGitStdoutPaths({
        stdout: "complete.txt\0partial",
        stdoutTruncated: true,
      });

      assert.deepStrictEqual(paths, ["complete.txt"]);
    }),
  );

  it.effect("keeps a/ and b/ patch prefixes when the repository disables them", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["config", "diff.noprefix", "true"]);
      yield* git(cwd, ["config", "diff.mnemonicPrefix", "true"]);
      yield* git(cwd, ["checkout", "-b", "feature/noprefix"]);
      yield* writeTextFile(cwd, "README.md", "# committed change\n");
      yield* git(cwd, ["add", "README.md"]);
      yield* git(cwd, ["commit", "-m", "committed change"]);
      yield* writeTextFile(cwd, "README.md", "# dirty change\n");
      yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

      const preview = yield* driver.getReviewDiffPreview({
        cwd,
        baseRef: initialBranch,
        ignoreWhitespace: false,
      });

      const workingTree = preview.sources.find((source) => source.kind === "working-tree")?.diff;
      const branchRange = preview.sources.find((source) => source.kind === "branch-range")?.diff;
      assert.include(workingTree, "diff --git a/README.md b/README.md");
      assert.include(workingTree, "+++ b/untracked.txt");
      assert.include(branchRange, "diff --git a/README.md b/README.md");
    }),
  );

  it.effect("keeps untracked filenames with pathspec magic in the review", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const literalPath = isWindowsHost ? "[a]fter.ts" : ":(exclude)after.ts";
      yield* writeTextFile(cwd, literalPath, "literal pathspec contents\n");
      yield* writeTextFile(cwd, "after.ts", "ordinary contents\n");
      const indexBefore = yield* git(cwd, ["ls-files", "--stage"]);

      const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
      const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

      assert.include(diff, "+literal pathspec contents");
      assert.include(diff, "+ordinary contents");
      const scoped = yield* driver.getReviewDiffPreview({
        cwd,
        file: {
          path: literalPath,
          previousPath: null,
          sourceKind: "working-tree",
        },
      });
      const scopedSource = scoped.sources.find((source) => source.kind === "working-tree")!;
      assert.deepStrictEqual(scopedSource.files, [
        { path: literalPath, previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.include(scopedSource.diff, "+literal pathspec contents");
      assert.notInclude(scopedSource.diff, "diff --git a/after.ts b/after.ts");
      assert.notInclude(scopedSource.diff, "+ordinary contents");
      assert.strictEqual(yield* git(cwd, ["ls-files", "--stage"]), indexBefore);
    }),
  );

  it.effect("detects an unstaged rename with edits without mutating a split index", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "before.ts", "one\ntwo\nthree\nfour\nfive\n");
      yield* git(cwd, ["add", "before.ts"]);
      yield* git(cwd, ["commit", "-m", "add source file"]);
      yield* git(cwd, ["config", "core.splitIndex", "true"]);
      yield* git(cwd, ["config", "splitIndex.sharedIndexExpire", "now"]);
      yield* git(cwd, ["update-index", "--split-index"]);
      const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
      const indexHashBefore = yield* git(cwd, ["hash-object", indexPath]);
      const gitDirValue = yield* git(cwd, ["rev-parse", "--git-dir"]);
      const gitDir = pathService.isAbsolute(gitDirValue)
        ? gitDirValue
        : pathService.resolve(cwd, gitDirValue);
      const sharedIndexesBefore = (yield* fileSystem.readDirectory(gitDir))
        .filter((entry) => entry.startsWith("sharedindex."))
        .sort();
      yield* fileSystem.rename(
        pathService.join(cwd, "before.ts"),
        pathService.join(cwd, "after.ts"),
      );
      yield* writeTextFile(cwd, "after.ts", "one\ntwo\nTHREE\nfour\nfive\n");

      const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
      const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";
      const indexHashAfter = yield* git(cwd, ["hash-object", indexPath]);
      const sharedIndexesAfter = (yield* fileSystem.readDirectory(gitDir))
        .filter((entry) => entry.startsWith("sharedindex."))
        .sort();

      const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
      assert.deepStrictEqual(source.files, [
        { path: "after.ts", previousPath: "before.ts", additions: 1, deletions: 1 },
      ]);
      const scoped = yield* driver.getReviewDiffPreview({
        cwd,
        file: { path: "after.ts", previousPath: "before.ts", sourceKind: "working-tree" },
      });
      const scopedSource = scoped.sources.find((candidate) => candidate.kind === "working-tree")!;
      assert.deepStrictEqual(scopedSource.files, source.files);
      assert.equal(scopedSource.diff, diff);
      assert.include(diff, "rename from before.ts");
      assert.include(diff, "rename to after.ts");
      assert.include(diff, "-three");
      assert.include(diff, "+THREE");
      assert.strictEqual(diff.match(/^diff --git /gm)?.length, 1);
      assert.strictEqual(indexHashAfter, indexHashBefore);
      assert.deepStrictEqual(sharedIndexesAfter, sharedIndexesBefore);
    }),
  );

  it.effect("keeps tracked changes visible when untracked discovery fails", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const failingLsFilesSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("expected a standard Git command");
        }
        return command.args[0] === "ls-files" && command.args[1] === "--others"
          ? Effect.succeed(makeNonRepositoryHandle())
          : delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingLsFilesSpawner),
        Effect.provide(layerServerConfig),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* writeTextFile(cwd, "README.md", "# tracked change\n");

      const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
      const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

      assert.include(diff, "-# test");
      assert.include(diff, "+# tracked change");
    }),
  );

  it.effect("preserves a staged deletion when the removed path still exists", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "removed.txt", "remove me\n");
      yield* git(cwd, ["add", "removed.txt"]);
      yield* git(cwd, ["commit", "-m", "add removable file"]);
      yield* git(cwd, ["rm", "--cached", "removed.txt"]);

      const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
      const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";

      assert.include(diff, "deleted file mode");
      assert.include(diff, "-remove me");
      assert.notInclude(diff, "new file mode");
    }),
  );

  it.effect.each([false, true])(
    "keeps the preceding second cached in review previews (split: %s)",
    (splitIndex) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, ".gitattributes", "stable.txt filter=probe\n");
        yield* writeTextFile(cwd, "stable.txt", "unchanged\n");
        yield* writeTextFile(
          cwd,
          ".git/filter.cjs",
          'require("node:fs").appendFileSync(".git/filter-runs", "read\\n"); process.stdin.pipe(process.stdout);',
        );
        yield* git(cwd, ["config", "filter.probe.clean", "node .git/filter.cjs"]);
        yield* fs.utimes(path.join(cwd, "stable.txt"), 1_699_999_999.5, 1_699_999_999.5);
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "cache stable file"]);
        if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
        const indexPath = path.join(cwd, ".git", "index");
        yield* fs.utimes(indexPath, 1_700_000_000, 1_700_000_000);
        const originalIndex = yield* fs.readFile(indexPath);
        const originalMtime = (yield* fs.stat(indexPath)).mtime;
        yield* writeTextFile(cwd, ".git/filter-runs", "");
        yield* writeTextFile(cwd, "untracked.txt", "new\n");
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        assert.deepStrictEqual(
          preview.sources.find((source) => source.kind === "working-tree")!.files,
          [{ path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 }],
        );
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/filter-runs")), "");
        assert.deepStrictEqual(yield* fs.readFile(indexPath), originalIndex);
        assert.deepStrictEqual((yield* fs.stat(indexPath)).mtime, originalMtime);
      }),
  );

  it.effect.each([
    [1_700_000_000, false],
    [1_700_000_000.9999, false],
    [1_700_000_000, true],
    [1_700_000_000.9999, true],
  ] as const)(
    "preserves same-size edits with a racy review index (%s, split: %s)",
    ([timestamp, splitIndex]) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const filePath = path.join(cwd, "tracked.txt");
        const indexPath = path.join(cwd, ".git", "index");
        yield* git(cwd, ["config", "core.trustctime", "false"]);
        yield* writeTextFile(cwd, "tracked.txt", "before\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* git(cwd, ["commit", "-m", "record racy file"]);
        if (splitIndex) yield* git(cwd, ["update-index", "--split-index"]);
        yield* fileSystem.utimes(indexPath, timestamp, timestamp);
        const originalIndex = yield* fileSystem.readFile(indexPath);
        const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
        yield* writeTextFile(cwd, "tracked.txt", "after!\n");
        yield* fileSystem.utimes(filePath, timestamp, timestamp);
        yield* writeTextFile(cwd, "untracked.txt", "new\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(dirty.files, [
          { path: "tracked.txt", previousPath: null, additions: 1, deletions: 1 },
          { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.include(dirty.diff, "-before");
        assert.include(dirty.diff, "+after!");
        assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
        assert.deepStrictEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
      }),
  );

  it.effect("keeps complete stats for files beyond the combined patch limit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const largeContents = "a long line of changed content for the diff preview\n".repeat(4000);
      yield* git(cwd, ["checkout", "-b", "feature/large"]);
      yield* writeTextFile(cwd, "a-large.txt", largeContents);
      yield* writeTextFile(cwd, "z-last.txt", "last file\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "large change"]);
      yield* writeTextFile(cwd, "a-large.txt", largeContents.replaceAll("changed", "updated"));
      yield* writeTextFile(cwd, "z-last.txt", "last file updated\n");
      yield* writeTextFile(cwd, "untracked.txt", largeContents);

      const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
      const branch = preview.sources.find((source) => source.kind === "branch-range")!;
      const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
      assert.isTrue(branch.truncated);
      assert.isTrue(dirty.truncated);
      assert.notInclude(branch.diff, "z-last.txt");
      for (const source of [branch, dirty]) {
        for (const file of source.files ?? []) {
          const individual = yield* driver.getReviewDiffPreview({
            cwd,
            baseRef: initialBranch,
            file: { path: file.path, previousPath: file.previousPath, sourceKind: source.kind },
          });
          const patch = individual.sources.find((candidate) => candidate.kind === source.kind)!;
          assert.isFalse(patch.truncated);
          assert.deepStrictEqual(patch.files, [file]);
          assert.include(patch.diff, `b/${file.path}`);
          assert.isEmpty(
            individual.sources.find((candidate) => candidate.kind !== source.kind)!.diff,
          );
        }
      }

      assert.deepStrictEqual(branch.files, [
        { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 0 },
        { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
        { path: "z-last.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.deepStrictEqual(dirty.files, [
        { path: "a-large.txt", previousPath: null, additions: 4000, deletions: 4000 },
        { path: "untracked.txt", previousPath: null, additions: 4000, deletions: 0 },
        { path: "z-last.txt", previousPath: null, additions: 1, deletions: 1 },
      ]);
    }),
  );
});

it.layer(layerTest)("Git review file contents and range patches", (it) => {
  it.effect("preserves renames, unusual paths, modes, and binary statistics", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "mode-only.sh", "echo unchanged\n");
      yield* git(cwd, ["add", "mode-only.sh"]);
      yield* git(cwd, ["commit", "-m", "add executable candidate"]);
      yield* git(cwd, ["checkout", "-b", "feature/paths"]);
      yield* git(cwd, ["mv", "README.md", "renamed.md"]);
      yield* writeTextFile(cwd, "[literal].txt", "literal\n");
      yield* writeTextFile(cwd, " leading.txt", "whitespace path\n");
      yield* writeTextFile(cwd, "l.txt", "other\n");
      yield* writeTextFile(cwd, "binary.dat", "binary\0data");
      if ((yield* HostProcess.Platform) !== "win32") {
        yield* writeTextFile(cwd, "tab\tand\nnewline.txt", "unusual path\n");
      }
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["update-index", "--chmod=+x", "mode-only.sh"]);
      yield* git(cwd, ["commit", "-m", "rename and add files"]);
      const preview = yield* driver.getReviewDiffPreview({
        cwd,
        baseRef: initialBranch,
      });
      const branch = preview.sources.find((source) => source.kind === "branch-range")!;
      const decodeReviewDiffPreviewInput = Schema.decodeEffect(ReviewDiffPreviewInput);

      for (const path of ["renamed.md", "[literal].txt", " leading.txt", "mode-only.sh"]) {
        const stat = branch.files!.find((file) => file.path === path)!;
        const request = yield* decodeReviewDiffPreviewInput({
          cwd,
          baseRef: initialBranch,
          file: { path, previousPath: stat.previousPath, sourceKind: "branch-range" },
        });
        const result = yield* driver.getReviewDiffPreview(request);
        const scoped = result.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(scoped.files, [stat]);
        assert.notInclude(scoped.diff, "b/l.txt");
        if (path === "renamed.md") assert.include(scoped.diff, "rename from README.md");
        if (path === "mode-only.sh") {
          assert.include(scoped.diff, "old mode 100644");
          assert.include(scoped.diff, "new mode 100755");
        }
      }
      assert.include(branch.diff, "rename from README.md");
      assert.include(branch.diff, "rename to renamed.md");
      assert.deepInclude(branch.files ?? [], {
        path: "renamed.md",
        previousPath: "README.md",
        additions: 0,
        deletions: 0,
      });
      assert.deepInclude(branch.files ?? [], {
        path: "binary.dat",
        previousPath: null,
        additions: 0,
        deletions: 0,
      });
      if ((yield* HostProcess.Platform) !== "win32") {
        assert.deepInclude(branch.files ?? [], {
          path: "tab\tand\nnewline.txt",
          previousPath: null,
          additions: 1,
          deletions: 0,
        });
      }
    }),
  );

  it.effect("reports staged and untracked changes before the first commit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init"]);
      yield* writeTextFile(cwd, "staged.txt", "staged\n");
      yield* git(cwd, ["add", "staged.txt"]);
      yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const dirty = preview.sources.find((source) => source.kind === "working-tree")!;
      assert.deepStrictEqual(dirty.files, [
        { path: "staged.txt", previousPath: null, additions: 1, deletions: 0 },
        { path: "untracked.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.include(dirty.diff, "b/staged.txt");
      assert.include(dirty.diff, "b/untracked.txt");
    }),
  );

  it.effect("loads full file contents for working-tree diff expansion", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "nested/.keep", "");
      yield* writeTextFile(cwd, "README.md", "# changed\nunchanged context\n");

      const contents = yield* driver.getReviewDiffFileContents(
        makeReviewDiffFileContentsInput(pathService.join(cwd, "nested")),
      );

      assert.strictEqual(contents.oldContents, "# test\n");
      assert.strictEqual(contents.newContents, "# changed\nunchanged context\n");
    }),
  );

  it.effect.each([
    { scenario: "kept", before: "\uFEFFold\n", after: "\uFEFFnew\n" },
    { scenario: "added", before: "same\n", after: "\uFEFFsame\n" },
    { scenario: "removed", before: "\uFEFFsame\n", after: "same\n" },
  ])("preserves byte-order marks in diff expansion when $scenario", ({ before, after }) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "README.md", before);
      yield* git(cwd, ["commit", "-am", "write original contents"]);
      yield* writeTextFile(cwd, "README.md", after);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const contents = yield* driver.getReviewDiffFileContents(
        makeReviewDiffFileContentsInput(cwd),
      );

      assert.deepStrictEqual(contents, { oldContents: before, newContents: after });
    }),
  );

  it.effect("reads a base ref that looks like an option as a revision", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const output = (yield* Path.Path).join(yield* makeTmpDir(), "out");

      yield* driver
        .getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, { baseRef: `--output=${output}` }),
        )
        .pipe(Effect.flip);
      yield* driver.readRangeContext(cwd, `--output=${output}`).pipe(Effect.flip);

      assert.isFalse(yield* fileSystem.exists(`${output}:README.md`));
      assert.isFalse(yield* fileSystem.exists(`${output}..HEAD`));
    }),
  );

  it.effect("reads range patches from source without running textconv", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["config", "diff.probe.textconv", "touch textconv-ran; echo converted"]);
      yield* git(cwd, ["checkout", "-b", "feature/range"]);
      yield* writeTextFile(cwd, ".gitattributes", "*.doc diff=probe\n");
      yield* writeTextFile(cwd, "notes.doc", "source line\n");
      yield* writeTextFile(cwd, "plain.txt", "plain line\n");
      yield* writeTextFile(cwd, "binary.dat", "binary\0data");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "range files"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;

      const context = yield* driver.readRangeContext(cwd, initialBranch);

      assert.include(context.diffPatch, "+source line");
      assert.notInclude(context.diffPatch, "converted");
      assert.include(context.diffPatch, "+plain line");
      assert.include(context.diffPatch, "Binary files /dev/null and b/binary.dat differ");
      assert.include(context.diffSummary, "notes.doc");
      assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));

      yield* writeTextFile(cwd, "notes.doc", "updated source line\n");
      const staged = yield* driver.prepareCommitContext(cwd, ["notes.doc"]);
      assert.include(staged?.stagedPatch ?? "", "+updated source line");
      assert.notInclude(staged?.stagedPatch ?? "", "converted");
      assert.include(staged?.stagedSummary ?? "", "notes.doc");
      assert.isFalse(yield* fileSystem.exists(`${cwd}/textconv-ran`));
    }),
  );

  it.effect("loads new and deleted files without reading their missing side", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* writeTextFile(cwd, "added.ts", "export const added = true;\n");
      yield* fileSystem.remove(pathService.join(cwd, "README.md"));

      const [added, deleted] = yield* Effect.all([
        driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            changeType: "new",
            oldPath: "added.ts",
            newPath: "added.ts",
          }),
        ),
        driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, { changeType: "deleted" }),
        ),
      ]);

      assert.deepStrictEqual(added, {
        oldContents: "",
        newContents: "export const added = true;\n",
      });
      assert.deepStrictEqual(deleted, {
        oldContents: "# test\n",
        newContents: "",
      });
    }),
  );

  it.effect("loads merge-base and disk contents for Changes expansion", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "-b", "feature/context"]);
      yield* writeTextFile(cwd, "README.md", "# branch change\nunchanged context\n");
      yield* git(cwd, ["add", "README.md"]);
      yield* git(cwd, ["commit", "-m", "change readme"]);
      yield* writeTextFile(cwd, "README.md", "# dirty change\nunchanged context\n");

      const contents = yield* driver.getReviewDiffFileContents(
        makeReviewDiffFileContentsInput(cwd, {
          sourceKind: "branch-range",
          baseRef: initialBranch,
          headRef: "feature/context",
        }),
      );

      assert.strictEqual(contents.oldContents, "# test\n");
      assert.strictEqual(contents.newContents, "# dirty change\nunchanged context\n");
    }),
  );
});

it.layer(layerTest)("Git branch comparisons", (it) => {
  it.effect("Changes combines commits, uncommitted edits, and untracked files", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const sourceFiles = (
        preview: ReviewDiffPreviewResult,
        kind: "working-tree" | "branch-range",
      ) => preview.sources.find((source) => source.kind === kind)!.files;
      yield* git(cwd, ["checkout", "-b", "feature/combined"]);
      yield* writeTextFile(cwd, "README.md", "# test\ncommitted\n");
      yield* git(cwd, ["commit", "-am", "commit edit"]);

      const clean = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
      assert.deepStrictEqual(sourceFiles(clean, "working-tree"), []);
      assert.deepStrictEqual(sourceFiles(clean, "branch-range"), [
        { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
      ]);

      yield* writeTextFile(cwd, "README.md", "# test\ncommitted\ndirty\n");
      yield* writeTextFile(cwd, "new.txt", "new\n");
      const dirty = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
      const changes = dirty.sources.find((source) => source.kind === "branch-range")!;
      assert.deepStrictEqual(changes.files, [
        { path: "README.md", previousPath: null, additions: 2, deletions: 0 },
        { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.strictEqual(changes.diff.match(/^diff --git a\/README\.md /gm)?.length, 1);
      assert.include(changes.diff, "+dirty");
      assert.deepStrictEqual(sourceFiles(dirty, "working-tree"), [
        { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
        { path: "new.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
    }),
  );

  it.effect("Changes on the default branch compares with its remote copy", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* writeTextFile(cwd, "unpushed.txt", "unpushed\n");
      yield* git(cwd, ["add", "unpushed.txt"]);
      yield* git(cwd, ["commit", "-m", "unpushed"]);

      const local = yield* driver.getReviewDiffPreview({ cwd });
      const localChanges = local.sources.find((source) => source.kind === "branch-range")!;
      assert.isNull(localChanges.baseRef);
      assert.deepStrictEqual(localChanges.files, []);

      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD~1:refs/heads/main"]);
      yield* git(cwd, ["fetch", "origin"]);
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.strictEqual(changes.baseRef, "origin/main");
      assert.deepStrictEqual(changes.files, [
        { path: "unpushed.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
    }),
  );

  it.effect("honors configured remote-qualified bases for Changes and ahead counts", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fork = yield* makeTmpDir();
      const upstream = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(fork, ["init", "--bare"]);
      yield* git(upstream, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", fork]);
      yield* git(cwd, ["remote", "add", "upstream", upstream]);
      yield* git(cwd, ["remote", "add", "canonical/team", upstream]);
      yield* git(cwd, ["push", "origin", "main"]);
      yield* writeTextFile(cwd, "upstream.txt", "unrelated upstream work\n");
      yield* git(cwd, ["add", "upstream.txt"]);
      yield* git(cwd, ["commit", "-m", "upstream work"]);
      yield* git(cwd, ["push", "upstream", "main"]);
      yield* git(cwd, ["fetch", "canonical/team"]);
      yield* git(cwd, ["branch", "release/v2"]);
      yield* git(cwd, ["checkout", "-b", "feature/configured-base"]);
      yield* writeTextFile(cwd, "feature.txt", "intended branch change\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature work"]);

      for (const baseRef of ["upstream/main", "canonical/team/main", "release/v2"]) {
        yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
        assert.strictEqual(status.aheadCount, 1);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, baseRef);
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
      }

      for (const baseRef of ["origin/main", "upstream/missing", "main"]) {
        yield* git(cwd, ["config", "branch.feature/configured-base.gh-merge-base", baseRef]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, {
          baseRef: "origin/main",
          insertions: 2,
          deletions: 0,
        });
        assert.strictEqual(status.aheadCount, 2);
      }

      yield* git(cwd, [
        "config",
        "branch.feature/configured-base.gh-merge-base",
        "refs/remotes/upstream/main",
      ]);
      yield* writeTextFile(cwd, "upstream.txt", "feature edits upstream file\n");
      for (const shadowRef of ["refs/heads/upstream/main", "refs/tags/upstream/main"]) {
        yield* git(cwd, ["update-ref", shadowRef, "HEAD~2"]);
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, {
          baseRef: "refs/remotes/upstream/main",
          insertions: 2,
          deletions: 1,
        });
        assert.strictEqual(status.aheadCount, 1);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, "refs/remotes/upstream/main");
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
          { path: "upstream.txt", previousPath: null, additions: 1, deletions: 1 },
        ]);
        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: changes.baseRef,
            headRef: "feature/configured-base",
            oldPath: "upstream.txt",
            newPath: "upstream.txt",
          }),
        );
        assert.deepStrictEqual(contents, {
          oldContents: "unrelated upstream work\n",
          newContents: "feature edits upstream file\n",
        });
        yield* git(cwd, ["update-ref", "-d", shadowRef]);
      }
    }),
  );

  it.effect("keeps local branch bases consistent when tags share their names", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      const initialCommit = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["update-ref", "refs/tags/main", initialCommit]);
      yield* git(cwd, ["update-ref", "refs/tags/release/v2", initialCommit]);
      yield* writeTextFile(cwd, "README.md", "# test\nbase work\n");
      yield* git(cwd, ["commit", "-am", "base work"]);
      yield* git(cwd, ["branch", "release/v2", "HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature/local-base", "HEAD"]);
      yield* writeTextFile(cwd, "README.md", "# test\nbase work\nfeature work\n");
      yield* git(cwd, ["commit", "-am", "feature work"]);

      for (const configuredBase of [undefined, "main", "release/v2"]) {
        if (configuredBase !== undefined) {
          yield* git(cwd, ["config", "branch.feature/local-base.gh-merge-base", configuredBase]);
        }
        const baseRef = configuredBase ?? "main";
        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
        assert.deepInclude(status.branchChanges, { baseRef, insertions: 1, deletions: 0 });
        assert.strictEqual(status.aheadCount, 1);
        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.strictEqual(changes.baseRef, baseRef);
        assert.deepStrictEqual(changes.files, [
          { path: "README.md", previousPath: null, additions: 1, deletions: 0 },
        ]);
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          baseRef,
          file: { path: "README.md", previousPath: null, sourceKind: "branch-range" },
        });
        const scopedChanges = scoped.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(scopedChanges.files, changes.files);
        assert.strictEqual(scopedChanges.diff, changes.diff);
        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef: changes.baseRef,
            headRef: "feature/local-base",
          }),
        );
        assert.deepStrictEqual(contents, {
          oldContents: "# test\nbase work\n",
          newContents: "# test\nbase work\nfeature work\n",
        });
      }

      for (const baseRef of ["refs/tags/main", initialCommit, "HEAD~2"]) {
        const contents = yield* driver.getReviewDiffFileContents(
          makeReviewDiffFileContentsInput(cwd, {
            sourceKind: "branch-range",
            baseRef,
            headRef: "feature/local-base",
          }),
        );
        assert.strictEqual(contents.oldContents, "# test\n");
      }
    }),
  );

  it.effect("Changes accepts an explicit base on a detached HEAD and rejects a bad one", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "--detach"]);
      yield* writeTextFile(cwd, "detached.txt", "detached\n");
      yield* git(cwd, ["add", "detached.txt"]);
      yield* git(cwd, ["commit", "-m", "detached work"]);

      const explicit = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
      assert.deepStrictEqual(
        explicit.sources.find((source) => source.kind === "branch-range")!.files,
        [{ path: "detached.txt", previousPath: null, additions: 1, deletions: 0 }],
      );
      const implicit = yield* driver.getReviewDiffPreview({ cwd });
      assert.deepStrictEqual(
        implicit.sources.find((source) => source.kind === "branch-range")!.files,
        [],
      );
      const error = yield* driver
        .getReviewDiffPreview({ cwd, baseRef: "missing-base" })
        .pipe(Effect.flip);
      assert.strictEqual(error.operation, "GitVcsDriver.resolveReviewMergeBase");
    }),
  );

  it.effect("Changes compares with the empty tree before the first commit", () =>
    Effect.gen(function* () {
      const upstream = yield* makeTmpDir();
      yield* initRepoWithCommit(upstream);
      yield* git(upstream, ["branch", "-M", "main"]);
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init", "-b", "main"]);
      yield* git(cwd, ["remote", "add", "origin", upstream]);
      yield* git(cwd, ["fetch", "origin"]);
      yield* writeTextFile(cwd, "new.txt", "one\ntwo\n");

      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.isNull(changes.baseRef);
      assert.deepStrictEqual(changes.files, [
        { path: "new.txt", previousPath: null, additions: 2, deletions: 0 },
      ]);
      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepInclude(status.branchChanges, {
        baseRef: null,
        insertions: 2,
        deletions: 0,
      });
    }),
  );

  it.effect("Changes does not show newer base commits as deletions", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["checkout", "-b", "feature/rebased"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature work"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
      yield* git(cwd, ["add", "upstream.txt"]);
      yield* git(cwd, ["commit", "-m", "base moves"]);
      yield* git(cwd, ["checkout", "feature/rebased"]);

      for (const rebase of [false, true]) {
        if (rebase) yield* git(cwd, ["rebase", initialBranch]);
        const preview = yield* driver.getReviewDiffPreview({ cwd, baseRef: initialBranch });
        assert.deepStrictEqual(
          preview.sources.find((source) => source.kind === "branch-range")!.files,
          [{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }],
        );
      }
    }),
  );
});
