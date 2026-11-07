import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
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
import {
  threadFailureStatus,
  type NeedsYouReason,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  resolveThreadStatus,
  THREAD_STATUS_DISPLAY,
} from "@t3tools/client-runtime/state/thread-status";
import { ClockIcon, Undo2Icon } from "lucide-react";
import { memo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WaitingSinceLabel } from "./SidebarThreadRow";
import { THREAD_ROW_STATUS_ICONS } from "./threadRowStatus";

export const NEEDS_YOU_LATER_ROW_ID = "needs-you:later";

const REASON_ICON = {
  approval: THREAD_ROW_STATUS_ICONS.approval,
  input: THREAD_ROW_STATUS_ICONS.input,
  request: THREAD_ROW_STATUS_ICONS.request,
  failed: THREAD_ROW_STATUS_ICONS.failed,
  limited: THREAD_ROW_STATUS_ICONS.failed,
} satisfies Record<NeedsYouReason, unknown>;

/** Listed threads already passed the snooze and settle checks, so only the kind of wait is left. */
function needsYouReasonOf(thread: EnvironmentThreadShell): NeedsYouReason {
  const status = resolveThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "request") return status;
  return threadFailureStatus(thread) ?? "failed";
}

function firstLine(text: string): string {
  return text.trimStart().split("\n", 1)[0] ?? "";
}

/** The thread's own approval, answered here unless the open thread's composer already offers it. */
function ApprovalRequest(props: {
  threadRef: ScopedThreadRef;
  icon: ReactNode;
  fallback: string;
  answerable: boolean;
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
  return (
    <>
      <RequestLine icon={props.icon}>
        <RequestSummary mono={approval?.detail !== undefined}>{summary}</RequestSummary>
      </RequestLine>
      {props.answerable && approval?.responseCapability === "live" ? (
        // Buttons answer the request; the row's own click opens the thread.
        <div className="flex items-center gap-3 ps-5 pt-1" onClick={stopRowActivation}>
          <ComposerPendingApprovalActions
            presentation="inline"
            requestId={approval.requestId}
            isResponding={responding}
            canRespond
            disabled={!canRespond}
            options={approval.options}
            onRespondToApproval={async (requestId, decision) => {
              if (!canRespond || responding) return;
              setResponding(true);
              setError(null);
              const result = await respond({
                environmentId: props.threadRef.environmentId,
                input: { threadId: props.threadRef.threadId, requestId, decision },
              });
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const failure = squashAtomCommandFailure(result);
                setError(
                  failure instanceof Error
                    ? failure.message
                    : t("Failed to submit approval decision."),
                );
              }
              setResponding(false);
              return result;
            }}
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
  const handleToggleLaterClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (props.placement === "box") props.onDecideLater(threadRef);
    else props.onPutBack(threadRef);
  };
  // Printable keys go to the composer (type to focus), so the row answers only Enter.
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || event.key !== "Enter") return;
    event.preventDefault();
    props.onOpen(threadRef);
  };
  const later = props.placement === "later";
  const laterLabel = later ? t("Move back to Needs you") : t("Decide later");
  const failure = reason === "failed" || reason === "limited";
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
            <span className="relative flex h-5 shrink-0 items-center justify-end text-xs text-muted-foreground tabular-nums">
              <span className="group-focus-within/needs-you-row:invisible group-any-hover/needs-you-row:invisible pointer-coarse:hidden">
                <WaitingSinceLabel since={props.since} />
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={laterLabel}
                      onClick={handleToggleLaterClick}
                      className="pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 whitespace-nowrap opacity-0 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-focus-within/needs-you-row:pointer-events-auto group-focus-within/needs-you-row:opacity-100 group-any-hover/needs-you-row:pointer-events-auto group-any-hover/needs-you-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100"
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
