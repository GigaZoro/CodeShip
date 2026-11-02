import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion } from "../Sidebar.logic";

/**
 * Unread threads on servers too old to record visits, which only this device tracks.
 * Selecting the joined keys re-renders only when that set changes, not on each visit tick.
 */
export function useLocallyUnreadThreadKeys(
  threads: readonly EnvironmentThreadShell[],
): ReadonlySet<string> {
  const joinedKeys = useUiStateStore((store) =>
    threads
      .flatMap((thread) => {
        if (thread.lastVisitedAt !== undefined) return [];
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        const lastVisitedAt = store.threadLastVisitedAtById[key];
        return hasUnseenCompletion({ ...thread, lastVisitedAt }) ? [key] : [];
      })
      .join("\n"),
  );
  return new Set(joinedKeys === "" ? [] : joinedKeys.split("\n"));
}
