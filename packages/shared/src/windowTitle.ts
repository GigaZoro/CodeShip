const SEPARATOR = " - ";

/** What is open comes first, so taskbars that cut long titles still show it. */
export function formatAppWindowTitle(
  context: ReadonlyArray<string | null | undefined>,
  appName: string,
): string {
  const parts = context.flatMap((part) => {
    const trimmed = part?.trim();
    return trimmed ? [trimmed] : [];
  });
  return [...parts, appName].join(SEPARATOR);
}

/**
 * A host window keeps a page's title only when the page named it after this app, so error
 * pages and the static HTML title never show.
 */
export function resolveAppWindowTitle(pageTitle: string, appName: string): string {
  return pageTitle === appName || pageTitle.endsWith(`${SEPARATOR}${appName}`)
    ? pageTitle
    : appName;
}
