import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentArtifact } from "./artifactList";
import { refreshConnectedArtifacts } from "./useArtifacts";

/** Confirms, then removes the page from the gallery; its thread keeps showing it inline. */
export function useDeleteArtifact() {
  const hideArtifact = useAtomCommand(threadEnvironment.hideArtifact, { reportFailure: false });
  return (artifact: EnvironmentArtifact, onDeleted?: () => void) => {
    if (!readEnvironmentScope(artifact.environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert("Could not delete artifact", "This connection cannot change threads.");
      return;
    }
    Dialog.confirm({
      title: "Delete artifact?",
      message: `“${artifact.title}” leaves the Artifacts list. Its thread keeps showing the page in the conversation.`,
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        void hideArtifact({
          environmentId: artifact.environmentId,
          input: { threadId: artifact.threadId, attachmentId: artifact.attachmentId, hidden: true },
        }).then((result) => {
          if (result._tag === "Success") {
            refreshConnectedArtifacts();
            onDeleted?.();
            return;
          }
          Dialog.alert("Could not delete artifact", "Try again in a moment.");
        });
      },
    });
  };
}
