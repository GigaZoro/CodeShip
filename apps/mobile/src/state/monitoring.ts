import { useAtomValue } from "@effect/atom-react";
import type { MonitoringOverviewInput } from "@t3tools/contracts";
import {
  failureRetry,
  keepsShownChats,
  type MonitoringChatsRequest,
  type MonitoringChatsView,
  type MonitoringOverviewView,
  type MonitoringRetry,
} from "@t3tools/client-runtime/monitoring";
import { createMonitoringAtoms } from "@t3tools/client-runtime/monitoring/atoms";
import { useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

const monitoring = createMonitoringAtoms({
  label: "mobile-monitoring",
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
 * The chats for `request`. While a longer list or a later answer of the same chats loads, the
 * chats on screen stay until it shows as many, and a complete list stays until it is read again
 * whole, so the list does not collapse under the reader; `retry` is what Retry offers for the
 * failures they name.
 */
export function useMonitoringChats(request: MonitoringChatsRequest): {
  readonly view: MonitoringChatsView;
  readonly updating: boolean;
  readonly retry: MonitoringRetry;
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
  };
}

export const refreshMonitoring = monitoring.refresh;
