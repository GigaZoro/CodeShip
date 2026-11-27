import {
  olderSettledViewRequestSetters,
  type OlderSettledScope,
  type OlderSettledViewTargets,
} from "@t3tools/client-runtime/state/threads";
import { threadFolderKey, type EnvironmentId } from "@t3tools/contracts";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import {
  useOlderSettledShelf,
  useOlderSettledShelfGrowth,
  useOlderSettledShelves,
} from "../../state/olderSettledShelf";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  isThreadListV2Filtered,
  threadListInboxReturns,
  threadListV2LayoutTime,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ChatFolderOlder,
  type ThreadListV2ChatFolders,
  type ThreadListV2Folder,
  type ThreadListV2Grouping,
} from "./threadListV2";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

const NO_FOLDERS: ReadonlyArray<ThreadListV2Folder> = [];

/**
 * The React Compiler drops unread dependencies, so pass the expired-grace version through
 * this call to keep inbox updates tied to its subscription.
 */
function observeInbox(
  threads: Parameters<typeof threadListInboxReturns.observe>[0],
  _expiredGraceVersion: number,
) {
  return threadListInboxReturns.observe(threads);
}

/**
 * Shelf callbacks prevent compiler caching across the whole derivation, so each stage keeps
 * its own memo boundary to preserve the list's identity during unrelated navigation renders.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  readonly statusFilter?: LayoutInput["statusFilter"];
  readonly sort?: LayoutInput["sort"];
  readonly lastActivityOrder?: LayoutInput["lastActivityOrder"];
  readonly selectedTags?: LayoutInput["selectedTags"];
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly hiddenTaskThreadKeys: ReadonlySet<string>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly shelfPreferencesLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
  readonly grouping: ThreadListV2Grouping | null;
  readonly chatFolders: ThreadListV2ChatFolders | null;
}) {
  const { threads, workingShelfEnabled, grouping, chatFolders } = input;
  const layoutTime = useMemo(
    () => threadListV2LayoutTime({ threads, now: input.now, searchQuery: input.searchQuery }),
    [threads, input.now, input.searchQuery],
  );
  // A thread can stop working when the threads change, or when its exit grace expires.
  const inboxVersion = useSyncExternalStore(
    threadListInboxReturns.subscribe,
    threadListInboxReturns.getSnapshot,
  );
  const inbox = useMemo(
    () => observeInbox(workingShelfEnabled ? threads : null, inboxVersion),
    [threads, workingShelfEnabled, inboxVersion],
  );
  // Older settled threads load in pages; the shelf lists them only as far as they are loaded.
  const scopes = useMemo(
    () =>
      olderSettledScopes({
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
      }),
    [input.environmentId, input.projectRefs, input.settlementEnvironmentIds],
  );
  // A search lists only matches, so a shelf would page forever; loaded pages stay.
  const searching = input.searchQuery.trim().length > 0;
  const filtered = useMemo(
    () =>
      isThreadListV2Filtered({
        statusFilter: input.statusFilter,
        selectedTags: input.selectedTags,
      }),
    [input.statusFilter, input.selectedTags],
  );
  const scopeKey = JSON.stringify([
    input.environmentId,
    input.projectRefs == null
      ? null
      : [...input.projectRefs]
          .map((ref) => scopedProjectKey(ref.environmentId, ref.projectId))
          .sort(),
    input.searchQuery.trim(),
  ]);
  // A target holds only in the view it was raised in; another view starts from the first page.
  const filterViewKey = JSON.stringify([
    scopeKey,
    input.statusFilter ?? "all",
    [...(input.selectedTags ?? [])].sort(),
  ]);
  const [settledTarget, setSettledTarget] = useState<{ scopeKey: string; count?: number }>({
    scopeKey,
  });
  if (settledTarget.scopeKey !== scopeKey) setSettledTarget({ scopeKey });
  const [viewTargets, setViewTargets] = useState<OlderSettledViewTargets>({
    viewKey: filterViewKey,
  });
  if (viewTargets.viewKey !== filterViewKey) setViewTargets({ viewKey: filterViewKey });
  const targets = viewTargets.viewKey === filterViewKey ? viewTargets : null;
  const pageRequestSetters = useMemo(
    () => olderSettledViewRequestSetters(filterViewKey, setViewTargets),
    [filterViewKey],
  );
  const initialCount = input.settledLimit ?? THREAD_LIST_V2_SETTLED_INITIAL_COUNT;
  const settledLimit = filtered
    ? (targets?.settled ?? initialCount)
    : settledTarget.scopeKey === scopeKey
      ? (settledTarget.count ?? initialCount)
      : initialCount;
  // Filed chats list in their folders, which page their own older chats.
  const settledScopes = useMemo(
    () => scopes.map((scope) => ({ ...scope, folder: null })),
    [scopes],
  );
  const olderSettledShelf = useOlderSettledShelf(
    {
      scopes: settledScopes,
      expanded: input.settledShelfExpanded,
      visibleCount: settledLimit,
      searching,
      filtered,
    },
    {
      requested: targets?.settledPages,
      setRequested: pageRequestSetters.settled,
    },
  );
  const { isListed, unloadedCount } = olderSettledShelf;
  // Settled chats each folder shows, once the user asks it for older ones.
  const folderTargets = targets?.folders;
  const folders = chatFolders?.folders ?? NO_FOLDERS;
  const folderShelfInputs = useMemo(
    () =>
      folders.map((folder) => {
        return {
          id: folder.key,
          scopes: scopes.map((scope) => ({ ...scope, folder: threadFolderKey(folder.label) })),
          expanded: folder.expanded,
          visibleCount: filtered ? 0 : (folderTargets?.get(folder.key) ?? 0),
          searching,
          filtered,
        };
      }),
    [folders, folderTargets, scopes, searching, filtered],
  );
  const folderShelves = useOlderSettledShelves(folderShelfInputs, {
    requested: targets?.folderPages,
    setRequested: pageRequestSetters.folder,
  });
  const chatFolderOlder = useMemo(
    () =>
      new Map(
        folders.flatMap((folder, index) => {
          const shelf = folderShelves[index];
          if (shelf === undefined) return [];
          const older: ThreadListV2ChatFolderOlder = {
            isListed: shelf.isListed,
            unloadedCount: shelf.unloadedCount,
            hasMorePages: shelf.hasMorePages,
            visibleCount: filtered ? folderTargets?.get(folder.key) : undefined,
            state: shelf.loading ? "loading" : null,
            failed: shelf.failed,
          };
          return [[folder.key, older] as const];
        }),
      ),
    [folders, folderShelves, filtered, folderTargets],
  );
  const layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder: input.pendingOrder,
        threads: threads.filter((thread) => thread.archivedAt === null),
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        searchQuery: input.searchQuery,
        statusFilter: input.statusFilter,
        sort: input.sort,
        lastActivityOrder: input.lastActivityOrder,
        selectedTags: input.selectedTags,
        matchedThreadKeys: new Set(input.searchMatches.keys()),
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        hiddenTaskThreadKeys: input.hiddenTaskThreadKeys,
        settledLimit,
        now: layoutTime,
        workingShelfEnabled,
        workingShelfExpanded: input.workingShelfExpanded,
        inboxReturnAt: inbox.returnedAt,
        isWorking: inbox.isWorking,
        snoozedShelfExpanded: input.snoozedShelfExpanded,
        settledShelfExpanded: input.settledShelfExpanded,
        selectedThreadKey: input.selectedThreadKey,
        grouping,
        chatFolders,
        chatFolderOlder,
        isListedSettled: isListed,
        unloadedSettledCount: unloadedCount,
        hasMoreSettledPages: olderSettledShelf.hasMorePages,
        settledReadFailed: olderSettledShelf.failed,
      }),
    [
      input.pendingOrder,
      threads,
      input.environmentId,
      input.projectRefs,
      input.searchQuery,
      input.statusFilter,
      input.sort,
      input.lastActivityOrder,
      input.selectedTags,
      input.searchMatches,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      input.hiddenTaskThreadKeys,
      settledLimit,
      layoutTime,
      workingShelfEnabled,
      input.workingShelfExpanded,
      inbox.returnedAt,
      inbox.isWorking,
      input.snoozedShelfExpanded,
      input.settledShelfExpanded,
      input.selectedThreadKey,
      grouping,
      chatFolders,
      chatFolderOlder,
      isListed,
      unloadedCount,
      olderSettledShelf.hasMorePages,
      olderSettledShelf.failed,
    ],
  );
  const listedArrangement = useRef(layout.listedSections);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed arrangement to callbacks retained by LegendList
  useLayoutEffect(() => {
    listedArrangement.current = layout.listedSections;
  }, [layout.listedSections]);
  const getListedArrangement = useCallback(() => listedArrangement.current, []);

  // Compute move availability per section; per-row planning is quadratic. Moves step
  // between the rows the list shows, so a filter cannot hide the row a move passes.
  const moveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: threads,
        section,
        pendingOrder: input.pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? input.pinReorderEnvironmentIds : input.activeReorderEnvironmentIds,
        ordered: layout.listedSections[section],
      });
    return new Map([
      ...sectionAvailability("pinned"),
      ...(layout.listedSections.activeManualOrder ? sectionAvailability("active") : []),
    ]);
  }, [
    threads,
    input.pendingOrder,
    input.pinReorderEnvironmentIds,
    input.activeReorderEnvironmentIds,
    layout.listedSections,
  ]);
  useOlderSettledShelfGrowth([
    { shelf: olderSettledShelf, listedCount: layout.listedSettledThreads.length },
    ...folders.flatMap((folder, index) => {
      const shelf = folderShelves[index];
      return shelf === undefined
        ? []
        : [{ shelf, listedCount: layout.listedFolderSettledCounts.get(folder.key) ?? 0 }];
    }),
  ]);
  const paging = {
    showMoreSettled: () => {
      if (filtered) {
        const listed = layout.listedSettledThreads.length;
        const count = olderSettledShelf.showMoreFiltered(Math.min(settledLimit, listed), listed);
        setViewTargets((current) => ({ ...current, settled: count }));
      } else {
        setSettledTarget({
          scopeKey,
          count: settledLimit + THREAD_LIST_V2_SETTLED_PAGE_COUNT,
        });
      }
    },
    showMoreInFolder: (folderKey: string) => {
      const shelf = folderShelves[folders.findIndex((folder) => folder.key === folderKey)];
      const footer = layout.folderFooters.find((entry) => entry.folderKey === folderKey);
      if (shelf === undefined || footer === undefined) return;
      const count = filtered
        ? shelf.showMoreFiltered(
            footer.listedCount,
            layout.listedFolderSettledCounts.get(folderKey) ?? 0,
          )
        : footer.listedCount + THREAD_LIST_V2_SETTLED_PAGE_COUNT;
      setViewTargets((current) => ({
        ...current,
        folders: new Map(
          [...(current.folders ?? [])].filter(([key]) =>
            folders.some((folder) => folder.key === key),
          ),
        ).set(folderKey, count),
      }));
    },
    retrySettled: olderSettledShelf.retry,
    retryFolder: (folderKey: string) =>
      folderShelves[folders.findIndex((folder) => folder.key === folderKey)]?.retry(),
  };
  // LegendList can keep a footer's handlers across a filter change, since the footer compares
  // equal, so they act on the committed shelves when pressed.
  const committedPaging = useRef(paging);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed shelves to footer handlers LegendList retains
  useLayoutEffect(() => {
    committedPaging.current = paging;
  });
  const showMoreSettled = useCallback(() => committedPaging.current.showMoreSettled(), []);
  const showMoreInFolder = useCallback(
    (folderKey: string) => committedPaging.current.showMoreInFolder(folderKey),
    [],
  );
  const retrySettled = useCallback(() => committedPaging.current.retrySettled(), []);
  const retryFolder = useCallback(
    (folderKey: string) => committedPaging.current.retryFolder(folderKey),
    [],
  );
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const pendingTasks = useMemo(() => {
    const scopedProjectKeys =
      input.projectRefs == null
        ? null
        : new Set(
            input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)),
          );
    const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
    return input.pendingTasks.filter(
      (pendingTask) =>
        (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          )) &&
        (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
    );
  }, [input.projectRefs, input.searchQuery, input.pendingTasks, input.environmentId]);
  const items = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: layout.items,
        pendingTasks,
        folderHeaders: layout.folderHeaders,
        folderFooters: layout.folderFooters,
        needsYouCount: layout.needsYouCount,
        needsYouLaterCount: layout.needsYouLaterCount,
        finishedNotSeenCount: layout.finishedNotSeenCount,
        workingCount: layout.workingCount,
        workingShelfExpanded: input.workingShelfExpanded,
        workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
        snoozedCount: layout.snoozedCount,
        snoozedShelfExpanded: input.snoozedShelfExpanded,
        snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
        settledCount: layout.settledCount,
        settledUncounted: layout.hiddenSettledCount === null || olderSettledShelf.failed,
        settledShelfExpanded: input.settledShelfExpanded,
        settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        moveAvailability,
        shelfPreferencesLoading: !input.shelfPreferencesLoaded,
      }),
    [
      layout,
      pendingTasks,
      input.workingShelfExpanded,
      input.snoozedShelfExpanded,
      input.settledShelfExpanded,
      input.now,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      moveAvailability,
      input.shelfPreferencesLoaded,
      olderSettledShelf.failed,
    ],
  );
  return {
    settledFooter:
      input.settledShelfExpanded &&
      layout.settledShelfHeaderIndex !== null &&
      (layout.hiddenSettledCount !== 0 || olderSettledShelf.failed)
        ? {
            hiddenCount: layout.hiddenSettledCount,
            state: olderSettledShelf.loading ? ("loading" as const) : null,
            failed: olderSettledShelf.failed,
          }
        : null,
    layout,
    items,
    contentOnlyThreadKeys,
    olderSettledShelf,
    retryFolder,
    retrySettled,
    showMoreInFolder,
    showMoreSettled,
    getListedArrangement,
  };
}

/** The list's scope per environment: its projects there, or every project. */
function olderSettledScopes(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<OlderSettledScope> {
  const environmentIds =
    input.environmentId === null ? [...input.settlementEnvironmentIds] : [input.environmentId];
  return environmentIds.flatMap((environmentId): ReadonlyArray<OlderSettledScope> => {
    if (input.projectRefs == null) return [{ environmentId, projectIds: null }];
    const projectIds = input.projectRefs.flatMap((ref) =>
      ref.environmentId === environmentId ? [ref.projectId] : [],
    );
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}
