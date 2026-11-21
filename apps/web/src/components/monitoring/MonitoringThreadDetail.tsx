import { Link } from "@tanstack/react-router";
import type { EnvironmentId, MonitoringThreadDetail, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatMonitoringTime } from "@t3tools/client-runtime/monitoring";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ArrowLeftIcon, CircleAlertIcon, ExternalLinkIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { refreshMonitoringThread, useMonitoringThread } from "../../state/monitoring";
import { resolveHour12 } from "../../timestampFormat";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { MonitoringGantt } from "./MonitoringGantt";
import {
  MonitoringKpi,
  MonitoringRefreshButton,
  MonitoringSection,
  MonitoringTruncated,
} from "./MonitoringSection";
import { MonitoringTimeBar } from "./MonitoringTimeBar";
import {
  FINDING_DETAIL_LABELED,
  FINDING_TEXT,
  KIND_LABEL,
  PHASE_LABEL,
  SEVERITY_LABEL,
  findingExplanation,
} from "@t3tools/client-runtime/monitoring-text";
import { SEVERITY_BADGE_VARIANT } from "./monitoringText";
import { msg, t, tn } from "~/i18n";

const NUMBER_CELL = "text-right";

const SOURCE_LABEL = {
  user: msg("You"),
  automatic: msg("Automatic"),
  scheduled: msg("Scheduled"),
  agent: msg("Agent"),
  helpers: msg("Helpers finished"),
} as const;

