import { useAtomValue } from "@effect/atom-react";
import { failedScheduledTaskCount } from "@t3tools/client-runtime/scheduled-task-pins";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { tn, t } from "~/i18n";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { RailCountBadge } from "./SidebarNavRailBadge";

/** Keyed like the sidebar's task atoms, so the rail reads the same live lists. */
const failedScheduledTaskCountAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    failedScheduledTaskCount(
      (JSON.parse(environmentIdsKey) as ReadonlyArray<EnvironmentId>).map(
        (environmentId) =>
          AsyncResult.getOrElse(
            get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} })),
            () => null,
          )?.tasks ?? [],
      ),
    ),
  ).pipe(Atom.withLabel(`web:scheduled-task-failures:${environmentIdsKey}`)),
);

/** The Scheduled tasks rail item's label, and a count of tasks whose latest run failed. */
export function useScheduledTasksRailBadge() {
  const serverConfigs = useServerConfigs();
  const failed = useAtomValue(
    failedScheduledTaskCountAtom(JSON.stringify([...serverConfigs.keys()])),
  );
  if (failed === 0) return { label: t("Scheduled tasks"), badge: null };
  return {
    label: tn(
      failed,
      "Scheduled tasks: {count} task's last run failed",
      "Scheduled tasks: {count} tasks' last runs failed",
    ),
    badge: <RailCountBadge count={failed} tone="problem" />,
  };
}
