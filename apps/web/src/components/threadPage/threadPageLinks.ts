import { useNavigate } from "@tanstack/react-router";

import { readLocalApi } from "../../localApi";
import { previewBridge } from "../preview/previewBridge";

const THREAD_PAGE_ORIGIN = "https://thread.page";
export const THREAD_PAGE_APP_URL = `${THREAD_PAGE_ORIGIN}/app`;

export function isThreadPageUrl(url: string): boolean {
  try {
    return new URL(url).origin === THREAD_PAGE_ORIGIN;
  } catch {
    return false;
  }
}

/** Returns false when this client has no system browser to hand the link to. */
export function openInSystemBrowser(url: string): boolean {
  const api = readLocalApi();
  if (!api) return false;
  void api.shell
    .openExternal(url)
    .catch((error: unknown) => console.error("Failed to open link in the system browser", error));
  return true;
}

/**
 * Thread browsers are signed out of ThreadPage, so its links open where the user
 * is signed in: the ThreadPage page on desktop, a browser tab on web.
 * Returns false when the link is not ThreadPage's and the caller should open it.
 */
export function useOpenThreadPageLink(): (url: string) => boolean {
  const navigate = useNavigate();
  return (url) => {
    if (!isThreadPageUrl(url)) return false;
    if (previewBridge) {
      void navigate({ to: "/thread-page", search: { url } });
      return true;
    }
    return openInSystemBrowser(url);
  };
}
