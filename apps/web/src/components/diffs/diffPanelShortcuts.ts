import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";

/** Keys typed into a field, a menu or a dialog inside the panel stay theirs. */
export function resolveDiffPanelShortcut(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
): "diff.previousFile" | "diff.nextFile" | null {
  if (event.defaultPrevented || event.isComposing) return null;
  // Viewer controls such as its find field live in shadow roots, which retarget the event.
  const target = event.composedPath()[0] ?? event.target;
  if (
    isEditableFocused(target) ||
    (target instanceof Element &&
      target.closest(
        '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-slot$="popup"]',
      ) !== null)
  ) {
    return null;
  }
  const command = resolveShortcutCommand(event, keybindings, {
    context: { diffFocus: true, editableFocus: false },
  });
  return command === "diff.previousFile" || command === "diff.nextFile" ? command : null;
}
