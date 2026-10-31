import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowUpIcon, SquareArrowOutUpRightIcon, SquareIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { newMessageId } from "~/lib/utils";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import {
  useProject,
  useQuietThreadProjection,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { openExpandedImagePreview } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessagesTimeline } from "./MessagesTimeline";
import { ScrollToEndButton } from "./TimelineOverlays";
import { useTimelineFollow } from "./useTimelineFollow";

const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};

export function SideChatPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly onOpenAsThread: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threadRef } = props;
  const shell = useThreadShell(threadRef);
  const thread = useQuietThreadProjection(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(threadRef.environmentId, shell.projectId),
  );
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const { resolvedTheme } = useTheme();
  const listRef = useRef<LegendListRef | null>(null);
  const threadKey = scopedThreadKey(threadRef);
  // The thread's own history sits beside it; show only what the side chat added.
  const visibleTurnItems = useThreadVisibleTurnItems(threadRef).filter(
    (row) => row.visibility !== "inherited",
  );
  const projection = thread?.projection ?? null;
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attempts: projection?.attempts ?? [],
    nodes: projection?.nodes ?? [],
    plans: projection?.plans ?? [],
  });
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadStructureRuntime(projection);
  const isWorking = derivePhase(runtime) === "running";
  const runningRunId = runtime?.activeRunId ?? null;
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Follow the end like a short conversation instead of anchoring each turn near the top.
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  const onImageExpand = useStableCallback((preview: ExpandedImagePreview) =>
    openExpandedImagePreview(threadKey, preview),
  );

  if (shell === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This side chat is no longer available.
      </div>
    );
  }
  const waitingForUser = shell.hasPendingApprovals || shell.hasPendingUserInput;
  const workspaceRoot = shell.worktreePath ?? project?.workspaceRoot ?? undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {shell.interactionMode === "plan" ? "Plan mode · " : ""}Not part of the thread
        </p>
        <Button size="xs" variant="ghost" onClick={props.onOpenAsThread}>
          <SquareArrowOutUpRightIcon />
          Open as thread
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <MessagesTimeline
          listRef={listRef}
          timelineEntries={entries}
          isWorking={isWorking}
          activeTurnStartedAt={deriveActiveWorkStartedAt(activityRun, runtime, null)}
          latestRun={activityRun}
          runningRunId={runningRunId}
          turnDiffSummaries={NO_TURN_DIFFS}
          runs={projection?.runs ?? []}
          routeThreadKey={threadKey}
          onOpenThread={props.onOpenThread}
          supportsConversationRollback={false}
          onRevertToTurnCount={ignore}
          isRevertingCheckpoint={false}
          onImageExpand={onImageExpand}
          activeThreadEnvironmentId={threadRef.environmentId}
          markdownCwd={workspaceRoot}
          resolvedTheme={resolvedTheme}
          timestampFormat={settings.timestampFormat}
          workspaceRoot={workspaceRoot}
          anchorMessageId={null}
          onAnchorReady={ignore}
          onAnchorSizeChanged={ignore}
          contentInsetEndAdjustment={0}
          emptyPlaceholderInset={0}
          liveFollowEnabled={follow.timelineLiveFollowEnabled}
          onIsAtEndChange={follow.onIsAtEndChangeStable}
          onViewportAttach={follow.attachTimelineViewport}
        />
        {follow.showScrollToBottom ? (
          <ScrollToEndButton
            summary={null}
            bottom={4}
            onScrollToEnd={() => follow.scrollToEnd(true)}
          />
        ) : null}
      </div>
      <div className="shrink-0 p-3">
        {waitingForUser ? (
          <div
            role="status"
            className="mb-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">The side chat is waiting for your answer.</span>
            <Button size="xs" variant="outline" onClick={props.onOpenAsThread}>
              Answer
            </Button>
          </div>
        ) : null}
        <SideChatComposer
          threadRef={threadRef}
          runtimeMode={shell.runtimeMode}
          interactionMode={shell.interactionMode}
          runningRunId={isWorking ? runningRunId : null}
          autoFocus={props.visible}
        />
      </div>
    </div>
  );
}

function SideChatComposer(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly runningRunId: RunId | null;
  readonly autoFocus: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const working = props.runningRunId !== null;

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || sending || working) return;
    setSending(true);
    const result = await startTurn({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        message: { messageId: newMessageId(), role: "user", text: trimmed, attachments: [] },
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not send to the side chat",
          description: error instanceof Error ? error.message : undefined,
        });
      }
      return;
    }
    // Keep anything typed while the request was in flight.
    setText((current) => (current.trim() === trimmed ? "" : current));
  };
  const stop = async () => {
    if (props.runningRunId === null) return;
    const result = await interruptTurn({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, runId: props.runningRunId },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: "Could not stop the side chat" });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same as the app composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-composer dark:shadow-composer-dark"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        aria-label="Side chat message"
        placeholder="Ask about this thread"
        rows={1}
        autoFocus={props.autoFocus}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none field-sizing-content placeholder:text-muted-foreground"
      />
      {working ? (
        <button
          type="button"
          aria-label="Stop"
          onClick={() => void stop()}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SquareIcon aria-hidden className="size-3.5" />
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send"
          disabled={sending || text.trim() === ""}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64"
        >
          <ArrowUpIcon aria-hidden className="size-4" />
        </button>
      )}
    </form>
  );
}
