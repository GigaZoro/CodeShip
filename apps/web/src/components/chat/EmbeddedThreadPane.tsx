import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { BackgroundThreadContext } from "./backgroundThread";

export function EmbeddedThreadPane(props: {
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
        {props.actions}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={props.closeLabel}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {props.children}
    </div>
  );
}

/** The caller registers where the chat's panel actions go (`hostRightPanel` or `embedRightPanelThread`). */
export function EmbeddedThreadChat(props: {
  readonly threadRef: ScopedThreadRef;
  readonly hostRef: ScopedThreadRef;
  readonly parentPanel?: SideChatParentPanel;
}) {
  const { threadRef, hostRef, parentPanel } = props;
  const { environmentId, threadId } = threadRef;
  const embedded = { ...parentPanel, hostRef };
  return (
    <BackgroundThreadContext value>
      <ComposerHandleContext value={null}>
        <ChatView
          environmentId={environmentId}
          threadId={threadId}
          routeKind="server"
          embedded={embedded}
        />
      </ComposerHandleContext>
    </BackgroundThreadContext>
  );
}
