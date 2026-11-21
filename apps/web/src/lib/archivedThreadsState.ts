import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedThreadSnapshotsState,
  type ArchivedThreadsView,
  createArchivedThreadSnapshotsAtomFamily,
  latestArchivedThread,
  makeArchivedThreadsViewKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { t } from "~/i18n";

import { orchestrationEnvironment } from "../state/orchestration";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForAtomValue } from "../state/waitForAtomValue";

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getPageAtom: (environmentId, input) =>
    orchestrationEnvironment.archivedShellSnapshot({ environmentId, input }),
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
  hiddenThreadKeysAtom: environmentThreadShells.hiddenThreadKeysAtom,
  liveThreadRefsAtom: environmentThreadShells.threadRefsAtom,
  anyEnvironmentHidingAtom: environmentThreadShells.anyEnvironmentHidingAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.update(
    orchestrationEnvironment.archivedShellSnapshotRefresh(environmentId),
    (count) => count + 1,
  );
}

export function useArchivedThreadSnapshots(
  view: ArchivedThreadsView,
): ArchivedThreadSnapshotsState & { readonly refresh: () => void } {
  const result = useAtomValue(archivedSnapshotsAtom(makeArchivedThreadsViewKey(view)));
  const refresh = () => {
    for (const environmentId of view.environmentIds) {
      refreshArchivedThreadsForEnvironment(environmentId);
    }
  };
  return { ...result, refresh };
}

const LATEST_ARCHIVED_TIMEOUT_MS = 10_000;

export type LatestArchivedThreadResult =
  | { readonly _tag: "Found"; readonly threadRef: ScopedThreadRef }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Failed"; readonly message: string };

/** Reads the newest archived thread of the given machines once, without a mounted view. */
export async function loadLatestArchivedThread(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<LatestArchivedThreadResult> {
  if (environmentIds.length === 0) return { _tag: "Empty" };
  for (const environmentId of environmentIds) refreshArchivedThreadsForEnvironment(environmentId);
  const atom = archivedSnapshotsAtom(makeArchivedThreadsViewKey({ environmentIds }));
  const settled = await waitForAtomValue({
    registry: appAtomRegistry,
    atom,
    predicate: (state) => !state.isLoading,
    timeoutMs: LATEST_ARCHIVED_TIMEOUT_MS,
  });
  const state = appAtomRegistry.get(atom);
  const latest = latestArchivedThread(state.snapshots);
  if (latest !== null) {
    return {
      _tag: "Found",
      threadRef: { environmentId: latest.environmentId, threadId: latest.thread.id },
    };
  }
  if (!settled || state.error !== null) {
    return { _tag: "Failed", message: state.error ?? t("Timed out loading archived threads.") };
  }
  return { _tag: "Empty" };
}
