import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sideChatSourceRunId } from "@t3tools/client-runtime/state/thread-workflows";
import { type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useStableCallback } from "~/hooks/useStableCallback";
import { newThreadId } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentProviders } from "~/state/environments";
import {
  useQuietThreadProjection,
  useQuietThreadShell,
  waitForThreadShell,
} from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { toastManager } from "../ui/toast";

// Shared across hook instances so the shortcut, panel menu, and palette can't fork one thread twice.
const startingSideChats = new Set<string>();

/**
 * Forks the thread from its newest finished run into plan mode and opens the fork beside the
 * thread, so a quick question neither waits for nor joins the thread's own turns.
 */
export function useStartSideChat(threadRef: ScopedThreadRef | null) {
  const shell = useQuietThreadShell(threadRef);
  // A draft's reserved thread 404s before the server lists it, and that marks it deleted for good.
  const thread = useQuietThreadProjection(shell === null ? null : threadRef);
  const providersByEnvironment = useEnvironmentProviders();
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const sourceRunId = thread === null ? null : sideChatSourceRunId(thread.projection.runs);
  const available = threadRef !== null && shell !== null && sourceRunId !== null;

  const startSideChat = async () => {
    if (threadRef === null || shell === null || sourceRunId === null) return;
    const { environmentId } = threadRef;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const forked = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        targetThreadId,
        runId: sourceRunId,
        title: `Side chat: ${shell.title}`,
      },
    });
    if (forked._tag === "Failure") {
      if (isAtomCommandInterrupted(forked)) return;
      const error = squashAtomCommandFailure(forked);
      toastManager.add({
        type: "error",
        title: "Could not start a side chat",
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (!(await waitForThreadShell(targetThreadRef))) {
      toastManager.add({
        type: "error",
        title: "Could not open the side chat",
        description:
          "Its thread did not reach this client. Reconnect and open it from the sidebar.",
      });
      return;
    }
    const provider = providersByEnvironment
      .get(environmentId)
      ?.find((status) => status.instanceId === shell.modelSelection.instanceId);
    // The fork shares the thread's workspace, so keep it from editing where the provider can.
    if (provider !== undefined && provider.showInteractionModeToggle !== false) {
      const planned = await setInteractionMode({
        environmentId,
        input: { threadId: targetThreadId, interactionMode: "plan" },
      });
      if (planned._tag === "Failure" && !isAtomCommandInterrupted(planned)) {
        const error = squashAtomCommandFailure(planned);
        toastManager.add({
          type: "warning",
          title: "The side chat is not in plan mode",
          description:
            error instanceof Error ? error.message : "It can edit files in this workspace.",
        });
      }
    }
    useRightPanelStore.getState().openSideChat(threadRef, targetThreadId);
  };
  const start = useStableCallback(() => {
    if (threadRef === null) return;
    const key = scopedThreadKey(threadRef);
    if (startingSideChats.has(key)) return;
    startingSideChats.add(key);
    void startSideChat().finally(() => startingSideChats.delete(key));
  });

  return { available, start };
}

/** Opening a side chat as a thread moves it out of the panel. */
export function useOpenSideChatAsThread(hostThreadRef: ScopedThreadRef | null) {
  const navigate = useNavigate();
  return useStableCallback((sideChatThreadId: string) => {
    if (hostThreadRef === null) return;
    const sideChatRef = scopeThreadRef(
      hostThreadRef.environmentId,
      ThreadId.make(sideChatThreadId),
    );
    useRightPanelStore.getState().closeSurface(hostThreadRef, `side-chat:${sideChatThreadId}`);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(sideChatRef) });
  });
}
