import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MonitoringOverviewInput } from "@t3tools/contracts";
import {
  mergeMonitoringOverviews,
  monitoringEnvironmentInput,
  type MonitoringEnvironmentReport,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useState } from "react";

import { t } from "../lib/i18n";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

interface MonitoringOverviewQuery {
  readonly input: MonitoringOverviewInput;
  /** The environment that holds the chosen project. */
  readonly projectEnvironmentId: EnvironmentId | null;
}

/** Connected environments answer; their chats merge. */
const monitoringOverviewAtom = Atom.family((queryKey: string) =>
  Atom.make((get): MonitoringOverviewView => {
    const { input, projectEnvironmentId } = JSON.parse(queryKey) as MonitoringOverviewQuery;
    const reports: MonitoringEnvironmentReport[] = [];
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      if (presentation.connection.phase !== "connected") continue;
      const asked = monitoringEnvironmentInput(input, projectEnvironmentId, environmentId);
      const result = get(
        serverEnvironment.monitoringOverview({ environmentId, input: asked.input }),
      );
      reports.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting,
        error:
          result._tag === "Failure" ? t("This environment could not report monitoring.") : null,
        result: AsyncResult.getOrElse(result, () => null),
        optionsOnly: asked.optionsOnly,
      });
    }
    return mergeMonitoringOverviews(reports, input);
  }).pipe(Atom.withLabel(`mobile-monitoring:overview:${queryKey}`)),
);

export function useMonitoringOverview(
  input: MonitoringOverviewInput,
  projectEnvironmentId: EnvironmentId | null,
): {
  readonly overview: MonitoringOverviewView;
  /** The view shown is the last answer while a new question loads, or it is refreshing. */
  readonly isRefreshing: boolean;
  readonly refresh: () => void;
} {
  const queryKey = JSON.stringify({
    input,
    projectEnvironmentId,
  } satisfies MonitoringOverviewQuery);
  const current = useAtomValue(monitoringOverviewAtom(queryKey));
  const [lastAnswered, setLastAnswered] = useState<MonitoringOverviewView | null>(null);
  if (!current.isLoading && lastAnswered !== current) setLastAnswered(current);
  const overview = current.isLoading ? (lastAnswered ?? current) : current;
  const idsKey = overview.environments.map((environment) => environment.environmentId).join(",");
  const refresh = useCallback(() => {
    const query = JSON.parse(queryKey) as MonitoringOverviewQuery;
    for (const id of idsKey === "" ? [] : (idsKey.split(",") as EnvironmentId[])) {
      appAtomRegistry.refresh(
        serverEnvironment.monitoringOverview({ environmentId: id, input: query.input }),
      );
    }
  }, [idsKey, queryKey]);
  return {
    overview,
    isRefreshing:
      overview !== current || overview.environments.some((environment) => environment.isPending),
    refresh,
  };
}
