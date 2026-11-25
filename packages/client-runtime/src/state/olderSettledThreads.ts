import {
  isListedThreadLineage,
  isOlderSettledThreadShell,
  ORCHESTRATION_V2_WS_METHODS,
  threadFolderKey,
  threadFolderKeyOf,
  type EnvironmentId,
  type OrchestrationV2OlderSettledCursor,
  type OrchestrationV2OlderSettledFolderCount,
  type OrchestrationV2OlderSettledThreads,
  type OrchestrationV2OlderSettledThreadsPage,
  type OrchestrationV2SearchThreadsInput,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, selectEnvironmentQueryData } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { threadFamilyRead } from "./threadFamilies.ts";

// Rows per page of older settled threads: one "Show more" step of the Settled shelf.
const OLDER_SETTLED_PAGE_SIZE = 25;
// A burst of changes (a PR sync touching many old threads) costs one count read.
const COUNT_REREAD_DELAY = "500 millis";

/** A folder's older settled threads per project, and one spelling of its name. */
export interface OlderSettledFolder {
  readonly name: string;
  readonly counts: ReadonlyMap<ProjectId, number>;
}

/** Where an environment's shell cut settled threads, and how many are older per project. */
export interface OlderSettled {
  readonly before: string;
  readonly beforeMs: number;
  readonly counts: ReadonlyMap<ProjectId, number>;
  /** The filed ones by folder key, or null when the server cannot read older threads by folder. */
  readonly folders: ReadonlyMap<string, OlderSettledFolder> | null;
}

/** The scope's projects in one environment, or null for all of them. */
export interface OlderSettledScope {
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId> | null;
  /** Threads in this folder (its key), or in none when null; threads in any folder when absent. */
  readonly folder?: string | null;
}

/**
 * The pages read below an environment's cut. Everything at or above `frontier` is local: pages
 * hold the rows that were there when read, and shell deltas keep that range current. A null
 * frontier means there is no page to read.
 */
export interface OlderSettledPages {
  readonly reads: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly frontier: OrchestrationV2OlderSettledCursor | null;
  readonly status: "ready" | "pending" | "failed";
}

const NO_PAGES: OlderSettledPages = { reads: [], frontier: null, status: "ready" };

type OlderSettledRow = Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "folder"
>;

export interface OlderSettledShelfEnvironment {
  readonly older: OlderSettled | null;
  readonly pages: OlderSettledPages;
  /** Estimated older rows still missing, for display counts. */
  readonly unloaded: number;
}

/**
 * Scopes in one order, so a shelf keyed on them keeps its pages when the caller's project order
 * changes. Loading a page can reorder the sidebar's projects, which would otherwise drop the page.
 */
function sortOlderSettledScopes(
  scopes: ReadonlyArray<OlderSettledScope>,
): ReadonlyArray<OlderSettledScope> {
  return scopes
    .map((scope) => ({
      environmentId: scope.environmentId,
      projectIds: scope.projectIds === null ? null : [...scope.projectIds].sort(),
      ...(scope.folder === undefined ? {} : { folder: scope.folder }),
    }))
    .sort((left, right) => left.environmentId.localeCompare(right.environmentId));
}

/**
 * Changes whenever the older counts can: any removal (by largest sequence, so a repeat counts), an
 * older row that arrives, unsettles or moves to another project or folder. Threads created after the cut never
 * enter it, as threads settle after creation; archiving arrives as a removal.
 */
export function olderSettledCountKey(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  beforeMs: number,
  removedAt: ReadonlyMap<ThreadId, number>,
): string {
  let lastRemoval = 0;
  for (const sequence of removedAt.values()) lastRemoval = Math.max(lastRemoval, sequence);
  const rows: string[] = [];
  for (const thread of threads) {
    if (!isListedThreadLineage(thread.lineage)) continue;
    const older = isOlderSettledThreadShell(thread, beforeMs);
    if (older || DateTime.toEpochMillis(thread.createdAt) < beforeMs) {
      rows.push(
        JSON.stringify([
          thread.id,
          older,
          ...(older ? [thread.projectId, threadFolderKeyOf(thread.folder)] : []),
        ]),
      );
    }
  }
  return `${lastRemoval}|${rows.sort().join(",")}`;
}

