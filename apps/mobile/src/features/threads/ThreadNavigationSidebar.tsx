import { useActiveNewTask } from "../../state/active-new-task";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { distinctEnvironmentLabels } from "@t3tools/client-runtime/connection";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "./threadListAnimations";
import { machineAvailabilityOf } from "./thread-row-emphasis";
import { useReconnectMachines } from "../connection/useReconnectMachines";
import { ThreadListPinnedTasks, useScheduledTaskHiddenThreadKeys } from "./ThreadListPinnedTasks";
import { ThreadListManualSteps } from "./ThreadListManualSteps";
import type { ThreadMoveDestination } from "./threadOrder";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { FLOATING_TABS } from "../layout/workspace/floating-workspace-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useOpenArchivedThreads } from "../archive/useOpenArchivedThreads";
import { useOpenArtifacts } from "../artifacts/useOpenArtifacts";
import { useProjects } from "../../state/entities";
import { useSavedThreadFolders, useThreadFolderNames } from "../../state/thread-folders";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { useThreadListNow } from "./use-thread-list-now";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  useLaunchingThreads,
  usePendingNewTasks,
  type PendingNewTask,
} from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadListV2 } from "./useThreadListV2";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { requestThreadMessageJump } from "./threadMessageJump";
import { useThreadListSearchMatches } from "./useThreadListSearchMatches";
import {
  environmentThreadShells,
  steadyListedThreadShellsAtom,
  threadFilterTagsAtom,
} from "../../state/threads";
import { useHomeListOptions } from "../home/home-list-options";
import {
  buildHomeListFilterMenuItems,
  threadListRefinementFilters,
} from "../home/home-list-filter-menu";
import {
  buildHomeProjectScopes,
  buildHomeChatFolders,
  buildHomeThreadListGrouping,
  homeFolderNewThreadTargets,
  resolveHomeProjectFilterScope,
  sortHomeProjectScopes,
} from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import { useFabScroll } from "../home/FabScrollContext";
import { WorkspaceListHeader } from "../layout/workspace/WorkspaceListHeader";
import { WorkspaceSidebarColumn } from "../layout/workspace/WorkspaceSidebarColumn";
import {
  ThreadListV2FolderHeader,
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2OlderThreadsFooter,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2NeedsYouHeader,
  ThreadListV2WorkingShelfHeader,
} from "./thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import { ThreadPrDemandProvider } from "../../state/thread-pr-demand";
import {
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Folder,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { t } from "../../lib/i18n";

type SidebarListItem =
  | ThreadListV2ListItem
  | {
      readonly type: "v2-show-more";
      readonly key: string;
      readonly hiddenCount: number | null;
      readonly state: "loading" | null;
      readonly failed: boolean;
    };

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onOpenPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  return (
    <ThreadPrDemandProvider visible={props.visible}>
      <WorkspaceSidebarColumn width={props.width}>
        <ThreadNavigationSidebarPane {...props} />
      </WorkspaceSidebarColumn>
    </ThreadPrDemandProvider>
  );
}

