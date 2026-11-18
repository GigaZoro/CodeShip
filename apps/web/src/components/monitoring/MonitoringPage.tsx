import { Link, useSearch } from "@tanstack/react-router";
import {
  EnvironmentId,
  ThreadId,
  type MonitoringFindingCode,
  type MonitoringThreadKind,
} from "@t3tools/contracts";
import {
  NO_MODEL,
  breakdownByKind,
  breakdownByModel,
  breakdownByProject,
  dailyTrend,
  dayKey,
  filterChats,
  mainModel,
  monitoringChatKey,
  monitoringWindowStart,
  outliers,
  phaseTotals,
  projectKey,
  rankFindings,
  sumTimeBuckets,
  totalsOf,
  type MonitoringChat,
} from "@t3tools/client-runtime/monitoring";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { enumerateDays, formatPercent, formatUsd } from "@t3tools/shared/usageFormat";
import { CircleAlertIcon, InfoIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { useProjects } from "../../state/entities";
import { refreshMonitoringOverview, useMonitoringOverview } from "../../state/monitoring";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { MonitoringChatList } from "./MonitoringChatList";
import { MonitoringFindingRanking } from "./MonitoringFindings";
import { MonitoringKpi, MonitoringSection } from "./MonitoringSection";
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

export function MonitoringPage() {
  const search = useSearch({ from: "/_chat/monitoring" });
  const [days, setDays] = useState<(typeof WINDOW_OPTIONS)[number]["days"]>(30);
  // Read once so the query key stays put until the person changes the window.
  const [now] = useState(() => Date.now());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const since = monitoringWindowStart(days, now);
  const overview = useMonitoringOverview({ since });
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

  const refresh = () =>
    refreshMonitoringOverview(
      overview.environments.map((environment) => environment.environmentId),
      { since },
    );
  const refreshing = overview.environments.some((environment) => environment.isPending);

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
            value={[String(days)]}
            onValueChange={(next) => {
              const option = WINDOW_OPTIONS.find((entry) => String(entry.days) === next[0]);
              if (option) setDays(option.days);
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.days} value={String(option.days)}>
                {t(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
          <Button
            onClick={refresh}
            aria-label={t("Refresh monitoring")}
            aria-busy={refreshing}
            disabled={refreshing}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
          </Button>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer width="expanded">
          {deepDive ? (
            <MonitoringThreadDeepDive
              key={`${deepDive.environmentId}:${deepDive.threadId}`}
              environmentId={deepDive.environmentId}
              threadId={deepDive.threadId}
            />
          ) : (
            <MonitoringOverview
              overview={overview}
              days={days}
              now={now}
              filters={filters}
              onFiltersChange={setFilters}
              projectTitleOfKey={projectTitleOfKey}
              projectTitleOf={projectTitleOf}
              onRetry={refresh}
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
  now,
  filters,
  onFiltersChange,
  projectTitleOfKey,
  projectTitleOf,
  onRetry,
}: {
  readonly overview: ReturnType<typeof useMonitoringOverview>;
  readonly days: number;
  readonly now: number;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
  readonly projectTitleOfKey: (key: string) => string;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
  readonly onRetry: () => void;
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
        <AlertDescription>
          {t("Could not load monitoring: {error}", {
            error: overview.environments[0]!.error ?? "",
          })}
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {t("Retry")}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (overview.isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const scoped = filterChats(overview.chats, {
    projectKey: filters.project,
    kind: filters.kind,
    model: filters.model,
  });
  const listed = filterChats(scoped, { findingCode: filters.finding });
  const totals = totalsOf(scoped);
  const buckets = sumTimeBuckets(scoped);
  const ranks = rankFindings(scoped);
  const phases = phaseTotals(scoped);
  const lastDay = dayKey(new Date(now).toISOString());
  const trend = dailyTrend(scoped, {
    days: enumerateDays(dayKey(monitoringWindowStart(days, now)), lastDay),
  });
  const top = outliers(scoped, 3);
  const failedEnvironments = overview.environments.filter((environment) => environment.error);
  const filtered = filters.project !== null || filters.kind !== null || filters.model !== null;

  return (
    <div className="flex flex-col gap-8">
      {failedEnvironments.length > 0 ? (
        <Alert variant="warning">
          <CircleAlertIcon />
          <AlertDescription>
            {t("Some environments could not be read, so their chats are missing: {names}", {
              names: failedEnvironments.map((environment) => environment.label).join(", "),
            })}
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={onRetry}>
              {t("Retry")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {overview.pendingAnalysis > 0 ? (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>
            {tn(
              overview.pendingAnalysis,
              "{count} settled chat is still being analyzed.",
              "{count} settled chats are still being analyzed.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {overview.failedAnalysis > 0 ? (
        <Alert variant="warning">
          <CircleAlertIcon />
          <AlertDescription>
            {tn(
              overview.failedAnalysis,
              "{count} chat could not be analyzed. It is tried again every 30 minutes.",
              "{count} chats could not be analyzed. They are tried again every 30 minutes.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {overview.truncated ? (
        <Alert variant="info">
          <InfoIcon />
          <AlertDescription>
            {t("More chats settled in this period than can be shown. These are the newest.")}
          </AlertDescription>
        </Alert>
      ) : null}

      <MonitoringFilters
        chats={overview.chats}
        filters={filters}
        onChange={onFiltersChange}
        projectTitleOfKey={projectTitleOfKey}
      />

      {scoped.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {filtered ? t("No chats match these filters") : t("No settled chats in this period")}
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
            <MonitoringOutliers outliers={top} projectTitleOf={projectTitleOf} />
            <MonitoringChatList chats={listed} projectTitleOf={projectTitleOf} />
          </MonitoringSection>
        </>
      )}
    </div>
  );
}

function MonitoringOutliers({
  outliers: top,
  projectTitleOf,
}: {
  readonly outliers: ReturnType<typeof outliers>;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  const groups = [
    {
      label: t("Slowest"),
      chats: top.slowest,
      value: (chat: MonitoringChat) => formatDuration(chat.summary.lifetimeMs),
    },
    {
      label: t("Most expensive"),
      chats: top.mostExpensive,
      value: (chat: MonitoringChat) => formatUsd(chat.summary.costUsd),
    },
    {
      label: t("Most failures"),
      chats: top.mostFailures,
      value: (chat: MonitoringChat) =>
        String(chat.summary.runs.failed + chat.summary.commands.failed),
    },
  ].filter((group) => group.chats.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {groups.map((group) => (
        <OutlierGroup
          key={group.label}
          label={group.label}
          chats={group.chats}
          value={group.value}
          projectTitleOf={projectTitleOf}
        />
      ))}
    </div>
  );
}

function OutlierGroup({
  label,
  chats,
  value,
  projectTitleOf,
}: {
  readonly label: string;
  readonly chats: ReadonlyArray<MonitoringChat>;
  readonly value: (chat: MonitoringChat) => string;
  readonly projectTitleOf: (chat: MonitoringChat) => string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border">
      <h3 className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </h3>
      <ul className="divide-y divide-border">
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
  chats,
  filters,
  onChange,
  projectTitleOfKey,
}: {
  readonly chats: ReadonlyArray<MonitoringChat>;
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
  readonly projectTitleOfKey: (key: string) => string;
}) {
  const projectKeys = [
    ...new Set(chats.map((chat) => projectKey(chat.environmentId, chat.summary.projectId))),
  ];
  const kinds = [...new Set(chats.map((chat) => chat.summary.kind))];
  const models = [...new Set(chats.map((chat) => mainModel(chat.summary)))];
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
