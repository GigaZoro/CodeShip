import type { MenuAction } from "@react-native-menu/menu";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ThreadListToolbar } from "./ThreadListToolbar";
import { useOpenArchivedThreads } from "../archive/useOpenArchivedThreads";
import { useOpenArtifacts } from "../artifacts/useOpenArtifacts";
import {
  ARCHIVED_THREADS_EVENT,
  ARTIFACTS_EVENT,
  SHOW_ALL_THREADS_EVENT,
  archivedThreadsMenuItem,
  artifactsMenuItem,
  buildGroupByMenuActions,
  handleGroupByMenuEvent,
  showAllThreadsMenuItems,
} from "./home-list-filter-menu";
import type { HomeHeaderProps } from "./HomeHeader.types";
import { t } from "../../lib/i18n";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
  const openArchivedThreads = useOpenArchivedThreads();
  const openArtifacts = useOpenArtifacts();
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const menuActions: MenuAction[] = [
    ...showAllThreadsMenuItems(hasCustomListOptions),
    {
      id: "environment",
      title: t("Environment"),
      subactions: [
        {
          id: "environment:all",
          title: t("All environments"),
          state: checkedMenuState(props.selectedEnvironmentId === null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
        })),
      ],
    },
    ...(props.projects.length === 0
      ? []
      : ([
          {
            id: "project",
            title: t("Project"),
            subactions: [
              {
                id: "project:all",
                title: t("All projects"),
                state: checkedMenuState(props.selectedProjectKey === null),
              },
              ...props.projects.map((project) => ({
                id: `project:${project.key}`,
                title: project.label,
                state: checkedMenuState(props.selectedProjectKey === project.key),
              })),
            ],
          },
        ] satisfies MenuAction[])),
    ...buildGroupByMenuActions(props.grouping, props.environments.length),
    archivedThreadsMenuItem,
    artifactsMenuItem,
  ];
  const handleMenuAction = (event: { nativeEvent: { event: string } }) => {
    const id = event.nativeEvent.event;
    if (id === SHOW_ALL_THREADS_EVENT) {
      props.onEnvironmentChange(null);
      props.onProjectChange(null);
      return;
    }
    if (id === ARCHIVED_THREADS_EVENT) {
      openArchivedThreads();
      return;
    }
    if (id === ARTIFACTS_EVENT) {
      openArtifacts();
      return;
    }
    if (handleGroupByMenuEvent(id, props)) return;
    if (id === "environment:all") {
      props.onEnvironmentChange(null);
      return;
    }

    if (id.startsWith("environment:")) {
      const environmentId = id.slice("environment:".length);
      const environment = props.environments.find(
        (candidate) => candidate.environmentId === environmentId,
      );
      if (environment) {
        props.onEnvironmentChange(environment.environmentId);
      }
      return;
    }

    if (id === "project:all") {
      props.onProjectChange(null);
      return;
    }

    if (id.startsWith("project:")) {
      const projectKey = id.slice("project:".length);
      if (props.projects.some((project) => project.key === projectKey)) {
        props.onProjectChange(projectKey);
      }
      return;
    }
  };

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <ThreadListToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        filterActions={menuActions}
        filterCustomized={hasCustomListOptions}
        onFilterAction={handleMenuAction}
        onOpenEnvironments={props.onOpenEnvironments}
      />
    </>
  );
}
