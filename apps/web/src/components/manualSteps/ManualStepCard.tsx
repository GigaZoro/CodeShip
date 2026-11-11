import { manualStepReviewFailureMessage } from "@t3tools/client-runtime/state/manualSteps";
import type { EnvironmentId, ManualStep, ManualStepReview } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BotIcon, CircleDollarSignIcon, HandIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useManualStepReview, useReviewAgain } from "../../state/manualSteps";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { CommandBlock } from "../CommandBlock";
import { WaitingSinceLabel } from "../sidebar/SidebarThreadRow";
import { openInSystemBrowser, useOpenThreadPageLink } from "../threadPage/threadPageLinks";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
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

function SolutionList(props: { readonly solutions: ManualStepReview["solutions"] }) {
  return (
    <ol className="grid gap-3">
      {props.solutions.map((solution, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- the model may repeat a title, so a solution is its position
        <li key={index} className="grid gap-1.5">
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
          <p className="text-sm text-muted-foreground">{solution.detail}</p>
          {solution.command === undefined ? null : <CommandBlock wrap command={solution.command} />}
        </li>
      ))}
    </ol>
  );
}

function ReviewBody(props: {
  readonly step: ManualStep;
  readonly reviewEnvironmentId: EnvironmentId;
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
      <SolutionList solutions={review.solutions} />
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
  readonly selected: boolean;
}) {
  const { step } = props;
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
          <ReviewBody step={step} reviewEnvironmentId={props.reviewEnvironmentId} />
        )}
        <CardFooter step={step} reviewEnvironmentId={props.reviewEnvironmentId} />
      </article>
    </li>
  );
}
