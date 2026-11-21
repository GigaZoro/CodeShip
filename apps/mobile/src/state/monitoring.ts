import { useAtomValue } from "@effect/atom-react";
import type { MonitoringOverviewInput } from "@t3tools/contracts";
import {
  presentMonitoringChats,
  presentMonitoringOverview,
  type MonitoringChatsRequest,
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
