import type {
  MonitoringBreakdownGroup,
  MonitoringChatRow,
  MonitoringCommandPhase,
  MonitoringFindingCode,
  MonitoringFindingRollup,
  MonitoringFindingSeverity,
  MonitoringOverviewInput,
  MonitoringOverviewResult,
  MonitoringThreadSummary,
  MonitoringTimeBuckets,
  ProjectId,
  UsageDay,
} from "@t3tools/contracts";
import {
  compareFindingRollups,
  compareMonitoringChatRows,
  moreSevere,
  sketchDurations,
  TIME_BUCKET_KEYS,
  topMonitoringOutliers,
} from "@t3tools/shared/monitoring";
import { enumerateDays } from "@t3tools/shared/usageFormat";

/** One analyzed chat of the window; `summary` already carries the thread's current title and project. */
export interface OverviewRow {
  readonly summary: MonitoringThreadSummary;
  /** The settle's calendar day in the requested zone. */
  readonly dayKey: string;
}

interface GroupAccumulator {
  chats: number;
  lifetimes: number[];
  actives: number[];
  costUsd: number;
  findings: number;
}

function addToGroup(groups: Map<string, GroupAccumulator>, key: string, row: MonitoringChatRow) {
  let group = groups.get(key);
  if (group === undefined) {
    group = { chats: 0, lifetimes: [], actives: [], costUsd: 0, findings: 0 };
    groups.set(key, group);
  }
  group.chats += 1;
  group.lifetimes.push(row.lifetimeMs);
  group.actives.push(row.activeMs);
  group.costUsd += row.costUsd;
  group.findings += row.findings;
}

const finishGroups = (groups: ReadonlyMap<string, GroupAccumulator>) =>
  [...groups]
    .map(([key, group]): MonitoringBreakdownGroup => ({
      key,
      chats: group.chats,
      lifetime: sketchDurations(group.lifetimes),
      active: sketchDurations(group.actives),
      costUsd: group.costUsd,
      findings: group.findings,
    }))
    .toSorted((a, b) => b.chats - a.chats || b.costUsd - a.costUsd);

const rowOf = (summary: MonitoringThreadSummary): MonitoringChatRow => ({
  threadId: summary.threadId,
  projectId: summary.projectId,
  title: summary.title,
  kind: summary.kind,
  model: summary.models[0] ?? "",
  settledAt: summary.settledAt,
  lifetimeMs: summary.lifetimeMs,
  activeMs: summary.activeMs,
  costUsd: summary.costUsd,
  failures: summary.runs.failed + summary.commands.failed,
  findings: summary.findings.length,
});

/**
 * Folds one window's rows into the overview, one row at a time so a caller never holds every decoded
 * summary. Rows whose day is outside the window are ignored.
 */
