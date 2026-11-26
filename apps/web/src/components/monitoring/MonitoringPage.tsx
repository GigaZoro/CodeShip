import {
  monitoringOperationRetry,
  monitoringRefreshTimedOut,
} from "@t3tools/client-runtime/monitoring/atoms";
import { Link, useSearch } from "@tanstack/react-router";
import {
  EnvironmentId,
  ThreadId,
  type MonitoringDay,
  type MonitoringFindingCode,
  type MonitoringThreadKind,
} from "@t3tools/contracts";
import {
  NO_MODEL,
  breakdownByKind,
  breakdownByModel,
  breakdownByProject,
  chatFailures,
  dailyTrend,
  failureRetry,
  filterGroups,
  missingEnvironments,
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
  type MonitoringChatOrder,
  type MonitoringChatsRequest,
  type MonitoringFilters as ChatFilters,
  type MonitoringOverviewView,
  type MonitoringRetry,
  type MonitoringWindow,
  type MissingEnvironments,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatPercent, formatUsd } from "@t3tools/shared/usageFormat";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useProjects } from "../../state/entities";
import {
  refreshMonitoring,
  refreshMonitoringThread,
  useMonitoringRefresh,
  useMonitoringChats,
  useMonitoringOverview,
} from "../../state/monitoring";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  MissingEnvironmentNotes,
  MONITORING_PAGE_SIZE,
  MonitoringChatList,
  RetryButton,
} from "./MonitoringChatList";
import { MonitoringFindingRanking } from "./MonitoringFindings";
import {
  MonitoringKpi,
  MonitoringOverviewNotices,
  MonitoringRefreshButton,
  MonitoringSection,
} from "./MonitoringSection";
import { MonitoringBreakdownTable, MonitoringPhaseTable } from "./MonitoringTables";
import { MonitoringThreadDeepDive } from "./MonitoringThreadDetail";
import { MonitoringTimeBar } from "./MonitoringTimeBar";
import { MonitoringTrendChart } from "./MonitoringTrendChart";
import { KIND_LABEL } from "@t3tools/client-runtime/monitoring-text";
import { msg, t, tn } from "~/i18n";

const WINDOW_OPTIONS = [
  { days: 7, label: msg("7 days") },
  { days: 30, label: msg("30 days") },
  { days: 90, label: msg("90 days") },
] as const;

const ALL = "all";
const MODEL_PREFIX = "model:";

interface Filters {
  readonly project: string | null;
  readonly kind: MonitoringThreadKind | null;
  /** A model name; {@link NO_MODEL} is chats that ran none. */
  readonly model: string | null;
  readonly finding: MonitoringFindingCode | null;
}

const NO_FILTERS: Filters = { project: null, kind: null, model: null, finding: null };

const FIRST_PAGE: MonitoringChatOrder = {
  sort: "settledAt",
  direction: "desc",
  limit: MONITORING_PAGE_SIZE,
};

const OUTLIERS = [
  {
    label: msg("Slowest"),
    sort: "lifetimeMs",
    score: (chat: MonitoringChat) => chat.summary.lifetimeMs,
    value: (chat: MonitoringChat) => formatDuration(chat.summary.lifetimeMs),
  },
  {
    label: msg("Most expensive"),
    sort: "costUsd",
    score: (chat: MonitoringChat) => chat.summary.costUsd,
    value: (chat: MonitoringChat) => formatUsd(chat.summary.costUsd),
  },
  {
    label: msg("Most failures"),
    sort: "failures",
    score: (chat: MonitoringChat) => chatFailures(chat.summary),
    value: (chat: MonitoringChat) => String(chatFailures(chat.summary)),
  },
] as const;
const OUTLIER_COUNT = 3;