interface OlderSettledShelfRequest {
  readonly scopeKey: string;
  readonly pages: ReadonlyMap<EnvironmentId, number>;
}

export type OlderSettledShelfRequests = ReadonlyMap<string, OlderSettledShelfRequest>;

export interface OlderSettledShelfRequestState {
  readonly requested: OlderSettledShelfRequests | undefined;
  readonly setRequested: (
    update: (current: OlderSettledShelfRequests) => OlderSettledShelfRequests,
  ) => void;
}

export const NO_OLDER_SETTLED_SHELF_REQUESTS: OlderSettledShelfRequests = new Map();

export interface OlderSettledViewTargets {
  readonly viewKey: string;
  readonly settled?: number;
  readonly folders?: ReadonlyMap<string, number>;
  readonly folderPages?: OlderSettledShelfRequests;
  readonly settledPages?: OlderSettledShelfRequests;
}

export function olderSettledViewRequestSetters(
  viewKey: string,
  setTargets: (update: (current: OlderSettledViewTargets) => OlderSettledViewTargets) => void,
) {
  const forShelf =
    (key: "folderPages" | "settledPages"): OlderSettledShelfRequestState["setRequested"] =>
    (update) =>
      setTargets((current) => {
        if (current.viewKey !== viewKey) return current;
        return { ...current, [key]: update(current[key] ?? NO_OLDER_SETTLED_SHELF_REQUESTS) };
      });
  return { folder: forShelf("folderPages"), settled: forShelf("settledPages") };
}

const NO_REQUESTED_PAGES: ReadonlyMap<EnvironmentId, number> = new Map();

export function prepareOlderSettledShelf(
  input: {
    readonly id: string;
    readonly scopes: ReadonlyArray<OlderSettledScope>;
    readonly expanded: boolean;
  },
  requested: OlderSettledShelfRequests,
) {
  const scopes = sortOlderSettledScopes(input.scopes);
  const scopeKey = JSON.stringify(scopes);
  const request = requested.get(input.id);
  const pages =
    input.expanded && request?.scopeKey === scopeKey ? request.pages : NO_REQUESTED_PAGES;
  const shelfScopes = scopes.map((scope) => ({
    scope,
    pages: pages.get(scope.environmentId) ?? 0,
  }));
  return { scopes, scopeKey, pages, shelfScopes };
}

export function setOlderSettledShelfRequest(
  current: OlderSettledShelfRequests,
  visibleShelfIds: ReadonlySet<string>,
  id: string,
  request: OlderSettledShelfRequest,
): OlderSettledShelfRequests {
  return new Map([...current].filter(([id]) => visibleShelfIds.has(id))).set(id, request);
}

/** Whether a row sits at or above a page cursor in the server's order (settle time desc, id asc). */
function atOrAboveCursor(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "settledAt">,
  cursor: OrchestrationV2OlderSettledCursor,
): boolean {
  if (thread.settledAt === null) return true;
  const settledAt = DateTime.formatIso(thread.settledAt);
  return !(
    settledAt < cursor.settledAt ||
    (cursor.threadId !== undefined && settledAt === cursor.settledAt && thread.id > cursor.threadId)
  );
}

export function hasMoreOlderSettledPages(pages: OlderSettledPages): boolean {
  return pages.frontier !== null && pages.status !== "failed";
}

/**
 * Where a shelf over these environments stops listing: the highest frontier of any environment
 * that can still load older threads (its cut until its first page). Rows below it could sort under
 * rows not loaded yet, so the merged list is a correct prefix even while a page loads. A failed
 * environment holds no one back; its Retry rejoins it.
 */
export function settledShelfFrontier(
  environments: ReadonlyArray<OlderSettledShelfEnvironment>,
): OrchestrationV2OlderSettledCursor | null {
  let highest: OrchestrationV2OlderSettledCursor | null = null;
  for (const { pages } of environments) {
    if (pages.frontier === null || pages.status === "failed") continue;
    const frontier = pages.frontier;
    // On a settle-time tie, a cursor with an id stops above one without, and a smaller id higher.
    if (
      highest === null ||
      frontier.settledAt > highest.settledAt ||
      (frontier.settledAt === highest.settledAt &&
        frontier.threadId !== undefined &&
        (highest.threadId === undefined || frontier.threadId < highest.threadId))
    ) {
      highest = frontier;
    }
  }
  return highest;
}

