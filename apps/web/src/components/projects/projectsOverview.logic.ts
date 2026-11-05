import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

export type ProjectThreadState = "attention" | "working" | "done" | "quiet";

export type ProjectsOverviewFilter = Exclude<ProjectThreadState, "quiet"> | "all";

type ProjectThreadStateInput = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenCompletion>[0];

/** What a thread asks of the user, with `lastVisitedAt` already resolved against local visits. */
export function resolveProjectThreadState(thread: ProjectThreadStateInput): ProjectThreadState {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
    case "input":
    case "request":
    case "limited":
    case "failed":
      return "attention";
    case "working":
      return "working";
    case "ready":
      return hasUnseenCompletion(thread) ? "done" : "quiet";
    case "waiting":
      return "quiet";
  }
}

export interface ProjectThreadCounts {
  readonly attention: number;
  readonly working: number;
  readonly done: number;
  readonly open: number;
}

export const EMPTY_PROJECT_THREAD_COUNTS: ProjectThreadCounts = {
  attention: 0,
  working: 0,
  done: 0,
  open: 0,
};

export function countProjectThreads<T>(
  threads: readonly T[],
  stateOf: (thread: T) => ProjectThreadState,
): ProjectThreadCounts {
  const counts = { attention: 0, working: 0, done: 0, quiet: 0 };
  for (const thread of threads) counts[stateOf(thread)] += 1;
  return {
    attention: counts.attention,
    working: counts.working,
    done: counts.done,
    open: threads.length,
  };
}

export function addProjectThreadCounts(
  left: ProjectThreadCounts,
  right: ProjectThreadCounts,
): ProjectThreadCounts {
  return {
    attention: left.attention + right.attention,
    working: left.working + right.working,
    done: left.done + right.done,
    open: left.open + right.open,
  };
}

export interface ProjectsSearch {
  readonly show?: Exclude<ProjectsOverviewFilter, "all">;
  readonly q?: string;
}

const MAX_PROJECTS_SEARCH_LENGTH = 200;

/** The page's filter and search live in its address, so going back returns to the same view. */
export function validateProjectsSearch(raw: Record<string, unknown>): ProjectsSearch {
  return {
    ...(raw.show === "attention" || raw.show === "working" || raw.show === "done"
      ? { show: raw.show }
      : {}),
    ...(typeof raw.q === "string" && raw.q.trim().length > 0
      ? { q: raw.q.slice(0, MAX_PROJECTS_SEARCH_LENGTH) }
      : {}),
  };
}

export function matchesProjectsOverviewFilter(
  state: ProjectThreadState,
  filter: ProjectsOverviewFilter,
): boolean {
  return filter === "all" || state === filter;
}

/** Folds case and accents so "codeship" finds "T3.CodeShip". */
export function matchesProjectSearch(name: string, query: string): boolean {
  const fold = (value: string) =>
    value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const needle = fold(query.trim());
  return needle.length === 0 || fold(name).includes(needle);
}
