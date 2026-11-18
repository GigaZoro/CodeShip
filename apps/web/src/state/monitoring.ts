import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  mergeMonitoringOverviews,
  monitoringEnvironmentInput,
  type MonitoringEnvironmentReport,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

/** Connected environments answer; their figures merge. */
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
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        result: AsyncResult.getOrElse(result, () => null),
        optionsOnly: asked.optionsOnly,
      });
    }
    return mergeMonitoringOverviews(reports, input);
  }).pipe(Atom.withLabel(`web-monitoring:overview:${queryKey}`)),
);

interface MonitoringOverviewQuery {
  readonly input: MonitoringOverviewInput;
  /** The environment that holds the chosen project. */
  readonly projectEnvironmentId: EnvironmentId | null;
}

export interface MonitoringOverviewState {
  readonly overview: MonitoringOverviewView;
  /** The overview shown is the last answer while a new question is still loading, or it is refreshing. */
  readonly isRefreshing: boolean;
}

export function useMonitoringOverview(
  input: MonitoringOverviewInput,
  projectEnvironmentId: EnvironmentId | null,
): MonitoringOverviewState {
  const queryKey = JSON.stringify({
    input,
    projectEnvironmentId,
  } satisfies MonitoringOverviewQuery);
  const current = useAtomValue(monitoringOverviewAtom(queryKey));
  const [lastAnswered, setLastAnswered] = useState<MonitoringOverviewView | null>(null);
  if (!current.isLoading && lastAnswered !== current) setLastAnswered(current);
  const overview = current.isLoading ? (lastAnswered ?? current) : current;
  return {
    overview,
    isRefreshing:
      overview !== current || overview.environments.some((environment) => environment.isPending),
  };
}

export function refreshMonitoringOverview(
  environmentIds: ReadonlyArray<EnvironmentId>,
  input: MonitoringOverviewInput,
) {
  for (const environmentId of environmentIds) {
    appAtomRegistry.refresh(serverEnvironment.monitoringOverview({ environmentId, input }));
  }
}

export interface MonitoringThreadView {
  readonly detail: MonitoringThreadDetail | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

export function useMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
): MonitoringThreadView {
  const result = useAtomValue(
    serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
  );
  return {
    detail: AsyncResult.getOrElse(result, () => null),
    isPending: result.waiting,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

export function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  appAtomRegistry.refresh(
    serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
  );
}
