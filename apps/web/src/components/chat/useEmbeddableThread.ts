import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useThreadHiding } from "../../state/threadHiding";

/** The thread a right panel tab may show, or `hidden` when the user's tag filter hides it. */
export function useEmbeddableThread(ref: ScopedThreadRef | null) {
  const shell = useQuietThreadShell(ref);
  // Archived threads can be absent from the shell but still have a detail stream.
  const detail = useQuietThreadProjection(shell === null ? ref : null);
  const detailThread = detail?.projection.thread ?? null;
  const hiding = useThreadHiding(ref, shell === null ? ref : null, detailThread);
  const loaded = shell ?? detailThread;
  const hidden = hiding.hiddenByTagFilter || (hiding.offShellBlocked && loaded !== null);
  return { thread: hidden ? null : loaded, hidden };
}
