import { MAX_THREAD_FOLDER_LENGTH } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { t } from "~/i18n";
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
import { Label } from "./ui/label";

interface ThreadFolderNameRequest {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialName: string;
  readonly resolve: (name: string | null) => void;
}

const useRequest = create<{ request: ThreadFolderNameRequest | null }>(() => ({ request: null }));

/** Asks for a folder name; resolves with the trimmed name, or null when the user cancels. */
export function requestThreadFolderName(
  options: Omit<ThreadFolderNameRequest, "resolve">,
): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...options, resolve } }));
}

function finish(name: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(name);
}

export function ThreadFolderNameDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending folder name request with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ThreadFolderNameDialog request={request} /> : null;
}

function ThreadFolderNameDialog(props: { request: ThreadFolderNameRequest }) {
  const { request } = props;
  const inputId = useId();
  const [name, setName] = useState(request.initialName);
  const trimmed = name.trim();
  const canSave = trimmed !== "" && trimmed !== request.initialName.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) finish(trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId}>{t("Folder name")}</Label>
              <Input
                nativeInput
                autoFocus
                id={inputId}
                value={name}
                maxLength={MAX_THREAD_FOLDER_LENGTH}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
              <span className="self-end text-xs tabular-nums text-muted-foreground">
                {`${name.length} / ${MAX_THREAD_FOLDER_LENGTH}`}
              </span>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {request.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
