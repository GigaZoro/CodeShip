import { Fragment, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { msg, t, tn } from "~/i18n";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  EMPTY_THREAD_NOTICE_APPEARANCE,
  nextThreadNoticeAppearance,
  resolveThreadNoticeSlot,
  threadNoticeTier,
  threadNoticeVariant,
  type ThreadNotice,
  type ThreadNoticeSlot as ResolvedSlot,
  type ThreadNoticeTier,
} from "./threadNoticeSlot.logic";

const TIER_LABELS = {
  sendBlocking: msg("Can't send"),
  needsYou: msg("Needs you"),
  failure: msg("Failed"),
  usageLimitRecovery: msg("Usage limit"),
  providerStatus: msg("Provider status"),
  info: null,
} as const satisfies Record<ThreadNoticeTier, ReturnType<typeof msg> | null>;

export type ResolvedThreadNoticeSlot = ResolvedSlot<ThreadNotice>;

/** Ranks the thread's notices; the slot shows the most urgent and keeps the rest behind a count. */
export function useThreadNoticeSlot(
  notices: ReadonlyArray<ThreadNotice>,
): ResolvedThreadNoticeSlot {
  const [appearance, setAppearance] = useState(EMPTY_THREAD_NOTICE_APPEARANCE);
  const nextAppearance = nextThreadNoticeAppearance(
    appearance,
    notices.map((notice) => notice.id),
  );
  if (nextAppearance !== appearance) setAppearance(nextAppearance);
  return resolveThreadNoticeSlot(notices, nextAppearance.order);
}

function withTierColour(notice: ThreadNotice): ComposerBannerStackItem {
  return { ...notice, variant: threadNoticeVariant(notice) };
}

const SLOT_ID = "thread-notice-slot";

const FOCUSABLE = "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * One notice, never a stack, so the composer keeps its height as notices come and go. The card
 * keeps its identity as the top notice changes, so an open list of the rest stays open.
 */
export function ThreadNoticeSlot({
  slot,
  detached = false,
  onFocusLost,
}: {
  readonly slot: ResolvedThreadNoticeSlot;
  readonly detached?: boolean;
  /** Where focus goes when the list of the rest empties under it and the card has no control. */
  readonly onFocusLost?: () => void;
}) {
  const { top, rest, restTier } = slot;
  const [moreOpen, setMoreOpen] = useState(false);
  const [emptiedWhileOpen, setEmptiedWhileOpen] = useState(0);
  const cardRef = useRef<HTMLElement | null>(null);
  if (restTier === null && moreOpen) {
    setMoreOpen(false);
    setEmptiedWhileOpen((count) => count + 1);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list unmounted with focus inside it; only the DOM knows focus fell to the page
  useLayoutEffect(() => {
    if (emptiedWhileOpen === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const card = cardRef.current;
    const control = card?.isConnected ? card.querySelector<HTMLElement>(FOCUSABLE) : null;
    if (control) control.focus();
    else onFocusLost?.();
  }, [emptiedWhileOpen, onFocusLost]);

  if (top === null) return null;
  const item = withTierColour(top);
  return (
    <ComposerBannerStack
      detached={detached}
      items={[
        {
          ...item,
          id: SLOT_ID,
          // Keyed by notice, so one notice's controls never carry another's state.
          children:
            item.children === undefined ? undefined : (
              <Fragment key={top.id}>{item.children}</Fragment>
            ),
          actions:
            restTier === null && item.actions === undefined ? undefined : (
              <>
                <Fragment key={top.id}>{item.actions}</Fragment>
                {restTier === null ? null : (
                  <MoreNotices
                    rest={rest}
                    restTier={restTier}
                    open={moreOpen}
                    onOpenChange={setMoreOpen}
                    cardRef={cardRef}
                  />
                )}
              </>
            ),
        },
      ]}
    />
  );
}

function MoreNotices({
  rest,
  restTier,
  open,
  onOpenChange,
  cardRef,
}: {
  readonly rest: ReadonlyArray<ThreadNotice>;
  readonly restTier: ThreadNoticeTier;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly cardRef: RefObject<HTMLElement | null>;
}) {
  const tierLabel = TIER_LABELS[restTier];
  const popupRef = useRef<HTMLDivElement>(null);
  const restIds = rest.map((notice) => notice.id).join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a notice in the open list went away with focus on its control; only the DOM knows focus fell to the page
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (open && (active === null || active === document.body)) popupRef.current?.focus();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a change in the list is what can take focus with it.
  }, [open, restIds]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            ref={(button: HTMLButtonElement | null) => {
              // Kept after the counter unmounts: that is when focus may need the card.
              if (button)
                cardRef.current = button.closest<HTMLElement>("[data-slot=composer-banner]");
            }}
            size="xs"
            variant="ghost"
            data-testid="thread-notice-more"
            // Starts with the visible "+N" so speech input can name it.
            aria-label={
              tierLabel === null
                ? tn(rest.length, "+{count} more notice", "+{count} more notices")
                : tn(
                    rest.length,
                    "+{count} more notice, most urgent: {tier}",
                    "+{count} more notices, most urgent: {tier}",
                    { tier: t(tierLabel) },
                  )
            }
          />
        }
      >
        <span className="tabular-nums">{`+${rest.length}`}</span>
        {tierLabel === null ? null : (
          <>
            <ComposerBanner.Separator />
            <span>{t(tierLabel)}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup
        ref={popupRef}
        tabIndex={-1}
        aria-label={t("Other notices")}
        side="top"
        align="end"
        padding="compact"
        className="w-[min(32rem,calc(100vw-2rem))]"
      >
        <ComposerBanner.Scroll>
          <div className="flex flex-col gap-1">
            {rest.map((notice) => (
              // One stack per notice: a stack groups by machine, and this list keeps rank order.
              <ComposerBannerStack key={notice.id} items={[withTierColour(notice)]} detached />
            ))}
          </div>
        </ComposerBanner.Scroll>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Announces the slot's notice when it changes, and nothing about the notices behind it. It stays
 * mounted while the slot is empty, since a live region that appears with its text is not read.
 */
export function ThreadNoticeStatus({ slot }: { readonly slot: ResolvedThreadNoticeSlot }) {
  const { top } = slot;
  const tierLabel = top === null ? null : TIER_LABELS[threadNoticeTier(top)];
  const text =
    top === null
      ? null
      : (top.announcement ??
        (typeof top.title === "string" ? top.title : tierLabel === null ? null : t(tierLabel)));
  return (
    <span role="status" className="sr-only">
      {text}
    </span>
  );
}
