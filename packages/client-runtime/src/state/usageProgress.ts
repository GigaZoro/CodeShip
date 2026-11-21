import { Atom } from "effect/reactivity";
import { limitResetTimes, type LimitPresentations } from "@t3tools/shared/usageLimits";
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
import { formatUsageContractMismatch, usageWindowLabel } from "@t3tools/shared/usageFormat";
import {
  isCompatibleUsageContractVersion,
  mergeUsage,
  type MergedUsage,
  type ProviderTotals,
} from "@t3tools/shared/usageMerge";
import { t } from "@t3tools/shared/i18n";

interface UsageProgressEnvironment {
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
    refreshing = false,
    providerLabel,
  }: {
    readonly refreshing?: boolean;
    readonly providerLabel: (provider: UsageProviderKind) => string;
  },
) {
  const progress = environments.map((environment) => ({
    label: environment.label,
    ...usageEnvironmentProgress(environment, refreshing),
  }));
  const waiting = progress.filter(({ phase }) => phase === "loading" || phase === "stale");
  const providers = [
    ...new Set(progress.flatMap((entry) => (entry.phase === "partway" ? entry.providers : []))),
  ];
  return {
    announcement: refreshing ? t("Updating…") : null,
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
  readonly environmentId: EnvironmentId;
  readonly canReadDiagnostics: boolean;
  readonly needsCursorKeychainAccess: boolean;
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
  environments: readonly EnvironmentUsageStatus[],
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

export function refreshingUsageProviders(
  environments: readonly EnvironmentUsageStatus[],
  hidden: ReadonlySet<UsageProviderKind> = new Set(),
): ReadonlySet<UsageProviderKind> {
  return new Set(
    environments.flatMap((environment) =>
      environment.isConnected && environment.isPending && hasCompatibleUsage(environment)
        ? (environment.summary?.sources ?? []).flatMap(
            ({ refreshing, fingerprint: { provider } }) =>
              refreshing && !hidden.has(provider) ? [provider] : [],
          )
        : [],
    ),
  );
}

export interface UsageSnapshot {
  readonly key: string;
  readonly window: UsageSummaryInput;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: ReturnType<typeof mergeAnsweredUsage>;
  readonly hasAnswer: boolean;
  readonly providers: readonly ProviderTotals[];
  readonly reservedProviders: ReadonlySet<UsageProviderKind>;
}

export function settleUsageSnapshot(
  previous: UsageSnapshot | null,
  window: UsageSummaryInput,
  environments: readonly EnvironmentUsageStatus[],
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): UsageSnapshot | null {
  if (selected.length === 0) return null;
  const key = usageSelectionKey(window, selected, hidden);
  if (previous?.key === key && equalUsageStatuses(previous.environments, selected)) return previous;

  const kept =
    previous?.hasAnswer &&
    previous.environments.every(
      (environment) =>
        !hasCompatibleUsage(environment) ||
        environments.some(
          (current) =>
            current.environmentId === environment.environmentId && current.canReadDiagnostics,
        ),
    )
      ? previous
      : null;
  const keepDuringRefresh =
    kept?.key === key && refreshingUsageProviders(kept.environments).size === 0;
  if (
    selected.some(
      ({ summary, isConnected, isPending, error }) =>
        error === null && isConnected && isPending && (summary === null || keepDuringRefresh),
    )
  )
    return kept;

  const hiddenProviders = new Set(hidden);
  const merged = mergeAnsweredUsage(
    hiddenProviders.size === 0
      ? selected
      : selected.map((environment) =>
          environment.summary === null
            ? environment
            : {
                ...environment,
                summary: {
                  ...environment.summary,
                  buckets: environment.summary.buckets.filter(
                    (bucket) => !hiddenProviders.has(bucket.provider),
                  ),
                  sources: environment.summary.sources.filter(
                    (source) => !hiddenProviders.has(source.fingerprint.provider),
                  ),
                },
              },
        ),
  );
  const reservedProviders = new Set([
    ...(kept?.key === key ? kept.reservedProviders : []),
    ...refreshingUsageProviders(selected, hiddenProviders),
  ]);
  const active = merged.providers.filter(
    ({ costUsd, totalTokens, sessions }) => costUsd > 0 || totalTokens > 0 || sessions > 0,
  );
  const represented = new Set(active.map(({ provider }) => provider));
  const providers = [
    ...active,
    ...[...reservedProviders].flatMap((provider) =>
      represented.has(provider)
        ? []
        : [
            {
              provider,
              costUsd: 0,
              totalTokens: 0,
              records: 0,
              sessions: 0,
              costShare: 0,
              tokenShare: 0,
            },
          ],
    ),
  ];
  return {
    key,
    window,
    hiddenProviders,
    environments: selected,
    merged,
    hasAnswer: selected.some(hasCompatibleUsage),
    providers,
    reservedProviders,
  };
}

export function usageCoverageEnvironments(
  represented: readonly EnvironmentUsageStatus[],
  live: readonly EnvironmentUsageStatus[],
): readonly EnvironmentUsageStatus[] {
  return represented.map((environment) => {
    const current = live.find(({ environmentId }) => environmentId === environment.environmentId);
    return current === undefined || current === environment
      ? environment
      : { ...current, summary: environment.summary };
  });
}

export function isKeptUsage(
  snapshot: UsageSnapshot | null,
  window: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): boolean {
  return snapshot !== null && snapshot.key !== usageSelectionKey(window, selected, hidden);
}

function usageSelectionKey(
  window: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[],
): string {
  return JSON.stringify([
    usageWindowKey(window),
    selected
      .map(({ environmentId, modelFilter }) => [environmentId, modelFilter] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    [...hidden].sort(),
  ]);
}

export function retainedUsageLabel(snapshot: UsageSnapshot, hour12?: boolean): string {
  return t("Showing previous usage for {environments} · {period}", {
    environments: snapshot.environments
      .filter(hasCompatibleUsage)
      .map(({ label }) => label)
      .join(", "),
    period: usageWindowLabel(snapshot.window, hour12),
  });
}

export function usageEnvironmentError(environment: EnvironmentUsageStatus): string | null {
  return (
    environment.error ?? (environment.isConnected ? null : t("This environment is not connected."))
  );
}

export function usageGaps(
  environments: readonly EnvironmentUsageStatus[],
  contractMismatches: MergedUsage["contractMismatches"],
) {
  const mismatchById = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const gaps = environments.flatMap((environment) => {
    const mismatch = mismatchById.get(environment.environmentId);
    if (mismatch !== undefined) {
      return [
        {
          environment,
          message: formatUsageContractMismatch(environment.label, mismatch),
          excluded: true,
          retryable: false,
        },
      ];
    }
    const error = usageEnvironmentError(environment);
    if (error === null) return [];
    const stale = environment.summary !== null;
    return [
      {
        environment,
        message: stale
          ? t("{environment}: {error} Showing its last values.", {
              environment: environment.label,
              error,
            })
          : t("{environment}: {error}", { environment: environment.label, error }),
        excluded: !stale,
        retryable: environment.canReadDiagnostics && environment.isConnected,
      },
    ];
  });
  if (gaps.length === 0) return null;
  const excluded = gaps.filter((gap) => gap.excluded);
  const title =
    excluded.length === 0
      ? t("Some totals may be out of date")
      : excluded.length === 1
        ? t("Totals leave out {environment}", { environment: excluded[0]!.environment.label })
        : t("Totals leave out {count} environments", { count: excluded.length });
  return { title, gaps };
}

export const usageLimitClockAtom = Atom.family((presentations: Atom.Atom<LimitPresentations>) =>
  Atom.make((get) =>
    JSON.stringify([...new Set(limitResetTimes(get(presentations)))].sort((a, b) => a - b)),
  ).pipe(
    Atom.map((resetTimes) => usageClock(JSON.parse(resetTimes) as number[])),
    Atom.withLabel("usage-limit-clock"),
  ),
);
