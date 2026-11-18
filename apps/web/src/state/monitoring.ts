import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  mergeMonitoringOverviews,
  type MonitoringEnvironmentReport,
  type MonitoringOverviewView,
} from "@t3tools/client-runtime/monitoring";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
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
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
        result: AsyncResult.getOrElse(result, () => null),
      });
    }
    return mergeMonitoringOverviews(reports);
  }).pipe(Atom.withLabel(`web-monitoring:overview:${inputKey}`)),
);

export function useMonitoringOverview(input: MonitoringOverviewInput): MonitoringOverviewView {
  return useAtomValue(monitoringOverviewAtom(JSON.stringify(input)));
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
