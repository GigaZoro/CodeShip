import {
  EnvironmentId,
  MONITORING_FIX_CHAT_MAX_CHATS,
  type MonitoringCommandPhase,
  type MonitoringFindingCode,
  type MonitoringFindingSeverity,
  type MonitoringOverviewResult,
  type MonitoringThreadDetail,
  type MonitoringThreadKind,
  type MonitoringThreadSummary,
  type MonitoringTimeBuckets,
  type ThreadId,
} from "@t3tools/contracts";

/** A summary and the environment that analyzed it; thread ids are only unique per environment. */
export interface MonitoringChat {
  readonly environmentId: string;
  readonly summary: MonitoringThreadSummary;
}

/** What one connected environment reported for the overview. */
export interface MonitoringEnvironmentReport {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  /** The last answer, kept while the environment refreshes. */
  readonly result: MonitoringOverviewResult | null;
}

export interface MonitoringOverviewView {
  readonly chats: ReadonlyArray<MonitoringChat>;
  readonly environments: ReadonlyArray<MonitoringEnvironmentReport>;
  readonly truncated: boolean;
  readonly pendingAnalysis: number;
  readonly failedAnalysis: number;
  /** No environment has answered yet. */
  readonly isLoading: boolean;
  /** Every connected environment failed. */
  readonly failed: boolean;
}

const NO_ENVIRONMENTS: ReadonlyArray<MonitoringEnvironmentReport> = [];

/** Merges the connected environments' answers into one overview. */
export function mergeMonitoringOverviews(
  reports: ReadonlyArray<MonitoringEnvironmentReport>,
): MonitoringOverviewView {
  const chats: MonitoringChat[] = [];
  let truncated = false;
  let pendingAnalysis = 0;
  let failedAnalysis = 0;
  let answered = 0;
  for (const { environmentId, result } of reports) {
    if (result === null) continue;
    answered += 1;
    truncated ||= result.truncated;
    pendingAnalysis += result.pendingAnalysis;
    failedAnalysis += result.failedAnalysis;
    for (const summary of result.threads) chats.push({ environmentId, summary });
  }
  return {
    chats,
    environments: reports.length === 0 ? NO_ENVIRONMENTS : reports,
    truncated,
    pendingAnalysis,
    failedAnalysis,
    isLoading: answered === 0 && reports.some((report) => report.isPending),
    failed: reports.length > 0 && reports.every((report) => report.error !== null),
  };
}

const chatKey = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;
export const projectKey = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

export const monitoringChatKey = (chat: MonitoringChat) =>
  chatKey(chat.environmentId, chat.summary.threadId);

/** Working first, then the waits, in the order a chat's lifetime usually unfolds. */
export const TIME_BUCKET_KEYS = [
  "agentMs",
  "commandMs",
  "toolMs",
  "approvalMs",
  "queuedMs",
  "usageLimitMs",
  "delegateWaitMs",
  "userResponseMs",
  "idleMs",
  "settleTailMs",
] as const satisfies ReadonlyArray<keyof MonitoringTimeBuckets>;
export type TimeBucketKey = (typeof TIME_BUCKET_KEYS)[number];

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

const SEVERITY_RANK: Record<MonitoringFindingSeverity, number> = { high: 3, medium: 2, low: 1 };

export interface MonitoringFilters {
  readonly projectKey?: string | null;
  readonly kind?: MonitoringThreadKind | null;
  readonly model?: string | null;
  /** Only chats that have a finding with this code. */
  readonly findingCode?: MonitoringFindingCode | null;
}

/** The chat's own model, or the label for a chat that ran none. */
export const NO_MODEL = "";
export const mainModel = (summary: MonitoringThreadSummary) => summary.models[0] ?? NO_MODEL;

export function filterChats(
  chats: ReadonlyArray<MonitoringChat>,
  filters: MonitoringFilters,
): ReadonlyArray<MonitoringChat> {
  const { projectKey: project, kind, model, findingCode } = filters;
  if (!project && !kind && model == null && !findingCode) return chats;
  return chats.filter(
    ({ environmentId, summary }) =>
      (!project || projectKey(environmentId, summary.projectId) === project) &&
      (!kind || summary.kind === kind) &&
      (model == null || mainModel(summary) === model) &&
      (!findingCode || summary.findings.some((finding) => finding.code === findingCode)),
  );
}

