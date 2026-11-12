import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTaskStatsInput } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentPresentation } from "./environments";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

export function supportsScheduledTaskGroups(
  environment: Pick<EnvironmentPresentation, "serverConfig"> | null | undefined,
): boolean {
  return environment?.serverConfig?.environment.capabilities.scheduledTaskGroups === true;
}

/** Keyed by the ids and range so equal lists reuse the atom, like `environmentAtomList`. */
const scheduledTaskStatsListAtom = Atom.family((key: string) => {
  const { ids, input } = JSON.parse(key) as {
    ids: ReadonlyArray<EnvironmentId>;
    input: ScheduledTaskStatsInput;
  };
  return Atom.make((get) =>
    ids.map((environmentId) => get(serverEnvironment.scheduledTaskStats({ environmentId, input }))),
  ).pipe(Atom.withLabel(`web-scheduled-task-stats:${key}`));
});

/** One answer per environment, in the order given. */
export function useScheduledTaskStats(
  environmentIds: ReadonlyArray<EnvironmentId>,
  input: ScheduledTaskStatsInput,
) {
  const results = useAtomValue(
    scheduledTaskStatsListAtom(JSON.stringify({ ids: environmentIds, input })),
  );
  return environmentIds.map((environmentId, index) => {
    const result = results[index]!;
    return {
      environmentId,
      stats: AsyncResult.getOrElse(result, () => null)?.tasks ?? null,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  });
}