export function MonitoringThreadDeepDive({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { detail, isPending, error } = useMonitoringThread(environmentId, threadId);

  return (
    <div className="flex flex-col gap-6">
      <Button
        render={<Link to="/monitoring" search={{}} />}
        variant="ghost"
        size="sm"
        className="self-start"
      >
        <ArrowLeftIcon aria-hidden />
        {t("All chats")}
      </Button>
      {error !== null ? (
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription>
            {detail
              ? t("Could not refresh this chat's analysis, so it may be out of date: {error}", {
                  error,
                })
              : t("Could not load this chat's analysis: {error}", { error })}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => refreshMonitoringThread(environmentId, threadId)}
            >
              {t("Retry")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {detail ? (
        <DeepDiveBody detail={detail} environmentId={environmentId} />
      ) : error !== null ? null : isPending ? (
        <div className="flex flex-col gap-4" aria-busy>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("This chat is not settled, not analyzed, or no longer exists.")}
        </p>
      )}
    </div>
  );
}

/** The header's Refresh while a chat is open: see `refreshMonitoringThread`. */
export function MonitoringThreadRefresh({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { isPending } = useMonitoringThread(environmentId, threadId);
  return (
    <MonitoringRefreshButton
      refreshing={isPending}
      onRefresh={() => refreshMonitoringThread(environmentId, threadId)}
    />
  );
}

function DeepDiveBody({
  detail,
  environmentId,
}: {
  readonly detail: MonitoringThreadDetail;
  readonly environmentId: EnvironmentId;
}) {
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const { summary } = detail;
  const input = summary.tokens.inputTokens;
  const workingMs = summary.time.agentMs + summary.time.commandMs + summary.time.toolMs;
  const helpers =
    summary.helpers.subagents +
    summary.helpers.delegates +
    summary.helpers.commands +
    summary.helpers.workflows;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-medium text-foreground">
            {summary.title || t("Untitled chat")}
          </h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge size="sm" variant="outline">
              {t(KIND_LABEL[summary.kind])}
            </Badge>
            <span>{summary.models.join(", ") || t("No model recorded")}</span>
            <span>
              {t("{from} to {to}", {
                from: formatMonitoringTime(summary.createdAt, hour12),
                to: formatMonitoringTime(summary.settledAt, hour12),
              })}
            </span>
            {summary.reopens > 0 ? (
              <Badge size="sm" variant="warning">
                {tn(summary.reopens, "Reopened once", "Reopened {count} times")}
              </Badge>
            ) : null}
          </p>
        </div>
        <Button
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: summary.threadId }}
            />
          }
          variant="outline"
          size="sm"
        >
          <ExternalLinkIcon aria-hidden />
          {t("Open chat")}
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <MonitoringKpi label={t("Lifetime")} value={formatDuration(summary.lifetimeMs)} />
        <MonitoringKpi
          label={t("Active time")}
          value={formatDuration(summary.activeMs)}
          hint={t("{share} of lifetime working", {
            share: formatPercent(summary.lifetimeMs > 0 ? workingMs / summary.lifetimeMs : 0, 0),
          })}
        />
        <MonitoringKpi
          label={t("Cost")}
          value={formatUsd(summary.costUsd)}
          hint={
            summary.unpricedTurns > 0
              ? tn(summary.unpricedTurns, "{count} turn unpriced", "{count} turns unpriced")
              : undefined
          }
        />
        <MonitoringKpi
          label={t("Runs")}
          value={formatCount(summary.runs.total)}
          hint={tn(
            summary.runs.userPrompts,
            "{failed} failed, {count} prompt",
            "{failed} failed, {count} prompts",
            { failed: summary.runs.failed },
          )}
        />
        <MonitoringKpi
          label={t("Commands")}
          value={formatCount(summary.commands.count)}
          hint={t("{failed} failed, {duration}", {
            failed: summary.commands.failed,
            duration: formatDuration(summary.commands.durationMs),
          })}
        />
        <MonitoringKpi
          label={t("Tokens")}
          value={t("{input} in, {output} out", {
            input: formatTokens(input),
            output: formatTokens(summary.tokens.outputTokens),
          })}
          hint={
            input > 0
              ? t("{percent} from cache", {
                  percent: formatPercent(summary.tokens.cachedInputTokens / input, 0),
                })
              : undefined
          }
        />
        <MonitoringKpi label={t("Files changed")} value={formatCount(summary.filesChanged)} />
        <MonitoringKpi label={t("Helpers")} value={formatCount(helpers)} />
      </dl>

      <MonitoringSection title={t("Where the time went")}>
        <MonitoringTimeBar buckets={summary.time} />
      </MonitoringSection>

      <MonitoringSection
        title={t("Timeline")}
        description={t("The chat's own runs, then each helper, with the events that shaped them.")}
      >
        <MonitoringGantt detail={detail} />
      </MonitoringSection>

      <MonitoringSection title={t("Weak points")}>
        {summary.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No weak points found.")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {summary.findings.map((finding) => {
              const text = FINDING_TEXT[finding.code];
              return (
                <li key={finding.code} className="flex flex-col gap-1 px-3 py-2.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{t(text.title)}</span>
                    <Badge variant={SEVERITY_BADGE_VARIANT[finding.severity]} size="sm">
                      {t(SEVERITY_LABEL[finding.severity])}
                    </Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {finding.wastedMs > 0
                        ? t("{count} times, {duration} lost", {
                            count: finding.count,
                            duration: formatDuration(finding.wastedMs),
                          })
                        : tn(finding.count, "{count} time", "{count} times")}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {findingExplanation(finding)}
                  </span>
                  {FINDING_DETAIL_LABELED.has(finding.code) && finding.detail ? (
                    <MonitoringTruncated
                      as="code"
                      text={finding.detail}
                      className="text-xs text-foreground"
                    />
                  ) : null}
                  {text.advice ? (
                    <span className="text-xs text-foreground">{t(text.advice)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </MonitoringSection>

      <MonitoringSection
        title={t("Steps")}
        description={t("One row per run and the prompt that started it.")}
      >
        <div className="tabular-nums">
          <Table aria-label={t("Runs")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Prompt")}</TableHead>
                <TableHead>{t("Model")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Queued")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Duration")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Output tokens")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Cost")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Commands")}</TableHead>
                <TableHead className={NUMBER_CELL}>{t("Files")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.steps.map((step) => (
                <TableRow key={step.runId}>
                  <TableCell className="max-w-72">
                    <MonitoringTruncated
                      text={step.prompt || t("(no prompt)")}
                      className="text-foreground"
                    />
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge size="sm" variant="outline">
                        {t(SOURCE_LABEL[step.source])}
                      </Badge>
                      <span>{step.status}</span>
                    </span>
                  </TableCell>
                  <TableCell className="max-w-32">
                    <MonitoringTruncated text={step.model ?? "-"} />
                  </TableCell>
                  <TableCell className={NUMBER_CELL}>{formatDuration(step.queuedMs)}</TableCell>
                  <TableCell className={NUMBER_CELL}>{formatDuration(step.durationMs)}</TableCell>
                  <TableCell className={NUMBER_CELL}>{formatTokens(step.outputTokens)}</TableCell>
                  <TableCell className={NUMBER_CELL}>
                    {step.costUsd === null ? "-" : formatUsd(step.costUsd)}
                  </TableCell>
                  <TableCell className={NUMBER_CELL}>
                    {step.failedCommands > 0
                      ? t("{count} ({failed} failed)", {
                          count: step.commands,
                          failed: step.failedCommands,
                        })
                      : formatCount(step.commands)}
                  </TableCell>
                  <TableCell className={NUMBER_CELL}>{formatCount(step.filesChanged)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {detail.omitted.steps > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {tn(
              detail.omitted.steps,
              "{count} shorter step not shown",
              "{count} shorter steps not shown",
            )}
          </p>
        ) : null}
      </MonitoringSection>

      {detail.slowestCommands.length > 0 ? (
        <MonitoringSection title={t("Slowest commands")}>
          <div className="tabular-nums">
            <Table aria-label={t("Slowest commands")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Command")}</TableHead>
                  <TableHead>{t("Step")}</TableHead>
                  <TableHead className={NUMBER_CELL}>{t("Duration")}</TableHead>
                  <TableHead className={NUMBER_CELL}>{t("Exit code")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.slowestCommands.map((command) => (
                  <TableRow key={`${command.startedAt}-${command.command}`}>
                    <TableCell className="max-w-96">
                      <MonitoringTruncated as="code" text={command.command} className="text-xs" />
                    </TableCell>
                    <TableCell>{t(PHASE_LABEL[command.phase])}</TableCell>
                    <TableCell className={NUMBER_CELL}>
                      {formatDuration(command.durationMs)}
                    </TableCell>
                    <TableCell className={NUMBER_CELL}>
                      {command.failed ? (
                        <Badge size="sm" variant="error">
                          {command.exitCode ?? t("Failed")}
                        </Badge>
                      ) : (
                        (command.exitCode ?? "-")
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </MonitoringSection>
      ) : null}

      {detail.repeatedCommands.length > 0 ? (
        <MonitoringSection title={t("Repeated commands")}>
          <div className="tabular-nums">
            <Table aria-label={t("Repeated commands")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Command")}</TableHead>
                  <TableHead>{t("Step")}</TableHead>
                  <TableHead className={NUMBER_CELL}>{t("Runs")}</TableHead>
                  <TableHead className={NUMBER_CELL}>{t("Failed")}</TableHead>
                  <TableHead className={NUMBER_CELL}>{t("Total time")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.repeatedCommands.map((group) => (
                  <TableRow key={group.command}>
                    <TableCell className="max-w-96">
                      <MonitoringTruncated as="code" text={group.command} className="text-xs" />
                    </TableCell>
                    <TableCell>{t(PHASE_LABEL[group.phase])}</TableCell>
                    <TableCell className={NUMBER_CELL}>{formatCount(group.count)}</TableCell>
                    <TableCell className={NUMBER_CELL}>{formatCount(group.failed)}</TableCell>
                    <TableCell className={NUMBER_CELL}>
                      {formatDuration(group.durationMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </MonitoringSection>
      ) : null}
    </>
  );
}
