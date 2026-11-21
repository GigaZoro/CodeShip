import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MonitoringOverviewInput,
  MonitoringThreadDetail,
} from "@t3tools/contracts";
import {
  failureRetry,
  keepsShownChats,
  type MonitoringChatOrder,
  type MonitoringChatsRequest,
  type MonitoringChatsView,
  type MonitoringOverviewView,
  type MonitoringRetry,
} from "@t3tools/client-runtime/monitoring";
import { createMonitoringAtoms } from "@t3tools/client-runtime/monitoring/atoms";
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

export function useMonitoringOverview(input: MonitoringOverviewInput): MonitoringOverviewView {
  return useAtomValue(monitoring.overviewAtom(JSON.stringify(input)));
}

/**
 * The chats for `request`. While a new sort, a longer list or a later answer of the same chats
 * loads, the chats on screen stay until it shows as many, and a complete list stays until it is
 * read again whole, so the list does not collapse under the reader; `sortedBy` is their order and
 * `retry` what Retry offers for the failures they name.
 */
export function useMonitoringChats(request: MonitoringChatsRequest): {
  readonly view: MonitoringChatsView;
  readonly updating: boolean;
  readonly retry: MonitoringRetry;
  readonly sortedBy: MonitoringChatOrder;
} {
  const view = useAtomValue(monitoring.chatsAtom(JSON.stringify(request)));
  const next = { request, view };
  const [shown, setShown] = useState(next);
  const keep = keepsShownChats(shown, next);
  if (!keep && shown.view !== view) setShown(next);
  const displayed = keep ? shown.view : view;
  return {
    view: displayed,
    updating: view.awaitingPage,
    retry: failureRetry(displayed, view),
    sortedBy: keep ? shown.request.order : request.order,
  };
}

export const refreshMonitoring = monitoring.refresh;

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

/** Asks for the chat's analysis again and, as Refresh on the list does, every failure a view read. */
export function refreshMonitoringThread(
  environmentId: EnvironmentId,
  threadId: MonitoringThreadDetail["summary"]["threadId"],
) {
  appAtomRegistry.refresh(
    serverEnvironment.monitoringThread({ environmentId, input: { threadId } }),
  );
  monitoring.refresh({});
}
