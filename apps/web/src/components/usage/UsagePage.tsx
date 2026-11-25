import { useUsageDocumentVisible, useUsageNow } from "../../hooks/useUsageNow";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { CircleAlertIcon, ChevronDownIcon, InfoIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { isAtomCommandInterrupted, settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import {
  cursorKeychainAccessEnvironments,
  refreshUsageLimits,
} from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  mergeAnsweredUsage,
  refreshingUsageProviders,
  usageWindowKey,
  usageSelectionKey,
  usageProgress,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  formatUsageSourceNotices,
  retainedUsageLabel,
  usageNotices,
  type UsageFigures,
  type UsageProviderRow,
  type UsageViewEnvironment,
} from "@t3tools/client-runtime/state/usage-view";

import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
  usageWindowLabel,
} from "@t3tools/shared/usageFormat";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageGapsNotice } from "./UsageGapsNotice";
import { UsageLimitsSection } from "./UsageLimits";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart } from "./UsageProviderChart";
import {
  refreshScheduledTaskGroupUsage,
  UsageScheduledTaskGroups,
  useScheduledTaskStatsAccess,
} from "./UsageScheduledTaskGroups";
import { UsageRetryButton } from "./UsageRetryButton";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import {
  costTypeSegments,
  modelShare,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION, providersWithUsage } from "./usageProviders";
import {
  usageResolution,
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";
import { msg, t, tn } from "~/i18n";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

type UsageBreakdown = "model" | "time";

const EMPTY_USAGE = mergeAnsweredUsage([]);
const skeletonProvidersAtom = Atom.make<readonly UsageProviderKind[]>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:skeleton-providers"),
);

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
const selectedUsageModelKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:selected-model-key"),
);

function selectUsageModel(key: string | null): void {
  appAtomRegistry.set(selectedUsageModelKeyAtom, key);
}

function UsageModelDialogHost({
  view,
  pageRef,
  onSetPrice,
  ...dialogProps
}: Pick<Parameters<typeof UsageModelDialog>[0], "metric" | "chartWindow"> & {
  readonly pageRef: React.RefObject<HTMLElement | null>;
  readonly view: UsageFigures | null;
  readonly onSetPrice: (model: string) => void;
}) {
  const selectedKey = useAtomValue(selectedUsageModelKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  const model =
    selectedKey === null
      ? undefined
      : view?.merged.models.find(
          (candidate) => `${candidate.provider}:${candidate.model}` === selectedKey,
        );
  const lost = selectedKey !== null && model === undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the shared model selection when the shown figures no longer hold the model
  useEffect(() => {
    if (!lost) return;
    selectUsageModel(null);
    if (document.activeElement === document.body) {
      const page = pageRef.current;
      const nextModel = page?.querySelector<HTMLButtonElement>(
        '[data-usage-model]:not([aria-disabled="true"])',
      );
      (nextModel ?? page)?.focus();
    }
  }, [lost, pageRef]);
  if (model === undefined || view === null) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      environments={view.environments}
      readOnly={view.kept}
      status={view.kept ? retainedUsageLabel(view, dialogProps.chartWindow.hour12) : undefined}
      onSetPrice={() => {
        selectUsageModel(null);
        onSetPrice(model.model);
      }}
      onClose={() => selectUsageModel(null)}
    />
  );
}

