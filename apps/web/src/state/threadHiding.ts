import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { visibilityParentKey } from "@t3tools/client-runtime/state/threads";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useAnyEnvironmentHiding, useQuietThreadShell } from "./entities";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const NO_HIDDEN_TAGS = Atom.make<ReadonlyArray<string> | null>(null);

interface HidableThread {
  readonly archivedAt?: unknown;
  readonly tags?: ReadonlyArray<string> | undefined;
}
type UnlistedThread = Parameters<typeof visibilityParentKey>[1] & HidableThread;

export interface ThreadHidingInput {
  readonly ref: ScopedThreadRef | null;
  readonly hiddenKeys: ReadonlySet<string>;
  readonly hidingAnywhere: boolean;
  /** Set only for a thread the shell does not list; its detail may be null while it loads. */
  readonly unlisted: {
    readonly thread: HidableThread | null;
    readonly parentKey: string | null;
    readonly parentLoaded: boolean;
    readonly hiddenTags: ReadonlyArray<string> | null;
  } | null;
}

/** Whether the user's tag filter keeps a thread out of every view that would show it. */
export function resolveThreadHiding(input: ThreadHidingInput): {
  readonly hiddenByTagFilter: boolean;
  readonly offShellBlocked: boolean;
} {
  const { ref, hiddenKeys, hidingAnywhere, unlisted } = input;
  const hiddenByTagFilter = ref !== null && hiddenKeys.has(threadKey(ref));
  if (unlisted === null) return { hiddenByTagFilter, offShellBlocked: false };
  // Archived threads are never in the shell; a top-level one opens unless its own tags are hidden.
  const visibleArchivedRoot =
    unlisted.thread?.archivedAt != null &&
    unlisted.parentKey === null &&
    !(unlisted.thread.tags ?? []).some((tag) => unlisted.hiddenTags?.includes(tag) === true);
  // Cached detail can predate a tag or an archive, so while hiding an off-shell thread opens only
  // as the child of a loaded, visible parent (lineage never changes); anything else stays closed.
  const offShellBlocked =
    hidingAnywhere &&
    !visibleArchivedRoot &&
    !(unlisted.parentKey !== null && unlisted.parentLoaded && !hiddenKeys.has(unlisted.parentKey));
  return { hiddenByTagFilter, offShellBlocked };
}

/** The route and the right panel share this decision, so a hidden thread opens in neither. */
export function useThreadHiding(
  ref: ScopedThreadRef | null,
  unlistedRef: ScopedThreadRef | null,
  unlistedThread: UnlistedThread | null,
) {
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const hidingAnywhere = useAnyEnvironmentHiding();
  const parentKey =
    unlistedRef === null || unlistedThread === null
      ? null
      : visibilityParentKey(unlistedRef.environmentId, unlistedThread);
  const parentShell = useQuietThreadShell(parentKey === null ? null : parseThreadKey(parentKey));
  const hiddenTags = useAtomValue(
    unlistedRef === null
      ? NO_HIDDEN_TAGS
      : serverEnvironment.hiddenThreadTagsAtom(unlistedRef.environmentId),
  );
  return {
    hiddenKeys,
    hidingAnywhere,
    ...resolveThreadHiding({
      ref,
      hiddenKeys,
      hidingAnywhere,
      unlisted:
        unlistedRef === null
          ? null
          : { thread: unlistedThread, parentKey, parentLoaded: parentShell !== null, hiddenTags },
    }),
  };
}
