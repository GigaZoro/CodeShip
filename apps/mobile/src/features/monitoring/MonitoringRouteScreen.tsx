import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  MONITORING_CHAT_LIMIT_MAX,
  type EnvironmentId,
  type MonitoringChatSort,
  type MonitoringFindingCode,
  type MonitoringOverviewInput,
  type MonitoringThreadKind,
  type ThreadId,
} from "@t3tools/contracts";
import {
  NO_MODEL,
  monitoringChatKey,
  projectKey,
  type MonitoringChat,
  type MonitoringOverviewView,
  type MonitoringProjectOption,
} from "@t3tools/client-runtime/monitoring";
import {
  FINDING_TEXT,
  KIND_LABEL,
  PHASE_LABEL,
  SEVERITY_LABEL,
} from "@t3tools/client-runtime/monitoring-text";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  formatDateTimeShort,
  formatPercent,
  formatUsd,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SymbolView } from "../../components/ui/AppSymbol";
import { msg, t, tn } from "../../lib/i18n";
import { useProjects } from "../../state/entities";
import { useMonitoringOverview } from "../../state/monitoring";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { MonitoringKpi } from "./MonitoringKpi";
import { MonitoringTimeBar } from "./MonitoringTimeBar";

export type MonitoringRoutes = {
  SettingsMonitoringThread: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
};

const WINDOW_OPTIONS = [
  { value: 7, label: msg("7d"), accessibilityLabel: msg("Past 7 days") },
  { value: 30, label: msg("30d"), accessibilityLabel: msg("Past 30 days") },
  { value: 90, label: msg("90d"), accessibilityLabel: msg("Past 90 days") },
] as const;

interface Scope {
  readonly project: MonitoringProjectOption | null;
  readonly kind: MonitoringThreadKind | null;
  /** A model name; NO_MODEL is chats that ran none. */
  readonly model: string | null;
}

const NO_SCOPE: Scope = { project: null, kind: null, model: null };
const ALL_ID = "all";
/** Option ids carry a prefix so that no project or model value can collide with ALL_ID. */
const OPTION_PREFIX = "option:";

const MAX_CONTENT_WIDTH = 720;
const PAGE_SIZE = 40;
const NEWEST_FIRST: MonitoringChatSort = { key: "settledAt", direction: "desc" };

