import {
  EnvironmentId,
  ORCHESTRATION_V2_ARCHIVED_THREADS_PAGE_DEFAULT,
  type OrchestrationProjectShell,
  type OrchestrationV2ArchivedShellSnapshot,
  type OrchestrationV2ArchivedThreadsCursor,
  type OrchestrationV2GetArchivedShellSnapshotInput,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { threadSearchPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";

import { threadKey } from "./entities.ts";
import { hiddenThreadKeys, type TagFilteredEnvironment } from "./threadTagFilter.ts";
import { t } from "@t3tools/shared/i18n";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  /** Per environment, the loaded threads that come before any row a later page could precede. */
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  /** Another page would show more; read it with a view one page longer. */
  readonly hasMore: boolean;
}

export type ArchivedThreadsOrder = "newest" | "oldest";

export interface ArchivedThreadsView {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly query?: string | undefined;
  /** Per environment id; an environment without an entry lists every project. */
  readonly projectIds?: Readonly<Record<string, ReadonlyArray<ProjectId>>> | undefined;
  readonly order?: ArchivedThreadsOrder | undefined;
  /** Pages read per environment, at least one. */
  readonly pages?: number | undefined;
  /** Only this thread's archived family, unpaged. */
  readonly familyOf?: ThreadId | undefined;
}

interface NormalizedView {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly query: string;
  readonly projectIds: Readonly<Record<string, ReadonlyArray<ProjectId>>>;
  readonly order: ArchivedThreadsOrder;
  readonly pages: number;
  readonly familyOf: ThreadId | null;
}

export function makeArchivedThreadsViewKey(view: ArchivedThreadsView): string {
  const environmentIds = [...view.environmentIds].sort();
  const normalized: NormalizedView = {
    environmentIds,
    query: view.query?.trim() ?? "",
    projectIds: Object.fromEntries(
      environmentIds.flatMap((environmentId) => {
        const projectIds = view.projectIds?.[environmentId];
        return projectIds === undefined ? [] : [[environmentId, [...projectIds].sort()]];
      }),
    ),
    order: view.order ?? "newest",
    pages: Math.max(1, view.pages ?? 1),
    familyOf: view.familyOf ?? null,
  };
  return JSON.stringify(normalized);
}

/** The request for one environment's page after `after`, keyed the same for the same page. */
function archivedThreadsPageInput(
  view: NormalizedView,
  environmentId: EnvironmentId,
  after: OrchestrationV2ArchivedThreadsCursor | undefined,
): OrchestrationV2GetArchivedShellSnapshotInput {
  if (view.familyOf !== null) return { familyOf: view.familyOf };
  const projectIds = view.projectIds[environmentId];
  return {
    limit: ORCHESTRATION_V2_ARCHIVED_THREADS_PAGE_DEFAULT,
    ...(view.order === "newest" ? {} : { order: view.order }),
    ...(view.query.length === 0 ? {} : { query: view.query }),
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(after === undefined ? {} : { after }),
  };
}

interface ArchiveRowKey {
  readonly archivedAtMs: number;
  readonly threadId: string;
}

/** The server's archive order: newest first, ties by id; `oldest` is its exact reverse. */
function compareArchiveRows(left: ArchiveRowKey, right: ArchiveRowKey): number {
  if (left.archivedAtMs !== right.archivedAtMs) return right.archivedAtMs - left.archivedAtMs;
  return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
}

function archiveRowKey(thread: OrchestrationV2ThreadShell): ArchiveRowKey {
  return {
    archivedAtMs: thread.archivedAt === null ? 0 : DateTime.toEpochMillis(thread.archivedAt),
    threadId: thread.id,
  };
}

function cursorRowKey(cursor: OrchestrationV2ArchivedThreadsCursor): ArchiveRowKey {
  return { archivedAtMs: Date.parse(cursor.archivedAt), threadId: cursor.threadId };
}

/** What a server answering every archived thread at once leaves to the client. */
function filterLegacyPage(
  page: OrchestrationV2ArchivedShellSnapshot,
  view: NormalizedView,
  environmentId: EnvironmentId,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  if (view.familyOf !== null) return page.threads;
  const projectIds = view.projectIds[environmentId];
  const projectTitles = new Map(page.projects.map((project) => [project.id, project.title]));
  const query = foldSearchQuery(view.query);
  return page.threads.filter(
    (thread) =>
      (projectIds === undefined || projectIds.includes(thread.projectId)) &&
      (query.length === 0 ||
        scoreThreadSearch(
          query,
          {
            id: thread.id,
            title: thread.title,
            branch: thread.branch,
            projectTitle: projectTitles.get(thread.projectId) ?? null,
            pullRequests: threadSearchPullRequests(thread),
            activityAt: null,
          },
          0,
          { picks: false },
        ) !== null),
  );
}

interface EnvironmentPages {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly snapshotSequence: number;
  readonly schemaVersion: number;
  /** The last loaded row, when more pages follow it. */
  readonly frontier: ArchiveRowKey | null;
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getPageAtom: (
    environmentId: EnvironmentId,
    input: OrchestrationV2GetArchivedShellSnapshotInput,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly hiddenThreadTagsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<string> | null>;
  /** Live threads the tag filter hides, so archived children of hidden parents stay hidden. */
  readonly hiddenThreadKeysAtom: Atom.Atom<ReadonlySet<string>>;
  /** Live threads, so archived children of loaded, visible parents stay visible. */
  readonly liveThreadRefsAtom: Atom.Atom<ReadonlyArray<ScopedThreadRef>>;
  /** Whether any connected environment hides tags, including ones outside this archive's scope. */
  readonly anyEnvironmentHidingAtom: Atom.Atom<boolean>;
  readonly labelPrefix: string;
}) {
  return Atom.family((viewKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const view = JSON.parse(viewKey) as NormalizedView;
      const loaded: EnvironmentPages[] = [];
      const environments: TagFilteredEnvironment[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of view.environmentIds) {
        const projects = new Map<string, OrchestrationProjectShell>();
        const threads = new Map<string, OrchestrationV2ThreadShell>();
        let after: OrchestrationV2ArchivedThreadsCursor | undefined;
        let frontier: ArchiveRowKey | null = null;
        let last: OrchestrationV2ArchivedShellSnapshot | null = null;
        // Each page starts where the one before it ended, so they are read in turn.
        for (let index = 0; index < view.pages; index++) {
          const result = get(
            options.getPageAtom(
              environmentId,
              archivedThreadsPageInput(view, environmentId, after),
            ),
          );
          isLoading ||= result.waiting;
          if (error === null && result._tag === "Failure") {
            error = t("Failed to load archived threads.");
          }
          const page = AsyncResult.getOrElse(result, () => null);
          if (page === null) break;
          last = page;
          for (const project of page.projects) projects.set(project.id, project);
          const legacy = page.nextCursor === undefined;
          for (const thread of legacy
            ? filterLegacyPage(page, view, environmentId)
            : page.threads) {
            if (!threads.has(thread.id)) threads.set(thread.id, thread);
          }
          frontier =
            page.nextCursor === undefined || page.nextCursor === null
              ? null
              : cursorRowKey(page.nextCursor);
          if (frontier === null || view.familyOf !== null) break;
          after = page.nextCursor ?? undefined;
        }
        if (last !== null) {
          loaded.push({
            environmentId,
            projects: [...projects.values()],
            threads: [...threads.values()],
            snapshotSequence: last.snapshotSequence,
            schemaVersion: last.schemaVersion,
            frontier,
          });
        }
        // A page that has not arrived still counts, so its tags apply to children elsewhere.
        environments.push({
          environmentId,
          threads: [...threads.values()],
          hiddenTags: get(options.hiddenThreadTagsAtom(environmentId)),
        });
      }

      // A machine with more pages may still hold rows that sort before another machine's
      // loaded rows, so only rows up to the earliest such frontier show.
      const sign = view.order === "oldest" ? -1 : 1;
      const compare = (left: ArchiveRowKey, right: ArchiveRowKey) =>
        sign * compareArchiveRows(left, right);
      const cutoff = loaded.reduce<ArchiveRowKey | null>(
        (earliest, { frontier }) =>
          frontier === null || (earliest !== null && compare(earliest, frontier) <= 0)
            ? earliest
            : frontier,
        null,
      );

      // One pass over every environment's pages, so archived tasks follow parents archived
      // elsewhere. Any connected machine may hide an unloaded parent, so the global flag decides.
      const hidingAnywhere = get(options.anyEnvironmentHidingAtom);
      const hidden = hiddenThreadKeys(
        environments,
        get(options.hiddenThreadKeysAtom),
        hidingAnywhere ? new Set(get(options.liveThreadRefsAtom).map(threadKey)) : undefined,
        hidingAnywhere,
      );
      const snapshots = loaded.map((entry): ArchivedSnapshotEntry => ({
        environmentId: entry.environmentId,
        snapshot: {
          schemaVersion: entry.schemaVersion,
          snapshotSequence: entry.snapshotSequence,
          projects: entry.projects,
          threads: entry.threads.filter(
            (thread) =>
              (cutoff === null || compare(archiveRowKey(thread), cutoff) <= 0) &&
              !hidden.has(threadKey({ environmentId: entry.environmentId, threadId: thread.id })),
          ),
        },
      }));
      return { snapshots, error, isLoading, hasMore: cutoff !== null };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${viewKey}`)),
  );
}
