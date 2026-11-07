import { useAtomValue } from "@effect/atom-react";
import { Undo2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "~/i18n";
import {
  threadUndoLabel,
  threadUndoNoticeSummary,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { InlineButton } from "../ui/button";
import { SidebarMenuItem, useSidebarVisibility } from "../ui/sidebar";
import { toastManager } from "../ui/toast";

/** Sits in the sidebar footer below the list's scroll area, so it never covers a thread. */
export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Short enough to fit beside an update run; screen readers hear the full summary.
  const summary = notice
    ? notice.count === 1
      ? notice.action
      : `${notice.action} ${notice.count}`
    : null;

  // Keeps the last text on screen while it fades out, then unmounts on transitionend.
  const [shownSummary, setShownSummary] = useState(summary);
  if (summary && summary !== shownSummary) setShownSummary(summary);
  const text = summary ?? shownSummary;
  if (!text) return null;

  return (
    <SidebarMenuItem
      className="@container flex min-w-0 flex-1"
      aria-hidden={!summary}
      inert={!summary}
    >
      <div
        onTransitionEnd={(event) => {
          if (!summary && event.target === event.currentTarget) setShownSummary(null);
        }}
        // Reversed wrap: a summary that does not fit beside the undo button drops to a
        // second line that overflow hides, instead of truncating mid-word. Browse mode
        // reads the button first; the live announcement carries the full sentence.
        className={cn(
          "flex h-6 min-w-0 flex-1 flex-row-reverse flex-wrap gap-x-1 overflow-hidden text-2xs leading-6 whitespace-nowrap text-sidebar-muted-foreground transition-opacity duration-200 ease-out starting:opacity-0",
          !summary && "opacity-0",
        )}
      >
        <InlineButton className="min-w-0 shrink" onClick={undoLatestThreadAction}>
          {/* The icon's negative margin cancels its width, so beside the label it sits in
              clipped space; once the label is too wide it wraps away and the icon shows. */}
          <span className="flex h-6 min-w-0 flex-wrap justify-end overflow-hidden">
            <Undo2Icon className="-ml-4 h-6 w-4 @max-[1rem]:invisible" />
            <span>{threadUndoLabel(keybindings)}</span>
          </span>
        </InlineButton>
        <span>{text},</span>
      </div>
    </SidebarMenuItem>
  );
}

/** A collapsed sidebar hides the footer notice, so the same undo shows as a toast instead. */
export function CollapsedSidebarUndoToast() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const sidebarVisible = useSidebarVisibility();
  const summary = notice !== null && !sidebarVisible ? threadUndoNoticeSummary(notice) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the undo notice into the toast manager, which lives outside React
  useEffect(() => {
    if (summary === null) return;
    const toastId = toastManager.add({
      type: "info",
      title: summary,
      // The notice's own expiry closes the toast through this effect's cleanup.
      timeout: 0,
      data: { hideCopyButton: true },
      actionProps: { children: t("Undo"), onClick: undoLatestThreadAction },
    });
    return () => toastManager.close(toastId);
  }, [summary]);

  return null;
}
