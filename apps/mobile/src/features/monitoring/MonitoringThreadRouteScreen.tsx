import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, MonitoringThreadDetail, ThreadId } from "@t3tools/contracts";
import { formatMonitoringTime, threadFixChatTarget } from "@t3tools/client-runtime/monitoring";
import {
  FINDING_DETAIL_LABELED,
  FINDING_TEXT,
  KIND_LABEL,
  PHASE_LABEL,
  SEVERITY_LABEL,
  findingExplanation,
} from "@t3tools/client-runtime/monitoring-text";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { msg, t, tn } from "../../lib/i18n";
import { refreshMonitoringThread, useMonitoringRefresh } from "../../state/monitoring";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useOpenScheduledTaskThread } from "../settings/ScheduledTaskRunsRouteScreen";
import { MonitoringFixChatAction } from "./MonitoringFixChat";
import { MonitoringKpi } from "./MonitoringKpi";
import { MonitoringNote } from "./MonitoringNote";
import { MonitoringTimeBar } from "./MonitoringTimeBar";
import { MonitoringTimeline } from "./MonitoringTimeline";

const MAX_CONTENT_WIDTH = 720;

const SOURCE_LABEL = {
  user: msg("You"),
  automatic: msg("Automatic"),
  scheduled: msg("Scheduled"),
  agent: msg("Agent"),
  helpers: msg("Helpers finished"),
} as const;

