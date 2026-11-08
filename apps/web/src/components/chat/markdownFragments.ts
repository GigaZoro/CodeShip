import type { MouseEvent as ReactMouseEvent } from "react";
import type { VFile } from "vfile";

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

function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The ids of one rendered block, so later blocks can keep heading ids unique across a reply. */
interface MarkdownHeadingIds {
  /** Ids the text gave elements itself; a heading never takes one. */
  readonly reserved: ReadonlyArray<string>;
  /** Each heading's slug and the id it got within its block, in order. */
  readonly slugs: ReadonlyArray<string>;
  readonly ids: ReadonlyArray<string>;
}

declare module "vfile" {
  interface DataMap {
    headingIds: MarkdownHeadingIds;
  }
}

const NO_HEADING_IDS: MarkdownHeadingIds = { reserved: [], slugs: [], ids: [] };

/** GitHub's numbering: the first free of `slug`, `slug-1`, `slug-2`, ... */
function claimHeadingId(slug: string, taken: Set<string>): string {
  let id = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
  for (let count = 1; taken.has(id); count++) id = `${SANITIZED_FRAGMENT_PREFIX}${slug}-${count}`;
  taken.add(id);
  return id;
}

function mayClaim(slug: string, id: string): boolean {
  const base = `${SANITIZED_FRAGMENT_PREFIX}${slug}`;
  return id === base || (id.startsWith(`${base}-`) && /^\d+$/.test(id.slice(base.length + 1)));
}

/**
 * Like the sanitizer's ids, they carry the `user-content-` prefix so they cannot clobber app
 * element ids; fragment lookup strips it.
 */
export function rehypeHeadingIds() {
  return (tree: HeadingHastNode, file: VFile) => {
    const taken = new Set<string>();
    const collect = (node: HeadingHastNode) => {
      const id = node.properties?.id;
      if (typeof id === "string") taken.add(id);
      node.children?.forEach(collect);
    };
    collect(tree);
    const reserved = [...taken];
    const slugs: string[] = [];
    const ids: string[] = [];
    const visit = (node: HeadingHastNode) => {
      if (node.type === "element" && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const slug = githubHeadingSlug(hastPlainTextDeep(node));
        if (node.properties?.id === undefined && slug) {
          const id = claimHeadingId(slug, taken);
          slugs.push(slug);
          ids.push(id);
          node.properties = { ...node.properties, id };
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    file.data.headingIds = { reserved, slugs, ids };
  };
}

/**
 * Numbers headings across blocks as one document would. Each block gets the taken ids its headings
 * could collide with, as a key; a block whose headings aren't known yet gets `following`.
 */
export function headingIdsTakenBefore(blocks: ReadonlyArray<MarkdownHeadingIds | undefined>): {
  readonly keys: string[];
  readonly following: string;
} {
  const taken = new Set(blocks.flatMap((block) => block?.reserved ?? []));
  const keys = blocks.map((block = NO_HEADING_IDS) => {
    const relevant = [...taken].filter((id) => block.slugs.some((slug) => mayClaim(slug, id)));
    for (const slug of block.slugs) claimHeadingId(slug, taken);
    return relevant.length === 0 ? "" : JSON.stringify(relevant);
  });
  return { keys, following: taken.size === 0 ? "" : JSON.stringify([...taken]) };
}

/** The block's heading ids that change once earlier blocks' ids are taken. */
export function headingIdRenames(
  block: MarkdownHeadingIds = NO_HEADING_IDS,
  takenKey: string,
): ReadonlyMap<string, string> | null {
  if (takenKey === "" || block.slugs.length === 0) return null;
  const taken = new Set<string>([...(JSON.parse(takenKey) as string[]), ...block.reserved]);
  const renames = new Map<string, string>();
  block.slugs.forEach((slug, index) => {
    const id = claimHeadingId(slug, taken);
    const local = block.ids[index];
    if (local !== undefined && local !== id) renames.set(local, id);
  });
  return renames.size === 0 ? null : renames;
}
