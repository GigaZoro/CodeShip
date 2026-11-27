import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { oneTapUserInputAnswers } from "@t3tools/client-runtime/state/pending-user-input";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { NeedsYouReason } from "@t3tools/client-runtime/state/thread-inbox";
import {
  resolveThreadStatus,
  THREAD_STATUS_DISPLAY,
} from "@t3tools/client-runtime/state/thread-status";
import { ClockIcon, Undo2Icon } from "lucide-react";
import {
  memo,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { t } from "~/i18n";
import { announce } from "~/lib/announce";
import { latinLetterOf } from "~/lib/sidebarTree";
import { cn } from "~/lib/utils";
import { requestWorkspaceContentFocus } from "~/lib/workspaceFocus";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  approvalOffersDecision,
  ComposerPendingApprovalActions,
} from "../chat/ComposerPendingApprovalActions";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WaitingSinceLabel } from "./SidebarThreadRow";
import { THREAD_ROW_STATUS_ICONS } from "./threadRowStatus";

export const NEEDS_YOU_LATER_ROW_ID = "needs-you:later";
export const FINISHED_NOT_SEEN_ROW_ID = "needs-you:finished";

const TRIAGE_KEYS = { a: "approve", d: "decline", l: "later", e: "settle" } as const;

/**
 * The box's keys: Enter opens, Escape leaves, and A, D, L and E answer, put off, or settle. The
 * box owns its letters (OWNS_LETTER_KEYS_ATTRIBUTE), so one that does not apply to the row
 * still stops here rather than typing into the composer.
 */
