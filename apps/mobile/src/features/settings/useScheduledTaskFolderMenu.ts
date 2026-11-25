import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { scheduledTaskGroupLabels } from "@t3tools/client-runtime/scheduled-task-groups";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { sameThreadFolder, type EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { t } from "../../lib/i18n";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { promptThreadFolderName } from "../threads/ThreadFolderNamePrompt";
import { useSaveThreadFolder } from "../threads/useThreadFolderActions";

const folderNamesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const saved = get(threadEnvironment.savedFoldersAtom(environmentId));
    const tasks = AsyncResult.getOrElse(
      get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
      () => null,
    )?.tasks;
    return scheduledTaskGroupLabels([...saved, ...(tasks ?? []).map((task) => task.group)]);
  }).pipe(
    Atom.withEquality<ReadonlyArray<string>>(
      (left, right) =>
        left.length === right.length && left.every((name, index) => name === right[index]),
    ),
  ),
);

export function useScheduledTaskFolderMenu(environmentId: EnvironmentId) {
  const capabilities = useEnvironmentServerConfig(environmentId)?.environment.capabilities;
  const canSetGroup = useAtomValue(
    serverEnvironment.setScheduledTaskGroup.permissionAtom(environmentId),
  );
  const canSaveFolders = useAtomValue(threadEnvironment.saveFolders.permissionAtom(environmentId));
  const folders = useAtomValue(folderNamesAtom(environmentId));
  const setGroup = useAtomCommand(serverEnvironment.setScheduledTaskGroup, {
    reportFailure: false,
  });
  const saveFolder = useSaveThreadFolder();
  const move = async (task: ScheduledTask, group: string | null, save = false) => {
    const result = await setGroup({ environmentId, input: { id: task.id, group } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Dialog.alert(t("Could not move task"), String(squashAtomCommandFailure(result)));
      }
      return;
    }
    if (save && group !== null) await saveFolder(environmentId, group);
  };

  const actions = (task: ScheduledTask): MenuAction[] =>
    capabilities?.scheduledTaskSetGroup !== true
      ? []
      : [
          {
            id: "move-to-folder",
            title: t("Move to folder"),
            image: "folder",
            attributes: { disabled: !canSetGroup },
            subactions: [
              ...folders.map((name) => ({
                id: `folder:move:${name}`,
                title: name,
                state: sameThreadFolder(task.group, name) ? ("on" as const) : ("off" as const),
              })),
              ...(capabilities.threadFolders === true && canSaveFolders
                ? [{ id: "folder:new", title: t("New folder…"), image: "folder.badge.plus" }]
                : []),
              ...(task.group == null
                ? []
                : [{ id: "folder:remove", title: t("Remove from folder") }]),
            ],
          },
        ];

  const handleAction = (task: ScheduledTask, action: string): boolean => {
    if (!action.startsWith("folder:")) return false;
    if (!canSetGroup || capabilities?.scheduledTaskSetGroup !== true) return true;
    if (action === "folder:new") {
      if (canSaveFolders && capabilities.threadFolders === true) {
        promptThreadFolderName({
          title: t("New folder"),
          confirmText: t("Create"),
          initialValue: "",
          onConfirm: (name) => void move(task, name, true),
        });
      }
    } else if (action === "folder:remove") {
      void move(task, null);
    } else if (action.startsWith("folder:move:")) {
      const name = action.slice("folder:move:".length);
      if (folders.includes(name) && !sameThreadFolder(task.group, name)) void move(task, name);
    }
    return true;
  };

  return { actions, handleAction };
}
