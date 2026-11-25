import {
  THREAD_LIST_STATUS_LABELS,
  ThreadListStatusFilter,
} from "@t3tools/client-runtime/state/thread-status";
import { THREAD_LIST_SORT_LABELS, ThreadListSort } from "@t3tools/client-runtime/state/thread-sort";
import {
  threadTagFilterOptions,
  toggleThreadTagSelection,
} from "@t3tools/client-runtime/state/thread-tag-filter";
import type { EnvironmentId } from "@t3tools/contracts";
import { offersSidebarMachineGrouping, type SidebarGrouping } from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { msg, t } from "../../lib/i18n";
import type { HomeListOptions } from "./home-list-options";

const PROJECT_GROUPING_LABELS = { none: msg("None"), project: msg("Project") } as const;

/** "Group" with nothing on, else what is on, outer folders first: "By machine, project". */
export function threadListGroupingLabel(grouping: SidebarGrouping): string {
  if (grouping.machine && grouping.project) return t("By machine, project");
  if (grouping.machine) return t("By machine");
  if (grouping.project) return t("By project");
  return t("Group");
}

/** The filter button marks a filter only by filling its icon, so its label says it too. */
export function threadListFilterButtonLabel(filtered: boolean): string {
  return filtered ? t("Filter threads, filtered") : t("Filter threads");
}

export function statusFilterMenuItems(selected: ThreadListStatusFilter) {
  return ThreadListStatusFilter.literals.map((value) => ({
    id: `status:${value}`,
    title: t(THREAD_LIST_STATUS_LABELS[value]),
    state: selected === value ? ("on" as const) : ("off" as const),
    value,
  }));
}

export function sortMenuItems(selected: ThreadListSort) {
  return ThreadListSort.literals.map((value) => ({
    id: `sort:${value}`,
    title: t(THREAD_LIST_SORT_LABELS[value]),
    state: value === selected ? ("on" as const) : ("off" as const),
    value,
  }));
}

export const CLEAR_TAGS_EVENT = "tags:clear";

export function tagFilterMenuItems(available: readonly string[], selected: readonly string[]) {
  const selectedSet = new Set(selected);
  return [
    {
      id: CLEAR_TAGS_EVENT,
      title: t("All tags"),
      state: selected.length === 0 ? ("on" as const) : ("off" as const),
    },
    ...threadTagFilterOptions(available, selected).map((tag) => ({
      id: `tags:toggle:${tag}`,
      title: tag,
      state: selectedSet.has(tag) ? ("on" as const) : ("off" as const),
    })),
  ];
}

export function applyTagFilterMenuEvent(event: string, selected: readonly string[]) {
  if (event === CLEAR_TAGS_EVENT) return [];
  if (event.startsWith("tags:toggle:"))
    return toggleThreadTagSelection(selected, event.slice("tags:toggle:".length));
  return null;
}

export type ThreadListRefinement = Pick<HomeListOptions, "statusFilter" | "sort" | "selectedTags">;

/** Status and tag filters hide threads; the sort only reorders them. */
export function threadListRefinementFilters(refinement: ThreadListRefinement) {
  return refinement.statusFilter !== "all" || refinement.selectedTags.length > 0;
}

/** The Status, Sort by and Filter by tags submenus of the thread list's native filter menus. */
export function buildThreadListRefinementMenuActions(
  refinement: ThreadListRefinement,
  availableTags: readonly string[],
): MenuAction[] {
  return [
    {
      id: "status",
      title: t("Status"),
      subactions: statusFilterMenuItems(refinement.statusFilter),
    },
    { id: "sort", title: t("Sort by"), subactions: sortMenuItems(refinement.sort) },
    ...(availableTags.length > 0 || refinement.selectedTags.length > 0
      ? [
          {
            id: "tags",
            title: t("Filter by tags"),
            subactions: tagFilterMenuItems(availableTags, refinement.selectedTags),
          },
        ]
      : []),
  ];
}

/** The change a menu event from the items above makes; null when the event is not one of them. */
export function threadListRefinementMenuChange(
  event: string,
  refinement: ThreadListRefinement,
): Partial<ThreadListRefinement> | null {
  const sort = sortMenuItems(refinement.sort).find((item) => item.id === event);
  if (sort) return { sort: sort.value };
  const status = statusFilterMenuItems(refinement.statusFilter).find((item) => item.id === event);
  if (status) return { statusFilter: status.value };
  const selectedTags = applyTagFilterMenuEvent(event, refinement.selectedTags);
  return selectedTags === null ? null : { selectedTags };
}

export const SHOW_ALL_THREADS_EVENT = "show-all-threads";

/** Clears the environment, project, status and tag filters; offered only while one is set. */
export function showAllThreadsMenuItems(filtered: boolean): MenuAction[] {
  return filtered ? [{ id: SHOW_ALL_THREADS_EVENT, title: t("Show all threads") }] : [];
}

export const ARCHIVED_THREADS_EVENT = "archived-threads";

/** Opens the archived threads screen from the thread list's native menus. */
export const archivedThreadsMenuItem = {
  id: ARCHIVED_THREADS_EVENT,
  get title() {
    return t("Archived");
  },
} satisfies MenuAction;

export const ARTIFACTS_EVENT = "artifacts";

/** Opens the artifacts screen from the thread list's native menus. */
export const artifactsMenuItem = {
  id: ARTIFACTS_EVENT,
  get title() {
    return t("Artifacts");
  },
} satisfies MenuAction;