export function handleTriageKeyDown(
  event: KeyboardEvent,
  actions: {
    readonly [action in "open" | (typeof TRIAGE_KEYS)[keyof typeof TRIAGE_KEYS]]?:
      | (() => unknown)
      | undefined;
  },
) {
  if (
    event.target !== event.currentTarget ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.nativeEvent.isComposing
  )
    return;
  const letter = latinLetterOf(event);
  if (event.key === "Enter") actions.open?.();
  else if (event.key === "Escape") requestWorkspaceContentFocus();
  else if (letter in TRIAGE_KEYS) {
    // A held key would act again on the row that takes focus next.
    if (!event.repeat) actions[TRIAGE_KEYS[letter as keyof typeof TRIAGE_KEYS]]?.();
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

const REASON_ICON = {
  approval: THREAD_ROW_STATUS_ICONS.approval,
  input: THREAD_ROW_STATUS_ICONS.input,
  request: THREAD_ROW_STATUS_ICONS.request,
  failed: THREAD_ROW_STATUS_ICONS.failed,
  limited: THREAD_ROW_STATUS_ICONS.failed,
  stalled: THREAD_ROW_STATUS_ICONS.stalled,
} satisfies Record<NeedsYouReason, unknown>;

/** Listed threads already passed the snooze and settle checks, so only the kind of wait is left. */
function needsYouReasonOf(thread: EnvironmentThreadShell): NeedsYouReason {
  const status = resolveThreadStatus(thread);
  if (status === "working") return "stalled";
  return status === "approval" || status === "input" || status === "request" || status === "limited"
    ? status
    : "failed";
}

function firstLine(text: string): string {
  return text.trimStart().split("\n", 1)[0] ?? "";
}

interface ApprovalHandle {
  /** Answers by keyboard; does nothing when this approval cannot take that answer here. */
  decide: (decision: ProviderApprovalDecision) => void;
}

/** The thread's own approval, answered here unless the open thread's composer already offers it. */
function ApprovalRequest(props: {
  threadRef: ScopedThreadRef;
  icon: ReactNode;
  fallback: string;
  answerable: boolean;
  handle: Ref<ApprovalHandle>;
  onAnswered: (decision: ProviderApprovalDecision) => void;
}) {
  const approval =
    useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef))?.approvals[0] ??
    null;
  const canRespond = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = approval ? firstLine(approval.detail || approval.requestKind) : props.fallback;
  const live = props.answerable && approval?.responseCapability === "live";
  // Stays set after a success: the request lingers until the pending list drops it.
  const answeredRef = useRef<RuntimeRequestId | null>(null);
  const answer = async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    if (!canRespond || responding || answeredRef.current === requestId) return;
    setResponding(true);
    setError(null);
    const result = await respond({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, requestId, decision },
    });
    if (result._tag === "Success") {
      answeredRef.current = requestId;
      props.onAnswered(decision);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : t("Failed to submit approval decision."),
      );
    }
    setResponding(false);
    return result;
  };
  useImperativeHandle(props.handle, () => ({
    decide: (decision) => {
      if (live && approvalOffersDecision(approval.options, decision)) {
        void answer(approval.requestId, decision);
      }
    },
  }));
  return (
    <>
      <RequestLine icon={props.icon}>
        <RequestSummary mono={approval?.detail !== undefined}>{summary}</RequestSummary>
      </RequestLine>
      {live ? (
        // Buttons answer the request; the row's own click opens the thread.
        <div className="flex items-center gap-3 ps-5 pt-1" onClick={stopRowActivation}>
          <ComposerPendingApprovalActions
            presentation="inline"
            requestId={approval.requestId}
            isResponding={responding}
            canRespond
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={answer}
          />
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="ps-5 pt-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The thread's own question, answered here when one tap answers it and its composer is elsewhere. */
function QuestionRequest(props: {
  threadRef: ScopedThreadRef;
  icon: ReactNode;
  fallback: string;
  answerable: boolean;
}) {
  const userInput =
    useAtomValue(environmentThreadDetails.pendingRequestsAtom(props.threadRef))?.userInputs[0] ??
    null;
  const canRespond = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = userInput?.questions[0]?.question;
  const answers =
    props.answerable && userInput !== null && userInput.responseCapability !== "not_resumable"
      ? oneTapUserInputAnswers(userInput.questions)
      : null;
  const submit = async (requestId: RuntimeRequestId, answer: Record<string, string>) => {
    setResponding(true);
    setError(null);
    const result = await respond({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, requestId, answers: answer },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : t("Failed to submit user input."));
    }
    setResponding(false);
  };
  return (
    <>
      <RequestLine icon={props.icon}>
        <RequestSummary>{question ? firstLine(question) : props.fallback}</RequestSummary>
      </RequestLine>
      {answers !== null && userInput !== null ? (
        // Buttons answer the question; the row's own click opens the thread.
        <div className="flex flex-wrap items-center gap-x-3 ps-5 pt-1" onClick={stopRowActivation}>
          {answers.map((answer, index) => (
            <InlineButton
              key={answer.value}
              tone={index === 0 ? "default" : "muted"}
              disabled={!canRespond || responding}
              onClick={() => void submit(userInput.requestId, answer.answers)}
            >
              {answer.label}
            </InlineButton>
          ))}
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="ps-5 pt-1 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}

function RequestLine(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
      {props.icon}
      {props.children}
    </div>
  );
}

function RequestSummary(props: { mono?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "min-w-0 flex-1 truncate text-xs text-muted-foreground",
        props.mono && "font-mono",
      )}
    >
      {props.children}
    </span>
  );
}

function stopRowActivation(event: MouseEvent) {
  event.stopPropagation();
}

/** A thread in the Needs you box: what it asks, and the answer when it can be given here. */
export const NeedsYouBoxRow = memo(function NeedsYouBoxRow(props: {
  thread: EnvironmentThreadShell;
  since: number;
  /** In the box, or put off under Later. */
  placement: "box" | "later";
  /** The open thread, whose composer already shows its request. */
  isOpen: boolean;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  jumpLabel: string | null;
  settlementSupported: boolean;
  /** The thread's server stores "Decide later". */
  laterSupported: boolean;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onDecideLater: (threadRef: ScopedThreadRef) => void;
  onPutBack: (threadRef: ScopedThreadRef) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const approvalRef = useRef<ApprovalHandle>(null);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const reason = needsYouReasonOf(thread);
  const ReasonIcon = REASON_ICON[reason];
  const reasonIcon = (
    <ReasonIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        reason === "failed" ? "text-error-foreground" : "text-warning-foreground",
      )}
    />
  );
  const reasonLabel = t(THREAD_STATUS_DISPLAY[reason].summary);
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: reasonLabel,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isOpen,
  });
  const toggleLater = () => {
    if (props.placement === "box") props.onDecideLater(threadRef);
    else props.onPutBack(threadRef);
  };
  const handleToggleLaterClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggleLater();
  };
  const later = props.placement === "later";
  const laterLabel = later ? t("Move back to Needs you") : t("Decide later");
  const failure = reason === "failed" || reason === "limited";
  const handleKeyDown = (event: KeyboardEvent) =>
    handleTriageKeyDown(event, {
      open: () => props.onOpen(threadRef),
      approve: () => approvalRef.current?.decide("accept"),
      decline: () => approvalRef.current?.decide("decline"),
      later: props.laterSupported ? toggleLater : undefined,
      settle: failure && props.settlementSupported ? () => props.onSettle(threadRef) : undefined,
    });
  return (
    <li className="list-none">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`needs-you:${scopedThreadKey(threadRef)}`}
        data-sidebar-parent={later ? NEEDS_YOU_LATER_ROW_ID : undefined}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        onClick={() => props.onOpen(threadRef)}
        onKeyDown={handleKeyDown}
        className={cn(
          "group/needs-you-row relative cursor-pointer rounded-md px-2 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isOpen
            ? "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "hover:bg-sidebar-row-hover",
          later && "ps-5",
        )}
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
          {props.isOpen ? (
            <span className="shrink-0 text-xs text-muted-foreground">{t("This thread")}</span>
          ) : null}
          {props.jumpLabel ? (
            <Kbd aria-hidden data-jump-hint>
              {props.jumpLabel}
            </Kbd>
          ) : !props.laterSupported ? (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <WaitingSinceLabel since={props.since} />
            </span>
          ) : (
            // One grid cell holds both, so the slot fits the wider "Later" and it never covers the title.
            <span className="grid h-5 shrink-0 items-center text-xs text-muted-foreground tabular-nums">
              <span className="col-start-1 row-start-1 justify-self-end group-focus-within/needs-you-row:invisible group-any-hover/needs-you-row:invisible pointer-coarse:hidden">
                <WaitingSinceLabel since={props.since} />
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={laterLabel}
                      onClick={handleToggleLaterClick}
                      className="pointer-events-none col-start-1 row-start-1 -mr-1 inline-flex h-5 cursor-pointer items-center justify-self-end gap-1 rounded-md px-1 whitespace-nowrap opacity-0 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/needs-you-row:pointer-events-auto group-focus-within/needs-you-row:opacity-100 group-any-hover/needs-you-row:pointer-events-auto group-any-hover/needs-you-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
                    />
                  }
                >
                  {later ? (
                    <Undo2Icon aria-hidden className="size-3.5" />
                  ) : (
                    <>
                      <ClockIcon aria-hidden className="size-3.5" />
                      {t("Later")}
                    </>
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">{laterLabel}</TooltipPopup>
              </Tooltip>
            </span>
          )}
        </div>
        {reason === "approval" && thread.hasPendingApprovals ? (
          <ApprovalRequest
            threadRef={threadRef}
            icon={reasonIcon}
            fallback={reasonLabel}
            answerable={!props.isOpen}
            handle={approvalRef}
            onAnswered={(decision) =>
              announce(
                decision === "decline"
                  ? t("Declined: {title}", { title: thread.title })
                  : t("Approved: {title}", { title: thread.title }),
                "needs-you-triage",
              )
            }
          />
        ) : reason === "input" && thread.hasPendingUserInput ? (
          <QuestionRequest
            threadRef={threadRef}
            icon={reasonIcon}
            fallback={reasonLabel}
            answerable={!props.isOpen}
          />
        ) : (
          <RequestLine icon={reasonIcon}>
            <RequestSummary>{reasonLabel}</RequestSummary>
          </RequestLine>
        )}
        {failure && props.settlementSupported ? (
          <div className="flex items-center ps-5 pt-1" onClick={stopRowActivation}>
            <InlineButton tone="muted" onClick={() => props.onSettle(threadRef)}>
              {t("Settle")}
            </InlineButton>
          </div>
        ) : null}
      </div>
    </li>
  );
});

/** A thread the user started that finished after they last looked; it waits on nobody. */
export const FinishedNotSeenRow = memo(function FinishedNotSeenRow(props: {
  thread: EnvironmentThreadShell;
  isOpen: boolean;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  settlementSupported: boolean;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: t("Finished, not seen"),
    projectDisplayName: props.projectDisplayName,
    isActive: props.isOpen,
  });
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  return (
    <li className="list-none">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`needs-you:finished:${scopedThreadKey(threadRef)}`}
        data-sidebar-parent={FINISHED_NOT_SEEN_ROW_ID}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        onClick={() => props.onOpen(threadRef)}
        onKeyDown={(event) =>
          handleTriageKeyDown(event, {
            open: () => props.onOpen(threadRef),
            settle: props.settlementSupported ? () => props.onSettle(threadRef) : undefined,
          })
        }
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-md ps-5 pe-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isOpen
            ? "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "hover:bg-sidebar-row-hover",
        )}
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          <WaitingSinceLabel since={completedAt} />
        </span>
      </div>
    </li>
  );
});
