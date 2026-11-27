import type { WhileAwaySummary } from "@t3tools/client-runtime/state/needs-you-triage";
import { BellDotIcon, CircleCheckIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { attachTriageTree } from "../../lib/sidebarTree";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { t, tn } from "~/i18n";
import { cn } from "~/lib/utils";
import { OWNS_LETTER_KEYS_ATTRIBUTE } from "../chat/composerFocusRedirect";
import { InlineButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import {
  FINISHED_NOT_SEEN_ROW_ID,
  handleTriageKeyDown,
  NEEDS_YOU_LATER_ROW_ID,
} from "./NeedsYouBoxRow";
import { SidebarNeedsYouHeader } from "./SidebarListMarkers";

/**
 * The box under the chat: what changed while the user was away, what needs them, what they put
 * off, and what finished that they have not seen. Only the Needs you rows count for the badge.
 */
export function SidebarNeedsYouPanel(props: {
  rows: readonly ReactNode[];
  laterRows: readonly ReactNode[];
  finishedRows: readonly ReactNode[];
  onSettleAllFinished: () => void;
  whileAway: WhileAwaySummary | null;
  onCaughtUp: () => void;
}) {
  const [laterOpen, setLaterOpen] = useState(false);
  const [finishedOpen, setFinishedOpen] = useState(true);
  const needsYou = props.rows.length + props.laterRows.length > 0;
  return (
    <section
      {...workspaceAreaProps("needs-you", 6, t("Needs you"))}
      {...{ [OWNS_LETTER_KEYS_ATTRIBUTE]: "" }}
      className={cn(
        "group/needs-you flex min-h-0 flex-col rounded-2xl border bg-sidebar p-1.5 text-sidebar-foreground shadow-sm",
        needsYou ? "border-warning/40" : "border-border",
      )}
    >
      {props.whileAway ? (
        <WhileAwayStrip summary={props.whileAway} onCaughtUp={props.onCaughtUp} />
      ) : null}
      {needsYou ? (
        <ul className="shrink-0">
          <SidebarNeedsYouHeader count={props.rows.length} />
        </ul>
      ) : null}
      <ul
        ref={attachTriageTree}
        role="tree"
        aria-label={t("Threads needing you")}
        className="flex min-h-0 flex-col gap-px overflow-y-auto overscroll-contain"
      >
        {props.rows}
        {props.laterRows.length > 0 ? (
          <>
            <GroupRow
              id={NEEDS_YOU_LATER_ROW_ID}
              divided={props.rows.length > 0}
              open={laterOpen}
              onToggle={() => setLaterOpen((open) => !open)}
              label={t("Later")}
              count={props.laterRows.length}
            />
            {laterOpen ? props.laterRows : null}
          </>
        ) : null}
        {props.finishedRows.length > 0 ? (
          <>
            <GroupRow
              id={FINISHED_NOT_SEEN_ROW_ID}
              divided={needsYou}
              open={finishedOpen}
              onToggle={() => setFinishedOpen((open) => !open)}
              onSettle={props.onSettleAllFinished}
              label={t("Finished, not seen")}
              count={props.finishedRows.length}
              action={
                <InlineButton
                  tone="muted"
                  aria-label={tn(
                    props.finishedRows.length,
                    "Settle {count} finished thread",
                    "Settle all {count} finished threads",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onSettleAllFinished();
                  }}
                >
                  {t("Settle all")}
                </InlineButton>
              }
            />
            {finishedOpen ? props.finishedRows : null}
          </>
        ) : null}
      </ul>
      <TriageHint />
    </section>
  );
}

/** A collapsible group heading inside the box's tree. */
function GroupRow(props: {
  id: string;
  divided: boolean;
  open: boolean;
  onToggle: () => void;
  onSettle?: () => void;
  label: string;
  count: number;
  action?: ReactNode;
}) {
  const handleKeyDown = (event: KeyboardEvent) =>
    handleTriageKeyDown(event, { open: props.onToggle, settle: props.onSettle });
  return (
    <li className={cn("list-none", props.divided && "mt-1 border-t border-border/60 pt-1")}>
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={props.id}
        aria-expanded={props.open}
        onClick={props.onToggle}
        onKeyDown={handleKeyDown}
        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0", props.open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.action}
        <span className="tabular-nums">{props.count}</span>
      </div>
    </li>
  );
}

/** What changed while the user was away, until they say they have caught up. */
function WhileAwayStrip(props: { summary: WhileAwaySummary; onCaughtUp: () => void }) {
  const { blocked, finished, recovered } = props.summary;
  return (
    <div className="mb-1 flex shrink-0 items-start gap-2 rounded-xl bg-sidebar-row-hover/60 px-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("While you were away")}</p>
        <ul className="text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <BellDotIcon aria-hidden className="size-3.5 shrink-0" />
            {tn(blocked, "{count} needs you now", "{count} need you now")}
          </li>
          <li className="flex items-center gap-1.5">
            <CircleCheckIcon aria-hidden className="size-3.5 shrink-0" />
            {tn(finished, "{count} finished", "{count} finished")}
          </li>
          <li className="flex items-center gap-1.5">
            <RotateCcwIcon aria-hidden className="size-3.5 shrink-0" />
            {t("Recovered ({count})", { count: recovered })}
          </li>
        </ul>
      </div>
      <InlineButton tone="muted" onClick={props.onCaughtUp}>
        {t("Caught up")}
      </InlineButton>
    </div>
  );
}

const HINT_KEYS = [
  ["J K", "move"],
  ["A", "approve"],
  ["D", "decline"],
  ["L", "later"],
  ["E", "settle"],
  ["↵", "open"],
  ["Esc", "leave"],
] as const;

/** Shown while focus is in the box; it keeps its line otherwise, so the rows never move. */
function TriageHint() {
  const labels = {
    move: t("move"),
    approve: t("approve"),
    decline: t("decline"),
    later: t("later"),
    settle: t("settle"),
    open: t("open"),
    leave: t("leave"),
  };
  return (
    <p className="invisible flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pt-1 text-2xs text-muted-foreground group-focus-within/needs-you:visible">
      {HINT_KEYS.map(([key, action]) => (
        <span key={action} className="inline-flex items-center gap-1">
          <Kbd>{key}</Kbd>
          {labels[action]}
        </span>
      ))}
    </p>
  );
}
