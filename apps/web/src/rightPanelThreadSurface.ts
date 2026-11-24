import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ThreadPanelSurface {
  id: `thread:${string}`;
  kind: "thread";
  threadRef: ScopedThreadRef;
}

export function threadPanelSurface(threadRef: ScopedThreadRef): ThreadPanelSurface {
  return { kind: "thread", id: `thread:${scopedThreadKey(threadRef)}`, threadRef };
}

const isThreadRef = Schema.is(ScopedThreadRef);

export function isThreadPanelSurface(value: unknown): value is ThreadPanelSurface {
  if (typeof value !== "object" || value === null) return false;
  const surface = value as Partial<Record<keyof ThreadPanelSurface, unknown>>;
  return (
    surface.kind === "thread" &&
    isThreadRef(surface.threadRef) &&
    surface.id === threadPanelSurface(surface.threadRef).id
  );
}
