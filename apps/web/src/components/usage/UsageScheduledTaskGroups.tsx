import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ScheduledTaskRunStats,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  scheduledTaskGroupUsage,
  scheduledTaskAccessNotice,
  scheduledTaskStatsRange,
} from "@t3tools/client-runtime/scheduled-task-groups";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";
import type { AtomRegistry } from "effect/reactivity";
import { useContext, useState } from "react";

import { t, tn } from "~/i18n";
import { cn } from "../../lib/utils";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { supportsScheduledTaskGroups, useScheduledTaskStats } from "../../state/scheduledTaskStats";
import { serverEnvironment } from "../../state/server";
import {
  environmentSession,
  environmentSessionStatesAtom,
  sessionHasScope,
} from "../../state/session";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";

const warningTone = (count: number) => (count > 0 ? "text-warning-foreground" : undefined);

function restoreSectionFocus(button: HTMLButtonElement | null) {
  if (!button) return;
  return () => {
    if (document.activeElement === button) button.closest("section")?.querySelector("h2")?.focus();
  };
}

/** Usage's Refresh asks again too, after the usage refresh has updated the prices runs cost at. */
export function refreshScheduledTaskGroupUsage(
  registry: AtomRegistry.AtomRegistry,
  environmentIds: ReadonlyArray<EnvironmentId>,
  period: UsageSummaryInput,
) {
  const range = scheduledTaskStatsRange(period);
  if (range === null) return;
  for (const environmentId of environmentIds) {
    const grant = registry.get(environmentSession.sessionStateAtom(environmentId));
    if (!sessionHasScope(grant, AuthOrchestrationReadScope)) continue;
    registry.refresh(serverEnvironment.scheduledTaskStats({ environmentId, input: range }));
  }
}