const PROJECT_GROUPING_EVENT_PREFIX = "group-by:";
const MACHINE_GROUPING_EVENT = "group-by-machine";

export interface ThreadListGroupingHandlers {
  readonly onProjectGroupingChange: (value: boolean) => void;
  readonly onMachineGroupingToggle: () => void;
}

/** None or Project; machine folders are a separate toggle. */
export function projectGroupingMenuItems(grouping: SidebarGrouping) {
  return (["none", "project"] as const).map((value) => ({
    id: `${PROJECT_GROUPING_EVENT_PREFIX}${value}`,
    title: t(PROJECT_GROUPING_LABELS[value]),
    state: grouping.project === (value === "project") ? ("on" as const) : ("off" as const),
  }));
}

export function machineGroupingMenuItem(grouping: SidebarGrouping) {
  return {
    id: MACHINE_GROUPING_EVENT,
    title: t("Group by machine"),
    state: grouping.machine ? ("on" as const) : ("off" as const),
  } satisfies MenuAction;
}

/** The "Group by" submenu of the thread list's native filter menus, then the machine toggle. */
export function buildGroupByMenuActions(
  grouping: SidebarGrouping,
  machineCount: number,
): MenuAction[] {
  return [
    { id: "group-by", title: t("Group by"), subactions: projectGroupingMenuItems(grouping) },
    ...(offersSidebarMachineGrouping(machineCount, grouping)
      ? [machineGroupingMenuItem(grouping)]
      : []),
  ];
}

/** Applies a menu event from the items above; false when the event is not one of them. */
export function handleGroupByMenuEvent(event: string, handlers: ThreadListGroupingHandlers) {
  if (event === MACHINE_GROUPING_EVENT) {
    handlers.onMachineGroupingToggle();
    return true;
  }
  if (!event.startsWith(PROJECT_GROUPING_EVENT_PREFIX)) return false;
  const value = event.slice(PROJECT_GROUPING_EVENT_PREFIX.length);
  if (value !== "none" && value !== "project") return false;
  handlers.onProjectGroupingChange(value === "project");
  return true;
}

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly grouping: SidebarGrouping;
    readonly statusFilter: ThreadListStatusFilter;
    readonly sort: ThreadListSort;
    readonly onSortChange: (sort: ThreadListSort) => void;
    readonly selectedTags: readonly string[];
    readonly availableTags: readonly string[];
    readonly onTagsChange: (tags: readonly string[]) => void;
    readonly onStatusChange: (status: ThreadListStatusFilter) => void;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    readonly onOpenArchived: () => void;
    readonly onOpenArtifacts: () => void;
  } & ThreadListGroupingHandlers,
): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [];

  if (
    props.selectedEnvironmentId !== null ||
    props.selectedProjectKey !== null ||
    threadListRefinementFilters(props)
  ) {
    items.push({
      id: "show-all-threads",
      title: t("Show all threads"),
      onPress: () => {
        props.onEnvironmentChange(null);
        props.onProjectChange(null);
        props.onStatusChange("all");
        props.onTagsChange([]);
      },
    });
  }

  items.push({
    id: "environment",
    title: t("Environment"),
    items: [
      {
        id: "environment:all",
        title: t("All environments"),
        subtitle: t("Show threads from every environment"),
        selected: props.selectedEnvironmentId === null,
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.label,
        selected: props.selectedEnvironmentId === environment.environmentId,
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: t("Project"),
      items: [
        {
          id: "project:all",
          title: t("All projects"),
          subtitle: t("Show threads from every project"),
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  items.push({
    id: "status",
    title: t("Status"),
    items: statusFilterMenuItems(props.statusFilter).map(({ id, title, state, value }) => ({
      id,
      title,
      selected: state === "on",
      onPress: () => props.onStatusChange(value),
    })),
  });

  items.push({
    id: "sort",
    title: t("Sort by"),
    items: sortMenuItems(props.sort).map(({ id, title, state, value }) => ({
      id,
      title,
      selected: state === "on",
      onPress: () => props.onSortChange(value),
    })),
  });

  if (props.availableTags.length > 0 || props.selectedTags.length > 0) {
    items.push({
      id: "tags",
      title: t("Filter by tags"),
      items: tagFilterMenuItems(props.availableTags, props.selectedTags).map(
        ({ id, title, state }) => ({
          id,
          title,
          selected: state === "on",
          onPress: () => {
            const next = applyTagFilterMenuEvent(id, props.selectedTags);
            if (next) props.onTagsChange(next);
          },
        }),
      ),
    });
  }

  items.push({
    id: "group-by",
    title: t("Group by"),
    items: (["none", "project"] as const).map((value) => ({
      id: `group-by:${value}`,
      title: t(PROJECT_GROUPING_LABELS[value]),
      selected: props.grouping.project === (value === "project"),
      onPress: () => props.onProjectGroupingChange(value === "project"),
    })),
  });
  if (offersSidebarMachineGrouping(props.environments.length, props.grouping)) {
    items.push({
      id: "group-by-machine",
      title: t("Group by machine"),
      selected: props.grouping.machine,
      onPress: props.onMachineGroupingToggle,
    });
  }

  items.push({ id: "archived", title: t("Archived"), onPress: props.onOpenArchived });
  items.push({ id: "artifacts", title: t("Artifacts"), onPress: props.onOpenArtifacts });

  return items;
}
