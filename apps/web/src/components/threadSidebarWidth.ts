export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
export const THREAD_SIDEBAR_NAV_RAIL_WIDTH = 3 * 16;
// Widths include the nav rail, so the thread list keeps its 16rem default and 13rem floor.
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16 + THREAD_SIDEBAR_NAV_RAIL_WIDTH;
// Wide windows start with a wider list, so nested folder titles are not cut to a few words.
const THREAD_SIDEBAR_WIDE_DEFAULT_WIDTH = 26 * 16 + THREAD_SIDEBAR_NAV_RAIL_WIDTH;
const THREAD_SIDEBAR_DEFAULT_VIEWPORT_SHARE = 0.2;
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16 + THREAD_SIDEBAR_NAV_RAIL_WIDTH;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? clampThreadSidebarWidth(
          Math.round(viewportWidth * THREAD_SIDEBAR_DEFAULT_VIEWPORT_SHARE),
          THREAD_SIDEBAR_DEFAULT_WIDTH,
          THREAD_SIDEBAR_WIDE_DEFAULT_WIDTH,
        )
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
