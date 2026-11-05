import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadAwaitsUser } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  CheckIcon,
  EllipsisIcon,
  FolderPlusIcon,
  PinIcon,
  SearchIcon,
  SquarePenIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { ProjectSettingsSheet } from "./ProjectSettingsSheet";
import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings, useSidebarGrouping } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import {
  getSidebarProjectSettingsKey,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { RelativeTime } from "../RelativeTime";
import {
  capSidebarFolderThreads,
  filterSidebarV2VisibleThreads,
  groupSidebarThreadsByMachineAndProject,
  groupSidebarThreadsByProject,
  hasUnseenServerWake,
  resolveSidebarThreadStatus,
  sidebarFolderExpansionKeys,
  sidebarMachineProjectFolderKey,
  sortPinnedThreadsForSidebar,
  sortWorkingThreadsBySend,
  useSnoozeWakeClock,
} from "../Sidebar.logic";
import type { SidebarMachine } from "../sidebar/SidebarFolderHeader";
import { resolveThreadRowStatus, ThreadRowStatusContent } from "../sidebar/threadRowStatus";
import { useLocallyUnreadThreadKeys } from "../sidebar/useLocallyUnreadThreadKeys";
import { useSidebarMachines } from "../sidebar/useSidebarMachines";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  addProjectThreadCounts,
  countProjectThreads,
  EMPTY_PROJECT_THREAD_COUNTS,
  matchesProjectSearch,
  matchesProjectsOverviewFilter,
  resolveProjectThreadState,
  validateProjectsSearch,
  type ProjectsOverviewFilter,
  type ProjectsSearch,
  type ProjectThreadCounts,
  type ProjectThreadState,
} from "./projectsOverview.logic";

import { msg, t, tn, type Message } from "~/i18n";
/** A card lists this many threads before the rest fold behind "Show more". */
const PROJECT_CARD_PREVIEW_COUNT = 6;

interface ProjectCard {
  readonly key: string;
  readonly group: SidebarProjectSnapshot;
  /** The group's project on the section's machine, when sections are machines. */
  readonly member: SidebarProjectGroupMember | null;
  /** Open threads that match the filter, pinned first, then newest message first. */
  readonly threads: readonly EnvironmentThreadShell[];
  readonly counts: ProjectThreadCounts;
  /** Seen threads that finished, which "Settle finished" parks together. */
  readonly finishedThreads: readonly EnvironmentThreadShell[];
  readonly snoozedCount: number;
  /** Where a new thread starts, or null while every machine with the project is offline. */
  readonly newThreadTarget: SidebarProjectGroupMember | SidebarProjectSnapshot | null;
  /** The newest message or update among all its threads, settled ones included. */
  readonly lastActivityAt: string | null;
  /** Its name matches the search, or one of `threads` does. */
  readonly matchesQuery: boolean;
}

/** What a card or a quiet row does, shared so both act the same way. */
interface ProjectCardHandlers {
  readonly stateOf: (thread: EnvironmentThreadShell) => ProjectThreadState;
  readonly isWoke: (thread: EnvironmentThreadShell) => boolean;
  readonly canSettle: (thread: EnvironmentThreadShell) => boolean;
  readonly machineById: ReadonlyMap<EnvironmentId, SidebarMachine>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly showMachineIcons: boolean;
  /** Null when the sidebar has no project folders to open or close. */
  readonly sidebarFolderOpen: (card: ProjectCard) => boolean | null;
  readonly onNewThread: (card: ProjectCard) => void;
  readonly onSettle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleFinished: (card: ProjectCard) => void;
  readonly onToggleSidebarFolder: (card: ProjectCard) => void;
  readonly onOpenSettings: (card: ProjectCard) => void;
  readonly onCopyPath: (card: ProjectCard) => void;
}

interface ProjectSection {
  readonly machine: SidebarMachine | null;
  readonly cards: readonly ProjectCard[];
  readonly counts: ProjectThreadCounts;
}

