import {
  manualStepsFailureMessage,
  type ManualStepGroup,
  type ManualStepsState,
  type ManualStepsView,
} from "@t3tools/client-runtime/state/manualSteps";
import type { ManualStep } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleDollarSignIcon, HandIcon } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { cn } from "../../lib/utils";
import { useManualSteps } from "../../state/manualSteps";
import { searchableSetting } from "../settings/settingsSearch";
import { WaitingSinceLabel } from "../sidebar/SidebarThreadRow";
import { openInSystemBrowser, useOpenThreadPageLink } from "../threadPage/threadPageLinks";
import { Button, InlineButton } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { t } from "~/i18n";

const MANUAL_STEPS_ROW_ID = "shelf:manual-steps";

/** Settings → Threads, at the ThreadPage token. */
function ConnectThreadPageLink(props: { readonly size?: "xs" | "sm" }) {
  return (
    <Button
      size={props.size ?? "sm"}
      variant="outline"
      render={<Link to="/settings/threads" hash={searchableSetting("threadpage-token").id} />}
    >
      {t("Connect ThreadPage")}
    </Button>
  );
}

function stopRowActivation(event: MouseEvent) {
  event.stopPropagation();
}

function useOpenManualStep() {
  const openThreadPageLink = useOpenThreadPageLink();
  return (step: ManualStep) => {
    if (!openThreadPageLink(step.url)) openInSystemBrowser(step.url);
  };
}

/** One step only the user can do; it opens its ThreadPage thread, whose newest note says how. */
function ManualStepRow(props: {
  readonly step: ManualStep;
  readonly parentRowId?: string;
  readonly onOpen: (step: ManualStep) => void;
}) {
  const { step } = props;
  const money = step.kind === "needs-you";
  const Icon = money ? CircleDollarSignIcon : HandIcon;
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    props.onOpen(step);
  };
  return (
    <li className="list-none">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`manual-step:${step.threadId}`}
        data-sidebar-parent={props.parentRowId}
        aria-label={[money ? t("Money decision") : null, step.step, step.title, step.machine]
          .filter(Boolean)
          .join(", ")}
        onClick={() => props.onOpen(step)}
        onKeyDown={handleKeyDown}
        className="cursor-pointer rounded-md px-2 py-1.5 text-left outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <Icon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              money ? "text-warning-foreground" : "text-muted-foreground",
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-sm">{step.step}</span>}
            />
            <TooltipPopup side="top">{step.step}</TooltipPopup>
          </Tooltip>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            <WaitingSinceLabel since={Date.parse(step.updatedAt)} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 ps-5 text-xs text-muted-foreground">
          {money ? (
            <span className="shrink-0 font-medium text-warning-foreground">{t("Money")}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{step.title}</span>
          {step.chat ? (
            <span className="shrink-0" onClick={stopRowActivation}>
              <InlineButton
                tone="muted"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId: step.chat.environmentId,
                      threadId: step.chat.threadId,
                    }}
                  />
                }
              >
                {t("Open chat")}
              </InlineButton>
            </span>
          ) : null}
          <span className="max-w-[40%] shrink-0 truncate">{step.machine}</span>
        </div>
      </div>
    </li>
  );
}

