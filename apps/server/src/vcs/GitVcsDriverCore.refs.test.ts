// @effect-diagnostics nodeBuiltinImport:off - these fixtures observe native filesystem paths or Node child process behavior directly.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { VcsRef, VcsListRefsResult } from "@t3tools/contracts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerServerConfig,
  layerTest,
  makeDriverReleasingLock,
  makeUnreadableConfigHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./GitVcsDriverCore.testkit.ts";

const decodeVcsRef = Schema.decodeUnknownSync(VcsRef);
const decodeVcsListRefsResult = Schema.decodeUnknownSync(VcsListRefsResult);

it.layer(layerTest)("Git references and remote configuration", (it) => {
  it.effect("lists root and upstream metadata and optionally includes matching remote refs", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["remote", "add", "team/upstream", remote]);
      yield* git(cwd, ["push", "team/upstream", "HEAD:refs/heads/feature/a"]);
      yield* git(cwd, ["branch", "--track", "feature/a", "team/upstream/feature/a"]);
      yield* git(cwd, ["branch", "--no-track", "local-only"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const deduplicated = yield* driver.listRefs({ cwd });
      assert.equal(
        deduplicated.refs.some((ref) => ref.name === `origin/${initialBranch}`),
        false,
      );

      const worktreePath = yield* makeTmpDir("git-vcs-driver-worktree-");
      yield* git(cwd, ["worktree", "add", worktreePath, "feature/a"]);
      yield* writeTextFile(worktreePath, "packages/app/file.txt", "nested project\n");
      const pathService = yield* Path.Path;
      const nestedCwd = pathService.join(worktreePath, "packages", "app");
      const complete = yield* driver.listRefs({
        cwd: nestedCwd,
        includeMatchingRemoteRefs: true,
      });
      const untracked = complete.refs.find((ref) => ref.name === "local-only");
      assert.ok(untracked);
      assert.equal("upstreamRef" in untracked, false);
      assert.deepEqual(decodeVcsRef(untracked), untracked);
      assert.equal(
        complete.refs.some((ref) => ref.name === initialBranch),
        true,
      );
      assert.equal(
        complete.refs.some((ref) => ref.name === `origin/${initialBranch}`),
        true,
      );

      const remoteOnly = yield* driver.listRefs({
        cwd,
        includeMatchingRemoteRefs: true,
        refKind: "remote",
        limit: 1,
      });
      assert.equal(remoteOnly.refs.length, 1);
      assert.equal(remoteOnly.refs[0]?.name, `origin/${initialBranch}`);
      assert.equal(remoteOnly.refs[0]?.isRemote, true);

      const tracked = complete.refs.find((ref) => ref.name === "feature/a");
      assert.ok(tracked);
      assert.deepEqual(decodeVcsRef(tracked), {
        ...tracked,
        upstreamRef: "refs/remotes/team/upstream/feature/a",
      });
      const aliasCwd = pathService.join(cwd, "worktree-alias");
      NodeFS.symlinkSync(worktreePath, aliasCwd, "junction");
      const aliased = yield* driver.listRefs({ cwd: aliasCwd });
      const expected = [
        { ...complete, isAtRepositoryRoot: false },
        { ...aliased, isAtRepositoryRoot: true },
      ];
      assert.deepEqual([complete, aliased], expected);
      assert.deepEqual(
        [decodeVcsListRefsResult(complete), decodeVcsListRefsResult(aliased)],
        expected,
      );
    }),
  );

  it.effect("marks the origin default ref as default when no local copy exists", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["remote", "set-head", "origin", initialBranch]);
      yield* git(cwd, ["checkout", "-b", "feature/only-local"]);
      yield* git(cwd, ["branch", "-D", initialBranch]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const refs = yield* driver.listRefs({ cwd });
      const remoteDefault = refs.refs.find((ref) => ref.name === `origin/${initialBranch}`);
      assert.equal(remoteDefault?.isRemote, true);
      assert.equal(remoteDefault?.isDefault, true);
    }),
  );

  it.effect("preserves exact custom names and refuses collisions without a suffix", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.createRef({ cwd, refName: "Julius/ABC-123" });
      const failed = yield* driver
        .renameBranch({
          cwd,
          oldBranch: initialBranch,
          newBranch: "Julius/ABC-123",
          exactName: true,
        })
        .pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      const renamed = yield* driver.renameBranch({
        cwd,
        oldBranch: initialBranch,
        newBranch: "Julius/ABC-124.v2",
        exactName: true,
      });
      assert.equal(renamed.branch, "Julius/ABC-124.v2");
    }),
  );

  it.effect("flattens a generated name when a branch at its parent path blocks it", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // A local `t3` branch is why launches start on the flat `t3-<hex>` temporary branch.
      yield* git(cwd, ["branch", "t3"]);
      yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
      yield* git(cwd, ["branch", "t3-fix-login"]);

      const renamed = yield* driver.renameBranch({
        cwd,
        oldBranch: "t3-abcd1234",
        newBranch: "t3/fix-login",
      });

      assert.equal(renamed.branch, "t3-fix-login-1");
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
    }),
  );

  it.effect("skips a flattened name that a nested branch blocks", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "t3"]);
      yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
      yield* git(cwd, ["branch", "t3-fix-login/child"]);

      const renamed = yield* driver.renameBranch({
        cwd,
        oldBranch: "t3-abcd1234",
        newBranch: "t3/fix-login",
      });

      assert.equal(renamed.branch, "t3-fix-login-1");
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
    }),
  );

  it.effect("rejects a missing branch without restoring a matching dirty file", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "obsolete-branch", "original\n");
      yield* git(cwd, ["add", "obsolete-branch"]);
      yield* git(cwd, ["commit", "-m", "tracked file"]);
      yield* git(cwd, ["branch", "obsolete-branch"]);
      yield* git(cwd, ["branch", "-D", "obsolete-branch"]);
      yield* writeTextFile(cwd, "obsolete-branch", "uncommitted work\n");

      const result = yield* driver
        .switchRef({ cwd, refName: "obsolete-branch" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      assert.equal(
        yield* fileSystem.readFileString(path.join(cwd, "obsolete-branch")),
        "uncommitted work\n",
      );
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
    }),
  );

  it.effect("treats ref names that look like options as ref names", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature", "HEAD:refs/heads/-M"]);
      // Git refuses such branch names, but update-ref writes them, here tracking origin/feature.
      yield* git(cwd, ["update-ref", "refs/heads/-f", "HEAD"]);
      yield* git(cwd, ["config", "branch.-f.remote", "origin"]);
      yield* git(cwd, ["config", "branch.-f.merge", "refs/heads/feature"]);
      yield* git(cwd, ["branch", "keep"]);
      yield* writeTextFile(cwd, "README.md", "uncommitted work\n");
      const branches = yield* driver.listLocalBranchNames(cwd);
      const worktrees = yield* makeTmpDir("git-worktrees-");

      yield* driver.switchRef({ cwd, refName: "-f" }).pipe(Effect.flip);
      yield* driver.switchRef({ cwd, refName: "origin/feature" }).pipe(Effect.flip);
      yield* driver.createRef({ cwd, refName: "--list" }).pipe(Effect.flip);
      for (const [refName, newRefName] of [
        ["--detach", undefined],
        ["-M", undefined],
        ["-M", "renamed"],
        ["-D", "keep"],
        ["keep", "-M"],
        ["keep", "-D"],
      ] as const) {
        yield* driver
          .createWorktree({
            cwd,
            path: pathService.join(worktrees, "wt"),
            refName,
            ...(newRefName ? { newRefName } : {}),
          })
          .pipe(Effect.flip);
      }

      assert.equal(
        yield* fileSystem.readFileString(pathService.join(cwd, "README.md")),
        "uncommitted work\n",
      );
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      assert.deepEqual(yield* driver.listLocalBranchNames(cwd), branches);
      assert.isFalse(yield* fileSystem.exists(pathService.join(worktrees, "wt")));

      yield* git(cwd, ["checkout", "-q", "keep"]);
      yield* git(cwd, ["checkout", "-q", initialBranch]);
      assert.equal((yield* driver.switchRef({ cwd, refName: "-" })).refName, "keep");
      const previous = yield* driver.createWorktree({
        cwd,
        path: pathService.join(worktrees, "previous"),
        refName: "-",
      });
      assert.equal(yield* git(previous.worktree.path, ["branch", "--show-current"]), initialBranch);
      const fromPrevious = yield* driver.createWorktree({
        cwd,
        path: pathService.join(worktrees, "from-previous"),
        refName: "-",
        newRefName: "from-previous",
      });
      assert.equal(
        yield* git(fromPrevious.worktree.path, ["rev-parse", "HEAD"]),
        yield* git(cwd, ["rev-parse", initialBranch]),
      );
    }),
  );

  it.effect("ensureRemote reuses a partial clone remote and avoids its name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const reused = yield* driver.ensureRemote({
        cwd,
        preferredName: "origin",
        url: "git@github.com:pingdotgg/t3code.git",
      });
      assert.equal(reused, "origin");
      const added = yield* driver.ensureRemote({
        cwd,
        preferredName: "origin",
        url: "https://github.com/another-owner/t3code.git",
      });
      assert.equal(added, "origin-1");
    }),
  );

  it.effect("ensureRemote returns the remote a parallel call added for the same URL", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init"]);
      // Hold the first add until both calls have listed remotes, so both decide to add.
      let listings = 0;
      const bothListed = yield* Deferred.make<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = ChildProcess.isStandardCommand(command) ? command.args : [];
          if (args[0] === "remote" && args[1] === "-v") {
            listings += 1;
            if (listings === 2) yield* Deferred.succeed(bothListed, undefined);
          }
          if (args[0] === "remote" && args[1] === "add") yield* Deferred.await(bothListed);
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const input = { cwd, preferredName: "fork", url: "https://github.com/fork/t3code.git" };

      const names = yield* Effect.all([driver.ensureRemote(input), driver.ensureRemote(input)], {
        concurrency: "unbounded",
      });

      assert.deepEqual(names, ["fork", "fork"]);
    }),
  );

  it.effect("retries a config write while another process holds the config lock", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = path.join(cwd, ".git", "config.lock");
      yield* fileSystem.writeFileString(lockPath, "");
      const { driver, failures } = yield* makeDriverReleasingLock(
        (args) => args[1] === "t3.test",
        lockPath,
      );

      // The retry waits on the real clock; the lock is already gone by then.
      yield* TestClock.withLive(driver.writeConfigValue({ cwd, key: "t3.test", value: "written" }));

      assert.equal(yield* Ref.get(failures), 1);
      assert.equal(yield* git(cwd, ["config", "t3.test"]), "written");
    }),
  );

  it.effect.each([
    { name: "a failing command", allowNonZeroExit: false },
    { name: "a command whose exit code the caller reads", allowNonZeroExit: true },
  ])("repeats $name that died reading a config another git was replacing", ({ allowNonZeroExit }) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["config", "t3.test", "present"]);
      const attempts = yield* Ref.make(0);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.args.includes("t3.test")
          ? Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.succeed(makeUnreadableConfigHandle())
                  : delegate.spawn(command),
              ),
            )
          : delegate.spawn(command),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );

      // The retry waits on the real clock.
      const result = yield* TestClock.withLive(
        driver.execute({
          operation: "test.readConfig",
          cwd,
          args: ["config", "--get", "t3.test"],
          allowNonZeroExit,
        }),
      );

      assert.equal(result.stdout.trim(), "present");
      assert.equal(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect("tracks a remote start point once another process releases the config lock", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", initialBranch]);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = path.join(cwd, ".git", "config.lock");
      yield* fileSystem.writeFileString(lockPath, "");
      const { driver, failures } = yield* makeDriverReleasingLock(
        (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
        lockPath,
      );

      // The upstream retry waits on the real clock; the lock is already gone by then.
      yield* TestClock.withLive(
        driver.createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "tracked"),
          refName: `origin/${initialBranch}`,
          newRefName: "feature/tracked",
        }),
      );

      assert.equal(yield* Ref.get(failures), 1);
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/tracked@{upstream}"]),
        `origin/${initialBranch}`,
      );
    }),
  );

  it.effect("fetches a remote branch into a tracking branch past another process's lock", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", `${initialBranch}:refs/heads/pr-head`]);
      const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
      yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
      const { driver, failures } = yield* makeDriverReleasingLock(
        (args) => args.some((arg) => arg.startsWith("--set-upstream-to")),
        lockPath,
      );

      yield* TestClock.withLive(
        driver.fetchRemoteBranch({
          cwd,
          remoteName: "origin",
          remoteBranch: "pr-head",
          localBranch: "review/pr-head",
        }),
      );

      assert.equal(yield* Ref.get(failures), 1);
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "review/pr-head@{upstream}"]),
        "origin/pr-head",
      );
    }),
  );

  // regression: #12485 explain fetch failures without exposing remote output
  it.effect("explains a real fetch failure for a missing local remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const missingRemote = `${cwd}/private-missing-remote`;
      yield* git(cwd, ["remote", "add", "origin", missingRemote]);
      const error = yield* driver.fetchRemote({ cwd, remoteName: "origin" }).pipe(Effect.flip);
      assert.include(error.detail, "could not access the remote repository");
      assert.equal(error.exitCode, 128);
      assert.isAbove(error.stderrLength ?? 0, 0);
      assert.notInclude(error.detail, missingRemote);
      assert.notProperty(error, "stderr");
    }),
  );

  it.effect("fetches from a configured remote whose name looks like an option", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      // Remote names come from .git/config. Read as an option, this one runs `touch` in cwd.
      const remoteName = "--upload-pack=touch${IFS}t3-marker;false";
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, [
        "push",
        remote,
        `HEAD:refs/heads/${initialBranch}`,
        "HEAD:refs/pull/7/head",
      ]);
      yield* git(cwd, ["config", `remote.${remoteName}.url`, remote]);

      assert.equal(yield* driver.resolvePrimaryRemoteName(cwd), remoteName);
      yield* driver.fetchRemoteTrackingBranch({ cwd, remoteName, remoteBranch: initialBranch });
      yield* driver.fetchRemote({ cwd, remoteName });
      const head = yield* driver.fetchRefCommit({ cwd, ref: "refs/pull/7/head" });

      assert.isFalse(yield* fileSystem.exists((yield* Path.Path).join(cwd, "t3-marker")));
      assert.equal(head.commitSha, yield* git(cwd, ["rev-parse", "HEAD"]));
      assert.equal(
        yield* git(cwd, ["rev-parse", `refs/remotes/${remoteName}/${initialBranch}`]),
        head.commitSha,
      );
    }),
  );

  it.effect("ensureRemote reuses an existing remote across ssh/https transport variants", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      yield* git(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);

      const reusedForSsh = yield* driver.ensureRemote({
        cwd,
        preferredName: "pingdotgg",
        url: "git@github.com:pingdotgg/t3code.git",
      });
      assert.equal(reusedForSsh, "origin");

      const reusedForSshScheme = yield* driver.ensureRemote({
        cwd,
        preferredName: "pingdotgg",
        url: "ssh://git@github.com/pingdotgg/t3code",
      });
      assert.equal(reusedForSshScheme, "origin");

      const reusedForBareSshScheme = yield* driver.ensureRemote({
        cwd,
        preferredName: "pingdotgg",
        url: "ssh://github.com/pingdotgg/t3code",
      });
      assert.equal(reusedForBareSshScheme, "origin");

      const reusedForSshPort = yield* driver.ensureRemote({
        cwd,
        preferredName: "pingdotgg",
        url: "ssh://git@github.com:22/pingdotgg/t3code",
      });
      assert.equal(reusedForSshPort, "origin");

      const reusedForSshWithPort = yield* driver.ensureRemote({
        cwd,
        preferredName: "pingdotgg",
        url: "ssh://git@github.com:22/pingdotgg/t3code.git",
      });
      assert.equal(reusedForSshWithPort, "origin");

      const addedForFork = yield* driver.ensureRemote({
        cwd,
        preferredName: "octocat",
        url: "git@github.com:octocat/t3code.git",
      });
      assert.equal(addedForFork, "octocat");
      assert.equal(yield* git(cwd, ["remote"]), "octocat\norigin");
    }),
  );
});

