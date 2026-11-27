import { assert, it } from "@effect/vitest";
import {
  GitCommandError,
  ProjectId,
  ThreadId,
  VcsCheckoutBusyError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

type ActiveTurnWorkspaces = ReadonlyArray<ProjectionStore.ActiveTurnWorkspace>;

const layerActiveTurns = (
  workspaces: () => ActiveTurnWorkspaces = () => [],
  projectRoot: () => string = () => "/unused",
) =>
  Layer.merge(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getActiveTurnWorkspaces: () => Effect.sync(workspaces),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.sync(() => Option.some({ workspaceRoot: projectRoot() } as ProjectStore.ProjectRow)),
    }),
  );

const layerUnmergedWork = (
  pullRequest: () => GitManager.GitBranchPullRequest | null = () => null,
) =>
  GitWorkflowService.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer),
    Layer.provide(
      Layer.mock(GitManager.GitManager)({ branchPullRequest: () => Effect.sync(pullRequest) }),
    ),
    Layer.provide(layerActiveTurns()),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-unmerged-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

// A repository on main with one commit and no remote, so the check's fetch gives up at once.
const unmergedWorkRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-unmerged-" });
  const cwd = `${root}/work`;
  yield* fileSystem.makeDirectory(cwd);
  const git = (dir: string, args: ReadonlyArray<string>) =>
    driver.execute({ operation: "test.setupRepo", cwd: dir, args: [...args] });
  const commit = ["-c", "user.email=t@t", "-c", "user.name=t", "commit"];
  // Empty commits carry no change, so each commit edits a file of its own.
  const change = (name: string) =>
    Effect.gen(function* () {
      yield* fileSystem.writeFileString(`${cwd}/${name}.txt`, name);
      yield* git(cwd, ["add", `${name}.txt`]);
      yield* git(cwd, [...commit, "-m", name]);
    });
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, [...commit, "--allow-empty", "-m", "init"]);
  return { root, cwd, git, change, driver, workflow };
});

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(layerActiveTurns()),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps why the VCS driver could not be resolved in the Git command error", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* Effect.flip(workflow.hasRefNamed({ cwd: "/repo", refName: "main" }));
      assert.instanceOf(error, GitCommandError);
      assert.include(error.detail, "Failed to resolve the VCS driver for this Git command.");
      assert.include(error.message, "timed out");
      assert.include(error.message, "5000ms");
    }).pipe(
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () =>
                Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: "GitVcsDriver.detectRepository",
                    command: "git",
                    cwd: "/repo",
                    timeoutMs: 5000,
                  }),
                ),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(layerActiveTurns()),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-resolve-failure-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("counts uncommitted files and commits the default branch lacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { cwd, git, change, workflow } = yield* unmergedWorkRepo;
      assert.deepEqual(yield* workflow.unmergedWork({ cwd }), {
        refName: "main",
        changedFileCount: 0,
        unmergedCommitCount: 0,
      });

      yield* git(cwd, ["switch", "-c", "t3/feature"]);
      yield* change("one");
      yield* change("two");
      yield* fileSystem.writeFileString(`${cwd}/notes.txt`, "draft");
      assert.deepEqual(yield* workflow.unmergedWork({ cwd }), {
        refName: "t3/feature",
        changedFileCount: 1,
        unmergedCommitCount: 2,
      });
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect("counts each change that config hides from status", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { cwd, git, workflow } = yield* unmergedWorkRepo;
      const commit = ["-c", "user.email=t@t", "-c", "user.name=t", "commit"];
      // An existing repository at the path is added as is, without a clone.
      yield* fileSystem.makeDirectory(`${cwd}/vendored`);
      yield* git(`${cwd}/vendored`, ["init", "-b", "main"]);
      yield* git(`${cwd}/vendored`, [...commit, "--allow-empty", "-m", "init"]);
      yield* git(cwd, ["submodule", "add", "./vendored", "vendored"]);
      yield* git(cwd, [...commit, "-m", "vendored"]);
      yield* git(cwd, ["config", "submodule.vendored.ignore", "all"]);
      yield* git(cwd, ["config", "status.showUntrackedFiles", "no"]);
      yield* fileSystem.writeFileString(`${cwd}/vendored/draft.txt`, "draft");
      yield* fileSystem.makeDirectory(`${cwd}/drafts`);
      yield* fileSystem.writeFileString(`${cwd}/drafts/one.txt`, "draft");
      yield* fileSystem.writeFileString(`${cwd}/drafts/two.txt`, "draft");
      assert.equal((yield* workflow.unmergedWork({ cwd })).changedFileCount, 3);
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect("clears the commits of a merged pull request only up to its head", () => {
    let pullRequest: GitManager.GitBranchPullRequest | null = null;
    return Effect.gen(function* () {
      const { cwd, git, change, driver, workflow } = yield* unmergedWorkRepo;
      yield* git(cwd, ["switch", "-c", "t3/feature"]);
      // T3 records the branch a worktree's branch was cut from.
      yield* git(cwd, ["config", "branch.t3/feature.t3-merge-base", "main"]);
      yield* change("one");
      const head = yield* driver.resolveCommit({ cwd, revision: "HEAD" });
      const merged: GitManager.GitBranchPullRequest = {
        number: 1,
        title: "Feature",
        url: "https://github.com/t3/t3/pull/1",
        baseRef: "main",
        headRef: "t3/feature",
        state: "merged",
        repositoryKey: null,
        updatedAt: null,
        headSha: head.commitSha,
      };
      pullRequest = merged;
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 0);
      // A merge into another branch leaves the commits outside the branch's base.
      pullRequest = { ...merged, baseRef: "staging" };
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 1);
      pullRequest = merged;
      yield* change("after-merge");
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 2);
      // Without the merged head, the merge cannot vouch for the commits checked out.
      pullRequest = { ...merged, headSha: null };
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 2);
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork(() => pullRequest)));
  });

  it.effect("fetches the default branch before counting work shipped from another checkout", () =>
    Effect.gen(function* () {
      const { root, cwd, git, change, workflow } = yield* unmergedWorkRepo;
      const origin = `${root}/origin.git`;
      for (const args of [
        ["init", "--bare", "-b", "main", origin],
        ["remote", "add", "origin", origin],
        ["push", "origin", "main"],
        ["switch", "-c", "t3/feature"],
      ]) {
        yield* git(cwd, args);
      }
      yield* change("one");
      yield* git(cwd, ["push", "origin", "HEAD:main"]);
      // The local default ref lags behind the remote until the check fetches it.
      yield* git(cwd, ["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 0);
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect("counts a commit the remote default branch no longer holds after it was rewound", () =>
    Effect.gen(function* () {
      const { root, cwd, git, change, workflow } = yield* unmergedWorkRepo;
      const origin = `${root}/origin.git`;
      for (const args of [
        ["init", "--bare", "-b", "main", origin],
        ["remote", "add", "origin", origin],
        ["push", "origin", "main"],
        ["switch", "-c", "t3/feature"],
      ]) {
        yield* git(cwd, args);
      }
      yield* change("one");
      yield* git(cwd, ["push", "origin", "HEAD:main"]);
      yield* git(cwd, ["fetch", "origin"]);
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 0);
      // The remote drops the commit; the local remote-tracking ref still holds it.
      yield* git(cwd, ["push", "--force", "origin", "HEAD~1:refs/heads/main"]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 1);
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect("finds no work in a missing folder but fails on a .git Git rejects", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { root, cwd, git, change, workflow } = yield* unmergedWorkRepo;
      assert.deepEqual(yield* workflow.unmergedWork({ cwd: `${root}/missing` }), {
        refName: null,
        changedFileCount: 0,
        unmergedCommitCount: 0,
      });
      // Git rejects this .git as it does a pruned worktree's, yet the folder may hold work.
      yield* fileSystem.makeDirectory(`${root}/pruned`);
      yield* fileSystem.writeFileString(`${root}/pruned/.git`, `gitdir: ${root}/gone\n`);
      const pruned = yield* Effect.flip(workflow.unmergedWork({ cwd: `${root}/pruned` }));
      assert.include(pruned.message, "does not recognize");

      // The repository stays detected after its HEAD breaks, so status is what finds it rejected.
      yield* git(cwd, ["switch", "-c", "t3/feature"]);
      yield* change("one");
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 1);
      yield* fileSystem.writeFileString(`${cwd}/.git/HEAD`, "not a ref\n");
      const damaged = yield* Effect.flip(workflow.unmergedWork({ cwd }));
      assert.include(damaged.message, "does not recognize");
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect("fails instead of counting zero when Git cannot count the commits", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { root, cwd, git, change, workflow } = yield* unmergedWorkRepo;
      yield* git(cwd, ["switch", "-c", "t3/feature"]);
      yield* change("unpushed");
      // The default branch's ref names a commit Git stores but cannot parse, so counting fails.
      yield* fileSystem.writeFileString(`${root}/bogus`, "not a commit\n");
      const bogus = yield* git(cwd, [
        "hash-object",
        "-t",
        "commit",
        "--literally",
        "-w",
        `${root}/bogus`,
      ]);
      yield* git(cwd, ["remote", "add", "origin", `${root}/nowhere`]);
      yield* fileSystem.makeDirectory(`${cwd}/.git/refs/remotes/origin`, { recursive: true });
      yield* fileSystem.writeFileString(`${cwd}/.git/refs/remotes/origin/main`, bogus.stdout);
      const failure = yield* Effect.flip(workflow.unmergedWork({ cwd }));
      assert.include(failure.message, "GitVcsDriver.countUnmergedCommits.rangeCount");
    }).pipe(Effect.scoped, Effect.provide(layerUnmergedWork())),
  );

  it.effect(
    "moves a released branch to the base only while a durable ref still holds its head",
    () => {
      const created: string[] = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-released-" });
        const cwd = `${root}/repo`;
        yield* fileSystem.makeDirectory(cwd);
        const git = (...args: ReadonlyArray<string>) =>
          driver
            .execute({ operation: "test.setupRepo", cwd, args: [...args] })
            .pipe(Effect.map((result) => result.stdout.trim()));
        const commit = (name: string) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(`${cwd}/${name}.txt`, name);
            yield* git("add", `${name}.txt`);
            yield* git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", name);
            return yield* git("rev-parse", "HEAD");
          });
        const tip = (branch: string) => git("rev-parse", `refs/heads/${branch}`);
        yield* git("init", "-b", "main");
        yield* commit("init");
        const branchWith = (branch: string, file: string) =>
          git("switch", "-c", branch, "main").pipe(
            Effect.andThen(commit(file)),
            Effect.tap(() => git("switch", "main")),
          );
        const rebased = yield* branchWith("rebased", "landed");
        const unlanded = yield* branchWith("archived", "unlanded");
        const forgotten = yield* branchWith("forgotten", "lost");
        const busy = yield* branchWith("busy", "busy");
        const moved = yield* branchWith("moved", "moved");
        yield* git("update-ref", "refs/remotes/origin/rebased", rebased);
        yield* git("update-ref", "refs/archive/archived", unlanded);
        yield* git("update-ref", "refs/archive/busy", busy);
        yield* git("-c", "user.email=t@t", "-c", "user.name=t", "cherry-pick", rebased);
        yield* fileSystem.writeFileString(`${cwd}/busy.txt`, "conflict");
        yield* git("add", "busy.txt");
        yield* git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "conflict");
        const base = yield* git("rev-parse", "main");
        yield* git("switch", "moved");
        const movedTip = yield* commit("after-release");
        yield* git("switch", "main");
        yield* git("worktree", "add", `${root}/busy`, "busy");
        // A rebase stopped on a conflict detaches HEAD but still holds the branch.
        yield* driver.execute({
          operation: "test.setupRepo",
          cwd: `${root}/busy`,
          args: ["-c", "user.email=t@t", "-c", "user.name=t", "rebase", "main"],
          allowNonZeroExit: true,
        });

        const recreate = (branch: string, previousHead: string, durableRefs: string[]) =>
          workflow.createWorktree(
            { cwd, refName: branch, path: `${root}/${branch}-new` },
            { releasedBranch: { previousHead, baseRef: "refs/heads/main", durableRefs } },
          );
        yield* recreate("rebased", rebased, ["refs/remotes/origin/rebased"]);
        yield* recreate("archived", unlanded, ["refs/heads/main", "refs/archive/archived"]);
        yield* recreate("forgotten", forgotten, ["refs/heads/main", "refs/archive/deleted"]);
        yield* recreate("moved", moved, ["refs/heads/main"]);
        const refused = yield* Effect.flip(recreate("busy", busy, ["refs/archive/busy"]));

        assert.deepEqual(
          {
            rebased: yield* tip("rebased"),
            archived: yield* tip("archived"),
            forgotten: yield* tip("forgotten"),
            moved: yield* tip("moved"),
            busy: yield* tip("busy"),
          },
          { rebased: base, archived: base, forgotten, moved: movedTip, busy },
        );
        assert.deepEqual(created, ["rebased", "archived", "forgotten", "moved"]);
        assert.include(refused.message, "another worktree");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(layerActiveTurns()),
            Layer.provide(VcsDriverRegistry.layer),
            Layer.provide(
              Layer.mock(GitManager.GitManager)({
                createWorktree: (input) =>
                  Effect.sync(() => {
                    created.push(input.refName);
                    return { worktree: { path: input.path ?? "", refName: input.refName } };
                  }),
              }),
            ),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provideMerge(VcsProcess.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-released-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    },
  );

  it.effect("refuses to move a checkout while a turn is running in it", () => {
    let active: ActiveTurnWorkspaces = [];
    let projectRoot = "";
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // Resolved, or macOS's /var link puts the missing worktree outside the resolved checkout.
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-turn-guard-" }),
      );
      const cwd = `${root}/repo`;
      const nested = `${cwd}/src`;
      const side = `${cwd}/.worktrees/side`;
      projectRoot = cwd;
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["branch", "other"],
        ["worktree", "add", "-b", "side", side],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const projectId = ProjectId.make("project:turn-guard");
      const projectTurn = {
        threadId: ThreadId.make("thread:project"),
        projectId,
        worktreePath: null,
      };
      const sideTurn = { threadId: ThreadId.make("thread:side"), projectId, worktreePath: side };

      const goneTurn = {
        threadId: ThreadId.make("thread:gone"),
        projectId,
        worktreePath: `${cwd}/.worktrees/gone`,
      };

      // A worktree inside the checkout's folder is a checkout of its own.
      active = [sideTurn, goneTurn];
      assert.deepEqual(yield* workflow.switchRef({ cwd, refName: "other" }), { refName: "other" });
      const sideBusy = yield* Effect.flip(workflow.switchRef({ cwd: side, refName: "main" }));
      assert.instanceOf(sideBusy, VcsCheckoutBusyError);
      assert.equal(sideBusy.threadId, sideTurn.threadId);

      active = [projectTurn];
      for (const refused of [
        workflow.switchRef({ cwd: nested, refName: "main" }),
        workflow.createRef({ cwd: nested, refName: "feature", switchRef: true }),
      ]) {
        const busy = yield* Effect.flip(refused);
        assert.instanceOf(busy, VcsCheckoutBusyError);
        assert.equal(busy.threadId, projectTurn.threadId);
      }
      assert.equal(yield* workflow.currentBranch(cwd), "other");
      assert.deepEqual(yield* workflow.createRef({ cwd, refName: "feature" }), {
        refName: "feature",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            layerActiveTurns(
              () => active,
              () => projectRoot,
            ),
          ),
          Layer.provide(VcsDriverRegistry.layer),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-turn-guard-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });
});
