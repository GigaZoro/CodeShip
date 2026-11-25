import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  presentMonitoringChats,
  presentMonitoringOverview,
  type MonitoringChatsRequest,
} from "@t3tools/client-runtime/monitoring";
import {
  createMonitoringAtoms,
  createMonitoringOperation,
  executeMonitoringQuery,
  monitoringRefreshTimedOut,
} from "@t3tools/client-runtime/monitoring/atoms";
import { useContext, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

const monitoring = createMonitoringAtoms({
  label: "web-monitoring",
  registry: appAtomRegistry,
  server: serverEnvironment,
  presentations: environmentPresentations,
  catalog: environmentCatalog,
  describeFailure: formatEnvironmentQueryError,
});

export function useMonitoringOverview(input: MonitoringOverviewInput) {
  const key = JSON.stringify(input);
  const view = useAtomValue(monitoring.overviewAtom(key));
  const next = { key, view, days: input.days };
  const [shown, setShown] = useState(next);
  const { keep, ...displayed } = presentMonitoringOverview(shown, next);
  if (!keep && (shown.key !== key || shown.view !== view)) setShown(next);
  return displayed;
}

export function useMonitoringChats(request: MonitoringChatsRequest) {
  const view = useAtomValue(monitoring.chatsAtom(JSON.stringify(request)));
  const next = { request, view };
  const [shown, setShown] = useState(next);
  const { keep, ...displayed } = presentMonitoringChats(shown, next);
  if (!keep && shown.view !== view) setShown(next);
  return displayed;
}

export const refreshMonitoring = monitoring.refresh;

export function useMonitoringRefresh(key: string | null = null) {
  const registry = useContext(RegistryContext);
  const [current, setCurrent] = useState(() => ({ key, operation: createMonitoringOperation() }));
  const next = current.key === key ? current : { key, operation: createMonitoringOperation() };
  if (next !== current) setCurrent(next);
  const state = useAtomValue(next.operation.state);
  return {
    refreshing: state === "pending",
    timedOut: state === "timed-out",
    run: (refresh: () => Promise<boolean>) => next.operation.run(registry, refresh),
  };
}

export interface MonitoringThreadView {
  readonly detail: MonitoringThreadDetail | null;
  readonly retained: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
}

export function useMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
): MonitoringThreadView {
  const { result, detail, retained } = useAtomValue(
    serverEnvironment.monitoringThreadView(environmentId, threadId),
  );
  return {
    retained,
    detail,
    isPending: result.waiting,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

/** Asks for the chat's analysis again and, as Refresh on the list does, every failure a view read. */
export async function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  const [detail, other] = await Promise.all([
    executeMonitoringQuery(
      appAtomRegistry,
      serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
      environmentId,
      { refresh: true },
    ),
    monitoring.refresh({}),
  ]);
  return monitoringRefreshTimedOut(detail) || other.some(monitoringRefreshTimedOut);
}
