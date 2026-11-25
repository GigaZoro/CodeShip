import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  settledShelfListPredicate,
  hasMoreOlderSettledPages,
  olderSettledFolderNames,
  planFilteredOlderSettledPress,
  settledShelfFrontier,
  NO_OLDER_SETTLED_SHELF_REQUESTS,
  prepareOlderSettledShelf,
  setOlderSettledShelfRequest,
  type OlderSettledShelfRequestState,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettled,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "./atom-registry";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_OLDER_SETTLED: Atom.Atom<OlderSettled | null> = Atom.make(null);
const NO_SHELF: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> = new Map();

export interface OlderSettledShelfInput {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
  readonly searching?: boolean;
  /** A status or tag filter picks the rows, so only a press requests a page. */
  readonly filtered: boolean;
}

export type OlderSettledShelf = ReturnType<typeof useOlderSettledShelves>[number];

/**
 * Shelves of older settled threads when shells leave them out, such as the Settled shelf and one
 * per folder: which rows each may list, how many threads it holds in all, and the pages read below
 * each environment's cut, whose rows merge into the thread list. `useOlderSettledShelfGrowth`
 * reads the next pages. A shelf keeps its pages by its `id`.
 */
export function useOlderSettledShelves(
  inputs: ReadonlyArray<OlderSettledShelfInput & { readonly id: string }>,
  requestState?: OlderSettledShelfRequestState,
) {
  const [localRequests, setLocalRequests] = useState(NO_OLDER_SETTLED_SHELF_REQUESTS);
  const requested = requestState
    ? (requestState.requested ?? NO_OLDER_SETTLED_SHELF_REQUESTS)
    : localRequests;
  const setRequested = requestState?.setRequested ?? setLocalRequests;
  const prepared = useMemo(
    () => inputs.map((input) => prepareOlderSettledShelf(input, requested)),
    [inputs, requested],
  );
  const shelfScopes = prepared.map((shelf) => shelf.shelfScopes);
  const loadedKey = JSON.stringify(
    shelfScopes.flatMap((scopes) => scopes.filter(({ pages }) => pages > 0)),
  );
  const shelves = useAtomValue(olderSettledThreads.shelvesAtom(shelfScopes));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts older settled thread pages into the shared thread registry while the shelf shows them
  useEffect(() => {
    const loaded = JSON.parse(loadedKey) as ReadonlyArray<{
      readonly scope: OlderSettledScope;
      readonly pages: number;
    }>;
    const releases = loaded.map(({ scope, pages }) =>
      threadFamilies.mountRows(
        appAtomRegistry,
        scope.environmentId,
        olderSettledThreads.rowsKey(scope, pages),
        olderSettledThreads.pageRowsAtom(scope, pages),
      ),
    );
    return () => {
      for (const release of releases) release();
    };
  }, [loadedKey]);

  return useMemo(() => {
    const ids = new Set(inputs.map((input) => input.id));
    return inputs.map((input, index) => {
      const { scopes, scopeKey, pages, shelfScopes } = prepared[index]!;
      const shelf = shelves[index] ?? NO_SHELF;
      const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
      const pagesOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.pages;
      const frontier = settledShelfFrontier([...shelf.values()]);
      const loaded = shelfScopes.filter(({ pages }) => pages > 0);
      const grow = (next: ReadonlyMap<EnvironmentId, number>) =>
        setRequested((current) =>
          setOlderSettledShelfRequest(current, ids, input.id, { scopeKey, pages: next }),
        );
      return {
        environments: shelf,
        visibleCount: input.expanded && !input.searching ? input.visibleCount : 0,
        filtered: input.filtered,
        pages,
        grow,
        showMoreFiltered: (shownCount: number, listedCount: number) => {
          const next = planFilteredOlderSettledPress({
            requested: pages,
            environments: shelf,
            shownCount,
            listedCount,
          });
          if (next.pages !== pages) grow(next.pages);
          return next.visibleCount;
        },
        hasMorePages: [...shelf.values()].some(({ pages }) => hasMoreOlderSettledPages(pages)),
        isListed: settledShelfListPredicate(frontier),
        /** Older settled threads in scope that are not local; add it to the local rows. */
        unloadedCount: [...shelf.values()].reduce((total, { unloaded }) => total + unloaded, 0),
        /** Folders that hold older settled threads in scope, for the folder list. */
        folderNames: olderSettledFolderNames({ olderSettled: olderOf, scopes }),
        /** Whether pages are mounted, so the rows they hold are listed. */
        hasPages: loaded.length > 0,
        loading: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "pending"),
        failed: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "failed"),
        retry: () => {
          for (const { scope, pages } of loaded) {
            if (pagesOf(scope.environmentId)?.status === "failed")
              olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
          }
        },
      };
    });
  }, [inputs, prepared, shelves, setRequested]);
}

/** One shelf of `useOlderSettledShelves`, such as the Settled shelf. */
export function useOlderSettledShelf(
  input: OlderSettledShelfInput,
  requestState?: OlderSettledShelfRequestState,
): OlderSettledShelf {
  return useOlderSettledShelves([{ ...input, id: "" }], requestState)[0]!;
}

/** Reads the next pages while a shelf lists fewer rows than it shows. */
export function useOlderSettledShelfGrowth(
  shelves: ReadonlyArray<{ readonly shelf: OlderSettledShelf; readonly listedCount: number }>,
) {
  const growing = shelves.flatMap(({ shelf, listedCount }) => {
    if (shelf.filtered) return [];
    const wanted = wantedOlderSettledPages({
      requested: shelf.pages,
      environments: shelf.environments,
      listedCount,
      visibleCount: shelf.visibleCount,
    });
    return wanted === shelf.pages ? [] : [{ grow: shelf.grow, wanted }];
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more shelf pages when the loaded rows list fewer threads than the shelf shows
  useEffect(() => {
    for (const { grow, wanted } of growing) grow(wanted);
  }, [growing]);
}

/**
 * Threads of these projects that this client does not hold (older settled threads), for counts
 * shown outside the shelf, such as a removal confirm.
 */
export function readUnloadedThreadCount(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): number {
  return unloadedOlderSettledCount({
    olderSettled: (environmentId) =>
      appAtomRegistry.get(olderSettledThreads.olderSettledAtom(environmentId)),
    scopes: [...new Set(members.map((member) => member.environmentId))].map((environmentId) => ({
      environmentId,
      projectIds: members.flatMap((member) =>
        member.environmentId === environmentId ? [member.id] : [],
      ),
    })),
    threads: threads.filter((thread) =>
      members.some(
        (member) => member.environmentId === thread.environmentId && member.id === thread.projectId,
      ),
    ),
  });
}

/** How many older settled threads one project has, loaded or not, kept current for render. */
export function useOlderSettledCount(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): number {
  const older = useAtomValue(
    project === null
      ? NO_OLDER_SETTLED
      : olderSettledThreads.olderSettledAtom(project.environmentId),
  );
  return project === null ? 0 : (older?.counts.get(project.id) ?? 0);
}
