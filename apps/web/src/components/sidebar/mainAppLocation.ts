import { useLocation, useNavigate, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { useMediaQuery } from "../../hooks/useMediaQuery";

export function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** The sidebar rail's sections other than Threads. */
export function isSidebarSectionPage(pathname: string) {
  return (
    pathname === "/pull-requests" ||
    pathname === "/artifacts" ||
    pathname === "/skills" ||
    pathname === "/scheduled-tasks" ||
    pathname === "/usage" ||
    isSettingsPage(pathname)
  );
}

/**
 * Settings sections replace the thread list in the sidebar. Below md the sidebar
 * is a sheet, so Settings keeps its own section nav on the page.
 */
export function useSettingsNavInSidebar() {
  const onSettingsPage = useLocation({ select: (location) => isSettingsPage(location.pathname) });
  const sidebarIsSheet = useMediaQuery("max-md");
  return onSettingsPage && !sidebarIsSheet;
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;

/** Remembers the last thread-side page, where leaving a section returns to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname, href } = router.state.location;
    if (isSidebarSectionPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

export function readMainAppHref() {
  return mainAppHref ?? "/";
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: readMainAppHref() });
}
