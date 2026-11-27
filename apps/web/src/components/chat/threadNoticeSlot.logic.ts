import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Most urgent first. A notice's tier decides whether it takes the slot and whether it is coloured. */
export const THREAD_NOTICE_TIERS = [
  "sendBlocking",
  "needsYou",
  "failure",
  "usageLimitRecovery",
  "providerStatus",
  "info",
] as const;

export type ThreadNoticeTier = (typeof THREAD_NOTICE_TIERS)[number];

/**
 * Every source of a thread notice, with the tier of its error notices and of the rest. A producer
 * exists only as a key here, so a new one cannot reach the slot without a rank.
 */
const PRODUCER_TIERS = {
  environmentUnavailable: { error: "sendBlocking", otherwise: "sendBlocking" },
  managedRuntimeMode: { error: "sendBlocking", otherwise: "sendBlocking" },
  branchMismatch: { error: "needsYou", otherwise: "needsYou" },
  queuedMessages: { error: "failure", otherwise: "info" },
  projectClone: { error: "failure", otherwise: "info" },
  serverUpdate: { error: "failure", otherwise: "info" },
  autoBalanceUpdate: { error: "failure", otherwise: "info" },
  feedback: { error: "failure", otherwise: "info" },
  usageLimitRecovery: { error: "usageLimitRecovery", otherwise: "usageLimitRecovery" },
  modelFallback: { error: "usageLimitRecovery", otherwise: "usageLimitRecovery" },
  usageLimits: { error: "info", otherwise: "info" },
} as const satisfies Record<
  string,
  { readonly error: ThreadNoticeTier; readonly otherwise: ThreadNoticeTier }
>;

export type ThreadNoticeProducer = keyof typeof PRODUCER_TIERS;

export type ThreadNotice = ComposerBannerStackItem & {
  readonly producer: ThreadNoticeProducer;
  /** What a screen reader hears when the notice takes the slot, for a title that is not text. */
  readonly announcement?: string;
};

type RankedNotice = Pick<ThreadNotice, "id" | "producer" | "variant">;

const COLOURED_TIERS: ReadonlySet<ThreadNoticeTier> = new Set([
  "sendBlocking",
  "needsYou",
  "failure",
]);

export function threadNoticeTier(notice: RankedNotice): ThreadNoticeTier {
  const tiers = PRODUCER_TIERS[notice.producer];
  return notice.variant === "error" ? tiers.error : tiers.otherwise;
}

/** Colour is kept for what blocks, needs or failed you; every other notice reads as neutral. */
export function threadNoticeVariant(notice: RankedNotice): ThreadNotice["variant"] {
  if (COLOURED_TIERS.has(threadNoticeTier(notice))) return notice.variant;
  return notice.variant === "error" || notice.variant === "warning" ? "default" : notice.variant;
}

/** The order notices first appeared in: equal tiers show the newest first. */
export interface ThreadNoticeAppearance {
  readonly next: number;
  readonly order: ReadonlyMap<string, number>;
}

export const EMPTY_THREAD_NOTICE_APPEARANCE: ThreadNoticeAppearance = {
  next: 0,
  order: new Map(),
};

/** The same object when the set of notices is unchanged, so a caller can skip a state update. */
export function nextThreadNoticeAppearance(
  previous: ThreadNoticeAppearance,
  ids: ReadonlyArray<string>,
): ThreadNoticeAppearance {
  // A repeated id counts once, as in the record, or the record would never settle.
  const unique = new Set(ids);
  const unchanged =
    unique.size === previous.order.size && [...unique].every((id) => previous.order.has(id));
  if (unchanged) return previous;
  let next = previous.next;
  const order = new Map<string, number>();
  for (const id of ids) {
    if (order.has(id)) continue;
    order.set(id, previous.order.get(id) ?? next++);
  }
  return { next, order };
}

export interface ThreadNoticeSlot<N extends RankedNotice> {
  readonly top: N | null;
  /** The rest, most urgent first. */
  readonly rest: ReadonlyArray<N>;
  /** The most urgent tier among the rest, so a hidden error never reads as a bare count. */
  readonly restTier: ThreadNoticeTier | null;
}

export function resolveThreadNoticeSlot<N extends RankedNotice>(
  notices: ReadonlyArray<N>,
  appearance: ReadonlyMap<string, number>,
): ThreadNoticeSlot<N> {
  const ranked = notices
    .map((notice) => ({
      notice,
      tier: THREAD_NOTICE_TIERS.indexOf(threadNoticeTier(notice)),
      // A notice not yet recorded arrived this render, so it is the newest.
      seen: appearance.get(notice.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .toSorted((a, b) => a.tier - b.tier || b.seen - a.seen);
  const [first, ...rest] = ranked;
  return {
    top: first?.notice ?? null,
    rest: rest.map((entry) => entry.notice),
    restTier: rest[0] ? (THREAD_NOTICE_TIERS[rest[0].tier] ?? null) : null,
  };
}
