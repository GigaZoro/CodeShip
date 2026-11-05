import type { ReactNode } from "react";

import { attachSidebarTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { SidebarNeedsYouHeader } from "./SidebarListMarkers";

export function SidebarNeedsYouPanel(props: { count: number; children: ReactNode }) {
  return (
    <section
      {...workspaceAreaProps("needs-you", 7, "Needs you")}
      className="flex max-h-[40dvh] min-h-0 flex-col rounded-xl border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground shadow-sm"
    >
      <ul className="shrink-0">
        <SidebarNeedsYouHeader count={props.count} />
      </ul>
      <ul
        ref={attachSidebarTree}
        role="tree"
        aria-label="Threads needing you"
        className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {props.children}
      </ul>
    </section>
  );
}
