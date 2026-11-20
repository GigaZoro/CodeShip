import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";

import { isSidebarHiddenThread } from "../Sidebar.logic";

const RECENT_THREAD_LIMIT = 5;

export function selectRecentThreads<
  T extends Pick<
    EnvironmentThreadShell,
    "id" | "archivedAt" | "lineage" | "createdAt" | "updatedAt" | "latestUserMessageAt"
  >,
>(threads: ReadonlyArray<T>): T[] {
  return sortThreads(
    threads.filter((thread) => thread.archivedAt === null && !isSidebarHiddenThread(thread)),
    "updated_at",
  ).slice(0, RECENT_THREAD_LIMIT);
}