/** What each group of scheduled tasks ran and cost in the period the page shows. */
export function UsageScheduledTaskGroups({
  selectionKey,
  period,
  environments,
}: {
  readonly selectionKey: string;
  readonly period: UsageSummaryInput;
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const registry = useContext(RegistryContext);
  const presentations = useEnvironments().environments;
  const connected = environments.filter((environment) => environment.isConnected);
  const support = connected.map((environment) => ({
    ...environment,
    supported: supportsScheduledTaskGroups(
      presentations.find((entry) => entry.environmentId === environment.environmentId),
    ),
  }));
  const supportedIds = support
    .filter((env) => env.supported === true)
    .map((env) => env.environmentId);
  const unsupported = support.filter((env) => env.supported === false);
  const checkingSupport = support.filter((env) => env.supported === null);
  const grants = useAtomValue(environmentSessionStatesAtom(environmentIdsKey(supportedIds)));
  const readableIds = supportedIds.filter((_, index) =>
    sessionHasScope(grants[index]!, AuthOrchestrationReadScope),
  );
  const pendingGrants = new Set(
    supportedIds.filter((_, index) => grants[index]!._tag === "Initial"),
  );
  const range = scheduledTaskStatsRange(period);
  const input = range ?? { since: period.sinceDay };
  const results = useScheduledTaskStats(range === null ? [] : readableIds, input);
  const key = JSON.stringify([selectionKey, supportedIds.toSorted()]);
  type Reading = readonly [EnvironmentId, readonly ScheduledTaskRunStats[]];
  const [last, setLast] = useState<{
    readonly key: string;
    readonly readings: readonly Reading[];
  } | null>(null);
  const retained = new Map(last?.key === key ? last.readings : []);
  const readings = results.flatMap(({ environmentId, stats, error }): Reading[] => {
    if (error !== null) return [];
    const available = stats ?? retained.get(environmentId);
    return available === undefined ? [] : [[environmentId, available]];
  });
  if (
    (last !== null || readings.length > 0) &&
    (last?.key !== key || JSON.stringify(last.readings) !== JSON.stringify(readings))
  )
    setLast({ key, readings });
  const loadingStats = results.some(({ stats, error }) => stats === null && error === null);
  const displayedRows = scheduledTaskGroupUsage(readings.map(([, stats]) => stats)).filter(
    (row) => row.runs > 0,
  );
  const showLoading = loadingStats && readings.length === 0;
  if (connected.length === 0 || range === null) return null;

  const failures = results.flatMap((result) =>
    result.error === null
      ? []
      : [
          {
            environmentId: result.environmentId,
            label:
              environments.find((entry) => entry.environmentId === result.environmentId)?.label ??
              result.environmentId,
            error: result.error,
          },
        ],
  );
  return (
    <section
      className="flex flex-col gap-3"
      aria-busy={loadingStats || pendingGrants.size > 0 || checkingSupport.length > 0}
    >
      <div className="flex flex-col gap-1">
        <h2 tabIndex={-1} className="text-sm font-medium text-foreground">
          {t("Scheduled task groups")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t("Estimated API-equivalent cost of the turns scheduled task runs started.")}
        </p>
      </div>

      {checkingSupport.map((environment) => (
        <p key={environment.environmentId} role="status" className="text-xs text-muted-foreground">
          {t("Checking scheduled task support on {environment}…", {
            environment: environment.label,
          })}
        </p>
      ))}
      {unsupported.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Not available on {environments}: they run an older T3.CodeShip.", {
            environments: unsupported.map((environment) => environment.label).join(", "),
          })}
        </p>
      ) : null}

      {connected
        .filter(
          ({ environmentId }) =>
            supportedIds.includes(environmentId) && !readableIds.includes(environmentId),
        )
        .map(({ environmentId, label }) => {
          const grant = grants[supportedIds.indexOf(environmentId)]!;
          const message = scheduledTaskAccessNotice(grant, label);
          if (grant._tag === "Failure") {
            return (
              <div
                key={environmentId}
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <p className="min-w-0 break-words">{message}</p>
                <Button
                  size="xs"
                  variant="outline"
                  ref={restoreSectionFocus}
                  aria-disabled={grant.waiting}
                  onClick={() =>
                    !grant.waiting &&
                    registry.refresh(environmentSession.sessionStateAtom(environmentId))
                  }
                >
                  {t("Retry")}
                </Button>
              </div>
            );
          }
          return (
            <p key={environmentId} role="status" className="text-xs text-muted-foreground">
              {message}
            </p>
          );
        })}

      {failures.map((failure) => (
        <div
          key={failure.environmentId}
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
        >
          <p className="min-w-0 break-words">
            {t("Could not load scheduled task runs: {label}: {error}", {
              label: failure.label,
              error: failure.error,
            })}
          </p>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              refreshScheduledTaskGroupUsage(registry, [failure.environmentId], period)
            }
          >
            {t("Retry")}
          </Button>
        </div>
      ))}

      {showLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Loading…")}
        </p>
      ) : displayedRows.length === 0 ? (
        readings.length > 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {t("No scheduled task runs in this period.")}
          </p>
        ) : null
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="w-full py-2 text-left font-normal">{t("Group")}</th>
                <th className="py-2 pl-6 font-normal">{t("Runs")}</th>
                <th className="py-2 pl-6 font-normal">{t("Failed")}</th>
                <th className="py-2 pl-6 font-normal">{t("Limited")}</th>
                <th className="py-2 pl-6 font-normal">{t("Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => (
                <tr
                  key={row.key ?? "none"}
                  className="border-b border-border/50 text-right text-muted-foreground tabular-nums"
                >
                  <td className="py-2.5 text-left whitespace-normal">
                    <span className="block break-words text-foreground">
                      {row.label ?? t("No group")}
                    </span>
                    <span className="block text-2xs">
                      {tn(row.tasks, "{count} task", "{count} tasks")}
                    </span>
                  </td>
                  <td className="py-2.5 pl-6 text-foreground">{formatCount(row.runs)}</td>
                  <td className={cn("py-2.5 pl-6", warningTone(row.failed))}>
                    {formatCount(row.failed)}
                  </td>
                  <td className={cn("py-2.5 pl-6", warningTone(row.usageLimited))}>
                    {formatCount(row.usageLimited)}
                  </td>
                  <td className="py-2.5 pl-6 text-foreground">
                    {formatUsd(row.costUsd)}
                    {row.unpricedRuns > 0 ? (
                      <span className="block text-2xs font-normal whitespace-nowrap text-muted-foreground">
                        {tn(row.unpricedRuns, "+{count} run unpriced", "+{count} runs unpriced")}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
