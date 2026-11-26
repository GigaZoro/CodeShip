import { t } from "../lib/i18n";

import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@t3tools/client-runtime/state/attachments";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type RuntimeMode as RuntimeModeType,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  shouldRetryThreadOutboxDelivery as shouldRetryDeliveryFailure,
  type ThreadOutboxDeliveryAction,
} from "@t3tools/client-runtime/state/thread-outbox";

import { DraftComposerAttachmentSchema } from "../lib/composer-image-schema";
import { withImplicitFastModeSelection } from "../lib/providerOptions";
import type { ComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";

// v4 file-backed writes require native baselines with embedded readers and storage guards.
const THREAD_OUTBOX_SCHEMA_VERSION = 4;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

const QueuedThreadCreationSchema = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.optional(Schema.String),
  projectCwd: Schema.optional(Schema.String),
  workspaceMode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
  pullRequestReference: Schema.optional(Schema.String),
  repositories: Schema.optional(Schema.Array(Schema.String)),
  startsFromRepositoryDefaults: Schema.optional(Schema.Boolean),
});

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2, 3, THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  restoreToDraft: Schema.optional(Schema.Boolean),
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.Array(DraftComposerAttachmentSchema),
  modelSelection: Schema.optional(ModelSelection),
  dispatchMode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  compactBeforeSend: Schema.optional(Schema.Boolean),
  freshContext: Schema.optional(Schema.Boolean),
  runtimeMode: Schema.optional(RuntimeMode),
  creation: Schema.optional(QueuedThreadCreationSchema),
  createdAt: IsoDateTime,
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);

export interface QueuedThreadCreation {
  readonly projectId: ProjectIdType;
  readonly projectTitle?: string;
  readonly projectCwd?: string;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
  readonly pullRequestReference?: string;
  /** Tracked repositories the new worktree takes, by path; absent leaves the choice to the server. */
  readonly repositories?: ReadonlyArray<string>;
  /** The project folder is no Git repository, so a new worktree needs no base branch. */
  readonly startsFromRepositoryDefaults?: boolean;
}

export interface QueuedThreadMessage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly restoreToDraft?: boolean;
  readonly context?: OrchestrationMessageContext;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly modelSelection?: ModelSelectionType;
  readonly runtimeMode?: RuntimeModeType;
  /** Captured at enqueue because draining may occur long after the tap. */
  readonly dispatchMode?: ComposerDispatchMode;
  /** Sends "When you return"'s `/compact` ahead of the message, which queues behind it. */
  readonly compactBeforeSend?: boolean;
  /** Starts a new provider session (`/clear`). */
  readonly freshContext?: boolean;
  readonly creation?: QueuedThreadCreation;
  readonly createdAt: string;
}

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId"> & {
      readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "capabilities">>;
    }
  > = [],
): ThreadSettingsSnapshot {
  return {
    modelSelection: withImplicitFastModeSelection(
      message.modelSelection ?? thread.modelSelection,
      providers,
    ),
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageId, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(message.environmentId, message.threadId);
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return grouped;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDispatchStep =
  | { readonly step: "wait" }
  | { readonly step: "remove" }
  | { readonly step: "retry" }
  | { readonly step: "restore"; readonly reason: string }
  | { readonly step: "send" };

export function resolveThreadOutboxDispatchStep(input: {
  readonly deliveryAction: ThreadOutboxDeliveryAction;
  readonly fileAttachments: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  readonly serverConfig: { readonly maxFileUploadBytes: number | undefined } | null;
}): ThreadOutboxDispatchStep {
  if (input.deliveryAction !== "send") {
    return { step: input.deliveryAction };
  }
  if (input.serverConfig === null) {
    return { step: "retry" };
  }
  if (input.fileAttachments.length === 0) {
    return { step: "send" };
  }
  const maxBytes = input.serverConfig.maxFileUploadBytes;
  if (maxBytes === undefined) {
    return { step: "restore", reason: t("This server does not support file attachments.") };
  }
  const effectiveMaxBytes = clampFileAttachmentUploadBytes(maxBytes);
  const oversized = input.fileAttachments.find(
    (attachment) => attachment.sizeBytes > effectiveMaxBytes,
  );
  return oversized
    ? { step: "restore", reason: fileAttachmentTooLargeMessage(oversized.name, effectiveMaxBytes) }
    : { step: "send" };
}

export function isQueuedThreadCreationSendable(message: QueuedThreadMessage): boolean {
  if (!message.creation) {
    return false;
  }
  const hasContent = message.text.trim().length > 0 || message.attachments.length > 0;
  if (!hasContent || message.modelSelection === undefined) {
    return false;
  }
  return (
    message.creation.workspaceMode !== "worktree" ||
    Boolean(message.creation.branch) ||
    message.creation.startsFromRepositoryDefaults === true
  );
}

/** A shared upload's failure decides by what made the upload fail. */
export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AttachmentUploadError"
  ) {
    return "cause" in error && shouldRetryThreadOutboxDelivery(error.cause);
  }
  return shouldRetryDeliveryFailure(error);
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "restore";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "restore";
}

export type AcknowledgedThreadMessage = QueuedThreadMessage & {
  /** The server sequence that committed the message; older servers do not report it. */
  readonly sequence?: number;
};