function ManualStepsSkeleton() {
  return (
    <div aria-hidden className="grid gap-2 px-2 py-1.5">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

/** The list's state: its rows, or why there are none. */
function ManualStepsBody(props: {
  readonly view: ManualStepsView;
  readonly onRetry: () => void;
  /** Labels each machine's rows; a narrow box shows the machine on each row instead. */
  readonly groupHeadings: boolean;
}) {
  const openStep = useOpenManualStep();
  const { view } = props;
  if (view.status === "loading") return <ManualStepsSkeleton />;
  if (view.status === "not-connected") {
    return (
      <div className="grid justify-items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <p>{t("Connect ThreadPage to see the steps only you can do, from every machine.")}</p>
        <ConnectThreadPageLink size="xs" />
      </div>
    );
  }
  if (view.status === "failed") {
    return (
      <div role="alert" className="grid justify-items-start gap-2 px-2 py-1.5 text-xs">
        <p className="text-destructive-foreground">{manualStepsFailureMessage(view.reason)}</p>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={props.onRetry}>
            {t("Retry")}
          </Button>
          {view.reason === "token-rejected" || view.reason === "access-denied" ? (
            <ConnectThreadPageLink size="xs" />
          ) : null}
        </div>
      </div>
    );
  }
  if (view.count === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {t("Nothing needs your hands right now")}
      </p>
    );
  }
  return (
    <ul
      ref={attachSidebarTree}
      role="tree"
      aria-label={t("Manual steps")}
      className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
    >
      {view.groups.map((group: ManualStepGroup) => (
        <li key={group.machine} className="list-none" role="none">
          {props.groupHeadings ? (
            <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              {group.machine}
            </h3>
          ) : null}
          <ul role="group" aria-label={group.machine} className="flex flex-col gap-px">
            {group.steps.map((step) => (
              <ManualStepRow key={step.threadId} step={step} onOpen={openStep} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function useManualStepsExpanded() {
  return useLocalStorage("t3code:manual-steps:expanded", true, Schema.Boolean);
}

/**
 * Shows only while a machine has a ThreadPage token and has answered, so a chat without
 * ThreadPage never flashes an empty box.
 */
function shownInPlace(state: ManualStepsState | null): state is ManualStepsState {
  return state !== null && (state.view.status === "listed" || state.view.status === "failed");
}

const countAccessory = (view: ManualStepsView) =>
  view.status === "listed" ? <span className="font-normal tabular-nums">{view.count}</span> : null;

/** Beside Needs you at the foot of the chat's details column. */
export function ManualStepsBox() {
  const { state, refresh } = useManualSteps();
  const [expanded, setExpanded] = useManualStepsExpanded();
  if (!shownInPlace(state)) return null;
  return (
    <section
      {...workspaceAreaProps("manual-steps", 7, t("Manual steps"))}
      className="flex min-h-0 shrink flex-col rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground shadow-sm"
    >
      <div className="flex shrink-0 items-center gap-1">
        <CollapsibleSectionHeader
          variant="panel"
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={countAccessory(state.view)}
        >
          {t("Manual steps")}
        </CollapsibleSectionHeader>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={t("Refresh manual steps")}
          disabled={state.refreshing}
          onClick={refresh}
        >
          <RefreshIcon refreshing={state.refreshing} />
        </Button>
      </div>
      {expanded ? (
        <ManualStepsBody view={state.view} onRetry={refresh} groupHeadings={false} />
      ) : null}
    </section>
  );
}

/** In the thread list, where narrow windows keep Needs you too. */
export function ManualStepsSidebarSection() {
  const { state, refresh } = useManualSteps();
  const openStep = useOpenManualStep();
  const [expanded, setExpanded] = useManualStepsExpanded();
  if (!shownInPlace(state)) return null;
  if (state.view.status === "listed" && state.view.count === 0) return null;
  return (
    <>
      <li className="mx-0.5 h-8 shrink-0 list-none">
        <CollapsibleSectionHeader
          role="treeitem"
          tabIndex={-1}
          data-sidebar-row={MANUAL_STEPS_ROW_ID}
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={countAccessory(state.view)}
        >
          {t("Manual steps")}
        </CollapsibleSectionHeader>
      </li>
      {expanded && state.view.status === "listed"
        ? state.view.groups.flatMap((group) =>
            group.steps.map((step) => (
              <ManualStepRow
                key={step.threadId}
                step={step}
                parentRowId={MANUAL_STEPS_ROW_ID}
                onOpen={openStep}
              />
            )),
          )
        : null}
      {expanded && state.view.status === "failed" ? (
        <li className="list-none">
          <ManualStepsBody view={state.view} onRetry={refresh} groupHeadings={false} />
        </li>
      ) : null}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
}

/** The whole list, for the Manual steps page. */
export function ManualStepsPageContent() {
  const { state, refresh } = useManualSteps();
  if (state === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No connected machine can read ThreadPage. Update T3.CodeShip on one of them.")}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Steps only you can do, from every machine's pending list in ThreadPage. Open one to see its newest note; replying there tells that machine to check it again.",
          )}
        </p>
        <Button size="sm" variant="outline" disabled={state.refreshing} onClick={refresh}>
          <RefreshIcon size="sm" refreshing={state.refreshing} />
          {t("Refresh")}
        </Button>
      </div>
      <div className="rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground">
        <ManualStepsBody view={state.view} onRetry={refresh} groupHeadings />
      </div>
    </div>
  );
}
