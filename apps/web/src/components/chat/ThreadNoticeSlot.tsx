import { useState } from "react";

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

/** One notice, never a stack, so the composer keeps its height as notices come and go. */
export function ThreadNoticeSlot({
  slot,
  detached = false,
}: {
  readonly slot: ResolvedThreadNoticeSlot;
  readonly detached?: boolean;
}) {
  const { top, rest, restTier } = slot;
  if (top === null) return null;
  const item = withTierColour(top);
  return (
    <ComposerBannerStack
      detached={detached}
      items={[
        restTier === null
          ? item
          : {
              ...item,
              actions: (
                <>
                  {item.actions}
                  <MoreNotices rest={rest} restTier={restTier} />
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
}: {
  readonly rest: ReadonlyArray<ThreadNotice>;
  readonly restTier: ThreadNoticeTier;
}) {
  const tierLabel = TIER_LABELS[restTier];
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            data-testid="thread-notice-more"
            aria-label={
              tierLabel === null
                ? tn(rest.length, "Show {count} more notice", "Show {count} more notices")
                : tn(
                    rest.length,
                    "Show {count} more notice, most urgent: {tier}",
                    "Show {count} more notices, most urgent: {tier}",
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
