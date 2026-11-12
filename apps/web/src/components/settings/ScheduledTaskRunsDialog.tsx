import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { peerNoWorkText, runCheckText } from "@t3tools/client-runtime/scheduled-task-run-condition";
import { mergeScheduledTaskRuns } from "@t3tools/client-runtime/scheduled-task-sharing";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskRunRecord,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { t } from "~/i18n";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
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

const runsQueryAtom = (environmentId: EnvironmentId, id: ScheduledTaskId) =>
  serverEnvironment.scheduledTaskRuns({ environmentId, input: { id } });

/** Keyed by the task id, then the ids of the machines whose runs to read. */
const scheduledTaskRunListsAtom = Atom.family((key: string) => {
  const [id, ...environmentIds] = key.split("\n") as [ScheduledTaskId, ...EnvironmentId[]];
  return Atom.make((get) =>
    environmentIds.map((environmentId) => ({
      environmentId,
      result: get(runsQueryAtom(environmentId, id)),
    })),
  ).pipe(Atom.withLabel(`web-scheduled-task-run-lists:${key}`));
});

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

function skipReasonText(
  run: ScheduledTaskRunRecord,
  machine: string,
  machineLabel: (id: EnvironmentId) => string,
) {
  switch (run.skipReason) {
    case "missed":
      return t("{machine} was off or asleep at that time, and catching up is off.", { machine });
    case "next_run_sooner":
      return t("{machine} was off or asleep at that time, and the next run comes sooner.", {
        machine,
      });
    case "no_work":
      return runCheckText(run.check) ?? t("The check found no work.");
    case "ran_elsewhere":
      if (run.check?.outcome === "skip") {
        return peerNoWorkText(
          run.ranOn === null ? null : machineLabel(run.ranOn),
          run.check.detail,
        );
      }
      return run.ranOn === null
        ? t("Another machine ran it.")
        : t("{machine} ran it.", { machine: machineLabel(run.ranOn) });
    case "unconfirmed":
      return t(
        "{machine} couldn't reach enough of the other machines to make sure no other machine would run it, so it didn't run it.",
        { machine },
      );
    default:
      return run.skipReason;
  }
}

function FailoverNote({
  environmentId,
  failover,
}: {
  readonly environmentId: EnvironmentId;
  readonly failover: NonNullable<ScheduledTaskRunRecord["failover"]>;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const accountName = (instanceId: string) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider ? resolveProviderInstanceDisplayName(provider) : instanceId;
  };
  return (
    <p className="text-muted-foreground">
      {t("Started on {to} because {from} was out of usage.", {
        to: accountName(failover.to),
        from: accountName(failover.from),
      })}
    </p>
  );
}

/**
 * The task's recent runs, including fires that failed before a thread existed or were skipped.
 * A shared task passes every machine holding it, and their runs read as one history.
 */
export function ScheduledTaskRunsDialog({
  environmentId,
  environmentIds = [environmentId],
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const lists = useAtomValue(scheduledTaskRunListsAtom([task.id, ...environmentIds].join("\n")));
  const registry = useContext(RegistryContext);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const machineLabel = (id: EnvironmentId) => {
    const entry = environments.find((candidate) => candidate.environmentId === id);
    return entry ? settingsScopeEnvironmentLabel(entry, environments) : id;
  };
  const severalMachines = environmentIds.length > 1;
  const loaded = lists.flatMap(({ environmentId: id, result }) => {
    const data = AsyncResult.getOrElse(result, () => null);
    return data === null ? [] : [{ environmentId: id, runs: data.runs }];
  });
  const errors = lists.flatMap(({ environmentId: id, result }) =>
    result._tag === "Failure"
      ? [{ environmentId: id, error: formatEnvironmentQueryError(result.cause) }]
      : [],
  );
  const pending = lists.some(({ result }) => result.waiting);
  const runs = loaded.length > 0 ? mergeScheduledTaskRuns(loaded) : null;

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
            {severalMachines
              ? t(
                  "Each time this task fired on any of its machines, including runs that failed or were skipped.",
                )
              : t(
                  "Each time this task fired on {machine}, including runs that failed or were skipped.",
                  { machine: machineLabel(environmentId) },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {errors.map(({ environmentId: id, error }) => (
            <p key={id} className="text-sm text-destructive-foreground">
              {severalMachines
                ? t("Could not load runs from {machine}: {error}", {
                    machine: machineLabel(id),
                    error,
                  })
                : error}
            </p>
          ))}
          {runs === null ? (
            errors.length === lists.length ? null : (
              <p className="text-sm text-muted-foreground" role="status">
                {t("Loading runs…")}
              </p>
            )
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No runs yet.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map(({ environmentId: ranOn, run }) => {
                const badge = outcomeBadge(run.outcome);
                const threadId = run.threadId;
                const checkText = runCheckText(run.check);
                return (
                  <li key={`${ranOn}:${run.id}`} className="space-y-1 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <span>{formatDayAwareTimestamp(run.startedAt, timestampFormat)}</span>
                      {severalMachines ? (
                        <span className="font-medium">{machineLabel(ranOn)}</span>
                      ) : null}
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
                              params: buildThreadRouteParams(scopeThreadRef(ranOn, threadId)),
                            });
                          }}
                        >
                          {t("Open thread")}
                        </Button>
                      ) : null}
                    </div>
                    {run.outcome === "skipped" ? (
                      <p className="text-muted-foreground">
                        {skipReasonText(run, machineLabel(ranOn), machineLabel)}
                      </p>
                    ) : null}
                    {run.skipReason !== "no_work" &&
                    !(run.skipReason === "ran_elsewhere" && run.check?.outcome === "skip") &&
                    checkText !== null ? (
                      <p className="text-muted-foreground">{checkText}</p>
                    ) : null}
                    {run.failover !== null ? (
                      <FailoverNote environmentId={ranOn} failover={run.failover} />
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
            disabled={pending}
            onClick={() => {
              for (const id of environmentIds) registry.refresh(runsQueryAtom(id, task.id));
            }}
          >
            {t("Refresh")}
          </Button>
          <DialogClose render={<Button size="sm" />}>{t("Done")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