/** Linear-interpolated percentile of unsorted values; 0 for none. `fraction` is 0 to 1. */
export function percentile(values: ReadonlyArray<number>, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(1, Math.max(0, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower]!;
  const high = sorted[upper]!;
  return low + (high - low) * (position - lower);
}

export const median = (values: ReadonlyArray<number>) => percentile(values, 0.5);

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

export function sumTimeBuckets(chats: ReadonlyArray<MonitoringChat>): MonitoringTimeBuckets {
  const totals = Object.fromEntries(TIME_BUCKET_KEYS.map((key) => [key, 0])) as {
    -readonly [K in keyof MonitoringTimeBuckets]: number;
  };
  for (const { summary } of chats) {
    for (const key of TIME_BUCKET_KEYS) totals[key] += summary.time[key];
  }
  return totals;
}

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

export function totalsOf(chats: ReadonlyArray<MonitoringChat>): MonitoringTotals {
  const summaries = chats.map((chat) => chat.summary);
  const buckets = sumTimeBuckets(chats);
  const lifetimeMs = sum(summaries.map((s) => s.lifetimeMs));
  const workingMs = TIME_BUCKET_KEYS.filter((key) => WORKING_BUCKETS.has(key)).reduce(
    (total, key) => total + buckets[key],
    0,
  );
  const inputTokens = sum(summaries.map((s) => s.tokens.inputTokens));
  const cachedInputTokens = sum(summaries.map((s) => s.tokens.cachedInputTokens));
  return {
    chats: chats.length,
    lifetimeMs,
    activeMs: sum(summaries.map((s) => s.activeMs)),
    medianLifetimeMs: median(summaries.map((s) => s.lifetimeMs)),
    medianActiveMs: median(summaries.map((s) => s.activeMs)),
    workingMs,
    workingShare: lifetimeMs > 0 ? workingMs / lifetimeMs : 0,
    costUsd: sum(summaries.map((s) => s.costUsd)),
    unpricedTurns: sum(summaries.map((s) => s.unpricedTurns)),
    inputTokens,
    cachedInputTokens,
    outputTokens: sum(summaries.map((s) => s.tokens.outputTokens)),
    cacheReuse: inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    runs: sum(summaries.map((s) => s.runs.total)),
    failedRuns: sum(summaries.map((s) => s.runs.failed)),
    userPrompts: sum(summaries.map((s) => s.runs.userPrompts)),
    helpers: sum(
      summaries.map(
        (s) => s.helpers.subagents + s.helpers.delegates + s.helpers.commands + s.helpers.workflows,
      ),
    ),
    findings: sum(summaries.map((s) => s.findings.length)),
  };
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

/** Command phases summed across chats, most total time first; phases that never ran are left out. */
export function phaseTotals(
  chats: ReadonlyArray<MonitoringChat>,
): ReadonlyArray<MonitoringPhaseTotal> {
  const byPhase = new Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >();
  for (const { summary } of chats) {
    for (const stats of summary.phases) {
      const entry = byPhase.get(stats.phase) ?? { count: 0, failed: 0, durationMs: 0 };
      entry.count += stats.count;
      entry.failed += stats.failed;
      entry.durationMs += stats.durationMs;
      byPhase.set(stats.phase, entry);
    }
  }
  return [...byPhase]
    .filter(([, entry]) => entry.count > 0)
    .map(([phase, entry]) => ({
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

/** Midnight, `days - 1` days back, in the viewer's time zone, as an ISO instant. */
export function monitoringWindowStart(days: number, now: number): string {
  // @effect-diagnostics-next-line globalDate:off - Pure calendar math for a client that renders outside an Effect runtime.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.toISOString();
}

/** `YYYY-MM-DD` of an instant in a time zone (the viewer's own when omitted). */
export function dayKey(instant: string, timeZone?: string): string {
  // @effect-diagnostics-next-line globalDate:off - Pure formatting for a client that renders outside an Effect runtime.
  const date = new Date(instant);
  if (timeZone === undefined) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export interface MonitoringDayPoint {
  readonly day: string;
  readonly chats: number;
  readonly medianLifetimeMs: number;
  readonly p90LifetimeMs: number;
  readonly activeMs: number;
  readonly costUsd: number;
}

/**
 * One point per day a chat settled, oldest first. Pass `days` to also get a zero point for each
 * listed day with no chats, so a chart keeps an even axis.
 */
export function dailyTrend(
  chats: ReadonlyArray<MonitoringChat>,
  options: { readonly timeZone?: string; readonly days?: ReadonlyArray<string> } = {},
): ReadonlyArray<MonitoringDayPoint> {
  const byDay = new Map<string, MonitoringThreadSummary[]>();
  for (const day of options.days ?? []) byDay.set(day, []);
  for (const { summary } of chats) {
    const day = dayKey(summary.settledAt, options.timeZone);
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [summary]);
    else list.push(summary);
  }
  return [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, summaries]) => {
      const lifetimes = summaries.map((s) => s.lifetimeMs);
      return {
        day,
        chats: summaries.length,
        medianLifetimeMs: median(lifetimes),
        p90LifetimeMs: percentile(lifetimes, 0.9),
        activeMs: sum(summaries.map((s) => s.activeMs)),
        costUsd: sum(summaries.map((s) => s.costUsd)),
      };
    });
}

export interface MonitoringBreakdownRow {
  readonly key: string;
  readonly chats: number;
  readonly medianLifetimeMs: number;
  readonly medianActiveMs: number;
  readonly costUsd: number;
  readonly findings: number;
}

function breakdownBy(
  chats: ReadonlyArray<MonitoringChat>,
  keyOf: (chat: MonitoringChat) => string,
): ReadonlyArray<MonitoringBreakdownRow> {
  const groups = new Map<string, MonitoringThreadSummary[]>();
  for (const chat of chats) {
    const key = keyOf(chat);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [chat.summary]);
    else list.push(chat.summary);
  }
  return [...groups]
    .map(([key, summaries]) => ({
      key,
      chats: summaries.length,
      medianLifetimeMs: median(summaries.map((s) => s.lifetimeMs)),
      medianActiveMs: median(summaries.map((s) => s.activeMs)),
      costUsd: sum(summaries.map((s) => s.costUsd)),
      findings: sum(summaries.map((s) => s.findings.length)),
    }))
    .sort((a, b) => b.chats - a.chats || b.costUsd - a.costUsd);
}

/** Keys are {@link projectKey} values. */
export const breakdownByProject = (chats: ReadonlyArray<MonitoringChat>) =>
  breakdownBy(chats, ({ environmentId, summary }) => projectKey(environmentId, summary.projectId));

export const breakdownByKind = (chats: ReadonlyArray<MonitoringChat>) =>
  breakdownBy(chats, ({ summary }) => summary.kind);

/** Keys are the chat's main model, or {@link NO_MODEL}. */
export const breakdownByModel = (chats: ReadonlyArray<MonitoringChat>) =>
  breakdownBy(chats, ({ summary }) => mainModel(summary));

export interface MonitoringFindingRank {
  readonly code: MonitoringFindingCode;
  readonly chats: number;
  readonly occurrences: number;
  readonly wastedMs: number;
  readonly severity: MonitoringFindingSeverity;
  /** Keys from {@link monitoringChatKey}, for filtering the chat list. */
  readonly chatKeys: ReadonlyArray<string>;
}

/** Findings across chats: most time lost first, then most chats affected. */
export function rankFindings(
  chats: ReadonlyArray<MonitoringChat>,
): ReadonlyArray<MonitoringFindingRank> {
  const ranks = new Map<
    MonitoringFindingCode,
    {
      occurrences: number;
      wastedMs: number;
      severity: MonitoringFindingSeverity;
      chatKeys: Set<string>;
    }
  >();
  for (const chat of chats) {
    for (const finding of chat.summary.findings) {
      const entry = ranks.get(finding.code) ?? {
        occurrences: 0,
        wastedMs: 0,
        severity: finding.severity,
        chatKeys: new Set<string>(),
      };
      entry.occurrences += finding.count;
      entry.wastedMs += finding.wastedMs;
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[entry.severity]) {
        entry.severity = finding.severity;
      }
      entry.chatKeys.add(monitoringChatKey(chat));
      ranks.set(finding.code, entry);
    }
  }
  return [...ranks]
    .map(([code, entry]) => ({
      code,
      chats: entry.chatKeys.size,
      occurrences: entry.occurrences,
      wastedMs: entry.wastedMs,
      severity: entry.severity,
      chatKeys: [...entry.chatKeys],
    }))
    .sort(
      (a, b) =>
        b.wastedMs - a.wastedMs ||
        b.chats - a.chats ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    );
}

export interface MonitoringFixChatTarget {
  readonly environmentId: EnvironmentId;
  /** Most time lost first. */
  readonly threadIds: ReadonlyArray<ThreadId>;
}

/**
 * The chats a fix chat for one weak point reads. A chat runs on one environment and reads only that
 * one's chats, so it goes to the environment that lost the most time to the weak point.
 */
export function fixChatTarget(
  chats: ReadonlyArray<MonitoringChat>,
  code: MonitoringFindingCode,
): MonitoringFixChatTarget | null {
  const byEnvironment = new Map<
    string,
    { wastedMs: number; hits: Array<{ threadId: ThreadId; wastedMs: number }> }
  >();
  for (const { environmentId, summary } of chats) {
    const finding = summary.findings.find((candidate) => candidate.code === code);
    if (finding === undefined) continue;
    const entry = byEnvironment.get(environmentId) ?? { wastedMs: 0, hits: [] };
    entry.wastedMs += finding.wastedMs;
    entry.hits.push({ threadId: summary.threadId, wastedMs: finding.wastedMs });
    byEnvironment.set(environmentId, entry);
  }
  const [best] = [...byEnvironment].sort(
    ([, left], [, right]) => right.wastedMs - left.wastedMs || right.hits.length - left.hits.length,
  );
  if (best === undefined) return null;
  const [environmentId, { hits }] = best;
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadIds: hits
      .sort((left, right) => right.wastedMs - left.wastedMs)
      .slice(0, MONITORING_FIX_CHAT_MAX_CHATS)
      .map((hit) => hit.threadId),
  };
}

export interface MonitoringOutliers {
  readonly slowest: ReadonlyArray<MonitoringChat>;
  readonly mostExpensive: ReadonlyArray<MonitoringChat>;
  readonly mostFailures: ReadonlyArray<MonitoringChat>;
}

const failuresOf = ({ summary }: MonitoringChat) => summary.runs.failed + summary.commands.failed;

export function outliers(chats: ReadonlyArray<MonitoringChat>, limit = 5): MonitoringOutliers {
  const top = (score: (chat: MonitoringChat) => number) =>
    chats
      .filter((chat) => score(chat) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, limit);
  return {
    slowest: top(({ summary }) => summary.lifetimeMs),
    mostExpensive: top(({ summary }) => summary.costUsd),
    mostFailures: top(failuresOf),
  };
}

export type ChatSortKey = "settledAt" | "lifetimeMs" | "activeMs" | "costUsd" | "findings";

const sortValue = (key: ChatSortKey, { summary }: MonitoringChat): number =>
  key === "settledAt"
    ? Date.parse(summary.settledAt)
    : key === "findings"
      ? summary.findings.length
      : summary[key];

export function sortChats(
  chats: ReadonlyArray<MonitoringChat>,
  key: ChatSortKey,
  direction: "asc" | "desc",
): ReadonlyArray<MonitoringChat> {
  const sign = direction === "asc" ? 1 : -1;
  return [...chats].sort(
    (a, b) =>
      sign * (sortValue(key, a) - sortValue(key, b)) ||
      Date.parse(b.summary.settledAt) - Date.parse(a.summary.settledAt),
  );
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
