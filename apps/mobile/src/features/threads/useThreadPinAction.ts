import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useEnvironmentScope } from "../../state/session";
import { useThreadListActions } from "../home/useThreadListActions";

export interface ThreadPinAction {
  readonly pinned: boolean;
  readonly onToggle: () => void;
}

/** The thread list's pin command for the open thread; null where it cannot be used. */
export function useThreadPinAction(thread: EnvironmentThreadShell | null): ThreadPinAction | null {
  const { pinThread, unpinThread } = useThreadListActions();
  const { pinningEnvironmentIds } = useAtomValue(threadListEnvironmentsAtom);
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  if (thread === null || !canOperate || !pinningEnvironmentIds.has(thread.environmentId)) {
    return null;
  }
  const pinned = thread.pinnedAt != null;
  return {
    pinned,
    onToggle: () => void (pinned ? unpinThread(thread) : pinThread(thread)),
  };
}