export function UsagePage() {
  const pageRef = useRef<HTMLElement>(null);
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut ? `${t(option.label)} (${shortcut})` : t(option.label);
  };
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsRefreshFailures, setLimitsRefreshFailures] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const refreshingRef = useRef(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  // Lives here so a rescan's skeleton or a visit to Limits does not reset it to Model.
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("model");
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  const windowDays = preferences.windowDays;
  const resolution = usageResolution(windowDays, preferences.weekResolution);
  const visible = useUsageDocumentVisible();
  const advanceWindow = visible && !showingLimits;
  const now = useUsageNow(advanceWindow);
  const window = makeWindow(windowDays, new Date(now), resolution);
  const chartType = preferences.chartType ?? "area";
  const {
    requestedWindow,
    refreshingEnvironmentIds,
    environments,
    selectedEnvironments,
    usage,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, preferences.hiddenProviders, {
    advanceWindow,
    enabled: !showingLimits,
  });
  const shown = usage.view.kind === "figures" ? usage.view : null;
  const showingKept = shown?.kept === true;
  // A kept view also stays after every environment has answered, when the new period failed.
  const updatingKept = showingKept && shown?.settled !== true;
  const merged = shown?.merged ?? EMPTY_USAGE;
  const shownEnvironments: readonly Pick<UsageViewEnvironment, "environmentId" | "label">[] =
    shown?.environments ?? selectedEnvironments;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const rollingRefresh =
    shown?.settled === true &&
    !showingKept &&
    usageWindowKey(shownWindow) !== usageWindowKey(requestedWindow);
  const progress = usageProgress(selectedEnvironments, {
    refreshingEnvironmentIds,
    providerLabel,
  });
  const activeProviders = PROVIDER_ORDER.filter((provider) =>
    shown?.providers.some((row) => row.provider === provider),
  );
  const footprint = providersWithUsage(merged.providers);
  const settledAnswer =
    shown !== null &&
    !showingKept &&
    !selectedEnvironments.some(({ isConnected, isPending }) => isConnected && isPending);
  const { coverage, sourceMessages } = usageNotices(usage, selectedEnvironments, requestedWindow, {
    hidden: hiddenProviders,
    hour12,
  });
  const shownHiddenProviders = shown?.hiddenProviders ?? hiddenProviders;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retain the last settled provider footprint across Usage visits
  useEffect(() => {
    if (!settledAnswer) return;
    const previous = appAtomRegistry.get(skeletonProvidersAtom);
    if (
      previous.length !== footprint.length ||
      previous.some((provider, index) => provider !== footprint[index])
    ) {
      appAtomRegistry.set(skeletonProvidersAtom, footprint);
    }
  }, [footprint, settledAnswer]);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const cursorAccessEnvironments = hiddenProviders.has("cursor")
    ? []
    : cursorKeychainAccessEnvironments(selectedEnvironments, environments);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );
  const statsAccess = useScheduledTaskStatsAccess(selectedEnvironments);
  // Each request keeps its own permission check, so Refresh only needs one of them to be readable.
  const canRefreshUsage = canReadDiagnostics || statsAccess.readableIds.length > 0;

  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const selectWindow = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
  };
  const selectWeekResolution = (weekResolution: "day" | "hour") => {
    updatePreferences({ weekResolution });
  };
  const chartControls = (
    <div className="flex flex-wrap items-center gap-2">
      {windowDays === 7 ? (
        <ToggleGroup
          aria-label={t("Usage resolution")}
          value={[preferences.weekResolution ?? "day"]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "day" || value === "hour") selectWeekResolution(value);
          }}
        >
          <Toggle value="day">{t("Daily")}</Toggle>
          <Toggle value="hour">{t("Hourly")}</Toggle>
        </ToggleGroup>
      ) : null}
      <ToggleGroup
        aria-label={t("Usage chart style")}
        value={[chartType]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "area" || value === "bar") updatePreferences({ chartType: value });
        }}
      >
        <Toggle value="area">{t("Area")}</Toggle>
        <Toggle value="bar">{t("Stacked bars")}</Toggle>
      </ToggleGroup>
    </div>
  );
  const selectMetric = (nextMetric: UsageMetric) => {
    updatePreferences({ metric: nextMetric });
  };
  const refreshLimits = (automatic = false, afterPending = false) =>
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, async ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
            return;
          }
          const refreshed = await refreshUsageLimits(
            environmentId,
            () => refreshProviders({ environmentId, input: {} }),
            automatic,
            afterPending,
          );
          // A throttled or shared refresh answers nothing new, so it keeps the earlier outcome.
          if (refreshed === undefined) return;
          // Command failures come back as results, so a failed refresh would otherwise look done.
          return {
            environmentId,
            failed: refreshed._tag === "Failure" && !isAtomCommandInterrupted(refreshed),
          };
        }),
      ),
    ).then((result) => {
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      const outcomes = result.value.filter((outcome) => outcome !== undefined);
      setLimitsRefreshFailures((previous) => {
        const next = new Set(previous);
        for (const outcome of outcomes) {
          if (outcome.failed) next.add(outcome.environmentId);
          else next.delete(outcome.environmentId);
        }
        return next;
      });
    });
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    // Periods do nothing on Limits, so their keys stay free there.
    if (!metricOption && (!periodOption || showingLimits)) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.days);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric and period shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    // The Refresh buttons stay focusable while a refresh runs, so a press then ends here.
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const statsEnvironmentIds = statsAccess.supportedIds;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(requestedWindow).finally(() => {
      refreshScheduledTaskGroupUsage(appAtomRegistry, statsEnvironmentIds, requestedWindow);
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const refreshButton = (
    <Button
      onClick={refreshWindow}
      aria-label={showingLimits ? t("Refresh limits") : t("Refresh usage")}
      aria-busy={isRefreshing}
      aria-disabled={isRefreshing}
      disabled={!showingLimits && !canRefreshUsage}
      size="icon-sm"
      variant="ghost"
    >
      <RefreshIcon size="sm" refreshing={isRefreshing} />
    </Button>
  );
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits from the server when the connected environment set changes
  useEffect(() => {
    if (showingLimits && connectedLimitsEnvironments) autoRefreshLimits();
  }, [showingLimits, connectedLimitsEnvironments]);

  const failedLimitsLabels = [...presentations].flatMap(([environmentId, presentation]) =>
    limitsRefreshFailures.has(environmentId) &&
    (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId))
      ? [presentation.entry.target.label]
      : [],
  );
  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);
  const showChatGptSharing =
    !shownHiddenProviders.has("codex") &&
    [...presentationsWithProviders].some(
      ([id, presentation]) =>
        shownEnvironments.some((environment) => environment.environmentId === id) &&
        (presentation.serverConfig?.providers ?? []).some(usesChatGptSharing),
    );

  const windowLabel = usageWindowLabel(shownWindow, hour12);
  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2 @4xl/usage-header:flex">
      <WorkspaceBreadcrumb ariaLabel={t("Usage breadcrumb")} className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>{t("Usage")}</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem className="min-w-10 shrink">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            refreshingEnvironmentIds={refreshingEnvironmentIds}
            duplicateSources={showingKept ? [] : merged.duplicateSources}
            coverage={coverage}
            onOpenModelPrices={() => setPriceDialog({})}
          />
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageProviderFilter
            hiddenProviders={hiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground @7xl/usage-header:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto hidden shrink-0 items-center justify-end gap-2 @4xl/usage-header:flex">
        {/* Limits are always current, so they have no period. The period sits before the metric
            tabs so dropping it never moves them. */}
        {showingLimits ? null : (
          <ToggleGroup
            aria-label={t("Usage period")}
            variant="segmented"
            value={[String(windowDays)]}
            onValueChange={(next) => {
              const value = next[0];
              if (value) selectWindow(Number(value));
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
                {t(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          aria-label={t("Usage metric")}
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {t(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>
        {refreshButton}
      </div>
      <div className="ms-auto flex shrink-0 items-center justify-end gap-1 @4xl/usage-header:hidden">
        {showingLimits ? null : (
          <Select value={String(windowDays)} onValueChange={(value) => selectWindow(Number(value))}>
            <SelectTrigger
              aria-label={t("Usage period")}
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>
                {t(WINDOW_OPTIONS.find((option) => option.days === windowDays)?.label ?? "")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem
                  key={option.days}
                  value={String(option.days)}
                  title={shortcutTitle(option)}
                >
                  {t(option.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label={t("Usage metric")}
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>
              {t(METRIC_OPTIONS.find((option) => option.value === metric)?.label ?? "")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {t(option.label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {refreshButton}
      </div>
    </div>
  );

  return (
    <SidebarInset
      ref={pageRef}
      {...workspaceAreaProps("usage", 1, t("Usage"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="@container/usage-header border-b">
          {topbarContent}
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!showingLimits ? (
              <>
                <span role="status" className="sr-only">
                  {progress.announcement}
                </span>
                <UsageGapsNotice
                  notice={coverage}
                  retrying={refreshingUsage}
                  onRetry={refreshWindow}
                />
              </>
            ) : null}
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? showingLimits
                    ? t("Connect an environment to see limits.")
                    : t("Connect an environment to see usage.")
                  : showingLimits
                    ? t("Select an environment to see limits.")
                    : t("Select an environment to see usage.")}
              </p>
            ) : PROVIDER_ORDER.every((provider) => hiddenProviders.has(provider)) ? (
              <div
                role="status"
                className="space-y-3 py-12 text-center text-sm text-muted-foreground"
              >
                <p>{t("Every provider is hidden.")}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => updatePreferences({ hiddenProviders: [] })}
                >
                  {t("Show all providers")}
                </Button>
              </div>
            ) : showingLimits ? (
              <>
                {failedLimitsLabels.length > 0 ? (
                  <Alert variant="warning" role="status">
                    <CircleAlertIcon aria-hidden />
                    <AlertDescription>
                      {t(
                        "Couldn't refresh limits on {environments}. Showing the last values read.",
                        {
                          environments: failedLimitsLabels.join(", "),
                        },
                      )}
                    </AlertDescription>
                    <AlertAction>
                      <UsageRetryButton pending={isRefreshing} onRetry={refreshWindow} />
                    </AlertAction>
                  </Alert>
                ) : null}
                <UsageLimitsSection
                  selectedEnvironmentIds={selectedEnvironmentIds}
                  hiddenProviders={hiddenProviders}
                  cursorPrompt={
                    cursorAccessEnvironments.length > 0 ? (
                      <CursorEnableLimits
                        environments={cursorAccessEnvironments}
                        onEnabled={() => {
                          void refresh();
                          void refreshLimits(false, true);
                        }}
                      />
                    ) : null
                  }
                />
              </>
            ) : usage.view.kind === "loading" ? (
              <UsageSkeleton hiddenProviders={hiddenProviders} />
            ) : shown === null ? null : (
              <>
                {showingKept ? (
                  <p className="text-xs text-muted-foreground">
                    {retainedUsageLabel(shown, hour12)}
                  </p>
                ) : null}
                <UsageOverview
                  merged={merged}
                  shownWindow={shownWindow}
                  hour12={hour12}
                  chartType={chartType}
                  chartControls={chartControls}
                  days={days}
                  hours={hours}
                  showingKept={showingKept}
                  updating={updatingKept}
                  progressLabel={
                    rollingRefresh && !refreshingUsage
                      ? null
                      : (progress.label ?? (updatingKept ? t("Updating…") : null))
                  }
                  metric={metric === "tokens" ? "tokens" : "cost"}
                  selectedEnvironments={shownEnvironments}
                  sourceMessages={formatUsageSourceNotices(sourceMessages, providerLabel)}
                  activeProviders={activeProviders}
                  providerRows={shown.providers}
                  refreshingProviders={refreshingUsageProviders(
                    selectedEnvironments,
                    shownHiddenProviders,
                  )}
                  cursorAccessEnvironments={cursorAccessEnvironments}
                  showChatGptSharing={showChatGptSharing}
                  onCursorEnabled={() => {
                    void refresh();
                    void refreshLimits(false, true);
                  }}
                  onSelectModel={selectUsageModel}
                  breakdown={breakdown}
                  onBreakdownChange={setBreakdown}
                />
              </>
            )}
            {!showingLimits && selectedEnvironments.length > 0 ? (
              <UsageScheduledTaskGroups
                selectionKey={usageSelectionKey(
                  requestedWindow,
                  selectedEnvironments,
                  preferences.hiddenProviders,
                )}
                period={requestedWindow}
                environments={selectedEnvironments}
              />
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits ? null : (
        <UsageModelDialogHost
          pageRef={pageRef}
          view={shown}
          metric={metric === "tokens" ? "tokens" : "cost"}
          chartWindow={{
            chartType,
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
          onSetPrice={(model) => setPriceDialog({ model })}
        />
      )}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

function UsageOverview({
  merged,
  shownWindow,
  hour12,
  days,
  hours,
  showingKept,
  updating,
  progressLabel,
  chartType,
  chartControls,
  metric,
  selectedEnvironments,
  sourceMessages,
  activeProviders,
  providerRows,
  refreshingProviders,
  cursorAccessEnvironments,
  showChatGptSharing,
  onCursorEnabled,
  onSelectModel,
  breakdown,
  onBreakdownChange,
}: {
  readonly merged: MergedUsage;
  readonly chartType: "area" | "bar";
  readonly chartControls: React.ReactNode;
  readonly shownWindow: UsageSummaryInput;
  readonly hour12: boolean;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly updating: boolean;
  readonly progressLabel: string | null;
  readonly metric: "tokens" | "cost";
  readonly selectedEnvironments: readonly Pick<UsageViewEnvironment, "environmentId" | "label">[];
  readonly sourceMessages: ReturnType<typeof formatUsageSourceNotices>;
  readonly activeProviders: readonly UsageProviderKind[];
  readonly providerRows: readonly UsageProviderRow[];
  readonly refreshingProviders: ReadonlySet<UsageProviderKind>;
  readonly cursorAccessEnvironments: readonly EnvironmentUsageStatus[];
  readonly showChatGptSharing: boolean;
  readonly onCursorEnabled: () => void;
  readonly onSelectModel: (key: string) => void;
  readonly breakdown: UsageBreakdown;
  readonly onBreakdownChange: (breakdown: UsageBreakdown) => void;
}) {
  const shownHourly = shownWindow.resolution === "hour";
  const loadingPartial = showingKept;
  const loadingProviders = showingKept ? new Set(activeProviders) : refreshingProviders;
  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? merged.hourly : merged.daily
  ).toReversed();
  const breakdownModels =
    breakdown === "model" && metric === "tokens"
      ? sortModelsByTokens(merged.models)
      : merged.models;
  const breakdownPeak = breakdownModels.reduce(
    (peak, model) => Math.max(peak, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );
  const cursorInsertAt =
    Math.max(activeProviders.indexOf("codex"), activeProviders.indexOf("claude")) + 1;
  const summaryRows: ReadonlyArray<
    | { readonly kind: "usage"; readonly provider: UsageProviderKind }
    | { readonly kind: "enable"; readonly environment: EnvironmentUsageStatus }
  > = [
    ...activeProviders
      .slice(0, cursorInsertAt)
      .map((provider) => ({ kind: "usage" as const, provider })),
    ...cursorAccessEnvironments.map((environment) => ({ kind: "enable" as const, environment })),
    ...activeProviders
      .slice(cursorInsertAt)
      .map((provider) => ({ kind: "usage" as const, provider })),
  ];

  return (
    <div aria-busy={updating} className="flex flex-col gap-6">
      {sourceMessages.map(({ key, text }) => (
        <p key={key} role="status" className="mb-4 text-sm text-muted-foreground">
          {text}
        </p>
      ))}
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "text-4xl font-semibold text-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {metric === "cost" ? formatUsd(merged.costUsd) : formatTokens(merged.totalTokens)}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span className="shrink-0">
                <span className={figureClass(loadingPartial)}>
                  {tn(merged.sessions, "{count} session", "{count} sessions", {
                    count: formatCount(merged.sessions),
                  })}
                </span>
                {metric === "cost" && ` · ${t("API estimate")}`}
              </span>
              {metric === "cost" && merged.costQuality.unpricedShare > 0 && (
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    render={<InlineButton tone="muted" />}
                    aria-label={t("Unpriced usage details")}
                  >
                    <InfoIcon className="size-3" aria-hidden />
                  </PopoverTrigger>
                  <PopoverPopup side="top" tooltipStyle>
                    {t("API estimate excludes {percent} unpriced records.", {
                      percent: formatPercent(merged.costQuality.unpricedShare),
                    })}
                  </PopoverPopup>
                </Popover>
              )}
              <span className="min-w-0 truncate">{progressLabel}</span>
            </span>
          </div>

          {showChatGptSharing ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t("ChatGPT shared usage")}</span>
              <ChatGptUsageButton size="xs" />
            </div>
          ) : null}

          {summaryRows.map((row) => {
            if (row.kind === "enable") {
              return (
                <CursorEnableRow
                  key={`enable:${row.environment.environmentId}`}
                  environmentId={row.environment.environmentId}
                  label={row.environment.label}
                  showEnvironment={selectedEnvironments.length > 1}
                  onEnabled={onCursorEnabled}
                />
              );
            }
            const provider = row.provider;
            const totals = providerRows.find((entry) => entry.provider === provider)?.totals;
            const share = metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
            const providerSessions = totals?.sessions ?? 0;
            const sessionLabel = tn(providerSessions, "{count} session", "{count} sessions", {
              count: formatCount(providerSessions),
            });
            const providerLoading = loadingProviders.has(provider);
            return (
              <div
                key={provider}
                role="group"
                aria-label={PROVIDER_PRESENTATION[provider].label}
                className="flex flex-col gap-1"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: PROVIDER_PRESENTATION[provider].color,
                      }}
                    />
                    <ProviderMark provider={provider} className="size-4" />
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
                      <span
                        className={cn(
                          "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                          figureClass(providerLoading),
                        )}
                      >
                        {!showingKept && providerLoading ? t("Updating…") : sessionLabel}
                      </span>
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-sm font-medium text-foreground tabular-nums",
                      figureClass(providerLoading),
                    )}
                  >
                    {totals == null
                      ? "–"
                      : metric === "cost"
                        ? formatUsd(totals.costUsd)
                        : formatTokens(totals.totalTokens)}
                  </span>
                </div>
                <span className={cn("text-xs text-muted-foreground", figureClass(providerLoading))}>
                  {totals == null
                    ? "–"
                    : metric === "cost"
                      ? t("{percent} of cost · {tokens} tokens", {
                          percent: formatPercent(share),
                          tokens: formatTokens(totals?.totalTokens ?? 0),
                        })
                      : t("{percent} of tokens · {cost}", {
                          percent: formatPercent(share),
                          cost: formatUsd(totals?.costUsd ?? 0),
                        })}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">
              {shownHourly
                ? metric === "tokens"
                  ? t("Hourly processed tokens")
                  : t("Hourly cost")
                : metric === "tokens"
                  ? t("Daily processed tokens")
                  : t("Daily cost")}
            </h2>
            {chartControls}
          </div>
          <UsageProviderChart
            chartType={chartType}
            providers={activeProviders}
            loadingProviders={loadingProviders}
            days={days}
            daily={merged.daily}
            hours={hours}
            hourly={merged.hourly}
            metric={metric}
            referenceTime={shownWindow.untilTime}
            resolution={shownHourly ? "hour" : "day"}
            timeZone={shownWindow.timeZone}
            hour12={hour12}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">{t("Totals")}</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            loading={loadingPartial}
            label={t("Processed tokens")}
            value={formatTokens(merged.totalTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={t("Cached input")}
            value={formatTokens(merged.cachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={t("Uncached input")}
            value={formatTokens(merged.uncachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={t("Output")}
            value={formatTokens(merged.outputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={t("Cache savings")}
            value={formatUsd(merged.costQuality.cacheSavingsUsd)}
          />
        </div>
      </section>

      <section className={cn("grid gap-x-12 gap-y-8 lg:grid-cols-2", figureClass(loadingPartial))}>
        {metric === "tokens" ? (
          <UsageShareBar
            label={t("Tokens by type")}
            segments={tokenTypeSegments(merged)}
            format={formatTokens}
            recordedUsage={merged}
            metric="tokens"
          />
        ) : (
          <>
            <UsageShareBar
              label={t("Cost by type")}
              segments={costTypeSegments(merged.categoryCost)}
              format={formatUsd}
              recordedUsage={merged}
              metric="cost"
            />
            {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
              <UsageShareBar
                label={t("Cost by speed")}
                segments={speedCostSegments(merged.speedCost)}
                format={formatUsd}
                recordedUsage={merged}
                metric="cost"
                aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
              />
            ) : null}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t("Breakdown")}</h2>
          <ToggleGroup
            aria-label={t("Usage breakdown")}
            variant="segmented"
            value={[breakdown]}
            onValueChange={(next) => {
              const value = next[0];
              if (!showingKept && (value === "model" || value === "time")) {
                onBreakdownChange(value);
              }
            }}
          >
            {(
              [
                { value: "model", label: t("Model") },
                { value: "time", label: shownHourly ? t("Hour") : t("Day") },
              ] as const
            ).map((option) => (
              <Toggle key={option.value} value={option.value} aria-disabled={showingKept}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        {breakdown === "model" ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="py-2 pr-3 text-left font-normal">{"#"}</th>
                <th className="w-full py-2 text-left font-normal">{t("Model")}</th>
                <th className="py-2 pl-6 font-normal">{t("Cost")}</th>
                <th className="hidden py-2 pl-6 font-normal sm:table-cell">{t("Share")}</th>
                <th className="py-2 pl-6 font-normal">{t("Tokens")}</th>
              </tr>
            </thead>
            <tbody>
              {breakdownModels.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    {t("No activity in this window.")}
                  </td>
                </tr>
              ) : (
                breakdownModels.map((model, index) => {
                  const key = `${model.provider}:${model.model}`;
                  const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                  const hasBar = value > 0 && breakdownPeak > 0;
                  const share = modelShare(model, metric === "tokens" ? "tokens" : "cost");
                  const rowFigures = figureClass(loadingProviders.has(model.provider));
                  return (
                    <tr
                      key={key}
                      className="relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
                    >
                      <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                      <td className="py-2.5 text-left whitespace-normal">
                        <button
                          type="button"
                          aria-disabled={showingKept}
                          data-usage-model
                          onClick={() => {
                            if (!showingKept) onSelectModel(key);
                          }}
                          className={cn(
                            // The ring sits on the overlay that spans the row, so focus shows on the whole row.
                            "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
                            !hasBar && "py-1",
                          )}
                        >
                          <ProviderMark provider={model.provider} className="size-3.5" />
                          {model.model}
                        </button>
                        {hasBar ? (
                          <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `max(0.5rem, ${(value / breakdownPeak) * 100}%)`,
                                backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                              }}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className={cn("py-2.5 pl-6 text-foreground", rowFigures)}>
                        {isModelCostUnknown(model) ? (
                          <span className="text-muted-foreground">{t("Unpriced")}</span>
                        ) : (
                          formatUsd(model.costUsd)
                        )}
                      </td>
                      <td className={cn("hidden py-2.5 pl-6 sm:table-cell", rowFigures)}>
                        {share === null ? "" : formatPercent(share)}
                      </td>
                      <td className={cn("py-2.5 pl-6", rowFigures)}>
                        {formatTokens(model.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <div
            className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            role="region"
            aria-label={t("Usage breakdown by time")}
            tabIndex={0}
          >
            <table className="w-full text-sm whitespace-nowrap">
              <colgroup>
                <col className="w-2/5" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 font-normal">{shownHourly ? t("Hour") : t("Day")}</th>
                  {activeProviders.map((provider) => (
                    <th key={provider} className="py-2 pl-4 text-right font-normal">
                      {PROVIDER_PRESENTATION[provider].label}
                    </th>
                  ))}
                  <th className="py-2 pl-4 text-right font-normal">{t("Total")}</th>
                  <th className="py-2 pl-4 text-right font-normal">
                    {metric === "tokens" ? t("Cost") : t("Tokens")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdownPeriods.length === 0 ? (
                  <tr>
                    <td
                      colSpan={activeProviders.length + 3}
                      className="py-6 text-center text-muted-foreground"
                    >
                      {t("No activity in this window.")}
                    </td>
                  </tr>
                ) : (
                  breakdownPeriods.map((period) => (
                    <tr
                      key={"hourStart" in period ? period.hourStart : period.day}
                      className="border-b border-border/50 transition-colors hover:bg-muted/50"
                    >
                      <td className="py-2 text-foreground">
                        {"hourStart" in period
                          ? formatDateTimeShort(period.hourStart, shownWindow.timeZone, hour12)
                          : formatDayShort(period.day)}
                      </td>
                      {activeProviders.map((provider) => (
                        <td
                          key={provider}
                          className={cn(
                            "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                            figureClass(loadingProviders.has(provider)),
                          )}
                        >
                          {metric === "tokens"
                            ? formatTokens(period.byProvider.get(provider)?.totalTokens ?? 0)
                            : formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {metric === "tokens"
                          ? formatTokens(period.totalTokens)
                          : formatUsd(period.costUsd)}
                      </td>
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {metric === "tokens"
                          ? formatUsd(period.costUsd)
                          : formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const CURSOR_KEYCHAIN_COPY = msg("Requires access to your Cursor login in macOS Keychain.");

function CursorEnableButton({
  environmentId,
  label,
  onEnabled,
  tooltip,
  buttonText,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly tooltip: boolean;
  readonly buttonText?: string;
}) {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const enable = async () => {
    setPending(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: true } },
    });
    if (result._tag === "Success") onEnabled();
    setPending(false);
  };
  const button = tooltip ? (
    <InlineButton
      disabled={pending}
      aria-busy={pending}
      aria-label={t("Enable Cursor usage from {environment}", { environment: label })}
      onClick={() => void enable()}
    >
      {buttonText ?? t("Enable")}
    </InlineButton>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={t("Enable Cursor usage from {environment}", { environment: label })}
      onClick={() => void enable()}
    >
      {buttonText ?? t("Enable")}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{t(CURSOR_KEYCHAIN_COPY)}</TooltipPopup>
    </Tooltip>
  );
}

function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly onEnabled: () => void;
}) {
  // oxlint-disable-next-line t3code/no-untranslated-text -- product name plus the environment label, which reads the same in every language
  const cursorLabel = showEnvironment ? `Cursor · ${label}` : "Cursor";
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_PRESENTATION.cursor.color }}
        />
        <ProviderMark provider="cursor" className="size-4" />
        <span className="truncate">{cursorLabel}</span>
      </span>
      <CursorEnableButton
        environmentId={environmentId}
        label={label}
        onEnabled={onEnabled}
        tooltip
      />
    </div>
  );
}

function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        {"Cursor"}
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{t(CURSOR_KEYCHAIN_COPY)}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={
                environments.length > 1
                  ? t("Enable on {environment}", { environment: environment.label })
                  : t("Enable")
              }
              onEnabled={onEnabled}
              tooltip={false}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function figureClass(loading: boolean) {
  return loading ? "text-usage-retained-foreground" : undefined;
}

function Metric({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}
      >
        {value}
      </span>
    </div>
  );
}

function UsageCoverageNotice({
  duplicateSources,
  coverage,
}: {
  readonly duplicateSources: readonly string[];
  readonly coverage: ReturnType<typeof usageNotices>["coverage"];
}) {
  if (coverage === null && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {coverage?.gaps.map(({ environment, message }) => (
        <span key={environment.environmentId}>{message}</span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {t("Counted once across environments sharing a transcript directory: {sources}", {
            sources: duplicateSources.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

export function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshingEnvironmentIds,
  duplicateSources,
  coverage,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshingEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly duplicateSources: readonly string[];
  readonly coverage: ReturnType<typeof usageNotices>["coverage"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? t("All environments")
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : tn(selectedEnvironments.length, "{count} environment", "{count} environments");
  const hasIssue = coverage !== null;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label={t("Some environments could not report usage")}
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-60 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          {t("All environments")}
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(
            environment,
            refreshingEnvironmentIds.has(environment.environmentId),
          );
          const hasGap = coverage?.gaps.some(
            (gap) => gap.environment.environmentId === environment.environmentId,
          );
          const status =
            environment.error !== null
              ? hasGap
                ? t("Unavailable")
                : environment.error
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? t("Update required")
                : !environment.isConnected
                  ? t("Connecting…")
                  : progress.phase === "loading"
                    ? t("Scanning…")
                    : progress.phase === "stale"
                      ? t("Refreshing…")
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel)
                        : progress.phase === "incomplete"
                          ? t("Usage figures may be incomplete")
                          : t("Ready");
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "max-w-60 shrink-0 whitespace-normal text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive-foreground",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {t("No environments connected.")}
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice duplicateSources={duplicateSources} coverage={coverage} />
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          {t("Model prices")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? t("All providers")
      : visible.length === 0
        ? t("No providers")
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : tn(visible.length, "{count} provider", "{count} providers");

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
        >
          {t("All providers")}
        </MenuCheckboxItem>
        <MenuSeparator />
        {PROVIDER_ORDER.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              onChange(
                PROVIDER_ORDER.filter((entry) =>
                  entry === provider ? !checked : hiddenProviders.has(entry),
                ),
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderMark provider={provider} className="size-3.5" />
              <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function UsageSkeleton({
  hiddenProviders,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const providers = useAtomValue(skeletonProvidersAtom).filter(
    (provider) => !hiddenProviders.has(provider),
  );
  return (
    <>
      <span role="status" className="sr-only">
        {t("Loading usage…")}
      </span>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {providers.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">{t("Totals")}</h2>
        <MetricSkeletons
          labels={[
            t("Processed tokens"),
            t("Cached input"),
            t("Uncached input"),
            t("Output"),
            t("Cache savings"),
          ]}
        />
      </section>

      <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-2" />
          <Skeleton className="h-4 w-72" />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">{t("Breakdown")}</h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}