export function makeOverviewFold(input: MonitoringOverviewInput) {
  const dayList = enumerateDays(input.sinceDay, input.untilDay);
  const days = new Map(
    dayList.map((day) => [day, { chats: 0, lifetimes: [] as number[], activeMs: 0, costUsd: 0 }]),
  );
  const projectIds = new Set<ProjectId>();
  const kinds = new Set<MonitoringChatRow["kind"]>();
  const models = new Set<string>();

  const scoped: MonitoringChatRow[] = [];
  const listed: MonitoringChatRow[] = [];
  const time = Object.fromEntries(TIME_BUCKET_KEYS.map((key) => [key, 0])) as {
    -readonly [K in keyof MonitoringTimeBuckets]: number;
  };
  const phases = new Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >();
  const findings = new Map<
    MonitoringFindingCode,
    { chats: number; occurrences: number; wastedMs: number; severity: MonitoringFindingSeverity }
  >();
  const lifetimes: number[] = [];
  const actives: number[] = [];
  const projectGroups = new Map<string, GroupAccumulator>();
  const kindGroups = new Map<string, GroupAccumulator>();
  const modelGroups = new Map<string, GroupAccumulator>();
  const totals = {
    lifetimeMs: 0,
    activeMs: 0,
    costUsd: 0,
    unpricedTurns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runs: 0,
    failedRuns: 0,
    userPrompts: 0,
    helpers: 0,
    findings: 0,
  };

  const add = ({ summary, dayKey }: OverviewRow) => {
    const day = days.get(dayKey);
    if (day === undefined) return;
    const row = rowOf(summary);
    projectIds.add(summary.projectId);
    kinds.add(summary.kind);
    models.add(row.model);

    const inScope =
      (input.projectId === undefined || summary.projectId === input.projectId) &&
      (input.kind === undefined || summary.kind === input.kind) &&
      (input.model === undefined || row.model === input.model);
    if (!inScope) return;
    scoped.push(row);
    if (
      input.findingCode === undefined ||
      summary.findings.some((finding) => finding.code === input.findingCode)
    ) {
      listed.push(row);
    }

    day.chats += 1;
    day.lifetimes.push(row.lifetimeMs);
    day.activeMs += row.activeMs;
    day.costUsd += row.costUsd;

    totals.lifetimeMs += summary.lifetimeMs;
    totals.activeMs += summary.activeMs;
    totals.costUsd += summary.costUsd;
    totals.unpricedTurns += summary.unpricedTurns;
    totals.inputTokens += summary.tokens.inputTokens;
    totals.cachedInputTokens += summary.tokens.cachedInputTokens;
    totals.outputTokens += summary.tokens.outputTokens;
    totals.runs += summary.runs.total;
    totals.failedRuns += summary.runs.failed;
    totals.userPrompts += summary.runs.userPrompts;
    totals.helpers +=
      summary.helpers.subagents +
      summary.helpers.delegates +
      summary.helpers.commands +
      summary.helpers.workflows;
    totals.findings += summary.findings.length;
    lifetimes.push(summary.lifetimeMs);
    actives.push(summary.activeMs);
    for (const key of TIME_BUCKET_KEYS) time[key] += summary.time[key];

    for (const stats of summary.phases) {
      const entry = phases.get(stats.phase) ?? { count: 0, failed: 0, durationMs: 0 };
      entry.count += stats.count;
      entry.failed += stats.failed;
      entry.durationMs += stats.durationMs;
      phases.set(stats.phase, entry);
    }

    const seenCodes = new Set<MonitoringFindingCode>();
    for (const finding of summary.findings) {
      const entry = findings.get(finding.code) ?? {
        chats: 0,
        occurrences: 0,
        wastedMs: 0,
        severity: finding.severity,
      };
      if (!seenCodes.has(finding.code)) {
        seenCodes.add(finding.code);
        entry.chats += 1;
      }
      entry.occurrences += finding.count;
      entry.wastedMs += finding.wastedMs;
      entry.severity = moreSevere(entry.severity, finding.severity);
      findings.set(finding.code, entry);
    }

    addToGroup(projectGroups, summary.projectId, row);
    addToGroup(kindGroups, summary.kind, row);
    addToGroup(modelGroups, row.model, row);
  };

  const finish = (): Omit<MonitoringOverviewResult, "pendingAnalysis" | "failedAnalysis"> => ({
    totals: {
      chats: scoped.length,
      lifetimeMs: totals.lifetimeMs,
      activeMs: totals.activeMs,
      lifetime: sketchDurations(lifetimes),
      active: sketchDurations(actives),
      time,
      costUsd: totals.costUsd,
      unpricedTurns: totals.unpricedTurns,
      tokens: {
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
      },
      runs: totals.runs,
      failedRuns: totals.failedRuns,
      userPrompts: totals.userPrompts,
      helpers: totals.helpers,
      findings: totals.findings,
    },
    phases: [...phases]
      .filter(([, entry]) => entry.count > 0)
      .map(([phase, entry]) => ({ phase, ...entry }))
      .toSorted((a, b) => b.durationMs - a.durationMs),
    findings: [...findings]
      .map(([code, entry]): MonitoringFindingRollup => ({ code, ...entry }))
      .toSorted(compareFindingRollups),
    days: dayList.map((day) => {
      const entry = days.get(day)!;
      return {
        day: day as UsageDay,
        chats: entry.chats,
        lifetime: sketchDurations(entry.lifetimes),
        activeMs: entry.activeMs,
        costUsd: entry.costUsd,
      };
    }),
    breakdowns: {
      projects: finishGroups(projectGroups),
      kinds: finishGroups(kindGroups),
      models: finishGroups(modelGroups),
    },
    outliers: topMonitoringOutliers(scoped),
    chats: listed.toSorted(compareMonitoringChatRows(input.sort)).slice(0, input.chatLimit),
    listedChats: listed.length,
    options: {
      projectIds: [...projectIds].toSorted(),
      kinds: [...kinds].toSorted(),
      models: [...models].toSorted(),
    },
  });

  return { add, finish };
}
