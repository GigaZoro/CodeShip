import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ClockIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { type QueuedThreadMessage, useThreadOutboxStore } from "../../threadOutboxStore";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { t, tn } from "~/i18n";

const NO_MESSAGES: ReadonlyArray<QueuedThreadMessage> = [];

/**
 * Messages this browser holds for the thread until its machine reconnects. Each can be taken
 * back into the composer or cancelled; one the machine refused says why.
 */
export function useQueuedMessagesBanner(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly machineLabel: string | null;
}): ComposerBannerStackItem | null {
  const { environmentId, threadId } = input;
  const messages = useThreadOutboxStore((state) =>
    environmentId === null || threadId === null ? NO_MESSAGES : state.messages,
  ).filter((message) => message.environmentId === environmentId && message.threadId === threadId);
  const removeMessage = useThreadOutboxStore((state) => state.remove);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  if (environmentId === null || threadId === null || messages.length === 0) return null;
  const threadRef = scopeThreadRef(environmentId, threadId);
  const edit = (message: QueuedThreadMessage) => {
    const current = getComposerDraft(threadRef)?.prompt.trim() ?? "";
    setPrompt(threadRef, current.length === 0 ? message.text : `${current}\n\n${message.text}`);
    removeMessage(message.messageId);
  };
  const failed = messages.some((message) => message.failure !== null);
  const machine = input.machineLabel ?? t("its machine");
  return {
    id: `queued-messages:${environmentId}:${threadId}`,
    variant: failed ? "error" : "info",
    icon: <ClockIcon />,
    title: failed
      ? t("A queued message was not sent")
      : tn(
          messages.length,
          "{count} message waits for {name} to reconnect",
          "{count} messages wait for {name} to reconnect",
          { name: machine },
        ),
    children: (
      <ul className="flex flex-col gap-1.5">
        {messages.map((message) => (
          <li key={message.messageId} className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-sm whitespace-pre-wrap text-foreground">
                {message.text}
              </p>
              {message.failure !== null ? (
                <p className="text-xs text-destructive-foreground">
                  {t("Not sent: {reason}", { reason: message.failure })}
                </p>
              ) : null}
            </div>
            <Button size="xs" variant="ghost" onClick={() => edit(message)}>
              {t("Edit")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => removeMessage(message.messageId)}>
              {t("Cancel")}
            </Button>
          </li>
        ))}
      </ul>
    ),
  };
}
