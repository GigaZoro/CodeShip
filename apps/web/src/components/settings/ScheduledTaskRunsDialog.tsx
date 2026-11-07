import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ScheduledTask, ScheduledTaskRunRecord } from "@t3tools/contracts";

import { t } from "~/i18n";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

function outcomeBadge(outcome: ScheduledTaskRunRecord["outcome"]) {
  switch (outcome) {
    case "running":
      return { variant: "info" as const, label: t("running") };
    case "succeeded":
      return { variant: "success" as const, label: t("started") };
    case "failed":
      return { variant: "error" as const, label: t("failed") };
    case "skipped":
      return { variant: "warning" as const, label: t("skipped") };
    default:
      return { variant: "outline" as const, label: outcome };
  }
}

function triggerLabel(trigger: ScheduledTaskRunRecord["trigger"]) {
  switch (trigger) {
    case "scheduled":
      return t("On schedule");
    case "catch_up":
      return t("Caught up");
    case "manual":
      return t("Run now");
    case "webhook":
      return t("Webhook");
    default:
      return trigger;
  }
}

function skipReasonText(run: ScheduledTaskRunRecord, machineLabel: (id: EnvironmentId) => string) {
  switch (run.skipReason) {
    case "missed":
      return t("This machine was off or asleep at that time, and catching up is off.");
    case "next_run_sooner":
      return t("This machine was off or asleep at that time, and the next run comes sooner.");
    case "ran_elsewhere":
      return run.ranOn === null
        ? t("Another machine ran it.")
        : t("{machine} ran it.", { machine: machineLabel(run.ranOn) });
    default:
      return run.skipReason;
  }
}

/** The task's recent runs, including fires that failed before a thread existed or were skipped. */
export function ScheduledTaskRunsDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const runsQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: task.id } }),
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const accountName = (instanceId: string) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider ? resolveProviderInstanceDisplayName(provider) : instanceId;
  };
  const machineLabel = (id: EnvironmentId) => {
    const entry = environments.find((candidate) => candidate.environmentId === id);
    return entry ? settingsScopeEnvironmentLabel(entry, environments) : id;
  };
  const runs = runsQuery.data?.runs ?? null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("Run history · {name}", { name: task.title })}</DialogTitle>
          <DialogDescription>
            {t("Each time this task fired here, including runs that failed or were skipped.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {runsQuery.error ? (
            <p className="text-sm text-destructive-foreground">{runsQuery.error}</p>
          ) : null}
          {runs === null ? (
            runsQuery.error ? null : (
              <p className="text-sm text-muted-foreground" role="status">
                {t("Loading runs…")}
              </p>
            )
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No runs yet.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((run) => {
                const badge = outcomeBadge(run.outcome);
                const threadId = run.threadId;
                return (
                  <li key={run.id} className="space-y-1 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <span>{formatDayAwareTimestamp(run.startedAt, timestampFormat)}</span>
                      <span className="text-muted-foreground">{triggerLabel(run.trigger)}</span>
                      {run.scheduledFor !== null && run.trigger !== "scheduled" ? (
                        <span className="text-muted-foreground">
                          {t("for {time}", {
                            time: formatDayAwareTimestamp(run.scheduledFor, timestampFormat),
                          })}
                        </span>
                      ) : null}
                      {threadId !== null ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            onClose();
                            void navigate({
                              to: "/$environmentId/$threadId",
                              params: buildThreadRouteParams(
                                scopeThreadRef(environmentId, threadId),
                              ),
                            });
                          }}
                        >
                          {t("Open thread")}
                        </Button>
                      ) : null}
                    </div>
                    {run.outcome === "skipped" ? (
                      <p className="text-muted-foreground">{skipReasonText(run, machineLabel)}</p>
                    ) : null}
                    {run.failover !== null ? (
                      <p className="text-muted-foreground">
                        {t("Started on {to} because {from} was out of usage.", {
                          to: accountName(run.failover.to),
                          from: accountName(run.failover.from),
                        })}
                      </p>
                    ) : null}
                    {run.error !== null ? (
                      <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-words text-destructive-foreground">
                        {run.error}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={runsQuery.isPending}
            onClick={runsQuery.refresh}
          >
            {t("Refresh")}
          </Button>
          <DialogClose render={<Button size="sm" />}>{t("Done")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
