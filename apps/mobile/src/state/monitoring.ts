import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MonitoringOverviewInput } from "@t3tools/contracts";
import {
  mergeMonitoringOverviews,
  type MonitoringEnvironmentReport,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { t } from "../lib/i18n";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

/** Connected environments answer; their chats merge. A chat stays in the list while it refreshes. */
const monitoringOverviewAtom = Atom.family((inputKey: string) =>
  Atom.make((get): MonitoringOverviewView => {
    const input = JSON.parse(inputKey) as MonitoringOverviewInput;
    const reports: MonitoringEnvironmentReport[] = [];
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      if (presentation.connection.phase !== "connected") continue;
      const result = get(serverEnvironment.monitoringOverview({ environmentId, input }));
      reports.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error:
          result._tag === "Failure" ? t("This environment could not report monitoring.") : null,
        result: AsyncResult.getOrElse(result, () => null),
      });
    }
    return mergeMonitoringOverviews(reports);
  }).pipe(Atom.withLabel(`mobile-monitoring:overview:${inputKey}`)),
);

export function useMonitoringOverview(input: MonitoringOverviewInput): {
  readonly overview: MonitoringOverviewView;
  readonly refresh: () => void;
} {
  const key = JSON.stringify(input);
  const overview = useAtomValue(monitoringOverviewAtom(key));
  const environmentIds = overview.environments.map((environment) => environment.environmentId);
  const idsKey = environmentIds.join(",");
  const refresh = useCallback(() => {
    for (const environmentId of idsKey === "" ? [] : (idsKey.split(",") as EnvironmentId[])) {
      appAtomRegistry.refresh(
        serverEnvironment.monitoringOverview({
          environmentId,
          input: JSON.parse(key) as MonitoringOverviewInput,
        }),
      );
    }
  }, [idsKey, key]);
  return { overview, refresh };
}