it.layer(layerTest)("Git remote worktree bases", (it) => {
  // A single-branch clone fetches its one branch, so a commit pushed on another one arrives only
  // when asked for by its SHA; a remote without it leaves the next one to be asked.
  it.effect("fetches a commit its branches do not reach from the first remote that has it", () =>
    Effect.gen(function* () {
      const source = yield* makeTmpDir("git-source-");
      const fork = yield* makeTmpDir("git-fork-");
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { initialBranch } = yield* initRepoWithCommit(source);
      yield* git(fork, ["init", "--bare"]);
      yield* git(source, ["push", fork, `HEAD:refs/heads/${initialBranch}`]);
      yield* git(source, ["checkout", "-b", "feature"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "on feature"]);
      const sha = yield* git(source, ["rev-parse", "HEAD"]);
      // --no-local copies objects as a remote clone does: only what its one branch reaches.
      yield* git(cwd, ["clone", "--no-local", "--single-branch", "-b", initialBranch, source, "."]);
      yield* git(cwd, ["remote", "rename", "origin", "upstream"]);
      yield* git(cwd, ["remote", "add", "origin", fork]);
      const hasCommit = driver
        .execute({
          operation: "GitVcsDriver.test.hasCommit",
          cwd,
          args: ["cat-file", "-e", `${sha}^{commit}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.map((result) => result.exitCode === 0));
      yield* driver.fetchRemote({ cwd, remoteName: "origin" });
      yield* driver.fetchRemote({ cwd, remoteName: "upstream" });
      assert.isFalse(yield* hasCommit);

      assert.deepEqual(yield* driver.fetchCommit({ cwd, commitSha: sha }), {
        fetchedFrom: "upstream",
        remoteNames: ["origin", "upstream"],
      });
      assert.isTrue(yield* hasCommit);
      assert.deepEqual(
        yield* driver.fetchCommit({ cwd, commitSha: "1234567890abcdef1234567890abcdef12345678" }),
        { fetchedFrom: null, remoteNames: ["origin", "upstream"] },
      );
      yield* git(cwd, ["remote", "remove", "origin"]);
      yield* git(cwd, ["remote", "remove", "upstream"]);
      assert.deepEqual(
        yield* driver.fetchCommit({ cwd, commitSha: "1234567890abcdef1234567890abcdef12345678" }),
        { fetchedFrom: null, remoteNames: [] },
      );
    }),
  );

  // origin lacks the commit, `broken` names no repository, and `upstream` holds the commit.
  it.effect(
    "keeps asking the remotes after one fails, and reports that failure when none has it",
    () =>
      Effect.gen(function* () {
        const source = yield* makeTmpDir("git-source-");
        const fork = yield* makeTmpDir("git-fork-");
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const { initialBranch } = yield* initRepoWithCommit(source);
        yield* git(fork, ["init", "--bare"]);
        yield* git(source, ["push", fork, `HEAD:refs/heads/${initialBranch}`]);
        yield* git(source, ["checkout", "-b", "feature"]);
        yield* git(source, ["commit", "--allow-empty", "-m", "on feature"]);
        const sha = yield* git(source, ["rev-parse", "HEAD"]);
        yield* git(cwd, [
          "clone",
          "--no-local",
          "--single-branch",
          "-b",
          initialBranch,
          source,
          ".",
        ]);
        yield* git(cwd, ["remote", "remove", "origin"]);
        yield* git(cwd, ["remote", "add", "origin", fork]);
        const missing = yield* makeTmpDir("git-missing-");
        yield* git(cwd, ["remote", "add", "broken", `${missing}/gone.git`]);
        yield* git(cwd, ["remote", "add", "upstream", source]);

        assert.deepEqual(yield* driver.fetchCommit({ cwd, commitSha: sha }), {
          fetchedFrom: "upstream",
          remoteNames: ["origin", "broken", "upstream"],
        });
        const error = yield* driver
          .fetchCommit({ cwd, commitSha: "1234567890abcdef1234567890abcdef12345678" })
          .pipe(Effect.flip);
        assert.include(error.detail, "could not access the remote repository");
        assert.notInclude(error.detail, missing);
        assert.match(error.diagnostics ?? "", /^Remote broken: Phases: /);
      }),
  );

  // A protocol v0 server without uploadpack.allow*SHA1InWant refuses any SHA it does not
  // advertise, so only fetching its branches and tags shows whether it has the commit.
  it.effect("fetches a commit a server refuses by SHA through the refs it advertises", () =>
    Effect.gen(function* () {
      const source = yield* makeTmpDir("git-source-");
      const remote = yield* makeTmpDir("git-remote-");
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { initialBranch } = yield* initRepoWithCommit(source);
      // The server does give the commits its refs name, so each one asked for sits below a tip.
      yield* git(source, ["checkout", "-b", "feature"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "on feature"]);
      const onBranch = yield* git(source, ["rev-parse", "HEAD"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "feature tip"]);
      yield* git(source, ["checkout", "--detach"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "tagged only"]);
      const tagOnly = yield* git(source, ["rev-parse", "HEAD"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "tag tip"]);
      yield* git(source, ["tag", "pushed-tag"]);
      yield* git(source, ["checkout", initialBranch]);
      yield* git(remote, ["clone", "--bare", "--no-local", source, "."]);
      yield* git(remote, ["--git-dir=.", "config", "uploadpack.allowReachableSHA1InWant", "false"]);
      yield* git(remote, ["--git-dir=.", "config", "uploadpack.allowAnySHA1InWant", "false"]);
      yield* git(cwd, ["clone", "--no-local", "--single-branch", "-b", initialBranch, remote, "."]);
      yield* git(cwd, ["config", "protocol.version", "0"]);
      const hasObject = (sha: string) =>
        driver
          .execute({
            operation: "GitVcsDriver.test.hasObject",
            cwd,
            args: ["cat-file", "-e", sha],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => result.exitCode === 0));
      assert.isFalse(yield* hasObject(onBranch));

      for (const sha of [tagOnly, onBranch]) {
        assert.deepEqual(yield* driver.fetchCommit({ cwd, commitSha: sha }), {
          fetchedFrom: "origin",
          remoteNames: ["origin"],
        });
        assert.isTrue(yield* hasObject(sha));
      }
      assert.deepEqual(
        yield* driver.fetchCommit({ cwd, commitSha: "1234567890abcdef1234567890abcdef12345678" }),
        { fetchedFrom: null, remoteNames: ["origin"] },
      );
      assert.equal(yield* git(cwd, ["for-each-ref", "refs/t3code/"]), "");
      // FETCH_HEAD belongs to whichever fetch ran last in the checkout.
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, ".git", "FETCH_HEAD")));
    }),
  );

  it.effect("looks a named branch up on the only remote when that remote is not origin", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", remote]);
      yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/release"]);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);

      assert.deepEqual(yield* driver.resolveWorktreeBaseRemote({ cwd, refName: "release" }), {
        remoteName: "upstream",
        branchName: "release",
      });
      assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "release" }), {
        commitSha: head,
        remoteRefName: "upstream/release",
      });
      yield* git(cwd, ["remote", "add", "origin", remote]);
      assert.deepEqual(yield* driver.resolveWorktreeBaseRemote({ cwd, refName: "release" }), {
        remoteName: "origin",
        branchName: "release",
      });
      yield* git(cwd, ["remote", "remove", "origin"]);
      yield* git(cwd, ["remote", "remove", "upstream"]);
      assert.isNull(yield* driver.resolveWorktreeBaseRemote({ cwd, refName: "release" }));
    }),
  );

  // Another fetch in the checkout, such as the status poll, rewrites FETCH_HEAD at any time.
  it.effect("reads a fetched ref from a ref of its own, leaving FETCH_HEAD to other fetches", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", `HEAD:refs/heads/${initialBranch}`]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "pull request head"]);
      const prHead = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/pull/7/head"]);
      yield* git(cwd, ["reset", "--hard", "HEAD~1"]);
      yield* git(cwd, ["fetch", "origin", initialBranch]);
      const fetchHead = path.join(cwd, ".git", "FETCH_HEAD");
      const otherFetch = yield* fileSystem.readFileString(fetchHead);

      assert.deepEqual(yield* driver.fetchRefCommit({ cwd, ref: "refs/pull/7/head" }), {
        commitSha: prHead,
      });
      assert.equal(yield* fileSystem.readFileString(fetchHead), otherFetch);
      assert.equal(yield* git(cwd, ["for-each-ref", "refs/t3code/"]), "");
    }),
  );

  // A restart between a fetch and its cleanup, or a delete that failed, leaves a prefix behind.
  // Each is deleted on its own: one that Git cannot delete would otherwise keep every later
  // fetch's refs too.
  it.effect("deletes the scratch refs earlier fetches left, keeping a running fetch's", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", `HEAD:refs/heads/${initialBranch}`]);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* TestClock.adjust("1 day");
      const now = yield* Clock.currentTimeMillis;
      const cutAt = now - 2 * 60 * 60_000;
      const running = `refs/t3code/fetch/${now - 60_000}-b2c4e6a8-1d3f-4a5b-8c7d-9e0f1a2b3c4d/ref`;
      const stuck = `refs/t3code/fetch/${cutAt}-0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e/ref`;
      for (const ref of [
        // Named before prefixes carried their start time.
        "refs/t3code/fetch/5f0c2a8e-9b1d-4c3e-8a7f-2d6b4e1c9a03/heads/main",
        `refs/t3code/fetch/${cutAt}-7a9c1e3f-5b2d-4e6a-9c8b-0d1f2e3a4b5c/ref`,
        running,
        stuck,
      ]) {
        yield* git(cwd, ["update-ref", ref, head]);
      }
      // A delete killed between locking a ref and removing it leaves the lock behind.
      const lockPath = yield* git(cwd, ["rev-parse", "--git-path", `${stuck}.lock`]);
      yield* writeTextFile(cwd, lockPath, `${head}\n`);

      assert.deepEqual(yield* driver.fetchRefCommit({ cwd, ref: `refs/heads/${initialBranch}` }), {
        commitSha: head,
      });
      const left = yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/t3code/"]);
      assert.deepEqual(left.split("\n").sort(), [running, stuck].sort());
    }),
  );

  it.effect("creates a worktree from the latest fetched remote commit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const peer = yield* makeTmpDir("git-peer-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
      const beforeFetch = yield* git(cwd, ["rev-parse", `refs/remotes/origin/${initialBranch}`]);

      yield* git(peer, ["clone", remote, "."]);
      yield* git(peer, ["config", "user.email", "test@test.com"]);
      yield* git(peer, ["config", "user.name", "Test"]);
      yield* writeTextFile(peer, "remote-change.txt", "remote\n");
      yield* git(peer, ["add", "remote-change.txt"]);
      yield* git(peer, ["commit", "-m", "remote change"]);
      yield* git(peer, ["push", "origin", initialBranch]);
      const remoteHead = yield* git(peer, ["rev-parse", "HEAD"]);
      assert.notEqual(beforeFetch, remoteHead);

      yield* git(peer, ["push", "origin", "HEAD:refs/heads/unrelated"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.fetchRemote({
        cwd,
        remoteName: "origin",
        refName: `origin/${initialBranch}`,
      });
      assert.isFalse(
        yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
      );

      assert.equal(
        yield* driver.remoteBranchExists({
          cwd,
          remoteName: "origin",
          refName: initialBranch,
        }),
        true,
      );
      assert.equal(
        yield* driver.remoteBranchExists({
          cwd,
          remoteName: "origin",
          refName: "local-only",
        }),
        false,
      );

      const resolvedBase = yield* driver.resolveRemoteTrackingCommit({
        cwd,
        refName: initialBranch,
        fallbackRemoteName: "origin",
      });
      const explicitlyResolvedBase = yield* driver.resolveRemoteTrackingCommit({
        cwd,
        refName: `origin/${initialBranch}`,
        fallbackRemoteName: "origin",
      });

      assert.deepEqual(resolvedBase, {
        commitSha: remoteHead,
        remoteRefName: `origin/${initialBranch}`,
      });
      assert.deepEqual(explicitlyResolvedBase, resolvedBase);
      assert.equal(yield* git(cwd, ["rev-parse", initialBranch]), beforeFetch);

      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(
        yield* makeTmpDir("git-fetched-worktrees-"),
        "fetched-origin",
      );
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: resolvedBase.commitSha,
        newRefName: "t3code/fetched-origin",
        baseRefName: resolvedBase.remoteRefName,
      });

      assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
      const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
      const comparisonBase = preview.sources.find(
        (source) => source.kind === "branch-range",
      )!.baseRef;
      assert.equal(
        yield* git(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`]),
        remoteHead,
      );
      assert.equal(
        yield* driver.readConfigValue(worktreePath, "branch.t3code/fetched-origin.remote"),
        null,
      );
      const status = yield* driver.statusDetails(worktreePath);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.aheadOfDefaultCount, 0);

      yield* driver.fetchRemote({ cwd, remoteName: "origin", refName: "local-only" });
      assert.isTrue(
        yield* driver.remoteBranchExists({ cwd, remoteName: "origin", refName: "unrelated" }),
      );
    }),
  );

  it.effect("fetches the selected worktree base for Changes", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fork = yield* makeTmpDir("git-fork-");
      const source = yield* makeTmpDir("git-source-");
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "-M", "stable"]);
      yield* git(fork, ["init", "--bare"]);
      yield* git(source, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", fork]);
      yield* git(cwd, ["remote", "add", "upstream", source]);
      yield* git(cwd, ["push", "origin", "stable"]);
      yield* git(cwd, ["push", "-u", "upstream", "stable:release"]);
      const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);

      yield* writeTextFile(cwd, "fork.txt", "fork-only work\n");
      yield* git(cwd, ["add", "fork.txt"]);
      yield* git(cwd, ["commit", "-m", "fork work"]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/release"]);
      yield* git(cwd, ["reset", "--hard", localHead]);

      // Advance the source without updating this checkout's tracking refs.
      yield* writeTextFile(cwd, "upstream.txt", "upstream-only work\n");
      yield* git(cwd, ["add", "upstream.txt"]);
      yield* git(cwd, ["commit", "-m", "source advance"]);
      const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(source, ["--git-dir=.", "fetch", cwd, "stable:refs/heads/release"]);
      yield* git(cwd, ["reset", "--hard", localHead]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" });
      assert.deepEqual(fetched, {
        commitSha: remoteHead,
        remoteRefName: "upstream/release",
      });
      yield* git(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);
      assert.deepEqual(
        yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "upstream/release" }),
        { commitSha: remoteHead, remoteRefName: "upstream/release" },
      );
      yield* git(cwd, ["branch", "--unset-upstream", "stable"]);
      assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "stable" }), {
        commitSha: localHead,
        remoteRefName: "origin/stable",
      });
      assert.equal(yield* git(cwd, ["rev-parse", "stable"]), localHead);

      const path = yield* Path.Path;
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "feature");
      yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: fetched!.commitSha,
        newRefName: "feature/from-upstream",
        baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
      });
      assert.equal(yield* git(worktreePath, ["rev-parse", "HEAD"]), remoteHead);
      yield* writeTextFile(worktreePath, "feature.txt", "feature work\n");
      yield* git(worktreePath, ["add", "feature.txt"]);
      yield* git(worktreePath, ["commit", "-m", "feature work"]);

      const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.deepStrictEqual(changes.files, [
        { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
      ]);
      assert.include(changes.diff, "+feature work");
      assert.notInclude(changes.diff, "upstream-only work");
      const status = yield* driver.statusDetailsLocal(worktreePath, {
        includeBranchChanges: true,
      });
      assert.strictEqual(status.aheadCount, 1);
      assert.strictEqual(status.branchChanges?.insertions, 1);
      assert.strictEqual(status.branchChanges?.deletions, 0);
      // gh pr create consumes this setting verbatim as the hosted target branch.
      assert.equal(
        yield* driver.readConfigValue(worktreePath, "branch.feature/from-upstream.t3-merge-base"),
        "release",
      );
      assert.equal(changes.baseRef, "upstream/release");
    }),
  );

  it.effect("does not use a deleted remote worktree base's stale tracking commit", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", `${initialBranch}:release`]);
      yield* git(remote, ["--git-dir=.", "update-ref", "-d", "refs/heads/release"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      assert.equal(
        yield* git(cwd, ["rev-parse", "refs/remotes/origin/release"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
      assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
      yield* git(cwd, ["remote", "remove", "origin"]);
      assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }));
    }),
  );

  it.effect("fetches a worktree base without downloading tags", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      const localHead = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "tagged release"]);
      const remoteHead = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["tag", "v1"]);
      yield* git(cwd, ["push", "origin", initialBranch, "v1"]);
      yield* git(cwd, ["tag", "-d", "v1"]);
      yield* git(cwd, ["reset", "--hard", localHead]);
      yield* git(cwd, ["update-ref", "-d", `refs/remotes/origin/${initialBranch}`]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      assert.deepEqual(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: initialBranch }), {
        commitSha: remoteHead,
        remoteRefName: `origin/${initialBranch}`,
      });
      assert.equal(yield* git(cwd, ["tag", "--list", "v1"]), "");
    }),
  );

  it.effect("fetches the remote a caller already resolved for the worktree base", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", initialBranch]);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      assert.isNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "unpublished" }));
      assert.deepEqual(
        yield* driver.fetchWorktreeBaseCommit({
          cwd,
          refName: "unpublished",
          remote: { remoteName: "origin", branchName: initialBranch },
        }),
        { commitSha: head, remoteRefName: `origin/${initialBranch}` },
      );
    }),
  );

  it.effect("fails instead of falling back when the worktree base remote is unreachable", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["remote", "add", "origin", `${cwd}/missing.git`]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const error = yield* driver
        .fetchWorktreeBaseCommit({ cwd, refName: initialBranch })
        .pipe(Effect.flip);
      assert.equal(error._tag, "GitCommandError");
    }),
  );
});