/**
 * Whether the Settled shelf may list a row: at or above the shelf's frontier. So a row that turns
 * older mid-session (a backdated auto-settle, a snooze that ends, an unarchive) waits for the
 * range that holds it.
 */
export function isListedSettledThread(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "settledAt">,
  frontier: OrchestrationV2OlderSettledCursor | null,
): boolean {
  return frontier === null || atOrAboveCursor(thread, frontier);
}

const listAllSettledThreads = () => true;
const predicatesByFrontier = new WeakMap<
  OrchestrationV2OlderSettledCursor,
  (thread: EnvironmentThreadShell) => boolean
>();

/** Keep the predicate stable so an unchanged frontier does not rebuild the rows of a list. */
export function settledShelfListPredicate(frontier: OrchestrationV2OlderSettledCursor | null) {
  if (frontier === null) return listAllSettledThreads;
  let predicate = predicatesByFrontier.get(frontier);
  if (predicate === undefined) {
    predicate = (thread) => atOrAboveCursor(thread.source, frontier);
    predicatesByFrontier.set(frontier, predicate);
  }
  return predicate;
}

/** Raw rows held before the cut, including those a shelf hides. */
function heldOlderSettledCounts(held: ReadonlyArray<OlderSettledRow>, beforeMs: number) {
  const counts = new Map<ProjectId, number>();
  const folders = new Map<string | null, Map<ProjectId, number>>();
  for (const thread of held) {
    if (!isOlderSettledThreadShell(thread, beforeMs)) continue;
    const { projectId } = thread;
    const folder = threadFolderKeyOf(thread.folder);
    let filed = folders.get(folder);
    if (filed === undefined) {
      filed = new Map();
      folders.set(folder, filed);
    }
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    filed.set(projectId, (filed.get(projectId) ?? 0) + 1);
  }
  return { counts, folders };
}

/**
 * Whether two holds of an environment's rows file the same older settled threads in the same
 * projects and folders. Streaming ticks replace rows in place, so most compare by reference.
 */
export function sameOlderSettledMembership(
  previous: ReadonlyArray<OlderSettledRow>,
  next: ReadonlyArray<OlderSettledRow>,
  beforeMs: number,
): boolean {
  if (previous.length !== next.length) return false;
  return next.every((row, index) => {
    const prior = previous[index]!;
    if (prior === row) return true;
    if (prior.id !== row.id) return false;
    const older = isOlderSettledThreadShell(row, beforeMs);
    if (older !== isOlderSettledThreadShell(prior, beforeMs)) return false;
    return (
      !older ||
      (prior.projectId === row.projectId &&
        threadFolderKeyOf(prior.folder) === threadFolderKeyOf(row.folder))
    );
  });
}

/**
 * Older settled threads in scope that this client does not hold: the server's counts minus the
 * older rows it has. Add it to the local rows for the Settled label or a project's thread count.
 */
export function unloadedOlderSettledCount(input: {
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  /** Every row the client holds in scope, in any section. */
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly source: OlderSettledRow;
  }>;
}): number {
  let unloaded = 0;
  for (const scope of input.scopes) {
    const older = input.olderSettled(scope.environmentId);
    if (older === null) continue;
    unloaded += unloadedInScope(
      scope,
      older,
      heldOlderSettledCounts(
        input.threads.flatMap((thread) =>
          thread.environmentId === scope.environmentId ? [thread.source] : [],
        ),
        older.beforeMs,
      ),
    );
  }
  return unloaded;
}

function countInProjects(
  counts: ReadonlyMap<ProjectId, number>,
  projectIds: ReadonlyArray<ProjectId> | null,
): number {
  let total = 0;
  if (projectIds === null) {
    for (const count of counts.values()) total += count;
  } else {
    for (const projectId of projectIds) total += counts.get(projectId) ?? 0;
  }
  return total;
}