/** The chat lists the overview shows: the paged list and the three outlier lists. */
function chatRequests(period: MonitoringWindow, filters: Filters, listOrder: MonitoringChatOrder) {
  const scope = {
    window: { since: period.since, until: period.until },
    filters: {
      projectKey: filters.project,
      kind: filters.kind,
      model: filters.model,
    } satisfies ChatFilters,
  };
  return {
    scope,
    list: {
      ...scope,
      filters: { ...scope.filters, findingCode: filters.finding },
      order: listOrder,
      pageSize: MONITORING_PAGE_SIZE,
    } satisfies MonitoringChatsRequest,
    outliers: OUTLIERS.map((outlier): MonitoringChatsRequest => ({
      ...scope,
      order: { sort: outlier.sort, direction: "desc", limit: OUTLIER_COUNT },
      pageSize: OUTLIER_COUNT,
    })),
  };
}

export function MonitoringPage() {
  const search = useSearch({ from: "/_chat/monitoring" });
  // The clock is read once per choice: a new value on every render would change the query key.
  const [windowChoice, setWindowChoice] = useState(() => ({ days: 30, now: Date.now() }));
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [listOrder, setListOrder] = useState(FIRST_PAGE);
  const period = monitoringWindow(windowChoice.days, windowChoice.now);
  const overviewInput = { days: period.days, until: period.until };
  const { view: overview, days: overviewDays, retained } = useMonitoringOverview(overviewInput);
  const requests = chatRequests(period, filters, listOrder);
  const projects = useProjects();

  const projectTitles = new Map(
    projects.map((project) => [projectKey(project.environmentId, project.id), project.title]),
  );
  const projectTitleOfKey = (key: string) => projectTitles.get(key) ?? t("Unknown project");
  const projectTitleOf = (chat: MonitoringChat) =>
    projectTitleOfKey(projectKey(chat.environmentId, chat.summary.projectId));

  const deepDive =
    search.environment && search.thread
      ? {
          environmentId: EnvironmentId.make(search.environment),
          threadId: ThreadId.make(search.thread),
        }
      : null;

  const refresh = () => {
    const now = Date.now();
    const today = monitoringWindow(windowChoice.days, now);
    if (today.until === period.until) {
      return refreshMonitoring({
        overview: overviewInput,
        chats: [requests.list, ...requests.outliers],
      });
    }
    // A period left open past midnight moves to today. Its queries are new and load on their own,
    // so the refresh only reconnects environments that are down.
    setWindowChoice({ days: windowChoice.days, now });
    return refreshMonitoring({
      overview: { days: today.days, until: today.until },
      chats: [],
    });
  };
  const overviewRefresh = useMonitoringRefresh();
  const detailRefresh = useMonitoringRefresh(
    deepDive === null ? null : JSON.stringify([deepDive.environmentId, deepDive.threadId]),
  );
  const refreshOverview = () =>
    overviewRefresh.run(async () => (await refresh()).some(monitoringRefreshTimedOut));
  const refreshDetail = () => {
    if (deepDive !== null) {
      void detailRefresh.run(() =>
        refreshMonitoringThread(deepDive.environmentId, deepDive.threadId),
      );
    }
  };
  // A new period or scope starts the list from its first page again.
  const changeFilters = (next: Filters) => {
    setFilters(next);
    setListOrder({ ...listOrder, limit: MONITORING_PAGE_SIZE });
  };

  return (
    <SidebarInset
      {...workspaceAreaProps("monitoring-page", 1, t("Monitoring"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={t("Monitoring breadcrumb")} className="min-w-0">
          <WorkspaceBreadcrumbItem current>
            <h1>{t("Monitoring")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <ToggleGroup
            aria-label={t("Monitoring period")}
            variant="segmented"
            value={[String(windowChoice.days)]}
            onValueChange={(next) => {
              const option = WINDOW_OPTIONS.find((entry) => String(entry.days) === next[0]);
              if (option) {
                setWindowChoice({ days: option.days, now: Date.now() });
                setListOrder({ ...listOrder, limit: MONITORING_PAGE_SIZE });
              }
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)}>
                {t(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
          <MonitoringRefreshButton
            refreshing={(deepDive === null ? overviewRefresh : detailRefresh).refreshing}
            timedOut={(deepDive === null ? overviewRefresh : detailRefresh).timedOut}
            onRefresh={deepDive === null ? refreshOverview : refreshDetail}
          />
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer width="expanded">
          {deepDive ? (
            <MonitoringThreadDeepDive
              key={`${deepDive.environmentId}:${deepDive.threadId}`}
              environmentId={deepDive.environmentId}
              threadId={deepDive.threadId}
              refreshing={detailRefresh.refreshing}
              onRetry={refreshDetail}
            />
          ) : (
            <MonitoringOverview
              overview={overview}
              days={overviewDays}
              retained={retained}
              filters={filters}
              onFiltersChange={changeFilters}
              requests={requests}
              onListOrderChange={setListOrder}
              projectTitleOfKey={projectTitleOfKey}
              projectTitleOf={projectTitleOf}
              retry={monitoringOperationRetry(failureRetry(overview), overviewRefresh.refreshing)}
              refreshing={overviewRefresh.refreshing}
              onRetry={refreshOverview}
            />
          )}
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}

function MonitoringOverview({
  overview,
  days,
  retained,
  filters,
  onFiltersChange,
  requests,
  onListOrderChange,
  projectTitleOfKey,
  projectTitleOf,
  retry,
  onRetry,
  refreshing,
}: {
  readonly overview: MonitoringOverviewView;
  readonly days: ReadonlyArray<MonitoringDay>;
  readonly retained: boolean;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
  readonly requests: ReturnType<typeof chatRequests>;
  readonly onListOrderChange: (order: MonitoringChatOrder) => void;
  readonly projectTitleOfKey: (key: string) => string;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
  readonly retry: MonitoringRetry;
  readonly onRetry: () => void;
  readonly refreshing: boolean;
}) {
  if (overview.environments.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("No environments connected")}</EmptyTitle>
          <EmptyDescription>
            {t("Monitoring reads the chats of the environments you are connected to.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (overview.failed) {
    return (
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertTitle>{t("Could not load monitoring")}</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-1">
            {overview.unreadable.map((environment) => (
              <li key={environment.environmentId} className="break-words">
                {unreadableEnvironmentText(environment)}
              </li>
            ))}
          </ul>
        </AlertDescription>
        {retry === "unavailable" ? null : (
          <AlertAction>
            <RetryButton retry={retry} onRetry={onRetry} />
          </AlertAction>
        )}
      </Alert>
    );
  }
  const missingNotices = (
    <MissingEnvironmentNotes
      missing={missingEnvironments(overview)}
      retry={retry}
      onRetry={onRetry}
    />
  );
  if (overview.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <MonitoringOverviewNotices stale={false} pending={0} failed={0}>
          {missingNotices}
        </MonitoringOverviewNotices>
        <div className="flex flex-col gap-4" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const scoped = filterGroups(overview.groups, requests.scope.filters);
  const totals = totalsOf(scoped);
  const buckets = sumTimeBuckets(scoped);
  const ranks = rankFindings(scoped);
  const phases = phaseTotals(scoped);
  const trend = dailyTrend(scoped, { days });
  const filtered = filters.project !== null || filters.kind !== null || filters.model !== null;
  const unanalyzed = unanalyzedCounts(overview.unanalyzed, filters.project);

  return (
    <div className="flex flex-col gap-8">
      <MonitoringOverviewNotices stale={overview.stale ?? false} {...unanalyzed}>
        {missingNotices}
      </MonitoringOverviewNotices>

      <MonitoringFilters
        overview={overview}
        filters={filters}
        onChange={onFiltersChange}
        projectTitleOfKey={projectTitleOfKey}
      />

      {scoped.length === 0 && overview.complete ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {filtered ? t("No chats match these filters") : t("No analyzed chats in this period")}
            </EmptyTitle>
            <EmptyDescription>
              {filtered
                ? t("Clear a filter or choose a longer period.")
                : t("Chats show up here once they settle and have been analyzed.")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
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
          </dl>

          <MonitoringSection
            title={t("Where the time goes")}
            description={t(
              "Every chat's lifetime, from creation to settling, split by what it waited on.",
            )}
          >
            <MonitoringTimeBar buckets={buckets} />
          </MonitoringSection>

          <MonitoringSection
            title={t("Weak points")}
            description={t("Choose one to list only the chats it hit.")}
          >
            <MonitoringFindingRanking
              ranks={ranks}
              groups={scoped}
              scope={retained ? null : requests.scope}
              activeCode={filters.finding}
              onSelect={(finding) => onFiltersChange({ ...filters, finding })}
            />
          </MonitoringSection>

          <MonitoringSection
            title={t("Steps")}
            description={t("Shell commands by what they were for.")}
          >
            <MonitoringPhaseTable phases={phases} />
          </MonitoringSection>

          <MonitoringSection title={t("Daily trend")}>
            <MonitoringTrendChart points={trend} />
          </MonitoringSection>

          <MonitoringSection title={t("Breakdowns")}>
            <div className="flex flex-col gap-6">
              <MonitoringBreakdownTable
                caption={t("By project")}
                dimension={t("Project")}
                rows={breakdownByProject(scoped)}
                labelOf={projectTitleOfKey}
              />
              <MonitoringBreakdownTable
                caption={t("By kind")}
                dimension={t("Kind")}
                rows={breakdownByKind(scoped)}
                labelOf={(key) => t(KIND_LABEL[key as MonitoringThreadKind])}
              />
              <MonitoringBreakdownTable
                caption={t("By model")}
                dimension={t("Model")}
                rows={breakdownByModel(scoped)}
                labelOf={(key) => (key === NO_MODEL ? t("No model") : key)}
              />
            </div>
          </MonitoringSection>

          <MonitoringSection
            title={t("Chats")}
            aside={
              filters.finding !== null ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onFiltersChange({ ...filters, finding: null })}
                >
                  <XIcon aria-hidden />
                  {t("Clear weak point filter")}
                </Button>
              ) : undefined
            }
          >
            <MonitoringOutliers
              requests={requests.outliers}
              onRetry={onRetry}
              refreshing={refreshing}
              projectTitleOf={projectTitleOf}
            />
            <MonitoringChatListQuery
              request={requests.list}
              onOrderChange={onListOrderChange}
              onRetry={onRetry}
              refreshing={refreshing}
              projectTitleOf={projectTitleOf}
            />
          </MonitoringSection>
        </>
      )}
    </div>
  );
}

function MonitoringChatListQuery({
  request,
  onOrderChange,
  onRetry,
  refreshing,
  projectTitleOf,
}: {
  readonly request: MonitoringChatsRequest;
  readonly onOrderChange: (order: MonitoringChatOrder) => void;
  readonly onRetry: () => void;
  readonly refreshing: boolean;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  const { view, updating, retry, sortedBy } = useMonitoringChats(request);
  return (
    <MonitoringChatList
      view={view}
      updating={updating}
      retry={monitoringOperationRetry(retry, refreshing)}
      sortedBy={sortedBy}
      order={request.order}
      onOrderChange={onOrderChange}
      onRetry={onRetry}
      projectTitleOf={projectTitleOf}
    />
  );
}

function MonitoringOutliers({
  requests,
  onRetry,
  refreshing,
  projectTitleOf,
}: {
  readonly requests: ReadonlyArray<MonitoringChatsRequest>;
  readonly onRetry: () => void;
  readonly refreshing: boolean;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {OUTLIERS.map((outlier, index) => (
        <OutlierGroupQuery
          key={outlier.sort}
          outlier={outlier}
          request={requests[index]!}
          onRetry={onRetry}
          refreshing={refreshing}
          projectTitleOf={projectTitleOf}
        />
      ))}
    </div>
  );
}

function OutlierGroupQuery({
  outlier,
  request,
  onRetry,
  refreshing,
  projectTitleOf,
}: {
  readonly outlier: (typeof OUTLIERS)[number];
  readonly request: MonitoringChatsRequest;
  readonly onRetry: () => void;
  readonly refreshing: boolean;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  const { view, retry } = useMonitoringChats(request);
  const chats = view.chats.filter((chat) => outlier.score(chat) > 0);
  const missing = missingEnvironments(view);
  return (
    <OutlierGroup
      label={t(outlier.label)}
      stale={view.stale ?? false}
      chats={chats}
      missing={missing}
      value={outlier.value}
      retry={monitoringOperationRetry(retry, refreshing)}
      onRetry={onRetry}
      projectTitleOf={projectTitleOf}
    />
  );
}

function OutlierGroup({
  label,
  stale,
  chats,
  missing,
  value,
  retry,
  onRetry,
  projectTitleOf,
}: {
  readonly label: string;
  readonly stale: boolean;
  readonly chats: ReadonlyArray<MonitoringChat>;
  /** Environments whose chats this ranking does not include yet. */
  readonly missing: MissingEnvironments;
  readonly value: (chat: MonitoringChat) => string;
  readonly retry: MonitoringRetry;
  readonly onRetry: () => void;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <h3 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </h3>
      <ul className="min-h-36 divide-y divide-border">
        {chats.map((chat) => (
          <li key={monitoringChatKey(chat)}>
            <Link
              to="/monitoring"
              search={{ environment: chat.environmentId, thread: chat.summary.threadId }}
              className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2 text-sm hover:bg-accent/50"
            >
              <span className="min-w-0">
                <span className="block truncate text-foreground">{chat.summary.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {projectTitleOf(chat)}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{value(chat)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div
        role="status"
        className="flex h-16 items-start justify-between gap-3 overflow-y-auto px-3 py-2 text-xs text-muted-foreground"
      >
        <div className="min-w-0 break-words">
          {stale ? <p>{t("Showing previous monitoring results.")}</p> : null}
          {missing.unreadable ? (
            <p>
              {t("Could not refresh these environments: {names}", {
                names: missing.unreadable,
              })}
            </p>
          ) : null}
          {missing.waiting ? (
            <p>{t("Waiting for these environments: {names}", { names: missing.waiting })}</p>
          ) : null}
        </div>
        {missing.unreadable && retry !== "unavailable" ? (
          <RetryButton retry={retry} onRetry={onRetry} />
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string | null) => void;
}) {
  const selected = value === null ? undefined : options.find((option) => option.value === value);
  return (
    <Select
      value={value === null ? ALL : value}
      onValueChange={(next) => onChange(next === ALL || next === null ? null : String(next))}
    >
      <SelectTrigger aria-label={label} size="compact" className="w-auto min-w-0 max-w-64">
        <SelectValue>{selected ? selected.label : allLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function MonitoringFilters({
  overview,
  filters,
  onChange,
  projectTitleOfKey,
}: {
  readonly overview: MonitoringOverviewView;
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
  readonly projectTitleOfKey: (key: string) => string;
}) {
  const { projectKeys, kinds, models } = monitoringFacets(overview);
  // The model filter is keyed by a prefixed value because the no-model bucket is the empty string.
  const modelValue = filters.model === null ? null : `${MODEL_PREFIX}${filters.model}`;
  const active = filters.project !== null || filters.kind !== null || filters.model !== null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        label={t("Project")}
        allLabel={t("All projects")}
        value={filters.project}
        options={projectKeys
          .map((key) => ({ value: key, label: projectTitleOfKey(key) }))
          .toSorted((a, b) => a.label.localeCompare(b.label))}
        onChange={(project) => onChange({ ...filters, project })}
      />
      <FilterSelect
        label={t("Kind")}
        allLabel={t("All kinds")}
        value={filters.kind}
        options={kinds.map((kind) => ({ value: kind, label: t(KIND_LABEL[kind]) }))}
        onChange={(kind) => onChange({ ...filters, kind: kind as MonitoringThreadKind | null })}
      />
      <FilterSelect
        label={t("Model")}
        allLabel={t("All models")}
        value={modelValue}
        options={models
          .map((model) => ({
            value: `${MODEL_PREFIX}${model}`,
            label: model === NO_MODEL ? t("No model") : model,
          }))
          .toSorted((a, b) => a.label.localeCompare(b.label))}
        onChange={(next) =>
          onChange({ ...filters, model: next === null ? null : next.slice(MODEL_PREFIX.length) })
        }
      />
      {active ? (
        <Button size="xs" variant="ghost" onClick={() => onChange(NO_FILTERS)}>
          <XIcon aria-hidden />
          {t("Clear filters")}
        </Button>
      ) : null}
    </div>
  );
}
