import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ThreadPanelSurface {
  id: `thread:${string}`;
  kind: "workspace-thread";
  threadRef: ScopedThreadRef;
}

export function threadPanelSurface(threadRef: ScopedThreadRef): ThreadPanelSurface {
  return { kind: "workspace-thread", id: `thread:${scopedThreadKey(threadRef)}`, threadRef };
}

const isThreadRef = Schema.is(ScopedThreadRef);

/** Restores workspace tabs saved with the former thread kind and rejects mismatched scoped ids. */
export function decodeThreadPanelSurface(value: unknown): ThreadPanelSurface | null {
  if (typeof value !== "object" || value === null) return null;
  const surface = value as Partial<Record<keyof ThreadPanelSurface, unknown>>;
  if (
    (surface.kind !== "thread" && surface.kind !== "workspace-thread") ||
    !isThreadRef(surface.threadRef)
  )
    return null;
  const decoded = threadPanelSurface(surface.threadRef);
  return surface.id === decoded.id ? decoded : null;
}
