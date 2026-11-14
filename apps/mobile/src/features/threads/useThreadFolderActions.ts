import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  addSavedThreadFolder,
  environmentSupportsThreadFolders as configSupportsThreadFolders,
  threadFolderTargets,
} from "@t3tools/client-runtime/thread-folders";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { t } from "../../lib/i18n";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { savedThreadFoldersAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { promptThreadFolderName } from "./ThreadFolderNamePrompt";

export function environmentSupportsThreadFolders(environmentId: EnvironmentId): boolean {
  return configSupportsThreadFolders(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId),
  );
}

export function readThreadFolderTargets(): ReadonlyArray<EnvironmentId> {
  return threadFolderTargets({
    configs: appAtomRegistry.get(environmentServerConfigsAtom),
    connected: appAtomRegistry.get(connectedEnvironmentIdsAtom),
    canWrite: (environmentId) => readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
  });
}

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
}

/** Names each machine that refused, in one alert. */
function alertFailures(title: string, results: ReadonlyArray<AtomCommandResult<unknown, unknown>>) {
  const problems = results.flatMap((result) =>
    result._tag === "Failure" && !isAtomCommandInterrupted(result)
      ? [failureMessage(squashAtomCommandFailure(result), t("Try again."))]
      : [],
  );
  if (problems.length > 0) Dialog.alert(title, problems.join("\n"));
}

export function useThreadFolderActions() {
  const setFolder = useAtomCommand(threadEnvironment.setFolder, { reportFailure: false });
  const renameFolder = useAtomCommand(threadEnvironment.renameFolder, {
    reportFailure: false,
  });
  const saveFolders = useAtomCommand(threadEnvironment.saveFolders, { reportFailure: false });

  const moveThreadToFolder = async (thread: EnvironmentThreadShell, folder: string | null) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert(t("Could not move thread"), t("This connection cannot change threads."));
      return false;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const result = await setFolder({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, folder },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Dialog.alert(
          t("Could not move thread"),
          failureMessage(squashAtomCommandFailure(result), t("The thread could not be moved.")),
        );
      }
      return false;
    }
    return true;
  };

  /** Saves the folder on every machine, so it stays after its chats leave it. */
  const saveFolder = async (name: string) => {
    const folders = addSavedThreadFolder(appAtomRegistry.get(savedThreadFoldersAtom), name);
    const results = await Promise.all(
      readThreadFolderTargets().map((environmentId) =>
        saveFolders({ environmentId, input: { folders } }),
      ),
    );
    alertFailures(t("Could not save folder"), results);
  };

  const promptNewFolder = (thread: EnvironmentThreadShell) =>
    promptThreadFolderName({
      title: t("New folder"),
      confirmText: t("Create"),
      initialValue: "",
      onConfirm: (name) => void Promise.all([moveThreadToFolder(thread, name), saveFolder(name)]),
    });

  /** Runs on every connected machine that keeps folders; a machine that refuses is named. */
  const changeFolderEverywhere = async (
    from: string,
    to: string | null,
    failureTitle: string,
  ): Promise<void> => {
    const results = await Promise.all(
      readThreadFolderTargets().map((environmentId) =>
        renameFolder({ environmentId, input: { from, to } }),
      ),
    );
    alertFailures(failureTitle, results);
  };

  const promptRenameFolder = (name: string) =>
    promptThreadFolderName({
      title: t("Rename folder"),
      confirmText: t("Rename"),
      initialValue: name,
      onConfirm: (next) => {
        if (next === name) return;
        void changeFolderEverywhere(name, next, t("Could not rename folder"));
      },
    });

  const confirmDeleteFolder = (name: string) =>
    Dialog.confirm({
      title: t("Delete folder “{name}”?", { name }),
      message: t(
        "Its chats move out of the folder. Scheduled tasks in this group lose their group.",
      ),
      confirmText: t("Delete"),
      destructive: true,
      onConfirm: () => void changeFolderEverywhere(name, null, t("Could not delete folder")),
    });

  return { moveThreadToFolder, promptNewFolder, promptRenameFolder, confirmDeleteFolder };
}
