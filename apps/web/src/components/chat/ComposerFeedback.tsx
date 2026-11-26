import { t, msg } from "~/i18n";
import {
  codexFeedbackNotice,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";

import { MessageSquareIcon } from "lucide-react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function feedbackBannerItem(
  submission: CodexFeedbackSubmission,
  onDismiss: () => void,
  resolve: typeof t = t,
): ComposerBannerStackItem | null {
  const notice = codexFeedbackNotice(submission, resolve);
  if (!notice) return null;
  return {
    id: `feedback:${submission.id}`,
    variant:
      submission.status === "failed" ? "error" : submission.status === "sent" ? "success" : "info",
    icon: <MessageSquareIcon />,
    ...notice,
    actions:
      submission.status === "sent" ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void writeTextToClipboard(submission.feedbackId, {
              target: "Codex feedback thread ID",
              unavailableMessage: msg(
                "Clipboard API is unavailable while copying Codex feedback thread ID.",
              ),
              failureMessage: msg("Failed to copy Codex feedback thread ID to the clipboard."),
            }).catch((error: unknown) => {
              toastManager.add({
                type: "error",
                title: t(msg("Could not copy thread ID")),
                description: error instanceof Error ? error.message : t(msg("An error occurred.")),
              });
            });
          }}
        >
          {resolve(msg("Copy ID"))}
        </Button>
      ) : undefined,
    ...(submission.status !== "uploading"
      ? { dismissLabel: resolve(msg("Dismiss feedback notice")), onDismiss }
      : {}),
  };
}
