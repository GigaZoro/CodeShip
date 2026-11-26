import { createContext } from "react";

/**
 * True for a thread embedded in another thread's panel; its global shortcuts and
 * listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);

/** True only for a thread kept mounted out of sight under Settings or Usage. */
export const HiddenThreadContext = createContext(false);
