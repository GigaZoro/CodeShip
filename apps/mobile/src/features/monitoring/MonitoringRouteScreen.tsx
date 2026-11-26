import { LegendList } from "@legendapp/list/react-native";
import { monitoringRefreshTimedOut } from "@t3tools/client-runtime/monitoring/atoms";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  type EnvironmentId,
  type MonitoringFindingCode,
  type MonitoringThreadKind,
  type ThreadId,
} from "@t3tools/contracts";
import {
  failureRetry,
  filterGroups,
  fixChatTarget,
  formatMonitoringTime,
  mainModel,
  missingEnvironments,
  NO_MODEL,
  monitoringChatKey,
  monitoringFacets,
  monitoringWindow,
  phaseTotals,
  projectKey,
  rankFindings,
  sumTimeBuckets,
  totalsOf,
  unanalyzedCounts,
  unreadableEnvironmentText,
  type MonitoringChat,
  type MonitoringChatsRequest,
  type MonitoringOverviewView,
  type MonitoringRetry,
} from "@t3tools/client-runtime/monitoring";
import {
  FINDING_TEXT,
  KIND_LABEL,
  PHASE_LABEL,
  SEVERITY_LABEL,
} from "@t3tools/client-runtime/monitoring-text";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatPercent, formatUsd } from "@t3tools/shared/usageFormat";
import { useMemo, useState } from "react";
import { Pressable, ScrollView as NativeScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { Menu } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SymbolView } from "../../components/ui/AppSymbol";
import { msg, t, tn } from "../../lib/i18n";
import { useProjects } from "../../state/entities";
import {
  refreshMonitoring,
  useMonitoringRefresh,
  useMonitoringChats,
  useMonitoringOverview,
} from "../../state/monitoring";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { MonitoringFixChatAction } from "./MonitoringFixChat";
import { MonitoringKpi } from "./MonitoringKpi";
import { MonitoringNote } from "./MonitoringNote";
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
  readonly project: string | null;
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

