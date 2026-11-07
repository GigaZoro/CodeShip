import {
  findRevertCheckpoint,
  turnsAfterChangedFiles,
  waitForRevertedMessage,
} from "@t3tools/client-runtime/state/thread-rewind";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type MessageId,
  type RunId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { downloadComposerAttachment } from "../../lib/composerContextClipboard";
import {
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { t } from "../../lib/i18n";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  clearThreadComposerError,
  setThreadComposerError,
} from "../../state/thread-composer-error";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import {
  appendComposerDraftAttachments,
  composerContextImportsAtom,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import {
  deriveThreadRewindTargets,
  restoredRewindDraftContent,
  sameThreadRewindTargets,
  type ThreadRewindTargets,
} from "./threadRewind";

export interface ThreadRewindRequest {
  /** The user message whose turn is undone and put back in the composer. */
  readonly messageId: MessageId;
  readonly turnCount: number;
  /** Retry resends the restored message; Edit from here leaves it in the composer. */
  readonly retry: boolean;
}

/**
 * Rewinds the thread to before the message and puts the message back in the thread's draft.
 * Resolves true once it is there; any failure is shown above the composer and leaves the draft
 * as it was.
 */
async function rewindToMessage(input: {
  readonly ref: ScopedThreadRef;
  readonly request: ThreadRewindRequest;
  readonly restoreFiles: boolean;
}): Promise<boolean> {
  const { ref, request } = input;
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  const structure = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref));
  const message = structure?.projection.visibleTurnItems.find(
    ({ item }) => item.type === "user_message" && item.messageId === request.messageId,
  )?.item;
  if (structure === null || message?.type !== "user_message") return false;
  await waitForComposerDraftsLoaded();
  const draft = getComposerDraftSnapshot(threadKey);
  const fail = (error: string) => {
    setThreadComposerError(threadKey, error);
    return false;
  };
  // The rewind appends to the composer, so an unsent draft would be sent with the retry.
  if (request.retry && (draft.text.trim().length > 0 || draft.attachments.length > 0)) {
    return fail(t("Clear the message box before retrying."));
  }
  if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) {
    return fail(t("Wait for attachments to finish preparing before rewinding."));
  }
  if (draft.attachments.length + message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
    return fail(t("Make room for this message's attachments in the composer before rewinding."));
  }
  clearThreadComposerError(threadKey);

  const restored: DraftComposerAttachment[] = [];
  const releaseRestored = () =>
    Promise.all(
      restored.map((attachment) =>
        attachment.fileUri
          ? removePersistedComposerAttachmentFile(attachment.fileUri)
          : Promise.resolve(),
      ),
    );
  const signal = new AbortController().signal;
  const prepared = await Promise.resolve()
    .then(async () => {
      for (const attachment of message.attachments) {
        if (attachment.type !== "image" && attachment.type !== "file") {
          return t("This message has an attachment that cannot be restored.");
        }
        const file = await downloadComposerAttachment(
          {
            attachmentId: attachment.id,
            kind: attachment.type,
            name: attachment.name,
            mimeType: attachment.mimeType,
          },
          ref.environmentId,
          signal,
        ).catch(() => null);
        if (file === null)
          return t("Could not restore attachment: {name}", { name: attachment.name });
        restored.push(file);
      }
      const checkpoint = findRevertCheckpoint(structure.projection.checkpoints, request.turnCount);
      const commandId = CommandId.make(uuidv4());
      await waitForRevertedMessage({
        registry: appAtomRegistry,
        threadAtom: environmentThreadDetails.stateAtom(ref),
        turnCount: request.turnCount,
        requestId: commandId,
        revert: async () => {
          const result = await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.revertCheckpoint,
            {
              environmentId: ref.environmentId,
              input: {
                commandId,
                threadId: ref.threadId,
                turnCount: request.turnCount,
                restoreFiles: input.restoreFiles,
                ...(checkpoint === undefined
                  ? {}
                  : { checkpointId: checkpoint.id, scopeId: checkpoint.scopeId }),
              },
            },
            { reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      });
      return null;
    })
    .catch((error: unknown) =>
      error instanceof Error ? error.message : t("Failed to revert thread state."),
    );
  if (prepared !== null) {
    await releaseRestored();
    return fail(prepared);
  }
  const { content, unreferencedFiles } = restoredRewindDraftContent({
    message,
    restored,
    createId: uuidv4,
  });
  await mergeComposerDraftContent(threadKey, content);
  appendComposerDraftAttachments(threadKey, unreferencedFiles, { appendReference: true });
  return true;
}

/**
 * Going back in a thread: Retry on the newest reply and Edit from here on the user's own
 * messages. Both rewind to before a message and put it back in the composer; Retry then sends
 * it again.
 */
export function useThreadRewind(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly detailRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
  readonly supportsConversationRollback: boolean;
  readonly hasMoreHistory: boolean;
  readonly unsettledRunId: RunId | null;
  readonly working: boolean;
  readonly connected: boolean;
  readonly environmentLabel: string | null;
  /** Runs once the message is back in the composer. */
  readonly onRestored: (retry: boolean) => void;
}) {
  const structure = useQuietThreadStructure(input.detailRef)?.projection ?? null;
  const [rewindingMessageId, setRewindingMessageId] = useState<MessageId | null>(null);

  const derived = deriveThreadRewindTargets({
    structure: input.canOperateThread ? structure : null,
    supportsConversationRollback: input.supportsConversationRollback,
    hasMoreHistory: input.hasMoreHistory,
    unsettledRunId: input.unsettledRunId,
  });
  const [targets, setTargets] = useState<ThreadRewindTargets>(derived);
  if (!sameThreadRewindTargets(targets, derived)) setTargets(derived);

  const threadKey = scopedThreadKey(input.environmentId, input.threadId);

  const perform = (request: ThreadRewindRequest, restoreFiles: boolean) => {
    const ref = input.detailRef;
    if (ref === null) return;
    setRewindingMessageId(request.messageId);
    void rewindToMessage({ ref, request, restoreFiles }).then(
      (restored) => {
        setRewindingMessageId(null);
        if (restored) input.onRestored(request.retry);
      },
      (error: unknown) => {
        setRewindingMessageId(null);
        setThreadComposerError(
          threadKey,
          error instanceof Error ? error.message : t("Failed to revert thread state."),
        );
      },
    );
  };

  const request = (request: ThreadRewindRequest) => {
    if (rewindingMessageId !== null || !input.canOperateThread) return;
    if (!input.connected) {
      setThreadComposerError(
        threadKey,
        input.environmentLabel
          ? t("Reconnect {name} before reverting checkpoints.", { name: input.environmentLabel })
          : t("The environment is not connected."),
      );
      return;
    }
    if (input.working) {
      Dialog.alert(request.retry ? t("Stop the agent to retry") : t("Stop the agent to edit"));
      return;
    }
    void Haptics.selectionAsync();
    // A retry that changed no files has nothing to restore, so it skips the question.
    if (request.retry && !turnsAfterChangedFiles(structure?.checkpoints ?? [], request.turnCount)) {
      perform(request, false);
      return;
    }
    Dialog.alert(
      request.retry ? t("Retry this response?") : t("Edit from here?"),
      request.retry
        ? t(
            "Rewind chat to before this response and send your message again. “Revert files too” also undoes the edits the response made, so the retry starts from the earlier files.",
          )
        : t(
            "Rewind chat to before this message. Your prompt and attachments return to the composer. “Revert files too” also undoes your own edits.",
          ),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Revert files too"),
          style: "destructive",
          onPress: () => perform(request, true),
        },
        {
          text: request.retry ? t("Retry, keep changes") : t("Revert and keep changes"),
          onPress: () => perform(request, false),
        },
      ],
    );
  };

  return {
    targets,
    actions: input.canOperateThread
      ? { working: input.working, rewindingMessageId, onRequest: request }
      : null,
  };
}
