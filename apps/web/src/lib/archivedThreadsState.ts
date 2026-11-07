import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedThreadSnapshotsState,
  type ArchivedThreadsView,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsViewKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";

import { orchestrationEnvironment } from "../state/orchestration";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";

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
