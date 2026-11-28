import type {
  ToastManager,
  ToastManagerAddOptions,
  ToastManagerUpdateOptions,
  ToastObject,
} from "@base-ui/react/toast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const NOTICE_LOG_CAPACITY = 200;
export const NOTICE_COALESCE_WINDOW_MS = 60_000;

/**
 * Who raised a notice. Calls without a tag count as "user-action"; `t3code/require-toast-source`
 * keeps new calls from relying on that default so Settings > Diagnostics can name the emitters.
 */
export type NoticeSource =
  | "user-action"
  | "desktop-update"
  | "guide-run"
  | "host-freeze"
  | "keybindings-update"
  | "legacy-thread-migration"
  | "permission-update"
  | "project-clone"
  | "slow-rpc"
  | "thread-notification";

export interface NoticeData {
  source?: NoticeSource;
  /** Goes to the activity log instead of a toast: background information the user need not act on now. */
  quiet?: boolean;
  /** Set by the log when repeats coalesced into this toast. */
  repeatCount?: number;
  threadRef?: { readonly environmentId: string; readonly threadId: string } | null;
  threadId?: string | null;
  expandableContent?: ReactNode;
}

export type NoticeDelivery = "toast" | "activity-log";
/**
 * "dismissed": the user closed it (the X, Escape or a swipe). "auto-dismissed": it timed out.
 * "closed": the app closed it, or for an activity log entry, it resolved.
 */
export type NoticeOutcome = "open" | "clicked" | "dismissed" | "auto-dismissed" | "closed";

export interface NoticeRecord {
  readonly id: string;
  /** Which toast manager raised it; the stacked and anchored managers share one log. */
  readonly channel: string;
  readonly source: NoticeSource;
  readonly type: string;
  readonly delivery: NoticeDelivery;
  readonly threadKey: string | null;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly actionProps: ComponentPropsWithoutRef<"button"> | undefined;
  readonly expandableContent: ReactNode;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly count: number;
  readonly clicked: boolean;
  readonly outcome: NoticeOutcome;
  readonly endedAt: number | null;
}

export type NoticeEvent =
  | { readonly kind: "shown"; readonly record: NoticeRecord; readonly coalesced: boolean }
  | { readonly kind: "ended"; readonly record: NoticeRecord };

export interface NoticeClock {
  /** Wall clock, for the times the log shows. */
  readonly now: () => number;
  /** Monotonic clock, for the coalescing window. */
  readonly monotonicNow: () => number;
}

const defaultClock: NoticeClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
};

type ManagerAddOptions = ToastManagerAddOptions<NoticeData>;

function deliveryOf(data: NoticeData | undefined): NoticeDelivery {
  return data?.quiet === true ? "activity-log" : "toast";
}

function threadKeyOf(data: NoticeData | undefined): string | null {
  if (data?.threadRef) return `${data.threadRef.environmentId}:${data.threadRef.threadId}`;
  return data?.threadId ?? null;
}

function coalesceKeyOf(record: NoticeRecord): string | null {
  // Different messages from one emitter stay apart; only a string title can be compared.
  if (typeof record.title !== "string") return null;
  return [
    record.channel,
    record.delivery,
    record.source,
    record.threadKey ?? "",
    record.type,
    record.title,
  ].join("\u0000");
}

export interface NoticeLog {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<NoticeRecord>;
  readonly subscribeEvents: (listener: (event: NoticeEvent) => void) => () => void;
  /**
   * Records an add. Returns the id of another open notice it coalesced into, or null when it is
   * a new notice or an update of its own open id.
   */
  readonly add: (id: string, options: ManagerAddOptions, channel?: string) => string | null;
  readonly get: (id: string) => NoticeRecord | undefined;
  readonly updateDisplay: (id: string, updates: ToastManagerUpdateOptions<NoticeData>) => void;
  readonly markClicked: (id: string) => void;
  readonly end: (id: string, outcome: Exclude<NoticeOutcome, "open" | "clicked">) => void;
  /** The user is closing it in this event; the close it causes counts as "dismissed". */
  readonly markDismissing: (id: string) => void;
  readonly isDismissing: (id: string) => boolean;
  readonly lastSeenAt: () => number;
  readonly markSeen: () => void;
}

