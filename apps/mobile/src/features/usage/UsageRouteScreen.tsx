import { Notice } from "../../components/ui/Notice";
import { useUsageNow } from "../../lib/clock";
import { useAppForeground } from "../../lib/appState";
import {
  mergeAnsweredUsage,
  refreshingUsageProviders,
  usageWindowKey,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  formatUsageSourceNotices,
  retainedUsageLabel,
  usageNotices,
  type UsageProviderRow,
  type UsageViewEnvironment,
} from "@t3tools/client-runtime/state/usage-view";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ChatGptUsageSummary } from "./ChatGptUsageSummary";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import { type RouteProp, useIsFocused, useRoute } from "@react-navigation/native";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
  usageEmptyMessage,
} from "@t3tools/shared/usageFormat";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Platform, View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { AppText as Text } from "../../components/ui/AppText";
import { useWorkspaceSettledContentWidth } from "../layout/workspace-content-width";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";
import { UsageDailyChart } from "./UsageDailyChart";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";
import { usageChartEmptyMessage, usageChartTotals, type UsageChartMetric } from "./usageChartData";
import { PROVIDER_LABEL, useProviderColors, useUsageMixColors } from "./usageProviders";
import { t, msg } from "../../lib/i18n";

type UsageView = UsageChartMetric | "limits";
const VIEW_OPTIONS = [
  { value: "cost", label: msg("Cost") },
  { value: "tokens", label: msg("Tokens") },
  { value: "limits", label: msg("Limits") },
] as const satisfies readonly { value: UsageView; label: string }[];

const WINDOW_OPTIONS = [
  { value: 1, label: msg("24h"), accessibilityLabel: msg("Past 24 hours") },
  { value: 7, label: msg("7d"), accessibilityLabel: msg("Past 7 days") },
  { value: 30, label: msg("30d"), accessibilityLabel: msg("Past 30 days") },
  { value: 90, label: msg("90d"), accessibilityLabel: msg("Past 90 days") },
] as const;

const viewOptions = () => VIEW_OPTIONS.map((option) => ({ ...option, label: t(option.label) }));
const windowOptions = () =>
  WINDOW_OPTIONS.map((option) => ({
    ...option,
    label: t(option.label),
    accessibilityLabel: t(option.accessibilityLabel),
  }));

const CHART_HEIGHT = 180;
const WIDE_CHART_HEIGHT = 260;
// Below this the page keeps the phone's single column.
const WIDE_WIDTH = 600;
const MAX_CONTENT_WIDTH = 1080;
const providerLabel = (provider: UsageProviderKind) => PROVIDER_LABEL[provider];

const EMPTY_USAGE = mergeAnsweredUsage([]);

export function UsageRouteScreen(props: { readonly workspace?: boolean }) {
  const route = useRoute<RouteProp<{ Usage: { tab?: string } | undefined }, "Usage">>();
  return <UsageScreen workspace={props.workspace} tabParam={route.params?.tab} />;
}

