import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master"];

/**
 * Where a new worktree starts when its caller names no base: the project's default branch,
 * fetched from its remote first. Scheduled tasks and agent launches both start here.
 */
export const defaultWorktreeStrategy = Effect.fn("vcs.defaultWorktreeStrategy")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
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
    if (remoteName !== null) {
      const remoteDefault = yield* git
        .resolveDefaultBranchName(cwd, remoteName)
        .pipe(Effect.orElseSucceed(() => null));
      // Fetch does not update a recorded HEAD, so it can outlive the branch it names.
      for (const branch of remoteDefault === null
        ? CONVENTIONAL_DEFAULT_BRANCHES
        : [remoteDefault, ...CONVENTIONAL_DEFAULT_BRANCHES]) {
        // Launch resolves a bare name through a local branch's upstream, or else assumes `origin`.
        if (yield* refExists(`refs/remotes/${remoteName}/${branch}`)) {
          return `${remoteName}/${branch}`;
        }
      }
    }
    // Local-only repositories, or a remote with neither a usable HEAD nor a conventional branch.
    for (const branch of CONVENTIONAL_DEFAULT_BRANCHES) {
      if (yield* refExists(`refs/heads/${branch}`)) return branch;
    }
    return "main";
  });
  return {
    type: "worktree" as const,
    baseRef: yield* resolveBaseRef,
    startFromOrigin: true,
  };
});
