import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { formatScheduledTaskRunTime } from "@t3tools/client-runtime/scheduled-task-pins";
import {
  failoverText,
  peerNoWorkText,
  runCheckText,
  usageLimitSkipText,
} from "@t3tools/client-runtime/scheduled-task-run-condition";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ScheduledTaskId,
  ScheduledTaskRunRecord,
  ThreadId,
} from "@t3tools/contracts";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { t } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/** Opens a run's thread the way the pull request pages do: Android shows one page at a time. */
export function useOpenScheduledTaskThread() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  return (environmentId: EnvironmentId, threadId: ThreadId) => {
    const params = { environmentId, threadId };
    if (Platform.OS === "android") selectDetail({ name: "Thread", params });
    else navigation.dispatch(StackActions.push("Thread", params));
  };
}

function outcomePresentation(outcome: ScheduledTaskRunRecord["outcome"]): {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly tint: string;
} {
  switch (outcome) {
    case "running":
      return { label: t("Running"), icon: "circle.dashed", tint: "accent-icon" };
    case "succeeded":
      return { label: t("Started"), icon: "checkmark.circle", tint: "accent-icon" };
    case "failed":
      return {
        label: t("Failed"),
        icon: "exclamationmark.triangle",
        tint: "accent-danger-foreground",
      };
    case "skipped":
      return { label: t("Skipped"), icon: "slash.circle", tint: "accent-warning-foreground" };
    default:
      return { label: outcome, icon: "circle.dashed", tint: "accent-icon" };
  }
}

function triggerLabel(trigger: ScheduledTaskRunRecord["trigger"]): string {
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
  machineLabel: (id: EnvironmentId) => string,
): string | null {
  switch (run.skipReason) {
    case null:
      return null;
    case "missed":
      return t("This machine was off or asleep at that time, and catching up is off.");
    case "next_run_sooner":
      return t("This machine was off or asleep at that time, and the next run comes sooner.");
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
        "This machine couldn't reach enough of the other machines to make sure no other machine would run it, so it didn't run it.",
      );
    case "usage_limited":
      return usageLimitSkipText(run.usageLimit, formatScheduledTaskRunTime);
    default:
      return run.skipReason;
  }
}

export function ScheduledTaskRunsRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly taskId: ScheduledTaskId;
  readonly title: string;
}>) {
  const { environmentId, taskId, title } = route.params;
  const insets = useSafeAreaInsets();
  const openThread = useOpenScheduledTaskThread();
  const runsAtom = serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: taskId } });
  const runs = useEnvironmentQuery(runsAtom);
  const pullRefresh = usePullToRefresh(runsAtom);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const { availableTargets } = useSettingsEnvironmentFilter();
  const machineLabel = (id: EnvironmentId) =>
    availableTargets.find((target) => target.environmentId === id)?.label ?? id;
  const accountName = (instanceId: string) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    return provider ? resolveProviderInstanceDisplayName(provider) : instanceId;
  };

  return (
    <SettingsScreen title={t("Run history")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={pullRefresh.refreshing}
            onRefresh={() => pullRefresh.onRefresh()}
          />
        }
      >
        <SettingsSection
          title={title}
          footer={t("Each time this task fired here, including runs that failed or were skipped.")}
        >
          {runs.error ? (
            <Text className="p-4 text-base text-danger-foreground">{runs.error}</Text>
          ) : runs.data === null ? (
            <Text className="p-4 text-base text-foreground-muted">{t("Loading runs…")}</Text>
          ) : runs.data.runs.length === 0 ? (
            <Text className="p-4 text-base text-foreground-muted">{t("No runs yet.")}</Text>
          ) : (
            runs.data.runs.map((run, index) => {
              const outcome = outcomePresentation(run.outcome);
              const skipReason =
                run.outcome === "skipped" ? skipReasonText(run, machineLabel) : null;
              const checkText = runCheckText(run.check);
              const threadId = run.threadId;
              const when = [
                formatScheduledTaskRunTime(run.startedAt),
                triggerLabel(run.trigger),
                run.scheduledFor !== null && run.trigger !== "scheduled"
                  ? t("for {time}", { time: formatScheduledTaskRunTime(run.scheduledFor) })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const content = (
                <>
                  <View className="size-6 items-center justify-center">
                    <SymbolView
                      name={outcome.icon}
                      size={20}
                      tintColorClassName={outcome.tint}
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text textRole="body" className="text-foreground">
                      {outcome.label}
                    </Text>
                    <Text textRole="footnote" className="text-foreground-muted">
                      {when}
                    </Text>
                    {skipReason ? (
                      <Text textRole="footnote" className="text-foreground-muted">
                        {skipReason}
                      </Text>
                    ) : null}
                    {run.skipReason !== "no_work" &&
                    !(run.skipReason === "ran_elsewhere" && run.check?.outcome === "skip") &&
                    checkText ? (
                      <Text textRole="footnote" className="text-foreground-muted">
                        {checkText}
                      </Text>
                    ) : null}
                    {run.failover !== null ? (
                      <Text textRole="footnote" className="text-foreground-muted">
                        {failoverText(run.failover, accountName)}
                      </Text>
                    ) : null}
                    {run.error !== null ? (
                      <Text
                        selectable
                        numberOfLines={4}
                        className="font-mono text-xs leading-5 text-danger-foreground"
                      >
                        {run.error}
                      </Text>
                    ) : null}
                  </View>
                </>
              );
              const rowClassName =
                index === 0
                  ? "min-h-14 flex-row items-center gap-3 px-4 py-3"
                  : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3";
              return threadId === null ? (
                <View key={run.id} className={rowClassName}>
                  {content}
                </View>
              ) : (
                <Pressable
                  key={run.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${outcome.label}, ${when}`}
                  accessibilityHint={t("Opens this run's thread.")}
                  className={`${rowClassName} active:opacity-70`}
                  onPress={() => openThread(environmentId, threadId)}
                >
                  {content}
                  <SymbolView
                    name="chevron.right"
                    size={14}
                    tintColorClassName="accent-chevron"
                    type="monochrome"
                  />
                </Pressable>
              );
            })
          )}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
