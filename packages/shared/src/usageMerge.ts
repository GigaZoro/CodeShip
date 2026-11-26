import {
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
  type UsageTokenTotals,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

interface UsageAmounts {
  costUsd: number;
  totalTokens: number;
  records: number;
  unpricedRecords: number;
}

export interface ProviderTotals extends Readonly<UsageAmounts> {
  readonly provider: UsageProviderKind;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals extends Readonly<UsageAmounts> {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly tokens: UsageTokenTotals;
  readonly unpricedTokens: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

/** When every record lacks rates, costUsd is unknown and must not be displayed as a dollar figure. */
export function isUsageCostUnknown(
  usage: Pick<UsageAmounts, "records" | "unpricedRecords">,
): boolean {
  return usage.records > 0 && usage.unpricedRecords >= usage.records;
}

export function usageChartValue(
  usage: Readonly<UsageAmounts> | undefined,
  metric: "tokens" | "cost",
): number | null {
  if (usage === undefined) return 0;
  if (metric === "tokens") return usage.totalTokens;
  return isUsageCostUnknown(usage) ? null : usage.costUsd;
}

export interface DailyTotals extends Readonly<UsageAmounts> {
  readonly day: string;
  readonly byProvider: ReadonlyMap<UsageProviderKind, Readonly<UsageAmounts>>;
}

export interface HourlyTotals extends DailyTotals {
  readonly hourStart: string;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number | null;
}

export interface CategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly unsplit: number;
}

export interface SpeedCost {
  readonly standard: number;
  readonly fast: number;
  readonly ultrafast: number;
  readonly premium: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
}

export interface MergedUsage extends Readonly<UsageAmounts> {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  readonly categoryCost: CategoryCost;
  readonly speedCost: SpeedCost;
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
}

// volumeId distinguishes machines sharing a hostname and home path.
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

// Sources are one directory when either their legacy key or their physicalSourceId matches.
// physicalSourceId joins a directory read natively by Windows and through a WSL mount (path
// and dev:ino both differ); the legacy key still joins installs whose host scopes differ.
export function sourceIdentity(
  fingerprints: Iterable<UsageSourceFingerprint>,
): (fingerprint: UsageSourceFingerprint) => string {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const next = parent.get(key);
    if (next === undefined || next === key) return key;
    const root = find(next);
    parent.set(key, root);
    return root;
  };
  for (const fingerprint of fingerprints) {
    if (fingerprint.physicalSourceId === undefined) continue;
    const legacy = find(fingerprintKey(fingerprint));
    const physical = find(`\u0000${fingerprint.provider}\u0000${fingerprint.physicalSourceId}`);
    if (legacy !== physical) parent.set(legacy, physical);
  }
  return (fingerprint) => find(fingerprintKey(fingerprint));
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

function claimSources(
  environments: readonly EnvironmentUsage[],
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly ownerScanByFingerprint: ReadonlyMap<string, { readonly source: UsageSource }>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<UsageBucket>>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
} {
  const ownerScanByFingerprint = new Map<
    string,
    { environment: EnvironmentUsage; source: UsageSource }
  >();
  const seenBucketKeysByFingerprint = new Map<string, Set<string>>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort(
    (a, b) =>
      (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) ||
      a.environmentId.localeCompare(b.environmentId),
  );

  for (const status of ["ok", "partial", "failed"] as const) {
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = sourceKey(source.fingerprint);
        if (ownerScanByFingerprint.has(key)) {
          duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
          continue;
        }
        ownerScanByFingerprint.set(key, { environment, source });
        sessionsByFingerprint.set(key, source.distinctSessions);
      }
    }
  }

  // Keep cells unique to newer partial scans; aggregates cannot reconcile overlapping records without double-counting.
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      const key = sourceKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      // A scan under another model filter counts different records, so its cells are not missing ones.
      if (
        owner?.source.status !== "ok" ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt) ||
        JSON.stringify(environment.summary.modelFilter) !==
          JSON.stringify(owner.environment.summary.modelFilter)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental =
        supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set<UsageBucket>();
      let added = false;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        const cell = bucketKey(bucket);
        if (seen.has(cell)) continue;
        seen.add(cell);
        supplemental.add(bucket);
        added = true;
      }
      if (!added) continue;
      supplementalBucketsByEnvironment.set(environment.environmentId, supplemental);
      sessionsByFingerprint.set(
        key,
        Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
      );
    }
  }

  return {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  };
}

