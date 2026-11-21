const SEPARATOR = " - ";

const NEEDS_YOU_PREFIX = /^\(\d+\) /;

/**
 * What is open comes first, so taskbars that cut long titles still show it. A count of threads
 * waiting on the user leads the whole title, where tabs and task switchers show it.
 */
export function formatAppWindowTitle(
  context: ReadonlyArray<string | null | undefined>,
  appName: string,
  needsYouCount = 0,
): string {
  const parts = context.flatMap((part) => {
    const trimmed = part?.trim();
    return trimmed ? [trimmed] : [];
  });
  const title = [...parts, appName].join(SEPARATOR);
  return needsYouCount > 0 ? `(${needsYouCount}) ${title}` : title;
}

/**
 * A host window keeps a page's title only when the page named it after this app, so error
 * pages and the static HTML title never show.
 */
export function resolveAppWindowTitle(pageTitle: string, appName: string): string {
  const unprefixed = pageTitle.replace(NEEDS_YOU_PREFIX, "");
  return unprefixed === appName || unprefixed.endsWith(`${SEPARATOR}${appName}`)
    ? pageTitle
    : appName;
}
