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
  it.effect("pushes with upstream setup and skips when already up to date", () =>
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

      const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
      assert.deepInclude(skipped, {
        status: "skipped_up_to_date",
        branch: "feature/push",
      });
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

  it.effect("publishes a branch tracking its base under its own name, not the base", () =>
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
      yield* git(cwd, ["checkout", "-b", "dev"]);
      yield* git(cwd, ["push", "-u", "origin", "dev"]);
      const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(upstream, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", upstream]);
      yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add upstream update", "");
      yield* git(cwd, ["push", "upstream", "dev"]);
      const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["checkout", "-b", "feature/x", "upstream/dev"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add feature", "");

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "feature/x",
        upstreamBranch: "origin/feature/x",
        setUpstream: true,
      });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"]),
        "Add feature",
      );
      assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "dev"]), devSha);
      assert.equal(yield* git(upstream, ["--git-dir=.", "rev-parse", "dev"]), upstreamDevSha);
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
        "origin/feature/x",
      );
      assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/x.t3-merge-base"), "dev");

      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.deepStrictEqual(changes.files, [
        { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.equal(changes.baseRef, "upstream/dev");
    }),
  );

  it.effect("keeps a recorded merge base when publishing a tracked branch", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/y", "origin/main"]);
      yield* git(cwd, ["config", "branch.feature/y.gh-merge-base", "release/v2"]);
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
        yield* driver.readConfigValue(cwd, "branch.feature/y.gh-merge-base"),
        "release/v2",
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
});
