import { createContext } from "react";

/**
 * Ref callback for the chat's details column slot. Without a registered slot, as in narrow chats,
 * Needs you stays in the thread list.
 */
export const NeedsYouSlotContext = createContext<
  (element: HTMLElement | null) => void | (() => void)
>(() => undefined);
