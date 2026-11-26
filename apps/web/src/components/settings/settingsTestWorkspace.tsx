import type { ReactNode } from "react";
import { workspaceAreaProps } from "../../lib/workspaceFocus";

function focusWorkspace(node: HTMLDivElement | null) {
  if (node === null) return;
  node.focus();
  // Section navigation observes Escape at document level after nested handlers, even
  // when an editor unmounts and browser focus returns to the body.
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !event.repeat &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      node.dataset.unhandledEscape = "true";
    }
  };
  const doc = node.ownerDocument;
  doc.addEventListener("keydown", onKeyDown);
  return () => doc.removeEventListener("keydown", onKeyDown);
}

/** A settings content area that records Escape when a nested control leaves it unhandled. */
export function SettingsTestWorkspace({ children }: { readonly children: ReactNode }) {
  return (
    <div {...workspaceAreaProps("settings", 1, "Settings content")} ref={focusWorkspace}>
      {children}
    </div>
  );
}
