import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import {
  scheduledTaskGroupUsage,
  scheduledTaskStatsRange,
} from "@t3tools/client-runtime/scheduled-task-groups";
import { formatCount, formatUsd } from "@t3tools/shared/usageFormat";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { t, tn } from "~/i18n";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { supportsScheduledTaskGroups, useScheduledTaskStats } from "../../state/scheduledTaskStats";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { Button } from "../ui/button";

const warningTone = (count: number) => (count > 0 ? "text-warning-foreground" : undefined);

/** Usage's Refresh asks again too, after the usage refresh has updated the prices runs cost at. */
export function refreshScheduledTaskGroupUsage(
  registry: AtomRegistry.AtomRegistry,
  environmentIds: ReadonlyArray<EnvironmentId>,
  period: UsageSummaryInput,
) {
  const range = scheduledTaskStatsRange(period);
  if (range === null) return;
  for (const environmentId of environmentIds) {
    registry.refresh(serverEnvironment.scheduledTaskStats({ environmentId, input: range }));
  }
}

/** What each group of scheduled tasks ran and cost in the period the page shows. */
export function UsageScheduledTaskGroups({
  period,
  environments,
}: {
  readonly period: UsageSummaryInput;
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const registry = useContext(RegistryContext);
  const presentations = useEnvironments().environments;
  const connected = environments.filter((environment) => environment.isConnected);
  const supportedIds = connected.flatMap((environment) =>
    supportsScheduledTaskGroups(
      presentations.find((entry) => entry.environmentId === environment.environmentId),
    )
      ? [environment.environmentId]
      : [],
  );
  const unsupported = connected.filter(
    (environment) => !supportedIds.includes(environment.environmentId),
  );
  const range = scheduledTaskStatsRange(period);
  const input = range ?? { since: period.sinceDay };
  const results = useScheduledTaskStats(range === null ? [] : supportedIds, input);
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
  const loading = results.some((result) => result.stats === null && result.error === null);
  const rows = scheduledTaskGroupUsage(
    results.flatMap((result) => (result.stats === null ? [] : [result.stats])),
  ).filter((row) => row.runs > 0);
  const answered = results.some((result) => result.stats !== null);

  return (
    <section className="flex flex-col gap-3" aria-busy={loading}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">{t("Scheduled task groups")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Estimated API-equivalent cost of the turns scheduled task runs started.")}
        </p>
      </div>

      {unsupported.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("Not available on {environments}: they run an older T3.CodeShip.", {
            environments: unsupported.map((environment) => environment.label).join(", "),
          })}
        </p>
      ) : null}

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
              registry.refresh(
                serverEnvironment.scheduledTaskStats({
                  environmentId: failure.environmentId,
                  input,
                }),
              )
            }
          >
            {t("Retry")}
          </Button>
        </div>
      ))}

      {loading && !answered ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Loading…")}
        </p>
      ) : rows.length === 0 ? (
        answered ? (
          <p className="py-2 text-sm text-muted-foreground">
            {t("No scheduled task runs in this period.")}
          </p>
        ) : null
      ) : (
        <div className="overflow-x-auto">
          <table className={cn("w-full text-sm", loading && "opacity-64")}>
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
              {rows.map((row) => (
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