const FILTER_EMPTY_MESSAGE: Record<Exclude<ProjectsOverviewFilter, "all">, Message> = {
  attention: msg("Nothing needs you right now."),
  working: msg("No threads are working."),
  done: msg("No finished threads are waiting for you to read them."),
};

const threadKeyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const threadActivityAt = (thread: EnvironmentThreadShell) =>
  thread.latestUserMessageAt ?? thread.updatedAt;

export function ProjectsPage() {
  const groups = useSidebarProjectGroups();
  const projects = useProjects();
  const machines = useSidebarMachines();
  const grouping = useSidebarGrouping();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const threads = useQuietThreadShells();
  const locallyUnreadKeys = useLocallyUnreadThreadKeys(threads);
  const serverConfigs = useServerConfigs();
  const delegatedUnderParent = useDelegatedUnderParent();
  // As on Home: a machine that settled offline counts as answered, so it cannot hold the skeleton.
  const projectsReady = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const nowMinute = useNowMinute();
  // As in the sidebar: minute ticks alone would wake a snooze up to a minute late.
  const snoozeWakeClock = useSnoozeWakeClock(threads);
  const search = useSearch({ from: "/_chat/projects" });
  const navigate = useNavigate({ from: "/projects" });
  const { handleNewThread } = useHandleNewThread();
  const [settingsProjectKey, setSettingsProjectKey] = useState<string | null>(null);
  const { settleThread, confirmSettlingUnmergedWork } = useThreadActions();
  const { copyToClipboard: copyPath } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) =>
      toastManager.add({ type: "success", title: t("Path copied"), description: path }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: t("Failed to copy path"),
        description: error.message,
      }),
  });
  const filter: ProjectsOverviewFilter = search.show ?? "all";
  // The field keeps what is typed while focused; the address catches up a moment later.
  const [typedQuery, setTypedQuery] = useState<string | null>(null);
  const query = typedQuery ?? search.q ?? "";
  const updateSearch = (patch: {
    readonly [Key in keyof ProjectsSearch]?: ProjectsSearch[Key] | undefined;
  }) =>
    void navigate({
      search: (previous) => validateProjectsSearch({ ...previous, ...patch }),
      replace: true,
      resetScroll: false,
    });

  const now = new Date(Math.max(snoozeWakeClock, Date.parse(`${nowMinute}:00.000Z`))).toISOString();
  const stateByKey = new Map<string, ProjectThreadState>();
  const wokeKeys = new Set<string>();
  const openThreads: EnvironmentThreadShell[] = [];
  const snoozedCountByProject = new Map<string, number>();
  const lastActivityByProject = new Map<string, string>();
  for (const thread of filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent)) {
    const projectKey = scopedProjectKey(thread);
    const activityAt = threadActivityAt(thread);
    const previousActivityAt = lastActivityByProject.get(projectKey);
    if (previousActivityAt === undefined || activityAt > previousActivityAt) {
      lastActivityByProject.set(projectKey, activityAt);
    }
    // As in the sidebar's Needs you, a thread waiting on the user never hides, settled or not.
    if (thread.settledOverride === "settled" && !threadAwaitsUser(thread)) continue;
    if (effectiveSnoozed(thread, { now })) {
      snoozedCountByProject.set(projectKey, (snoozedCountByProject.get(projectKey) ?? 0) + 1);
      continue;
    }
    // Server visits, as in the sidebar's folder preview, so streaming never re-renders the page.
    const key = threadKeyOf(thread);
    const state = resolveProjectThreadState({
      ...thread,
      lastVisitedAt: thread.lastVisitedAt ?? undefined,
    });
    const woke = hasUnseenServerWake(thread, now);
    if (woke) wokeKeys.add(key);
    // A woken snooze is the reminder the user asked for, so it waits with what needs them.
    stateByKey.set(
      key,
      woke && (state === "quiet" || state === "done")
        ? "attention"
        : state === "quiet" && locallyUnreadKeys.has(key)
          ? "done"
          : state,
    );
    openThreads.push(thread);
  }
  const sortedOpenThreads = [
    ...sortPinnedThreadsForSidebar(openThreads.filter((thread) => thread.pinnedAt != null)),
    ...sortWorkingThreadsBySend(openThreads.filter((thread) => thread.pinnedAt == null)),
  ];
  const stateOf = (thread: EnvironmentThreadShell) =>
    stateByKey.get(threadKeyOf(thread)) ?? "quiet";
  // Matches the sidebar, which keeps machine folders on even with one machine.
  const byMachine = grouping.machine && machines.length > 0;
  const machineById = new Map(machines.map((machine) => [machine.environmentId, machine]));
  const isOnline = (environmentId: EnvironmentId) =>
    machineById.get(environmentId)?.disconnected !== true;
  // As in the sidebar: settling needs the server's config and a reachable machine, and would not
  // move a thread that still waits on the user.
  const canSettle = (thread: EnvironmentThreadShell) =>
    serverConfigs.has(thread.environmentId) &&
    isOnline(thread.environmentId) &&
    !threadAwaitsUser(thread);

  const buildCard = (
    group: SidebarProjectSnapshot,
    member: SidebarProjectGroupMember | null,
    cardThreads: readonly EnvironmentThreadShell[],
  ): ProjectCard => {
    const refs = member
      ? [{ environmentId: member.environmentId, projectId: member.id }]
      : group.memberProjectRefs;
    const nameMatches = matchesProjectSearch(group.displayName, query);
    const filtered = cardThreads.filter((thread) =>
      matchesProjectsOverviewFilter(stateOf(thread), filter),
    );
    // A search that misses the project's name narrows it to the threads whose titles it finds.
    const shownThreads = nameMatches
      ? filtered
      : filtered.filter((thread) => matchesProjectSearch(thread.title, query));
    const lastActivityAt = refs.reduce<string | null>((latest, ref) => {
      const at = lastActivityByProject.get(scopedProjectKey(ref)) ?? null;
      return at !== null && (latest === null || at > latest) ? at : latest;
    }, null);
    return {
      key: member
        ? sidebarMachineProjectFolderKey(member.environmentId, group.projectKey)
        : group.projectKey,
      group,
      member,
      threads: shownThreads,
      counts: countProjectThreads(cardThreads, stateOf),
      finishedThreads: cardThreads.filter(
        (thread) =>
          thread.pinnedAt == null &&
          stateOf(thread) === "quiet" &&
          resolveSidebarThreadStatus(thread) === "ready" &&
          canSettle(thread),
      ),
      // Snoozed threads sit outside every status filter, so only the full view counts them.
      snoozedCount:
        filter === "all"
          ? refs.reduce(
              (total, ref) => total + (snoozedCountByProject.get(scopedProjectKey(ref)) ?? 0),
              0,
            )
          : 0,
      newThreadTarget: member
        ? isOnline(member.environmentId)
          ? member
          : null
        : isOnline(group.environmentId)
          ? group
          : (group.memberProjects.find((candidate) => isOnline(candidate.environmentId)) ?? null),
      lastActivityAt,
      matchesQuery: nameMatches || shownThreads.length > 0,
    };
  };
  const shownCard = (card: ProjectCard) =>
    card.matchesQuery && (filter === "all" || card.threads.length > 0);
  const sumCounts = (cards: readonly ProjectCard[]) =>
    cards.reduce(
      (total, card) => addProjectThreadCounts(total, card.counts),
      EMPTY_PROJECT_THREAD_COUNTS,
    );
  const allSections: ProjectSection[] = byMachine
    ? groupSidebarThreadsByMachineAndProject({
        machines,
        groups,
        threads: sortedOpenThreads,
        keepEnvironmentIds: new Set(machines.map((machine) => machine.environmentId)),
        keepEmptyProjects: () => true,
      }).map((folder) => {
        const cards = folder.projects.map((project) =>
          buildCard(project.group, project.member, project.threads),
        );
        return { machine: folder.machine, cards, counts: sumCounts(cards) };
      })
    : [
        (() => {
          const cards = groupSidebarThreadsByProject(groups, sortedOpenThreads, () => true).map(
            (folder) => buildCard(folder.group, null, folder.threads),
          );
          return { machine: null, cards, counts: sumCounts(cards) };
        })(),
      ];
  const totals = allSections.reduce(
    (total, section) => addProjectThreadCounts(total, section.counts),
    EMPTY_PROJECT_THREAD_COUNTS,
  );
  const sections = allSections
    .map((section) => ({ ...section, cards: section.cards.filter(shownCard) }))
    .filter((section) => section.cards.length > 0);

  const openProjectSettings = (card: ProjectCard) =>
    setSettingsProjectKey(
      getSidebarProjectSettingsKey(
        card.group,
        projectGroupingSettings,
        projects,
        card.member ? scopeProjectRef(card.member.environmentId, card.member.id) : undefined,
      ),
    );
  const startThread = (card: ProjectCard) => {
    const project = card.newThreadTarget;
    if (project === null) return;
    void handleNewThread(scopeProjectRef(project.environmentId, project.id));
  };
  const settle = (thread: EnvironmentThreadShell, unmergedWorkConfirmed = false) => {
    void (async () => {
      const result = await settleThread(scopeThreadRef(thread.environmentId, thread.id), {
        unmergedWorkConfirmed,
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to settle thread"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      }
    })();
  };
  const sidebarFolderKeys = (card: ProjectCard) =>
    card.member ? [card.key] : sidebarFolderExpansionKeys(card.group);
  const sidebarFolderOpen = (card: ProjectCard) =>
    resolveProjectExpanded(projectExpandedById, sidebarFolderKeys(card));
  const handlers: ProjectCardHandlers = {
    stateOf,
    isWoke: (thread) => wokeKeys.has(threadKeyOf(thread)),
    canSettle,
    machineById,
    primaryEnvironmentId,
    showMachineIcons: !byMachine,
    sidebarFolderOpen: (card) => (grouping.project ? sidebarFolderOpen(card) : null),
    onNewThread: startThread,
    onSettle: (thread) => settle(thread),
    // One question for the whole project, as for a range in the sidebar, instead of one per thread.
    onSettleFinished: (card) => {
      const threads = card.finishedThreads;
      void confirmSettlingUnmergedWork(
        threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      ).then((confirmed) => {
        if (confirmed) for (const thread of threads) settle(thread, true);
      });
    },
    onToggleSidebarFolder: (card) =>
      setProjectExpanded(sidebarFolderKeys(card), !sidebarFolderOpen(card)),
    onOpenSettings: openProjectSettings,
    onCopyPath: (card) => {
      const { workspaceRoot } = card.member ?? card.group;
      copyPath(workspaceRoot, { path: workspaceRoot });
    },
  };

  const filterOptions: ReadonlyArray<{
    readonly value: ProjectsOverviewFilter;
    readonly label: string;
    readonly count: number;
  }> = [
    { value: "all", label: t("All"), count: totals.open },
    { value: "attention", label: t("Needs you"), count: totals.attention },
    { value: "working", label: t("Working"), count: totals.working },
    { value: "done", label: t("Done"), count: totals.done },
  ];

  return (
    <SidebarInset
      {...workspaceAreaProps("projects", 1, t("Projects"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel={t("Projects breadcrumb")} className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>{t("Projects")}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ml-auto flex items-center gap-2">
            <InputGroup className="w-40 sm:w-56">
              <InputGroupAddon>
                <SearchIcon aria-hidden className="size-3" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t("Search projects and threads")}
                placeholder={t("Search projects and threads")}
                size="sm"
                value={query}
                onFocus={() => setTypedQuery(search.q ?? "")}
                onBlur={() => setTypedQuery(null)}
                onChange={(event) => {
                  setTypedQuery(event.currentTarget.value);
                  updateSearch({ q: event.currentTarget.value });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || query.length === 0) return;
                  event.preventDefault();
                  setTypedQuery("");
                  updateSearch({ q: undefined });
                }}
              />
            </InputGroup>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <FolderPlusIcon aria-hidden />
              <span className="max-sm:sr-only">{t("Add project")}</span>
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="full">
            {groups.length === 0 ? (
              projectsReady ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{t("No projects yet")}</EmptyTitle>
                    <EmptyDescription>
                      {t("Add a folder to start threads in it and follow them here.")}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button onClick={() => openCommandPalette({ open: "add-project" })}>
                      <FolderPlusIcon aria-hidden />
                      {t("Add project")}
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] gap-4">
                  {["first", "second", "third"].map((key) => (
                    <Skeleton key={key} shape="card" className="h-48" />
                  ))}
                </div>
              )
            ) : (
              <>
                {/* On the narrowest phones the filters scroll on their own, never the page. */}
                <div className="max-w-full overflow-x-auto">
                  <ToggleGroup
                    aria-label={t("Show threads")}
                    value={[filter]}
                    onValueChange={(next) => {
                      const value = filterOptions.find((option) => option.value === next[0]);
                      if (value)
                        updateSearch({ show: value.value === "all" ? undefined : value.value });
                    }}
                  >
                    {filterOptions.map((option) => (
                      <Toggle key={option.value} value={option.value}>
                        {option.label}
                        <span className="tabular-nums text-muted-foreground">{option.count}</span>
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
                {sections.length === 0 ? (
                  <p role="status" className="py-10 text-center text-sm text-muted-foreground">
                    {query.trim().length > 0
                      ? t("No projects or threads match “{query}”.", { query: query.trim() })
                      : filter === "all"
                        ? t("No projects.")
                        : t(FILTER_EMPTY_MESSAGE[filter])}
                  </p>
                ) : (
                  sections.map((section) => (
                    <ProjectSectionView
                      key={section.machine?.environmentId ?? "all"}
                      section={section}
                      handlers={handlers}
                    />
                  ))
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      <ProjectSettingsSheet
        projectKey={settingsProjectKey}
        onClose={() => setSettingsProjectKey(null)}
      />
    </SidebarInset>
  );
}

function ProjectSectionView(props: { section: ProjectSection; handlers: ProjectCardHandlers }) {
  const headingId = useId();
  const quietHeadingId = useId();
  const { machine, cards } = props.section;
  // Projects with nothing open shrink to a line each, so they do not bury the ones at work.
  const activeCards = cards.filter((card) => card.counts.open > 0);
  const quietCards = cards.filter((card) => card.counts.open === 0);
  const content = (
    <>
      {activeCards.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] items-start gap-4">
          {activeCards.map((card) => (
            <ProjectCardView key={card.key} card={card} handlers={props.handlers} />
          ))}
        </div>
      ) : null}
      {quietCards.length > 0 ? (
        <div className="flex flex-col gap-2">
          {activeCards.length > 0 ? (
            <h3 id={quietHeadingId} className="text-xs font-medium text-muted-foreground">
              {t("No open threads")}
            </h3>
          ) : null}
          <ul
            aria-labelledby={activeCards.length > 0 ? quietHeadingId : undefined}
            aria-label={activeCards.length > 0 ? undefined : t("Projects with no open threads")}
            className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] gap-2 p-0"
          >
            {quietCards.map((card) => (
              <ProjectQuietRow key={card.key} card={card} handlers={props.handlers} />
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
  if (machine === null) return <div className="flex flex-col gap-6">{content}</div>;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <EnvironmentMachineIcon
          aria-hidden
          kind={machine.machineKind}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          {machine.label}
        </h2>
        {machine.disconnected ? (
          <span className="text-xs text-muted-foreground">{t("Offline")}</span>
        ) : null}
        <ProjectCountsSummary counts={props.section.counts} />
      </div>
      {content}
    </section>
  );
}

/** A project with no open threads: its name, when it last saw work, and how to start some. */
function ProjectQuietRow(props: { card: ProjectCard; handlers: ProjectCardHandlers }) {
  const { card, handlers } = props;
  return (
    <li className="flex h-11 min-w-0 items-center gap-2 rounded-xl border bg-card ps-3 pe-1.5 text-card-foreground">
      <ProjectFavicon project={card.group} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{card.group.displayName}</span>
      {card.snoozedCount > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {tn(card.snoozedCount, "{count} snoozed", "{count} snoozed")}
        </span>
      ) : card.lastActivityAt !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          <RelativeTime timestamp={card.lastActivityAt} />
        </span>
      ) : null}
      <NewThreadButton card={card} handlers={handlers} />
      <ProjectCardMenu card={card} handlers={handlers} />
    </li>
  );
}

function ProjectCountsSummary(props: { counts: ProjectThreadCounts; className?: string }) {
  const { counts } = props;
  const parts = [
    {
      key: "attention",
      count: counts.attention,
      text: tn(counts.attention, "{count} needs you", "{count} need you"),
      className: "text-warning-foreground",
    },
    {
      key: "working",
      count: counts.working,
      text: tn(counts.working, "{count} working", "{count} working"),
      className: "text-info-foreground",
    },
    {
      key: "done",
      count: counts.done,
      text: tn(counts.done, "{count} done", "{count} done"),
      className: "text-success-foreground",
    },
  ].filter((part) => part.count > 0);
  return (
    <p
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground",
        props.className,
      )}
    >
      {parts.map((part) => (
        <span key={part.key} className="contents">
          <span className={part.className}>{part.text}</span>
          <span aria-hidden>·</span>
        </span>
      ))}
      <span>{tn(counts.open, "{count} open thread", "{count} open threads")}</span>
    </p>
  );
}

/** Stays focusable while the project is offline, so its tooltip can say why it does nothing. */
function NewThreadButton(props: { card: ProjectCard; handlers: ProjectCardHandlers }) {
  const { card, handlers } = props;
  const canStartThread = card.newThreadTarget !== null;
  const label = canStartThread
    ? t("New thread in {name}", { name: card.group.displayName })
    : t("{name} is offline", { name: card.group.displayName });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            aria-disabled={!canStartThread}
            onClick={() => {
              if (canStartThread) handlers.onNewThread(card);
            }}
          />
        }
      >
        <SquarePenIcon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function ProjectCardMenu(props: { card: ProjectCard; handlers: ProjectCardHandlers }) {
  const { card, handlers } = props;
  const finishedCount = card.finishedThreads.length;
  const sidebarFolderOpen = handlers.sidebarFolderOpen(card);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            data-project-menu-trigger
            aria-label={t("More actions for {name}", { name: card.group.displayName })}
          />
        }
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={card.newThreadTarget === null}
          onClick={() => handlers.onNewThread(card)}
        >
          {t("New thread")}
        </MenuItem>
        <MenuItem disabled={finishedCount === 0} onClick={() => handlers.onSettleFinished(card)}>
          {finishedCount === 0
            ? t("Settle finished threads")
            : tn(
                finishedCount,
                "Settle {count} finished thread",
                "Settle {count} finished threads",
              )}
        </MenuItem>
        {sidebarFolderOpen === null ? null : (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={sidebarFolderOpen}
              onCheckedChange={() => handlers.onToggleSidebarFolder(card)}
            >
              {t("Expand in thread list")}
            </MenuCheckboxItem>
          </>
        )}
        <MenuSeparator />
        <MenuItem onClick={() => handlers.onCopyPath(card)}>{t("Copy path")}</MenuItem>
        <MenuItem onClick={() => handlers.onOpenSettings(card)}>{t("Project settings")}</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ProjectCardView(props: { card: ProjectCard; handlers: ProjectCardHandlers }) {
  const { card, handlers } = props;
  const headingId = useId();
  const [showingAll, setShowingAll] = useState(false);
  const preview = capSidebarFolderThreads(
    card.threads,
    PROJECT_CARD_PREVIEW_COUNT,
    (thread) => handlers.stateOf(thread) !== "quiet",
  );
  const rows = showingAll ? card.threads : preview.visible;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs/5"
    >
      <div className="flex items-start gap-2 px-3 pt-3 pb-2">
        <ProjectFavicon project={card.group} className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-sm font-semibold">
            {card.group.displayName}
          </h3>
          <ProjectCountsSummary counts={card.counts} className="mt-0.5" />
        </div>
        <NewThreadButton card={card} handlers={handlers} />
        <ProjectCardMenu card={card} handlers={handlers} />
      </div>
      <ul className="flex flex-col px-1.5 pb-1.5">
        {rows.map((thread) => (
          <ProjectThreadRow
            key={threadKeyOf(thread)}
            thread={thread}
            state={handlers.stateOf(thread)}
            woke={handlers.isWoke(thread)}
            onSettle={handlers.canSettle(thread) ? handlers.onSettle : null}
            machine={
              handlers.showMachineIcons && thread.environmentId !== handlers.primaryEnvironmentId
                ? (handlers.machineById.get(thread.environmentId) ?? null)
                : null
            }
          />
        ))}
        {preview.overflow.length > 0 ? (
          <li>
            <Button
              size="xs"
              variant="ghost-muted"
              className="w-full justify-start"
              onClick={() => setShowingAll((value) => !value)}
            >
              {showingAll
                ? t("Show less")
                : t("Show {count} more", { count: preview.overflow.length })}
            </Button>
          </li>
        ) : null}
      </ul>
      {card.snoozedCount > 0 ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {tn(card.snoozedCount, "{count} snoozed", "{count} snoozed")}
        </p>
      ) : null}
    </section>
  );
}

function ProjectThreadRow(props: {
  thread: EnvironmentThreadShell;
  state: ProjectThreadState;
  woke: boolean;
  machine: SidebarMachine | null;
  /** Null when the thread's machine cannot settle it right now. */
  onSettle: ((thread: EnvironmentThreadShell) => void) | null;
}) {
  const { thread, onSettle } = props;
  const status = resolveThreadRowStatus({
    status: resolveSidebarThreadStatus(thread),
    goalActive: thread.goal?.status === "active",
    isWoke: props.woke,
    isUnread: props.state === "done",
  });
  return (
    <li className="group/project-row relative">
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
        className="flex h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {thread.pinnedAt != null ? (
          <PinIcon aria-label={t("Pinned")} className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            props.state === "quiet" ? "text-foreground/75" : "font-medium text-foreground",
          )}
        >
          {thread.title}
        </span>
        {props.machine ? (
          <EnvironmentMachineIcon
            aria-label={props.machine.label}
            kind={props.machine.machineKind}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
        <span
          className={cn(
            "flex shrink-0 items-center text-xs transition-opacity",
            onSettle !== null &&
              "group-hover/project-row:opacity-0 group-focus-within/project-row:opacity-0",
          )}
        >
          {status ? (
            <span className={cn("inline-flex items-center gap-1 font-medium", status.className)}>
              <ThreadRowStatusContent status={status} iconClassName="size-3" />
            </span>
          ) : (
            <span className="text-muted-foreground">
              <RelativeTime timestamp={thread.latestUserMessageAt ?? thread.updatedAt} />
            </span>
          )}
        </span>
      </Link>
      {onSettle === null ? null : (
        // Hover and focus only, so a tap on a touch screen never settles a thread.
        <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 group-hover/project-row:pointer-events-auto group-hover/project-row:opacity-100 group-focus-within/project-row:pointer-events-auto group-focus-within/project-row:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={t("Settle {title}", { title: thread.title })}
                  onClick={(event) => {
                    // The row leaves once the thread settles, so focus moves to a neighbour first.
                    const row = event.currentTarget.closest("li");
                    const neighbour = row?.nextElementSibling ?? row?.previousElementSibling;
                    const next =
                      neighbour?.querySelector<HTMLElement>("a, button") ??
                      // The last open thread turns its card into a quiet row, which keeps this menu.
                      event.currentTarget
                        .closest("section")
                        ?.querySelector<HTMLElement>("[data-project-menu-trigger]");
                    next?.focus();
                    onSettle(thread);
                  }}
                />
              }
            >
              <CheckIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>{t("Settle thread")}</TooltipPopup>
          </Tooltip>
        </span>
      )}
    </li>
  );
}
