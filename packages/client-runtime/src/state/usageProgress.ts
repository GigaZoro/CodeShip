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
import {
  USAGE_HOUR_MS,
  formatUsageContractMismatch,
  usageSourceMessages,
  usageWindowLabel,
} from "@t3tools/shared/usageFormat";
import {
  isCompatibleUsageContractVersion,
  mergeUsage,
  type MergedUsage,
  type ProviderTotals,
} from "@t3tools/shared/usageMerge";
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

interface EnvironmentReading {
  readonly environment: EnvironmentUsageStatus;
  readonly window: UsageSummaryInput;
  readonly requestKey: string;
  readonly reservations: ReadonlySet<UsageProviderKind>;
  readonly hidden: readonly UsageProviderKind[];
}
export type UsageReadings = ReadonlyMap<EnvironmentId, EnvironmentReading>;
const NO_READINGS: UsageReadings = new Map();

function environmentRequestKey(
  window: UsageSummaryInput,
  env: EnvironmentUsageStatus,
  hidden: readonly UsageProviderKind[],
) {
  return JSON.stringify([usagePeriodKey(window), env.modelFilter, [...hidden].sort()]);
}

export function settleUsageReadings(
  previous: UsageReadings | undefined,
  window: UsageSummaryInput,
  environments: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): UsageReadings {
  const readings = new Map<EnvironmentId, EnvironmentReading>();
  for (const env of environments) {
    if (!env.canReadDiagnostics || !env.isConnected) continue;
    const saved = previous?.get(env.environmentId);
    if (!hasCompatibleUsage(env)) {
      if (saved) readings.set(env.environmentId, saved);
      continue;
    }
    const requestKey = environmentRequestKey(window, env, hidden);
    const sameRequest = saved?.requestKey === requestKey;
    const oldReservations = sameRequest ? saved.reservations : new Set<UsageProviderKind>();
    const adding = refreshingSources(env).filter(
      (provider) => !hidden.includes(provider) && !oldReservations.has(provider),
    );
    const reservations = adding.length ? new Set([...oldReservations, ...adding]) : oldReservations;
    // A provisional follow-up can reserve rows, but cannot replace a completed reading for the same period.
    if (sameRequest && env.isPending && !saved.environment.isPending) {
      readings.set(
        env.environmentId,
        reservations === oldReservations ? saved : { ...saved, reservations },
      );
    } else if (
      sameRequest &&
      reservations === oldReservations &&
      usageWindowKey(saved.window) === usageWindowKey(window) &&
      equalUsageStatuses([saved.environment], [env])
    ) {
      readings.set(env.environmentId, saved);
    } else {
      readings.set(env.environmentId, {
        environment: env,
        window,
        requestKey,
        reservations,
        hidden,
      });
    }
  }
  const old = previous ?? NO_READINGS;
  return old.size === readings.size &&
    [...readings].every(([id, reading]) => old.get(id) === reading)
    ? old
    : readings;
}

export interface UsageSnapshot {
  readonly key: string;
  readonly window: UsageSummaryInput;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: ReturnType<typeof mergeAnsweredUsage>;
  readonly hasAnswer: boolean;
  readonly providers: readonly UsageProviderRow[];
  readonly readings: UsageReadings;
  readonly settled: boolean;
}

export interface UsageProviderRow {
  readonly provider: UsageProviderKind;
  readonly totals: ProviderTotals | null;
}

