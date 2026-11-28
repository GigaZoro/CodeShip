import type {
  ThreadIncident,
  ThreadIncidentCause,
  ThreadIncidentKind,
} from "@t3tools/client-runtime/state/thread-incidents";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { CircleAlertIcon, GaugeIcon, WifiOffIcon, type LucideIcon } from "lucide-react";

import { formatProviderDriverKindLabel } from "../../providerModels";
import {
  useEnvironmentConnectionSummaries,
  useEnvironmentProviders,
} from "../../state/environments";
import { t, tn } from "~/i18n";

export interface ThreadIncidentNames {
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly providerName: (
    cause: Extract<ThreadIncidentCause, { providerInstanceId: unknown }>,
  ) => string;
}

export interface ThreadIncidentPresentation {
  readonly icon: LucideIcon;
  /** The cause and how many threads it holds: "VPS offline · 7 threads waiting". */
  readonly summary: string;
  /** Where the cause can be looked at or fixed. */
  readonly to: "/machines" | "/usage" | "/settings/providers";
  readonly actionLabel: string;
}

const ICONS = {
  "machine-offline": WifiOffIcon,
  "usage-limit": GaugeIcon,
  "provider-outage": CircleAlertIcon,
} as const satisfies Record<ThreadIncidentKind, LucideIcon>;

export function presentThreadIncident(
  cause: ThreadIncidentCause,
  count: number,
  names: ThreadIncidentNames,
): ThreadIncidentPresentation {
  const icon = ICONS[cause.kind];
  switch (cause.kind) {
    case "machine-offline":
      return {
        icon,
        summary: tn(
          count,
          "{machine} offline · {count} thread waiting",
          "{machine} offline · {count} threads waiting",
          { machine: names.machineLabel(cause.environmentId) },
        ),
        to: "/machines",
        actionLabel: t("Open machines"),
      };
    case "usage-limit":
      return {
        icon,
        summary: tn(
          count,
          "{provider} usage limit · {count} thread stopped",
          "{provider} usage limit · {count} threads stopped",
          { provider: names.providerName(cause) },
        ),
        to: "/usage",
        actionLabel: t("Open usage"),
      };
    case "provider-outage":
      return {
        icon,
        summary: tn(
          count,
          "{provider} unavailable · {count} thread failed",
          "{provider} unavailable · {count} threads failed",
          { provider: names.providerName(cause) },
        ),
        to: "/settings/providers",
        actionLabel: t("Open providers"),
      };
  }
}

function threadIncidentProviderName(
  providers: ReadonlyArray<ServerProvider> | undefined,
  cause: Extract<ThreadIncidentCause, { providerInstanceId: unknown }>,
): string {
  const provider = providers?.find((entry) => entry.instanceId === cause.providerInstanceId);
  if (provider === undefined) return cause.providerInstanceId;
  return provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver);
}

/** Names the machines and providers incidents point at, as this client knows them now. */
export function threadIncidentNames(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>,
  providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>,
): ThreadIncidentNames {
  return {
    machineLabel: (environmentId) =>
      environments.find((environment) => environment.environmentId === environmentId)
        ?.environmentLabel ?? environmentId,
    providerName: (cause) =>
      threadIncidentProviderName(providersByEnvironment.get(cause.environmentId), cause),
  };
}

export function useThreadIncidentNames(): ThreadIncidentNames {
  return threadIncidentNames(useEnvironmentConnectionSummaries(), useEnvironmentProviders());
}

export function useThreadIncidentPresentation(
  incident: ThreadIncident | null,
): ThreadIncidentPresentation | null {
  const names = useThreadIncidentNames();
  return incident === null
    ? null
    : presentThreadIncident(incident.cause, incident.threadKeys.length, names);
}
