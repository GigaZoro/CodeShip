import type {
  EnvironmentId,
  MonitoringBreakdownGroup,
  MonitoringChatRow,
  MonitoringChatSort,
  MonitoringCommandPhase,
  MonitoringDurationSketch,
  MonitoringFindingCode,
  MonitoringFindingSeverity,
  MonitoringOverviewInput,
  MonitoringOverviewResult,
  MonitoringThreadDetail,
  MonitoringThreadKind,
  MonitoringTimeBuckets,
  ProjectId,
} from "@t3tools/contracts";
import {
  compareFindingRollups,
  compareMonitoringChatRows,
  durationQuantile,
  mergeDurationSketches,
  moreSevere,
  TIME_BUCKET_KEYS,
  topMonitoringOutliers,
  type TimeBucketKey,
} from "@t3tools/shared/monitoring";

/** A listed chat and the environment that analyzed it; thread ids are only unique per environment. */
export interface MonitoringChat {
  readonly environmentId: string;
  readonly row: MonitoringChatRow;
}

/** What one connected environment reported for the overview. */
export interface MonitoringEnvironmentReport {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  /** The last answer, kept while the environment refreshes. */
  readonly result: MonitoringOverviewResult | null;
  /** The chosen project belongs to another environment, so only this answer's filter options count. */
  readonly optionsOnly: boolean;
}

/**
 * What one environment is asked. A project belongs to one environment, so the others answer
 * without the project filter and keep their projects in the filter options.
 */
export function monitoringEnvironmentInput(
  input: MonitoringOverviewInput,
  projectEnvironmentId: EnvironmentId | null,
  environmentId: EnvironmentId,
): { readonly input: MonitoringOverviewInput; readonly optionsOnly: boolean } {
  if (projectEnvironmentId === null || projectEnvironmentId === environmentId) {
    return { input, optionsOnly: false };
  }
  const { projectId: _projectId, ...unscoped } = input;
  return { input: unscoped, optionsOnly: true };
}

const WORKING_BUCKETS: ReadonlySet<TimeBucketKey> = new Set(["agentMs", "commandMs", "toolMs"]);

const COMMAND_PHASE_ORDER = [
  "install",
  "build",
  "typecheck",
  "lint",
  "format",
  "test",
  "git",
  "ship",
  "inspect",
  "run",
  "other",
] as const satisfies ReadonlyArray<MonitoringCommandPhase>;

/** The chat's own model, or the label for a chat that ran none. */
export const NO_MODEL = "";

const chatKey = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;
export const projectKey = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

export interface MonitoringProjectOption {
  /** Its {@link projectKey}. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export const monitoringChatKey = (chat: MonitoringChat) =>
  chatKey(chat.environmentId, chat.row.threadId);

export interface MonitoringTotals {
  readonly chats: number;
  readonly lifetimeMs: number;
  readonly activeMs: number;
  readonly medianLifetimeMs: number;
  readonly medianActiveMs: number;
  /** Time agents were working (model, commands, tools). */
  readonly workingMs: number;
  /** Working time as a share of lifetime, 0 to 1; 0 with no lifetime. */
  readonly workingShare: number;
  readonly costUsd: number;
  readonly unpricedTurns: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** cachedInput / input, 0 to 1; null when no input was counted. */
  readonly cacheReuse: number | null;
  readonly runs: number;
  readonly failedRuns: number;
  readonly userPrompts: number;
  readonly helpers: number;
  readonly findings: number;
}

export interface MonitoringPhaseTotal {
  readonly phase: MonitoringCommandPhase;
  readonly count: number;
  readonly failed: number;
  /** failed / count, 0 to 1. */
  readonly failureRate: number;
  readonly durationMs: number;
  readonly averageMs: number;
}

export interface MonitoringDayPoint {
  readonly day: string;
  readonly chats: number;
  readonly medianLifetimeMs: number;
  readonly p90LifetimeMs: number;
  readonly activeMs: number;
  readonly costUsd: number;
}

export interface MonitoringBreakdownRow {
  readonly key: string;
  readonly chats: number;
  readonly medianLifetimeMs: number;
  readonly medianActiveMs: number;
  readonly costUsd: number;
  readonly findings: number;
}

