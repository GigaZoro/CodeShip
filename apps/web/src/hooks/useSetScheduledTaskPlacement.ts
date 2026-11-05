import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskPlacement,
} from "@t3tools/contracts";
import { t } from "~/i18n";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** Servers that predate placements leave it out of the task, so they cannot move one. */
export function supportsScheduledTaskPlacement(task: Pick<ScheduledTask, "placement">): boolean {
  return task.placement !== undefined;
}

export function useSetScheduledTaskPlacement() {
  const setPlacement = useAtomCommand(serverEnvironment.setScheduledTaskPlacement, {
    label: "scheduled task placement",
  });
  return async (
    environmentId: EnvironmentId,
    tasks: ReadonlyArray<Pick<ScheduledTask, "id">>,
    placement: ScheduledTaskPlacement,
  ) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await setPlacement({
      environmentId,
      input: { ids: tasks.map((task) => task.id), placement },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: tasks.length === 1 ? t("Could not move task") : t("Could not move tasks"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
}
