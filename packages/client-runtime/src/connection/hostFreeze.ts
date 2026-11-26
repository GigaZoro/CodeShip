import { msg, t } from "@t3tools/shared/i18n";
import type { ServerEventLoopStall } from "@t3tools/contracts";

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
  resolve: typeof t = t,
): HostFreezeNotice | null {
  if (stall === undefined) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: resolve(msg("{host} froze for {seconds}s"), {
      host: hostLabel,
      seconds: Math.round(stall.durationMs / 1000),
    }),
    description:
      loadAverage !== undefined && loadAverage > cpuCount
        ? resolve(msg("Its CPU is overloaded (load {load} on {cpuCount} cores)."), {
            load: Math.round(loadAverage),
            cpuCount,
          })
        : resolve(msg("T3.CodeShip on {host} was too busy to answer."), { host: hostLabel }),
  };
}
