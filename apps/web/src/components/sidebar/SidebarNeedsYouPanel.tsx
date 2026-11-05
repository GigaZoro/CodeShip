import { PanelRightCloseIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarNeedsYouHeader } from "./SidebarListMarkers";
import { useNeedsYouColumnVisible } from "./needsYouColumn";

export function SidebarNeedsYouPanel(props: {
  count: number;
  target: HTMLElement;
  children: ReactNode;
}) {
  const [, setNeedsYouColumnVisible] = useNeedsYouColumnVisible();
  return createPortal(
    <section
      {...workspaceAreaProps("needs-you", 6, "Needs you")}
      className="flex max-h-[40dvh] min-h-0 flex-col rounded-xl border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground shadow-sm"
    >
      <ul className="shrink-0">
        <SidebarNeedsYouHeader
          count={props.count}
          action={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label="Move Needs you to the thread list"
                    onClick={() => setNeedsYouColumnVisible(false)}
                  />
                }
              >
                <PanelRightCloseIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Move to the thread list</TooltipPopup>
            </Tooltip>
          }
        />
      </ul>
      <ul
        ref={attachSidebarTree}
        role="tree"
        aria-label="Threads needing you"
        className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {props.children}
      </ul>
    </section>,
    props.target,
  );
}
