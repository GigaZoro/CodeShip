import { useNavigate, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";

/** The sidebar rail's sections other than Threads. */
export function isSidebarSectionPage(pathname: string) {
  return (
    pathname === "/pull-requests" ||
    pathname === "/usage" ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/")
  );
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
