import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  monitoringDetailReconnects,
  presentMonitoringChats,
  presentMonitoringOverview,
  threadDetailOf,
  type MonitoringChatsRequest,
} from "@t3tools/client-runtime/monitoring";
import {
  createMonitoringAtoms,
  executeMonitoringQuery,
} from "@t3tools/client-runtime/monitoring/atoms";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

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

export interface MonitoringThreadView {
  readonly detail: MonitoringThreadDetail | null;
  readonly reconnecting: boolean;
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
  const ready =
    useAtomValue(environmentPresentations.presentationsAtom).get(environmentId)?.connection
      .phase === "connected";
  const [wasReconnecting, setWasReconnecting] = useState(!ready);
  const reconnecting = monitoringDetailReconnects(ready, wasReconnecting, result.waiting);
  if (reconnecting !== wasReconnecting) setWasReconnecting(reconnecting);
  return {
    reconnecting,
    detail: threadDetailOf(AsyncResult.getOrElse(result, () => null)),
    isPending: result.waiting,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

/** Asks for the chat's analysis again and, as Refresh on the list does, every failure a view read. */
export function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  return Promise.all([
    executeMonitoringQuery(
      appAtomRegistry,
      serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
      environmentId,
      { refresh: true },
    ),
    monitoring.refresh({}),
  ]);
}
