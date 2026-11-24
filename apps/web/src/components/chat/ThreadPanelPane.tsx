import { t } from "~/i18n";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { embedRightPanelThread, useRightPanelStore } from "../../rightPanelStore";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { useEnvironmentConnectionSummary } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { isSidebarEnvironmentDisconnected } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { EmbeddedThreadChat, EmbeddedThreadPane } from "./EmbeddedThreadPane";

function useEmbeddableThread(ref: ScopedThreadRef | null) {
  const shell = useQuietThreadShell(ref);
  // Archived threads can be absent from the shell but still have a detail stream.
  const detail = useQuietThreadProjection(shell === null ? ref : null);
  return shell ?? detail?.projection.thread ?? null;
}

export default function ThreadPanelPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly hostRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { threadRef, hostRef, onClose } = props;
  const navigate = useNavigate();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const environmentRemoved = catalog.isReady && !catalog.entries.has(threadRef.environmentId);
  const connection = useEnvironmentConnectionSummary(threadRef.environmentId);
  const availableRef = environmentRemoved ? null : threadRef;
  const loaded = useEmbeddableThread(availableRef);
  const status = useThreadStatus(availableRef);
  const host = useEmbeddableThread(hostRef);
  const deleted = status === "deleted" || loaded?.deletedAt != null;
  const disconnectedLabel =
    !environmentRemoved &&
    loaded === null &&
    connection !== null &&
    isSidebarEnvironmentDisconnected(connection.connectionState, true)
      ? connection.environmentLabel
      : null;
  const unavailable = environmentRemoved || deleted || disconnectedLabel !== null;
  const thread = unavailable ? null : loaded;
  const title = thread?.title ?? t("Thread");

  const guestProjectId = thread?.projectId ?? null;
  const guestWorktreePath = thread?.worktreePath ?? null;
  const hostProjectId = host?.projectId ?? null;
  const hostWorktreePath = host?.worktreePath ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the panel store where the embedded chat's panel actions go until it unmounts
  useEffect(() => {
    if (guestProjectId === null) return;
    return embedRightPanelThread(
      { ref: threadRef, projectId: guestProjectId, worktreePath: guestWorktreePath },
      { ref: hostRef, projectId: hostProjectId, worktreePath: hostWorktreePath },
    );
  }, [threadRef, hostRef, guestProjectId, guestWorktreePath, hostProjectId, hostWorktreePath]);

  const openInMainView = () => {
    onClose();
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  const openInMainViewOnRequest = useEffectEvent(() => {
    if (useRightPanelStore.getState().consumeThreadRevealRequest(hostRef, threadRef)) {
      openInMainView();
    }
  });
  const hostKey = scopedThreadKey(hostRef);
  const threadKey = scopedThreadKey(threadRef);
  const revealRequested = useRightPanelStore(
    (state) =>
      state.pendingThreadReveal?.hostKey === hostKey &&
      state.pendingThreadReveal.threadKey === threadKey,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a panel action of a thread from another workspace opened in its own panel, so the thread moves to the main view
  useEffect(() => {
    if (revealRequested) openInMainViewOnRequest();
  }, [revealRequested]);

  return (
    <EmbeddedThreadPane
      title={title}
      closeLabel={t("Close {title}", { title })}
      onClose={onClose}
      actions={
        thread && (
          <Button variant="ghost" size="xs" onClick={openInMainView}>
            {t("Open in main view")}
          </Button>
        )
      }
    >
      {thread ? (
        <EmbeddedThreadChat threadRef={threadRef} hostRef={hostRef} />
      ) : (
        <div className="space-y-1 p-3 text-xs text-muted-foreground" role="status">
          <p>{unavailable ? t("Thread unavailable") : t("Loading this thread.")}</p>
          {disconnectedLabel !== null && !deleted ? (
            <p>{t("{environment} is not connected.", { environment: disconnectedLabel })}</p>
          ) : null}
        </div>
      )}
    </EmbeddedThreadPane>
  );
}
