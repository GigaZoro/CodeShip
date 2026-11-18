import type { MonitoringFindingSeverity } from "@t3tools/contracts";

export const SEVERITY_BADGE_VARIANT = {
  high: "error",
  medium: "warning",
  low: "info",
} as const satisfies Record<MonitoringFindingSeverity, "error" | "warning" | "info">;