export interface MonitoringFindingRank {
  readonly code: MonitoringFindingCode;
  readonly chats: number;
  readonly occurrences: number;
  readonly wastedMs: number;
  readonly severity: MonitoringFindingSeverity;
}

export interface MonitoringOutliers {
  readonly slowest: ReadonlyArray<MonitoringChat>;
  readonly mostExpensive: ReadonlyArray<MonitoringChat>;
  readonly mostFailures: ReadonlyArray<MonitoringChat>;
}

export interface MonitoringOverviewView {
  /** The environments the figures come from. */
  readonly environments: ReadonlyArray<MonitoringEnvironmentReport>;
  /** Some environment is connected, even when none of them holds the chosen project. */
  readonly connected: boolean;
  readonly pendingAnalysis: number;
  readonly failedAnalysis: number;
  /** No environment has answered yet. */
  readonly isLoading: boolean;
  /** Every connected environment failed. */
  readonly failed: boolean;
  readonly totals: MonitoringTotals;
  readonly time: MonitoringTimeBuckets;
  readonly phases: ReadonlyArray<MonitoringPhaseTotal>;
  readonly findings: ReadonlyArray<MonitoringFindingRank>;
  /** One point per day of the period, oldest first. */
  readonly days: ReadonlyArray<MonitoringDayPoint>;
  readonly breakdowns: {
    /** Keys are {@link projectKey} values. */
    readonly projects: ReadonlyArray<MonitoringBreakdownRow>;
    readonly kinds: ReadonlyArray<MonitoringBreakdownRow>;
    /** Keys are the chat's main model, or {@link NO_MODEL}. */
    readonly models: ReadonlyArray<MonitoringBreakdownRow>;
  };
  readonly outliers: MonitoringOutliers;
  /** The first chats of the list across environments, in the requested order. */
  readonly chats: ReadonlyArray<MonitoringChat>;
  /** Chats the list holds in all, which may exceed `chats`. */
  readonly listedChats: number;
  /** Every connected environment's choices, whatever the filters. */
  readonly options: {
    readonly projects: ReadonlyArray<MonitoringProjectOption>;
    readonly kinds: ReadonlyArray<MonitoringThreadKind>;
    readonly models: ReadonlyArray<string>;
  };
}

const NO_ENVIRONMENTS: ReadonlyArray<MonitoringEnvironmentReport> = [];

const sum = (values: Iterable<number>) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

const breakdownRows = (groups: Iterable<MonitoringBreakdownGroup>) =>
  [...groups]
    .map((group): MonitoringBreakdownRow => ({
      key: group.key,
      chats: group.chats,
      medianLifetimeMs: durationQuantile(group.lifetime, 0.5),
      medianActiveMs: durationQuantile(group.active, 0.5),
      costUsd: group.costUsd,
      findings: group.findings,
    }))
    .sort((a, b) => b.chats - a.chats || b.costUsd - a.costUsd);

/** Groups with the same key, across environments, become one. */
function mergeGroups(lists: ReadonlyArray<ReadonlyArray<MonitoringBreakdownGroup>>) {
  const byKey = new Map<string, MonitoringBreakdownGroup[]>();
  for (const group of lists.flat()) {
    const same = byKey.get(group.key);
    if (same === undefined) byKey.set(group.key, [group]);
    else same.push(group);
  }
  return [...byKey].map(([key, same]): MonitoringBreakdownGroup => ({
    key,
    chats: sum(same.map((group) => group.chats)),
    lifetime: mergeDurationSketches(same.map((group) => group.lifetime)),
    active: mergeDurationSketches(same.map((group) => group.active)),
    costUsd: sum(same.map((group) => group.costUsd)),
    findings: sum(same.map((group) => group.findings)),
  }));
}

