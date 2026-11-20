import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { sortWorkingThreadsBySend } from "@t3tools/client-runtime/state/thread-inbox";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

const RECENT_THREAD_LIMIT = 5;

/** The sidebar's top-level threads the user last sent to; one shown under its parent stays there. */
export function selectRecentThreads<
  T extends Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "projectId"
    | "archivedAt"
    | "lineage"
    | "createdAt"
    | "latestUserMessageAt"
    | "latestUserAuthoredMessageAt"
  >,
>(threads: ReadonlyArray<T>, delegatedUnderParent: ReadonlySet<string>): T[] {
  return sortWorkingThreadsBySend(
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
  ).slice(0, RECENT_THREAD_LIMIT);
}