export function createNoticeLog(clock: NoticeClock = defaultClock): NoticeLog {
  let records: ReadonlyArray<NoticeRecord> = [];
  const lastRepeatAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: NoticeEvent) => void>();
  const dismissing = new Set<string>();
  let seenAt = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const emit = (event: NoticeEvent) => {
    for (const listener of eventListeners) listener(event);
  };
  const replace = (next: NoticeRecord) => {
    records = records.map((record) => (record.id === next.id ? next : record));
  };
  const get = (id: string) => records.find((record) => record.id === id);
  /** Drops the oldest ended notice first, so an ongoing one stays in the popover and updatable. */
  const trim = () => {
    if (records.length <= NOTICE_LOG_CAPACITY) return;
    const oldestEnded = records.findLastIndex((record) => record.outcome !== "open");
    const evict = oldestEnded === -1 ? records.length - 1 : oldestEnded;
    const evictedId = records[evict]?.id;
    records = records.filter((_, index) => index !== evict);
    if (evictedId !== undefined) lastRepeatAt.delete(evictedId);
  };

  const findCoalesceTarget = (candidate: NoticeRecord): NoticeRecord | undefined => {
    const key = coalesceKeyOf(candidate);
    if (key === null) return undefined;
    const at = clock.monotonicNow();
    return records.find(
      (record) =>
        record.outcome === "open" &&
        coalesceKeyOf(record) === key &&
        at - (lastRepeatAt.get(record.id) ?? -Infinity) <= NOTICE_COALESCE_WINDOW_MS,
    );
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => records,
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    get,
    add(id, options, channel = "toast") {
      const at = clock.now();
      const existing = get(id);
      const candidate: NoticeRecord = {
        id,
        channel,
        source: options.data?.source ?? "user-action",
        type: options.type ?? "default",
        delivery: deliveryOf(options.data),
        threadKey: threadKeyOf(options.data),
        title: options.title,
        description: options.description,
        actionProps: options.actionProps,
        expandableContent: options.data?.expandableContent,
        firstAt: existing?.firstAt ?? at,
        lastAt: at,
        count: 1,
        clicked: false,
        outcome: "open",
        endedAt: null,
      };
      if (existing?.outcome === "open" && existing.delivery === candidate.delivery) {
        // The caller updating its own notice: not a repeat.
        replace({
          ...candidate,
          firstAt: existing.firstAt,
          count: existing.count,
          clicked: existing.clicked,
        });
        notify();
        return null;
      }
      const target = options.id ? undefined : findCoalesceTarget(candidate);
      if (target) {
        const merged: NoticeRecord = {
          ...candidate,
          id: target.id,
          firstAt: target.firstAt,
          count: target.count + 1,
          clicked: target.clicked,
        };
        replace(merged);
        lastRepeatAt.set(target.id, clock.monotonicNow());
        notify();
        emit({ kind: "shown", record: merged, coalesced: true });
        return target.id;
      }
      records = [candidate, ...records.filter((record) => record.id !== id)];
      trim();
      lastRepeatAt.set(id, clock.monotonicNow());
      notify();
      emit({ kind: "shown", record: candidate, coalesced: false });
      return null;
    },
    updateDisplay(id, updates) {
      const record = get(id);
      if (!record) return;
      replace({
        ...record,
        ...(Object.hasOwn(updates, "title") ? { title: updates.title } : {}),
        ...(Object.hasOwn(updates, "description") ? { description: updates.description } : {}),
        ...(Object.hasOwn(updates, "type") ? { type: updates.type ?? record.type } : {}),
        ...(Object.hasOwn(updates, "actionProps") ? { actionProps: updates.actionProps } : {}),
        ...(updates.data && Object.hasOwn(updates.data, "expandableContent")
          ? { expandableContent: updates.data.expandableContent }
          : {}),
      });
      notify();
    },
    markClicked(id) {
      const record = get(id);
      if (!record || record.clicked) return;
      replace({ ...record, clicked: true });
      notify();
    },
    end(id, outcome) {
      const record = get(id);
      if (!record || record.outcome !== "open") return;
      const ended: NoticeRecord = {
        ...record,
        outcome: record.clicked ? "clicked" : outcome,
        endedAt: clock.now(),
      };
      replace(ended);
      notify();
      emit({ kind: "ended", record: ended });
    },
    markDismissing(id) {
      dismissing.add(id);
      // base-ui closes synchronously inside the same event, so the mark only has to last it.
      queueMicrotask(() => dismissing.delete(id));
    },
    isDismissing: (id) => dismissing.has(id),
    lastSeenAt: () => seenAt,
    markSeen() {
      seenAt = clock.now();
      notify();
    },
  };
}

export const noticeLog = createNoticeLog();

let nextNoticeId = 0;

/**
 * Records every notice in `log`, coalesces repeats into the open toast with a count, and keeps
 * quiet notices out of the toast stack (the activity log popover shows them instead).
 */