function providersWithReservations(
  active: readonly UsageProviderRow[],
  readings: UsageReadings,
): readonly UsageProviderRow[] {
  const represented = new Set(active.map(({ provider }) => provider));
  const reserved = new Set([...readings.values()].flatMap(({ reservations }) => [...reservations]));
  return [
    ...active,
    ...[...reserved].flatMap((provider) =>
      represented.has(provider) ? [] : [{ provider, totals: null }],
    ),
  ];
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

interface UsageScanFailure {
  readonly requestKey: string;
  readonly message: string;
  readonly summary: UsageSummary | null;
}

export interface UsageScanFailures {
  readonly errors: ReadonlyMap<EnvironmentId, UsageScanFailure>;
}

export function settleUsageScanFailures(
  previous: UsageScanFailures | null,
  window: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): UsageScanFailures {
  const previousErrors = previous?.errors;
  const errors = new Map<EnvironmentId, UsageScanFailure>();
  for (const environment of selected) {
    if (!environment.canReadDiagnostics) continue;
    const requestKey = environmentRequestKey(window, environment, hidden);
    const entry = previousErrors?.get(environment.environmentId);
    const saved = entry?.requestKey === requestKey ? entry : undefined;
    const { error, summary } = environment;
    if (usageScanFailed(environment) && error !== null) {
      errors.set(
        environment.environmentId,
        saved?.message === error && saved.summary === summary
          ? saved
          : { requestKey, message: error, summary },
      );
    } else if (
      saved !== undefined &&
      (!environment.isConnected ||
        (environment.isPending && (!hasCompatibleUsage(environment) || summary === saved.summary)))
    ) {
      errors.set(environment.environmentId, saved);
    }
  }
  if (
    previousErrors?.size === errors.size &&
    [...errors].every(([id, error]) => previousErrors.get(id) === error)
  )
    return previous!;
  return { errors };
}

export function waitingForFirstUsage(
  selected: readonly EnvironmentUsageStatus[],
  failures: UsageScanFailures | null,
) {
  return selected.some(
    (env) =>
      env.isConnected &&
      env.isPending &&
      env.summary === null &&
      env.error === null &&
      !failures?.errors.has(env.environmentId),
  );
}

export function settleUsageSnapshot(
  previous: UsageSnapshot | null,
  window: UsageSummaryInput,
  environments: readonly EnvironmentUsageStatus[],
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
  readings = settleUsageReadings(previous?.readings, window, environments, hidden),
): UsageSnapshot | null {
  if (selected.length === 0) return null;
  const key = usageSelectionKey(window, selected, hidden);
  const bounds = usageWindowKey(window);
  const available = new Map<EnvironmentId, EnvironmentReading>();
  const current = new Map<EnvironmentId, EnvironmentReading>();
  for (const env of selected) {
    const reading = readings.get(env.environmentId);
    if (!reading) continue;
    available.set(env.environmentId, reading);
    if (
      usageWindowKey(reading.window) === bounds &&
      reading.requestKey === environmentRequestKey(window, env, hidden)
    )
      current.set(env.environmentId, reading);
  }
  const pending = selected.some(
    (env) => env.isConnected && env.isPending && (env.canReadDiagnostics || env.error === null),
  );
  const prior = previous && retainUsageSnapshot(previous, selected);
  // Never combine an old contributor's figures with another contributor's new hourly range.
  if (
    prior &&
    (current.size === 0 ||
      (prior.key === key && current.size < available.size) ||
      (pending &&
        (prior.key === key
          ? prior.settled
          : selected.some((env) => env.isPending && !env.summary))))
  ) {
    let updated: Map<EnvironmentId, EnvironmentReading> | undefined;
    for (const [id, reading] of available) {
      const saved = prior.readings.get(id);
      if (
        !reading.reservations.size ||
        reading.reservations === saved?.reservations ||
        prior.key !== key
      )
        continue;
      updated ??= new Map(prior.readings);
      updated.set(id, saved ? { ...saved, reservations: reading.reservations } : reading);
    }
    return updated
      ? {
          ...prior,
          readings: updated,
          providers: providersWithReservations(
            prior.providers.filter((row) => row.totals !== null),
            updated,
          ),
        }
      : prior;
  }

  const first = current.values().next().value ?? available.values().next().value;
  if (!first && waitingForFirstUsage(selected, null)) return null;
  const shownWindow = first?.window ?? window;
  const displayed =
    current.size || !first
      ? current
      : new Map(
          [...available].filter(
            ([, reading]) => usageWindowKey(reading.window) === usageWindowKey(shownWindow),
          ),
        );
  const represented = selected.map((env) => {
    const saved = displayed.get(env.environmentId);
    if (saved) return saved.environment;
    return hasCompatibleUsage(env) ? { ...env, summary: null } : env;
  });
  const shownHidden = first?.hidden ?? hidden;
  const shownKey = usageSelectionKey(shownWindow, represented, shownHidden);
  if (
    previous &&
    previous.key === shownKey &&
    previous.settled === !pending &&
    usageWindowKey(previous.window) === usageWindowKey(shownWindow) &&
    equalUsageStatuses(previous.environments, represented) &&
    displayed.size === previous.readings.size &&
    [...displayed].every(([id, reading]) => previous.readings.get(id) === reading)
  )
    return previous;
  return buildUsageSnapshot({
    key: shownKey,
    window: shownWindow,
    environments: represented,
    readings: displayed,
    hiddenProviders: new Set(shownHidden),
    settled: !pending,
  });
}

function buildUsageSnapshot(
  snapshot: Pick<
    UsageSnapshot,
    "key" | "window" | "hiddenProviders" | "environments" | "readings" | "settled"
  >,
): UsageSnapshot {
  const { hiddenProviders, environments, readings } = snapshot;
  const merged = mergeAnsweredUsage(
    hiddenProviders.size === 0
      ? environments
      : environments.map((environment) =>
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
  const active = merged.providers
    .filter(
      ({ costUsd, totalTokens, sessions, records }) =>
        costUsd > 0 || totalTokens > 0 || sessions > 0 || records > 0,
    )
    .map((totals) => ({ provider: totals.provider, totals }));
  return {
    ...snapshot,
    merged,
    hasAnswer: environments.some(hasCompatibleUsage),
    providers: providersWithReservations(active, readings),
  };
}

export function retainUsageSnapshot(
  snapshot: UsageSnapshot,
  environments: readonly EnvironmentUsageStatus[],
): UsageSnapshot | null {
  if (!snapshot.hasAnswer) return null;
  const readable = new Set(
    environments
      .filter(({ canReadDiagnostics, isConnected }) => canReadDiagnostics && isConnected)
      .map(({ environmentId }) => environmentId),
  );
  const retained = snapshot.environments.filter(({ environmentId }) => readable.has(environmentId));
  if (!retained.some(hasCompatibleUsage)) return null;
  const readings = new Map([...snapshot.readings].filter(([id]) => readable.has(id)));
  if (retained.length === snapshot.environments.length && readings.size === snapshot.readings.size)
    return snapshot;
  return buildUsageSnapshot({
    ...snapshot,
    environments: retained,
    readings,
  });
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

export function usageNotices(
  live: readonly EnvironmentUsageStatus[],
  represented: readonly EnvironmentUsageStatus[],
  failures: UsageScanFailures | null,
  hidden: ReadonlySet<UsageProviderKind> = new Set(),
) {
  const contractMismatches = live.flatMap(({ environmentId, summary }) => {
    if (
      summary === null ||
      isCompatibleUsageContractVersion(summary.contractVersion, USAGE_CONTRACT_VERSION)
    )
      return [];
    return [
      {
        environmentId,
        direction:
          summary.contractVersion < USAGE_CONTRACT_VERSION
            ? ("serverBehind" as const)
            : ("clientBehind" as const),
        contractVersion: summary.contractVersion,
      },
    ];
  });
  const sourceMessages = usageSourceMessages(
    live.flatMap((environment) =>
      hasCompatibleUsage(environment)
        ? (environment.summary?.sources ?? []).filter(
            ({ fingerprint }) => !hidden.has(fingerprint.provider),
          )
        : [],
    ),
  );
  return {
    contractMismatches,
    sourceMessages,
    coverage: usageGaps(
      live.map((status) => ({
        ...status,
        error:
          !status.canReadDiagnostics || !status.isConnected
            ? status.error
            : (failures?.errors.get(status.environmentId)?.message ?? null),
      })),
      contractMismatches,
      represented,
    ),
  };
}

export function isKeptUsage(
  snapshot: UsageSnapshot | null,
  window: UsageSummaryInput,
  selected: readonly EnvironmentUsageStatus[],
  hidden: readonly UsageProviderKind[] = [],
): boolean {
  return snapshot !== null && snapshot.key !== usageSelectionKey(window, selected, hidden);
}

function usagePeriodKey(window: UsageSummaryInput): string {
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
  represented = environments,
) {
  const mismatchById = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const gaps = environments.flatMap((environment) => {
    const mismatch = mismatchById.get(environment.environmentId);
    const stale = represented.some(
      (entry) => entry.environmentId === environment.environmentId && hasCompatibleUsage(entry),
    );
    const error =
      mismatch === undefined
        ? usageEnvironmentError(environment)
        : formatUsageContractMismatch(environment.label, mismatch, stale);
    if (error === null) return [];
    return [
      {
        environment,
        message:
          mismatch !== undefined
            ? error
            : stale
              ? t("{environment}: {error} Showing its last values.", {
                  environment: environment.label,
                  error,
                })
              : t("{environment}: {error}", { environment: environment.label, error }),
        excluded: !stale,
        retryable:
          mismatch === undefined && environment.canReadDiagnostics && environment.isConnected,
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
