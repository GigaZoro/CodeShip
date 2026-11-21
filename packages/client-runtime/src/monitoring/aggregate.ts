import type {
  EnvironmentId,
  MonitoringChatSort,
  MonitoringChatsInput,
  MonitoringChatsResult,
  MonitoringCommandPhase,
  MonitoringFindingCode,
  MonitoringFindingSeverity,
  MonitoringDay,
  MonitoringGroup,
  MonitoringOverviewInput,
  MonitoringOverviewResult,
  MonitoringThreadDetail,
  MonitoringThreadResult,
  MonitoringThreadKind,
  MonitoringThreadSummary,
  MonitoringTimeBuckets,
  MonitoringUnanalyzed,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { getFormattingLocale, t } from "@t3tools/shared/i18n";
import type * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  connectionCanRetry,
  connectionStatusText,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";

/** A group and the environment that reported it; project ids are only unique per environment. */
export interface MonitoringGroupEntry {
  readonly environmentId: string;
  readonly group: MonitoringGroup;
}

/** A summary and the environment that analyzed it; thread ids are only unique per environment. */
export interface MonitoringChat {
  readonly environmentId: string;
  readonly summary: MonitoringThreadSummary;
}

/** What one query has answered so far. */
export interface MonitoringQueryRead<A> {
  /** A request for it is in flight. */
  readonly isPending: boolean;
  readonly error: string | null;
  /** The last answer, kept while the query refreshes or after a failed refresh. */
  readonly result: A | null;
}

export function queryRead<A, E>(
  result: AsyncResult.AsyncResult<A, E>,
  describeFailure: (cause: Cause.Cause<E>) => string,
): MonitoringQueryRead<A> {
  return {
    isPending: result.waiting,
    error: result._tag === "Failure" ? describeFailure(result.cause) : null,
    result: AsyncResult.getOrElse(result, () => null),
  };
}

/** What one environment answered to one query. */
export interface MonitoringEnvironmentReport<
  A = MonitoringOverviewResult,
> extends MonitoringQueryRead<A> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Retry can reach it: it answers queries, or its connection can be retried now. */
  readonly retryable: boolean;
  readonly stale?: boolean;
  readonly connectionFailure?: boolean;
}

/** An environment the user asked to connect, and whether Monitoring can ask it yet. */
export interface MonitoringEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /**
   * Null once it can answer; otherwise it is waiting (no error) or cannot answer (the reason), and
   * `reconnects` says whether a retry of its connection can change that.
   */
  readonly unready: { readonly error: string | null; readonly reconnects: boolean } | null;
}

/**
 * How Monitoring sees an environment, or null for one the user has not asked to connect, which no
 * sum includes. One still connecting is waiting, and one that is offline, whose connection failed
 * or whose server predates paged Monitoring is unreadable, so none passes for an environment
 * without chats.
 */
export function monitoringEnvironment(
  environmentId: EnvironmentId,
  { entry, connection, serverConfig }: EnvironmentPresentation,
): MonitoringEnvironment | null {
  if (!entry.enabled || connection.phase === "available") return null;
  const environment = { environmentId, label: entry.target.label };
  const reconnects = connectionCanRetry(connection.phase);
  const unready = (error: string | null) => ({ ...environment, unready: { error, reconnects } });
  switch (connection.phase) {
    case "connected":
      if (serverConfig === null) return unready(null);
      return serverConfig.environment.capabilities.monitoringPages === true
        ? { ...environment, unready: null }
        : unready(t("Update this environment's T3.CodeShip server to see it in Monitoring."));
    case "connecting":
    case "reconnecting":
      return unready(connection.error === null ? null : connectionStatusText(connection));
    case "unsupported":
      return unready(connection.error ?? connectionStatusText(connection));
    case "offline":
    case "error":
      return unready(connectionStatusText(connection));
  }
}

/** The last answer stays visible when this environment temporarily cannot answer. */
export function environmentReport<A>(
  { environmentId, label, unready }: MonitoringEnvironment,
  read: () => MonitoringQueryRead<A>,
  previous: A | null = null,
  previousReport?: MonitoringEnvironmentReport<A>,
): MonitoringEnvironmentReport<A> {
  const current =
    unready === null ? read() : { isPending: false, error: unready.error, result: null };
  const result = current.result ?? previous;
  const retryingConnection =
    current.error === null &&
    previousReport?.connectionFailure === true &&
    (unready !== null || current.isPending);
  return {
    ...current,
    isPending: current.isPending || retryingConnection,
    error: retryingConnection ? previousReport.error : current.error,
    connectionFailure: retryingConnection || (unready !== null && current.error !== null),
    environmentId,
    label,
    retryable: retryingConnection || unready === null || unready.reconnects,
    result,
    stale:
      result !== null &&
      (unready !== null || retryingConnection || current.error !== null || current.result === null),
  };
}

