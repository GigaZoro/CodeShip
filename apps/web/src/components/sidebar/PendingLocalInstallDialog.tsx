import { useRef } from "react";

import {
  decideHostedRestartHold,
  usePendingLocalInstall,
  usePendingLocalInstallTurns,
  usePendingLocalInstallWork,
} from "./localInstallWait";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { BackgroundWorkGroup, RunningTurnsGroup } from "./SafeUpdateDialog";
import { splitRestartHoldWork } from "../restartHold.logic";

import { t, tx } from "~/i18n";

/** What a queued update install waits on, with the choice to install now or stop waiting. */
export function PendingLocalInstallDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const pending = usePendingLocalInstall();
  const { background, turnCalls } = splitRestartHoldWork(usePendingLocalInstallWork());
  const turns = usePendingLocalInstallTurns();
  const closeRef = useRef<HTMLButtonElement>(null);
  // The wait ends by itself when the work finishes; the dialog closes with it.
  const shown = open && pending !== null;
  return (
    <AlertDialog open={shown} onOpenChange={onOpenChange}>
      <AlertDialogPopup
        className="sm:max-w-lg"
        initialFocus={closeRef}
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <AlertDialogHeader className="shrink-0">
          <AlertDialogTitle>
            {pending?.version != null
              ? tx("Update to {version} is waiting", {
                  version: <span className="font-mono">{pending.version}</span>,
                })
              : t("Update is waiting")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.automatic === true
              ? t(
                  "The update installs once no chat is answering or has background work, including any that starts meanwhile. Restarting now stops it.",
                )
              : t(
                  "The update installs once nothing listed here is running. Restarting now stops it.",
                )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea scrollFade>
          <div className="flex flex-col gap-4 px-6 pb-4 text-sm">
            <BackgroundWorkGroup title={t("Waits for background work")} work={background} />
            <BackgroundWorkGroup title={t("Waits for running tool calls")} work={turnCalls} />
            <RunningTurnsGroup title={t("Waits for chats to finish")} turns={turns} />
          </div>
        </ScrollArea>
        <AlertDialogFooter>
          <AlertDialogClose ref={closeRef} render={<Button variant="outline" />}>
            {t("Close")}
          </AlertDialogClose>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              decideHostedRestartHold("cancel");
            }}
          >
            {t("Stop waiting")}
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              decideHostedRestartHold("update-now");
            }}
          >
            {t("Update now")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
