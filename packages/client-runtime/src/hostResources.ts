import type {
  DatabaseStorageStatus,
  HostResourcesSnapshot,
  HostSpaceUsage,
} from "@t3tools/contracts";
import { formatBytes } from "@t3tools/shared/formatBytes";
import { t, tn } from "@t3tools/shared/i18n";

export type ResourceTone = "default" | "warning" | "error";

const WARNING_FRACTION = 0.8;
const ERROR_FRACTION = 0.9;

export function resourceTone(fraction: number | null): ResourceTone {
  if (fraction === null) return "default";
  if (fraction >= ERROR_FRACTION) return "error";
  return fraction >= WARNING_FRACTION ? "warning" : "default";
}

export interface ResourceMeter {
  readonly fraction: number;
  readonly usedBytes: number;
  readonly totalBytes: number;
}

function meter(usage: HostSpaceUsage | null | undefined): ResourceMeter | null {
  if (!usage) return null;
  const usedBytes = Math.max(0, usage.totalBytes - usage.availableBytes);
  return {
    fraction: usage.totalBytes > 0 ? usedBytes / usage.totalBytes : 0,
    usedBytes,
    totalBytes: usage.totalBytes,
  };
}

export interface HostResourcesView {
  readonly cpuFraction: number | null;
  readonly cpuCount: number;
  readonly loadAverage: readonly [number, number, number] | null;
  readonly memory: ResourceMeter | null;
  /** Null when the machine does not report swap; zero total when none is in use. */
  readonly swap: ResourceMeter | null;
  readonly disk: ResourceMeter | null;
  readonly uptimeSeconds: number | null;
}

export function presentHostResources(snapshot: HostResourcesSnapshot): HostResourcesView {
  return {
    cpuFraction: snapshot.cpuUtilization,
    cpuCount: snapshot.cpuCount,
    loadAverage: snapshot.loadAverage ?? null,
    memory: meter(
      snapshot.totalMemoryBytes > 0
        ? { totalBytes: snapshot.totalMemoryBytes, availableBytes: snapshot.availableMemoryBytes }
        : null,
    ),
    swap: meter(snapshot.swap),
    disk: meter(snapshot.disk),
    uptimeSeconds: snapshot.uptimeSeconds ?? null,
  };
}

/** "12 cores · Load 4.8 · 8.7 · 15"; the load part is left out where the machine has none. */
export function describeCpu(view: HostResourcesView): string {
  const cores = tn(view.cpuCount, "{count} core", "{count} cores");
  if (view.loadAverage === null) return cores;
  const load = view.loadAverage.map((value) => value.toFixed(value >= 10 ? 0 : 1)).join(" · ");
  return `${cores} · ${t("Load {load}", { load })}`;
}

export function describeUsedSpace(meter: ResourceMeter): string {
  return t("{used} of {total}", {
    used: formatBytes(meter.usedBytes),
    total: formatBytes(meter.totalBytes),
  });
}

export function describeFreeSpace(meter: ResourceMeter): string {
  return t("{free} free of {total}", {
    free: formatBytes(meter.totalBytes - meter.usedBytes),
    total: formatBytes(meter.totalBytes),
  });
}

export function describeDatabaseChange(status: DatabaseStorageStatus): ReadonlyArray<string> {
  const growth = status.dailyGrowthBytes;
  const reclaimable = status.reclaimableBytes + status.fragmentedBytes;
  return [
    growth === null
      ? null
      : growth > 0
        ? t("Grows {size} a day", { size: formatBytes(growth) })
        : growth < 0
          ? t("Shrinks {size} a day", { size: formatBytes(-growth) })
          : t("Size unchanged"),
    reclaimable > 0 ? t("{size} can be reclaimed", { size: formatBytes(reclaimable) }) : null,
  ].filter((detail) => detail !== null);
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return t("{days}d {hours}h", { days, hours });
  if (hours > 0) return t("{hours}h {minutes}m", { hours, minutes });
  return t("{count}m", { count: minutes });
}

export function describeUptime(seconds: number): string {
  return t("Up {duration}", { duration: formatDuration(seconds) });
}
