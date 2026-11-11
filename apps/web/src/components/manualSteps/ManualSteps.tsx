import {
  manualStepsFailureMessage,
  detectedManualStepKey,
  type DetectedManualStepEntry,
  type ManualStepGroup,
  type ManualStepsState,
  type ManualStepsView,
} from "@t3tools/client-runtime/state/manualSteps";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, EnvironmentId, ManualStep } from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { BotIcon, CircleDollarSignIcon, HandIcon, KeyRoundIcon } from "lucide-react";
import { useId, type KeyboardEvent, type MouseEvent } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { attachSidebarTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { cn } from "../../lib/utils";
import { useManualStepReview, useManualSteps } from "../../state/manualSteps";
import { searchableSetting } from "../settings/settingsSearch";
import { WaitingSinceLabel } from "../sidebar/SidebarThreadRow";
import { detectedStepText, useOpenDetectedStep } from "./detectedManualStep";
import { Button, InlineButton } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { MenuCheckboxItem, MenuSeparator } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ManualStepCard } from "./ManualStepCard";
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

/** Shown when the review says an agent can do the step without the user. */
function AgentCanDoMarker() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 text-muted-foreground">
            <BotIcon aria-hidden className="size-3.5" />
            <span className="sr-only">{t("An agent can do this.")}</span>
          </span>
        }
      />
      <TooltipPopup side="top">{t("An agent can do this. See the review.")}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One step only the user can do; it opens the Manual steps page at its review. The row asks for
 * its own review, so every listed step is reviewed and only this row re-renders when one arrives.
 */
function ManualStepRow(props: {
  readonly step: ManualStep;
  readonly parentRowId?: string;
  /** False under the machine's own heading, which already names it. */
  readonly showMachine?: boolean;
  readonly reviewEnvironmentId: EnvironmentId | null;
}) {
  const { step } = props;
  const machine = props.showMachine === false ? null : step.machine;
  const navigate = useNavigate();
  const review = useManualStepReview(step, props.reviewEnvironmentId).state;
  const agentCanDo = review?.status === "ready" && !review.review.needsPerson;
  const openStep = () => void navigate({ to: "/manual-steps", search: { step: step.threadId } });
  const money = step.kind === "needs-you";
  const Icon = money ? CircleDollarSignIcon : HandIcon;
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    openStep();
  };
  return (
    <li className="list-none">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`manual-step:${step.threadId}`}
        data-sidebar-parent={props.parentRowId}
        aria-label={[
          money ? t("Money decision") : null,
          agentCanDo ? t("An agent can do this.") : null,
          step.step,
          step.title,
          machine,
        ]
          .filter(Boolean)
          .join(", ")}
        onClick={openStep}
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
          {agentCanDo ? <AgentCanDoMarker /> : null}
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
          {machine ? <span className="max-w-[40%] shrink-0 truncate">{machine}</span> : null}
        </div>
      </div>
    </li>
  );
}

/** A sign-in this machine noticed itself; the button opens the account or MCP server that fixes it. */
function DetectedStepRow(props: {
  readonly entry: DetectedManualStepEntry;
  readonly parentRowId?: string;
  /** False under the machine's own heading, which already names it. */
  readonly showMachine?: boolean;
  readonly onOpen: (entry: DetectedManualStepEntry) => void;
}) {
  const { entry } = props;
  const machine = props.showMachine === false ? null : entry.step.machine;
  const text = detectedStepText(entry);
  const lapsed = entry.step.kind === "login-expired";
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    props.onOpen(entry);
  };
  return (
    <li className="list-none">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`detected-step:${detectedManualStepKey(entry)}`}
        data-sidebar-parent={props.parentRowId}
        aria-label={[text.step, text.detail, machine].filter(Boolean).join(", ")}
        onClick={() => props.onOpen(entry)}
        onKeyDown={handleKeyDown}
        className="cursor-pointer rounded-md px-2 py-1.5 text-left outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <KeyRoundIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              lapsed ? "text-destructive-foreground" : "text-warning-foreground",
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 flex-1 truncate text-sm">{text.step}</span>}
            />
            <TooltipPopup side="top">{text.step}</TooltipPopup>
          </Tooltip>
          <span className="shrink-0" onClick={stopRowActivation}>
            <Button size="xs" variant="outline" onClick={() => props.onOpen(entry)}>
              {t("Sign in")}
            </Button>
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 ps-5 text-xs text-muted-foreground">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              lapsed ? "font-medium text-destructive-foreground" : "",
            )}
          >
            {text.detail}
          </span>
          {machine ? <span className="max-w-[40%] shrink-0 truncate">{machine}</span> : null}
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

