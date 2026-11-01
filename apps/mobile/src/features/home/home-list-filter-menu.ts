import type { EnvironmentId } from "@t3tools/contracts";
import { offersSidebarMachineGrouping, type SidebarGrouping } from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";

const PROJECT_GROUPING_LABELS = { none: "None", project: "Project" } as const;

/** "Group" with nothing on, else what is on, outer folders first: "By machine, project". */
export function threadListGroupingLabel(grouping: SidebarGrouping): string {
  const kinds = [grouping.machine ? "machine" : null, grouping.project ? "project" : null].filter(
    (kind) => kind !== null,
  );
  return kinds.length === 0 ? "Group" : `By ${kinds.join(", ")}`;
}

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
    title: PROJECT_GROUPING_LABELS[value],
    state: grouping.project === (value === "project") ? ("on" as const) : ("off" as const),
  }));
}

export function machineGroupingMenuItem(grouping: SidebarGrouping) {
  return {
    id: MACHINE_GROUPING_EVENT,
    title: "Group by machine",
    state: grouping.machine ? ("on" as const) : ("off" as const),
  } satisfies MenuAction;
}

/** The "Group by" submenu of the thread list's native filter menus, then the machine toggle. */
export function buildGroupByMenuActions(
  grouping: SidebarGrouping,
  machineCount: number,
): MenuAction[] {
  return [
    { id: "group-by", title: "Group by", subactions: projectGroupingMenuItems(grouping) },
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

export function buildHomeListFilterMenu(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly grouping: SidebarGrouping;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
  } & ThreadListGroupingHandlers,
): HomeListFilterMenu {
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
    items: (["none", "project"] as const).map((value) => ({
      type: "action" as const,
      title: PROJECT_GROUPING_LABELS[value],
      state: props.grouping.project === (value === "project") ? ("on" as const) : ("off" as const),
      onPress: () => props.onProjectGroupingChange(value === "project"),
    })),
  });
  if (offersSidebarMachineGrouping(props.environments.length, props.grouping)) {
    items.push({
      type: "action",
      title: "Group by machine",
      state: props.grouping.machine ? "on" : "off",
      onPress: props.onMachineGroupingToggle,
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}
