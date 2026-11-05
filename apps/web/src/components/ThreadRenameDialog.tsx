import { t } from "~/i18n";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { create } from "zustand";

import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface RenameRequest {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
}

const useRenameRequest = create<{ request: RenameRequest | null }>(() => ({ request: null }));

/** The palette closes as its command runs, so this host owns the dialog it opens. */
export function requestThreadRename(request: RenameRequest): void {
  useRenameRequest.setState({ request });
}

function close() {
  useRenameRequest.setState({ request: null });
}

export function ThreadRenameDialogHost() {
  const request = useRenameRequest((state) => state.request);
  return request ? <ThreadRenameDialog request={request} /> : null;
}

function ThreadRenameDialog({ request }: { readonly request: RenameRequest }) {
  const [title, setTitle] = useState(request.title);
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const trimmed = title.trim();
  const submit = () => {
    close();
    if (trimmed.length === 0 || trimmed === request.title) return;
    void updateThreadMetadata({
      environmentId: request.threadRef.environmentId,
      input: { threadId: request.threadRef.threadId, title: trimmed },
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to rename thread"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        }),
      );
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("Rename thread")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label={t("Thread title")}
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {t("Rename")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
