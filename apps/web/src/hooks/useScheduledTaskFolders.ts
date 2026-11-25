import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { addSavedThreadFolder, resolveThreadFolders } from "@t3tools/client-runtime/thread-folders";
import { threadFolderKeyOf, type EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { requestNewFolderName } from "../components/ThreadFolderNameDialog";
import {
  buildThreadFolderMenuItem,
  THREAD_FOLDER_NEW_ID,
  THREAD_FOLDER_REMOVE_ID,
  THREAD_FOLDER_SET_PREFIX,
  type ThreadFolderMenuAction,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { t } from "~/i18n";
import { useEnvironment } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

function reportFolderFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      }),
    );
  }
}

export function useSaveScheduledTaskFolder() {
  const registry = useContext(RegistryContext);
  const save = useAtomCommand(threadEnvironment.saveFolders);
  return async (environmentId: EnvironmentId, name: string) => {
    const current = registry.get(threadEnvironment.savedFoldersAtom(environmentId));
    const folders = addSavedThreadFolder(current, name);
    if (folders === current) return;
    const result = await save({ environmentId, input: { folders } });
    reportFolderFailure(t("Failed to save folders"), result);
  };
}

export function useScheduledTaskFolderMenu(environmentId: EnvironmentId, task: ScheduledTask) {
  const registry = useContext(RegistryContext);
  const environment = useEnvironment(environmentId);
  const permitted = useAtomValue(
    serverEnvironment.setScheduledTaskGroup.permissionAtom(environmentId),
  );
  const savePermitted = useAtomValue(threadEnvironment.saveFolders.permissionAtom(environmentId));
  const canCreate =
    savePermitted && environment?.serverConfig?.environment.capabilities.threadFolders === true;
  const move = useAtomCommand(serverEnvironment.setScheduledTaskGroup);
  const saveFolder = useSaveScheduledTaskFolder();
  if (
    !permitted ||
    environment?.connection.phase !== "connected" ||
    environment.serverConfig?.environment.capabilities.scheduledTaskSetGroup !== true
  )
    return null;

  const menu = () => {
    const tasks = registry.get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const currentKey = threadFolderKeyOf(task.group);
    return buildThreadFolderMenuItem({
      entries: resolveThreadFolders(
        registry.get(threadEnvironment.savedFoldersAtom(environmentId)),
        AsyncResult.getOrElse(tasks, () => null)?.tasks.map((entry) => entry.group) ?? [],
      ),
      currentKey,
      inFolder: currentKey !== null,
      canCreate,
    });
  };
  const choose = async (action: ThreadFolderMenuAction) => {
    const group =
      action === THREAD_FOLDER_NEW_ID
        ? await requestNewFolderName()
        : action === THREAD_FOLDER_REMOVE_ID
          ? null
          : action.slice(THREAD_FOLDER_SET_PREFIX.length);
    if (action === THREAD_FOLDER_NEW_ID && group === null) return;
    const result = await move({ environmentId, input: { id: task.id, group } });
    reportFolderFailure(t("Could not move task"), result);
    if (result._tag === "Success" && action === THREAD_FOLDER_NEW_ID && group !== null) {
      await saveFolder(environmentId, group);
    }
  };
  return { menu, choose };
}
