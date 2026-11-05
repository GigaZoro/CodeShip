import * as Schema from "effect/Schema";
import { createContext } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/** Narrower windows keep Needs you in the thread list. */
export const NEEDS_YOU_COLUMN_MIN_WIDTH = 1280;

export function useNeedsYouColumnVisible() {
  return useLocalStorage("t3code:needs-you-column-visible", true, Schema.Boolean);
}

/** Ref callback for an open inline right panel; the Needs you column gives up the right edge to it. */
export const InlineRightPanelRefContext = createContext<
  (element: HTMLElement | null) => void | (() => void)
>(() => undefined);