function UsageScreen(props: {
  readonly workspace?: boolean;
  readonly tabParam: string | undefined;
}) {
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState(() => ({
    params: props.tabParam,
    view: (props.tabParam === "usage" ? "cost" : "limits") as UsageView,
  }));
  if (selection.params !== props.tabParam) {
    setSelection({
      params: props.tabParam,
      view: props.tabParam === "usage" ? "cost" : "limits",
    });
  }
  const { view } = selection;
  const isFocused = useIsFocused();
  const showingLimits = view === "limits";
  const setView = (view: UsageView) => setSelection({ params: props.tabParam, view });
  const [measuredWidth, setWidth] = useState(0);
  // A workspace pane knows its width in the render that resizes it; measuring lags a frame.
  const width = useWorkspaceSettledContentWidth() ?? measuredWidth;
  const wide = width >= WIDE_WIDTH;
  const [windowDays, selectWindow] = useState(30);
  const resolution = windowDays === 1 ? "hour" : "day";
  const foreground = useAppForeground();
  const advanceWindow = isFocused && foreground && !showingLimits;
  const now = useUsageNow(advanceWindow);
  const window = makeWindow(windowDays, new Date(now), resolution);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const {
    requestedWindow,
    refreshingEnvironmentIds,
    usage,
    environments,
    selectedEnvironments,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, { advanceWindow, enabled: !showingLimits });
  const shown = usage.view.kind === "figures" ? usage.view : null;
  const showingKept = shown?.kept === true;
  const merged = shown?.merged ?? EMPTY_USAGE;
  const shownWindow = shown?.window ?? window;
  const shownEnvironments: readonly Pick<UsageViewEnvironment, "environmentId">[] =
    shown?.environments ?? selectedEnvironments;
  const isPast24Hours = shownWindow.resolution === "hour";
  const limits = useRefreshLimits(selectedEnvironmentIds, isFocused && showingLimits);
  const { coverage, sourceMessages } = usageNotices(usage, selectedEnvironments, requestedWindow);
  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const chartDays =
    isPast24Hours && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime)
      : days;
  const chartTotals = usageChartTotals(merged, isPast24Hours);

  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const refreshingRef = useRef(false);
  const initialLoading = usage.view.kind === "loading";
  const loading = isFocused && !showingLimits && initialLoading && selectedEnvironments.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android uses a live region, while VoiceOver needs an explicit initial announcement
  useEffect(() => {
    if (loading && Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(t("Scanning provider transcripts…"));
    }
  }, [loading]);
  const metric: UsageChartMetric = view === "tokens" ? "tokens" : "cost";
  const progress = usageProgress(selectedEnvironments, {
    refreshingEnvironmentIds,
    providerLabel,
  });
  const rollingRefresh =
    shown?.settled === true &&
    !showingKept &&
    usageWindowKey(shownWindow) !== usageWindowKey(requestedWindow);
  const refreshWindow = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshingUsage(true);
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(t("Updating…"));
    void refresh(requestedWindow).finally(() => {
      refreshingRef.current = false;
      setRefreshingUsage(false);
    });
  };

  const chart = {
    merged,
    days: chartDays,
    daily: chartTotals,
    metric,
    sinceDay: shownWindow.sinceDay,
    untilDay: shownWindow.untilDay,
    isPast24Hours,
    timeZone: shownWindow.timeZone,
  };
  const providers = (
    <ProviderSection
      providers={shown?.providers ?? []}
      refreshingProviders={showingKept ? new Set() : refreshingUsageProviders(selectedEnvironments)}
      metric={metric}
      compact={wide}
    />
  );

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const selectEnvironment = (value: string) => {
    if (value === "all") {
      setSelectedEnvironmentIds(null);
      return;
    }
    const id = EnvironmentId.make(value);
    setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
  };
  const environmentMenu = {
    title: t("Filter usage environments"),
    icon:
      selectedEnvironmentIds === null
        ? ("line.3.horizontal.decrease" as const)
        : ("line.3.horizontal.decrease.circle.fill" as const),
    items: [
      {
        id: "all",
        title: t("All environments"),
        selected: selectedEnvironmentIds === null,
        onPress: () => selectEnvironment("all"),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: showingLimits
          ? !environment.isConnected
            ? t("Waiting for connection…")
            : limits.refreshingEnvironmentIds.has(environment.environmentId)
              ? t("Updating limits…")
              : limits.failedIds.has(environment.environmentId)
                ? t("Could not refresh limits.")
                : t("Connected")
          : usageEnvironmentStatus(
              environment,
              refreshingEnvironmentIds.has(environment.environmentId),
              coverage?.gaps.find(
                (gap) => gap.environment.environmentId === environment.environmentId,
              )?.message,
            ),
        selected:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId),
        onPress: () => selectEnvironment(environment.environmentId),
      })),
    ],
  };

  return (
    <SettingsScreen
      title={t("Usage")}
      menus={showEnvironmentFilter ? [environmentMenu] : undefined}
      workspaceRoot={props.workspace}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        refreshControl={
          showingLimits || canReadDiagnostics ? (
            <RefreshControl
              refreshing={showingLimits ? limits.refreshing : refreshingUsage}
              onRefresh={showingLimits ? () => void limits.refresh() : refreshWindow}
            />
          ) : undefined
        }
      >
        <View className="w-full gap-6 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
          {wide ? (
            <View className="flex-row items-center gap-3">
              {showingLimits ? (
                <View className="flex-1" />
              ) : (
                <SegmentedControl
                  options={windowOptions()}
                  selected={windowDays}
                  onSelect={selectWindow}
                  size="compact"
                  className="flex-1"
                />
              )}
              <SegmentedControl
                options={viewOptions()}
                selected={view}
                onSelect={setView}
                size="compact"
                role="tab"
                className="flex-1"
              />
            </View>
          ) : (
            <SegmentedControl
              options={viewOptions()}
              selected={view}
              onSelect={setView}
              role="tab"
            />
          )}
          <Animated.View
            key={showingLimits ? "limits" : "usage"}
            entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
            className="gap-6"
          >
            {showingLimits ? (
              <UsageLimitsSection
                failedLabels={limits.failedLabels}
                selectedEnvironmentIds={selectedEnvironmentIds}
                wide={wide}
              />
            ) : (
              <>
                {wide ? null : (
                  <SegmentedControl
                    options={windowOptions()}
                    selected={windowDays}
                    onSelect={selectWindow}
                    size="compact"
                  />
                )}
                <ChatGptUsageSummary
                  selectedEnvironmentIds={
                    showingKept
                      ? new Set(shownEnvironments.map(({ environmentId }) => environmentId))
                      : selectedEnvironmentIds
                  }
                  disabled={showingKept}
                />
                {merged.duplicateSources.length > 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    {t(
                      "Counted once across environments sharing a transcript directory: {sources}",
                      {
                        sources: merged.duplicateSources.join(", "),
                      },
                    )}
                  </Text>
                ) : null}
                {coverage === null ? null : (
                  <View className="gap-2">
                    <Notice
                      message={[
                        coverage.title,
                        ...coverage.gaps.map(({ message }) => message),
                      ].join("\n")}
                    />
                    {coverage.gaps.some(({ retryable }) => retryable) ? (
                      <Button
                        label={t("Retry")}
                        disabled={refreshingUsage}
                        onPress={refreshWindow}
                      />
                    ) : null}
                  </View>
                )}
                {selectedEnvironments.length === 0 ? (
                  <Text className="py-16 text-center text-base text-foreground-muted">
                    {environments.length === 0
                      ? t("Connect an environment to see usage.")
                      : t("Select an environment to see usage.")}
                  </Text>
                ) : initialLoading ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    className="py-16 text-center text-base text-foreground-muted"
                  >
                    {t("Scanning provider transcripts…")}
                  </Text>
                ) : shown === null ? null : (
                  <>
                    {showingKept ? (
                      <Text className="text-sm text-foreground-muted">
                        {retainedUsageLabel(shown)}
                      </Text>
                    ) : null}
                    {formatUsageSourceNotices(sourceMessages, providerLabel).map(
                      ({ key, text }) => (
                        <Notice key={key} message={text} />
                      ),
                    )}
                    <UsageUpdating
                      dimmed={showingKept}
                      announce={progress.announcement !== null}
                      label={
                        rollingRefresh && !refreshingUsage
                          ? null
                          : (progress.label ?? (showingKept ? t("Updating…") : null))
                      }
                    >
                      {wide ? (
                        <View className="flex-row gap-6">
                          <View className="w-72 gap-6">
                            <View className="rounded-[24px] border-continuous bg-grouped-card p-4">
                              <UsageSummary merged={merged} metric={metric} />
                            </View>
                            {providers}
                          </View>
                          <View className="min-w-0 flex-1">
                            <ChartCard
                              {...chart}
                              height={WIDE_CHART_HEIGHT}
                              fill
                              title={
                                isPast24Hours
                                  ? metric === "cost"
                                    ? t("Hourly cost")
                                    : t("Hourly processed tokens")
                                  : metric === "cost"
                                    ? t("Daily cost")
                                    : t("Daily processed tokens")
                              }
                            />
                          </View>
                        </View>
                      ) : (
                        <>
                          <ChartCard {...chart} height={CHART_HEIGHT} />
                          {providers}
                        </>
                      )}
                      <TotalsSection
                        merged={merged}
                        isPast24Hours={isPast24Hours}
                        columns={width >= 900 ? 6 : wide ? 3 : 2}
                      />
                      <CostSection merged={merged} wide={wide} />
                      <ModelsSection merged={merged} metric={metric} columns={wide ? 2 : 1} />
                    </UsageUpdating>
                  </>
                )}
              </>
            )}
          </Animated.View>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