export function MonitoringRouteScreen(props: { readonly workspace?: boolean }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<MonitoringRoutes>>();
  // The clock is read once per choice: a new value on every render would change the query key.
  const [windowChoice, setWindowChoice] = useState(() => ({ days: 30, now: Date.now() }));
  const [finding, setFinding] = useState<MonitoringFindingCode | null>(null);
  const [scope, setScope] = useState<Scope>(NO_SCOPE);
  const [shown, setShown] = useState(PAGE_SIZE);
  const period = monitoringWindow(windowChoice.days, windowChoice.now);
  const overviewInput = { days: period.days, until: period.until };
  const { view: overview, retained } = useMonitoringOverview(overviewInput);
  const scopeFilters = useMemo(
    () => ({ projectKey: scope.project, kind: scope.kind, model: scope.model }),
    [scope],
  );
  const chatsRequest: MonitoringChatsRequest = {
    window: { since: period.since, until: period.until },
    filters: { ...scopeFilters, findingCode: finding },
    order: { sort: "settledAt", direction: "desc", limit: shown },
    pageSize: PAGE_SIZE,
  };
  const { view: chats, updating, retry: chatsRetry } = useMonitoringChats(chatsRequest);
  const projects = useProjects();
  const { refreshing, timedOut, run } = useMonitoringRefresh();
  const refresh = () => {
    const now = Date.now();
    const today = monitoringWindow(windowChoice.days, now);
    if (today.until === period.until) {
      return refreshMonitoring({ overview: overviewInput, chats: [chatsRequest] });
    }
    // A period left open past midnight moves to today. Its queries are new and load on their own,
    // so the refresh only reconnects environments that are down.
    setWindowChoice({ days: windowChoice.days, now });
    return refreshMonitoring({
      overview: { days: today.days, until: today.until },
      chats: [],
    });
  };

  const refreshFromPull = () => run(async () => (await refresh()).some(monitoringRefreshTimedOut));

  const projectTitles = useMemo(
    () =>
      new Map(
        projects.map((project) => [projectKey(project.environmentId, project.id), project.title]),
      ),
    [projects],
  );
  const projectTitleOfKey = (key: string) => projectTitles.get(key) ?? t("Unknown project");
  const projectTitleOf = (chat: MonitoringChat) =>
    projectTitleOfKey(projectKey(chat.environmentId, chat.summary.projectId));

  const groups = overview.groups;
  const scoped = useMemo(() => filterGroups(groups, scopeFilters), [groups, scopeFilters]);
  const fixScope = retained ? null : { window: chatsRequest.window, filters: scopeFilters };
  const totals = useMemo(() => totalsOf(scoped), [scoped]);
  const unanalyzed = unanalyzedCounts(overview.unanalyzed, scope.project);
  const buckets = useMemo(() => sumTimeBuckets(scoped), [scoped]);
  const ranks = useMemo(() => rankFindings(scoped), [scoped]);
  const phases = useMemo(() => phaseTotals(scoped), [scoped]);
  const body = monitoringBody();
  function monitoringBody(): "empty-environments" | "failed" | "loading" | "empty" | "ready" {
    if (overview.environments.length === 0) return "empty-environments";
    if (overview.failed) return "failed";
    if (overview.isLoading) return "loading";
    return groups.length === 0 && overview.complete ? "empty" : "ready";
  }
  const overviewMissing = missingEnvironments(overview);
  // The list is its own query, so it can lack an environment the overview counted.
  const chatsMissing = missingEnvironments(chats);
  const overviewRetry = failureRetry(overview);
  const retry = (state: MonitoringRetry, tone: "primary" | "secondary" = "secondary") =>
    state === "unavailable" ? undefined : (
      <Button tone={tone} label={t("Retry")} onPress={refreshFromPull} loading={refreshing} />
    );

  const controls = (
    <View className="gap-4">
      <SegmentedControl
        options={WINDOW_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.label),
          accessibilityLabel: t(option.accessibilityLabel),
        }))}
        selected={windowChoice.days}
        onSelect={(days) => {
          setWindowChoice({ days, now: Date.now() });
          setFinding(null);
          setScope(NO_SCOPE);
          setShown(PAGE_SIZE);
        }}
      />
      <NativeScrollView className="h-24" nestedScrollEnabled contentContainerClassName="gap-2">
        {overview.stale ? (
          <Text textRole="footnote" accessibilityLiveRegion="polite">
            {t("Showing previous monitoring results.")}
          </Text>
        ) : null}
        {overviewMissing.unreadable && body !== "failed" ? (
          <MonitoringNote
            announce
            text={t("Could not refresh these environments: {names}", {
              names: overviewMissing.unreadable,
            })}
            action={retry(overviewRetry)}
          />
        ) : null}
        {overviewMissing.waiting ? (
          <MonitoringNote
            announce
            text={t("Waiting for these environments: {names}", {
              names: overviewMissing.waiting,
            })}
          />
        ) : null}
        {unanalyzed.pending > 0 ? (
          <MonitoringNote
            text={tn(
              unanalyzed.pending,
              "{count} settled chat is still being analyzed.",
              "{count} settled chats are still being analyzed.",
            )}
          />
        ) : null}
        {unanalyzed.failed > 0 ? (
          <MonitoringNote
            text={tn(
              unanalyzed.failed,
              "{count} chat could not be analyzed.",
              "{count} chats could not be analyzed.",
            )}
          />
        ) : null}
      </NativeScrollView>
    </View>
  );

  // Shown with no analyzed chat too: the pending and failed notes count the chosen project.
  const scopeControls = (
    <ScopeFilters
      overview={overview}
      scope={scope}
      projectTitleOf={projectTitleOfKey}
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
        {scopeControls}
        {scoped.length === 0 && overview.complete ? (
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
            <MonitoringTimeBar buckets={buckets} />
          </View>
        </SettingsSection>
        <SettingsSection
          title={t("Weak points")}
          footer={t("Choose one to list only the chats it hit.")}
        >
          {ranks.length === 0 ? (
            <Text className="p-4 text-foreground-muted">{t("No weak points found.")}</Text>
          ) : (
            ranks.map((rank, index) => {
              const text = FINDING_TEXT[rank.code];
              const active = rank.code === finding;
              const stats = [
                tn(rank.chats, "{count} chat", "{count} chats"),
                rank.wastedMs > 0
                  ? t("{duration} lost", { duration: formatDuration(rank.wastedMs) })
                  : t("No time counted"),
              ].join(" · ");
              return (
                <View
                  key={rank.code}
                  className={`px-4 py-3 ${active ? "bg-secondary" : ""} ${index > 0 ? "border-t border-border-subtle" : ""}`}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${t(text.title)}, ${t(SEVERITY_LABEL[rank.severity])}, ${stats}`}
                    accessibilityHint={t("Choose one to list only the chats it hit.")}
                    className="min-h-11 gap-1 active:opacity-70"
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
                  <MonitoringFixChatAction
                    target={fixScope === null ? null : fixChatTarget(scoped, rank.code, fixScope)}
                    code={rank.code}
                  />
                </View>
              );
            })
          )}
        </SettingsSection>
        <SettingsSection title={t("Steps")} footer={t("Shell commands by what they were for.")}>
          {phases.length === 0 ? (
            <Text className="p-4 text-foreground-muted">{t("No commands ran.")}</Text>
          ) : (
            phases.map((phase, index) => (
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
    ) : body === "empty" ? (
      <View className="gap-5">
        {controls}
        {scopeControls}
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
        detail={overview.unreadable.map(unreadableEnvironmentText).join("\n")}
        action={retry(overviewRetry, "primary")}
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
        title={t("No analyzed chats in this period")}
        detail={t("Chats show up here once they settle and have been analyzed.")}
      />
    ) : null;

  const visible = body === "ready" && !chats.isLoading ? chats.chats : [];
  const more = chats.chats.length < chats.total;

  return (
    <SettingsScreen title={t("Monitoring")} workspaceRoot={props.workspace}>
      <LegendList
        data={visible}
        keyExtractor={monitoringChatKey}
        extraData={{ projectTitles, count: visible.length, navigation }}
        estimatedItemSize={78}
        recycleItems
        renderScrollComponent={ScreenScrollView}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshFromPull}
            accessibilityLabel={refreshing ? t("Refreshing…") : t("Refresh monitoring")}
            accessibilityLiveRegion="polite"
          />
        }
        ListHeaderComponent={
          <View className="w-full gap-3 self-center pb-3" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
            {header}
            {timedOut ? (
              <Text accessibilityLiveRegion="polite" textRole="footnote">
                {t("The request timed out.")}
              </Text>
            ) : null}
            {status}
            {body === "ready" ? (
              <NativeScrollView
                className="h-20"
                nestedScrollEnabled
                contentContainerClassName="gap-2"
              >
                {chats.stale ? (
                  <Text textRole="footnote" accessibilityLiveRegion="polite">
                    {t("Showing previous monitoring results.")}
                  </Text>
                ) : null}
                {chatsMissing.unreadable ? (
                  <MonitoringNote
                    announce
                    text={t("Could not refresh these environments: {names}", {
                      names: chatsMissing.unreadable,
                    })}
                    action={retry(chatsRetry)}
                  />
                ) : null}
                {chatsMissing.waiting ? (
                  <MonitoringNote
                    announce
                    text={t("Waiting for these environments: {names}", {
                      names: chatsMissing.waiting,
                    })}
                  />
                ) : null}
              </NativeScrollView>
            ) : null}
            {body === "ready" && chats.isLoading ? (
              <View className="items-center py-8" accessibilityState={{ busy: true }}>
                <AppActivityIndicator />
              </View>
            ) : null}
            {body === "ready" &&
            !chats.isLoading &&
            visible.length === 0 &&
            scoped.length > 0 &&
            chats.complete ? (
              <Text className="px-2 text-foreground-muted">
                {t("No chats match these filters.")}
              </Text>
            ) : null}
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
                  threadId: item.summary.threadId,
                })
              }
            />
          </View>
        )}
        ListFooterComponent={
          visible.length > 0 && more ? (
            <View className="items-center gap-2 pt-4">
              <Text textRole="footnote" className="text-foreground-muted">
                {tn(
                  chats.total,
                  "Showing {shown} of {count} chat",
                  "Showing {shown} of {count} chats",
                  {
                    shown: visible.length,
                  },
                )}
              </Text>
              <Button
                label={t("Show more")}
                disabled={updating}
                onPress={() => setShown(shown + PAGE_SIZE)}
              />
            </View>
          ) : undefined
        }
      />
    </SettingsScreen>
  );
}

function ScopeFilters(props: {
  readonly overview: MonitoringOverviewView;
  readonly scope: Scope;
  readonly projectTitleOf: (projectKey: string) => string;
  readonly onChange: (scope: Scope) => void;
}) {
  const { scope } = props;
  const { projectKeys, kinds, models } = monitoringFacets(props.overview);
  const modelLabel = (model: string) => (model === NO_MODEL ? t("No model") : model);
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return (
    <View className="flex-row flex-wrap gap-2">
      <FilterMenu
        label={t("Project")}
        allLabel={t("All projects")}
        value={scope.project}
        options={projectKeys
          .map((value) => ({ value, label: props.projectTitleOf(value) }))
          .sort(byLabel)}
        onChange={(project) => props.onChange({ ...scope, project })}
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

function ChatRow(props: {
  readonly chat: MonitoringChat;
  readonly first: boolean;
  readonly last: boolean;
  readonly projectTitle: string;
  readonly onPress: () => void;
}) {
  const { summary } = props.chat;
  const model = mainModel(summary);
  const title = summary.title || t("Untitled chat");
  const metrics = [
    formatMonitoringTime(summary.settledAt),
    formatDuration(summary.lifetimeMs),
    formatUsd(summary.costUsd),
    tn(summary.findings.length, "{count} finding", "{count} findings"),
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
            model,
            summary.kind === "interactive" ? null : t(KIND_LABEL[summary.kind]),
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
