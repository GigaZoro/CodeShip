import { ChevronLeftIcon, ChevronRightIcon, NotebookTextIcon } from "lucide-react";
import { useState } from "react";
import { t } from "~/i18n";

import releaseNotes from "../../../../docs/release-notes.md?raw";
import ChatMarkdown from "./ChatMarkdown";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ENTRIES_PER_PAGE = 10;

function ReleaseNotesHistory() {
  const [entries] = useState(() => releaseNotes.trim().split(/(?=^## )/m));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const search = query.trim().toLowerCase();
  const matches = search
    ? entries.filter((entry) => entry.toLowerCase().includes(search))
    : entries;
  const pages = Math.ceil(matches.length / ENTRIES_PER_PAGE);
  const offset = page * ENTRIES_PER_PAGE;
  const markdown = matches.slice(offset, offset + ENTRIES_PER_PAGE).join("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Release notes")}</DialogTitle>
        <DialogDescription>
          {t("Changes included in this version of T3.CodeShip.")}
        </DialogDescription>
        <Input
          type="search"
          aria-label={t("Search release notes")}
          placeholder={t("Search release notes")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </DialogHeader>
      <DialogPanel key={`${page}:${search}`}>
        {matches.length > 0 ? (
          <ChatMarkdown text={markdown} cwd={undefined} parseRawHtml={false} />
        ) : (
          <p role="status">{t("No results found.")}</p>
        )}
      </DialogPanel>
      {pages > 1 && (
        <DialogFooter>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("Previous page")}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span role="status" className="text-sm tabular-nums">
              {t("Page {page} of {total}", { page: page + 1, total: pages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={t("Next page")}
              disabled={page + 1 === pages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        </DialogFooter>
      )}
    </>
  );
}

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
        <ReleaseNotesHistory />
      </DialogPopup>
    </Dialog>
  );
}
