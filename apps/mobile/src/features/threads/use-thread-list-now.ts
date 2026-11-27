import { useState } from "react";

import { useNowAfter, useNowMinuteMs } from "../../lib/clock";
import type { ThreadListDeadlineInput } from "@t3tools/client-runtime/state/thread-status";

import { nextThreadListDeadlineAfter } from "./threadListV2";

/**
 * The thread list's clock as an ISO timestamp. It advances on each wall-clock
 * minute and the moment any snooze expires or working thread stalls, so the list
 * re-partitions on time instead of on the next minute tick. Waking on every such
 * thread, not just the ones the list shows, only costs an extra render.
 */
export function useThreadListNow(threads: ReadonlyArray<ThreadListDeadlineInput>): string {
  const minuteMs = useNowMinuteMs();
  // The latest time returned. The next wake is searched after it, not after
  // the floored minute, so a second snooze expiring later in the same minute
  // arms its own wake instead of waiting for the next minute tick.
  const [latestMs, setLatestMs] = useState(minuteMs);
  const afterWakeMs = useNowAfter(
    nextThreadListDeadlineAfter(threads, Math.max(minuteMs, latestMs)),
  );
  const nowMs = Math.max(minuteMs, afterWakeMs, latestMs);
  if (nowMs !== latestMs) setLatestMs(nowMs);
  return new Date(nowMs).toISOString();
}
