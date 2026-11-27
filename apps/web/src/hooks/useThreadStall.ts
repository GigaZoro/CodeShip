import {
  resolveThreadStall,
  type ThreadStall,
  type ThreadStallInput,
} from "@t3tools/client-runtime/state/thread-status";

import { useDeadlinePassed } from "./useDeadline";

/** The thread's stall once it has been quiet past its limit; re-renders once when that happens. */
export function useThreadStall(thread: ThreadStallInput | null): ThreadStall | null {
  const stall = thread === null ? null : resolveThreadStall(thread);
  const stalled = useDeadlinePassed(stall?.stalledAt ?? null);
  return stalled ? stall : null;
}
