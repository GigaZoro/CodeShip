import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

export type ThreadUndoClaim = ReturnType<typeof ThreadUndo.begin>;

type UndoNotice = {
  readonly action: "Settled" | "Snoozed" | "Unpinned";
  /** More than one thread: "Settle all" lists one notice for the batch. */
  readonly count?: number;
  readonly durationMs?: number;
  readonly claim: ThreadUndoClaim;
  readonly undo: () => Promise<void>;
};

const UNDO_NOTICE_MS = 5_000;
export const BULK_UNDO_NOTICE_MS = 8_000;

let notice: UndoNotice | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
let screenReaderEnabled = false;
const listeners = new Set<() => void>();

// A screen reader user needs longer than a timer allows to reach Undo (WCAG 2.2.1), so the
// notice then stays until it is used, dismissed, or replaced.
function armExpiry() {
  clearTimeout(expiry);
  if (notice !== null && !screenReaderEnabled)
    expiry = setTimeout(dismissThreadUndoNotice, notice.durationMs ?? UNDO_NOTICE_MS);
}

function setScreenReaderEnabled(enabled: boolean) {
  if (screenReaderEnabled === enabled) return;
  screenReaderEnabled = enabled;
  armExpiry();
}

AccessibilityInfo.addEventListener("screenReaderChanged", setScreenReaderEnabled);
void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderEnabled);

function notify() {
  for (const listener of listeners) listener();
}

export function readThreadUndoNotice() {
  return notice;
}

export function dismissThreadUndoNotice() {
  const previous = notice;
  notice = null;
  clearTimeout(expiry);
  previous?.claim.finish();
  notify();
}

ThreadUndo.subscribe(() => {
  if (notice !== null && !notice.claim.isCurrent()) dismissThreadUndoNotice();
});

export function showThreadUndoNotice(options: UndoNotice) {
  if (!options.claim.isCurrent()) return;
  dismissThreadUndoNotice();
  notice = {
    ...options,
    undo: async () => {
      if (notice?.claim !== options.claim || !options.claim.isCurrent()) return;
      dismissThreadUndoNotice();
      await options.undo();
    },
  };
  notify();
  armExpiry();
}

export function useThreadUndoNotice() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, readThreadUndoNotice);
}