function mergeTotals(results: ReadonlyArray<MonitoringOverviewResult>) {
  const time = Object.fromEntries(TIME_BUCKET_KEYS.map((key) => [key, 0])) as {
    -readonly [K in keyof MonitoringTimeBuckets]: number;
  };
  for (const { totals } of results) {
    for (const key of TIME_BUCKET_KEYS) time[key] += totals.time[key];
  }
  const total = (pick: (totals: MonitoringOverviewResult["totals"]) => number) =>
    sum(results.map(({ totals }) => pick(totals)));
  const lifetimeMs = total((totals) => totals.lifetimeMs);
  const workingMs = sum(
    TIME_BUCKET_KEYS.filter((key) => WORKING_BUCKETS.has(key)).map((key) => time[key]),
  );
  const inputTokens = total((totals) => totals.tokens.inputTokens);
  const cachedInputTokens = total((totals) => totals.tokens.cachedInputTokens);
  const lifetime: MonitoringDurationSketch = mergeDurationSketches(
    results.map(({ totals }) => totals.lifetime),
  );
  const active: MonitoringDurationSketch = mergeDurationSketches(
    results.map(({ totals }) => totals.active),
  );
  const totals: MonitoringTotals = {
    chats: total((entry) => entry.chats),
    lifetimeMs,
    activeMs: total((entry) => entry.activeMs),
    medianLifetimeMs: durationQuantile(lifetime, 0.5),
    medianActiveMs: durationQuantile(active, 0.5),
    workingMs,
    workingShare: lifetimeMs > 0 ? workingMs / lifetimeMs : 0,
    costUsd: total((entry) => entry.costUsd),
    unpricedTurns: total((entry) => entry.unpricedTurns),
    inputTokens,
    cachedInputTokens,
    outputTokens: total((entry) => entry.tokens.outputTokens),
    cacheReuse: inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    runs: total((entry) => entry.runs),
    failedRuns: total((entry) => entry.failedRuns),
    userPrompts: total((entry) => entry.userPrompts),
    helpers: total((entry) => entry.helpers),
    findings: total((entry) => entry.findings),
  };
  return { totals, time: time as MonitoringTimeBuckets };
}

function mergePhases(results: ReadonlyArray<MonitoringOverviewResult>) {
  const byPhase = new Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >();
  for (const { phases } of results) {
    for (const stats of phases) {
      const entry = byPhase.get(stats.phase) ?? { count: 0, failed: 0, durationMs: 0 };
      entry.count += stats.count;
      entry.failed += stats.failed;
      entry.durationMs += stats.durationMs;
      byPhase.set(stats.phase, entry);
    }
  }
  return [...byPhase]
    .filter(([, entry]) => entry.count > 0)
    .map(([phase, entry]): MonitoringPhaseTotal => ({
      phase,
      ...entry,
      failureRate: entry.failed / entry.count,
      averageMs: entry.durationMs / entry.count,
    }))
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs ||
        COMMAND_PHASE_ORDER.indexOf(a.phase) - COMMAND_PHASE_ORDER.indexOf(b.phase),
    );
}

function mergeFindings(results: ReadonlyArray<MonitoringOverviewResult>) {
  const byCode = new Map<
    MonitoringFindingCode,
    { -readonly [K in keyof MonitoringFindingRank]: MonitoringFindingRank[K] }
  >();
  for (const { findings } of results) {
    for (const finding of findings) {
      const entry = byCode.get(finding.code);
      if (entry === undefined) {
        byCode.set(finding.code, { ...finding });
        continue;
      }
      entry.chats += finding.chats;
      entry.occurrences += finding.occurrences;
      entry.wastedMs += finding.wastedMs;
      entry.severity = moreSevere(entry.severity, finding.severity);
    }
  }
  return [...byCode.values()].sort(compareFindingRollups);
}

function mergeDays(results: ReadonlyArray<MonitoringOverviewResult>) {
  const byDay = new Map<
    string,
    { chats: number; lifetimes: MonitoringDurationSketch[]; activeMs: number; costUsd: number }
  >();
  for (const { days } of results) {
    for (const day of days) {
      const entry = byDay.get(day.day) ?? { chats: 0, lifetimes: [], activeMs: 0, costUsd: 0 };
      entry.chats += day.chats;
      entry.lifetimes.push(day.lifetime);
      entry.activeMs += day.activeMs;
      entry.costUsd += day.costUsd;
      byDay.set(day.day, entry);
    }
  }
  return [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, entry]): MonitoringDayPoint => {
      const lifetime = mergeDurationSketches(entry.lifetimes);
      return {
        day,
        chats: entry.chats,
        medianLifetimeMs: durationQuantile(lifetime, 0.5),
        p90LifetimeMs: durationQuantile(lifetime, 0.9),
        activeMs: entry.activeMs,
        costUsd: entry.costUsd,
      };
    });
}

