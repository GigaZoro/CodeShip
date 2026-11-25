import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  limitAccountWorkspaces,
  limitResetTimes,
  type LimitAccountWorkspaces,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { usageClock } from "../clock.ts";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageModelFilter,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { USAGE_HOUR_MS } from "@t3tools/shared/usageFormat";
import { isCompatibleUsageContractVersion, mergeUsage } from "@t3tools/shared/usageMerge";
import { t } from "@t3tools/shared/i18n";

interface UsageProgressEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isConnected: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export function usageEnvironmentProgress(
  environment: UsageProgressEnvironment,
  refreshing = false,
) {
  const { summary } = environment;
  if (!environment.isConnected || environment.error !== null) return { phase: "inactive" } as const;
  if (summary === null) return { phase: "loading" } as const;
  if (refreshing) return { phase: "stale" } as const;
  if (!environment.isPending) return { phase: "ready" } as const;
  const providers = [
    ...new Set(
      summary.sources.flatMap((source) => (source.refreshing ? [source.fingerprint.provider] : [])),
    ),
  ];
  return providers.length > 0
    ? ({ phase: "partway", providers } as const)
    : ({ phase: "stale" } as const);
}

export function updatingProvidersLabel(
  providers: readonly UsageProviderKind[],
  providerLabel: (provider: UsageProviderKind) => string,
) {
  return providers.length === 1
    ? t("Updating {provider}…", { provider: providerLabel(providers[0]!) })
    : t("Updating {count} providers…", { count: providers.length });
}

export function usageProgress(
  environments: readonly UsageProgressEnvironment[],
  {
    refreshingEnvironmentIds,
    providerLabel,
  }: {
    readonly refreshingEnvironmentIds?: ReadonlySet<EnvironmentId>;
    readonly providerLabel: (provider: UsageProviderKind) => string;
  },
) {
  const progress = environments.map((environment) => ({
    label: environment.label,
    ...usageEnvironmentProgress(
      environment,
      refreshingEnvironmentIds?.has(environment.environmentId),
    ),
  }));
  const waiting = progress.filter(({ phase }) => phase === "loading" || phase === "stale");
  const providers = [
    ...new Set(progress.flatMap((entry) => (entry.phase === "partway" ? entry.providers : []))),
  ];
  return {
    announcement: environments.some(({ environmentId }) =>
      refreshingEnvironmentIds?.has(environmentId),
    )
      ? t("Updating…")
      : null,
    label:
      waiting.length === 0
        ? providers.length === 0
          ? null
          : updatingProvidersLabel(providers, providerLabel)
        : environments.length === 1
          ? t("Updating…")
          : waiting.length === 1
            ? t("Updating {label}…", { label: waiting[0]!.label })
            : t("Updating {count} environments…", { count: waiting.length }),
  };
}

export interface EnvironmentUsageStatus extends UsageProgressEnvironment {
  readonly canReadDiagnostics: boolean;
  readonly needsCursorKeychainAccess: boolean;
  readonly readsCursorAccount?: boolean;
  readonly modelFilter?: UsageModelFilter | undefined;
}

export function equalUsageStatuses(
  left: readonly EnvironmentUsageStatus[],
  right: readonly EnvironmentUsageStatus[],
): boolean {
  return (
    left.length === right.length &&
    left.every((env, index) => {
      const other = right[index]!;
      return (
        env.environmentId === other.environmentId &&
        env.label === other.label &&
        env.summary === other.summary &&
        env.isPending === other.isPending &&
        env.isConnected === other.isConnected &&
        env.error === other.error &&
        env.canReadDiagnostics === other.canReadDiagnostics &&
        env.needsCursorKeychainAccess === other.needsCursorKeychainAccess &&
        env.readsCursorAccount === other.readsCursorAccount &&
        JSON.stringify(env.modelFilter) === JSON.stringify(other.modelFilter)
      );
    })
  );
}

export function usageWindowKey(input: UsageSummaryInput): string {
  return JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
}

