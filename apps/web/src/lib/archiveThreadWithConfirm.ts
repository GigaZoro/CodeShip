import type { ScopedThreadRef } from "@t3tools/contracts";
import { t } from "~/i18n";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { useThreadActions } from "../hooks/useThreadActions";
import { readLocalApi } from "../localApi";

/** The confirm-then-archive flow behind the thread menu, the palette, and the archive shortcut. */
export async function archiveThreadWithConfirm(input: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly confirm: boolean;
  readonly archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
}): Promise<void> {
  if (input.confirm) {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(t('Archive thread "{title}"?', { title: input.title })),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
  }
  let didArchive = false;
  const result = await input.archiveThread(input.threadRef, {
    onArchived: () => {
      didArchive = true;
    },
  });
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: didArchive
          ? t("Thread archived, but navigation failed")
          : t("Failed to archive thread"),
        description: error instanceof Error ? error.message : t("An error occurred."),
      }),
    );
  }
}
