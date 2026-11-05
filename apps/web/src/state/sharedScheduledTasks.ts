import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  sharedScheduledTaskSnapshot,
  type SharedScheduledTaskSnapshot,
  type SharedScheduledTaskSyncFailure,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "./server";

/** Keyed by the ids of connected environments that support sharing. */
export const sharedScheduledTaskSnapshotsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const snapshots: SharedScheduledTaskSnapshot[] = [];
    for (const environmentId of key === "" ? [] : (key.split("\n") as EnvironmentId[])) {
      if (get(serverEnvironment.applySharedScheduledTask.permissionAtom(environmentId)) !== true) {
        continue;
      }
      // An unloaded list is unknown, not empty.
      const list = AsyncResult.getOrElse(
        get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
        () => null,
      );
      if (list === null) continue;
      snapshots.push(sharedScheduledTaskSnapshot(environmentId, list));
    }
    return snapshots;
  }).pipe(Atom.withLabel(`web-shared-scheduled-task-snapshots:${key}`)),
);

export const sharedScheduledTaskFailuresAtom = Atom.make<
  ReadonlyMap<string, SharedScheduledTaskSyncFailure>
>(new Map()).pipe(Atom.withLabel("web-shared-scheduled-task-failures"));

export function useSharedScheduledTaskFailures() {
  return useAtomValue(sharedScheduledTaskFailuresAtom);
}

export function supportsSharedScheduledTasks(
  environment: {
    readonly serverConfig: {
      readonly environment: { readonly capabilities: { readonly sharedScheduledTasks?: boolean } };
    } | null;
  } | null,
): boolean {
  return environment?.serverConfig?.environment.capabilities.sharedScheduledTasks === true;
}
