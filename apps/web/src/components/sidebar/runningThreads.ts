import {
  EnvironmentId,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "~/state/threads";

const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

export interface RunningThread {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationV2ThreadShell;
}

/** Keyed by `environmentIdsKey` so equal id lists share one atom. */
export const runningThreadsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get): ReadonlyArray<RunningThread> =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .flatMap((id) => {
        const environmentId = EnvironmentId.make(id);
        return get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap(
          (thread) => (isRunning(thread.status) ? [{ environmentId, thread }] : []),
        );
      }),
  ).pipe(Atom.withLabel(`running-threads:${environmentIds}`)),
);

/** A count re-renders only when it changes, unlike the list. */
export const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) => get(runningThreadsAtom(environmentIds)).length).pipe(
    Atom.withLabel(`running-thread-count:${environmentIds}`),
  ),
);

// Mirrors the server's restart continuation: a turn blocked on a person's answer stops instead.
const resumesAfterRestart = (request: OrchestrationV2PendingRuntimeRequestSummary | null) =>
  request === null ||
  request.blocking === false ||
  request.kind === "dynamic_tool_call" ||
  request.kind === "auth_refresh";

export function splitRunningThreadsForRestart(threads: ReadonlyArray<RunningThread>): {
  readonly resuming: ReadonlyArray<RunningThread>;
  readonly waitingOnYou: ReadonlyArray<RunningThread>;
} {
  const resuming: Array<RunningThread> = [];
  const waitingOnYou: Array<RunningThread> = [];
  for (const running of threads) {
    (resumesAfterRestart(running.thread.pendingRuntimeRequest) ? resuming : waitingOnYou).push(
      running,
    );
  }
  return { resuming, waitingOnYou };
}
