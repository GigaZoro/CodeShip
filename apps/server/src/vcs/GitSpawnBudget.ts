import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * On Windows every git spawn blocks the server's main thread for about 130 ms, so what a
 * background job costs is its spawn count. A job running past its budget is logged with the
 * count, which makes a regression visible before it becomes an event-loop stall.
 */
export interface GitSpawnTally {
  readonly job: string;
  spawns: number;
}

const GitSpawnBudget = Context.Reference<GitSpawnTally | null>("t3/vcs/GitSpawnBudget", {
  defaultValue: () => null,
});

export const countGitSpawn = Effect.gen(function* () {
  const tally = yield* GitSpawnBudget;
  if (tally !== null) tally.spawns += 1;
});

export const withGitSpawnBudget =
  (job: string, budget: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const tally: GitSpawnTally = { job, spawns: 0 };
      return effect.pipe(
        Effect.provideService(GitSpawnBudget, tally),
        Effect.ensuring(
          Effect.suspend(() =>
            tally.spawns > budget
              ? Effect.logWarning("background job exceeded its git spawn budget", {
                  job,
                  spawns: tally.spawns,
                  budget,
                })
              : Effect.void,
          ),
        ),
      );
    });
