import { createFileRoute } from "@tanstack/react-router";

import { MonitoringPage } from "../components/monitoring/MonitoringPage";

export interface MonitoringSearch {
  readonly environment?: string;
  readonly thread?: string;
}

export const Route = createFileRoute("/_chat/monitoring")({
  validateSearch: (raw: Record<string, unknown>): MonitoringSearch => ({
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment.slice(0, 200) }
      : {}),
    ...(typeof raw.thread === "string" && raw.thread ? { thread: raw.thread.slice(0, 200) } : {}),
  }),
  component: MonitoringPage,
});
