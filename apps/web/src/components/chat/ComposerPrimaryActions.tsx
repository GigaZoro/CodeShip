import { msg, t } from "~/i18n";
import {
  memo,
  useEffect,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  Minimize2Icon,
  PlayIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierSelection } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  ACTIVE_TURN_COMPOSER_ACTIONS,
  type ActiveTurnComposerAction,
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  /** Footer controls (dictation) that always sit right before the primary button. */
  children?: ReactNode;
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  runId?: string | null;
  followUpBehavior?: ActiveTurnComposerAction;
  canSteer?: boolean;
  /** The provider can stop the running turn and start it again with a new message. */
  canRestart?: boolean;
  alternateShortcutLabel?: string | null;
  stopShortcutLabel?: string | null;
  /** Dictation is running; Send finishes it and submits once the transcript lands. */
  voiceInputActive?: boolean;
  isSendBusy: boolean;
  /** A send is armed and waiting for its attachments to finish preparing or uploading. */
  isSendHeld?: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  /** The offline machine a message here waits for, which turns Send into Queue. */
  offlineQueueMachine?: string | null;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canResume?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onSendWithAction?: (action: ActiveTurnComposerAction) => void;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  compactBeforeSendTokens?: number | null;
  hideCompactToggle?: boolean;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
}

const FOLLOW_UP_ACTION_LABEL = {
  queue: msg("queue"),
  steer: msg("steer"),
  restart: msg("stop and send"),
} as const;

const FOLLOW_UP_MENU_ITEM = {
  steer: { label: msg("Steer now"), description: msg("Add it to what the agent is doing") },
  queue: { label: msg("Queue"), description: msg("Send it when the current turn ends") },
  restart: {
    label: msg("Stop and send"),
    description: msg("Stop the current turn and send it instead"),
  },
} as const;

const FOLLOW_UP_SUBMIT_LABEL = {
  queue: msg("Queue message"),
  steer: msg("Steer message"),
  restart: msg("Stop and send message"),
} as const;

const FOLLOW_UP_ICON = {
  queue: ListPlusIcon,
  steer: CornerUpRightIcon,
  restart: RotateCcwIcon,
} as const;

const formatPendingPrimaryActionLabel = (
  input: {
    compact: boolean;
    isLastQuestion: boolean;
    isResponding: boolean;
    questionIndex: number;
  },
  resolve: typeof t,
) => {
  if (input.isResponding) {
    return resolve(msg("Submitting..."));
  }
  if (input.compact) {
    return input.isLastQuestion ? resolve(msg("Submit")) : resolve(msg("Next"));
  }
  if (!input.isLastQuestion) {
    return resolve(msg("Next question"));
  }
  return input.questionIndex > 0 ? resolve(msg("Submit answers")) : resolve(msg("Submit answer"));
};

const STOP_PENDING_MAX_MS = 10_000;
// The action that takes Stop's place ignores clicks this long, so repeat Stop clicks can't resume.
const STOP_LANDED_CLICK_GUARD_MS = 500;

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

type StopPhase = "pending" | "timedOut" | "landed" | null;

