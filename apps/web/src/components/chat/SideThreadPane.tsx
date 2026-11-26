import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { t } from "~/i18n";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { ComposerHandleContext } from "../../composerHandleContext";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import {
  hostRightPanel,
  rightPanelHostRef,
  type ThreadSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import {
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
} from "../../threadRoutes";
import { useOpenThreadFamily } from "../ThreadRouteView";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BackgroundThreadContext } from "./backgroundThread";
import { closeThreadFindIn } from "./threadFindStore";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/**
 * A side chat or a subagent as a tab: the thread's own chat, which decides its bottom, the
 * composer or the read-only bar, as it does on the main screen. The tab names it and closes it,
 * so only a side chat, which has actions of its own, gets a header.
 */
export default function SideThreadPane(props: {
  /** The thread whose panel shows the tab. */
  readonly parentRef: ScopedThreadRef;
  readonly surface: ThreadSurface;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, surface } = props;
  const { threadId } = surface;

  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store, and closes this side chat's find with its pane
  useEffect(() => {
    const ref = scopeThreadRef(parentRef.environmentId, threadId);
    const unhost = hostRightPanel(ref, parentRef);
    return () => {
      unhost();
      // Crossing the sheet breakpoint remounts the pane in the same commit, which re-hosts it.
      queueMicrotask(() => {
        if (rightPanelHostRef(ref) === ref) closeThreadFindIn(scopedThreadKey(ref));
      });
    };
  }, [parentRef, threadId]);
  const shell = useQuietThreadShell(threadRef);
  // A nested side chat shows in its ancestor's panel but merges into its own parent.
  const mergeTargetId = shell?.lineage.parentThreadId ?? null;
  const mergeTarget = useQuietThreadShell(
    mergeTargetId === null ? null : scopeThreadRef(parentRef.environmentId, mergeTargetId),
  );
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(parentRef.environmentId),
  );
  // The shell can leave an idle subagent out, so its own detail says whether it still exists.
  const unlistedDetail = useEnvironmentThread(
    shell === null ? parentRef.environmentId : null,
    shell === null ? threadId : null,
  );
  useOpenThreadFamily(threadRef, bootstrapComplete && shell === null);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: shell !== null,
    serverThreadDeleted: shell?.deletedAt != null,
    unlistedThreadDetail: unlistedDetail,
    draftThreadExists: false,
  });
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const thread = shell ?? projection?.thread ?? null;
  // A tab opens for side chats and subagents only, so an unloaded one is still one of them.
  const kind = sideThreadKindOf(thread) ?? "subagent";
  const isSideChat = kind === "side-chat";
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const [bringingBack, setBringingBack] = useState(false);
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [deleting, setDeleting] = useState(false);
  // Closing an unused side chat deletes it, which would leave the link unreadable.
  const canAddToChat = shell !== null && shell.latestUserMessageAt !== null;
  const addToChat = () => {
    if (!canAddToChat) return;
    useComposerDraftStore
      .getState()
      .addThreadContexts(parentRef, [threadContextRecord(threadRef, shell.title)], {
        insertAtCaret: false,
      });
  };

  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  // A pending merge-back would fail the main thread's queued message, so the server refuses it.
  const bringBackBlockedReason = !canOperate
    ? t("This connection cannot change threads.")
    : threadRuntimeIsActive(mergeTarget?.runtime)
      ? t("Available when the main thread is idle.")
      : mergeRun === null || mergeTargetId === null
        ? t("Available after a finished reply.")
        : null;

  const bringBack = async () => {
    if (bringBackBlockedReason !== null || bringingBack) return;
    if (mergeRun === null || mergeTargetId === null) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: { sourceThreadId: threadId, targetThreadId: mergeTargetId, runId: mergeRun.id },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: t("Brought back"),
        description: t("The main thread gets this side chat with your next message there."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("Could not bring back the side chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            t('Delete side chat "{title}"?', { title: shell.title }),
            t("This permanently clears its conversation history."),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    setDeleting(true);
    const result = await deleteThread({
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      useRightPanelStore.getState().closeSurface(parentRef, surface.id);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("Could not delete the side chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const title =
    thread === null
      ? isSideChat
        ? t("Side chat")
        : t("Subagent")
      : isSideChat
        ? thread.title
        : formatSubagentDisplayTitle(thread.title);

  return (
    <div
      data-side-chat-pane={threadId}
      data-testid="side-thread-pane"
      className="flex h-full min-h-0 flex-col"
    >
      {isSideChat ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
          <h2 className="min-w-0 flex-1 truncate text-xs font-medium">{title}</h2>
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={bringBackBlockedReason !== null || bringingBack || undefined}
                onClick={() => void bringBack()}
              >
                {t("Bring back")}
              </Button>
            }
            label={
              bringBackBlockedReason ?? t("Adds this side chat to the main thread's next message.")
            }
            side="bottom"
          />
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={!canAddToChat || undefined}
                onClick={addToChat}
              >
                {t("Add to chat")}
              </Button>
            }
            label={
              canAddToChat
                ? t("Adds this side chat to the main thread's next message.")
                : t("Available after the first message.")
            }
            side="bottom"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Delete side chat")}
            disabled={!canOperate || shell === null || deleting}
            onClick={() => void deleteSideChat()}
          >
            <Trash2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Close side chat")}
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {renderState === "missing" ? (
        <p className="p-3 text-xs text-muted-foreground">
          {isSideChat ? t("This side chat was deleted.") : t("This thread is no longer available.")}
        </p>
      ) : renderState === "loading" && thread === null ? null : (
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={parentRef.environmentId}
              threadId={threadId}
              routeKind="server"
              embedded={{ ...props.parentPanel, hostRef: parentRef }}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      )}
    </div>
  );
}