function olderCountInScope(
  older: Pick<OlderSettled, "counts" | "folders">,
  projectIds: ReadonlyArray<ProjectId> | null,
  folder: string | null | undefined,
): number {
  if (older.folders === null || folder === undefined) {
    return folder == null ? countInProjects(older.counts, projectIds) : 0;
  }
  if (folder !== null) {
    const filed = older.folders.get(folder);
    return filed === undefined ? 0 : countInProjects(filed.counts, projectIds);
  }
  let total = countInProjects(older.counts, projectIds);
  for (const filed of older.folders.values()) total -= countInProjects(filed.counts, projectIds);
  return total;
}

function unloadedInScope(
  scope: OlderSettledScope,
  older: OlderSettled,
  held: ReturnType<typeof heldOlderSettledCounts>,
): number {
  const folder = older.folders === null ? undefined : scope.folder;
  const heldCounts = folder === undefined ? held.counts : held.folders.get(folder);
  return Math.max(
    0,
    olderCountInScope(older, scope.projectIds, scope.folder) -
      (heldCounts === undefined ? 0 : countInProjects(heldCounts, scope.projectIds)),
  );
}

/** Folders that hold older settled threads in scope, by one spelling each, for the folder list. */
export function olderSettledFolderNames(input: {
  readonly olderSettled: (environmentId: EnvironmentId) => OlderSettled | null;
  readonly scopes: ReadonlyArray<OlderSettledScope>;
}): ReadonlyArray<string> {
  const names = new Map<string, string>();
  for (const scope of input.scopes) {
    for (const [key, folder] of input.olderSettled(scope.environmentId)?.folders ?? []) {
      if (names.has(key)) continue;
      const filed =
        scope.projectIds === null
          ? folder.counts.size > 0
          : scope.projectIds.some((projectId) => (folder.counts.get(projectId) ?? 0) > 0);
      if (filed) names.set(key, folder.name);
    }
  }
  return [...names.values()];
}

/**
 * The `folder` a page read sends, or null when the server cannot read this scope: it ignores
 * `folder`, so the shelf in no folder reads every older thread there, and a folder reads none.
 */
function pageFolderInput(
  cut: OrchestrationV2OlderSettledThreads,
  folder: string | null | undefined,
): { readonly folder?: string | null } | null {
  if (folder === undefined) return {};
  if (cut.folderCounts !== undefined) return { folder };
  return folder === null ? {} : null;
}

function olderCountsOf(source: {
  readonly counts: OrchestrationV2OlderSettledThreadsPage["counts"];
  readonly folderCounts?: ReadonlyArray<OrchestrationV2OlderSettledFolderCount>;
}): Pick<OlderSettled, "counts" | "folders"> {
  const counts = new Map(source.counts.map(({ projectId, count }) => [projectId, count] as const));
  if (source.folderCounts === undefined) return { counts, folders: null };
  const folders = new Map<string, { name: string; counts: Map<ProjectId, number> }>();
  for (const { projectId, folder, count } of source.folderCounts) {
    const key = threadFolderKey(folder);
    const entry = folders.get(key) ?? { name: folder, counts: new Map() };
    entry.counts.set(projectId, (entry.counts.get(projectId) ?? 0) + count);
    folders.set(key, entry);
  }
  return { counts, folders };
}

/**
 * The pages each environment should read: while the shelf lists fewer than `visibleCount` rows,
 * one more for each environment whose frontier is the shelf's, once its pages have loaded.
 */
export function wantedOlderSettledPages(input: {
  readonly requested: ReadonlyMap<EnvironmentId, number>;
  readonly environments: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>;
  readonly listedCount: number;
  readonly visibleCount: number;
}): ReadonlyMap<EnvironmentId, number> {
  if (input.listedCount >= input.visibleCount) return input.requested;
  const frontier = settledShelfFrontier([...input.environments.values()]);
  if (frontier === null) return input.requested;
  let next: Map<EnvironmentId, number> | null = null;
  for (const [environmentId, { pages }] of input.environments) {
    if (pages.status !== "ready" || pages.frontier === null) continue;
    const requested = input.requested.get(environmentId) ?? 0;
    if (
      pages.frontier.settledAt !== frontier.settledAt ||
      pages.frontier.threadId !== frontier.threadId
    ) {
      continue;
    }
    next ??= new Map(input.requested);
    next.set(environmentId, requested + 1);
  }
  return next ?? input.requested;
}

