import type { ServerEventLoopStall } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export interface HostFreezeNotice {
  readonly title: string;
  readonly description: string;
}

/**
 * Says why a host stopped answering, from the recent stall it reports on
 * connect. Web shows it as a toast, mobile in the environment's connection row.
 */
export function hostFreezeNotice(
  hostLabel: string,
  stall: ServerEventLoopStall | undefined,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: t("{hostLabel} froze for {seconds}s", {
      hostLabel,
      seconds: Math.round(stall.durationMs / 1000),
    }),
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? t("Its CPU is overloaded (load {load} on {cpuCount} cores).", {
            load: Math.round(loadAverage),
            cpuCount,
          })
        : t("T3.CodeShip on {hostLabel} was too busy to answer.", { hostLabel }),
  };
}