export function MonitoringRouteScreen(props: { readonly workspace?: boolean }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<MonitoringRoutes>>();
  const [days, setDays] = useState<(typeof WINDOW_OPTIONS)[number]["value"]>(30);
  const [finding, setFinding] = useState<MonitoringFindingCode | null>(null);
  const [scope, setScope] = useState<Scope>(NO_SCOPE);
  const [shown, setShown] = useState(PAGE_SIZE);
  const { sinceDay, untilDay, timeZone } = makeWindow(days);
  const input: MonitoringOverviewInput = {
    sinceDay,
    untilDay,
    timeZone,
    ...(scope.project ? { projectId: scope.project.projectId } : {}),
    ...(scope.kind ? { kind: scope.kind } : {}),
    ...(scope.model !== null ? { model: scope.model } : {}),
    ...(finding ? { findingCode: finding } : {}),
    sort: NEWEST_FIRST,
    chatLimit: shown,
  };
  const {
    overview,
    isRefreshing: refreshing,
    refresh,
  } = useMonitoringOverview(input, scope.project?.environmentId ?? null);
  const projects = useProjects();

  const projectTitles = useMemo(
    () =>
      new Map(
        projects.map((project) => [projectKey(project.environmentId, project.id), project.title]),
      ),
    [projects],
  );
  const projectTitleOfKey = (key: string) => projectTitles.get(key) ?? t("Unknown project");
  const projectTitleOf = (chat: MonitoringChat) =>
    projectTitleOfKey(projectKey(chat.environmentId, chat.row.projectId));

  const { totals, chats } = overview;
  const filtered = scope.project !== null || scope.kind !== null || scope.model !== null;
  const body = monitoringBody();
  function monitoringBody(): "empty-environments" | "failed" | "loading" | "empty" | "ready" {
    if (!overview.connected) return "empty-environments";
    if (overview.failed) return "failed";
    if (overview.isLoading) return "loading";
    return totals.chats === 0 && !filtered && finding === null ? "empty" : "ready";
  }

  const controls = (
    <View className="gap-4">
      <SegmentedControl
        options={WINDOW_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.label),
          accessibilityLabel: t(option.accessibilityLabel),
        }))}
        selected={days}
        onSelect={(next) => {
          setDays(next);
          setFinding(null);
          setScope(NO_SCOPE);
          setShown(PAGE_SIZE);
        }}
      />
      {overview.environments.some((environment) => environment.error) && body !== "failed" ? (
        <Note
          text={t("Some environments could not be read, so their chats are missing: {names}", {
            names: overview.environments
              .filter((environment) => environment.error)
              .map((environment) => environment.label)
              .join(", "),
          })}
          action={<Button label={t("Retry")} onPress={refresh} />}
        />
      ) : null}
      {overview.pendingAnalysis > 0 ? (
        <Note
          text={tn(
            overview.pendingAnalysis,
            "{count} settled chat is still being analyzed.",
            "{count} settled chats are still being analyzed.",
          )}
        />
      ) : null}
      {overview.failedAnalysis > 0 ? (
        <Note
          text={tn(
            overview.failedAnalysis,
            "{count} chat could not be analyzed. It is tried again every 30 minutes.",
            "{count} chats could not be analyzed. They are tried again every 30 minutes.",
          )}
        />
      ) : null}
    </View>
  );

  const scopeFilters = (
    <ScopeFilters
      options={overview.options}
      scope={scope}
      projectTitleOfKey={projectTitleOfKey}
      onChange={(next) => {
        setScope(next);
        setFinding(null);
        setShown(PAGE_SIZE);
      }}
    />
  );

  const header =
    body === "ready" ? (
      <View className="gap-5">
        {controls}
        {scopeFilters}
        {totals.chats === 0 ? (
          <EmptyState
            variant="plain"
            title={t("No chats match these filters")}
            detail={t("Clear a filter or choose a longer period.")}
          />
        ) : null}
        <View className="flex-row flex-wrap gap-3">
          <MonitoringKpi label={t("Chats settled")} value={String(totals.chats)} />
          <MonitoringKpi
            label={t("Median lifetime")}
            value={formatDuration(totals.medianLifetimeMs)}
          />
          <MonitoringKpi
            label={t("Median active time")}
            value={formatDuration(totals.medianActiveMs)}
          />
          <MonitoringKpi
            label={t("Agents working")}
            value={formatPercent(totals.workingShare, 0)}
            hint={t("{share} waiting", { share: formatPercent(1 - totals.workingShare, 0) })}
          />
          <MonitoringKpi
            label={t("Cost")}
            value={formatUsd(totals.costUsd)}
            hint={
              totals.unpricedTurns > 0
                ? tn(totals.unpricedTurns, "{count} turn unpriced", "{count} turns unpriced")
                : undefined
            }
          />
          <MonitoringKpi
            label={t("Cache reuse")}
            value={totals.cacheReuse === null ? "-" : formatPercent(totals.cacheReuse, 0)}
            hint={t("{failed} of {runs} runs failed", {
              failed: totals.failedRuns,
              runs: totals.runs,
            })}
          />
        </View>
        <SettingsSection title={t("Where the time goes")}>
          <View className="p-4">
            <MonitoringTimeBar buckets={overview.time} />
          </View>
        </SettingsSection>
        <SettingsSection
          title={t("Weak points")}
          footer={t("Choose one to list only the chats it hit.")}
        >
          {overview.findings.length === 0 ? (
            <Text className="p-4 text-foreground-muted">{t("No weak points found.")}</Text>
          ) : (
            overview.findings.map((rank, index) => {
              const text = FINDING_TEXT[rank.code];
              const active = rank.code === finding;
              const stats = [
                tn(rank.chats, "{count} chat", "{count} chats"),
                rank.wastedMs > 0
                  ? t("{duration} lost", { duration: formatDuration(rank.wastedMs) })
                  : t("No time counted"),
              ].join(" · ");
              return (
                <Pressable
                  key={rank.code}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${t(text.title)}, ${t(SEVERITY_LABEL[rank.severity])}, ${stats}`}
                  accessibilityHint={t("Choose one to list only the chats it hit.")}
                  className={`min-h-11 gap-1 px-4 py-3 active:opacity-70 ${active ? "bg-secondary" : ""} ${index > 0 ? "border-t border-border-subtle" : ""}`}
                  onPress={() => {
                    setFinding(active ? null : rank.code);
                    setShown(PAGE_SIZE);
                  }}
                >
                  <Text className="font-t3-medium text-foreground">
                    {`${t(text.title)} · ${t(SEVERITY_LABEL[rank.severity])}`}
                  </Text>
                  <Text textRole="footnote" className="text-foreground-muted">
                    {t(text.overview ?? text.explanation)}
                  </Text>
                  {text.advice ? (
                    <Text textRole="footnote" className="text-foreground">
                      {t(text.advice)}
                    </Text>
                  ) : null}
                  <Text textRole="footnote" className="text-foreground-muted">
                    {stats}
                  </Text>
                </Pressable>
              );
            })
          )}
        </SettingsSection>
        <SettingsSection title={t("Steps")} footer={t("Shell commands by what they were for.")}>
          {overview.phases.length === 0 ? (
            <Text className="p-4 text-foreground-muted">{t("No commands ran.")}</Text>
          ) : (
            overview.phases.map((phase, index) => (
              <View
                key={phase.phase}
                accessible
                accessibilityLabel={`${t(PHASE_LABEL[phase.phase])}, ${tn(phase.count, "{count} run", "{count} runs")}, ${t("Failure rate")} ${formatPercent(phase.failureRate, 0)}, ${t("Total time")} ${formatDuration(phase.durationMs)}`}
                className={`min-h-11 flex-row items-center gap-3 px-4 py-2.5 ${index > 0 ? "border-t border-border-subtle" : ""}`}
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-foreground">{t(PHASE_LABEL[phase.phase])}</Text>
                  <Text textRole="footnote" className="text-foreground-muted">
                    {[
                      tn(phase.count, "{count} run", "{count} runs"),
                      t("{rate} failed", { rate: formatPercent(phase.failureRate, 0) }),
                      t("{average} on average", { average: formatDuration(phase.averageMs) }),
                    ].join(", ")}
                  </Text>
                </View>
                <Text className="text-foreground">{formatDuration(phase.durationMs)}</Text>
              </View>
            ))
          )}
        </SettingsSection>
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {t("Chats")}
        </Text>
      </View>
    ) : body === "failed" ? (
      // A scope on a failing environment is undone here.
      <View className="gap-5">
        {controls}
        {scopeFilters}
      </View>
    ) : (
      controls
    );

  const status =
    body === "loading" ? (
      <View className="items-center py-16" accessibilityState={{ busy: true }}>
        <AppActivityIndicator />
      </View>
    ) : body === "failed" ? (
      <EmptyState
        variant="plain"
        title={t("Could not load monitoring")}
        detail={overview.environments[0]?.error ?? ""}
        actionLabel={t("Retry")}
        onAction={refresh}
      />
    ) : body === "empty-environments" ? (
      <EmptyState
        variant="plain"
        title={t("No environments connected")}
        detail={t("Monitoring reads the chats of the environments you are connected to.")}
      />
    ) : body === "empty" ? (
      <EmptyState
        variant="plain"
        title={t("No settled chats in this period")}
        detail={t("Chats show up here once they settle and have been analyzed.")}
      />
    ) : null;

  const visible = body === "ready" ? chats : [];
  const hasMore = visible.length < overview.listedChats;
  const capReached = shown >= MONITORING_CHAT_LIMIT_MAX;

  return (
    <SettingsScreen title={t("Monitoring")} workspaceRoot={props.workspace}>
      <FlatList
        data={visible}
        keyExtractor={monitoringChatKey}
        renderScrollComponent={(scrollProps) => <ScrollView {...scrollProps} />}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListHeaderComponent={
          <View className="w-full gap-3 self-center pb-3" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
            {header}
            {status}
          </View>
        }
        renderItem={({ item, index }) => (
          <View className="w-full self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
            <ChatRow
              chat={item}
              first={index === 0}
              last={index === visible.length - 1}
              projectTitle={projectTitleOf(item)}
              onPress={() =>
                navigation.navigate("SettingsMonitoringThread", {
                  environmentId: item.environmentId as EnvironmentId,
                  threadId: item.row.threadId,
                })
              }
            />
          </View>
        )}
        ListFooterComponent={
          hasMore ? (
            <View className="items-center gap-2 pt-4">
              {capReached ? (
                <Text textRole="footnote" className="text-foreground-muted">
                  {t("Narrow the filters to see the rest.")}
                </Text>
              ) : (
                <Button
                  label={t("Show more")}
                  onPress={() => setShown(Math.min(MONITORING_CHAT_LIMIT_MAX, shown + PAGE_SIZE))}
                />
              )}
            </View>
          ) : undefined
        }
      />
    </SettingsScreen>
  );
}

function ScopeFilters(props: {
  readonly options: MonitoringOverviewView["options"];
  readonly scope: Scope;
  readonly projectTitleOfKey: (key: string) => string;
  readonly onChange: (scope: Scope) => void;
}) {
  const { options, scope } = props;
  const { projects, kinds, models } = options;
  const modelLabel = (model: string) => (model === NO_MODEL ? t("No model") : model);
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return (
    <View className="flex-row flex-wrap gap-2">
      <FilterMenu
        label={t("Project")}
        allLabel={t("All projects")}
        value={scope.project?.key ?? null}
        options={projects
          .map((project) => ({ value: project.key, label: props.projectTitleOfKey(project.key) }))
          .sort(byLabel)}
        onChange={(key) =>
          props.onChange({
            ...scope,
            project: projects.find((project) => project.key === key) ?? null,
          })
        }
      />
      <FilterMenu
        label={t("Kind")}
        allLabel={t("All kinds")}
        value={scope.kind}
        options={kinds.map((kind) => ({ value: kind, label: t(KIND_LABEL[kind]) }))}
        onChange={(kind) => props.onChange({ ...scope, kind })}
      />
      <FilterMenu
        label={t("Model")}
        allLabel={t("All models")}
        value={scope.model}
        options={models.map((model) => ({ value: model, label: modelLabel(model) })).sort(byLabel)}
        onChange={(model) => props.onChange({ ...scope, model })}
      />
    </View>
  );
}

function FilterMenu<Value extends string>(props: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: Value | null;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value | null) => void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  const shown = current?.label ?? props.allLabel;
  return (
    <Menu
      actions={[
        { id: ALL_ID, title: props.allLabel, state: props.value === null ? "on" : undefined },
        ...props.options.map((option) => ({
          id: `${OPTION_PREFIX}${option.value}`,
          title: option.label,
          state: option.value === props.value ? ("on" as const) : undefined,
        })),
      ]}
      onPressAction={({ nativeEvent }) =>
        props.onChange(
          props.options.find((option) => `${OPTION_PREFIX}${option.value}` === nativeEvent.event)
            ?.value ?? null,
        )
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("{label}, {value}", { label: props.label, value: shown })}
        className="min-h-11 flex-row items-center gap-1.5 rounded-full bg-secondary px-3.5 py-2 active:opacity-70"
      >
        <Text textRole="footnote" className="max-w-[200px] text-foreground" numberOfLines={1}>
          {shown}
        </Text>
        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}

function Note(props: { readonly text: string; readonly action?: ReactNode }) {
  return (
    <View className="gap-2 rounded-2xl bg-grouped-card p-3">
      <Text textRole="footnote" className="text-foreground-muted">
        {props.text}
      </Text>
      {props.action}
    </View>
  );
}

function ChatRow(props: {
  readonly chat: MonitoringChat;
  readonly first: boolean;
  readonly last: boolean;
  readonly projectTitle: string;
  readonly onPress: () => void;
}) {
  const { row } = props.chat;
  const title = row.title || t("Untitled chat");
  const metrics = [
    formatDateTimeShort(row.settledAt),
    formatDuration(row.lifetimeMs),
    formatUsd(row.costUsd),
    tn(row.findings, "{count} finding", "{count} findings"),
  ].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${props.projectTitle}, ${metrics}`}
      accessibilityHint={t("Opens this chat's analysis.")}
      className={`min-h-11 flex-row items-center gap-3 border-continuous bg-grouped-card px-4 py-3 active:opacity-70 ${props.first ? "rounded-t-2xl" : "border-t border-border-subtle"} ${props.last ? "rounded-b-2xl" : ""}`}
      onPress={props.onPress}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="font-t3-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {[
            props.projectTitle,
            row.model,
            row.kind === "interactive" ? null : t(KIND_LABEL[row.kind]),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {metrics}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}