function useStopPhase(input: {
  runId: string | null;
  canInterrupt: boolean;
  canOperateThread: boolean;
}) {
  const { runId, canInterrupt, canOperateThread } = input;
  const [stopPhase, setStopPhase] = useState<StopPhase>(null);
  const [stopRunId, setStopRunId] = useState(runId);
  if (runId !== null && stopRunId !== runId) {
    setStopRunId(runId);
    setStopPhase(null);
  } else if (canOperateThread) {
    // Losing permission also clears canInterrupt; it does not acknowledge the stop.
    if ((stopPhase === "pending" || stopPhase === "timedOut") && !canInterrupt)
      setStopPhase("landed");
    else if (stopPhase === "landed" && canInterrupt) setStopPhase(null);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timers that re-enable an unsettled Stop and end the landed click guard
  useEffect(() => {
    if (stopPhase === "pending") {
      const timeout = setTimeout(() => setStopPhase("timedOut"), STOP_PENDING_MAX_MS);
      return () => clearTimeout(timeout);
    }
    if (stopPhase === "landed") {
      const timeout = setTimeout(() => setStopPhase(null), STOP_LANDED_CLICK_GUARD_MS);
      return () => clearTimeout(timeout);
    }
  }, [stopPhase]);
  return [stopPhase, setStopPhase] as const;
}

function StopGenerationButton({
  stopPhase,
  canOperateThread,
  insidePendingAction,
  preserveComposerFocusOnPointerDown,
  stopShortcutLabel = null,
  onStopRequested,
  onInterrupt,
}: {
  stopPhase: StopPhase;
  stopShortcutLabel?: string | null;
  canOperateThread: boolean;
  insidePendingAction: boolean;
  preserveComposerFocusOnPointerDown: boolean;
  onStopRequested: () => void;
  onInterrupt: () => void;
}) {
  const isStopDisabled = stopPhase === "pending";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none disabled:cursor-default disabled:opacity-64 disabled:hover:bg-destructive/90 [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
            disabled={!canOperateThread || isStopDisabled}
            onClick={() => {
              if (!canOperateThread || isStopDisabled) return;
              onStopRequested();
              onInterrupt();
            }}
            aria-label={stopPhase === "pending" ? t("Stopping") : t("Stop agent")}
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>
        {stopPhase === "pending"
          ? t("Stopping…")
          : stopShortcutLabel
            ? t("{text} ({shortcut})", { text: t("Stop agent"), shortcut: stopShortcutLabel })
            : t("Stop agent")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The collapsed mobile composer's Stop, shown in place of `children` while a turn can be stopped. */
export function CollapsedComposerStopAction({
  children,
  canOperateThread,
  canInterrupt,
  runId,
  hasSendableContent,
  isEditingQueuedMessage,
  onInterrupt,
}: {
  children: ReactNode;
  canOperateThread: boolean;
  canInterrupt: boolean;
  runId: string | null;
  hasSendableContent: boolean;
  isEditingQueuedMessage: boolean;
  onInterrupt: () => void;
}) {
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
  if (
    !(canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") ||
    hasSendableContent ||
    isEditingQueuedMessage
  ) {
    return children;
  }
  return (
    <span
      data-chat-composer-transition-actions="true"
      data-chat-composer-collapsed-controls="true"
      className="flex shrink-0"
    >
      <StopGenerationButton
        stopPhase={stopPhase}
        canOperateThread={canOperateThread}
        insidePendingAction={false}
        preserveComposerFocusOnPointerDown
        onStopRequested={() => setStopPhase("pending")}
        onInterrupt={onInterrupt}
      />
    </span>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  children,
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  runId = null,
  followUpBehavior = "steer",
  canSteer = true,
  canRestart = false,
  alternateShortcutLabel = null,
  stopShortcutLabel = null,
  voiceInputActive = false,
  isSendBusy,
  isSendHeld = false,
  sendDisabledReason,
  isEnvironmentUnavailable,
  offlineQueueMachine = null,
  isPreparingWorktree,
  hasSendableContent,
  canResume = false,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onSendWithAction,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  compactBeforeSendTokens = null,
  hideCompactToggle = false,
  keepFullHistory = false,
  onToggleKeepFullHistory,
}: ComposerPrimaryActionsProps) {
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const alternateModifier = useShortcutModifierSelection(
    (modifiers) => modifiers.metaKey || modifiers.ctrlKey,
  );
  const dispatchMode = isEditingQueuedMessage
    ? "auto"
    : resolveComposerDispatchMode({
        running: isRunning,
        activeTurnDefault: followUpBehavior,
        canSteer,
        alternateModifier,
      });
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const FollowUpIcon = dispatchMode === "auto" ? null : FOLLOW_UP_ICON[dispatchMode];
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <StopGenerationButton
      key="interrupt"
      stopPhase={stopPhase}
      canOperateThread={canOperateThread}
      insidePendingAction={insidePendingAction}
      preserveComposerFocusOnPointerDown={preserveComposerFocusOnPointerDown}
      onStopRequested={() => setStopPhase("pending")}
      stopShortcutLabel={stopShortcutLabel}
      onInterrupt={onInterrupt}
    />
  );

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label={t("Previous question")}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              {t("Previous")}
            </Button>
          )
        ) : null}
        {children}
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          onClick={(event) => {
            if (stopPhase === "landed") event.preventDefault();
          }}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            isSendDisabled ||
            pendingAction.isResponding ||
            (!voiceInputActive &&
              (pendingAction.isLastQuestion
                ? !pendingAction.isComplete
                : !pendingAction.canAdvance))
          }
        >
          {formatPendingPrimaryActionLabel(
            {
              compact,
              isLastQuestion: pendingAction.isLastQuestion,
              isResponding: pendingAction.isResponding,
              questionIndex: pendingAction.questionIndex,
            },
            t,
          )}
        </button>
        {canInterrupt || stopPhase === "pending" || stopPhase === "timedOut"
          ? renderStopGenerationButton(true)
          : null}
      </div>
    );
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage && !isSendHeld;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? t("Resume thread")
    : offlineQueueMachine !== null
      ? t("Queue until {name} reconnects", { name: offlineQueueMachine })
      : isEditingQueuedMessage
        ? t("Update queued message")
        : compactsBeforeSend
          ? t("Compact and send")
          : dispatchMode === "auto"
            ? t("Submit message")
            : t(FOLLOW_UP_SUBMIT_LABEL[dispatchMode]);
  const submitStatus = isEnvironmentUnavailable
    ? t("Environment disconnected")
    : isSendHeld
      ? t("Sending when ready")
      : (sendDisabledReason ??
        (isPreparingWorktree
          ? t("Preparing worktree")
          : isSendBusy
            ? isEditingQueuedMessage
              ? t("Updating queued message")
              : t("Submitting message")
            : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? t("Summarize {tokens} tokens of history, then send", { tokens: compactTokens })
      : isRunning && !isEditingQueuedMessage && canSteer
        ? alternateShortcutLabel
          ? t("Click to {action}, {modifier}-click or {shortcut} to {alternate}", {
              action: t(FOLLOW_UP_ACTION_LABEL[followUpBehavior]),
              modifier: isMacPlatform(navigator.platform) ? "⌘" : "Ctrl",
              shortcut: alternateShortcutLabel,
              alternate: t(FOLLOW_UP_ACTION_LABEL[alternateAction]),
            })
          : t("Click to {action}, {modifier}-click to {alternate}", {
              action: t(FOLLOW_UP_ACTION_LABEL[followUpBehavior]),
              modifier: isMacPlatform(navigator.platform) ? "⌘" : "Ctrl",
              alternate: t(FOLLOW_UP_ACTION_LABEL[alternateAction]),
            })
        : submitLabel);

  const isBusyOrHeld = isSendBusy || isSendHeld;
  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
        stageBackdropVariant
          ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64"
          : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
      )}
      {...pointerFocusProps}
      onClick={(event) => {
        if (stopPhase === "landed") {
          event.preventDefault();
          return;
        }
        if (showResume) onResume?.();
        else onSubmitMessage?.(event);
      }}
      disabled={
        isBusyOrHeld ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
      aria-busy={isBusyOrHeld || undefined}
    >
      {stageBackdropVariant ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isBusyOrHeld ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : FollowUpIcon ? (
        <FollowUpIcon className="size-4" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const sendTooltip = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  const followsUpRunningTurn = isRunning && !showResume && !isEditingQueuedMessage;
  // Keep the clicked target at the right edge even if typing changes the primary action.
  const withStopButton = (action: ReactNode) => (
    <>
      {action}
      {!followsUpRunningTurn && (stopPhase === "pending" || stopPhase === "timedOut")
        ? renderStopGenerationButton(false)
        : null}
    </>
  );
  // Stop stays beside Send so a correction can be typed while the agent works.
  const submit = followsUpRunningTurn ? (
    <div data-chat-composer-follow-up-actions="true" className="flex items-center gap-1.5">
      {canInterrupt || stopPhase === "pending" || stopPhase === "timedOut"
        ? renderStopGenerationButton(false)
        : null}
      {canSteer && onSendWithAction ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("Choose how to send")}
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
                disabled={
                  isSendBusy || isSendDisabled || isEnvironmentUnavailable || !hasSendableContent
                }
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            {ACTIVE_TURN_COMPOSER_ACTIONS.map((action) => {
              const unavailable = action === "restart" && !canRestart;
              return (
                <MenuItem
                  key={action}
                  disabled={unavailable}
                  onClick={() => {
                    if (!unavailable) onSendWithAction(action);
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span>{t(FOLLOW_UP_MENU_ITEM[action].label)}</span>
                    <span className="text-muted-foreground text-xs">
                      {unavailable
                        ? t("This provider can't stop and restart a turn")
                        : t(FOLLOW_UP_MENU_ITEM[action].description)}
                    </span>
                  </span>
                  {action === alternateAction && alternateShortcutLabel ? (
                    <MenuShortcut>{alternateShortcutLabel}</MenuShortcut>
                  ) : null}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
      {sendTooltip}
    </div>
  ) : (
    sendTooltip
  );
  if (compactTokens === null || hideCompactToggle) {
    return withStopButton(
      <>
        {children}
        {submit}
      </>,
    );
  }

  return withStopButton(
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:text-muted-foreground"
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={t("Compact {tokens} tokens of history before sending", {
                tokens: compactTokens,
              })}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          <span className="@max-[480px]/composer-surface:hidden">
            {keepFullHistory ? t("Keep") : t("Compact")}
          </span>
          <span className="text-muted-foreground">{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? t("Next send keeps all {tokens} tokens.", { tokens: compactTokens })
              : t("Next send compacts {tokens} tokens first.", { tokens: compactTokens })}
          </div>
          <div>
            {keepFullHistory ? t("Click to compact first") : t("Click to keep full history")}
          </div>
        </TooltipPopup>
      </Tooltip>
      {children}
      {submit}
    </div>,
  );
});