export function withNoticeLog<Data extends NoticeData>(
  manager: ToastManager<Data>,
  log: NoticeLog = noticeLog,
  channel = "toast",
): ToastManager<Data> {
  const wrapOnClose = (id: string, onClose: (() => void) | undefined) => (): void => {
    log.end(id, log.isDismissing(id) ? "dismissed" : "auto-dismissed");
    onClose?.();
  };

  const close = (id?: string) => {
    if (id === undefined) {
      for (const record of log.getSnapshot()) {
        if (record.channel === channel && record.delivery === "toast") log.end(record.id, "closed");
      }
      manager.close();
      return;
    }
    const record = log.get(id);
    log.end(id, log.isDismissing(id) ? "dismissed" : "closed");
    if (record?.delivery !== "activity-log") manager.close(id);
  };

  return {
    ...manager,
    add<T extends Data>(options: ToastManagerAddOptions<T>) {
      nextNoticeId += 1;
      const id = options.id ?? `notice-${nextNoticeId}`;
      const existing = options.id === undefined ? undefined : log.get(options.id);
      if (existing?.outcome === "open" && existing.delivery !== deliveryOf(options.data)) {
        // Moving between the toast stack and the log: end the old entry where it lives.
        close(id);
      }
      const targetId = log.add(id, options as ManagerAddOptions, channel) ?? id;
      const record = log.get(targetId);
      if (record?.delivery === "activity-log") return targetId;
      const repeatCount = record !== undefined && record.count > 1 ? record.count : undefined;
      // Adding an existing id upserts and restarts its timer, so a repeat stays up its full time.
      return manager.add({
        ...options,
        id: targetId,
        ...(repeatCount === undefined ? {} : { data: { ...options.data, repeatCount } as T }),
        onClose: wrapOnClose(targetId, options.onClose),
      });
    },
    update<T extends Data>(
      id: string,
      updates:
        | ToastManagerUpdateOptions<T>
        | ((prevToast: ToastObject<T>) => ToastManagerUpdateOptions<T>),
    ) {
      const record = log.get(id);
      if (record?.delivery === "activity-log") {
        const resolved =
          typeof updates === "function"
            ? updates({
                id,
                type: record.type,
                title: record.title,
                description: record.description,
                actionProps: record.actionProps,
                data: {
                  source: record.source,
                  quiet: true,
                  expandableContent: record.expandableContent,
                },
              } as ToastObject<T>)
            : updates;
        log.updateDisplay(id, resolved as ToastManagerUpdateOptions<NoticeData>);
        return;
      }
      if (typeof updates !== "function" && Object.hasOwn(updates, "onClose")) {
        manager.update(id, { ...updates, onClose: wrapOnClose(id, updates.onClose) });
        return;
      }
      manager.update(id, updates);
    },
    close,
  };
}

export interface NoticeEmitterSummary {
  readonly source: NoticeSource;
  /** Every add, repeats included. */
  readonly shown: number;
  readonly toasts: number;
  readonly logged: number;
  readonly clicked: number;
  readonly dismissed: number;
  readonly autoDismissed: number;
  readonly lastAt: number;
  readonly lastTitle: ReactNode;
}

/** Emitters by how many notices they raised, most first: the candidates to quiet down. */
export function summarizeNoticeEmitters(
  records: ReadonlyArray<NoticeRecord>,
): ReadonlyArray<NoticeEmitterSummary> {
  const bySource = new Map<NoticeSource, NoticeEmitterSummary>();
  for (const record of records) {
    const previous = bySource.get(record.source);
    const newer = previous === undefined || record.lastAt > previous.lastAt;
    bySource.set(record.source, {
      source: record.source,
      shown: (previous?.shown ?? 0) + record.count,
      toasts: (previous?.toasts ?? 0) + (record.delivery === "toast" ? record.count : 0),
      logged: (previous?.logged ?? 0) + (record.delivery === "activity-log" ? record.count : 0),
      clicked: (previous?.clicked ?? 0) + (record.clicked ? 1 : 0),
      dismissed: (previous?.dismissed ?? 0) + (record.outcome === "dismissed" ? 1 : 0),
      autoDismissed: (previous?.autoDismissed ?? 0) + (record.outcome === "auto-dismissed" ? 1 : 0),
      lastAt: newer ? record.lastAt : previous.lastAt,
      lastTitle: newer ? record.title : previous.lastTitle,
    });
  }
  return [...bySource.values()].sort((a, b) => b.shown - a.shown || b.lastAt - a.lastAt);
}
