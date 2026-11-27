import { useAtomValue } from "@effect/atom-react";
import { threadLastSendAt } from "@t3tools/client-runtime/state/thread-inbox";
import { resolveThreadStatus } from "@t3tools/client-runtime/state/thread-status";
import { t, tn } from "~/i18n";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { composerDraftHasUserContent } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useSidebarScopedProjectKeys } from "~/hooks/useSidebarProjectGroups";
import { useThreadStall } from "~/hooks/useThreadStall";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { environmentThreadShells, hiddenScheduledTaskThreadKeysAtom } from "~/state/threads";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useUiStateStore } from "~/uiStateStore";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { resolveThreadRowStatus, ThreadRowStatusContent } from "../sidebar/threadRowStatus";
import { selectDraftRecentThreads } from "./DraftRecentThreads.logic";

// Keyed like the sidebar's, so both read one family entry; a config change that keeps the
// environments does not re-render the list.
const draftHiddenTaskThreadKeysAtom = Atom.make((get) =>
  get(
    hiddenScheduledTaskThreadKeysAtom(
      JSON.stringify([...get(environmentPresentations.serverConfigsAtom).keys()]),
    ),
  ),
);

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
  const nowMinute = useNowMinute();
  const stall = useThreadStall(thread);
  const status = resolveThreadRowStatus({
    status: resolveThreadStatus(thread),
    goalActive: thread.goal?.status === "active",
    isWoke: false,
    isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
    stalled: stall !== null,
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
          {formatRelativeTimeLabel(
            new Date(threadLastSendAt(thread)).toISOString(),
            Date.parse(`${nowMinute}:00.000Z`),
          )}
        </span>
      </button>
    </li>
  );
}

function ThreadSection(props: {
  readonly title: string;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly projectNameOf: (thread: EnvironmentThreadShell) => string | null;
  readonly children?: ReactNode;
}) {
  return (
    <section aria-label={props.title} className="pt-6">
      <h2 className="px-2 pb-1 font-medium text-muted-foreground text-xs">{props.title}</h2>
      <ul>
        {props.threads.map((thread) => (
          <RecentThreadRow
            key={`${thread.environmentId}:${thread.id}`}
            thread={thread}
            projectName={props.projectNameOf(thread)}
          />
        ))}
        {props.children}
      </ul>
    </section>
  );
}

/** Quick way back into waiting and recent work from an empty draft; gone once the user types. */
export function DraftRecentThreads(props: { readonly draftTarget: ComposerThreadTarget }) {
  const hasDraftContent = useComposerDraftStore((store) =>
    composerDraftHasUserContent(store.getComposerDraft(props.draftTarget)),
  );
  return hasDraftContent ? null : <DraftRecentThreadLists />;
}

function DraftRecentThreadLists() {
  const threads = useQuietThreadShells();
  const { threads: waiting, later } = useAtomValue(environmentThreadShells.needsYouThreadsAtom);
  const hiddenTaskThreadKeys = useAtomValue(draftHiddenTaskThreadKeysAtom);
  const delegatedUnderParent = useDelegatedUnderParent();
  const scopedProjectKeys = useSidebarScopedProjectKeys();
  const projects = useProjects();
  const lists = selectDraftRecentThreads(threads, {
    waiting,
    later,
    delegatedUnderParent,
    hiddenTaskThreadKeys,
    scopedProjectKeys,
  });
  const projectNameByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title] as const),
  );
  const projectNameOf = (thread: EnvironmentThreadShell) =>
    projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
  const moreNeedYou = lists.needsYouCount - lists.needsYou.length;
  return (
    <>
      {lists.needsYou.length === 0 ? null : (
        <ThreadSection
          title={t("Needs you")}
          threads={lists.needsYou}
          projectNameOf={projectNameOf}
        >
          {moreNeedYou > 0 ? (
            <li className="px-2 pt-1 text-muted-foreground text-xs">
              {tn(
                moreNeedYou,
                "{count} more needs you in the sidebar",
                "{count} more need you in the sidebar",
              )}
            </li>
          ) : null}
        </ThreadSection>
      )}
      {lists.recent.length === 0 ? null : (
        <ThreadSection
          title={t("Recent threads")}
          threads={lists.recent}
          projectNameOf={projectNameOf}
        />
      )}
    </>
  );
}
