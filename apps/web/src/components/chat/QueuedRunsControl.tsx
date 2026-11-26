import { t, msg, tn } from "~/i18n";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isSlashCommand } from "@t3tools/shared/composerTrigger";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { composerFileLinksToPlainText } from "@t3tools/shared/composerInlineTokens";
import {
  parseGoalCommand,
  type ChatAttachment as ContractChatAttachment,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  MessagesSquareIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";

import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { threadEnvironment } from "../../state/threads";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { isImageAttachment, type ChatImageAttachment, type ChatMessage } from "../../types";
import { cn, newMessageId } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { GuestMessageName } from "./guestMessageStyle";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { FoldedMessageHeader, useScheduledTaskTitle } from "./TimelineUserMessageRow";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";

export interface EditQueuedRunRequest {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ContractChatAttachment>;
}

// A longer queue shows its first messages and a button that shows the rest.
const QUEUE_VISIBLE_ROWS = 3;

export interface QueuedRunsControlHandle {
  steerNext: (repeat: boolean) => boolean;
  editLatest: (repeat: boolean) => boolean;
}

type ThreadQueueProjection = Parameters<typeof deriveThreadQueueWorkflowState>[0];

function queuedImageResources(projection: ThreadQueueProjection | undefined) {
  if (!projection) return [];
  return deriveThreadQueueWorkflowState(projection).queuedRuns.flatMap(({ attachments }) =>
    attachments.flatMap((attachment) =>
      isImageAttachment(attachment)
        ? [{ _tag: "attachment" as const, attachmentId: attachment.id }]
        : [],
    ),
  );
}

export function QueuedRunsControl({
  ref,
  ...props
}: {
  readonly ref?: Ref<QueuedRunsControlHandle>;
  readonly steerShortcutLabel?: string | null;
  readonly editShortcutLabel?: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<
    Pick<ChatMessage, "id" | "inputIntent" | "text" | "attachments">
  >;
  readonly editingRunId: RunId | null;
  /** Set while something else holds the composer, such as an open question. */
  readonly editBlockedReason: string | null;
  readonly onEditQueuedRun: (request: EditQueuedRunRequest) => void;
  readonly onCancelEdit: () => void;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const projection = useQuietThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const [showAll, setShowAll] = useState(false);
  const queueListId = useId();
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const steerInFlightRef = useRef(false);
  // Run-only acknowledgements can resurrect pending rows after cancellation or startup.
  const acknowledgedMessageIds = new Set((projection?.messages ?? []).map((message) => message.id));
  const queuedImageAttachmentResources = queuedImageResources(projection);
  const queuedImageAttachmentUrls = useAssetUrls(
    props.environmentId,
    queuedImageAttachmentResources,
  );
  const workflow = projection ? deriveThreadQueueWorkflowState(projection, t) : null;
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
  const canSendRun = (freshContext: boolean) =>
    workflow?.canSendNow === true ||
    (workflow?.canPromoteToSteer === true &&
      (!freshContext || workflow.promoteSkipsCompaction === true));
  const queuedImageUrlById = new Map(
    queuedImageAttachmentUrls.flatMap((url, index) => {
      const resource = queuedImageAttachmentResources[index];
      return url && resource ? [[resource.attachmentId, url] as const] : [];
    }),
  );
  const optimisticQueued = props.optimisticMessages.filter(
    (message) => message.inputIntent === "queued_turn" && !acknowledgedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text, attachments, context, message }, serverIndex) => ({
      key: run.id,
      message,
      runId: run.id,
      messageId: run.userMessageId,
      freshContext: run.freshContext === true,
      serverIndex,
      text,
      // A guest's message keeps the guest's words; the owner can cancel it, not rewrite it.
      editable: context?.guest === undefined,
      attachments,
      thumbnails: attachments.filter(isImageAttachment).map<ChatImageAttachment>((attachment) => {
        const previewUrl = queuedImageUrlById.get(attachment.id);
        return {
          ...attachment,
          type: "image",
          ...(previewUrl ? { previewUrl } : {}),
        };
      }),
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      message: undefined,
      runId: null,
      messageId: null,
      freshContext: false,
      serverIndex: null,
      text: message.text,
      editable: true,
      attachments: [] as ReadonlyArray<ContractChatAttachment>,
      thumbnails: (message.attachments ?? []).filter(isImageAttachment),
      pending: true,
    })),
  ];

  const sendQueuedMessage = async (queuedRunId: RunId) => {
    const freshContext = queued.some(
      ({ run }) => run.id === queuedRunId && run.freshContext === true,
    );
    if (!canSendRun(freshContext) || steerInFlightRef.current) return;
    steerInFlightRef.current = true;
    setBusyRunId(queuedRunId);
    const result = workflow?.canSendNow
      ? await resume({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, runId: queuedRunId },
        })
      : activeRun !== null
        ? await promote({
            environmentId: props.environmentId,
            input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
          })
        : null;
    steerInFlightRef.current = false;
    setBusyRunId(null);
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t(msg("Could not send queued message")),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, t) ?? error.message)
            : t(msg("An error occurred.")),
      });
    }
  };

  useImperativeHandle(ref, () => ({
    steerNext(repeat) {
      const next = queued[0];
      if (!next || !canSendRun(next.run.freshContext === true)) return false;
      if (!repeat && busyRunId === null) void sendQueuedMessage(next.run.id);
      return true;
    },
    // Leave the key to caret navigation while editing.
    editLatest(repeat) {
      const latest = queued.at(-1);
      if (
        !latest ||
        latest.context?.guest !== undefined ||
        props.editingRunId !== null ||
        props.editBlockedReason !== null ||
        busyRunId !== null
      ) {
        return false;
      }
      if (!repeat) {
        setShowAll(true);
        props.onEditQueuedRun({
          runId: latest.run.id,
          messageId: latest.run.userMessageId,
          text: latest.text,
          attachments: latest.attachments,
        });
      }
      return true;
    },
  }));

  if (items.length === 0) return null;

  // Undo queues the message again, at the end of the queue.
  const restore = (
    removed: (typeof queued)[number],
    thread: NonNullable<typeof projection>["thread"],
  ) => {
    if (!removed.message) return;
    void startTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: removed.message.text,
          attachments: removed.attachments,
          ...(removed.context ? { context: removed.context } : {}),
        },
        modelSelection: removed.run.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        ...(removed.run.sourcePlanRef ? { sourceProposedPlan: removed.run.sourcePlanRef } : {}),
        dispatchMode: "queue",
      },
    });
  };

  const remove = async (runId: RunId) => {
    const removed = queued.find((entry) => entry.run.id === runId);
    const thread = projection?.thread;
    setBusyRunId(runId);
    const result = await cancel({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId },
    });
    setBusyRunId(null);
    // A guest's message keeps the guest's attribution, which the owner cannot send again.
    if (
      result._tag === "Failure" ||
      !removed?.message ||
      removed.context?.guest !== undefined ||
      !thread
    ) {
      return;
    }
    const toastId = toastManager.add({
      type: "info",
      title: t("Removed queued message"),
      actionProps: {
        children: t("Undo"),
        onClick: () => {
          toastManager.close(toastId);
          restore(removed, thread);
        },
      },
    });
  };

  const collapsible = items.length > QUEUE_VISIBLE_ROWS;
  const visibleItems = collapsible && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : items;

  return (
    <section
      aria-label={tn(items.length, "{count} queued message", "{count} queued messages")}
      data-thread-queue="true"
      // Anchors the sr-only live region; unanchored, it escapes the timeline scroller and makes the chat column scroll.
      className="relative mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2 pb-4"
    >
      <span className="sr-only" aria-live="polite">
        {t("{count} queued", { count: items.length })}
      </span>
      <ol className="flex flex-col items-end gap-3" id={queueListId}>
        {visibleItems.map((item, position) => {
          const previewText = isAttachmentOnlyBootstrapPrompt(item.text)
            ? ""
            : assistantCitationsToPlainText(
                composerFileLinksToPlainText(
                  replaceComposerContextReferences(item.text, (reference) => reference.label),
                ),
              ).trim();
          const isEditing = item.runId !== null && item.runId === props.editingRunId;
          // The server decides on the agent's text, and a goal command can stop the turn.
          const sentText = { text: item.message?.text ?? item.text, attachments: item.attachments };
          const movesCommandFirst = isSlashCommand(sentText) && parseGoalCommand(sentText) === null;
          return (
            <li
              key={item.key}
              aria-label={t("Queued message {position} of {total}, not sent", {
                position: position + 1,
                total: items.length,
              })}
              aria-posinset={position + 1}
              aria-setsize={items.length}
              aria-current={isEditing ? "true" : undefined}
              className="group/queued flex w-full flex-col items-end gap-1"
            >
              <QueuedMessage
                environmentId={props.environmentId}
                message={item.message}
                previewText={previewText}
                thumbnails={item.thumbnails}
                isEditing={isEditing}
                timestampFormat={props.timestampFormat}
                onOpenThread={props.onOpenThread}
                onImageExpand={props.onImageExpand}
              >
                {canSendRun(item.freshContext) && !isEditing ? (
                  <>
                    <SharedTooltipTrigger
                      render={<span className="flex shrink-0" />}
                      label={
                        item.serverIndex === 0 && props.steerShortcutLabel
                          ? workflow?.canSendNow
                            ? t("Start a turn with this message ({shortcut})", {
                                shortcut: props.steerShortcutLabel,
                              })
                            : workflow?.promoteSkipsCompaction
                              ? t("Skip compaction and send this message ({shortcut})", {
                                  shortcut: props.steerShortcutLabel,
                                })
                              : movesCommandFirst
                                ? t("Move this command to the front of the queue ({shortcut})", {
                                    shortcut: props.steerShortcutLabel,
                                  })
                                : t("Send into the current turn ({shortcut})", {
                                    shortcut: props.steerShortcutLabel,
                                  })
                          : workflow?.canSendNow
                            ? t("Start a turn with this message")
                            : workflow?.promoteSkipsCompaction
                              ? t("Skip compaction and send this message")
                              : movesCommandFirst
                                ? t("Move this command to the front of the queue")
                                : t("Send into the current turn")
                      }
                    >
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={item.runId === null || busyRunId !== null}
                        onClick={() => {
                          if (item.runId !== null) {
                            void sendQueuedMessage(item.runId);
                          }
                        }}
                      >
                        <ArrowUpIcon />
                        {t("Send now")}
                      </Button>
                    </SharedTooltipTrigger>
                  </>
                ) : null}
                {item.pending ? (
                  <span className="flex items-center gap-1 px-1">
                    <Clock3Icon aria-hidden className="size-3" />
                    {t("Saving")}
                  </span>
                ) : null}
                {isEditing ? (
                  <>
                    <span className="px-1 text-foreground">{t("Editing in the composer")}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t("Cancel editing queued message")}
                      onClick={props.onCancelEdit}
                    >
                      {t("Cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Tooltip>
                      {/* The span keeps the tooltip, and its reason, on a disabled button. */}
                      <TooltipTrigger render={<span className="flex shrink-0" />}>
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={t("Edit queued message")}
                          disabled={
                            item.runId === null ||
                            !item.editable ||
                            busyRunId !== null ||
                            props.editBlockedReason !== null
                          }
                          onClick={() => {
                            if (item.runId !== null && item.messageId !== null) {
                              props.onEditQueuedRun({
                                runId: item.runId,
                                messageId: item.messageId,
                                text: item.text,
                                attachments: item.attachments,
                              });
                            }
                          }}
                        >
                          <PencilIcon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {props.editBlockedReason ??
                          (item.serverIndex === queued.length - 1 && props.editShortcutLabel
                            ? t("Edit in the composer ({shortcut})", {
                                shortcut: props.editShortcutLabel,
                              })
                            : t("Edit in the composer"))}
                      </TooltipPopup>
                    </Tooltip>
                    <SharedTooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={t("Remove queued message")}
                          disabled={item.runId === null || busyRunId !== null}
                          onClick={() => {
                            if (item.runId !== null) void remove(item.runId);
                          }}
                        />
                      }
                      label={<>{t("Remove from queue")}</>}
                    >
                      <XIcon />
                    </SharedTooltipTrigger>
                  </>
                )}
              </QueuedMessage>
            </li>
          );
        })}
      </ol>
      {collapsible ? (
        <div className="self-end pe-1 text-xs pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5">
          <InlineButton
            tone="muted"
            aria-expanded={showAll}
            aria-controls={queueListId}
            // Keep the composer focused; keyboard activation still works.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? t("Show fewer") : t("Show all {count} queued", { count: items.length })}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                showAll && "rotate-180",
              )}
            />
          </InlineButton>
        </div>
      ) : null}
    </section>
  );
}

