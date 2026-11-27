import { type ChatFileAttachment, type ChatImageAttachment } from "../../types";
import type {
  ComposerContextRecord,
  KnownComposerContextRecord,
  OrchestrationV2ModelSwitch,
  OrchestrationV2UserMessageInputIntent,
  RunId,
} from "@t3tools/contracts";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { asKnownContextRecord } from "~/lib/composerContextRecords";
import { t } from "~/i18n";

export function didContinuationSwitchAccount(input: {
  readonly runId: RunId | null;
  readonly messageId: string;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
  readonly modelSwitch?: OrchestrationV2ModelSwitch | undefined;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent | undefined;
}): boolean {
  if (
    input.modelSwitch !== undefined &&
    input.modelSwitch.from.instanceId !== input.modelSwitch.to.instanceId
  ) {
    return true;
  }
  if (input.messageId.startsWith("limit-failover:")) {
    return true;
  }
  // A continuation attached to an existing run (e.g. a held-run restart via appendSteeringMessage)
  // did not switch accounts unless the server recorded a modelSwitch or limit-failover id.
  if (input.inputIntent === "steer" || input.inputIntent === "promoted_queued_to_steer") {
    return false;
  }
  if (input.runId !== null) {
    const currentRun = input.runs.find((run) => run.id === input.runId);
    if (currentRun !== undefined) {
      if (currentRun.userMessageId !== undefined && currentRun.userMessageId !== input.messageId) {
        return false;
      }
      let previousRun: HandoffTimelineRun | undefined;
      for (const run of input.runs) {
        if (run.status === "queued" || run.status === "rolled_back") continue;
        if (run.ordinal < currentRun.ordinal) {
          if (previousRun === undefined || run.ordinal > previousRun.ordinal) {
            previousRun = run;
          }
        }
      }
      if (previousRun !== undefined) {
        return currentRun.providerInstanceId !== previousRun.providerInstanceId;
      }
    }
  }
  return false;
}

export function userMessageFileLabel(file: Pick<ChatFileAttachment, "name" | "source">) {
  return file.source?._tag === "pasted-text" ? t("Pasted text") : file.name;
}

export function resolvePreviewAnnotationImage(input: {
  record: Extract<KnownComposerContextRecord, { kind: "preview-annotation" }>;
  recordsById: ReadonlyMap<string, ComposerContextRecord>;
  userImages: ReadonlyArray<ChatImageAttachment>;
  previewImages: ReadonlyArray<ChatImageAttachment>;
  annotationRecordIds: ReadonlyArray<string>;
}): ChatImageAttachment | null {
  const screenshotRecord = input.record.screenshotContextId
    ? asKnownContextRecord(input.recordsById.get(input.record.screenshotContextId))
    : undefined;
  return (
    (screenshotRecord?.kind === "image"
      ? input.userImages.find((image) => image.id === screenshotRecord.attachmentId)
      : undefined) ??
    input.previewImages.find(
      (image) => image.name === `preview-annotation-${input.record.annotationId}.png`,
    ) ??
    input.previewImages[input.annotationRecordIds.indexOf(input.record.contextId)] ??
    null
  );
}
