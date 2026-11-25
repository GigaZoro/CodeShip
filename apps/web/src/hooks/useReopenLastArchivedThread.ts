import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { t } from "~/i18n";
import { loadLatestArchivedThread } from "../lib/archivedThreadsState";
import { useConnectedEnvironmentIds } from "../state/environments";
import { readEnvironmentScope } from "../state/session";
import { useThreadActions } from "./useThreadActions";

/** Unarchives the newest archived thread on any connected machine and opens it. */
export function useReopenLastArchivedThread() {
  const { unarchiveThread } = useThreadActions();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();

  return async () => {
    const failed = (description: string) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to reopen archived thread"),
          description,
        }),
      );
    const latest = await loadLatestArchivedThread(
      connectedEnvironmentIds.filter((environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      ),
    );
    if (latest._tag === "Empty") {
      toastManager.add({ type: "info", title: t("No archived threads to reopen") });
      return;
    }
    if (latest._tag === "Failed") {
      failed(latest.message);
      return;
    }
    const result = await unarchiveThread(latest.threadRef, { navigate: true });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    failed(error instanceof Error ? error.message : t("An error occurred."));
  };
}