export const threadDetailOf = (answer: MonitoringThreadResult): MonitoringThreadDetail | null =>
  answer !== null && "detail" in answer ? answer.detail : answer;

export function monitoringDetailReconnects(
  ready: boolean,
  wasReconnecting: boolean,
  isPending: boolean,
) {
  return !ready || (wasReconnecting && isPending);
}

/** Which environments a merged answer is still missing, and whether it has any answer at all. */
export interface MonitoringReportStatus<A> {
  readonly environments: ReadonlyArray<MonitoringEnvironmentReport<A>>;
  /** Environments without a current answer that can still respond. */
  readonly waiting: ReadonlyArray<MonitoringEnvironmentReport<A>>;
  /** Environments that could not answer the current request. */
  readonly unreadable: ReadonlyArray<MonitoringEnvironmentReport<A>>;
  /** No environment has answered yet, and one still may. */
  readonly isLoading: boolean;
  /** Every environment answered, so an empty answer means there is nothing to show. */
  readonly complete: boolean;
  /** Every environment failed and there is no answer to display. */
  readonly failed: boolean;
  readonly stale?: boolean;
}

function reportStatus<A>(
  reports: ReadonlyArray<MonitoringEnvironmentReport<A>>,
): MonitoringReportStatus<A> {
  const waiting = reports.filter(
    (report) => (report.result === null || report.stale) && report.error === null,
  );
  const unreadable = reports.filter((report) => report.error !== null);
  return {
    environments: reports,
    waiting,
    unreadable,
    isLoading: waiting.length > 0 && reports.every((report) => report.result === null),
    complete: waiting.length === 0 && unreadable.length === 0,
    failed:
      reports.length > 0 &&
      unreadable.length === reports.length &&
      reports.every((report) => report.result === null),
    stale: reports.some((report) => report.stale),
  };
}

/** An environment that could not answer, with the reason. */
export const unreadableEnvironmentText = (report: MonitoringEnvironmentReport<unknown>) =>
  t("{environment}: {error}", { environment: report.label, error: report.error ?? "" });

export interface MissingEnvironments {
  /** The environments still answering, by name; empty when none or before one answers or fails. */
  readonly waiting: string;
  /** The environments that could not answer, each with its reason; empty when none. */
  readonly unreadable: string;
}

/**
 * The environments one answer lacks, so the screen can name them next to it. Until one answers or
 * fails, the loading state alone shows what is missing; once one failed, it names those it awaits.
 */
export function missingEnvironments(view: MonitoringReportStatus<unknown>): MissingEnvironments {
  const waiting = view.isLoading && view.unreadable.length === 0 ? [] : view.waiting;
  return {
    waiting: waiting.map((report) => report.label).join(", "),
    unreadable: view.unreadable.map(unreadableEnvironmentText).join("; "),
  };
}

/** What Retry offers next to the failures a view names. */
export type MonitoringRetry = "unavailable" | "busy" | "available";

/**
 * Retry for the failures `shown` names: unavailable when it can reach none of them, such as a
 * server too old to page, and busy while `live`, the answer `shown` stands in for while it loads,
 * asks again each one it can reach, so a press would add nothing.
 */
export function failureRetry(
  shown: MonitoringReportStatus<unknown>,
  live: MonitoringReportStatus<unknown> = shown,
): MonitoringRetry {
  const retryable = shown.unreadable.filter((report) => report.retryable);
  if (retryable.length === 0) return "unavailable";
  const asking = new Set(
    live.environments.flatMap(({ environmentId, isPending }) => (isPending ? [environmentId] : [])),
  );
  return retryable.every(({ environmentId }) => asking.has(environmentId)) ? "busy" : "available";
}

export interface MonitoringUnanalyzedEntry {
  readonly environmentId: string;
  readonly unanalyzed: MonitoringUnanalyzed;
}

export interface MonitoringOverviewView extends MonitoringReportStatus<MonitoringOverviewResult> {
  readonly groups: ReadonlyArray<MonitoringGroupEntry>;
  readonly unanalyzed: ReadonlyArray<MonitoringUnanalyzedEntry>;
}

function sameMonitoringEnvironments(
  a: MonitoringReportStatus<unknown>,
  b: MonitoringReportStatus<unknown>,
): boolean {
  return (
    a.environments.length === b.environments.length &&
    a.environments.every(({ environmentId }) =>
      b.environments.some((report) => report.environmentId === environmentId),
    )
  );
}

interface MonitoringOverviewShown {
  readonly key: string;
  readonly view: MonitoringOverviewView;
  readonly days: ReadonlyArray<MonitoringDay>;
}

