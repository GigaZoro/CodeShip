import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useRouter } from "@tanstack/react-router";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { Artifact } from "./artifactsState";

import { t } from "~/i18n";
/** The URL the Artifacts page itself uses to select a page, rooted at the current origin. */
function useArtifactLink() {
  const router = useRouter();
  return (artifact: Pick<Artifact, "environmentId" | "attachmentId">) => {
    const location = router.buildLocation({
      to: "/artifacts",
      search: { environmentId: artifact.environmentId, page: artifact.attachmentId },
    });
    return new URL(router.history.createHref(location.href), window.location.origin).href;
  };
}

export function useArtifactActions(options: {
  readonly refresh: () => void;
  readonly onDeleted: (artifact: Artifact) => void;
}) {
  const hideArtifact = useOrchestrationCommand(threadEnvironment.hideArtifact);
  const artifactLink = useArtifactLink();

  const setHidden = (artifact: Artifact, hidden: boolean) =>
    hideArtifact({
      environmentId: artifact.environmentId,
      input: {
        threadId: artifact.threadId,
        attachmentId: artifact.attachmentId,
        hidden,
      },
    });

  const copyLink = async (artifact: Artifact) => {
    try {
      await writeTextToClipboard(artifactLink(artifact), t("artifact link"));
      toastManager.add(stackedThreadToast({ type: "success", title: t("Link copied") }));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Couldn't copy the link"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        }),
      );
    }
  };

  const deleteArtifact = async (artifact: Artifact) => {
    const confirmed = await (readLocalApi()?.dialogs.confirm(
      [
        t("Delete “{title}”?", { title: artifact.title }),
        t("It leaves the Artifacts list. The thread keeps showing the page in its conversation."),
      ].join("\n"),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    const result = await setHidden(artifact, true);
    if (result._tag !== "Success") {
      // The command reports its own failure; an interrupted one changed nothing.
      if (!isAtomCommandInterrupted(result)) options.refresh();
      return;
    }
    options.onDeleted(artifact);
    options.refresh();
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: t("Artifact deleted"),
        actionProps: {
          children: t("Undo"),
          onClick: () => {
            void setHidden(artifact, false).then((undone) => {
              if (undone._tag === "Success") options.refresh();
            });
          },
        },
      }),
    );
  };

  return { copyLink, deleteArtifact };
}