function ThreadNavigationSidebarPane(props: ThreadNavigationSidebarProps) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance, fabSize } = useAndroidControlSizing();
  const projects = useProjects();
  const threads = useAtomValue(steadyListedThreadShellsAtom);
  const openArchivedThreads = useOpenArchivedThreads();
  const openArtifacts = useOpenArtifacts();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const machineReconnect = useReconnectMachines(workspaceEnvironments);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    setThreadLater,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const launchingThreads = useLaunchingThreads(threads);
  const activeNewTask = useActiveNewTask();
  const queuedThreadKeys = useQueuedThreadKeys();
  const selectDetail = useSelectWorkspaceDetail();
  const { confirmDeletePendingTask } = usePendingTaskListActions((params) =>
    selectDetail({ name: "Thread", params }),
  );
  const savedConnections = Object.values(savedConnectionsById);
  const environmentLabels = distinctEnvironmentLabels(
    savedConnections.map((connection) => ({
      label: connection.environmentLabel,
      displayUrl: connection.displayUrl,
    })),
  );
  const environments = savedConnections
    .map((connection, index) => ({
      environmentId: connection.environmentId,
      label: environmentLabels[index] ?? connection.environmentLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableEnvironmentIds = new Set(
    environments.map((environment) => environment.environmentId),
  );
  const { options, setSelectedEnvironmentId, setSelectedProjectKey, updateOptions } =
    useHomeListOptions(availableEnvironmentIds);
  const searchEnvironmentIds =
    options.selectedEnvironmentId === null
      ? workspaceEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId)
      : workspaceEnvironments.some(
            (environment) =>
              environment.environmentId === options.selectedEnvironmentId &&
              environment.connectionState === "connected",
          )
        ? [options.selectedEnvironmentId]
        : [];
  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes(
        buildHomeProjectScopes({
          projects,
          environmentId: options.selectedEnvironmentId,
          projectGroupingMode: options.projectGroupingMode,
        }),
      ),
    [projects, options.selectedEnvironmentId, options.projectGroupingMode],
  );
  const projectFilterOptions = pickableProjectGroups(sortHomeProjectScopes(projectScopes)).map(
    (scope) => ({
      key: scope.key,
      label: scope.title,
    }),
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope = resolveHomeProjectFilterScope(projectScopes, projects, options);
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    selectedProjectScope === null
      ? {}
      : { projectIds: selectedProjectScope.projectRefs.map((ref) => ref.projectId) },
  );
  // This map reaches LegendList's extraData, which re-renders every row whenever it changes
  // identity; the hook keeps it stable.
  const threadSearchMatchByKey = useThreadListSearchMatches(threads, threadSearch);
  const selectedProjectKey = selectedProjectScope?.key ?? null;
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    grouping: groupBy,
    folderExpanded,
    setProjectGrouping,
    toggleMachineGrouping,
    toggleFolder,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } = useThreadListV2ShelfPreferences();
  const connectionStateByEnvironmentId = new Map(
    workspaceEnvironments.map(
      (environment) => [environment.environmentId, environment.connectionState] as const,
    ),
  );
  // A string, so rows re-render when a machine's state changes but not on every render.
  const machineStatesKey = workspaceEnvironments
    .map((environment) => `${environment.environmentId}:${environment.connectionState}`)
    .join(",");
  const grouping = buildHomeThreadListGrouping({
    grouping: groupBy,
    folderExpanded,
    projectScopes,
    environments: environments
      .filter(
        (environment) =>
          options.selectedEnvironmentId === null ||
          environment.environmentId === options.selectedEnvironmentId,
      )
      .map((environment) => {
        const connectionState = connectionStateByEnvironmentId.get(environment.environmentId);
        return {
          ...environment,
          offline: connectionState !== "connected" && connectionState !== "connecting",
        };
      }),
  });
  const chatFolders = buildHomeChatFolders({
    saved: useSavedThreadFolders(),
    names: useThreadFolderNames(),
    folderExpanded,
  });
  const toggleThreadListFolder = (folder: ThreadListV2Folder) =>
    toggleFolder(folder.key, folder.expandedByDefault);
  const now = useThreadListNow(threads);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    snoozePresetsByEnvironmentId,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    laterEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder();
  const hiddenTaskThreadKeys = useScheduledTaskHiddenThreadKeys(
    JSON.stringify([...settlementEnvironmentIds]),
  );
  const lastActivityOrder = useAtomValue(
    environmentThreadShells.lastActivityOrderAtom(options.sort),
  );
  const {
    layout: threadListV2Layout,
    items: threadListV2Items,
    contentOnlyThreadKeys,
    settledFooter,
    retryFolder,
    retrySettled,
    showMoreInFolder,
    showMoreSettled,
    getListedArrangement,
  } = useThreadListV2({
    threads: launchingThreads,
    pendingTasks,
    environmentId: options.selectedEnvironmentId,
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    searchQuery: props.searchQuery,
    statusFilter: options.statusFilter,
    sort: options.sort,
    lastActivityOrder,
    selectedTags: options.selectedTags,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    queuedThreadKeys,
    hiddenTaskThreadKeys,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey: props.selectedThreadKey ?? null,
    grouping,
    chatFolders,
  });
  const moveListedThread = (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) =>
    moveThread(thread, direction, getListedArrangement);
  const listItems: readonly SidebarListItem[] =
    settledFooter !== null
      ? [
          ...threadListV2Items,
          {
            type: "v2-show-more",
            key: "v2-show-more",
            ...settledFooter,
          },
        ]
      : threadListV2Items;
  const availableTags = useAtomValue(threadFilterTagsAtom);

  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };
  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };
  // Destructure callback props; capturing all props would invalidate these row-closing handlers on unrelated changes.
  const { onSelectThread, onOpenThreadPullRequests } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
    openSwipeableRef.current?.close();
  };
  const pinnedTasksHeader = props.searchQuery.trim() ? null : (
    <>
      <ThreadListPinnedTasks
        environmentIdsKey={JSON.stringify([...settlementEnvironmentIds])}
        environmentId={options.selectedEnvironmentId}
        projectRefs={selectedProjectScope === null ? null : selectedProjectScope.projectRefs}
        pane="sidebar"
        selectedThreadKey={props.selectedThreadKey ?? null}
        onSelectThread={handleSelectThread}
      />
      <ThreadListManualSteps pane="sidebar" onSelectThread={handleSelectThread} />
    </>
  );
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    onOpenThreadPullRequests(thread, pr);
    openSwipeableRef.current?.close();
  };
  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const onFabScroll = useFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Recycle equality needs project/search data for titles and favicons; keep the minute clock on items to limit updates.
  const listExtraData = {
    activeNewTask,
    selectedThreadKey: props.selectedThreadKey ?? "",
    projectByKey,
    projectTitleByProjectKey,
    savedConnectionsById,
    listEnvironments,
    threadSearchMatchByKey,
    workingShelfEnabled,
    groupByProject: groupBy.project,
    groupByMachine: groupBy.machine,
    machineStatesKey,
  };
  useThreadJumpShortcuts(listItems, handleSelectThread);
  const sidebarItemsAreEqual = (previous: SidebarListItem, item: SidebarListItem): boolean => {
    if (isThreadListV2ListItem(previous) && isThreadListV2ListItem(item)) {
      return threadListV2ListItemsAreEqual(previous, item);
    }
    if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
      return (
        previous.hiddenCount === item.hiddenCount &&
        previous.state === item.state &&
        previous.failed === item.failed
      );
    }
    return false;
  };
  const renderListItem = ({ item }: { readonly item: SidebarListItem }) => {
    switch (item.type) {
      case "v2-pending": {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            selected={
              activeNewTask?.pendingKey === item.pendingTask.key ||
              (item.pendingTask.kind === "pending" &&
                scopedThreadKey(
                  item.pendingTask.environmentId,
                  item.pendingTask.message.threadId,
                ) === props.selectedThreadKey)
            }
            project={projectByKey.get(pendingScopeKey) ?? null}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                : null
            }
            pane="sidebar"
            showPendingDivider={item.showPendingDivider}
            onSelectPendingTask={props.onOpenPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            fullSwipeWidth={props.width - 20}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-thread": {
        const thread = item.item.thread;
        const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
        return (
          <ThreadListV2Row
            onNewThreadOnBranch={props.onNewThreadOnBranch}
            thread={thread}
            variant={item.item.variant}
            hasQueuedMessages={item.hasQueuedMessages}
            snoozed={item.item.snoozed}
            pinned={item.item.pinned}
            wokeAt={item.item.wokeAt}
            waitingSince={item.item.waitingSince}
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            project={projectByKey.get(scopeKey) ?? null}
            providerInstance={resolveProviderInstance(thread)}
            providers={providersByEnvironmentId.get(thread.environmentId)}
            environmentLabel={
              // A machine folder already names the machine.
              Object.keys(savedConnectionsById).length > 1 && item.folderKind !== "machine"
                ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            machineAvailability={machineAvailabilityOf(
              connectionStateByEnvironmentId.get(thread.environmentId),
            )}
            searchMatch={
              // Only rows listed for their messages show one and open at it.
              contentOnlyThreadKeys.has(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
                ? threadSearchMatchByKey.get(
                    threadSearchMatchKey({
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    }),
                  )
                : undefined
            }
            searchQuery={threadSearch.query}
            pane="sidebar"
            selected={
              !activeNewTask &&
              scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
            }
            fullSwipeWidth={props.width - 20}
            onSelectThread={handleSelectThread}
            onOpenThreadPullRequests={handleOpenThreadPullRequests}
            onDeleteThread={confirmDeleteThread}
            onArchiveThread={archiveThread}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
            settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
            onSettleThread={settleThread}
            snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
            snoozePresets={snoozePresetsByEnvironmentId.get(thread.environmentId)}
            pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
            autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
            arrangementSupported={activeReorderEnvironmentIds.has(thread.environmentId)}
            reorderSupported={
              item.item.needsYou !== true &&
              (item.item.pinned
                ? pinReorderEnvironmentIds.has(thread.environmentId)
                : threadListV2Layout.listedSections.activeManualOrder &&
                  activeReorderEnvironmentIds.has(thread.environmentId))
            }
            canMoveUp={item.canMoveUp}
            canMoveDown={item.canMoveDown}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onUnsettleThread={unsettleThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onSetThreadAutoSettle={setThreadAutoSettle}
            onSetThreadLater={setThreadLater}
            needsYouLater={
              item.item.needsYou === true && laterEnvironmentIds.has(thread.environmentId)
                ? item.item.later === true
                : undefined
            }
            onMoveThread={moveListedThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-folder":
        return (
          <ThreadListV2FolderHeader
            folder={item.folder}
            project={
              item.folder.kind === "project"
                ? (projectByKey.get(item.folder.projectKey) ?? null)
                : null
            }
            hiddenCount={item.hiddenCount}
            pane="sidebar"
            newThreadTargets={homeFolderNewThreadTargets(item.folder, projectScopes)}
            onToggle={toggleThreadListFolder}
            onNewThreadInProject={props.onNewThreadInProject}
          />
        );
      case "v2-folder-more":
        return (
          <ThreadListV2OlderThreadsFooter
            pane="sidebar"
            hiddenCount={item.hiddenCount}
            state={item.state}
            onShowMore={() => showMoreInFolder(item.folderKey)}
            onRetry={item.failed ? () => retryFolder(item.folderKey) : undefined}
          />
        );
      case "v2-needs-you":
        return <ThreadListV2NeedsYouHeader count={item.count} later={item.later} pane="sidebar" />;
      case "v2-working-shelf":
        return (
          <ThreadListV2WorkingShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleWorkingShelf}
            pane="sidebar"
          />
        );
      case "v2-snoozed-shelf":
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
            pane="sidebar"
          />
        );
      case "v2-settled-shelf":
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
            pane="sidebar"
          />
        );
      case "v2-show-more":
        return (
          <ThreadListV2OlderThreadsFooter
            pane="sidebar"
            hiddenCount={item.hiddenCount}
            state={item.state}
            onShowMore={showMoreSettled}
            onRetry={item.failed ? retrySettled : undefined}
          />
        );
    }
  };
  const filterCustomized =
    options.selectedEnvironmentId !== null ||
    selectedProjectKey !== null ||
    threadListRefinementFilters(options);
  const header = (
    <WorkspaceListHeader
      accessibilityLabel={t("T3.CodeShip, Threads")}
      onOpenEnvironments={props.onOpenEnvironmentSettings}
      onOpenSettings={props.onOpenSettings}
      search={{
        value: props.searchQuery,
        onChangeText: props.onSearchQueryChange,
        placeholder: t("Search"),
        accessibilityLabel: t("Search threads"),
      }}
      filter={{
        customized: filterCustomized,
        items: buildHomeListFilterMenuItems({
          environments,
          projects: projectFilterOptions,
          selectedEnvironmentId: options.selectedEnvironmentId,
          selectedProjectKey,
          grouping: groupBy,
          statusFilter: options.statusFilter,
          onStatusChange: (statusFilter) => updateOptions({ statusFilter }),
          sort: options.sort,
          onSortChange: (sort) => updateOptions({ sort }),
          selectedTags: options.selectedTags,
          availableTags,
          onTagsChange: (selectedTags) => updateOptions({ selectedTags }),
          onEnvironmentChange: setSelectedEnvironmentId,
          onProjectChange: setSelectedProjectKey,
          onProjectGroupingChange: setProjectGrouping,
          onMachineGroupingToggle: toggleMachineGrouping,
          onOpenArchived: openArchivedThreads,
          onOpenArtifacts: openArtifacts,
        }),
      }}
      sidebar={{
        width: props.width,
        visible: props.visible,
        onRequestVisibility: props.onRequestVisibility,
      }}
    />
  );
  const showAddEnvironment =
    !catalogState.isLoadingConnections &&
    !catalogState.hasReadyEnvironment &&
    !catalogState.hasConnectingEnvironment;
  const listEmpty = (
    <View>
      <Text
        className={
          Platform.OS === "android"
            ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
            : "px-2 py-4 text-sm text-drawer-foreground-muted"
        }
      >
        {catalogState.isLoadingConnections
          ? t("Loading threads…")
          : showAddEnvironment
            ? t("No environments connected")
            : props.searchQuery.trim().length > 0
              ? threadSearch.isPending
                ? t("Searching thread messages…")
                : t("No matching threads")
              : threadListRefinementFilters(options)
                ? t("No threads match your filters")
                : selectedProjectScope !== null
                  ? t("No threads in {project}", { project: selectedProjectScope.title })
                  : t("No threads yet")}
      </Text>
      {showAddEnvironment ? (
        <View className={Platform.OS === "android" ? "self-center" : "px-2"}>
          <Button
            tone="primary"
            size="compact"
            icon="plus"
            label={t("Add environment")}
            onPress={props.onOpenEnvironmentSettings}
          />
        </View>
      ) : null}
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <>
        {header}
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <AnimatedLegendList
                renderScrollComponent={NativeScrollView}
                itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                refreshing={machineReconnect.refreshing}
                onRefresh={() => void machineReconnect.reconnect()}
                automaticallyAdjustsScrollIndicatorInsets
                // The column lays the list under its bar, glass or solid; UIKit insets it past both.
                contentInsetAdjustmentBehavior="automatic"
                contentContainerStyle={[
                  styles.threadListContent,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListHeaderComponent={pinnedTasksHeader}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
          <ThreadUndoNotice visible={props.visible} />
        </View>
      </>
    );
  }

  // Android: the bar floats below the list.
  return (
    <View testID="thread-navigation-sidebar" className="flex-1 bg-header">
      <View
        className="flex-1"
        style={{
          marginHorizontal: 4,
          paddingBottom: insets.bottom,
          backgroundColor: drawerColor,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          overflow: "hidden",
        }}
      >
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- The Android sidebar has no native header to register with. */}
            <AnimatedLegendList
              itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              refreshing={machineReconnect.refreshing}
              onRefresh={() => void machineReconnect.reconnect()}
              contentContainerStyle={[
                {
                  paddingBottom: floatingTabsEnabled
                    ? FLOATING_TABS.bottom + FLOATING_TABS.edge + fabSize
                    : Math.max(insets.bottom, 16) + fabClearance - insets.bottom,
                  paddingTop: 6,
                },
                listItems.length === 0 ? { flexGrow: 1 } : null,
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListHeaderComponent={pinnedTasksHeader}
              ListEmptyComponent={
                <View className="flex-1 items-center justify-center">{listEmpty}</View>
              }
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>
      {header}
      <ThreadUndoNotice visible={props.visible} />
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
