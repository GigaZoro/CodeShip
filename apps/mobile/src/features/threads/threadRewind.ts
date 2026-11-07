import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  deriveAvailableRevertTurnCounts,
  deriveRetryTarget,
  deriveRevertTurnCountByUserMessageId,
  findRevertCheckpoint,
  revertRunMarkersFromVisibleTurnItems,
  type RetryTarget,
} from "@t3tools/client-runtime/state/thread-rewind";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import { reidentifyComposerContext, uploadedComposerContext } from "../../lib/composerContext";
import type { ComposerDraftContent } from "../../state/use-composer-drafts";

export interface ThreadRewindTargets {
  /** User messages "Edit from here" can rewind to, by the turn count the rewind restores. */
  readonly turnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  readonly retryTarget: RetryTarget | null;
}

export const NO_THREAD_REWIND_TARGETS: ThreadRewindTargets = {
  turnCountByUserMessageId: new Map(),
  retryTarget: null,
};

export function deriveThreadRewindTargets(input: {
  readonly structure: ThreadStructure | null;
  readonly supportsConversationRollback: boolean;
  /** Paged-out history hides the thread start, so the first loaded run cannot rewind to it. */
  readonly hasMoreHistory: boolean;
  readonly unsettledRunId: RunId | null;
}): ThreadRewindTargets {
  const { structure } = input;
  if (structure === null || !input.supportsConversationRollback) return NO_THREAD_REWIND_TARGETS;
  const turnCountByUserMessageId = deriveRevertTurnCountByUserMessageId({
    runMarkers: revertRunMarkersFromVisibleTurnItems(structure.visibleTurnItems),
    checkpoints: structure.checkpoints.flatMap((checkpoint) =>
      checkpoint.runId === null || checkpoint.appRunOrdinal === null
        ? []
        : [
            {
              runId: checkpoint.runId,
              status: checkpoint.status,
              checkpointTurnCount: checkpoint.appRunOrdinal,
            },
          ],
    ),
    threadStartCheckpointReady:
      !input.hasMoreHistory && findRevertCheckpoint(structure.checkpoints, 0) !== undefined,
    availableRevertTurnCounts: deriveAvailableRevertTurnCounts(structure),
    unsettledRunId: input.unsettledRunId,
  });
  if (turnCountByUserMessageId.size === 0) return NO_THREAD_REWIND_TARGETS;
  const messages = structure.visibleTurnItems.flatMap(({ item }) =>
    item.type === "assistant_message"
      ? [{ id: item.messageId, role: "assistant", streaming: item.streaming }]
      : item.type === "user_message" &&
          !(item.inputIntent === "queued_turn" && item.status === "pending")
        ? [{ id: item.messageId, role: "user", streaming: false }]
        : [],
  );
  return {
    turnCountByUserMessageId,
    retryTarget: deriveRetryTarget(messages, turnCountByUserMessageId),
  };
}

/** The rows read these targets, so an equal value keeps the old one and the rows stay put. */
export function sameThreadRewindTargets(a: ThreadRewindTargets, b: ThreadRewindTargets): boolean {
  if (a === b) return true;
  if (
    a.retryTarget?.assistantMessageId !== b.retryTarget?.assistantMessageId ||
    a.retryTarget?.userMessageId !== b.retryTarget?.userMessageId ||
    a.retryTarget?.turnCount !== b.retryTarget?.turnCount ||
    a.turnCountByUserMessageId.size !== b.turnCountByUserMessageId.size
  )
    return false;
  for (const [messageId, turnCount] of a.turnCountByUserMessageId) {
    if (b.turnCountByUserMessageId.get(messageId) !== turnCount) return false;
  }
  return true;
}

/**
 * What a rewound message puts back in the composer: its text, its context with fresh identities
 * bound to the restored files, and those files. Files no chip refers to come back separately,
 * since the composer shows a non-media file only through its chip.
 */
export function restoredRewindDraftContent(input: {
  readonly message: {
    readonly text: string;
    readonly context?: OrchestrationMessageContext | undefined;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  };
  /** The message's attachments as composer files, in the same order. */
  readonly restored: ReadonlyArray<DraftComposerAttachment>;
  readonly createId: () => string;
}): {
  readonly content: ComposerDraftContent;
  readonly unreferencedFiles: ReadonlyArray<DraftComposerAttachment>;
} {
  const text =
    input.message.text.trim() === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT ? "" : input.message.text;
  const bound = uploadedComposerContext(
    input.message.context,
    input.message.attachments,
    input.restored,
  );
  const reidentified =
    bound === undefined || bound.records.length === 0
      ? { text, context: undefined }
      : reidentifyComposerContext(text, bound.records, input.createId);
  const referenced = new Set(
    (reidentified.context?.records ?? []).flatMap((record) =>
      "attachmentId" in record ? [record.attachmentId] : [],
    ),
  );
  // Media shows in the attachment strip; any other file shows only through its chip.
  const unreferencedFiles = input.restored.filter(
    (attachment) =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      !referenced.has(attachment.id),
  );
  return {
    content: {
      text: reidentified.text,
      ...(reidentified.context === undefined ? {} : { context: reidentified.context }),
      attachments: input.restored.filter((attachment) => !unreferencedFiles.includes(attachment)),
    },
    unreferencedFiles,
  };
}
