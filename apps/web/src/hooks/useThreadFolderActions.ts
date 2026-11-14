import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { olderSettledFolderNames } from "@t3tools/client-runtime/state/threads";
import {
  addSavedThreadFolder,
  moveThreadFolder,
  resolveThreadFolders,
  threadFolderTargets,
  type ThreadFolderEntry,
} from "@t3tools/client-runtime/thread-folders";
import { threadFolderKeyOf, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { requestThreadFolderName } from "../components/ThreadFolderNameDialog";
import {
  THREAD_FOLDER_NEW_ID,
  THREAD_FOLDER_REMOVE_ID,
  THREAD_FOLDER_SET_PREFIX,
  type ThreadFolderMenuAction,
  type ThreadFolderMenuState,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { t } from "~/i18n";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentSupportsThreadFolders,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { olderSettledThreads, savedThreadFoldersAtom, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/** Every folder the chats name, older ones not loaded too, or the user saved, in sidebar order. */
function readThreadFolderEntries(): ReadonlyArray<ThreadFolderEntry> {
  const threads = readThreadShells();
  // A machine with older settled chats holds its newest settled ones, so its shells name it.
  const olderNames = olderSettledFolderNames({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(threads.map((thread) => thread.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: null,
    })),
  });
  return resolveThreadFolders(appAtomRegistry.get(savedThreadFoldersAtom), [
    ...threads.flatMap((thread) => (thread.archivedAt == null ? [thread.folder] : [])),
    ...olderNames,
  ]);
}

export function readThreadFolderTargets(): ReadonlyArray<EnvironmentId> {
  return threadFolderTargets({
    configs: appAtomRegistry.get(environmentServerConfigsAtom),
    connected: appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
    canWrite: (environmentId) =>
      appAtomRegistry.get(threadEnvironment.renameFolder.permissionAtom(environmentId)) === true,
  });
}

/** The data the thread menus need for their folder submenu; null when no chat can be filed here. */
export function readThreadFolderMenuState(
  refs: ReadonlyArray<ScopedThreadRef>,
): ThreadFolderMenuState | null {
  if (
    refs.length === 0 ||
    !refs.every((ref) => readEnvironmentSupportsThreadFolders(ref.environmentId))
  ) {
    return null;
  }
  const keys = refs.map((ref) => threadFolderKeyOf(readThreadShell(ref)?.folder));
  const first = keys[0] ?? null;
  return {
    entries: readThreadFolderEntries(),
    currentKey: keys.every((key) => key === first) ? first : null,
    inFolder: keys.some((key) => key !== null),
  };
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : t("An error occurred."),
    }),
  );
}

export function useThreadFolderActions() {
  const setFolderCommand = useOrchestrationCommand(threadEnvironment.setFolder, {
    reportFailure: false,
  });
  const renameFolderCommand = useAtomCommand(threadEnvironment.renameFolder, {
    reportFailure: false,
  });
  const saveFoldersCommand = useAtomCommand(threadEnvironment.saveFolders, {
    reportFailure: false,
  });

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(title, squashAtomCommandFailure(result));
      return false;
    }
    return result._tag === "Success";
  };

  const setFolder = async (refs: ReadonlyArray<ScopedThreadRef>, folder: string | null) => {
    const results = await Promise.all(
      refs.map((ref) =>
        setFolderCommand({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, folder },
        }),
      ),
    );
    for (const result of results) reportFailure(t("Failed to move chat to folder"), result);
  };

  /** Saves `folders` first, in this order, on every machine; each keeps the ones it leaves out. */
  const saveFolders = async (folders: ReadonlyArray<string>) => {
    const results = await Promise.all(
      readThreadFolderTargets().map((environmentId) =>
        saveFoldersCommand({ environmentId, input: { folders } }),
      ),
    );
    for (const result of results) reportFailure(t("Failed to save folders"), result);
  };

  const saveFolder = (name: string) =>
    saveFolders(addSavedThreadFolder(appAtomRegistry.get(savedThreadFoldersAtom), name));

  /**
   * Asks for a name, saves the folder, and files the chats in it when there are any. The chats
   * move optimistically, so starting the move with the save shows them in one render.
   */
  const createFolder = async (refs: ReadonlyArray<ScopedThreadRef>) => {
    const name = await requestThreadFolderName({
      title: t("New folder"),
      submitLabel: t("Create folder"),
      initialName: "",
    });
    if (name === null) return;
    await Promise.all([setFolder(refs, name), saveFolder(name)]);
  };

  /**
   * Each machine moves its chats, tasks and saved folder; all show at once. A machine that
   * refuses keeps its chats in the old folder, so the folder still shows there.
   */
  const changeFolderEverywhere = async (from: string, to: string | null, failureTitle: string) => {
    const results = await Promise.all(
      readThreadFolderTargets().map((environmentId) =>
        renameFolderCommand({ environmentId, input: { from, to } }),
      ),
    );
    for (const result of results) reportFailure(failureTitle, result);
  };

  const renameFolder = async (entry: ThreadFolderEntry) => {
    const name = await requestThreadFolderName({
      title: t("Rename folder"),
      submitLabel: t("Rename"),
      initialName: entry.name,
    });
    if (name === null || name === entry.name) return;
    await changeFolderEverywhere(entry.name, name, t("Failed to rename folder"));
  };

  const deleteFolder = async (entry: ThreadFolderEntry) => {
    const message = [
      t("Delete folder “{name}”?", { name: entry.name }),
      t("Its chats move out of the folder. Scheduled tasks in this group lose their group."),
    ].join("\n");
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ??
      window.confirm(message.replace("\n", " "));
    if (!confirmed) return;
    await changeFolderEverywhere(entry.name, null, t("Failed to delete folder"));
  };

  /** Moves a folder one place among the shown ones; the whole order is saved so it stays when empty. */
  const moveFolder = async (
    shown: ReadonlyArray<ThreadFolderEntry>,
    entry: ThreadFolderEntry,
    direction: -1 | 1,
  ) => {
    await saveFolders(moveThreadFolder(shown, entry.key, direction));
  };

  /** Runs a folder choice from a thread menu for the given chats. */
  const runMenuAction = async (
    action: ThreadFolderMenuAction,
    refs: ReadonlyArray<ScopedThreadRef>,
  ) => {
    if (action === THREAD_FOLDER_NEW_ID) return createFolder(refs);
    if (action === THREAD_FOLDER_REMOVE_ID) return setFolder(refs, null);
    return setFolder(refs, action.slice(THREAD_FOLDER_SET_PREFIX.length));
  };

  return { setFolder, createFolder, renameFolder, deleteFolder, moveFolder, runMenuAction };
}
