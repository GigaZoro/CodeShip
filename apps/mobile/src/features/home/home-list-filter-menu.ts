import type { EnvironmentId } from "@t3tools/contracts";
import {
  offeredSidebarGroupingKinds,
  type SidebarGrouping,
  SidebarGroupingKind,
} from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";
import * as Schema from "effect/Schema";

const THREAD_LIST_GROUPING_LABELS: Record<SidebarGroupingKind, string> = {
  project: "Project",
  machine: "Machine",
};

/** "Group" with nothing on, else what is on, outer folders first: "By machine, project". */
export function threadListGroupingLabel(grouping: SidebarGrouping): string {
  const kinds = (["machine", "project"] as const).filter((kind) => grouping[kind]);
  return kinds.length === 0
    ? "Group"
    : `By ${kinds.map((kind) => THREAD_LIST_GROUPING_LABELS[kind].toLowerCase()).join(", ")}`;
}

const GROUP_BY_EVENT_PREFIX = "group-by:";
const isSidebarGroupingKind = Schema.is(SidebarGroupingKind);

/** The "Group by" submenu of the thread list's native filter menus; each item toggles. */
export function buildGroupByMenuAction(grouping: SidebarGrouping, machineCount: number) {
  return {
    id: "group-by",
    title: "Group by",
    subactions: offeredSidebarGroupingKinds(machineCount, grouping).map((kind) => ({
      id: `${GROUP_BY_EVENT_PREFIX}${kind}`,
      title: THREAD_LIST_GROUPING_LABELS[kind],
      state: grouping[kind] ? ("on" as const) : ("off" as const),
    })),
  } satisfies MenuAction;
}

export function parseGroupByMenuEvent(event: string): SidebarGroupingKind | null {
  if (!event.startsWith(GROUP_BY_EVENT_PREFIX)) return null;
  const value = event.slice(GROUP_BY_EVENT_PREFIX.length);
  return isSidebarGroupingKind(value) ? value : null;
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
  readonly grouping: SidebarGrouping;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onGroupingToggle: (kind: SidebarGroupingKind) => void;
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
    items: offeredSidebarGroupingKinds(props.environments.length, props.grouping).map((kind) => ({
      type: "action" as const,
      title: THREAD_LIST_GROUPING_LABELS[kind],
      state: props.grouping[kind] ? ("on" as const) : ("off" as const),
      onPress: () => props.onGroupingToggle(kind),
    })),
  });

  return {
    title: "Thread list options",
    items,
  };
}
