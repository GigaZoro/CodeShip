import { type ChatFileAttachment, type ChatImageAttachment } from "../../types";
import type {
  ComposerContextRecord,
  KnownComposerContextRecord,
  OrchestrationV2ModelSwitch,
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
}): boolean {
  if (
    input.modelSwitch !== undefined &&
    input.modelSwitch.from.instanceId !== input.modelSwitch.to.instanceId
  ) {
    return true;
  }
  if (input.runId !== null) {
    const currentRun = input.runs.find((run) => run.id === input.runId);
    if (currentRun !== undefined) {
      let previousRun: HandoffTimelineRun | undefined;
      for (const run of input.runs) {
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
  return input.messageId.startsWith("limit-failover:");
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
