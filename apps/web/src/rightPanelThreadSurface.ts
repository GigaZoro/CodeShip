import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ScopedThreadRef, type ProjectId } from "@t3tools/contracts";
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

/** The workspace a thread's panel surfaces (files, terminals, browser tabs) resolve against. */
export interface RightPanelThreadWorkspace {
  readonly ref: ScopedThreadRef;
  /** Null while the thread is not loaded; an unknown workspace shares nothing. */
  readonly projectId: ProjectId | null;
  readonly worktreePath: string | null;
}

export function sharesThreadWorkspace(
  a: RightPanelThreadWorkspace,
  b: RightPanelThreadWorkspace,
): boolean {
  return (
    a.ref.environmentId === b.ref.environmentId &&
    a.projectId !== null &&
    a.projectId === b.projectId &&
    a.worktreePath === b.worktreePath
  );
}
