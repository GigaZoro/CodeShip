import { useAtomValue } from "@effect/atom-react";
import { scheduledTasksForThread } from "@t3tools/client-runtime/scheduled-task-pins";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

// A boolean, so a task update re-renders a row only when its mark appears or goes.
const threadHasScheduledTaskAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const tasks =
      AsyncResult.getOrElse(
        get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
        () => null,
      )?.tasks ?? [];
    return scheduledTasksForThread(tasks, threadId).length > 0;
  }).pipe(Atom.withLabel(`mobile:thread-has-scheduled-task:${key}`));
});

/** Whether a scheduled task keeps running in this thread. */
export function useThreadHasScheduledTask(environmentId: EnvironmentId, threadId: ThreadId) {
  return useAtomValue(threadHasScheduledTaskAtom(JSON.stringify([environmentId, threadId])));
}
