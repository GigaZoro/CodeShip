import { createContext } from "react";

/**
 * True for a thread embedded in another thread's panel; its global shortcuts and
 * listeners stand down.
 */
export const BackgroundThreadContext = createContext(false);
