import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createSharedScheduledTaskSync,
  type SharedScheduledTaskSync,
} from "@t3tools/client-runtime/scheduled-task-sharing";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useRef } from "react";

import { environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import {
  sharedScheduledTaskFailuresAtom,
  sharedScheduledTaskSnapshotsAtom,
  supportsSharedScheduledTasks,
} from "../state/sharedScheduledTasks";

/** Keeps shared scheduled tasks equal across every connected environment that supports them. */
export function ScheduledTaskSharingCoordinator() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const syncRef = useRef<SharedScheduledTaskSync | null>(null);
  const candidates = environments.filter(
    (entry) => entry.connection.phase === "connected" && supportsSharedScheduledTasks(entry),
  );
  const key = environmentIdsKey(candidates.map((entry) => entry.environmentId));
  const snapshots = useAtomValue(sharedScheduledTaskSnapshotsAtom(key));

  // The executor holds timers and in-flight requests outside React.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns an external executor
  useEffect(() => {
    const sync = createSharedScheduledTaskSync({
      apply: async ({ environmentId, input }) => {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.applySharedScheduledTask,
          { environmentId, input },
          { reportFailure: false },
        );
        if (result._tag !== "Failure") return { ok: true };
        const error = squashAtomCommandFailure(result);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      },
    });
    syncRef.current = sync;
    const unsubscribe = sync.subscribe(() =>
      registry.set(sharedScheduledTaskFailuresAtom, sync.failures()),
    );
    return () => {
      unsubscribe();
      sync.dispose();
      syncRef.current = null;
      registry.set(sharedScheduledTaskFailuresAtom, new Map());
    };
  }, [registry]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes lists to the executor
  useEffect(() => {
    syncRef.current?.update(snapshots);
  }, [snapshots]);

  return null;
}
