import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildThreadMarkdown,
  threadMarkdownFileName,
} from "@t3tools/client-runtime/thread-markdown";
import { EnvironmentRequestInvalidError, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { t } from "~/i18n";
import { downloadMarkdownFile } from "../proposedPlan";
import { readProject, readThreadShell } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useAtomCommand } from "../state/use-atom-command";

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

/** Loads the whole transcript from the thread's environment, so a long thread exports completely. */
export function useExportThreadMarkdown() {
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });

  return async (threadRef: ScopedThreadRef): Promise<void> => {
    const thread = readThreadShell(threadRef);
    if (thread === null) return;
    const loadingToast = toastManager.add({
      type: "loading",
      title: t("Exporting thread…"),
      timeout: 0,
    });
    const result = await loadThreadTranscript({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag !== "Success") {
      toastManager.close(loadingToast);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to export thread"),
          description:
            isEnvironmentRequestInvalidError(error) &&
            error.reason === "thread_transcript_too_large"
              ? t("This thread is too large to export.")
              : t("Check that its environment is connected and up to date, then try again."),
        }),
      );
      return;
    }
    const filename = threadMarkdownFileName(result.value.title);
    try {
      const markdown = await buildThreadMarkdown({
        title: result.value.title,
        thread: thread.source,
        projectName:
          readProject(scopeProjectRef(threadRef.environmentId, thread.projectId))?.title ?? null,
        createdAt: thread.createdAt,
        items: result.value.items,
      });
      downloadMarkdownFile(filename, markdown);
    } catch (cause) {
      toastManager.close(loadingToast);
      console.error("Failed to build the exported thread.", cause);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to export thread"),
          description: t("Try exporting this thread again."),
        }),
      );
      return;
    }
    toastManager.close(loadingToast);
    toastManager.add({ type: "success", title: t("Thread exported"), description: filename });
  };
}
