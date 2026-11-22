import { t } from "~/i18n";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { environmentCatalog } from "../../connection/catalog";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadStatus,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { EmbeddedThreadChat, EmbeddedThreadPane } from "./EmbeddedThreadPane";

export default function ThreadPanelPane(props: {
  readonly threadRef: ScopedThreadRef;
  readonly hostRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { threadRef, hostRef, onClose } = props;
  const navigate = useNavigate();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const environmentRemoved = catalog.isReady && !catalog.entries.has(threadRef.environmentId);
  const availableRef = environmentRemoved ? null : threadRef;
  const shell = useQuietThreadShell(availableRef);
  // Archived threads can be absent from the shell but still have a detail stream.
  const detail = useQuietThreadProjection(shell === null ? availableRef : null);
  const status = useThreadStatus(availableRef);
  const unavailable =
    environmentRemoved ||
    status === "deleted" ||
    (shell?.deletedAt ?? detail?.projection.thread.deletedAt) != null;
  const thread = unavailable ? null : (shell ?? detail?.projection.thread ?? null);
  const title = thread?.title ?? t("Thread");

  return (
    <EmbeddedThreadPane
      title={title}
      closeLabel={t("Close {title}", { title })}
      onClose={onClose}
      actions={
        thread && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onClose();
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              });
            }}
          >
            {t("Open in main view")}
          </Button>
        )
      }
    >
      {thread ? (
        <EmbeddedThreadChat threadRef={threadRef} hostRef={hostRef} />
      ) : (
        <p className="p-3 text-xs text-muted-foreground" role="status">
          {unavailable ? t("Thread unavailable") : t("Loading this thread.")}
        </p>
      )}
    </EmbeddedThreadPane>
  );
}
