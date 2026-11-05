import { NotebookTextIcon } from "lucide-react";
import { t } from "~/i18n";

import releaseNotes from "../../../../docs/release-notes.md?raw";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ReleaseNotesButton() {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={<Button variant="ghost" size="sm" aria-label={t("Release notes")} />}
            />
          }
        >
          <NotebookTextIcon aria-hidden className="size-4" />
          <span aria-hidden className="hidden xl:inline">
            {t("Release notes")}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{t("Release notes")}</TooltipPopup>
      </Tooltip>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Release notes")}</DialogTitle>
          <DialogDescription>
            {t("Changes included in this version of T3.CodeShip.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ChatMarkdown text={releaseNotes} cwd={undefined} parseRawHtml={false} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
