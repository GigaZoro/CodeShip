import { ChevronRightIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { NEEDS_YOU_LATER_ROW_ID } from "./NeedsYouBoxRow";
import { SidebarNeedsYouHeader } from "./SidebarListMarkers";

/** The box under the chat: what needs the user, then what they put off, collapsed. */
export function SidebarNeedsYouPanel(props: {
  target: HTMLElement;
  rows: readonly ReactNode[];
  laterRows: readonly ReactNode[];
}) {
  const [laterOpen, setLaterOpen] = useState(false);
  const toggleLater = () => setLaterOpen((open) => !open);
  const handleLaterKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    toggleLater();
  };
  return createPortal(
    <section
      {...workspaceAreaProps("needs-you", 6, t("Needs you"))}
      className="flex min-h-0 flex-col rounded-2xl border border-warning/40 bg-sidebar p-1.5 text-sidebar-foreground shadow-sm"
    >
      <ul className="shrink-0">
        <SidebarNeedsYouHeader count={props.rows.length} />
      </ul>
      <ul
        ref={attachSidebarTree}
        role="tree"
        aria-label={t("Threads needing you")}
        className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {props.rows}
        {props.laterRows.length > 0 ? (
          <>
            <li
              className={cn(
                "list-none",
                props.rows.length > 0 && "mt-1 border-t border-border/60 pt-1",
              )}
            >
              <div
                role="treeitem"
                tabIndex={-1}
                data-sidebar-row={NEEDS_YOU_LATER_ROW_ID}
                aria-expanded={laterOpen}
                onClick={toggleLater}
                onKeyDown={handleLaterKeyDown}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3.5 shrink-0", laterOpen && "rotate-90")}
                />
                <span className="flex-1">{t("Later")}</span>
                <span className="tabular-nums">{props.laterRows.length}</span>
              </div>
            </li>
            {laterOpen ? props.laterRows : null}
          </>
        ) : null}
      </ul>
    </section>,
    props.target,
  );
}
