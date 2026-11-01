import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** Servers without task pinning leave pinnedAt out of the task entirely. */
export function supportsScheduledTaskPinning(task: Pick<ScheduledTask, "pinnedAt">): boolean {
  return task.pinnedAt !== undefined;
}

export function useSetScheduledTaskPinned() {
  const setPinned = useAtomCommand(serverEnvironment.setScheduledTaskPinned, {
    label: "scheduled task pin",
  });
  return async (environmentId: EnvironmentId, task: ScheduledTask, pinned: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await setPinned({ environmentId, input: { id: task.id, pinned } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Could not pin task" : "Could not unpin task",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
}
