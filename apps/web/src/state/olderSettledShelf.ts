import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isListedSettledThread,
  olderSettledFolderNames,
  settledShelfFrontier,
  sortOlderSettledScopes,
  unloadedOlderSettledCount,
  wantedOlderSettledPages,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";

const NO_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();
const NO_REQUESTS: ReadonlyMap<string, OlderSettledShelfRequest> = new Map();
const NO_SHELF: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> = new Map();

interface OlderSettledShelfRequest {
  readonly scopeKey: string;
  readonly pages: ReadonlyMap<EnvironmentId, number>;
}

export interface OlderSettledShelfInput {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** A collapsed shelf mounts no pages, so a reconnect reads none; expanding restores them. */
  readonly expanded: boolean;
  /** Rows the shelf shows; pages are read until it lists that many. */
  readonly visibleCount: number;
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
) {
  const [requested, setRequested] = useState(NO_REQUESTS);
  const shelfScopes = inputs.map((input) => prepareShelf(input, requested).shelfScopes);
  const loadedKey = JSON.stringify(
    shelfScopes.flatMap((scopes) => scopes.filter(({ pages }) => pages > 0)),
  );
  const shelves = useAtomValue(olderSettledThreads.shelvesAtom(shelfScopes));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the requested older settled pages into the thread family registry while shown
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

  const ids = new Set(inputs.map((input) => input.id));
  return inputs.map((input, index) => {
    const { scopes, scopeKey, pages, shelfScopes } = prepareShelf(input, requested);
    const shelf = shelves[index] ?? NO_SHELF;
    const olderOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.older ?? null;
    const pagesOf = (environmentId: EnvironmentId) => shelf.get(environmentId)?.pages;
    const frontier = settledShelfFrontier([...shelf.values()]);
    const loaded = shelfScopes.filter(({ pages }) => pages > 0);
    return {
      environments: shelf,
      visibleCount: input.expanded ? input.visibleCount : 0,
      pages,
      // Drops the requests of shelves no longer drawn, such as a deleted folder's.
      grow: (next: ReadonlyMap<EnvironmentId, number>) =>
        setRequested((current) =>
          new Map([...current].filter(([id]) => ids.has(id))).set(input.id, {
            scopeKey,
            pages: next,
          }),
        ),
      isListed: (thread: EnvironmentThreadShell) => isListedSettledThread(thread.source, frontier),
      /** Older settled threads in scope that are not local; add it to the local rows. */
      unloadedCount: (threads: ReadonlyArray<EnvironmentThreadShell>) =>
        unloadedOlderSettledCount({ olderSettled: olderOf, scopes, threads }),
      /** Folders that hold older settled threads in scope, for the folder list. */
      folderNames: olderSettledFolderNames({ olderSettled: olderOf, scopes }),
      /** Whether pages are mounted, so the rows they hold are listed. */
      hasPages: loaded.length > 0,
      loading: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "pending"),
      failed: loaded.some(({ scope }) => pagesOf(scope.environmentId)?.status === "failed"),
      retry: () => {
        for (const { scope, pages } of loaded) {
          olderSettledThreads.retryPages(appAtomRegistry, scope, pages);
        }
      },
    };
  });
}

/** The pages one shelf reads, from its scopes and the pages last requested for it. */
function prepareShelf(
  input: OlderSettledShelfInput & { readonly id: string },
  requested: ReadonlyMap<string, OlderSettledShelfRequest>,
) {
  const scopes = sortOlderSettledScopes(input.scopes);
  const scopeKey = JSON.stringify(scopes);
  const request = requested.get(input.id);
  const pages = request?.scopeKey === scopeKey && input.expanded ? request.pages : NO_PAGES;
  const shelfScopes = scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
  return { scopes, scopeKey, pages, shelfScopes };
}

/** One shelf of `useOlderSettledShelves`, such as the Settled shelf. */
export function useOlderSettledShelf(input: OlderSettledShelfInput): OlderSettledShelf {
  return useOlderSettledShelves([{ ...input, id: "" }])[0]!;
}

/** Reads the next pages while a shelf lists fewer rows than it shows. */
export function useOlderSettledShelfGrowth(
  shelves: ReadonlyArray<{ readonly shelf: OlderSettledShelf; readonly listedCount: number }>,
) {
  const growing = shelves.flatMap(({ shelf, listedCount }) => {
    const wanted = wantedOlderSettledPages({
      requested: shelf.pages,
      environments: shelf.environments,
      listedCount,
      visibleCount: shelf.visibleCount,
    });
    return wanted === shelf.pages ? [] : [{ grow: shelf.grow, wanted }];
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more older settled pages when the listed threads cannot fill the visible count
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