/** Detected sign-ins can list while ThreadPage fails; this says why its steps are missing. */
function ThreadPageIssueNote(props: { readonly view: ManualStepsView }) {
  if (props.view.status !== "listed" || props.view.threadPageIssue === undefined) return null;
  return (
    <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
      {t("ThreadPage steps are not shown. {reason}", {
        reason: manualStepsFailureMessage(props.view.threadPageIssue),
      })}
    </p>
  );
}

/** The list's state: its rows, or why there are none. */
function ManualStepsBody(props: {
  readonly view: ManualStepsView;
  readonly onRetry: () => void;
  /** Labels each machine's rows; a narrow box shows the machine on each row instead. */
  readonly groupHeadings: boolean;
}) {
  const openDetected = useOpenDetectedStep();
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
    <>
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
              {group.detected.map((entry) => (
                <DetectedStepRow
                  key={detectedManualStepKey(entry)}
                  entry={entry}
                  showMachine={!props.groupHeadings}
                  onOpen={openDetected}
                />
              ))}
              {group.steps.map((step) => (
                <ManualStepRow
                  key={step.threadId}
                  step={step}
                  showMachine={!props.groupHeadings}
                  reviewEnvironmentId={view.reviewEnvironmentId}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <ThreadPageIssueNote view={view} />
    </>
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

/** Hiding only removes these placements; the Manual steps page keeps the list. */
const showMenu = async (position: { x: number; y: number }) => {
  const api = readLocalApi();
  if (!api) return;
  const items: ContextMenuItem<"hide">[] = [{ id: "hide", label: t("Hide Manual steps") }];
  const clicked = await settlePromise(() => api.contextMenu.show(items, position));
  if (clicked._tag === "Failure" || clicked.value !== "hide") return;
  void updateClientSettings({ sidebarManualStepsEnabled: false });
  toastManager.add({
    type: "info",
    title: t("Manual steps hidden"),
    description: t(
      "They stay on the Manual steps page in the sidebar rail. Show them here again from Details → Choose what to show.",
    ),
    actionProps: {
      children: t("Undo"),
      onClick: () => void updateClientSettings({ sidebarManualStepsEnabled: true }),
    },
  });
};
const onContextMenu = (event: MouseEvent) => {
  event.preventDefault();
  void showMenu({ x: event.clientX, y: event.clientY });
};
const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  void showMenu({ x: rect.left, y: rect.bottom });
};

const hideManualStepsMenu = { onContextMenu, onKeyDown };

/** Turns the list under Needs you on and off from the thread details menu, while there is one. */
export function ManualStepsMenuItems() {
  const { state } = useManualSteps();
  const enabled = useClientSettings((s) => s.sidebarManualStepsEnabled);
  if (!shownInPlace(state)) return null;
  return (
    <>
      <MenuSeparator />
      <MenuCheckboxItem
        checked={enabled}
        onCheckedChange={(checked) =>
          void updateClientSettings({ sidebarManualStepsEnabled: checked })
        }
      >
        {t("Manual steps under Needs you")}
      </MenuCheckboxItem>
    </>
  );
}

/** Beside Needs you at the foot of the chat's details column. */
export function ManualStepsBox() {
  const { state, refresh } = useManualSteps();
  const [expanded, setExpanded] = useManualStepsExpanded();
  const enabled = useClientSettings((s) => s.sidebarManualStepsEnabled);
  if (!enabled || !shownInPlace(state)) return null;
  return (
    <section
      {...workspaceAreaProps("manual-steps", 7, t("Manual steps"))}
      className="flex min-h-0 shrink flex-col rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground shadow-sm"
    >
      <div className="flex shrink-0 items-center gap-1">
        <CollapsibleSectionHeader
          variant="panel"
          {...hideManualStepsMenu}
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
  const openDetected = useOpenDetectedStep();
  const [expanded, setExpanded] = useManualStepsExpanded();
  const enabled = useClientSettings((s) => s.sidebarManualStepsEnabled);
  if (!enabled || !shownInPlace(state)) return null;
  if (state.view.status === "listed" && state.view.count === 0) return null;
  const reviewEnvironmentId =
    state.view.status === "listed" ? state.view.reviewEnvironmentId : null;
  return (
    <>
      <li className="mx-0.5 h-8 shrink-0 list-none">
        <CollapsibleSectionHeader
          role="treeitem"
          tabIndex={-1}
          data-sidebar-row={MANUAL_STEPS_ROW_ID}
          {...hideManualStepsMenu}
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          accessory={countAccessory(state.view)}
        >
          {t("Manual steps")}
        </CollapsibleSectionHeader>
      </li>
      {expanded && state.view.status === "listed"
        ? state.view.groups.flatMap((group) => [
            ...group.detected.map((entry) => (
              <DetectedStepRow
                key={detectedManualStepKey(entry)}
                entry={entry}
                parentRowId={MANUAL_STEPS_ROW_ID}
                onOpen={openDetected}
              />
            )),
            ...group.steps.map((step) => (
              <ManualStepRow
                key={step.threadId}
                step={step}
                parentRowId={MANUAL_STEPS_ROW_ID}
                reviewEnvironmentId={reviewEnvironmentId}
              />
            )),
          ])
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

function ManualStepsMachineSection(props: {
  readonly group: ManualStepGroup;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly selectedThreadId: string | undefined;
}) {
  const { group } = props;
  const headingId = useId();
  const openDetected = useOpenDetectedStep();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="px-1 pb-2 text-xs font-medium text-muted-foreground">
        {group.machine}
      </h2>
      {group.detected.length > 0 ? (
        <ul
          ref={attachSidebarTree}
          role="tree"
          aria-label={t("Sign-ins on {machine}", { machine: group.machine })}
          className="mb-3 flex flex-col gap-px rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground"
        >
          {group.detected.map((entry) => (
            <DetectedStepRow
              key={detectedManualStepKey(entry)}
              entry={entry}
              showMachine={false}
              onOpen={openDetected}
            />
          ))}
        </ul>
      ) : null}
      <ul className="flex flex-col gap-3">
        {group.steps.map((step) => (
          <ManualStepCard
            key={step.threadId}
            step={step}
            reviewEnvironmentId={props.reviewEnvironmentId}
            selected={step.threadId === props.selectedThreadId}
          />
        ))}
      </ul>
    </section>
  );
}

/** Every step with its review, grouped by machine. */
function ManualStepsPageList(props: {
  readonly groups: ReadonlyArray<ManualStepGroup>;
  readonly reviewEnvironmentId: EnvironmentId | null;
  readonly selectedThreadId: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      {props.groups.map((group) => (
        <ManualStepsMachineSection
          key={group.machine}
          group={group}
          reviewEnvironmentId={props.reviewEnvironmentId}
          selectedThreadId={props.selectedThreadId}
        />
      ))}
    </div>
  );
}

/** The whole list, for the Manual steps page. */
export function ManualStepsPageContent() {
  const { state, refresh } = useManualSteps();
  const { step: selectedThreadId } = useSearch({ from: "/_chat/manual-steps" });
  if (state === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No connected machine can read ThreadPage. Update T3.CodeShip on one of them.")}
      </p>
    );
  }
  const { view } = state;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(
            "Steps only you can do. Sign-ins each machine notices itself come first; the rest are every machine's pending list in ThreadPage, each reviewed for whether it needs you, with ways to get it done. Replying in a step's ThreadPage thread tells that machine to check it again.",
          )}
        </p>
        <Button size="sm" variant="outline" disabled={state.refreshing} onClick={refresh}>
          <RefreshIcon size="sm" refreshing={state.refreshing} />
          {t("Refresh")}
        </Button>
      </div>
      {view.status === "listed" && view.count > 0 ? (
        <>
          <ManualStepsPageList
            groups={view.groups}
            reviewEnvironmentId={view.reviewEnvironmentId}
            selectedThreadId={selectedThreadId}
          />
          <ThreadPageIssueNote view={view} />
        </>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-sidebar p-1.5 text-sidebar-foreground">
          <ManualStepsBody view={view} onRetry={refresh} groupHeadings />
        </div>
      )}
    </div>
  );
}
