import {
  createSharedScheduledTaskSync,
  sharedScheduledTaskSnapshot,
  type SharedScheduledTaskSnapshot,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";

import { useAtomValue } from "@effect/atom-react";

import { appAtomRegistry } from "./atom-registry";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { serverEnvironment } from "./server";

// A list that has not loaded yet is left out: unknown is not empty.
const sharedSnapshotsAtom = Atom.make((get) => {
  const snapshots: SharedScheduledTaskSnapshot[] = [];
  for (const environmentId of get(connectedEnvironmentIdsAtom)) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.sharedScheduledTasks !== true) continue;
    if (get(serverEnvironment.applySharedScheduledTask.permissionAtom(environmentId)) !== true) {
      continue;
    }
    const list = AsyncResult.getOrElse(
      get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
      () => null,
    );
    if (list === null) continue;
    snapshots.push(sharedScheduledTaskSnapshot(environmentId, list));
  }
  return snapshots;
}).pipe(Atom.withLabel("mobile-shared-scheduled-task-snapshots"));

/** Keeps shared scheduled tasks equal across every connected environment that supports them. */
export function installSharedScheduledTaskSync(): () => void {
  const sync = createSharedScheduledTaskSync({
    apply: async ({ environmentId, input }) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.applySharedScheduledTask,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag !== "Failure") return { ok: true };
      const error = squashAtomCommandFailure(result);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    },
  });
  const unsubscribe = appAtomRegistry.subscribe(sharedSnapshotsAtom, sync.update, {
    immediate: true,
  });
  return () => {
    unsubscribe();
    sync.dispose();
  };
}

export function useSharedScheduledTaskSnapshots() {
  return useAtomValue(sharedSnapshotsAtom);
}
