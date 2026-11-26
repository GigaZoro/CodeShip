import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master"] as const;

/**
 * Where a new worktree starts when its caller names no base: the project's default branch,
 * fetched from its remote first. Scheduled tasks, agent launches and chats started for the user
 * start here; `fromOrigin: false` starts from the local branch instead, as the "start from
 * origin" setting can ask of a new chat.
 */
export const defaultWorktreeStrategy = Effect.fn("vcs.defaultWorktreeStrategy")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  { fromOrigin }: { readonly fromOrigin: boolean } = { fromOrigin: true },
) {
  const refExists = (revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const resolveBaseRef = Effect.gen(function* () {
    const remoteName = yield* git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    const remoteDefault =
      remoteName === null
        ? null
        : yield* git
            .resolveDefaultBranchName(cwd, remoteName)
            .pipe(Effect.orElseSucceed(() => null));
    if (remoteName !== null && fromOrigin) {
      if (
        remoteDefault !== null &&
        (yield* refExists(`refs/remotes/${remoteName}/${remoteDefault}`))
      ) {
        return `${remoteName}/${remoteDefault}`;
      }
      // A single-branch clone may contain a secondary main or master. Ask the remote when the
      // worktree is prepared, so an offline machine can still configure a scheduled task.
      return `refs/remotes/${remoteName}/HEAD`;
    }
    const branches =
      remoteDefault === null
        ? CONVENTIONAL_DEFAULT_BRANCHES
        : [remoteDefault, ...CONVENTIONAL_DEFAULT_BRANCHES];
    for (const branch of branches) {
      if (yield* refExists(`refs/heads/${branch}`)) return branch;
    }
    // A local start in a repository whose branches follow no convention, such as one with only
    // `trunk`: its checked-out branch, or the commit a detached checkout is on.
    const checkedOut = yield* git
      .resolveBranchName(cwd, "HEAD")
      .pipe(Effect.orElseSucceed(() => null));
    if (checkedOut !== null) return checkedOut;
    const head = yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
      Effect.map(({ commitSha }) => commitSha),
      Effect.orElseSucceed(() => null),
    );
    return head ?? CONVENTIONAL_DEFAULT_BRANCHES[0];
  });
  return {
    type: "worktree" as const,
    baseRef: yield* resolveBaseRef,
    startFromOrigin: fromOrigin,
  };
});
