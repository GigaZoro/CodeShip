import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, VcsCheckoutBusyError } from "@t3tools/contracts";
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

  it.effect("counts uncommitted files and commits the default branch lacks", () => {
    let pullRequest: GitManager.GitBranchPullRequest | null = null;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-unmerged-" });
      const origin = `${root}/origin.git`;
      const cwd = `${root}/work`;
      yield* fileSystem.makeDirectory(origin);
      yield* fileSystem.makeDirectory(cwd);
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = (dir: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.setupRepo", cwd: dir, args: [...args] });
      const commit = ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty"];
      yield* git(origin, ["init", "--bare", "-b", "main"]);
      for (const args of [
        ["init", "-b", "main"],
        [...commit, "-m", "init"],
        ["remote", "add", "origin", origin],
        ["push", "-u", "origin", "main"],
      ]) {
        yield* git(cwd, args);
      }
      assert.deepEqual(yield* workflow.unmergedWork({ cwd }), {
        refName: "main",
        changedFileCount: 0,
        unmergedCommitCount: 0,
      });

      yield* git(cwd, ["switch", "-c", "t3/feature"]);
      yield* git(cwd, [...commit, "-m", "one"]);
      yield* git(cwd, [...commit, "-m", "two"]);
      yield* fileSystem.writeFileString(`${cwd}/notes.txt`, "draft");
      assert.deepEqual(yield* workflow.unmergedWork({ cwd }), {
        refName: "t3/feature",
        changedFileCount: 1,
        unmergedCommitCount: 2,
      });

      const head = yield* driver.resolveCommit({ cwd, revision: "HEAD" });
      pullRequest = {
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
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 0);
      yield* git(cwd, [...commit, "-m", "after merge"]);
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 3);

      // Shipped from another checkout: the local default ref lags until the check fetches it.
      const staleMain = yield* driver.resolveCommit({ cwd, revision: "origin/main" });
      yield* git(cwd, ["push", "origin", "HEAD:main"]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/main", staleMain.commitSha]);
      pullRequest = null;
      assert.equal((yield* workflow.unmergedWork({ cwd })).unmergedCommitCount, 0);
      assert.deepEqual(yield* workflow.unmergedWork({ cwd: `${root}/missing` }), {
        refName: null,
        changedFileCount: 0,
        unmergedCommitCount: 0,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: ({ cwd }) =>
                Effect.succeed(
                  cwd.endsWith("/missing")
                    ? null
                    : ({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(pullRequest),
            }),
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
        ),
      ),
    );
  });

  it.effect("refuses to move a checkout while a turn is running in it", () => {
    let active: ActiveTurnWorkspaces = [];
    let projectRoot = "";
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-turn-guard-" });
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