/** Reveal another page of matches, requesting one step at the frontier if needed. */
export function planFilteredOlderSettledPress(input: {
  readonly requested: ReadonlyMap<EnvironmentId, number>;
  readonly environments: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>;
  readonly shownCount: number;
  readonly listedCount: number;
}) {
  const visibleCount = input.shownCount + OLDER_SETTLED_PAGE_SIZE;
  return { visibleCount, pages: wantedOlderSettledPages({ ...input, visibleCount }) };
}

export function hasMoreSettledMatches(
  hasMorePages: boolean,
  loadedCount: number,
  shownCount: number,
) {
  return hasMorePages || loadedCount > shownCount;
}

export function settledFooterHiddenCount(input: {
  readonly filtered: boolean;
  readonly hasMorePages: boolean;
  readonly hiddenLoaded: number;
  readonly displayCount: number;
}): number | null {
  if (!hasMoreSettledMatches(input.hasMorePages, input.hiddenLoaded, 0)) return 0;
  return input.filtered || input.displayCount <= 0 ? null : input.displayCount;
}

const countsByCut = new WeakMap<
  OrchestrationV2OlderSettledThreads,
  Pick<OlderSettled, "counts" | "folders">
>();

function snapshotOlderCounts(cut: OrchestrationV2OlderSettledThreads) {
  let counts = countsByCut.get(cut);
  if (counts === undefined) {
    counts = olderCountsOf(cut);
    countsByCut.set(cut, counts);
  }
  return counts;
}

/**
 * Shells that omit older settled threads (`omitOlderSettled`) name the cut and count what they left
 * out. These atoms keep those counts current and read older threads in pages for the Settled shelf.
 */
