import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useReopenLastArchivedThread } from "../hooks/useReopenLastArchivedThread";
import { resolveShortcutCommand } from "../keybindings";
import { isInsideModalDialog } from "../lib/modalDialog";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Lives at the root, so the shortcut works while the sidebar sheet is closed. */
export function ReopenLastArchivedShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const reopenLastArchivedThread = useReopenLastArchivedThread();
  const running = useRef(false);

  const reopen = useEffectEvent(() => {
    if (running.current) return;
    running.current = true;
    void reopenLastArchivedThread().finally(() => {
      running.current = false;
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for the reopen last archived thread shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isCommandPaletteOpen() || isModelPickerOpen()) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "thread.reopenLastArchived" || isInsideModalDialog(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) reopen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  return null;
}
