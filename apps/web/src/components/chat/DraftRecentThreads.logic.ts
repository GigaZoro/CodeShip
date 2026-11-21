import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  resolveThreadWorkingStartedAt,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { threadLastSendAt } from "@t3tools/client-runtime/state/thread-inbox";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

export const DRAFT_RECENT_THREAD_LIMIT = 5;

type DraftRecentThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "archivedAt"
  | "lineage"
  | "createdAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
  | "runtime"
  | "latestRun"
>;

export interface DraftRecentThreads<T> {
  readonly needsYou: readonly T[];
  /** Every thread waiting on the user, so the list can say how many it leaves out. */
  readonly needsYouCount: number;
  readonly recent: readonly T[];
}

const threadKey = (thread: Pick<DraftRecentThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const isRunning = (thread: DraftRecentThread) => threadRuntimeIsActive(thread.runtime);
// Neither key moves with streamed output, so threads running side by side keep their places.
const lastActivity = (thread: DraftRecentThread) => {
  const startedAt = isRunning(thread) ? resolveThreadWorkingStartedAt(thread) : null;
  return startedAt === null ? threadLastSendAt(thread) : Date.parse(startedAt);
};
// A running thread is active now, so it ranks ahead of threads the user sent to after its work began.
const byRecentActivity = (left: DraftRecentThread, right: DraftRecentThread) =>
  Number(isRunning(right)) - Number(isRunning(left)) || lastActivity(right) - lastActivity(left);

/**
 * What an empty draft offers: the threads waiting on the user, in the order the sidebar's Needs
 * you lists them, then the running threads, latest started first, and the threads the sidebar
 * lists that the user last sent to, together no more than the limit.
 */
export function selectDraftRecentThreads<T extends DraftRecentThread>(
  threads: readonly T[],
  options: {
    /** What needs the user now, longest wait first, as the sidebar collects it. */
    readonly waiting: readonly T[];
    readonly later: readonly T[];
    readonly hiddenTaskThreadKeys: ReadonlySet<string>;
    readonly delegatedUnderParent: ReadonlySet<string>;
    /** The sidebar's project and machine scope; Needs you ignores it, as the sidebar's does. */
    readonly scopedProjectKeys: ReadonlySet<string> | null;
  },
): DraftRecentThreads<T> {
  const needsYou = options.waiting.slice(0, DRAFT_RECENT_THREAD_LIMIT);
  const needsYouCount = options.waiting.length;
  if (needsYou.length === DRAFT_RECENT_THREAD_LIMIT) return { needsYou, needsYouCount, recent: [] };
  const waitingKeys = new Set(options.waiting.map(threadKey));
  const recent = filterSidebarV2VisibleThreads(
    threads,
    options.scopedProjectKeys,
    options.delegatedUnderParent,
    {
      hiddenKeys: options.hiddenTaskThreadKeys,
      needsYouKeys: new Set([...waitingKeys, ...options.later.map(threadKey)]),
    },
  )
    .filter((thread) => !waitingKeys.has(threadKey(thread)))
    .toSorted(byRecentActivity)
    .slice(0, DRAFT_RECENT_THREAD_LIMIT - needsYou.length);
  return { needsYou, needsYouCount, recent };
}