const RetainedFigures = createContext(false);

function UsageFigure({ className, ...props }: ComponentProps<typeof Text>) {
  const retained = use(RetainedFigures);
  return <Text {...props} className={cn(className, retained && "text-foreground-muted")} />;
}

function UsageUpdating({
  dimmed,
  announce,
  label,
  children,
}: {
  readonly dimmed: boolean;
  readonly announce: boolean;
  readonly label: string | null;
  readonly children: ReactNode;
}) {
  return (
    <View>
      <View className="gap-6" accessibilityState={{ busy: dimmed }}>
        <RetainedFigures.Provider value={dimmed}>{children}</RetainedFigures.Provider>
      </View>
      {label !== null ? (
        <Animated.View
          entering={FadeIn.delay(150).duration(150).reduceMotion(ReduceMotion.System)}
          accessibilityLiveRegion={announce ? "polite" : "none"}
          pointerEvents="none"
          className="absolute right-4 top-4 h-5 max-w-[55%] flex-row items-center gap-1.5"
        >
          <AppActivityIndicator size="small" colorClassName="accent-adaptive-sky-600-400" />
          <Text className="shrink text-sm text-adaptive-sky-600-400" numberOfLines={1}>
            {label}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function ChartCard(props: {
  readonly merged: MergedUsage;
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly isPast24Hours: boolean;
  readonly timeZone: string;
  readonly height: number;
  /** Replaces the summary when it sits beside the chart. */
  readonly title?: string;
  /** Grows the chart past `height` to match a taller neighbouring column. */
  readonly fill?: boolean;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  const emptyMessage = usageChartEmptyMessage(props.daily, merged, metric);
  const [fillHeight, setFillHeight] = useState(0);
  const height = props.fill ? Math.max(fillHeight, props.height) : props.height;
  const chart =
    emptyMessage === null ? (
      <UsageDailyChart days={props.days} daily={props.daily} metric={metric} height={height} />
    ) : (
      <View style={{ height }} className="items-center justify-center">
        <Text className="text-base text-foreground-muted">{emptyMessage}</Text>
      </View>
    );

  return (
    <View
      className={`gap-4 rounded-[24px] border-continuous bg-grouped-card p-4${props.fill ? " flex-1" : ""}`}
    >
      {props.title ? (
        <Text className="text-sm font-t3-medium text-foreground">{props.title}</Text>
      ) : (
        <UsageSummary merged={merged} metric={metric} />
      )}

      {props.fill ? (
        // Absolute so the measured slot can shrink again when the neighbour gets shorter.
        <View
          className="flex-1"
          style={{ minHeight: props.height }}
          onLayout={(event) => setFillHeight(event.nativeEvent.layout.height)}
        >
          <View className="absolute inset-0">{chart}</View>
        </View>
      ) : (
        chart
      )}

      <View className="gap-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[0] ?? "", props.timeZone)
              : formatDayShort(props.sinceDay)}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            {props.isPast24Hours
              ? formatHourShort(props.days[props.days.length - 1] ?? "", props.timeZone)
              : formatDayShort(props.untilDay)}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
          {merged.providers.map((provider) => (
            <View key={provider.provider} className="flex-row items-center gap-1.5">
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: colors[provider.provider] }}
              />
              <Text className="text-xs text-foreground-muted">
                {PROVIDER_LABEL[provider.provider]}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function UsageSummary(props: { readonly merged: MergedUsage; readonly metric: UsageChartMetric }) {
  const { merged, metric } = props;
  return (
    <View className="gap-0.5">
      <Text className="text-sm text-foreground-muted">
        {metric === "cost" ? t("Raw token cost") : t("Processed tokens")}
      </Text>
      <UsageFigure className="text-4xl font-t3-bold tabular-nums text-foreground">
        {metric === "cost" ? `${formatUsd(merged.costUsd)}*` : formatTokens(merged.totalTokens)}
      </UsageFigure>
      <Text className="text-sm text-foreground-muted">
        {metric === "cost"
          ? t("* if billed at full API rate")
          : t("Across {count} sessions", { count: formatCount(merged.sessions) })}
      </Text>
    </View>
  );
}

function ProviderSection(props: {
  readonly providers: readonly UsageProviderRow[];
  readonly refreshingProviders: ReadonlySet<UsageProviderKind>;
  readonly metric: UsageChartMetric;
  /** Drops the share bar so the list fits beside the chart. */
  readonly compact: boolean;
}) {
  const { providers, metric } = props;
  const colors = useProviderColors();
  if (providers.length === 0) return null;

  // Hermes lacks toSorted.
  const ordered = [...providers].sort((a, b) =>
    metric === "cost"
      ? (b.totals?.costUsd ?? 0) - (a.totals?.costUsd ?? 0)
      : (b.totals?.totalTokens ?? 0) - (a.totals?.totalTokens ?? 0),
  );

  return (
    <SettingsSection title={t("Providers")}>
      {ordered.map((provider, index) => {
        const totals = provider.totals;
        const share = metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
        return (
          <View
            key={provider.provider}
            className={cn(
              props.compact ? "gap-0.5 px-4 py-3" : "gap-2 p-4",
              index > 0 && "border-t border-border-subtle",
            )}
          >
            <View className="flex-row items-baseline justify-between gap-3">
              <View className="flex-row items-center gap-2">
                <View
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: colors[provider.provider] }}
                />
                <Text
                  className={
                    props.compact ? "text-base text-foreground" : "text-lg text-foreground"
                  }
                >
                  {PROVIDER_LABEL[provider.provider]}
                </Text>
                {props.refreshingProviders.has(provider.provider) ? (
                  <Text className="text-xs text-foreground-muted">{t("Updating…")}</Text>
                ) : null}
              </View>
              <UsageFigure
                className={
                  props.compact
                    ? "text-base tabular-nums text-foreground"
                    : "text-lg tabular-nums text-foreground"
                }
              >
                {totals === null
                  ? "–"
                  : metric === "cost"
                    ? formatUsd(totals.costUsd)
                    : formatTokens(totals.totalTokens)}
              </UsageFigure>
            </View>
            {props.compact ? null : (
              <View className="h-1 flex-row overflow-hidden rounded-full bg-subtle">
                <View
                  className="h-full rounded-full"
                  style={{ flex: share, backgroundColor: colors[provider.provider] }}
                />
                <View style={{ flex: 1 - share }} />
              </View>
            )}
            <Text className="text-sm text-foreground-muted">
              {totals === null
                ? "–"
                : metric === "cost"
                  ? t("{share} of cost · {tokens} tokens", {
                      share: formatPercent(share),
                      tokens: formatTokens(totals.totalTokens),
                    })
                  : t("{share} of tokens · {cost}", {
                      share: formatPercent(share),
                      cost: formatUsd(totals.costUsd),
                    })}
            </Text>
          </View>
        );
      })}
    </SettingsSection>
  );
}

function TotalsSection(props: {
  readonly merged: MergedUsage;
  readonly isPast24Hours: boolean;
  readonly columns: number;
}) {
  const { merged } = props;
  const activePeriods = (props.isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;

  return (
    <SettingsSection title={t("Totals")}>
      <View className="flex-row flex-wrap">
        <MetricCell
          columns={props.columns}
          label={t("Processed tokens")}
          value={formatTokens(merged.totalTokens)}
          detail={
            props.isPast24Hours
              ? t("{tokens} per active hour", { tokens: formatTokens(periodAverage) })
              : t("{tokens} per active day", { tokens: formatTokens(periodAverage) })
          }
        />
        <MetricCell
          columns={props.columns}
          label={t("Cache savings")}
          value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          detail={
            merged.costUsd > 0
              ? t("{ratio}x the raw cost", {
                  ratio: (merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1),
                })
              : t("vs full input rates")
          }
        />
        <MetricCell
          columns={props.columns}
          label={t("Cached input")}
          value={formatTokens(merged.cachedInputTokens)}
          detail={t("{share} of observed input", { share: formatPercent(cachedShare) })}
        />
        <MetricCell
          columns={props.columns}
          label={t("Uncached input")}
          value={formatTokens(merged.uncachedInputTokens)}
          detail={t("{tokens} cache writes", { tokens: formatTokens(merged.cacheCreationTokens) })}
        />
        <MetricCell
          columns={props.columns}
          label={t("Output")}
          value={formatTokens(merged.outputTokens)}
          detail={t("incl. {tokens} reasoning", { tokens: formatTokens(merged.reasoningTokens) })}
        />
        <MetricCell
          columns={props.columns}
          label={t("Unpriced")}
          value={formatPercent(merged.costQuality.unpricedShare)}
          detail={t("of records, excluded from cost")}
        />
      </View>
    </SettingsSection>
  );
}

function CostSection(props: { readonly merged: MergedUsage; readonly wide: boolean }) {
  const { categoryCost, speedCost } = props.merged;
  const colors = useUsageMixColors();
  const byType = [
    { label: t("Input"), value: categoryCost.input, color: colors.input },
    { label: t("Cache read"), value: categoryCost.cacheRead, color: colors.cacheRead },
    { label: t("Cache write"), value: categoryCost.cacheWrite, color: colors.cacheWrite },
    { label: t("Output"), value: categoryCost.output, color: colors.output },
    // Reported cost with no rates to split it, or from older servers. Below a
    // cent it is rounding, not usage.
    {
      label: t("Other"),
      value: categoryCost.unsplit >= 0.005 ? categoryCost.unsplit : 0,
      color: colors.other,
    },
  ];
  const bySpeed = [
    { label: t("Standard"), value: speedCost.standard, color: colors.standard },
    { label: t("Fast"), value: speedCost.fast, color: colors.fast },
    { label: t("Ultrafast"), value: speedCost.ultrafast, color: colors.ultrafast },
  ];
  const emptyMessage = usageEmptyMessage(props.merged, "cost");

  return (
    <SettingsSection title={t("Cost")}>
      <View className={props.wide ? "flex-row" : undefined}>
        <View className={props.wide ? "min-w-0 flex-1" : undefined}>
          <ShareBar label={t("By type")} segments={byType} emptyMessage={emptyMessage} />
        </View>
        {speedCost.fast + speedCost.ultrafast > 0 ? (
          <View
            className={
              props.wide
                ? "min-w-0 flex-1 border-l border-border-subtle"
                : "border-t border-border-subtle"
            }
          >
            <ShareBar
              label={t("By speed")}
              segments={bySpeed}
              emptyMessage={emptyMessage}
              aside={t("{cost} premium", { cost: formatUsd(speedCost.premium) })}
            />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function ShareBar(props: {
  readonly label: string;
  readonly segments: readonly { label: string; value: number; color: string }[];
  readonly aside?: string;
  readonly emptyMessage: string;
}) {
  const visible = props.segments.filter((segment) => segment.value > 0);

  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        {props.aside ? (
          <Text className="text-sm tabular-nums text-foreground-muted">{props.aside}</Text>
        ) : null}
      </View>
      {visible.length === 0 ? (
        <Text className="text-xs text-foreground-muted">{props.emptyMessage}</Text>
      ) : (
        <View className="h-2 flex-row gap-0.5">
          {visible.map((segment) => (
            <View
              key={segment.label}
              className="h-full rounded-sm"
              style={{ flex: segment.value, backgroundColor: segment.color }}
            />
          ))}
        </View>
      )}
      <View className="flex-row flex-wrap gap-x-4 gap-y-1.5">
        {visible.map((segment) => (
          <View key={segment.label} className="flex-row items-center gap-1.5">
            <View className="size-2 rounded-sm" style={{ backgroundColor: segment.color }} />
            <Text className="text-sm text-foreground-muted">{segment.label}</Text>
            <UsageFigure className="text-sm tabular-nums text-foreground">
              {formatUsd(segment.value)}
            </UsageFigure>
          </View>
        ))}
      </View>
    </View>
  );
}

function MetricCell(props: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly columns: number;
}) {
  return (
    <View className="gap-0.5 p-4" style={{ width: `${100 / props.columns}%` }}>
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <UsageFigure className="text-xl font-t3-medium tabular-nums text-foreground">
        {props.value}
      </UsageFigure>
      <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
    </View>
  );
}

function ModelsSection(props: {
  readonly merged: MergedUsage;
  readonly metric: UsageChartMetric;
  readonly columns: 1 | 2;
}) {
  const { merged, metric } = props;
  const colors = useProviderColors();
  if (merged.models.length === 0) return null;

  // Hermes lacks toSorted.
  const ordered = [...merged.models].sort((a, b) =>
    metric === "cost"
      ? b.costUsd - a.costUsd || b.totalTokens - a.totalTokens
      : b.totalTokens - a.totalTokens || b.costUsd - a.costUsd,
  );

  return (
    <SettingsSection title={t("By model")}>
      <View className="flex-row flex-wrap">
        {ordered.map((model, index) => (
          <View
            key={`${model.provider}:${model.model}`}
            className={cn(
              "flex-row items-center gap-3 p-4",
              index >= props.columns && "border-t border-border-subtle",
              index % props.columns === 1 && "border-l border-border-subtle",
            )}
            style={{ width: `${100 / props.columns}%` }}
          >
            <View
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors[model.provider] }}
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-base text-foreground" numberOfLines={1}>
                {model.model}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {metric === "tokens"
                  ? t("{share} of tokens · {cost}", {
                      share: formatPercent(model.tokenShare),
                      cost: isModelCostUnknown(model)
                        ? t("no known rates")
                        : formatUsd(model.costUsd),
                    })
                  : isModelCostUnknown(model)
                    ? t("no known rates · {tokens} tokens", {
                        tokens: formatTokens(model.totalTokens),
                      })
                    : t("{share} of cost · {tokens} tokens", {
                        share: formatPercent(model.costShare),
                        tokens: formatTokens(model.totalTokens),
                      })}
              </Text>
            </View>
            <UsageFigure className="text-base tabular-nums text-foreground">
              {metric === "tokens"
                ? formatTokens(model.totalTokens)
                : isModelCostUnknown(model)
                  ? t("Unpriced")
                  : formatUsd(model.costUsd)}
            </UsageFigure>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}

function usageEnvironmentStatus(
  environment: EnvironmentUsageStatus,
  refreshing: boolean,
  gap?: string,
): string {
  if (!environment.isConnected) return t("Waiting for connection…");
  if (
    environment.summary !== null &&
    !isCompatibleUsageContractVersion(environment.summary.contractVersion, USAGE_CONTRACT_VERSION)
  )
    return t("Update required.");
  if (gap) return gap;
  if (environment.error !== null) return environment.error;
  const progress = usageEnvironmentProgress(environment, refreshing);
  if (progress.phase === "loading") return t("Loading usage…");
  if (progress.phase === "stale") return t("Updating usage…");
  if (progress.phase === "partway")
    return updatingProvidersLabel(progress.providers, providerLabel);
  return t("Usage up to date");
}