export function presentMonitoringOverview(
  shown: MonitoringOverviewShown,
  next: MonitoringOverviewShown,
) {
  const keep =
    next.key !== shown.key &&
    !next.view.environments.some(
      ({ result, stale, error }) => result !== null && !stale && error === null,
    ) &&
    shown.view.environments.some(({ result }) => result !== null) &&
    sameMonitoringEnvironments(shown.view, next.view);
  return {
    keep,
    view: keep
      ? {
          ...next.view,
          groups: shown.view.groups,
          unanalyzed: shown.view.unanalyzed,
          stale: true,
          isLoading: false,
          failed: false,
        }
      : next.view,
    days: keep ? shown.days : next.days,
  };
}

/** Merges the connected environments' answers into one overview. */
export function mergeMonitoringOverviews(
  reports: ReadonlyArray<MonitoringEnvironmentReport>,
): MonitoringOverviewView {
  const groups: MonitoringGroupEntry[] = [];
  const unanalyzed: MonitoringUnanalyzedEntry[] = [];
  for (const { environmentId, result } of reports) {
    if (result === null) continue;
    for (const group of result.groups) groups.push({ environmentId, group });
    for (const entry of result.unanalyzed) unanalyzed.push({ environmentId, unanalyzed: entry });
  }
  return { ...reportStatus(reports), groups, unanalyzed };
}

export const projectKey = (environmentId: string, projectId: string) =>
  `${environmentId}:${projectId}`;

/**
 * The settled chats of the project in scope, or of every project, that the sums leave out. Kind and
 * model are known only once a chat is analyzed, so those filters do not narrow them.
 */
export function unanalyzedCounts(
  entries: ReadonlyArray<MonitoringUnanalyzedEntry>,
  project: string | null,
) {
  let pending = 0;
  let failed = 0;
  for (const { environmentId, unanalyzed } of entries) {
    if (project !== null && projectKey(environmentId, unanalyzed.projectId) !== project) continue;
    pending += unanalyzed.pending;
    failed += unanalyzed.failed;
  }
  return { pending, failed };
}

export const monitoringChatKey = (chat: MonitoringChat) =>
  `${chat.environmentId}:${chat.summary.threadId}`;

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
  /** Only chats that have a finding with this code; the chat list applies it, groups cannot. */
  readonly findingCode?: MonitoringFindingCode | null;
}

/** The chat's own model, or the label for a chat that ran none. */
export const NO_MODEL = "";
export const mainModel = (summary: MonitoringThreadSummary) => summary.models[0] ?? NO_MODEL;

/** The groups in scope of the project, kind and model filters. */
export function filterGroups(
  entries: ReadonlyArray<MonitoringGroupEntry>,
  filters: MonitoringFilters,
): ReadonlyArray<MonitoringGroupEntry> {
  const { projectKey: project, kind, model } = filters;
  if (!project && !kind && model == null) return entries;
  return entries.filter(
    ({ environmentId, group }) =>
      (!project || projectKey(environmentId, group.projectId) === project) &&
      (!kind || group.kind === kind) &&
      (model == null || group.model === model),
  );
}

/**
 * The projects, kinds and models the groups hold, for the filter choices. Projects also come from
 * the chats not analyzed yet, so the notes on them can be narrowed to a project with no sums.
 */
