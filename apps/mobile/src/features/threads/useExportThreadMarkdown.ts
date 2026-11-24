import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildThreadMarkdown,
  threadMarkdownFileName,
  type ThreadMarkdownInput,
} from "@t3tools/client-runtime/thread-markdown";
import { EnvironmentRequestInvalidError, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as Dialog from "../../components/ui/Dialog";
import { shareGeneratedAttachment } from "../../lib/attachmentDownload";
import { t } from "../../lib/i18n";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

const isEnvironmentRequestInvalidError = Schema.is(EnvironmentRequestInvalidError);

// Every thread row can start an export, and the app shares one file at a time.
let activeExport: AbortController | null = null;

export interface ExportThreadMarkdownTarget extends ScopedThreadRef {
  readonly projectName: string | null;
  readonly thread: NonNullable<ThreadMarkdownInput["thread"]>;
  readonly createdAt: string;
}

/**
 * Loads the whole transcript from the thread's environment and shares it as a `.md` file; a long
 * thread passed as share text would exceed Android's transaction limit. Starting another export,
 * from any row, cancels the one in progress.
 */
export function useExportThreadMarkdown() {
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });

  return async (target: ExportThreadMarkdownTarget): Promise<void> => {
    activeExport?.abort();
    const controller = new AbortController();
    activeExport = controller;
    const { signal } = controller;
    const result = await loadThreadTranscript(
      {
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      },
      signal,
    );
    if (signal.aborted) return;
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        t("Failed to export thread"),
        isEnvironmentRequestInvalidError(error) && error.reason === "thread_transcript_too_large"
          ? t("This thread is too large to export.")
          : t("Check that its environment is connected and up to date, then try again."),
      );
      return;
    }
    let markdown: string;
    try {
      markdown = await buildThreadMarkdown(
        {
          title: result.value.title,
          thread: target.thread,
          projectName: target.projectName,
          createdAt: target.createdAt,
          items: result.value.items,
        },
        { signal },
      );
    } catch (cause) {
      if (signal.aborted) return;
      console.error("Failed to build the exported thread.", cause);
      Dialog.alert(t("Failed to export thread"), t("Try exporting this thread again."));
      return;
    }
    const shared = await shareGeneratedAttachment({
      bytes: new TextEncoder().encode(markdown),
      attachment: { name: threadMarkdownFileName(result.value.title), mimeType: "text/markdown" },
      signal,
    }).catch((cause: unknown) => {
      if (signal.aborted) return null;
      console.error("Failed to share the exported thread.", cause);
      Dialog.alert(t("Failed to export thread"), t("Try exporting this thread again."));
      return null;
    });
    if (shared === false && !signal.aborted) {
      Dialog.alert(
        t("Failed to export thread"),
        t("Saving and sharing files is unavailable on this device."),
      );
    }
  };
}
