import { resolveThreadStatus } from "@t3tools/client-runtime/state/thread-status";
import { t } from "~/i18n";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { composerDraftHasUserContent } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { useProjects, useVisibleThreadShells } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import {
  hasUnseenCompletion,
  isSidebarHiddenThread,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { resolveThreadRowStatus, ThreadRowStatusContent } from "../sidebar/threadRowStatus";

const RECENT_THREAD_LIMIT = 5;

function selectRecentThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
  return threads
    .filter((thread) => thread.archivedAt === null && !isSidebarHiddenThread(thread))
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RECENT_THREAD_LIMIT);
}

function RecentThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projectName: string | null;
}) {
  const { thread } = props;
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const status = resolveThreadRowStatus({
    status: resolveThreadStatus(thread),
    goalActive: thread.goal?.status === "active",
    isWoke: false,
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
        }}
      >
        <span className="min-w-0 flex-1 truncate text-foreground">{thread.title}</span>
        {props.projectName === null ? null : (
          <span className="hidden max-w-[10rem] shrink-0 truncate text-muted-foreground text-xs sm:block">
            {props.projectName}
          </span>
        )}
        {status === null ? null : (
          <span className={cn("flex shrink-0 items-center gap-1 text-xs", status.className)}>
            <ThreadRowStatusContent status={status} iconClassName="size-3" />
          </span>
        )}
        <span className="w-16 shrink-0 whitespace-nowrap text-right text-muted-foreground text-xs tabular-nums">
          {formatRelativeTimeLabel(thread.updatedAt)}
        </span>
      </button>
    </li>
  );
}

/** Quick way back into recent work from an empty draft; gone once the user starts typing. */
export function DraftRecentThreads(props: { readonly draftTarget: ComposerThreadTarget }) {
  const hasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(props.draftTarget)),
  );
  const threads = useVisibleThreadShells(!hasDraftContent);
  const projects = useProjects();
  if (hasDraftContent) return null;
  const recent = selectRecentThreads(threads);
  if (recent.length === 0) return null;
  const projectNameByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title] as const),
  );
  return (
    <section aria-label={t("Recent threads")} className="pt-6">
      <h2 className="px-2 pb-1 font-medium text-muted-foreground text-xs">{t("Recent threads")}</h2>
      <ul>
        {recent.map((thread) => (
          <RecentThreadRow
            key={`${thread.environmentId}:${thread.id}`}
            thread={thread}
            projectName={
              projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
            }
          />
        ))}
      </ul>
    </section>
  );
}
