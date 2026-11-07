import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useState } from "react";

interface FileRevealViewport {
  getScrollTop(): number;
  getHeight(): number;
  getScrollHeight(): number;
  getTopForItem(id: string): number | undefined;
}

interface FileRevealHandle {
  getInstance(): FileRevealViewport | undefined;
  getItem(id: string): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/**
 * The file a reader is on: the last one whose top has reached the top of the viewport. Files at
 * the end of a diff cannot scroll that far, so at the bottom the file last revealed counts while
 * it is on screen below that one.
 */
function fileAtViewportTop(
  ids: ReadonlyArray<string>,
  viewport: FileRevealViewport,
  lastRevealed: string | null,
): string | null {
  const scrollTop = viewport.getScrollTop();
  const scrollBottom = scrollTop + viewport.getHeight();
  const atBottom = scrollBottom >= viewport.getScrollHeight() - 1;
  let current: string | null = null;
  for (const id of ids) {
    const top = viewport.getTopForItem(id);
    if (top === undefined) continue;
    if (top <= scrollTop + 1) current = id;
    else if (atBottom && id === lastRevealed && top < scrollBottom) return id;
    else if (!atBottom) break;
  }
  return current;
}

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. A reveal belongs to the diff it was asked of, so detaching the viewer,
 * such as remounting it for another diff scope, drops it.
 */
export function createCodeViewFileReveal() {
  let viewer: FileRevealHandle | null = null;
  let pending: string | null = null;
  let lastRevealed: string | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending, align: "start" });
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (viewer !== null && next !== viewer) {
        pending = null;
        lastRevealed = null;
      }
      viewer = next;
      flush();
    },
    request(fileKey: string) {
      pending = fileKey;
      lastRevealed = fileKey;
      flush();
    },
    flush,
    /** The file at the top of `ids`, in viewer order, or the one a reveal is still waiting for. */
    fileAtTop(ids: ReadonlyArray<string>): string | null {
      if (pending !== null) return pending;
      const viewport = viewer?.getInstance();
      return viewport ? fileAtViewportTop(ids, viewport, lastRevealed) : null;
    },
  };
}

export function useCodeViewFileReveal() {
  const [reveal] = useState(createCodeViewFileReveal);
  return reveal;
}

/** The file after or before `current` in `ids`; with no current file, next is the first. */
export function adjacentFileKey(
  ids: ReadonlyArray<string>,
  current: string | null,
  direction: "previous" | "next",
): string | null {
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return direction === "next" ? (ids[0] ?? null) : null;
  return ids[direction === "next" ? index + 1 : index - 1] ?? null;
}