export function createOlderSettledThreadAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
  /** Every row the client holds for an environment, the ones a tag filter hides included. */
  heldThreadsAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlyArray<OlderSettledRow>>,
) {
  const shellStateValue = (state: AsyncResult.AsyncResult<EnvironmentShellState, E>) =>
    AsyncResult.getOrElse(state, () => null);

  const countReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-counts",
    staleTimeMs: Number.POSITIVE_INFINITY,
    // A newer key unmounts this read; with no idle time its wait is interrupted before the RPC.
    idleTtlMs: 0,
    execute: Effect.fn("OlderSettledThreads.readCounts")(function* (input: {
      readonly generation: number;
      readonly before: string;
      readonly key: string;
    }) {
      yield* Effect.sleep(COUNT_REREAD_DELAY);
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, {
        before: { settledAt: input.before },
        limit: 0,
      });
    }),
  });

  const pageReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-page",
    staleTimeMs: Number.POSITIVE_INFINITY,
    // A collapsed shelf keeps no read alive, as an idle one runs again when a reconnect replaces
    // the session.
    idleTtlMs: 0,
    execute: Effect.fn("OlderSettledThreads.readPage")(function* (input: {
      readonly generation: number;
      readonly projectIds: ReadonlyArray<ProjectId> | null;
      readonly folder?: string | null;
      readonly before: OrchestrationV2OlderSettledCursor;
    }) {
      return yield* request(ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads, {
        before: input.before,
        ...(input.projectIds === null ? {} : { projectIds: input.projectIds }),
        ...(input.folder === undefined ? {} : { folder: input.folder }),
        limit: OLDER_SETTLED_PAGE_SIZE,
      });
    }),
  });

  const olderSettledAtom = Atom.family((environmentId: EnvironmentId) => {
    let generation = -1;
    // The key of the first state seen this generation, when that state is the snapshot itself.
    let snapshotKey: string | null = null;
    let keyInputs: { readonly threads: unknown; readonly removedAt: unknown } | null = null;
    let key = "";
    let fromSnapshot: OlderSettled | null = null;
    let lastRead: OlderSettled | null = null;
    let lastReadPage: OrchestrationV2OlderSettledThreadsPage | null = null;
    return Atom.make((get): OlderSettled | null => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const cut = snapshot?.olderSettled;
      if (state === null || snapshot === null || cut === undefined) return null;
      if (fromSnapshot?.before !== cut.before || state.generation !== generation) {
        fromSnapshot = {
          before: cut.before,
          beforeMs: DateTime.toEpochMillis(DateTime.makeUnsafe(cut.before)),
          ...snapshotOlderCounts(cut),
        };
      }
      // Most shell updates move only the cursor; the key needs new rows or removals.
      if (keyInputs?.threads !== snapshot.threads || keyInputs.removedAt !== state.removedAt) {
        keyInputs = { threads: snapshot.threads, removedAt: state.removedAt };
        key = olderSettledCountKey(snapshot.threads, fromSnapshot.beforeMs, state.removedAt);
      }
      if (state.generation !== generation) {
        generation = state.generation;
        snapshotKey = snapshot.snapshotSequence === cut.asOfSequence ? key : null;
        lastRead = null;
        lastReadPage = null;
      }
      // Generation 0 is a cached shell: no reads until this session's first snapshot.
      if (key === snapshotKey || state.generation === 0) return fromSnapshot;
      const read = selectEnvironmentQueryData(
        get(
          countReadAtom({
            environmentId,
            input: { generation: state.generation, before: cut.before, key },
          }),
        ),
      );
      if (read !== null && read !== lastReadPage) {
        lastReadPage = read;
        lastRead = { ...fromSnapshot, ...olderCountsOf(read) };
      }
      return lastRead ?? fromSnapshot;
    }).pipe(Atom.withLabel(`environment-older-settled:${environmentId}`));
  });

  // JSON has no undefined, so the folder goes in a list that is empty when the scope has none.
  const pagesKey = (scope: OlderSettledScope, pages: number) =>
    JSON.stringify([
      scope.environmentId,
      scope.projectIds === null ? null : [...scope.projectIds].sort(),
      scope.folder === undefined ? [] : [scope.folder],
      pages,
    ]);

  const parsePagesKey = (key: string) =>
    JSON.parse(key) as [
      EnvironmentId,
      ReadonlyArray<ProjectId> | null,
      [] | [string | null],
      number,
    ];

  const pagesAtom = Atom.family((key: string) => {
    const [environmentId, projectIds, [folder], pages] = parsePagesKey(key);
    let previous = NO_PAGES;
    const keep = (next: OlderSettledPages): OlderSettledPages => {
      const same =
        next.status === previous.status &&
        next.frontier?.settledAt === previous.frontier?.settledAt &&
        next.frontier?.threadId === previous.frontier?.threadId &&
        (next.frontier === null) === (previous.frontier === null) &&
        next.reads.length === previous.reads.length &&
        next.reads.every((read, index) => read === previous.reads[index]);
      if (!same) previous = next;
      return previous;
    };
    return Atom.make((get) => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const cut = state === null ? undefined : Option.getOrNull(state.snapshot)?.olderSettled;
      // A cached shell (an environment not connected yet, or offline) must not hold the shelf
      // back for other environments, so it lists what it holds until its first snapshot.
      if (state === null || cut === undefined || state.generation === 0) return keep(NO_PAGES);
      const folderInput = pageFolderInput(cut, folder);
      if (
        folderInput === null ||
        olderCountInScope(snapshotOlderCounts(cut), projectIds, folder) === 0
      ) {
        return keep(NO_PAGES);
      }
      let frontier: OrchestrationV2OlderSettledCursor = { settledAt: cut.before };
      if (pages === 0) return keep({ reads: [], frontier, status: "ready" });
      const reads: OrchestrationV2ThreadFamily[] = [];
      for (let index = 0; index < pages; index += 1) {
        const result = get(
          pageReadAtom({
            environmentId,
            input: { generation: state.generation, projectIds, ...folderInput, before: frontier },
          }),
        );
        const page = selectEnvironmentQueryData(result);
        if (page === null) {
          return keep({
            reads,
            frontier,
            status: threadFamilyRead(result) === "failed" ? "failed" : "pending",
          });
        }
        reads.push(page);
        const last = page.threads.at(-1);
        if (page.threads.length < OLDER_SETTLED_PAGE_SIZE || last?.settledAt == null) {
          return keep({ reads, frontier: null, status: "ready" });
        }
        frontier = { settledAt: DateTime.formatIso(last.settledAt), threadId: last.id };
      }
      return keep({ reads, frontier, status: "ready" });
    }).pipe(Atom.withLabel(`environment-older-settled-pages:${key}`));
  });

  const heldCountsAtom = Atom.family((environmentId: EnvironmentId) => {
    const beforeMsAtom = Atom.map(olderSettledAtom(environmentId), (older) => older?.beforeMs);
    let previous: {
      readonly held: ReadonlyArray<OlderSettledRow>;
      readonly beforeMs: number;
      readonly counts: ReturnType<typeof heldOlderSettledCounts>;
    } | null = null;
    return Atom.make((get) => {
      const beforeMs = get(beforeMsAtom);
      if (beforeMs === undefined) return null;
      const held = get(heldThreadsAtom(environmentId));
      previous =
        previous !== null &&
        previous.beforeMs === beforeMs &&
        sameOlderSettledMembership(previous.held, held, beforeMs)
          ? { ...previous, held }
          : { held, beforeMs, counts: heldOlderSettledCounts(held, beforeMs) };
      return previous.counts;
    }).pipe(Atom.withLabel(`environment-held-older-settled-counts:${environmentId}`));
  });

  const displayUnloadedAtom = Atom.family((key: string) => {
    const [environmentId, projectIds, [folder]] = parsePagesKey(key);
    const scope: OlderSettledScope = {
      environmentId,
      projectIds,
      ...(folder === undefined ? {} : { folder }),
    };
    return Atom.make((get) => {
      const older = get(olderSettledAtom(environmentId));
      if (older === null) return 0;
      const pages = get(pagesAtom(key));
      if (pages.reads.length > 0 && pages.frontier === null) return 0;
      const held = get(heldCountsAtom(environmentId));
      return held === null ? 0 : unloadedInScope(scope, older, held);
    }).pipe(Atom.withLabel(`environment-older-settled-unloaded:${key}`));
  });

  const pageRowsAtom = Atom.family((key: string) =>
    Atom.map(pagesAtom(key), (pages) => pages.reads).pipe(
      Atom.withLabel(`environment-older-settled-page-rows:${key}`),
    ),
  );

  const searchGenerationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): number | "waiting" | "none" => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      if (state !== null && state.generation > 0) return state.generation;
      return state?.status === "synchronizing" ? "waiting" : "none";
    }),
  );
  const searchReadAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:older-settled-search",
    staleTimeMs: 0,
    idleTtlMs: 0,
    execute: Effect.fn("OlderSettledThreads.search")(function* (input: {
      readonly generation: number;
      readonly search: OrchestrationV2SearchThreadsInput;
    }) {
      return yield* request(ORCHESTRATION_V2_WS_METHODS.searchThreads, input.search);
    }),
  });
  // Keyed by shell generation like pages: rows read before a new snapshot do not merge, so the
  // search reads them again.
  const searchAtom = Atom.family((key: string) => {
    const [environmentId, search] = JSON.parse(key) as [
      EnvironmentId,
      OrchestrationV2SearchThreadsInput,
    ];
    return Atom.make((get) => {
      const generation = get(searchGenerationAtom(environmentId));
      // Nothing is read before this session's first snapshot, which would drop the rows. It shows
      // as loading only while that snapshot is on its way, so an offline environment never spins.
      return typeof generation === "number"
        ? get(searchReadAtom({ environmentId, input: { generation, search } }))
        : AsyncResult.initial(generation === "waiting");
    }).pipe(Atom.withLabel(`environment-older-settled-search:${key}`));
  });

  const shelfKey = (
    scopes: ReadonlyArray<{ readonly scope: OlderSettledScope; readonly pages: number }>,
  ) =>
    JSON.stringify(
      scopes.map(({ scope, pages }) => [scope.environmentId, pagesKey(scope, pages)] as const),
    );

  // One read for a shelf that spans environments: each one's cut, counts, pages and unloaded rows.
  const shelfAtom = Atom.family((key: string) => {
    const entries = JSON.parse(key) as ReadonlyArray<readonly [string, string]>;
    let previous: ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> = new Map();
    return Atom.make((get): ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment> => {
      const shelf = new Map<EnvironmentId, OlderSettledShelfEnvironment>();
      let changed = previous.size !== entries.length;
      for (const [environmentId, pagesKey] of entries) {
        const older = get(olderSettledAtom(environmentId as EnvironmentId));
        const pages = get(pagesAtom(pagesKey));
        const unloaded = get(displayUnloadedAtom(pagesKey));
        const prior = previous.get(environmentId as EnvironmentId);
        changed ||= prior?.older !== older || prior.pages !== pages || prior.unloaded !== unloaded;
        shelf.set(environmentId as EnvironmentId, { older, pages, unloaded });
      }
      if (changed) previous = shelf;
      return previous;
    }).pipe(Atom.withLabel(`environment-older-settled-shelf:${key}`));
  });

  // Shelves a list draws as many of as it has folders, in one read.
  const shelvesAtom = Atom.family((key: string) => {
    const keys = JSON.parse(key) as ReadonlyArray<string>;
    let previous: ReadonlyArray<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>> = [];
    return Atom.make((get) => {
      const shelves = keys.map((shelf) => get(shelfAtom(shelf)));
      if (
        shelves.length !== previous.length ||
        shelves.some((shelf, index) => shelf !== previous[index])
      ) {
        previous = shelves;
      }
      return previous;
    }).pipe(Atom.withLabel(`environment-older-settled-shelves:${key}`));
  });

  /** Reads a failed page again (a no-op when none failed); the pages after it follow. */
  const retryPages = (
    registry: AtomRegistry.AtomRegistry,
    scope: OlderSettledScope,
    pages: number,
  ) => {
    const state = shellStateValue(registry.get(shellStateAtom(scope.environmentId)));
    const cut = state === null ? undefined : Option.getOrNull(state.snapshot)?.olderSettled;
    const result = registry.get(pagesAtom(pagesKey(scope, pages)));
    if (state === null || cut === undefined || result.status !== "failed") return;
    const folderInput = pageFolderInput(cut, scope.folder);
    if (folderInput === null || result.frontier === null) return;
    registry.refresh(
      pageReadAtom({
        environmentId: scope.environmentId,
        input: {
          generation: state.generation,
          projectIds: scope.projectIds === null ? null : [...scope.projectIds].sort(),
          ...folderInput,
          before: result.frontier,
        },
      }),
    );
  };

  return {
    /** The environment's cut and current counts, or null when its shell keeps every settled thread. */
    olderSettledAtom,
    /** Each scope's cut, counts, first `pages` pages and older threads not held. */
    shelfAtom: (
      scopes: ReadonlyArray<{ readonly scope: OlderSettledScope; readonly pages: number }>,
    ) => shelfAtom(shelfKey(scopes)),
    /** Several shelves at once, in order, such as one per folder. */
    shelvesAtom: (
      shelves: ReadonlyArray<
        ReadonlyArray<{ readonly scope: OlderSettledScope; readonly pages: number }>
      >,
    ) => shelvesAtom(JSON.stringify(shelves.map(shelfKey))),
    retryPages,
    /** The first `pages` pages below the cut for one scope, read in order. */
    pagesAtom: (scope: OlderSettledScope, pages: number) => pagesAtom(pagesKey(scope, pages)),
    /** Their rows, for `createThreadFamilyAtoms(...).mountRows`, under `rowsKey`. */
    pageRowsAtom: (scope: OlderSettledScope, pages: number) => pageRowsAtom(pagesKey(scope, pages)),
    rowsKey: (scope: OlderSettledScope, pages: number) => `older-settled:${pagesKey(scope, pages)}`,
    /** `orchestration.searchThreads` for a search that asks for older settled rows. */
    searchAtom: (environmentId: EnvironmentId, search: OrchestrationV2SearchThreadsInput) =>
      searchAtom(JSON.stringify([environmentId, search])),
  };
}
