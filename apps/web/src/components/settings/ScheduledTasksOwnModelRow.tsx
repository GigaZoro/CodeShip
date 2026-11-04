import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { scheduledTasksListAtom } from "./ScheduledTasksSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";

interface TaskGroup {
  readonly environmentId: EnvironmentId;
  readonly ids: ReadonlyArray<ScheduledTaskId>;
}

function countTasks(groups: ReadonlyArray<TaskGroup>) {
  return groups.reduce((total, group) => total + group.ids.length, 0);
}

function taskCount(count: number) {
  return count === 1 ? "1 task" : `${count} tasks`;
}

/** Moves every task that picked its own model onto the scheduled tasks model, with Undo. */
export function ScheduledTasksOwnModelRow() {
  const { connectedEnvironments } = useSettingsScope();
  const environmentIds = connectedEnvironments.map((environment) => environment.environmentId);
  const queries = useAtomValue(scheduledTasksListAtom(environmentIdsKey(environmentIds)));
  const setFollows = useAtomCommand(serverEnvironment.setScheduledTasksFollowDefaultModel, {
    label: "scheduled tasks default model",
  });
  const [busy, setBusy] = useState(false);
  // Tasks bound to a thread run that thread's model, so the default never applies to them.
  const ownModelTasks: ReadonlyArray<TaskGroup> = environmentIds.flatMap((environmentId, index) => {
    const query = queries[index];
    const tasks = query ? (AsyncResult.getOrElse(query, () => null)?.tasks ?? []) : [];
    const ids = tasks
      .filter((task) => task.threadId === null && task.followsDefaultModel !== true)
      .map((task) => task.id);
    return ids.length > 0 && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ? [{ environmentId, ids }]
      : [];
  });
  const count = countTasks(ownModelTasks);
  if (count === 0) return null;

  const apply = async (groups: ReadonlyArray<TaskGroup>, followsDefaultModel: boolean) => {
    const changed: TaskGroup[] = [];
    for (const group of groups) {
      const result = await setFollows({
        environmentId: group.environmentId,
        input: { ids: group.ids, followsDefaultModel },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Could not update scheduled tasks",
            description: String(squashAtomCommandFailure(result)),
          });
        }
        continue;
      }
      if (result.value.ids.length > 0) {
        changed.push({ environmentId: group.environmentId, ids: result.value.ids });
      }
    }
    return changed;
  };

  const switchAllToDefault = async () => {
    setBusy(true);
    const changed = await apply(ownModelTasks, true);
    setBusy(false);
    if (changed.length === 0) return;
    const switched = countTasks(changed);
    toastManager.add({
      type: "success",
      title: `${taskCount(switched)} now ${switched === 1 ? "uses" : "use"} the scheduled tasks model`,
      actionProps: {
        children: "Undo",
        onClick: () => void apply(changed, false),
      },
    });
  };

  return (
    <SettingsRow
      title="Tasks with their own model"
      description={`${taskCount(count)} ${count === 1 ? "runs a model" : "run models"} picked for that task instead of the scheduled tasks model.`}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void switchAllToDefault()}
        >
          Use default for all
        </Button>
      }
    />
  );
}
