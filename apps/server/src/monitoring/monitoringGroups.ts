import type {
  MonitoringCommandPhase,
  MonitoringFindingCode,
  MonitoringFindingSeverity,
  MonitoringGroup,
  MonitoringThreadSummary,
  MonitoringTimeBuckets,
  MonitoringTokenTotals,
} from "@t3tools/contracts/monitoring";
import * as DateTime from "effect/DateTime";

const SEVERITY_RANK: Record<MonitoringFindingSeverity, number> = { high: 3, medium: 2, low: 1 };

type Counts<T> = { -readonly [K in keyof T]: number };

interface GroupState {
  readonly day: string;
  readonly projectId: MonitoringThreadSummary["projectId"];
  readonly kind: MonitoringThreadSummary["kind"];
  readonly model: string;
  readonly lifetimesMs: number[];
  readonly activesMs: number[];
  readonly time: Counts<MonitoringTimeBuckets>;
  readonly tokens: Counts<MonitoringTokenTotals>;
  costUsd: number;
  unpricedTurns: number;
  runs: number;
  failedRuns: number;
  userPrompts: number;
  helpers: number;
  readonly findings: Map<
    MonitoringFindingCode,
    { severity: MonitoringFindingSeverity; chats: number; occurrences: number; wastedMs: number }
  >;
  readonly phases: Map<
    MonitoringCommandPhase,
    { count: number; failed: number; durationMs: number }
  >;
}

const addCounts = <T extends object>(target: Counts<T>, source: T) => {
  const into = target as Record<string, number>;
  for (const [key, value] of Object.entries(source) as Array<[string, number]>) {
    into[key] = (into[key] ?? 0) + value;
  }
};

/** A requested day: its name and the epoch milliseconds it starts at. */
export interface MonitoringDayStart {
  readonly day: string;
  readonly startMs: number;
}

/**
 * Sums analyzed chats into one {@link MonitoringGroup} per day, project, kind and main model. A
 * chat counts on the last of `days` (oldest first) that started by the time it settled; the
 * window opens at the first one, so no chat it reads settled before that.
 */
export function makeMonitoringGroups(
  days: readonly [MonitoringDayStart, ...ReadonlyArray<MonitoringDayStart>],
) {
  const groups = new Map<string, GroupState>();
  const dayOf = (settledMs: number) => {
    let found = days[0];
    for (const entry of days) {
      if (entry.startMs > settledMs) break;
      found = entry;
    }
    return found.day;
  };

  return {
    add(summary: MonitoringThreadSummary, settledAt: DateTime.Utc): void {
      const day = dayOf(DateTime.toEpochMillis(settledAt));
      const model = summary.models[0] ?? "";
      const key = [day, summary.projectId, summary.kind, model].join("\u0000");
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          day,
          projectId: summary.projectId,
          kind: summary.kind,
          model,
          lifetimesMs: [],
          activesMs: [],
          time: {} as Counts<MonitoringTimeBuckets>,
          tokens: {} as Counts<MonitoringTokenTotals>,
          costUsd: 0,
          unpricedTurns: 0,
          runs: 0,
          failedRuns: 0,
          userPrompts: 0,
          helpers: 0,
          findings: new Map(),
          phases: new Map(),
        };
        groups.set(key, group);
      }
      group.lifetimesMs.push(summary.lifetimeMs);
      group.activesMs.push(summary.activeMs);
      addCounts(group.time, summary.time);
      addCounts(group.tokens, summary.tokens);
      group.costUsd += summary.costUsd;
      group.unpricedTurns += summary.unpricedTurns;
      group.runs += summary.runs.total;
      group.failedRuns += summary.runs.failed;
      group.userPrompts += summary.runs.userPrompts;
      group.helpers +=
        summary.helpers.subagents +
        summary.helpers.delegates +
        summary.helpers.commands +
        summary.helpers.workflows;
      const counted = new Set<MonitoringFindingCode>();
      for (const finding of summary.findings) {
        const entry = group.findings.get(finding.code) ?? {
          severity: finding.severity,
          chats: 0,
          occurrences: 0,
          wastedMs: 0,
        };
        if (!counted.has(finding.code)) {
          counted.add(finding.code);
          entry.chats += 1;
        }
        entry.occurrences += finding.count;
        entry.wastedMs += finding.wastedMs;
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[entry.severity]) {
          entry.severity = finding.severity;
        }
        group.findings.set(finding.code, entry);
      }
      for (const stats of summary.phases) {
        const entry = group.phases.get(stats.phase) ?? { count: 0, failed: 0, durationMs: 0 };
        entry.count += stats.count;
        entry.failed += stats.failed;
        entry.durationMs += stats.durationMs;
        group.phases.set(stats.phase, entry);
      }
    },

    groups(): ReadonlyArray<MonitoringGroup> {
      return [...groups.values()].map((group) => ({
        ...group,
        findings: [...group.findings].map(([code, entry]) => ({ code, ...entry })),
        phases: [...group.phases].map(([phase, entry]) => ({ phase, ...entry })),
      }));
    },
  };
}
