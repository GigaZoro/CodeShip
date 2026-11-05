import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { EnvironmentArtifact } from "./artifactList";
import { refreshConnectedArtifacts } from "./useArtifacts";
import { t } from "../../lib/i18n";

/** Confirms, then removes the page from the gallery; its thread keeps showing it inline. */
export function useDeleteArtifact() {
  const hideArtifact = useAtomCommand(threadEnvironment.hideArtifact, { reportFailure: false });
  return (artifact: EnvironmentArtifact, onDeleted?: () => void) => {
    if (!readEnvironmentScope(artifact.environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert(t("Could not delete artifact"), t("This connection cannot change threads."));
      return;
    }
    Dialog.confirm({
      title: t("Delete artifact?"),
      message: t(
        "“{title}” leaves the Artifacts list. Its thread keeps showing the page in the conversation.",
        { title: artifact.title },
      ),
      confirmText: t("Delete"),
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
          Dialog.alert(t("Could not delete artifact"), t("Try again in a moment."));
        });
      },
    });
  };
}
