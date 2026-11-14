import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import { threadFolderKey, type EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState, useSyncExternalStore } from "react";

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
  getThreadListV2OrderedSection,
  threadListInboxReturns,
  threadListV2LayoutTime,
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
const NO_FOLDER_TARGETS: ReadonlyMap<string, number> = new Map();

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
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly hiddenTaskThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
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
  // Compute move availability per section; per-row planning is quadratic.
  const moveAvailability = useMemo(() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeThreadMoveAvailability({
        allThreads: threads,
        section,
        pendingOrder: input.pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? input.pinReorderEnvironmentIds : input.activeReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder: input.pendingOrder,
          now: layoutTime,
          settlementEnvironmentIds: input.settlementEnvironmentIds,
          snoozeEnvironmentIds: input.snoozeEnvironmentIds,
          queuedThreadKeys: input.queuedThreadKeys,
        }).filter(
          // Filed chats list in their folders; the Active list's moves step over them.
          (thread) =>
            section === "pinned" ||
            chatFolders === null ||
            chatFolders.folderKeyOf(thread) === null,
        ),
      });
    return new Map([
      ...sectionAvailability("pinned"),
      ...(workingShelfEnabled || grouping !== null ? [] : sectionAvailability("active")),
    ]);
  }, [
    threads,
    input.pendingOrder,
    input.pinReorderEnvironmentIds,
    input.activeReorderEnvironmentIds,
    layoutTime,
    input.settlementEnvironmentIds,
    input.snoozeEnvironmentIds,
    input.queuedThreadKeys,
    workingShelfEnabled,
    grouping,
    chatFolders,
  ]);
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
  // Filed chats list in their folders, which page their own older chats.
  const settledScopes = useMemo(
    () => scopes.map((scope) => ({ ...scope, folder: null })),
    [scopes],
  );
  const olderSettledShelf = useOlderSettledShelf({
    scopes: settledScopes,
    expanded: input.settledShelfExpanded,
    visibleCount: searching ? 0 : input.settledLimit,
  });
  const { isListed, unloadedCount } = olderSettledShelf;
  const scopedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          scopes.some(
            (scope) =>
              scope.environmentId === thread.environmentId &&
              (scope.projectIds === null || scope.projectIds.includes(thread.projectId)),
          ),
      ),
    [threads, scopes],
  );
  // Settled chats each folder shows, once the user asks it for older ones.
  const [folderTargets, setFolderTargets] = useState(NO_FOLDER_TARGETS);
  const folders = chatFolders?.folders ?? NO_FOLDERS;
  const folderShelves = useOlderSettledShelves(
    folders.map((folder) => {
      const target = folderTargets.get(folder.key);
      return {
        id: folder.key,
        scopes: scopes.map((scope) => ({ ...scope, folder: threadFolderKey(folder.label) })),
        expanded: folder.expanded && target !== undefined,
        visibleCount: searching ? 0 : (target ?? 0),
      };
    }),
  );
  const chatFolderOlder = useMemo(
    () =>
      new Map(
        folders.flatMap((folder, index) => {
          const shelf = folderShelves[index];
          if (shelf === undefined) return [];
          const older: ThreadListV2ChatFolderOlder = {
            isListed: shelf.isListed,
            unloadedCount: shelf.unloadedCount(scopedThreads),
            state: shelf.loading ? "loading" : shelf.failed ? "failed" : null,
          };
          return [[folder.key, older] as const];
        }),
      ),
    [folders, folderShelves, scopedThreads],
  );
  const layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder: input.pendingOrder,
        threads: threads.filter((thread) => thread.archivedAt === null),
        environmentId: input.environmentId,
        projectRefs: input.projectRefs,
        searchQuery: input.searchQuery,
        matchedThreadKeys: new Set(input.searchMatches.keys()),
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
        hiddenTaskThreadKeys: input.hiddenTaskThreadKeys,
        settledLimit: input.settledLimit,
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
        unloadedSettledCount: unloadedCount(scopedThreads),
      }),
    [
      input.pendingOrder,
      threads,
      input.environmentId,
      input.projectRefs,
      input.searchQuery,
      input.searchMatches,
      input.settlementEnvironmentIds,
      input.snoozeEnvironmentIds,
      input.queuedThreadKeys,
      input.hiddenTaskThreadKeys,
      input.settledLimit,
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
      scopedThreads,
    ],
  );
  useOlderSettledShelfGrowth([
    { shelf: olderSettledShelf, listedCount: layout.listedSettledThreads.length },
    ...folders.flatMap((folder, index) => {
      const shelf = folderShelves[index];
      return shelf === undefined
        ? []
        : [{ shelf, listedCount: layout.listedFolderSettledCounts.get(folder.key) ?? 0 }];
    }),
  ]);
  /** Lists a page more of a chat folder's older chats, and reads again what failed. */
  const showMoreInFolder = (folderKey: string, listedCount: number) => {
    folderShelves[folders.findIndex((folder) => folder.key === folderKey)]?.retry();
    setFolderTargets((current) =>
      new Map([...current].filter(([key]) => folders.some((folder) => folder.key === key))).set(
        folderKey,
        listedCount + THREAD_LIST_V2_SETTLED_PAGE_COUNT,
      ),
    );
  };
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
        workingCount: layout.workingCount,
        workingShelfExpanded: input.workingShelfExpanded,
        workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
        snoozedCount: layout.snoozedCount,
        snoozedShelfExpanded: input.snoozedShelfExpanded,
        snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
        settledCount: layout.settledCount,
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
    ],
  );
  return { layout, items, contentOnlyThreadKeys, olderSettledShelf, showMoreInFolder };
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
