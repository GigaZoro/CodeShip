import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelCapabilities, ServerProviderFunding } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Provider-reported model family when the executable slug is opaque. */
  nativeModelFamily: Schema.optionalKey(TrimmedNonEmptyString),
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  /** Overrides the account funding when the adapter can identify this model's payer separately. */
  funding: Schema.optionalKey(ServerProviderFunding),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  badge: Schema.optional(Schema.Literal("new")),
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
  isLegacy: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS = 5 * 60_000;

export function isProviderWorkspaceSnapshotCurrent(
  snapshot: { readonly checkedAt: string },
  nowMs: number,
): boolean {
  return nowMs - Date.parse(snapshot.checkedAt) < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS;
}

/** Unavailable snapshots must set installed and enabled false. */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderCompatibilityStatus = Schema.Literals([
  "unknown",
  "supported",
  "graceful",
  "unsupported",
  "broken",
]);
export type ServerProviderCompatibilityStatus = typeof ServerProviderCompatibilityStatus.Type;

export const ServerProviderApiCredit = Schema.Struct({
  linkedPlanInstanceId: ProviderInstanceId,
  grantUsd: Schema.Number,
  cycleStart: IsoDateTime,
  cycleEnd: IsoDateTime,
  balanceState: Schema.Literals(["available", "exhausted"]),
  checkedAt: IsoDateTime,
  exhaustedAt: Schema.optional(IsoDateTime),
  reason: Schema.optional(TrimmedNonEmptyString),
  spendUsd: Schema.NullOr(Schema.Number),
  estimatedRemainingUsd: Schema.NullOr(Schema.Number),
  spendSource: Schema.Literal("metered"),
  meteringStartedAt: IsoDateTime,
  unpricedUsage: Schema.Boolean,
  sharedWith: Schema.optional(ProviderInstanceId),
});
export type ServerProviderApiCredit = typeof ServerProviderApiCredit.Type;

export const isProviderAvailable = (snapshot: {
  readonly availability?: ServerProviderAvailability | undefined;
}): boolean => snapshot.availability !== "unavailable";

/** Legacy producers omit this field and support text generation. */
export const isProviderTextGenerationCapable = (snapshot: {
  readonly supportsTextGeneration?: boolean | undefined;
}): boolean => snapshot.supportsTextGeneration !== false;

export class ServerProviderUpdateError extends Schema.TaggedError<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}
