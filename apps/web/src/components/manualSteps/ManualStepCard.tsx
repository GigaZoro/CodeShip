import {
  manualStepReviewFailureMessage,
  manualStepSolutionDecision,
  manualStepStartChatFailureMessage,
  sameManualStepDecision,
  type ManualStepChatHost,
} from "@t3tools/client-runtime/state/manualSteps";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  MANUAL_STEP_DECISION_MAX_LENGTH,
  type EnvironmentId,
  type ManualStep,
  type ManualStepDecision,
  type ManualStepReview,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { BotIcon, CircleDollarSignIcon, HandIcon } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import {
  useManualStepReview,
  useReviewAgain,
  useStartManualStepChat,
} from "../../state/manualSteps";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { CommandBlock } from "../CommandBlock";
import { WaitingSinceLabel } from "../sidebar/SidebarThreadRow";
import { openInSystemBrowser, useOpenThreadPageLink } from "../threadPage/threadPageLinks";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { t } from "~/i18n";

function Verdict(props: { readonly needsPerson: boolean }) {
  const Icon = props.needsPerson ? HandIcon : BotIcon;
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      {props.needsPerson ? t("Needs you") : t("An agent can do this")}
    </p>
  );
}

interface StepDecision {
  /** The decision whose chat is starting; every other choice waits for it. */
  readonly pending: ManualStepDecision | null;
  readonly failure: string | null;
  /** The chat this session already started for the step. */
  readonly started: ScopedThreadRef | null;
  readonly decide: (decision: ManualStepDecision) => void;
}

/** Sends a decision to `host` and opens the chat that carries it out. */
function useStepDecision(step: ManualStep, host: ManualStepChatHost | null): StepDecision | null {
  const { pending, started, start } = useStartManualStepChat(step);
  const navigate = useNavigate();
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  if (host === null) return null;
  const decide = (decision: ManualStepDecision) => {
    const starting = start(host.environmentId, decision);
    if (starting === null) return;
    setFailure(null);
    const chosenAt = router.state.location.pathname;
    void starting.then((result) => {
      if (result._tag === "Success") {
        // The chat opens only where the user chose; elsewhere the card links to it on their return.
        if (router.state.location.pathname !== chosenAt) return;
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: host.environmentId, threadId: result.value.threadId },
        });
      } else if (!isAtomCommandInterrupted(result)) {
        setFailure(manualStepStartChatFailureMessage(result.cause));
      }
    });
  };
  return { pending, failure, started, decide };
}

function SolutionList(props: {
  readonly solutions: ManualStepReview["solutions"];
  readonly decision: StepDecision | null;
}) {
  const { decision } = props;
  return (
    <ol className="grid gap-3">
      {props.solutions.map((solution, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- the model may repeat a title, so a solution is its position
        <li key={index} className="grid gap-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">
                {index + 1}. {solution.title}
              </span>
              {index === 0 ? (
                <Badge variant="info" size="sm">
                  {t("Recommended")}
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {solution.agentCanDo ? t("Agent can do it") : t("Only you")}
              </span>
            </div>
            {decision === null ? null : (
              <Button
                size="xs"
                variant="outline"
                aria-label={t("Choose: {solution}", { solution: solution.title })}
                disabled={decision.pending !== null}
                onClick={() => decision.decide(manualStepSolutionDecision(solution))}
              >
                {decision.pending !== null &&
                sameManualStepDecision(decision.pending, manualStepSolutionDecision(solution))
                  ? t("Starting chat…")
                  : t("Choose")}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{solution.detail}</p>
          {solution.command === undefined ? null : <CommandBlock wrap command={solution.command} />}
        </li>
      ))}
    </ol>
  );
}

/** The user's own decision, for when no suggested way fits. */
function OtherDecision(props: { readonly decision: StepDecision; readonly machine: string }) {
  const { decision } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputId = useId();
  const trimmed = text.trim();
  const sending = decision.pending?._tag === "Other";
  const send = () => {
    if (trimmed.length > 0) decision.decide({ _tag: "Other", text: trimmed });
  };
  const sendOnModEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    send();
  };
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={decision.pending !== null}
          onClick={() => setOpen(true)}
        >
          {t("Other…")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("Your choice starts a chat on {machine} that carries it out.", {
            machine: props.machine,
          })}
        </span>
      </div>
    );
  }
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Label htmlFor={inputId}>{t("Your decision")}</Label>
      <Textarea
        id={inputId}
        autoFocus
        rows={2}
        maxLength={MANUAL_STEP_DECISION_MAX_LENGTH}
        placeholder={t("Say what to do, in your own words.")}
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={sendOnModEnter}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="xs"
            disabled={trimmed.length === 0 || decision.pending !== null}
          >
            {sending ? t("Starting chat…") : t("Start chat")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={sending}
            onClick={() => setOpen(false)}
          >
            {t("Cancel")}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {text.length} / {MANUAL_STEP_DECISION_MAX_LENGTH}
        </span>
      </div>
    </form>
  );
}

/** Below the suggested ways: the user's own decision, the chat already started, and failures. */
function DecisionFooter(props: { readonly decision: StepDecision; readonly machine: string }) {
  const { decision } = props;
  return (
    <div className="grid gap-2">
      <OtherDecision decision={decision} machine={props.machine} />
      {decision.failure === null ? null : (
        <p role="alert" className="text-sm text-destructive-foreground">
          {decision.failure}
        </p>
      )}
      {decision.started === null ? null : (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          {t("A chat is carrying out your decision.")}
          <InlineButton
            tone="muted"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: decision.started.environmentId,
                  threadId: decision.started.threadId,
                }}
              />
            }
          >
            {t("Open that chat")}
          </InlineButton>
        </p>
      )}
    </div>
  );
}

