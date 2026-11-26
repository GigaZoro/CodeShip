import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  GitManagerError,
  GitCommandError,
  VcsCheckoutBusyError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
  type VcsUnmergedWorkResult,
} from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { gitFailureFacts } from "../vcs/GitVcsDriverCore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly repositoryRoot: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    /** Counts HEAD's commits whose changes `baseRef` (else the branch's own base) lacks. */
    readonly countUnmergedCommits: (input: {
      readonly cwd: string;
      readonly baseRef?: string;
    }) => Effect.Effect<number, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitLocalStatusOptions,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly unmergedWork: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsUnmergedWorkResult, GitManagerServiceError>;
    readonly upstreamDivergence: (cwd: string) => Effect.Effect<
      {
        readonly refName: string;
        readonly aheadCount: number;
        readonly behindCount: number;
      } | null,
      GitManagerServiceError
    >;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly readRefSnapshot: (cwd: string) => Effect.Effect<string | null>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    /** The checkout's own HEAD file, inside a linked worktree's admin directory when there is one. */
    readonly headPath: (cwd: string) => Effect.Effect<string | null, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<
      GitPreparePullRequestThreadResult,
      GitManagerServiceError | VcsCheckoutBusyError
    >;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions & {
        readonly releasedBranch?: { readonly previousHead: string; readonly baseRef: string };
      },
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchCommit: GitVcsDriver.GitVcsDriver["Service"]["fetchCommit"];
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError | VcsCheckoutBusyError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError | VcsCheckoutBusyError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("t3/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

// Settling waits on this fetch, so an unreachable remote must not hold it for long.
const UNMERGED_WORK_FETCH_TIMEOUT = Duration.seconds(10);

/** @public */
// Detection fails for a timeout, a Git exit or a missing repository; the person reading the chat needs which.
export const resolveFailureDetail = (base: string, cause: { readonly message: string }) =>
  `${base} ${cause.message}`;

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    realPath(rootPath).pipe(Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)));

  const findActiveTurnIn = Effect.fn("GitWorkflowService.findActiveTurnIn")(function* (
    checkoutRoot: string,
  ) {
    for (const workspace of yield* threads.getActiveTurnWorkspaces()) {
      const folder =
        workspace.worktreePath ??
        Option.getOrNull(yield* projects.get(workspace.projectId))?.workspaceRoot;
      if (folder === undefined) continue;
      const turnCwd = yield* realPath(folder);
      if (contains(turnCwd, checkoutRoot)) return workspace.threadId;
      if (!contains(checkoutRoot, turnCwd)) continue;
      // A removed worktree folder is no checkout, and git cannot run in it.
      if (!(yield* fileSystem.exists(turnCwd))) continue;
      // A worktree inside the checkout's folder is a checkout of its own.
      const handle = yield* registry.detect({ cwd: turnCwd });
      if (handle !== null && (yield* realPath(handle.repository.rootPath)) === checkoutRoot) {
        return workspace.threadId;
      }
    }
    return null;
  });

  // A switch moves files under the agent, and a turn holds the lease only while it starts.
  const ensureCheckoutIdle = Effect.fn("GitWorkflowService.ensureCheckoutIdle")(function* (
    operation: string,
    cwd: string,
    checkoutRoot: string,
  ) {
    const threadId = yield* findActiveTurnIn(checkoutRoot).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "turn-guard",
            cwd,
            detail: "Failed to check for turns running in this checkout.",
            cause,
          }),
      ),
    );
    if (threadId !== null) {
      return yield* new VcsCheckoutBusyError({ operation, cwd, threadId });
    }
  });

  const withIdleCheckoutLease = <A, E, R>(
    operation: string,
    cwd: string,
    rootPath: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    realPath(rootPath).pipe(
      Effect.flatMap((checkoutRoot) =>
        withWorkspaceLease(
          checkoutRoot,
          ensureCheckoutIdle(operation, cwd, checkoutRoot).pipe(Effect.andThen(effect)),
        ),
      ),
    );

  // The registry reads a repository Git cannot read as none; a Git workflow needs Git's reason.
  const resolveRepository = (cwd: string) =>
    registry.resolve({ cwd }).pipe(
      Effect.catchTags({
        VcsUnsupportedOperationError: (unsupported) =>
          registry.get("git").pipe(
            Effect.flatMap((driver) => driver.detectRepository(cwd)),
            Effect.andThen(Effect.fail(unsupported)),
          ),
      }),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveRepository(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: resolveFailureDetail(
              "Failed to resolve the VCS driver for this Git workflow.",
              cause,
            ),
            cause,
          }),
      ),
    );
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* resolveRepository(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: resolveFailureDetail(
              "Failed to resolve the VCS driver for this Git command.",
              cause,
            ),
            cause,
          }),
      ),
    );
    return handle;
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    return true;
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    repositoryRoot: Effect.fn("GitWorkflowService.repositoryRoot")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => (handle?.kind === "git" ? handle.repository.rootPath : null)),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.repositoryRoot",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return /[*?[\\]/.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    countUnmergedCommits: Effect.fn("GitWorkflowService.countUnmergedCommits")(function (input) {
      return ensureGitCommand("GitWorkflowService.countUnmergedCommits", input.cwd).pipe(
        Effect.andThen(git.countUnmergedCommits(input)),
      );
    }),
    status: Effect.fn("GitWorkflowService.status")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input, options)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      );
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      if (!(yield* detectGitRepositoryForStatus("GitWorkflowService.currentBranch", cwd))) {
        return null;
      }
      const result = yield* git.execute({
        operation: "GitWorkflowService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return result.stdout.trim().replace(/^refs\/heads\//, "") || null;
      }
      if (result.exitCode === 1) return null;
      return yield* new GitCommandError({
        operation: "GitWorkflowService.currentBranch",
        command: "git symbolic-ref",
        cwd,
        argumentCount: 3,
        ...gitFailureFacts(result, { quoteGitLines: true }),
        detail: "Failed to read the checked-out branch.",
      });
    }),
    unmergedWork: Effect.fn("GitWorkflowService.unmergedWork")(function* (input) {
      const none = { refName: null, changedFileCount: 0, unmergedCommitCount: 0 };
      // A .git that Git rejects (a damaged HEAD, a pruned worktree) may still hold work.
      const notRepository = Effect.fnUntraced(function* () {
        const rejected = yield* fileSystem
          .exists(path.join(input.cwd, ".git"))
          .pipe(Effect.orElseSucceed(() => true));
        if (!rejected) return none;
        return yield* new GitManagerError({
          operation: "GitWorkflowService.unmergedWork",
          cwd: input.cwd,
          detail: "Git does not recognize this worktree's .git.",
        });
      });
      if (!(yield* detectGitRepositoryForStatus("GitWorkflowService.unmergedWork", input.cwd))) {
        return yield* notRepository();
      }
      const read = Effect.fnUntraced(function* () {
        const details = yield* git.statusDetailsLocal(input.cwd, {
          includeDivergence: false,
          listAllChanges: true,
        });
        // The registry keeps a repository it detected until its .git entries change on disk.
        if (!details.isRepo) return yield* notRepository();
        // Status reads a divergence it cannot count as none; this count fails instead.
        const unmergedCommitCount = details.isDefaultBranch
          ? 0
          : yield* git.countUnmergedCommits({ cwd: input.cwd });
        return {
          refName: details.branch,
          changedFileCount: details.workingTree.files.length,
          unmergedCommitCount,
        };
      });
      const remoteDefaultBranch = Effect.fnUntraced(function* (remoteName: string) {
        const named = yield* git.resolveDefaultBranchName(input.cwd, remoteName);
        if (named !== null) return named;
        // Repositories that were not cloned have no remote HEAD to name the default.
        for (const refName of ["main", "master"]) {
          if (yield* git.remoteBranchExists({ cwd: input.cwd, remoteName, refName })) {
            return refName;
          }
        }
        return null;
      });
      // A merge, push or rewind elsewhere reaches the local default ref only after a fetch, and a stale
      // ref that over-reports the default branch makes the count 0, so the fetch comes before it.
      const fetchDefaultBranch = Effect.fnUntraced(function* () {
        const remoteName = yield* git.resolvePrimaryRemoteName(input.cwd);
        const remoteBranch = yield* remoteDefaultBranch(remoteName);
        if (remoteBranch === null) return;
        yield* git.fetchRemoteTrackingBranch({ cwd: input.cwd, remoteName, remoteBranch });
      });
      yield* fetchDefaultBranch().pipe(Effect.timeout(UNMERGED_WORK_FETCH_TIMEOUT), Effect.ignore);
      const work = yield* read();
      if (work.unmergedCommitCount === 0) return work;
      // The count compares the branch with the base T3 recorded for it, else the default branch.
      const countBase = Effect.fnUntraced(function* (refName: string) {
        const recorded = yield* git.readBranchBase(input.cwd, refName);
        if (recorded !== null) return recorded;
        return yield* git.resolvePrimaryRemoteName(input.cwd).pipe(
          Effect.flatMap(remoteDefaultBranch),
          Effect.orElseSucceed(() => null),
        );
      });
      if (work.refName !== null) {
        // Squash and rebase merges leave the branch's own commits outside the default branch.
        // A lookup that fails keeps the commits counted, so the warning errs toward showing.
        const pullRequest = yield* gitManager
          .branchPullRequest({ cwd: input.cwd, branch: work.refName }, { freshGitState: true })
          .pipe(Effect.orElseSucceed(() => null));
        // Commits added after the merge are still unmerged, so only the merged head clears them,
        // and only when it merged into the branch the count compares with.
        if (pullRequest?.state === "merged" && pullRequest.headSha) {
          const head = yield* git.resolveCommit({ cwd: input.cwd, revision: "HEAD" });
          if (
            head.commitSha === pullRequest.headSha &&
            pullRequest.baseRef === (yield* countBase(work.refName))
          ) {
            return { ...work, unmergedCommitCount: 0 };
          }
        }
      }
      return work;
    }),
    upstreamDivergence: Effect.fn("GitWorkflowService.upstreamDivergence")(function* (cwd) {
      const details = yield* git.statusDetailsRemote(cwd, { refreshUpstream: false });
      return details.hasUpstream && details.branch !== null
        ? {
            refName: details.branch,
            aheadCount: details.aheadCount,
            behindCount: details.behindCount,
          }
        : null;
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    readRefSnapshot: git.readRefSnapshot,
    invalidateStatus: gitManager.invalidateStatus,
    headPath: Effect.fn("GitWorkflowService.headPath")(function (cwd) {
      return git
        .execute({
          operation: "GitWorkflowService.headPath",
          cwd,
          args: ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
          Effect.orElseSucceed(() => null),
        );
    }),
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function (input, options) {
      return ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitManager.runStackedAction(input, options),
          ),
        ),
      );
    }),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        const operation = "GitWorkflowService.preparePullRequestThread";
        return ensureGit(operation, input.cwd).pipe(
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withIdleCheckoutLease(
                  operation,
                  input.cwd,
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function* (input, options) {
      yield* ensureGitCommand("GitWorkflowService.createWorktree", input.cwd);
      if (options?.releasedBranch) {
        const ref = "refs/heads/" + input.refName;
        const { commitSha } = yield* git.resolveCommit({ cwd: input.cwd, revision: ref });
        if (commitSha === options.releasedBranch.previousHead) {
          // Local fetch fast-forwards only and refuses to update a branch checked out elsewhere.
          yield* git.executeRemote({
            cwd: input.cwd,
            operation: "GitWorkflowService.advanceReleasedBranch",
            timeoutMs: 30_000,
            fallbackErrorDetail:
              "Git could not fast-forward the released branch to the project's current base.",
            args: [
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-recurse-submodules",
              "--no-write-fetch-head",
              "--no-auto-maintenance",
              "--",
              ".",
              options.releasedBranch.baseRef + ":" + ref,
            ],
          });
        }
      }
      return yield* gitManager.createWorktree(input, options);
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      );
    }),
    fetchCommit: Effect.fn("GitWorkflowService.fetchCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchCommit", input.cwd).pipe(
        Effect.andThen(git.fetchCommit(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolvePrimaryRemoteName: Effect.fn("GitWorkflowService.resolvePrimaryRemoteName")(
      function (cwd) {
        return ensureGitCommand("GitWorkflowService.resolvePrimaryRemoteName", cwd).pipe(
          Effect.andThen(git.resolvePrimaryRemoteName(cwd)),
        );
      },
    ),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
          Effect.andThen(git.resolveWorktreeBaseRemote(input)),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        );
      },
    ),
    resolveDefaultBranchName: Effect.fn("GitWorkflowService.resolveDefaultBranchName")(
      function (cwd, remoteName) {
        return ensureGitCommand("GitWorkflowService.resolveDefaultBranchName", cwd).pipe(
          Effect.andThen(git.resolveDefaultBranchName(cwd, remoteName)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function (input) {
      return ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      );
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function (input) {
      return ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      const operation = "GitWorkflowService.createRef";
      return ensureGitCommand(operation, input.cwd).pipe(
        Effect.flatMap((handle) =>
          input.switchRef
            ? withIdleCheckoutLease(
                operation,
                input.cwd,
                handle.repository.rootPath,
                git.createRef(input),
              )
            : git.createRef(input),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      const operation = "GitWorkflowService.switchRef";
      return ensureGitCommand(operation, input.cwd).pipe(
        Effect.flatMap((handle) =>
          withIdleCheckoutLease(
            operation,
            input.cwd,
            handle.repository.rootPath,
            Effect.scoped(git.switchRef(input)),
          ),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function (input) {
      return ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
