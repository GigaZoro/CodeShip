import type { EnvironmentId } from "@t3tools/contracts";
import { availableSidebarGroupBy, SidebarGroupBy } from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";
import * as Schema from "effect/Schema";

export const THREAD_LIST_GROUP_BY_LABELS: Record<SidebarGroupBy, string> = {
  none: "None",
  project: "Project",
  machine: "Machine",
};

const GROUP_BY_EVENT_PREFIX = "group-by:";
const isSidebarGroupBy = Schema.is(SidebarGroupBy);

/** The "Group by" submenu of the thread list's native filter menus. */
export function buildGroupByMenuAction(groupBy: SidebarGroupBy, machineCount: number) {
  return {
    id: "group-by",
    title: "Group by",
    subactions: availableSidebarGroupBy(machineCount, groupBy).map((value) => ({
      id: `${GROUP_BY_EVENT_PREFIX}${value}`,
      title: THREAD_LIST_GROUP_BY_LABELS[value],
      state: value === groupBy ? ("on" as const) : ("off" as const),
    })),
  } satisfies MenuAction;
}

export function parseGroupByMenuEvent(event: string): SidebarGroupBy | null {
  if (!event.startsWith(GROUP_BY_EVENT_PREFIX)) return null;
  const value = event.slice(GROUP_BY_EVENT_PREFIX.length);
  return isSidebarGroupBy(value) ? value : null;
}

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: HomeListFilterMenuAction[];
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly groupBy: SidebarGroupBy;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onGroupByChange: (groupBy: SidebarGroupBy) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        type: "action" as const,
        title: environment.label,
        state:
          props.selectedEnvironmentId === environment.environmentId
            ? ("on" as const)
            : ("off" as const),
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  items.push({
    type: "submenu",
    title: "Group by",
    items: availableSidebarGroupBy(props.environments.length, props.groupBy).map((groupBy) => ({
      type: "action" as const,
      title: THREAD_LIST_GROUP_BY_LABELS[groupBy],
      state: props.groupBy === groupBy ? ("on" as const) : ("off" as const),
      onPress: () => props.onGroupByChange(groupBy),
    })),
  });

  return {
    title: "Thread list options",
    items,
  };
}