function ReviewBody(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId;
  readonly decision: StepDecision | null;
}) {
  const { state, retry } = useManualStepReview(props.step, props.reviewEnvironmentId);
  if (state === null) return null;
  if (state.status === "loading") {
    return (
      <div role="status" className="grid gap-2">
        <p className="text-sm text-muted-foreground">{t("Reviewing…")}</p>
        <Skeleton aria-hidden className="h-3.5 w-4/5" />
        <Skeleton aria-hidden className="h-3.5 w-3/5" />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <p className="text-destructive-foreground">
          {manualStepReviewFailureMessage(state.reason)}
        </p>
        <Button size="xs" variant="outline" onClick={retry}>
          {t("Retry")}
        </Button>
      </div>
    );
  }
  const { review } = state;
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Verdict needsPerson={review.needsPerson} />
        <p className="text-sm text-muted-foreground">{review.summary}</p>
      </div>
      <SolutionList solutions={review.solutions} decision={props.decision} />
    </div>
  );
}

function ReviewedLabel(props: { readonly generatedAt: string }) {
  const nowMinute = useNowMinute();
  return t("Reviewed {time}", {
    time: formatRelativeTimeLabel(props.generatedAt, Date.parse(`${nowMinute}:00.000Z`)),
  });
}

function CardFooter(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
}) {
  const { step, reviewEnvironmentId } = props;
  const { state } = useManualStepReview(step, reviewEnvironmentId);
  const { allowed, running, reviewAgain } = useReviewAgain(step, reviewEnvironmentId);
  const openThreadPageLink = useOpenThreadPageLink();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
      {state?.status === "ready" ? (
        <span>
          <ReviewedLabel generatedAt={state.review.generatedAt} />
        </span>
      ) : null}
      {reviewEnvironmentId === null ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={!allowed || running || state?.status === "loading"}
          onClick={() => void reviewAgain()}
        >
          {running ? t("Reviewing…") : t("Review again")}
        </Button>
      )}
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          if (!openThreadPageLink(step.url)) openInSystemBrowser(step.url);
        }}
      >
        {t("Open in ThreadPage")}
      </Button>
      {step.chat ? (
        <InlineButton
          tone="muted"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: step.chat.environmentId, threadId: step.chat.threadId }}
            />
          }
        >
          {t("Open chat")}
        </InlineButton>
      ) : null}
    </div>
  );
}

/** Takes focus and scrolls into view when the Manual steps page was opened at this step. */
const showSelectedStep = (element: HTMLElement | null) => {
  if (element === null) return;
  element.scrollIntoView({ block: "start" });
  element.focus({ preventScroll: true });
};

/** One step with its review inline, on the Manual steps page. */
export function ManualStepCard(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId | null;
  /** The machine that runs the chat a decision starts; null when none can. */
  readonly chatHost: ManualStepChatHost | null;
  readonly selected: boolean;
}) {
  const { step } = props;
  const decision = useStepDecision(step, props.chatHost);
  const money = step.kind === "needs-you";
  const Icon = money ? CircleDollarSignIcon : HandIcon;
  const headingId = `manual-step-${step.threadId}`;
  return (
    <li className="list-none">
      <article
        ref={props.selected ? showSelectedStep : undefined}
        tabIndex={-1}
        aria-labelledby={headingId}
        data-manual-step={step.threadId}
        className={cn(
          "grid gap-3 rounded-2xl border bg-sidebar p-4 text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.selected ? "border-ring" : "border-border/70",
        )}
      >
        <header className="grid gap-1">
          <div className="flex min-w-0 items-start gap-2">
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                money ? "text-warning-foreground" : "text-muted-foreground",
              )}
            />
            <h3 id={headingId} className="min-w-0 flex-1 text-sm font-medium">
              {step.step}
            </h3>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-6 text-xs text-muted-foreground">
            {money ? (
              <span className="font-medium text-warning-foreground">{t("Money")}</span>
            ) : null}
            <span className="min-w-0 truncate">{step.title}</span>
            <span>{step.machine}</span>
            <span className="tabular-nums">
              {t("Waiting")} <WaitingSinceLabel since={Date.parse(step.updatedAt)} />
            </span>
          </div>
        </header>
        {props.reviewEnvironmentId === null ? null : (
          <ReviewBody
            step={step}
            reviewEnvironmentId={props.reviewEnvironmentId}
            decision={decision}
          />
        )}
        {decision === null || props.chatHost === null ? null : (
          <DecisionFooter decision={decision} machine={props.chatHost.machine} />
        )}
        <CardFooter step={step} reviewEnvironmentId={props.reviewEnvironmentId} />
      </article>
    </li>
  );
}
