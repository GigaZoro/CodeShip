import type { MouseEvent as ReactMouseEvent } from "react";

import { hastPlainTextDeep } from "./markdownHast.logic";

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

export function handleMarkdownFragmentClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  // Never let the browser follow the fragment or write it to the URL: desktop keeps
  // its route in the hash, so replacing the hash navigates away from the thread.
  event.preventDefault();
  findMarkdownFragmentTarget(event.currentTarget, href)?.scrollIntoView({ block: "start" });
}

type HeadingHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HeadingHastNode[];
};

export function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** GitHub's numbering: the first free of `slug`, `slug-1`, `slug-2`, ... */
function claimHeadingId(slug: string, taken: Set<string>): string {
  let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
  for (let count = 1; taken.has(id); count++) id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
  taken.add(id);
  return id;
}

/** Gives headings prefixed IDs while respecting the IDs already reserved by sanitized HTML. */
export function addMarkdownHeadingIds(tree: HeadingHastNode) {
  const taken = new Set<string>();
  const collect = (node: HeadingHastNode) => {
    const id = node.properties?.id;
    if (typeof id === "string") taken.add(id);
    node.children?.forEach(collect);
  };
  collect(tree);
  const visit = (node: HeadingHastNode) => {
    if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
      const slug = githubHeadingSlug(hastPlainTextDeep(node));
      if (node.properties?.id === undefined && slug) {
        node.properties = { ...node.properties, id: claimHeadingId(slug, taken) };
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(tree);
}
