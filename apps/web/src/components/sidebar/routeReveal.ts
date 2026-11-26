import { useRef, useState } from "react";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

// AppSidebarLayout owns this so drawer and Settings remounts preserve the chosen project scope.
// Only route changes may widen that scope; scroll position is lost on remount.
// Leaving Settings commits the router's location before its matches, briefly hiding thread params.
// Ignore null keys so the same thread does not look new during that gap.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
  // The route key whose reveal already widened the scope; a pick the user makes later stands.
  widenedKey: string | null;
}

export function pendingSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
    reveal.widenedKey = null;
  }
  return reveal.pendingKey;
}

export function markSidebarRouteRevealWidened(reveal: SidebarRouteReveal): void {
  reveal.widenedKey = reveal.observedKey;
}

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export function useCollapsedRouteAncestors(routeKey: string | null) {
  const [collapse, setCollapse] = useState({ routeKey, keys: EMPTY_KEYS });
  if (collapse.routeKey !== routeKey) {
    setCollapse({ routeKey, keys: EMPTY_KEYS });
  }
  return [
    collapse.routeKey === routeKey ? collapse.keys : EMPTY_KEYS,
    (keys: ReadonlySet<string>) => setCollapse({ routeKey, keys }),
  ] as const;
}

// Each route change and each mount scroll to the open thread once. Render records
// the route, so a thread left before its row mounted still counts as a change.
// The row can mount after the route, once its shells arrive, so its ref scrolls.
export function useActiveRowReveal(reveal: SidebarRouteReveal, routeKey: string | null) {
  const mountRevealOwed = useRef(true);
  pendingSidebarRouteReveal(reveal, routeKey);
  return (row: HTMLElement | null) => {
    if (row === null) return;
    if (reveal.pendingKey === null && !mountRevealOwed.current) return;
    completeSidebarRouteReveal(reveal);
    mountRevealOwed.current = false;
    // A row under the pointer was just clicked, so it is in view; scrolling it would force a
    // layout mid-commit. Keyboard activation can come from a focused row scrolled out of view.
    if (row.matches(":hover")) return;
    row.scrollIntoView({ block: "nearest" });
  };
}

type RevealableThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];

// Render records the route before deciding, so the first render of a new route
// already widens the scope. Only a route reveal widens: the once-per-mount
// scroll never changes a scope the user chose.
export function resolveSidebarRouteReveal<T extends RevealableThread>(input: {
  readonly reveal: SidebarRouteReveal;
  readonly routeKey: string | null;
  readonly sectionRowKey?: string | null;
  readonly descendantOutsideScope?: boolean;
  readonly isSearching: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly findThread: (key: string) => T | undefined;
  readonly listsThread: (thread: T) => boolean;
}): { readonly pendingKey: string | null; readonly widensScope: boolean } {
  const {
    reveal,
    routeKey,
    isSearching,
    scopedProjectKeys,
    delegatedUnderParent,
    findThread,
    listsThread,
  } = input;
  const pendingKey = pendingSidebarRouteReveal(reveal, routeKey);
  // Search results replace the thread list; the reveal waits for it to return.
  const thread =
    pendingKey === null || isSearching ? undefined : findThread(input.sectionRowKey ?? pendingKey);
  if (thread !== undefined && !listsThread(thread)) {
    // Widening could never show the row now, and a scope picked later stands; the row still
    // scrolls if it mounts later, e.g. once an approval resolves elsewhere.
    markSidebarRouteRevealWidened(reveal);
    return { pendingKey, widensScope: false };
  }
  const widensScope =
    thread !== undefined &&
    reveal.widenedKey !== reveal.observedKey &&
    scopedProjectKeys !== null &&
    (input.descendantOutsideScope === true ||
      filterSidebarV2VisibleThreads([thread], scopedProjectKeys, delegatedUnderParent).length ===
        0) &&
    filterSidebarV2VisibleThreads([thread], null, delegatedUnderParent).length === 1;
  return { pendingKey, widensScope };
}