function ownedContribution(
  environment: EnvironmentUsage,
  ownerScanByFingerprint: ReadonlyMap<string, { readonly source: UsageSource }>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsByFingerprint: ReadonlyMap<string, number>,
  sourceKey: (fingerprint: UsageSourceFingerprint) => string,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = sourceKey(source.fingerprint);
    // By source, not environment: one server can reach a directory through two
    // mounts, and only the winning reading may count.
    if (ownerScanByFingerprint.get(key)?.source === source) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
      // Count distinct sessions per directory; bucket sums overcount sessions spanning days/models.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter(
      (bucket) =>
        supplementalBuckets.has(bucket) ||
        (bucket.sourcePath === undefined
          ? ownedProviders.has(bucket.provider)
          : ownedSources.has(`${bucket.provider}\u0000${bucket.sourcePath}`)),
    ),
    sessionsByProvider,
  };
}

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  unpricedRecords: 0,
  sessions: 0,
  providers: [],
  models: [],
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
  speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
};

function emptyUsageAmounts(): UsageAmounts {
  return { costUsd: 0, totalTokens: 0, records: 0, unpricedRecords: 0 };
}

function addUsageAmounts(amounts: UsageAmounts, bucket: UsageBucket, tokens: number) {
  amounts.costUsd += bucket.costUsd;
  amounts.totalTokens += tokens;
  amounts.records += bucket.records;
  amounts.unpricedRecords += bucket.unpricedRecords;
}

type PeriodAmounts = UsageAmounts & {
  day: string;
  byProvider: Map<UsageProviderKind, UsageAmounts>;
};

function addPeriodUsage(
  periods: Map<string, PeriodAmounts>,
  key: string,
  bucket: UsageBucket,
  tokens: number,
) {
  let period = periods.get(key);
  if (!period) {
    period = { ...emptyUsageAmounts(), day: bucket.day, byProvider: new Map() };
    periods.set(key, period);
  }
  addUsageAmounts(period, bucket, tokens);
  const provider = period.byProvider.get(bucket.provider) ?? emptyUsageAmounts();
  addUsageAmounts(provider, bucket, tokens);
  period.byProvider.set(bucket.provider, provider);
}

export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const sourceKey = sourceIdentity(
    current.flatMap((environment) =>
      environment.summary.sources.map((source) => source.fingerprint),
    ),
  );
  const {
    ownerScanByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  } = claimSources(current, sourceKey);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let hasPricedCacheReads = false;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };

  const providerAccumulator = new Map<UsageProviderKind, UsageAmounts & { sessions: number }>();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      tokens: UsageTokenTotals;
      records: number;
      unpricedRecords: number;
      unpricedTokens: number;
    }
  >();
  const dailyAccumulator = new Map<string, PeriodAmounts>();
  const hourlyAccumulator = new Map<string, PeriodAmounts>();
  const contributingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const { buckets, sessionsByProvider } = ownedContribution(
      environment,
      ownerScanByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsByFingerprint,
      sourceKey,
    );
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

    for (const [providerKind, providerSessions] of sessionsByProvider) {
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        ...emptyUsageAmounts(),
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      // Older servers sent only the savings subtotal. A provider-reported cost can lack token rates.
      hasPricedCacheReads ||=
        bucket.pricedCacheReadTokens !== undefined
          ? bucket.pricedCacheReadTokens > 0
          : bucket.totals.cachedInputTokens > 0 &&
            (bucket.cacheSavingsUsd !== 0 ||
              bucket.categoryCostUsd !== undefined ||
              (bucket.costSource === "modelPriced" && bucket.unpricedRecords === 0));
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        ...emptyUsageAmounts(),
        sessions: 0,
      };
      addUsageAmounts(provider, bucket, tokens);
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      addUsageAmounts(model, bucket, tokens);
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.unpricedTokens !== undefined) {
        model.unpricedTokens += bucket.unpricedTokens;
      } else if (bucket.records > 0) {
        model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      }
      modelAccumulator.set(modelKey, model);

      addPeriodUsage(dailyAccumulator, bucket.day, bucket, tokens);
      if (bucket.hourStart !== undefined) {
        addPeriodUsage(hourlyAccumulator, bucket.hourStart, bucket, tokens);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      ...totals,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      tokens: totals.tokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      unpricedTokens: totals.unpricedTokens,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  const hourly: HourlyTotals[] = [...hourlyAccumulator]
    .map(([hourStart, totals]) => ({
      hourStart,
      ...totals,
    }))
    .sort((a, b) => a.hourStart.localeCompare(b.hourStart));

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    unpricedRecords,
    sessions,
    providers,
    models,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd: cachedInputTokens === 0 || hasPricedCacheReads ? cacheSavingsUsd : null,
    },
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd -
          categoryCost.input -
          categoryCost.cacheRead -
          categoryCost.cacheWrite -
          categoryCost.output,
      ),
    },
    speedCost: {
      ...speedCost,
      standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast),
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
  };
}