/** Merges the connected environments' answers into one overview. */
export function mergeMonitoringOverviews(
  reports: ReadonlyArray<MonitoringEnvironmentReport>,
  list: { readonly sort: MonitoringChatSort; readonly chatLimit: number },
): MonitoringOverviewView {
  const counted = reports.filter((report) => !report.optionsOnly);
  const answered = counted.flatMap(({ environmentId, result }) =>
    result === null ? [] : [{ environmentId, result }],
  );
  const optionSources = reports.flatMap(({ environmentId, result }) =>
    result === null ? [] : [{ environmentId, options: result.options }],
  );
  const results = answered.map(({ result }) => result);

  const owners = new Map<MonitoringChatRow, string>();
  const tag = (environmentId: string, rows: ReadonlyArray<MonitoringChatRow>) => {
    for (const row of rows) owners.set(row, environmentId);
  };
  for (const { environmentId, result } of answered) {
    tag(environmentId, result.chats);
    tag(environmentId, result.outliers.slowest);
    tag(environmentId, result.outliers.mostExpensive);
    tag(environmentId, result.outliers.mostFailures);
  }
  const chatOf = (row: MonitoringChatRow): MonitoringChat => ({
    environmentId: owners.get(row)!,
    row,
  });
  // A chat can lead several lists; each decoded list holds its own copy of the row.
  const candidates = new Map<string, MonitoringChatRow>();
  for (const { environmentId, result } of answered) {
    for (const row of [
      ...result.outliers.slowest,
      ...result.outliers.mostExpensive,
      ...result.outliers.mostFailures,
    ]) {
      candidates.set(chatKey(environmentId, row.threadId), row);
    }
  }
  const top = topMonitoringOutliers([...candidates.values()]);

  const byRow = compareMonitoringChatRows(list.sort);
  const { totals, time } = mergeTotals(results);
  return {
    environments: counted.length === 0 ? NO_ENVIRONMENTS : counted,
    connected: reports.length > 0,
    pendingAnalysis: sum(results.map((result) => result.pendingAnalysis)),
    failedAnalysis: sum(results.map((result) => result.failedAnalysis)),
    isLoading: answered.length === 0 && counted.some((report) => report.isPending),
    failed: counted.length > 0 && counted.every((report) => report.error !== null),
    totals,
    time,
    phases: mergePhases(results),
    findings: mergeFindings(results),
    days: mergeDays(results),
    breakdowns: {
      projects: breakdownRows(
        answered.flatMap(({ environmentId, result }) =>
          result.breakdowns.projects.map((group) => ({
            ...group,
            key: projectKey(environmentId, group.key),
          })),
        ),
      ),
      kinds: breakdownRows(mergeGroups(results.map((result) => result.breakdowns.kinds))),
      models: breakdownRows(mergeGroups(results.map((result) => result.breakdowns.models))),
    },
    outliers: {
      slowest: top.slowest.map(chatOf),
      mostExpensive: top.mostExpensive.map(chatOf),
      mostFailures: top.mostFailures.map(chatOf),
    },
    chats: answered
      .flatMap(({ result }) => result.chats)
      .sort(byRow)
      .slice(0, list.chatLimit)
      .map(chatOf),
    listedChats: sum(results.map((result) => result.listedChats)),
    options: {
      projects: optionSources.flatMap(({ environmentId, options }) =>
        options.projectIds.map((projectId) => ({
          key: projectKey(environmentId, projectId),
          environmentId,
          projectId,
        })),
      ),
      kinds: [...new Set(optionSources.flatMap(({ options }) => options.kinds))],
      models: [...new Set(optionSources.flatMap(({ options }) => options.models))],
    },
  };
}

/**
 * Where a chat's timeline starts and how long it is. Loops instead of spreading into
 * Math.min/max: a very long chat has more instants than a call takes.
 */
export function detailExtent({ summary, lanes, markers }: MonitoringThreadDetail) {
  let min = Infinity;
  let max = -Infinity;
  const note = (instant: string) => {
    const time = Date.parse(instant);
    if (!Number.isFinite(time)) return;
    if (time < min) min = time;
    if (time > max) max = time;
  };
  note(summary.createdAt);
  note(summary.settledAt);
  for (const lane of lanes) {
    for (const segment of lane.segments) {
      note(segment.startedAt);
      note(segment.completedAt);
    }
  }
  for (const marker of markers) note(marker.at);
  return { start: min, span: Math.max(1, max - min) };
}
