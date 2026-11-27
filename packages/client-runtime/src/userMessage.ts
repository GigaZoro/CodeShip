import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { msg, t } from "@t3tools/shared/i18n";

/** The working row while T3.CodeShip's own compaction runs. */
export const IDLE_COMPACTING_MESSAGES = {
  beforeCacheExpires: msg("Compacting before the cache expires…"),
  onReturn: msg("Compacting…"),
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLE_MESSAGES = {
  beforeCacheExpires: msg("Auto-compacted before cache expiry"),
  onReturn: msg("Context compacted before sending"),
} satisfies Record<OrchestrationV2IdleCompaction, string>;

// Keep existing consumers localized while callers that defer copy resolution use the message tables.
export const IDLE_COMPACTING_LABELS = {
  get beforeCacheExpires() {
    return t(IDLE_COMPACTING_MESSAGES.beforeCacheExpires);
  },
  get onReturn() {
    return t(IDLE_COMPACTING_MESSAGES.onReturn);
  },
};

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/**
 * Prompts the server dispatches under `createdBy: "user"` / `creationSource: "server"` when
 * automatically resuming or failing over a thread after a usage limit or transient cut-off.
 */
const AUTOMATIC_SERVER_CONTINUATION_PROMPTS: ReadonlySet<string> = new Set([
  "Continue where you left off.",
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.",
]);

const NON_CONTINUATION_SERVER_USER_MESSAGE_PREFIXES = [
  "async-answer:",
  "approval-feedback:",
  "signed-out-failover:",
] as const;

export function isAutomaticServerContinuationMessage(message: {
  readonly id?: string | undefined;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly context?:
    | {
        readonly guest?: GuestMessageAttribution | undefined;
        readonly records?: ReadonlyArray<unknown> | undefined;
      }
    | undefined;
}): boolean {
  if (
    message.role !== "user" ||
    message.createdBy !== "user" ||
    message.creationSource !== "server" ||
    message.scheduledTaskId !== undefined ||
    message.context?.guest !== undefined ||
    (message.context?.records?.length ?? 0) > 0 ||
    (message.attachments?.length ?? 0) > 0
  ) {
    return false;
  }
  if (
    message.id !== undefined &&
    NON_CONTINUATION_SERVER_USER_MESSAGE_PREFIXES.some((prefix) => message.id!.startsWith(prefix))
  ) {
    return false;
  }
  return AUTOMATIC_SERVER_CONTINUATION_PROMPTS.has(message.text.trim());
}

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly context?:
    | {
        readonly guest?: GuestMessageAttribution | undefined;
        readonly records?: ReadonlyArray<unknown> | undefined;
      }
    | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | "continuation" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  if (isAutomaticServerContinuationMessage(message)) {
    return {
      text: message.text,
      attribution: "continuation",
      scheduledTaskId: undefined,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
