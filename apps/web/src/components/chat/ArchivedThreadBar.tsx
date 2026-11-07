import { t, tx } from "~/i18n";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useEnvironmentScope } from "../../state/session";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Takes the composer's place while a thread is archived: it reads, but takes no messages. */
export function ArchivedThreadBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly archivedAt: string;
}) {
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [busy, setBusy] = useState(false);
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);

  const run = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
  ) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : t("An error occurred."),
      }),
    );
  };

  return (
    <div className="flex min-h-12 items-center gap-3 rounded-2xl py-2 ps-5 pe-2 text-sm">
      <ArchiveIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {tx("Archived {time}. Unarchive it to send messages.", {
          time: <RelativeTime timestamp={props.archivedAt} />,
        })}
      </span>
      <Button
        size="sm"
        variant="ghost-destructive"
        disabled={!canOperate || busy}
        onClick={() => {
          void run(
            () => confirmAndDeleteThread(threadRef, { title: props.title }),
            t("Failed to delete thread"),
          );
        }}
      >
        <Trash2Icon aria-hidden />
        <span className="@max-[420px]/composer-surface:sr-only">{t("Delete")}</span>
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!canOperate || busy}
        onClick={() => {
          void run(() => unarchiveThread(threadRef), t("Failed to unarchive thread"));
        }}
      >
        <ArchiveRestoreIcon aria-hidden />
        <span className="@max-[320px]/composer-surface:sr-only">{t("Unarchive")}</span>
      </Button>
    </div>
  );
}