export function MonitoringThreadRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }>) {
  const { environmentId, threadId } = route.params;
  const insets = useSafeAreaInsets();
  const openThread = useOpenScheduledTaskThread();
  const { result, detail, retained } = useAtomValue(
    serverEnvironment.monitoringThreadView(environmentId, threadId),
  );
  const error = result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
  const { refreshing, timedOut, run } = useMonitoringRefresh();
  const refreshAll = () => run(() => refreshMonitoringThread(environmentId, threadId));

  return (
    <SettingsScreen title={t("Chat analysis")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} />}
      >
        <View className="w-full gap-5 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
          {timedOut ? (
            <Text accessibilityLiveRegion="polite" textRole="footnote">
              {t("The request timed out.")}
            </Text>
          ) : null}
          {detail && error !== null ? (
            <MonitoringNote
              text={t("Could not refresh this chat's analysis, so it may be out of date: {error}", {
                error,
              })}
              action={<Button label={t("Retry")} onPress={refreshAll} loading={refreshing} />}
            />
          ) : retained && detail ? (
            <Text textRole="footnote">{t("Showing previous monitoring results.")}</Text>
          ) : null}
          {detail ? (
            <DeepDiveBody
              detail={detail}
              environmentId={environmentId}
              onOpenChat={() => openThread(environmentId, threadId)}
            />
          ) : error !== null ? (
            <EmptyState
              variant="plain"
              title={t("Could not load this chat's analysis")}
              detail={error}
              action={
                <Button
                  tone="primary"
                  label={t("Retry")}
                  onPress={refreshAll}
                  loading={refreshing}
                />
              }
            />
          ) : result.waiting ? (
            <View className="items-center py-16" accessibilityState={{ busy: true }}>
              <AppActivityIndicator />
            </View>
          ) : (
            <EmptyState
              variant="plain"
              title={t("Nothing to show")}
              detail={t("This chat is not settled, not analyzed, or no longer exists.")}
            />
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function DeepDiveBody(props: {
  readonly detail: MonitoringThreadDetail;
  readonly environmentId: EnvironmentId;
  readonly onOpenChat: () => void;
}) {
  const { detail, environmentId } = props;
  const { summary } = detail;
  const fixTarget = threadFixChatTarget(environmentId, summary);
  const input = summary.tokens.inputTokens;
  const workingMs = summary.time.agentMs + summary.time.commandMs + summary.time.toolMs;
  const helpers =
    summary.helpers.subagents +
    summary.helpers.delegates +
    summary.helpers.commands +
    summary.helpers.workflows;

  return (
    <>
      <View className="gap-2">
        <Text textRole="title" className="font-t3-bold text-foreground">
          {summary.title || t("Untitled chat")}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {[
            t(KIND_LABEL[summary.kind]),
            summary.models.join(", ") || t("No model recorded"),
            t("{from} to {to}", {
              from: formatMonitoringTime(summary.createdAt),
              to: formatMonitoringTime(summary.settledAt),
            }),
            summary.reopens > 0
              ? tn(summary.reopens, "Reopened once", "Reopened {count} times")
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <Button
          label={t("Open chat")}
          icon="text.bubble"
          tone="primary"
          onPress={props.onOpenChat}
        />
      </View>

      <View className="flex-row flex-wrap gap-3">
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
      </View>

      <SettingsSection title={t("Where the time went")}>
        <View className="p-4">
          <MonitoringTimeBar buckets={summary.time} />
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("Timeline")}
        footer={t("The chat's own runs, then each helper, with the events that shaped them.")}
      >
        <View className="p-4">
          <MonitoringTimeline detail={detail} />
        </View>
      </SettingsSection>

      <SettingsSection title={t("Weak points")}>
        {summary.findings.length === 0 ? (
          <Text className="p-4 text-foreground-muted">{t("No weak points found.")}</Text>
        ) : (
          summary.findings.map((finding, index) => {
            const text = FINDING_TEXT[finding.code];
            const counts =
              finding.wastedMs > 0
                ? t("{count} times, {duration} lost", {
                    count: finding.count,
                    duration: formatDuration(finding.wastedMs),
                  })
                : tn(finding.count, "{count} time", "{count} times");
            return (
              <View
                key={finding.code}
                className={`gap-1 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
              >
                <Text className="font-t3-medium text-foreground">
                  {`${t(text.title)} · ${t(SEVERITY_LABEL[finding.severity])}`}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {counts}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {findingExplanation(finding)}
                </Text>
                {FINDING_DETAIL_LABELED.has(finding.code) && finding.detail ? (
                  <Text selectable numberOfLines={3} className="font-mono text-xs text-foreground">
                    {finding.detail}
                  </Text>
                ) : null}
                {text.advice ? (
                  <Text textRole="footnote" className="text-foreground">
                    {t(text.advice)}
                  </Text>
                ) : null}
                <MonitoringFixChatAction target={fixTarget} code={finding.code} />
              </View>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection
        title={t("Steps")}
        footer={t("One row per run and the prompt that started it.")}
      >
        {detail.steps.map((step, index) => {
          const commands = [
            tn(step.commands, "{count} command", "{count} commands"),
            step.failedCommands > 0 ? t("{failed} failed", { failed: step.failedCommands }) : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <View
              key={step.runId}
              className={`gap-0.5 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
            >
              <Text className="text-foreground" numberOfLines={3}>
                {step.prompt || t("(no prompt)")}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {[t(SOURCE_LABEL[step.source]), step.model ?? "-", step.status].join(" · ")}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {[
                  formatDuration(step.durationMs),
                  step.costUsd === null ? "-" : formatUsd(step.costUsd),
                  commands,
                ].join(" · ")}
              </Text>
            </View>
          );
        })}
      </SettingsSection>
      {detail.omitted.steps > 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {tn(
            detail.omitted.steps,
            "{count} shorter step not shown",
            "{count} shorter steps not shown",
          )}
        </Text>
      ) : null}

      {detail.slowestCommands.length > 0 ? (
        <SettingsSection title={t("Slowest commands")}>
          {detail.slowestCommands.map((command, index) => (
            <View
              key={`${command.startedAt}-${command.command}`}
              className={`gap-0.5 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
            >
              <Text selectable numberOfLines={2} className="font-mono text-xs text-foreground">
                {command.command}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {[
                  t(PHASE_LABEL[command.phase]),
                  formatDuration(command.durationMs),
                  command.failed
                    ? t("Failed") + (command.exitCode === null ? "" : ` (${command.exitCode})`)
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          ))}
        </SettingsSection>
      ) : null}

      {detail.repeatedCommands.length > 0 ? (
        <SettingsSection title={t("Repeated commands")}>
          {detail.repeatedCommands.map((group, index) => (
            <View
              key={group.command}
              className={`gap-0.5 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
            >
              <Text selectable numberOfLines={2} className="font-mono text-xs text-foreground">
                {group.command}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {[
                  t(PHASE_LABEL[group.phase]),
                  tn(group.count, "{count} run", "{count} runs"),
                  t("{failed} failed", { failed: group.failed }),
                  formatDuration(group.durationMs),
                ].join(" · ")}
              </Text>
            </View>
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}