export function monitoringFacets(overview: Pick<MonitoringOverviewView, "groups" | "unanalyzed">) {
  const { groups, unanalyzed } = overview;
  return {
    projectKeys: [
      ...new Set([
        ...groups.map(({ environmentId, group }) => projectKey(environmentId, group.projectId)),
        ...unanalyzed.map((entry) => projectKey(entry.environmentId, entry.unanalyzed.projectId)),
      ]),
    ],
    kinds: [...new Set(groups.map(({ group }) => group.kind))],
    models: [...new Set(groups.map(({ group }) => group.model))],
  };
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

const chatCount = (group: MonitoringGroup) => group.lifetimesMs.length;
const findingCount = (group: MonitoringGroup) =>
  sum(group.findings.map((finding) => finding.chats));

export function sumTimeBuckets(
  entries: ReadonlyArray<MonitoringGroupEntry>,
): MonitoringTimeBuckets {
  const totals = Object.fromEntries(TIME_BUCKET_KEYS.map((key) => [key, 0])) as {
    -readonly [K in keyof MonitoringTimeBuckets]: number;
  };
  for (const { group } of entries) {
    for (const key of TIME_BUCKET_KEYS) totals[key] += group.time[key];
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

export function totalsOf(entries: ReadonlyArray<MonitoringGroupEntry>): MonitoringTotals {
  const groups = entries.map((entry) => entry.group);
  const lifetimes = groups.flatMap((group) => group.lifetimesMs);
  const actives = groups.flatMap((group) => group.activesMs);
  const buckets = sumTimeBuckets(entries);
  const lifetimeMs = sum(lifetimes);
  const workingMs = TIME_BUCKET_KEYS.filter((key) => WORKING_BUCKETS.has(key)).reduce(
    (total, key) => total + buckets[key],
    0,
  );
  const inputTokens = sum(groups.map((group) => group.tokens.inputTokens));
  const cachedInputTokens = sum(groups.map((group) => group.tokens.cachedInputTokens));
  return {
    chats: lifetimes.length,
    lifetimeMs,
    activeMs: sum(actives),
    medianLifetimeMs: median(lifetimes),
    medianActiveMs: median(actives),
    workingMs,
    workingShare: lifetimeMs > 0 ? workingMs / lifetimeMs : 0,
    costUsd: sum(groups.map((group) => group.costUsd)),
    unpricedTurns: sum(groups.map((group) => group.unpricedTurns)),
    inputTokens,
    cachedInputTokens,
    outputTokens: sum(groups.map((group) => group.tokens.outputTokens)),
    cacheReuse: inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    runs: sum(groups.map((group) => group.runs)),
    failedRuns: sum(groups.map((group) => group.failedRuns)),
    userPrompts: sum(groups.map((group) => group.userPrompts)),
    helpers: sum(groups.map((group) => group.helpers)),
    findings: sum(groups.map(findingCount)),
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

/** Command phases summed across groups, most total time first; phases that never ran are left out. */
export function phaseTotals(
  entries: ReadonlyArray<MonitoringGroupEntry>,
): ReadonlyArray<MonitoringPhaseTotal> {
  const byPhase = new Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >();
  for (const { group } of entries) {
    for (const stats of group.phases) {
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

export interface MonitoringWindow {
  readonly since: string;
  /**
   * The end of the last day. Every read of the window ends here, not at the server's now, so the
   * pages of one list ask about the same chats and the sums cover exactly the listed days.
   */
  readonly until: string;
  /** Every day of the window, oldest first; each environment counts a chat on one of these. */
  readonly days: MonitoringOverviewInput["days"];
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * The last `days` calendar days up to `now` on the device's clock, each with the instant it starts.
 * Only Date's local math draws them, never Intl, whose zone can disagree with the clock (a POSIX
 * `TZ`, Hermes misreading offsets), so a day's name, its start and the period's bounds agree.
 */
export function monitoringWindow(days: number, now: number): MonitoringWindow {
  // @effect-diagnostics-next-line globalDate:off - Pure calendar math for a client that renders outside an Effect runtime.
  const today = new Date(now);
  // Built from the date alone, a midnight that DST skips moves to the first hour that exists.
  const dayStart = (offset: number) =>
    // @effect-diagnostics-next-line globalDate:off - Pure calendar math for a client that renders outside an Effect runtime.
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const dayAt = (offset: number): MonitoringDay => {
    const start = dayStart(offset);
    return {
      day: `${start.getFullYear()}-${twoDigits(start.getMonth() + 1)}-${twoDigits(start.getDate())}`,
      since: start.toISOString(),
    };
  };
  const first = dayAt(1 - days);
  const calendar: [MonitoringDay, ...MonitoringDay[]] = [first];
  for (let offset = 2 - days; offset <= 0; offset += 1) {
    const day = dayAt(offset);
    // A date the clock skips whole (Samoa's 2011-12-30) starts with the next one, so it is left out.
    if (day.since !== calendar[calendar.length - 1]?.since) calendar.push(day);
  }
  return { since: first.since, until: dayStart(1).toISOString(), days: calendar };
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
/** Further than any clock change moves the clock: Antarctica/Troll's moves it two hours. */
const CLOCK_CHANGE_REACH_MS = 180 * MINUTE_MS;

/** How far ahead of UTC the device's clock is at `ms`, read from its fields to keep any seconds. */
const offsetAt = (ms: number) => {
  // @effect-diagnostics-next-line globalDate:off - Pure calendar math for a client that renders outside an Effect runtime.
  const local = new Date(ms);
  const wall = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
  return wall - ms;
};

const wallTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Formats a wall time read as UTC, which keeps Intl's own zone out of it. */
function wallTimeFormatter(hour12: boolean | undefined): Intl.DateTimeFormat {
  const locale = getFormattingLocale() ?? "en-US";
  const key = `${locale}:${String(hour12)}`;
  let formatter = wallTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      minute: "2-digit",
      ...(hour12 === undefined
        ? { hour: "numeric" }
        : hour12
          ? { hour: "numeric", hour12: true }
          : // `hour12: false` reads as h24 on some engines, which writes midnight as 24:00.
            { hour: "2-digit", hourCycle: "h23" }),
    });
    if (wallTimeFormatters.size >= 8) wallTimeFormatters.clear();
    wallTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * A Monitoring time on the device's clock that {@link monitoringWindow} draws the days on, so a
 * chat's settle time names the day it counts on. A minute the clock shows twice names its offset.
 * Without `hour12`, the locale's clock decides.
 */
export function formatMonitoringTime(instant: string, hour12?: boolean): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return instant;
  const offset = offsetAt(ms);
  const wall = ms + offset;
  // @effect-diagnostics-next-line globalDate:off - Pure calendar math for a client that renders outside an Effect runtime.
  const label = wallTimeFormatter(hour12).format(new Date(wall));
  const minute = Math.floor(wall / MINUTE_MS) * MINUTE_MS;
  // Another offset near `ms` shows the same minute at other instants when one of them has it.
  const repeated = [-CLOCK_CHANGE_REACH_MS, CLOCK_CHANGE_REACH_MS].some((step) => {
    const other = offsetAt(ms + step);
    return (
      other !== offset &&
      [minute - other, minute + MINUTE_MS - 1 - other].some((time) => offsetAt(time) === other)
    );
  });
  if (!repeated) return label;
  const totalSeconds = Math.round(Math.abs(offset) / SECOND_MS);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  // Only old local mean times, such as Liberia's until 1972, have seconds, which can tell two apart.
  const seconds = totalSeconds % 60;
  const rest =
    seconds !== 0
      ? `:${twoDigits(minutes)}:${twoDigits(seconds)}`
      : minutes !== 0
        ? `:${twoDigits(minutes)}`
        : "";
  const sign = offset < 0 ? "-" : "+";
  return `${label} GMT${sign}${Math.floor(totalSeconds / 3_600)}${rest}`;
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
  entries: ReadonlyArray<MonitoringGroupEntry>,
  options: { readonly days?: ReadonlyArray<Pick<MonitoringDay, "day">> } = {},
): ReadonlyArray<MonitoringDayPoint> {
  const byDay = new Map<string, MonitoringGroup[]>();
  for (const { day } of options.days ?? []) byDay.set(day, []);
  for (const { group } of entries) {
    const list = byDay.get(group.day);
    if (list === undefined) byDay.set(group.day, [group]);
    else list.push(group);
  }
  return [...byDay]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, groups]) => {
      const lifetimes = groups.flatMap((group) => group.lifetimesMs);
      return {
        day,
        chats: lifetimes.length,
        medianLifetimeMs: median(lifetimes),
        p90LifetimeMs: percentile(lifetimes, 0.9),
        activeMs: sum(groups.flatMap((group) => group.activesMs)),
        costUsd: sum(groups.map((group) => group.costUsd)),
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
  entries: ReadonlyArray<MonitoringGroupEntry>,
  keyOf: (entry: MonitoringGroupEntry) => string,
): ReadonlyArray<MonitoringBreakdownRow> {
  const byKey = new Map<string, MonitoringGroup[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [entry.group]);
    else list.push(entry.group);
  }
  return [...byKey]
    .map(([key, groups]) => ({
      key,
      chats: sum(groups.map(chatCount)),
      medianLifetimeMs: median(groups.flatMap((group) => group.lifetimesMs)),
      medianActiveMs: median(groups.flatMap((group) => group.activesMs)),
      costUsd: sum(groups.map((group) => group.costUsd)),
      findings: sum(groups.map(findingCount)),
    }))
    .sort((a, b) => b.chats - a.chats || b.costUsd - a.costUsd);
}

/** Keys are {@link projectKey} values. */
export const breakdownByProject = (entries: ReadonlyArray<MonitoringGroupEntry>) =>
  breakdownBy(entries, ({ environmentId, group }) => projectKey(environmentId, group.projectId));

export const breakdownByKind = (entries: ReadonlyArray<MonitoringGroupEntry>) =>
  breakdownBy(entries, ({ group }) => group.kind);

/** Keys are the chats' main model, or {@link NO_MODEL}. */
export const breakdownByModel = (entries: ReadonlyArray<MonitoringGroupEntry>) =>
  breakdownBy(entries, ({ group }) => group.model);

export interface MonitoringFindingRank {
  readonly code: MonitoringFindingCode;
  readonly chats: number;
  readonly occurrences: number;
  readonly wastedMs: number;
  readonly severity: MonitoringFindingSeverity;
}

/** Findings across groups: most time lost first, then most chats affected. */
export function rankFindings(
  entries: ReadonlyArray<MonitoringGroupEntry>,
): ReadonlyArray<MonitoringFindingRank> {
  const ranks = new Map<MonitoringFindingCode, MonitoringFindingRank>();
  for (const { group } of entries) {
    for (const finding of group.findings) {
      const entry = ranks.get(finding.code);
      ranks.set(finding.code, {
        code: finding.code,
        chats: (entry?.chats ?? 0) + finding.chats,
        occurrences: (entry?.occurrences ?? 0) + finding.occurrences,
        wastedMs: (entry?.wastedMs ?? 0) + finding.wastedMs,
        severity:
          entry !== undefined && SEVERITY_RANK[entry.severity] >= SEVERITY_RANK[finding.severity]
            ? entry.severity
            : finding.severity,
      });
    }
  }
  return [...ranks.values()].sort(
    (a, b) =>
      b.wastedMs - a.wastedMs ||
      b.chats - a.chats ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

export type ChatSortKey = MonitoringChatSort;

export interface MonitoringChatOrder {
  readonly sort: ChatSortKey;
  readonly direction: "asc" | "desc";
  /** How many chats to show. */
  readonly limit: number;
}

/** Failed runs plus failed commands, the "failures" sort. */
export const chatFailures = (summary: MonitoringThreadSummary) =>
  summary.runs.failed + summary.commands.failed;

interface RankedChat {
  readonly chat: MonitoringChat;
  readonly sortValue: number;
}

/**
 * Which of two environments' next chats comes first: the key each environment sorted by, the
 * newest settle, the environment.
 */
function compareAcrossEnvironments(direction: MonitoringChatOrder["direction"]) {
  const sign = direction === "asc" ? 1 : -1;
  return (a: RankedChat, b: RankedChat) =>
    sign * (a.sortValue - b.sortValue) ||
    Date.parse(b.chat.summary.settledAt) - Date.parse(a.chat.summary.settledAt) ||
    (a.chat.environmentId < b.chat.environmentId ? -1 : 1);
}

/** One chat-list question asked of every environment. */
export interface MonitoringChatsRequest {
  readonly window: Pick<MonitoringWindow, "since" | "until">;
  readonly filters: MonitoringFilters;
  readonly order: MonitoringChatOrder;
  /** How many chats one page of an environment's list holds. */
  readonly pageSize: number;
}

/**
 * The query for one environment's page that starts at `offset`, or null when the project filter
 * names another environment's project, so none of its chats can match.
 */
export function monitoringChatsInput(
  environmentId: string,
  { window, filters, order, pageSize }: MonitoringChatsRequest,
  offset: number,
): MonitoringChatsInput | null {
  let projectId: ProjectId | undefined;
  if (filters.projectKey) {
    const prefix = `${environmentId}:`;
    if (!filters.projectKey.startsWith(prefix)) return null;
    projectId = ProjectId.make(filters.projectKey.slice(prefix.length));
  }
  return {
    since: window.since,
    until: window.until,
    ...(projectId === undefined ? {} : { projectId }),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.model == null ? {} : { model: filters.model }),
    ...(filters.findingCode ? { findingCode: filters.findingCode } : {}),
    sort: order.sort,
    direction: order.direction,
    limit: pageSize,
    offset,
  };
}

/** One environment's chat list, read a page at a time. */
export interface MonitoringChatsSource {
  readonly environment: MonitoringEnvironment;
  readonly readPage: (offset: number) => MonitoringQueryRead<MonitoringChatsResult>;
}

/** A page of one environment's chat list that a merge read. */
export interface MonitoringChatsPage {
  readonly environmentId: EnvironmentId;
  readonly offset: number;
}

export interface MonitoringChatsView extends MonitoringReportStatus<MonitoringChatsResult> {
  /** The first `limit` chats across environments, in the requested order, as far as known. */
  readonly chats: ReadonlyArray<MonitoringChat>;
  /** Every chat that matches in the environments that answered. */
  readonly total: number;
  /** Every page the merge read, a failed environment's included. */
  readonly pages: ReadonlyArray<MonitoringChatsPage>;
  /** A page the list needs is still loading or being read again, so the list can still change. */
  readonly awaitingPage: boolean;
  readonly cachedPages: ReadonlyMap<EnvironmentId, ReadonlyArray<MonitoringChatsResult>>;
  readonly failedOffsets: ReadonlyMap<EnvironmentId, number>;
  readonly keptPendingPages: boolean;
  readonly availableEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

interface ChatQueue {
  readonly environmentId: EnvironmentId;
  readonly source: MonitoringChatsSource;
  readonly rows: RankedChat[];
  readonly seen: Set<string>;
  next: number;
  /** Where the environment's next page starts, or null after its last. */
  nextOffset: number | null;
}

interface DeferredChatPage {
  readonly environmentId: EnvironmentId;
  readonly error: string | null;
  readonly offset: number;
  readonly isPending: boolean;
  readonly awaitingEarlierPage: boolean;
}

type MergeAttempt =
  | { readonly view: Omit<MonitoringChatsView, "availableEnvironmentIds"> }
  | { readonly failure: DeferredChatPage };

/**
 * Keeps each environment's server order and orders by the servers' keys, which can disagree with
 * keys computed here. Reads a next page only once the chats shown need it, and stops at one still
 * loading or read again, marking its environment pending. An environment whose later page fails
 * is left out whole.
 */
export function mergeMonitoringChats(
  sources: ReadonlyArray<MonitoringChatsSource>,
  request: MonitoringChatsRequest,
  previous?: MonitoringChatsView,
  availableEnvironmentIds = sources.map(({ environment }) => environment.environmentId),
): MonitoringChatsView {
  const failed = new Map<EnvironmentId, DeferredChatPage>();
  for (;;) {
    const attempt = mergeChatPages(sources, request, failed, previous);
    if ("view" in attempt) return { ...attempt.view, availableEnvironmentIds };
    failed.set(attempt.failure.environmentId, attempt.failure);
  }
}

/**
 * A page read again counts as still loading, whatever it answered before: an old answer next to
 * pages already answered again can skip or repeat chats, and an old failure would leave out an
 * environment that may be answering now.
 */
const currentPage = (
  read: MonitoringQueryRead<MonitoringChatsResult>,
): MonitoringQueryRead<MonitoringChatsResult> =>
  read.isPending
    ? { isPending: true, error: null, result: null }
    : read.error !== null
      ? { ...read, result: null }
      : read;

function mergeChatPages(
  sources: ReadonlyArray<MonitoringChatsSource>,
  { order, pageSize }: MonitoringChatsRequest,
  failed: ReadonlyMap<EnvironmentId, DeferredChatPage>,
  previous: MonitoringChatsView | undefined,
): MergeAttempt {
  const pages: MonitoringChatsPage[] = [];
  const reports: MonitoringEnvironmentReport<MonitoringChatsResult>[] = [];
  const queues: ChatQueue[] = [];
  let awaitingPage = false;
  const cachedPages = new Map<EnvironmentId, ReadonlyArray<MonitoringChatsResult>>();
  const answeredPages = new Map<EnvironmentId, MonitoringChatsResult[]>();
  const pendingEnvironments = new Set<EnvironmentId>();

  const readPage = (source: MonitoringChatsSource, offset: number) => {
    const { environmentId } = source.environment;
    pages.push({ environmentId, offset });
    const read = currentPage(source.readPage(offset));
    const failedOffset = previous?.failedOffsets.get(environmentId);
    const retry =
      read.isPending && failedOffset !== undefined && offset <= failedOffset
        ? previous?.unreadable.find((report) => report.environmentId === environmentId)?.error
        : null;
    const error = read.error ?? retry;
    const hold = read.isPending && previous?.cachedPages.has(environmentId) === true;
    if (error != null || hold) {
      return {
        failure: {
          environmentId,
          error: error ?? null,
          offset: retry == null ? offset : (failedOffset ?? offset),
          isPending: read.isPending,
          awaitingEarlierPage:
            hold || (retry != null && failedOffset !== undefined && offset < failedOffset),
        },
      };
    }
    if (read.result === null) pendingEnvironments.add(environmentId);
    else answeredPages.get(environmentId)?.push(read.result);
    return { read };
  };

  const append = (queue: ChatQueue, offset: number, page: MonitoringChatsResult) => {
    for (const { summary, sortValue } of page.chats) {
      // Chats settling between two page reads shift the pages, so one can repeat.
      if (queue.seen.has(summary.threadId)) continue;
      queue.seen.add(summary.threadId);
      queue.rows.push({ chat: { environmentId: queue.environmentId, summary }, sortValue });
    }
    queue.nextOffset =
      page.chats.length === pageSize && offset + pageSize < page.total ? offset + pageSize : null;
  };
  for (const source of sources) {
    const { environmentId, unready } = source.environment;
    const cached = previous?.cachedPages.get(environmentId);
    const previousReport = previous?.environments.find(
      (report) => report.environmentId === environmentId,
    );
    if (cached !== undefined) cachedPages.set(environmentId, cached);
    const failure = failed.get(environmentId);
    const queue: ChatQueue = {
      environmentId,
      source,
      rows: [],
      seen: new Set(),
      next: 0,
      nextOffset: null,
    };
    if (failure !== undefined || unready !== null) {
      const report = environmentReport(
        source.environment,
        () => ({
          isPending: failure?.isPending ?? false,
          error: failure?.error ?? null,
          result: failure?.error === null ? (cached?.[0] ?? null) : null,
        }),
        cached?.[0],
        previousReport,
      );
      reports.push(report);
      if (failure !== undefined) {
        pages.push({ environmentId, offset: failure.offset });
        awaitingPage ||= failure.awaitingEarlierPage;
      }
      cached?.forEach((page, index) => append(queue, index * pageSize, page));
      queue.nextOffset = null;
      queues.push(queue);
      continue;
    }

    answeredPages.set(environmentId, []);
    const first = readPage(source, 0);
    if (first.failure !== undefined) return { failure: first.failure };
    const report = environmentReport(source.environment, () => first.read, null, previousReport);
    reports.push(report);
    if (report.result === null) {
      awaitingPage = true;
      continue;
    }
    append(queue, 0, report.result);
    queues.push(queue);
  }

  const compare = compareAcrossEnvironments(order.direction);
  const chats: MonitoringChat[] = [];
  merging: while (chats.length < order.limit) {
    for (const queue of queues) {
      while (queue.next === queue.rows.length && queue.nextOffset !== null) {
        const offset = queue.nextOffset;
        const page = readPage(queue.source, offset);
        if (page.failure !== undefined) return { failure: page.failure };
        if (page.read.result === null) {
          awaitingPage = true;
          const stopped = reports.findIndex(
            (report) => report.environmentId === queue.environmentId,
          );
          reports[stopped] = { ...reports[stopped]!, isPending: true };
          break merging;
        }
        append(queue, offset, page.read.result);
      }
    }
    let first: ChatQueue | null = null;
    for (const queue of queues) {
      if (
        queue.next < queue.rows.length &&
        (first === null || compare(queue.rows[queue.next]!, first.rows[first.next]!) < 0)
      ) {
        first = queue;
      }
    }
    if (first === null) break;
    chats.push(first.rows[first.next]!.chat);
    first.next += 1;
  }

  for (const [environmentId, answers] of answeredPages) {
    if (!pendingEnvironments.has(environmentId)) cachedPages.set(environmentId, answers);
  }
  let total = 0;
  for (const { result } of reports) total += result?.total ?? 0;
  const status = reportStatus(reports);
  return {
    view: {
      ...status,
      complete: status.complete && pendingEnvironments.size === 0,
      chats,
      total,
      pages,
      awaitingPage,
      cachedPages,
      failedOffsets: new Map(
        Array.from(failed).flatMap(([id, failure]) =>
          failure.error === null ? [] : [[id, failure.offset]],
        ),
      ),
      keptPendingPages: Array.from(failed.values()).some((failure) => failure.error === null),
    },
  };
}

/** A chat list on screen: the question and the answer it shows. */
export interface MonitoringChatsShown {
  readonly request: MonitoringChatsRequest;
  readonly view: MonitoringChatsView;
}

/**
 * Keep the rows visible while the period or scope changes, a contributing environment reconnects
 * or fails, or a later read would show fewer rows until the pages catch up.
 */
export function keepsShownChats(shown: MonitoringChatsShown, next: MonitoringChatsShown): boolean {
  const oldEnvironments = shown.view.availableEnvironmentIds;
  const newEnvironments = next.view.availableEnvironmentIds;
  if (
    oldEnvironments.length !== newEnvironments.length ||
    oldEnvironments.some((id) => !newEnvironments.includes(id))
  )
    return false;
  const scope = ({ request }: MonitoringChatsShown) =>
    JSON.stringify([request.window, request.filters]);
  if (scope(next) !== scope(shown)) {
    return shown.view.chats.length > 0 && next.view.awaitingPage;
  }
  if (!next.view.awaitingPage || next.view.keptPendingPages) return false;
  const asked = new Set(shown.view.pages.map(({ environmentId }) => environmentId));
  const failures = new Map(shown.view.unreadable.map((report) => [report.environmentId, report]));
  const sameRequest = JSON.stringify(next.request) === JSON.stringify(shown.request);
  const readAgain = !shown.view.awaitingPage && sameRequest;
  // Keeps the note, and the Retry button a keyboard user just pressed, until the failure answers.
  const retrying =
    sameRequest &&
    next.view.environments.some(
      ({ environmentId, isPending }) => isPending && failures.has(environmentId),
    );
  const shownChats = shown.view.chats.length;
  const nextChats = next.view.chats.length;
  return (
    (nextChats < shownChats || readAgain || (retrying && nextChats === shownChats)) &&
    next.view.environments.every(({ environmentId, error, result, isPending, retryable }) => {
      const failure = failures.get(environmentId);
      if (error !== null) return failure?.error === error && failure.retryable === retryable;
      // A failure nothing asks again has cleared, such as an offline environment now connecting.
      if (result === null) return failure === undefined || isPending;
      return asked.has(environmentId);
    })
  );
}

export function presentMonitoringChats(shown: MonitoringChatsShown, next: MonitoringChatsShown) {
  const { request, view } = next;
  const keep = keepsShownChats(shown, next);
  const displayed = keep ? shown.view : view;
  const retry = failureRetry(view.unreadable.length > 0 ? view : displayed, view);
  const unreadable =
    retry === "busy" && view.unreadable.length === 0 ? displayed.unreadable : view.unreadable;
  const sameRequest = JSON.stringify(shown.request) === JSON.stringify(request);
  // Pending pages can still be displayed as a coherent answer from the same read.
  const waiting =
    keep && sameRequest
      ? view.waiting.filter(
          (report) =>
            !report.isPending ||
            !shown.view.environments.some(
              (previous) =>
                previous.environmentId === report.environmentId &&
                previous.result !== null &&
                !previous.stale,
            ),
        )
      : view.waiting;
  const stale = !sameRequest || waiting.length > 0 || unreadable.length > 0;
  return {
    keep,
    view: keep
      ? {
          ...view,
          unreadable,
          waiting,
          stale,
          chats: displayed.chats,
          total: displayed.total,
          complete: !stale && displayed.complete,
          isLoading: false,
          failed: false,
        }
      : view,
    updating: view.awaitingPage,
    retry,
    sortedBy: keep ? shown.request.order : request.order,
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