export function mergeAnsweredUsage(
  environments: readonly Pick<EnvironmentUsageStatus, "environmentId" | "label" | "summary">[],
  keepBucket?: (bucket: UsageBucket) => boolean,
) {
  return mergeUsage(
    environments.flatMap(({ environmentId, label, summary }) =>
      summary === null
        ? []
        : [
            {
              environmentId,
              label,
              summary:
                keepBucket === undefined
                  ? summary
                  : { ...summary, buckets: summary.buckets.filter(keepBucket) },
            },
          ],
    ),
    USAGE_CONTRACT_VERSION,
  );
}

function hasCompatibleUsage({ summary }: EnvironmentUsageStatus): boolean {
  return (
    summary !== null &&
    isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION)
  );
}

function refreshingSources(environment: EnvironmentUsageStatus) {
  return usageScanPending(environment) && hasCompatibleUsage(environment)
    ? environment.summary!.sources.flatMap(({ refreshing, fingerprint }) =>
        refreshing ? [fingerprint.provider] : [],
      )
    : [];
}

export function refreshingUsageProviders(
  environments: readonly EnvironmentUsageStatus[],
  hidden: ReadonlySet<UsageProviderKind> = new Set(),
): ReadonlySet<UsageProviderKind> {
  return new Set(
    environments.flatMap(refreshingSources).filter((provider) => !hidden.has(provider)),
  );
}

function usageScanPending(environment: EnvironmentUsageStatus): boolean {
  return environment.canReadDiagnostics && environment.isConnected && environment.isPending;
}

function usageScanFailed(environment: EnvironmentUsageStatus): boolean {
  return (
    environment.canReadDiagnostics &&
    environment.isConnected &&
    !environment.isPending &&
    environment.error !== null
  );
}

interface UsageRequest {
  readonly window: UsageSummaryInput;
  readonly failedThrough: string | null;
  readonly enabled: boolean;
}

export function nextUsageRequest(
  current: UsageRequest,
  latest: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  active: boolean,
  enabled: boolean,
): UsageRequest {
  if (current.enabled !== enabled) {
    return { window: enabled ? latest : current.window, failedThrough: null, enabled };
  }
  if (!enabled) return current;
  if (active && usagePeriodKey(current.window) !== usagePeriodKey(latest)) {
    return { ...current, window: latest, failedThrough: null };
  }
  if (selected.some(usageScanPending)) {
    return current.failedThrough === null ? current : { ...current, failedThrough: null };
  }
  const tick = usageWindowKey(latest);
  if (current.failedThrough === null && selected.some(usageScanFailed)) {
    return { ...current, failedThrough: tick };
  }
  return active && current.failedThrough !== tick && usageWindowKey(current.window) !== tick
    ? { ...current, window: latest, failedThrough: null }
    : current;
}

export function usagePeriodKey(window: UsageSummaryInput): string {
  const resolution = window.resolution ?? "day";
  const dayMs = 24 * USAGE_HOUR_MS;
  const days =
    resolution === "hour" && window.sinceTime !== undefined && window.untilTime !== undefined
      ? (Date.parse(window.untilTime) - Date.parse(window.sinceTime)) / dayMs
      : (Date.parse(window.untilDay) - Date.parse(window.sinceDay)) / dayMs + 1;
  return JSON.stringify([days, resolution, window.timeZone]);
}

export function usageSelectionKey(
  window: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): string {
  return JSON.stringify([
    usagePeriodKey(window),
    selected
      .map(({ environmentId, modelFilter }) => [environmentId, modelFilter] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    [...hidden].sort(),
  ]);
}

export const usageLimitClockAtom = Atom.family((presentations: Atom.Atom<LimitPresentations>) =>
  Atom.make((get) =>
    JSON.stringify([...new Set(limitResetTimes(get(presentations)))].sort((a, b) => a - b)),
  ).pipe(
    Atom.map((resetTimes) => {
      const times = JSON.parse(resetTimes) as number[];
      return { countdown: usageClock(times), resets: usageClock(times, false) };
    }),
    Atom.withLabel("usage-limit-clock"),
  ),
);

export const usageLimitAccountWorkspacesAtom = Atom.family(
  (presentations: Atom.Atom<LimitPresentations>) =>
    Atom.make((get) =>
      limitAccountWorkspaces(
        get(presentations),
        Option.getOrUndefined(get.self<LimitAccountWorkspaces>()),
      ),
    ).pipe(Atom.withLabel("usage-limit-account-workspaces")),
);
