import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  resolveThreadOutboxDeliveryAction,
  shouldRetryThreadOutboxDelivery,
} from "@t3tools/client-runtime/state/thread-outbox";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { environmentSummaries } from "./state/presentation";
import { environmentShell, liveShellEnvironmentIdsAtom } from "./state/shell";
import { environmentThreadShells, threadEnvironment } from "./state/threads";
import {
  nextQueuedMessagePerThread,
  type QueuedThreadMessage,
  useThreadOutboxStore,
} from "./threadOutboxStore";
import { t } from "~/i18n";

// A connected machine that dropped one send gets another try after this long.
const RETRY_DELAY_MS = 5_000;

/**
 * Sends queued messages once their machine is connected again, one at a time per thread so they
 * arrive in the order they were written. A message the machine refuses stays, marked, for the
 * user to see; one lost to the connection waits for the next try.
 */
export function startThreadOutboxDelivery(registry: AtomRegistry.AtomRegistry): () => void {
  const inFlight = new Set<MessageId>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRetry = () => {
    retryTimer ??= setTimeout(() => {
      retryTimer = null;
      drain();
    }, RETRY_DELAY_MS);
  };

  const send = async (message: QueuedThreadMessage) => {
    inFlight.add(message.messageId);
    const raw = registry
      .get(environmentThreadShells.environmentThreadIndexAtom(message.environmentId))
      .get(message.threadId);
    const running =
      raw !== undefined && isThreadWorking(presentThreadShell(message.environmentId, raw, null));
    const result = await runAtomCommand(
      registry,
      threadEnvironment.startTurn,
      {
        environmentId: message.environmentId,
        input: {
          threadId: message.threadId,
          commandId: message.commandId,
          createdAt: message.createdAt,
          message: {
            messageId: message.messageId,
            role: "user",
            text: message.text,
            attachments: [],
          },
          modelSelection: message.modelSelection,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          // Written while the machine was away: it waits behind a run instead of steering it.
          dispatchMode: running ? "queue" : "auto",
        },
      },
      { label: "thread-outbox:send", reportFailure: false },
    );
    inFlight.delete(message.messageId);
    const store = useThreadOutboxStore.getState();
    if (result._tag === "Success") {
      store.remove(message.messageId);
    } else if (
      isAtomCommandInterrupted(result) ||
      shouldRetryThreadOutboxDelivery(squashAtomCommandFailure(result))
    ) {
      scheduleRetry();
      return;
    } else {
      const error = squashAtomCommandFailure(result);
      store.markFailed(
        message.messageId,
        error instanceof Error && error.message.length > 0
          ? error.message
          : t("The machine did not accept the message."),
      );
    }
    drain();
  };

  // Sending and marking messages notify the store, which calls back in; those calls run after.
  let draining = false;
  let drainAgain = false;
  const drain = () => {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        drainOnce();
      } while (drainAgain);
    } finally {
      draining = false;
    }
  };

  const drainOnce = () => {
    const { messages, markFailed } = useThreadOutboxStore.getState();
    if (messages.length === 0) return;
    const environments = registry.get(environmentSummaries.environmentsAtom);
    for (const message of nextQueuedMessagePerThread(messages, inFlight)) {
      const action = resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: registry
          .get(environmentThreadShells.environmentThreadIndexAtom(message.environmentId))
          .has(message.threadId),
        shellStatus: registry.get(environmentShell.stateValueAtom(message.environmentId)).status,
        environmentConnected:
          environments.find((environment) => environment.environmentId === message.environmentId)
            ?.connectionState === "connected",
      });
      if (action === "remove") {
        markFailed(message.messageId, t("The thread no longer exists on its machine."));
      } else if (action === "send") {
        void send(message);
      }
    }
  };

  const unsubscribes = [
    useThreadOutboxStore.subscribe(drain),
    registry.subscribe(environmentSummaries.environmentsAtom, drain),
    registry.subscribe(liveShellEnvironmentIdsAtom, drain),
  ];
  drain();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    if (retryTimer !== null) clearTimeout(retryTimer);
  };
}
