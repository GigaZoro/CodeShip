import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

it.layer(layerTest)("Git branch publishing", (it) => {
  it.effect.each([false, true])(
    "pushes with upstream setup and skips when already up to date (autoSetupMerge=%s)",
    (autoSetupMerge) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        if (autoSetupMerge) {
          yield* git(cwd, ["config", "branch.autoSetupMerge", "always"]);
        }
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        if (autoSetupMerge) {
          assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/push.remote"), ".");
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.merge"),
            `refs/heads/${initialBranch}`,
          );
        }

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        if (autoSetupMerge) {
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.t3-merge-base"),
            initialBranch,
          );
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.t3-merge-base-ref"),
            `refs/heads/${initialBranch}`,
          );
        }

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
  );

  it.effect("republishes a branch whose upstream was deleted", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
        cwd,
        refName: "feature/push",
      });
      yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
        cwd,
        refName: "feature/push",
      });
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

      yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);

      yield* git(cwd, ["push", "origin", "--delete", "feature/push"]);
      yield* writeTextFile(cwd, "followup.txt", "followup\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add followup", "");
      const republished = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
      assert.deepInclude(republished, { status: "pushed", branch: "feature/push" });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );

      const fork = yield* makeTmpDir("git-fork-");
      yield* git(fork, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "fork", fork]);
      yield* git(cwd, ["remote", "add", "feature", fork]);
      yield* git(cwd, ["push", "-u", "fork", "feature/push"]);
      yield* git(cwd, ["push", "fork", "--delete", "feature/push"]);
      yield* writeTextFile(cwd, "fork.txt", "fork\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add fork change", "");
      assert.deepInclude(
        yield* (yield* GitVcsDriver.GitVcsDriver).resolvePushTarget(cwd, {
          branch: "feature/push",
          hasUpstream: false,
        }),
        { remoteName: "fork", branchName: "feature/push" },
      );
      const forkRepublished = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(
        cwd,
        null,
      );
      assert.deepInclude(forkRepublished, { upstreamBranch: "fork/feature/push" });
      assert.equal(
        yield* git(fork, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );

      yield* git(cwd, ["config", "branch.feature/push.remote", "."]);
      yield* git(cwd, ["config", "branch.feature/push.merge", "refs/heads/push"]);
      yield* writeTextFile(cwd, "local.txt", "local\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add local change", "");
      const localUpstreamGone = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(
        cwd,
        null,
      );
      assert.deepInclude(localUpstreamGone, { upstreamBranch: "origin/feature/push" });

      yield* git(cwd, ["push", "fork", "HEAD:refs/heads/release"]);
      yield* git(cwd, ["branch", "-u", "fork/release"]);
      yield* git(cwd, ["push", "fork", "--delete", "release"]);
      yield* writeTextFile(cwd, "release.txt", "release\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add release change", "");
      yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
      assert.equal(
        yield* (yield* GitVcsDriver.GitVcsDriver).readConfigValue(
          cwd,
          "branch.feature/push.t3-merge-base",
        ),
        "release",
      );
    }),
  );

  it.effect("rebases a pushed branch's pulls when branch.autoSetupRebase asks for it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["config", "branch.autoSetupRebase", "always"]);
      yield* git(cwd, ["checkout", "-q", "-b", "feature/rebase"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), { setUpstream: true });
      assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/rebase.rebase"), "true");
    }),
  );

  it.effect("reports a push whose upstream could not be recorded", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["checkout", "-q", "-b", "feature/locked"]);
      yield* writeTextFile(cwd, ".git/config.lock", "");
      const driver = yield* GitVcsDriver.GitVcsDriver;

      // Recording the upstream retries on the real clock before giving up.
      const pushed = yield* TestClock.withLive(driver.pushCurrentBranch(cwd, null));

      assert.deepInclude(pushed, { status: "pushed", setUpstream: false });
      assert.include(
        yield* git(cwd, ["ls-remote", "origin", "refs/heads/feature/locked"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
      assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/locked.remote"), null);
    }),
  );

  it.effect.each(["feature/push", "origin/feature/push"])(
    "publishes %s when the configured diff base already contains HEAD",
    (branch) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["push", "origin", "main", "main:refs/heads/feature/push"]);
        yield* git(cwd, ["checkout", "--no-track", "-b", branch]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");
        yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/main"]);
        yield* git(cwd, ["config", `branch.${branch}.gh-merge-base`, "upstream/main"]);

        const status = yield* driver.statusDetails(cwd);
        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        assert.notEqual(
          yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
          head,
        );

        const pushed = yield* driver.pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch,
          upstreamBranch: "origin/feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
          head,
        );

        yield* git(cwd, ["branch", "--unset-upstream"]);
        const skipped = yield* driver.pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, { status: "skipped_up_to_date", branch });

        yield* writeTextFile(cwd, "remote.txt", "remote update\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Advance publish branch", "");
        yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature/push"]);
        const publishedHead = yield* git(originRemote, [
          "--git-dir=.",
          "rev-parse",
          "refs/heads/feature/push",
        ]);
        yield* git(cwd, ["reset", "--hard", head]);
        const skippedBehindRemote = yield* driver.pushCurrentBranch(cwd, null);
        assert.deepInclude(skippedBehindRemote, { status: "skipped_up_to_date", branch });
        assert.equal(
          yield* git(originRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
          publishedHead,
        );

        const pushOnlyRemote = yield* makeTmpDir("git-push-only-remote-");
        yield* git(pushOnlyRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "set-url", "--push", "origin", pushOnlyRemote]);
        const pushedToPushUrl = yield* driver.pushCurrentBranch(cwd, null);
        assert.deepInclude(pushedToPushUrl, { status: "pushed", branch });
        assert.equal(
          yield* git(pushOnlyRemote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
          head,
        );
      }),
  );

  it.effect("pushes upstream branches to the remote branch name, not the upstream shorthand", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", "main"]);
      yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add upstream update", "");

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "main",
        upstreamBranch: "origin/main",
        setUpstream: false,
      });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
        "Add upstream update",
      );
      const badBranch = yield* driver.execute({
        operation: "GitVcsDriver.test.showBadRemoteBranch",
        cwd: remote,
        args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
      assert.notEqual(badBranch.exitCode, 0);
    }),
  );

  it.effect.each([
    { baseBranch: "dev", local: false, branch: "feature/x", deleted: false },
    { baseBranch: "dev", local: true, branch: "feature/x", deleted: false },
    { baseBranch: "feature/base", local: true, branch: "feature/x", deleted: false },
    { baseBranch: "upstream", local: true, branch: "feature/x", deleted: false },
    { baseBranch: "upstream/feature/x", local: true, branch: "feature/x", deleted: false },
    { baseBranch: "dev", local: false, branch: "origin/dev", deleted: true },
  ])(
    "publishes $branch tracking $baseBranch (local=$local, deleted=$deleted) without updating the base",
    ({ baseBranch, local, branch, deleted }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstream = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "--no-track", "-b", baseBranch]);
        yield* git(cwd, ["push", "-u", "origin", baseBranch]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "upstream", baseBranch]);
        const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, [
          "checkout",
          "--track",
          "-b",
          branch,
          local ? `refs/heads/${baseBranch}` : `refs/remotes/upstream/${baseBranch}`,
        ]);
        assert.equal(
          yield* driver.readConfigValue(cwd, `branch.${branch}.remote`),
          local ? "." : "upstream",
        );
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");
        if (deleted) {
          yield* git(cwd, ["push", "upstream", "--delete", baseBranch]);
        }
        const publishBranch = branch === "origin/dev" ? "dev" : branch;
        assert.deepInclude(
          yield* driver.resolvePushTarget(cwd, { branch, hasUpstream: !deleted }),
          { remoteName: "origin", branchName: publishBranch },
        );

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch,
          upstreamBranch: `origin/${publishBranch}`,
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", publishBranch]),
          "Add feature",
        );
        if (publishBranch !== baseBranch) {
          assert.equal(
            yield* git(remote, ["--git-dir=.", "rev-parse", `refs/heads/${baseBranch}`]),
            devSha,
          );
        }
        assert.equal(
          yield* git(upstream, [
            "--git-dir=.",
            "for-each-ref",
            "--format=%(objectname)",
            `refs/heads/${baseBranch}`,
          ]),
          deleted ? "" : upstreamDevSha,
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]),
          `refs/remotes/origin/${publishBranch}`,
        );
        assert.equal(
          yield* driver.readConfigValue(cwd, `branch.${branch}.t3-merge-base`),
          baseBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(cwd, `branch.${branch}.t3-merge-base-ref`),
          local ? `refs/heads/${baseBranch}` : `refs/remotes/upstream/${baseBranch}`,
        );
        assert.equal(yield* git(cwd, ["rev-parse", `refs/heads/${baseBranch}`]), upstreamDevSha);

        if (deleted) return;

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          {
            path: "feature.txt",
            previousPath: null,
            changeType: "new",
            additions: 1,
            deletions: 0,
          },
        ]);
        assert.equal(
          changes.baseRef,
          local ? `refs/heads/${baseBranch}` : `upstream/${baseBranch}`,
        );
      }),
  );

  it.effect.each([
    { upstreamRef: "refs/remotes/origin/main", baseKey: "gh-merge-base" },
    { upstreamRef: "refs/heads/main", baseKey: "gh-merge-base" },
    { upstreamRef: "refs/heads/main", baseKey: "t3-merge-base" },
  ])(
    "keeps a recorded $baseKey when publishing a branch tracking $upstreamRef",
    ({ upstreamRef, baseKey }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "--track", "-b", "feature/y", upstreamRef]);
        yield* git(cwd, ["config", `branch.feature/y.${baseKey}`, "release/v2"]);
        yield* git(cwd, ["config", "branch.feature/y.t3-merge-base-ref", "refs/heads/release/v2"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, `branch.feature/y.${baseKey}`),
          "release/v2",
        );
        assert.equal(yield* driver.readBranchBase(cwd, "feature/y"), "release/v2");
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.t3-merge-base-ref"),
          "refs/heads/release/v2",
        );
      }),
  );

  it.effect.each(["main", "feature/base"])(
    "rejects publishing a branch tracking local %s without a git remote",
    (parent) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", parent]);
        yield* git(cwd, ["checkout", "--track", "-b", "child", `refs/heads/${parent}`]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");
        const parentSha = yield* git(cwd, ["rev-parse", `refs/heads/${parent}`]);

        const error = yield* driver.pushCurrentBranch(cwd, null).pipe(Effect.flip);

        assert.equal(error._tag, "GitCommandError");
        assert.equal(error.operation, "GitVcsDriver.pushCurrentBranch");
        assert.equal(
          error.detail,
          "Cannot push because no git remote is configured for this repository.",
        );
        assert.equal(yield* git(cwd, ["rev-parse", `refs/heads/${parent}`]), parentSha);
      }),
  );

  it.effect("publishes a local-tracking branch named like a remote ref under its full name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", "main"]);
      const mainSha = yield* git(cwd, ["rev-parse", "refs/heads/main"]);
      yield* git(cwd, ["checkout", "--track", "-b", "origin/main", "refs/heads/main"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add feature", "");

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "origin/main",
        upstreamBranch: "origin/origin/main",
      });
      assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/main"]), mainSha);
      assert.equal(
        yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "refs/heads/origin/main"]),
        "Add feature",
      );
    }),
  );

  it.effect("still pushes a git-mangled tracking alias to its upstream head", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "my-org/upstream", remote]);
      yield* git(cwd, ["push", "my-org/upstream", "main:effect-atom"]);
      yield* git(cwd, ["fetch", "my-org/upstream"]);
      yield* git(cwd, ["checkout", "--track", "my-org/upstream/effect-atom"]);
      assert.equal(yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), "upstream/effect-atom");
      yield* writeTextFile(cwd, "alias.txt", "alias\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add alias update", "");

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "upstream/effect-atom",
        upstreamBranch: "my-org/upstream/effect-atom",
        setUpstream: false,
      });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "effect-atom"]),
        "Add alias update",
      );

      yield* git(cwd, ["push", "my-org/upstream", "--delete", "effect-atom"]);
      assert.deepInclude(
        yield* driver.resolvePushTarget(cwd, {
          branch: "upstream/effect-atom",
          hasUpstream: false,
        }),
        { remoteName: "my-org/upstream", branchName: "effect-atom" },
      );
      assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), {
        upstreamBranch: "my-org/upstream/effect-atom",
        setUpstream: true,
      });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/effect-atom"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
      assert.equal(
        yield* git(remote, [
          "--git-dir=.",
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/upstream/",
        ]),
        "",
      );
    }),
  );

  it.effect("pushes to the requested remote instead of the primary remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const originRemote = yield* makeTmpDir("git-origin-remote-");
      const publishRemote = yield* makeTmpDir("git-publish-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(originRemote, ["init", "--bare"]);
      yield* git(publishRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", originRemote]);
      yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

      const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "main",
        upstreamBranch: "origin-1/main",
        setUpstream: true,
      });
      assert.equal(
        yield* git(publishRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
        "initial commit",
      );
      const originMain = yield* driver.execute({
        operation: "GitVcsDriver.test.originMainMissing",
        cwd: originRemote,
        args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/main"],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
      assert.notEqual(originMain.exitCode, 0);
    }),
  );

  it.effect.each(["branch.topic.pushRemote", "remote.pushDefault"] as const)(
    "pushes a branch tracking its upstream head to the %s remote",
    (configKey) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        const forkRemote = yield* makeTmpDir("git-fork-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["remote", "add", "fork", forkRemote]);
        yield* git(cwd, ["checkout", "-b", "topic"]);
        yield* git(cwd, ["push", "upstream", "topic"]);
        yield* git(cwd, ["push", "fork", "topic"]);
        yield* git(cwd, ["branch", "--set-upstream-to=upstream/topic"]);
        yield* git(cwd, ["config", configKey, "fork"]);
        const upstreamTopicSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "fork.txt", "fork\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add fork update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "topic",
          upstreamBranch: "fork/topic",
          pushRemote: "fork",
          setUpstream: false,
        });
        assert.equal(
          yield* git(forkRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "topic"]),
          "Add fork update",
        );
        assert.equal(
          yield* git(upstreamRemote, ["--git-dir=.", "rev-parse", "topic"]),
          upstreamTopicSha,
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "upstream/topic",
        );
      }),
  );

  it.effect.each(["deleted", "rewound"] as const)(
    "pushes an up-to-date tracked branch to the push remote when its branch there is %s",
    (forkState) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        const forkRemote = yield* makeTmpDir("git-fork-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["remote", "add", "fork", forkRemote]);
        yield* git(cwd, ["checkout", "-b", "topic"]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "-u", "upstream", "topic"]);
        yield* git(cwd, ["config", "remote.pushDefault", "fork"]);
        // Another checkout changes the fork after this one last fetched it,
        // leaving a local fork/topic that still contains HEAD.
        yield* git(cwd, ["push", "fork", "topic"]);
        yield* git(
          forkRemote,
          forkState === "deleted"
            ? ["--git-dir=.", "update-ref", "-d", "refs/heads/topic"]
            : ["--git-dir=.", "update-ref", "refs/heads/topic", "topic~1"],
        );

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          upstreamBranch: "fork/topic",
          pushRemote: "fork",
        });
        assert.equal(
          yield* git(forkRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "topic"]),
          "Add upstream update",
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "upstream/topic",
        );
      }),
  );

  it.effect.each([
    { pushUrls: [], status: "skipped_up_to_date" },
    { pushUrls: ["mirror"], status: "pushed" },
    { pushUrls: ["fork", "mirror"], status: "pushed" },
  ] as const)(
    "skips an up-to-date tracked branch only when every push URL has it (pushurl $pushUrls)",
    ({ pushUrls, status }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        const remotes = {
          fork: yield* makeTmpDir("git-fork-remote-"),
          mirror: yield* makeTmpDir("git-mirror-remote-"),
        };
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(remotes.fork, ["init", "--bare"]);
        yield* git(remotes.mirror, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["remote", "add", "fork", remotes.fork]);
        yield* git(cwd, ["checkout", "-b", "topic"]);
        yield* git(cwd, ["push", "-u", "upstream", "topic"]);
        yield* git(cwd, ["push", "fork", "topic"]);
        yield* git(cwd, ["config", "remote.pushDefault", "fork"]);
        for (const name of pushUrls) {
          yield* git(cwd, ["remote", "set-url", "--add", "--push", "fork", remotes[name]]);
        }

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, { status, upstreamBranch: "fork/topic", pushRemote: "fork" });
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        for (const name of pushUrls) {
          assert.equal(
            yield* git(remotes[name], ["--git-dir=.", "rev-parse", "refs/heads/topic"]),
            head,
          );
        }
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "upstream/topic",
        );
      }),
  );

  it.effect("pushes an up-to-date branch whose tracked remote has a separate push URL", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fetchRemote = yield* makeTmpDir("git-fetch-remote-");
      const pushRemote = yield* makeTmpDir("git-push-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(fetchRemote, ["init", "--bare"]);
      yield* git(pushRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", fetchRemote]);
      yield* git(cwd, ["checkout", "-b", "topic"]);
      yield* git(cwd, ["push", "-u", "origin", "topic"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", pushRemote]);

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, { status: "pushed", upstreamBranch: "origin/topic" });
      assert.equal(
        yield* git(pushRemote, ["--git-dir=.", "rev-parse", "refs/heads/topic"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
    }),
  );

  it.effect("skips an up-to-date branch whose differently named upstream is its base", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
      const forkRemote = yield* makeTmpDir("git-fork-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(upstreamRemote, ["init", "--bare"]);
      yield* git(forkRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
      yield* git(cwd, ["remote", "add", "fork", forkRemote]);
      yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/release"]);
      yield* git(cwd, ["fetch", "upstream"]);
      yield* git(cwd, ["checkout", "-b", "topic", "--track", "upstream/release"]);
      yield* git(cwd, ["config", "remote.pushDefault", "fork"]);

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "skipped_up_to_date",
        upstreamBranch: "upstream/release",
      });
      assert.equal(yield* git(forkRemote, ["--git-dir=.", "branch", "--list", "topic"]), "");
    }),
  );
});