type QueuedRunMessage = NonNullable<ThreadQueueProjection["messages"][number]>;

/** A queued turn wears its sent form's attribution; only the dashed edge and controls differ. */
function QueuedMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage | undefined;
  readonly previewText: string;
  readonly thumbnails: ReadonlyArray<ChatImageAttachment>;
  readonly isEditing: boolean;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly children: ReactNode;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const presentation = props.message ? resolveUserMessagePresentation(props.message) : null;
  const attribution = presentation?.attribution ?? null;
  const scheduledTaskId = presentation?.scheduledTaskId;
  const senderThreadId = props.message?.senderThreadId;
  // A linked environment's agent sent it from a thread there.
  const senderRef =
    props.message?.linkedSender ??
    (senderThreadId === undefined ? null : scopeThreadRef(props.environmentId, senderThreadId));
  const [expanded, setExpanded] = useState(false);
  const taskTitle = useScheduledTaskTitle(props.environmentId, scheduledTaskId);
  const senderShell = useQuietThreadShell(attribution === "agent" ? senderRef : null);
  const linkedSenderEnvironment = useEnvironment(
    props.message?.linkedSender?.environmentId ?? null,
  );
  const senderTitle = senderShell?.title.trim() || props.message?.linkedSender?.title.trim();
  const fold =
    attribution === "automation"
      ? {
          icon: CalendarClockIcon,
          label: t("Automation"),
          fitLabel: true,
          summary: taskTitle ?? props.previewText.split(/\r?\n/, 1)[0] ?? "",
        }
      : attribution === "agent"
        ? {
            icon: MessagesSquareIcon,
            label: senderTitle || t("Agent"),
            fitLabel: !senderTitle,
            summary: props.previewText.split(/\r?\n/).find((line) => line.trim()) ?? "",
          }
        : null;
  const bodyVisible = fold === null || expanded;

  return (
    <>
      {attribution === "t3code" ? (
        <p className="me-1 text-2xs text-muted-foreground/70">{t("Sent by T3.CodeShip")}</p>
      ) : null}
      {presentation?.guestName === undefined ? null : (
        <GuestMessageName name={presentation.guestName} />
      )}
      {/* Dashed and unfilled: a turn that has not been sent yet. */}
      <div
        className={cn(
          "flex min-w-0 max-w-[80%] flex-col rounded-2xl border border-dashed text-sm",
          props.isEditing
            ? "border-primary/60 text-foreground"
            : attribution === "guest"
              ? "border-guest/50 text-muted-foreground"
              : "border-muted-foreground/40 text-muted-foreground",
          fold === null && "px-3 py-2",
          fold !== null && expanded && "w-full",
        )}
      >
        {fold ? (
          <FoldedMessageHeader
            icon={fold.icon}
            label={fold.label}
            fitLabel={fold.fitLabel}
            summary={fold.summary}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
        {bodyVisible ? (
          <div
            className={cn(
              "flex flex-col gap-2",
              fold !== null && "max-h-96 overflow-auto px-3 pb-2",
            )}
          >
            {props.thumbnails.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1">
                {props.thumbnails.map((thumbnail) => (
                  <button
                    key={thumbnail.id}
                    type="button"
                    aria-label={t("Preview {name}", { name: thumbnail.name })}
                    disabled={!thumbnail.previewUrl}
                    className="size-8 overflow-hidden rounded-md border border-border/70 bg-background enabled:cursor-zoom-in"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(props.thumbnails, thumbnail.id);
                      if (preview) props.onImageExpand(preview);
                    }}
                  >
                    {thumbnail.previewUrl ? (
                      <img
                        src={thumbnail.previewUrl}
                        alt={thumbnail.name}
                        className="size-full object-cover"
                      />
                    ) : (
                      <span aria-label={thumbnail.name} className="block size-full bg-muted/60" />
                    )}
                  </button>
                ))}
              </span>
            ) : null}
            {/* In full, like a sent turn: a queued message is read before it is sent. */}
            {props.previewText ? (
              <p className="whitespace-pre-wrap wrap-anywhere">{props.previewText}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
        {props.message ? (
          <span className="me-1 flex items-center gap-2 px-1 opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/queued:opacity-100">
            {attribution === "agent" &&
            senderRef &&
            // Only an environment this client is connected to can open the sender's thread there.
            (props.message?.linkedSender === undefined || linkedSenderEnvironment !== null) ? (
              <InlineButton
                tone="muted"
                onClick={() => props.onOpenThread(senderRef.threadId, senderRef.environmentId)}
              >
                {t("Open thread")}
              </InlineButton>
            ) : null}
            {scheduledTaskId ? (
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/scheduled-tasks"
                    search={{ environmentId: props.environmentId, taskId: scheduledTaskId }}
                  />
                }
              >
                {t("Open automation")}
              </InlineButton>
            ) : null}
            <TimelineRowTimestamp
              createdAt={DateTime.formatIso(props.message.createdAt)}
              timestampFormat={props.timestampFormat}
              alwaysVisible
            />
          </span>
        ) : null}
        {props.children}
      </div>
    </>
  );
}
