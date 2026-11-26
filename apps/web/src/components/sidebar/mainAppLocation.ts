import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useLocation, useNavigate, useRouter, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../../threadRoutes";

export function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** The sidebar rail's sections other than Threads. */
export function isSidebarSectionPage(pathname: string) {
  return (
    pathname === "/projects" ||
    isSidebarUtilityPage(pathname) ||
    pathname === "/artifacts" ||
    pathname === "/extensions" ||
    pathname === "/archived" ||
    pathname === "/scheduled-tasks" ||
    pathname === "/thread-page" ||
    pathname === "/manual-steps" ||
    pathname === "/usage" ||
    pathname === "/monitoring" ||
    pathname === "/machines" ||
    isSettingsPage(pathname)
  );
}

/** What the sidebar shows beside the rail. "none" leaves the sidebar to the rail alone. */
export type SidebarPanel = "threads" | "settings" | "none";

function sidebarPanelFor(pathname: string): SidebarPanel {
  if (isSettingsPage(pathname)) return "settings";
  return isSidebarSectionPage(pathname) ? "none" : "threads";
}

/**
 * Only thread pages list threads beside the rail; Settings lists its sections. Below md
 * the sidebar is a sheet over the page, so it keeps the thread list and Settings keeps
 * its own section nav on the page.
 */
export function useSidebarPanel(): SidebarPanel {
  const panel = useLocation({ select: (location) => sidebarPanelFor(location.pathname) });
  const sidebarIsSheet = useMediaQuery("max-md");
  return sidebarIsSheet ? "threads" : panel;
}

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/pull-requests" ||
    pathname === "/issues" ||
    pathname === "/workflows"
  );
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;
let appModalReturnHistoryIndex: number | null = null;
let appModalReturnThreadTarget: ThreadRouteTarget | null = null;
let initialHistoryIndex = 0;

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  initialHistoryIndex = router.state.location.state.__TSR_index;
  const record = () => {
    const { pathname } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    const href = withoutAssistantCitationHash(router.state.location.href);
    appModalReturnHref = href;
    // Only an entry that is exactly the return location can be stepped back to.
    appModalReturnHistoryIndex =
      href === router.state.location.href ? router.state.location.state.__TSR_index : null;
    appModalReturnThreadTarget = resolveThreadRouteTarget(
      router.state.matches.at(-1)?.params ?? {},
    );
    if (!isSidebarSectionPage(pathname)) mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

/** The thread Settings or Usage opened over, for views mounted while the modal is open. */
export function getAppModalReturnThreadTarget() {
  return appModalReturnThreadTarget;
}

export function readMainAppHref() {
  return mainAppHref ?? "/";
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  const router = useRouter();
  return () => {
    const href = appModalReturnHref ?? mainAppHref ?? "/";
    const returnIndex = appModalReturnHistoryIndex ?? 0;
    const steps = router.state.location.state.__TSR_index - returnIndex;
    // Stepping back past this document's first entry reloads the page. Written as a negated
    // comparison so a missing (NaN) history index also falls back to client navigation.
    if (!(returnIndex > initialHistoryIndex && steps > 0)) return navigate({ href, replace: true });
    // Go back to the entry before the return page and push it again: only a push drops the
    // modal's entries from forward history, and reusing the old entry avoids a duplicate stop.
    const unsubscribe = router.history.subscribe(() => {
      unsubscribe();
      void navigate({ href });
    });
    router.history.go(-(steps + 1));
  };
}
