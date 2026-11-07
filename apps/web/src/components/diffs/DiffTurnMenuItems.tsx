import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

import { t } from "~/i18n";
import { useQuietThreadProjection } from "~/state/entities";
import { formatShortTimestamp } from "~/timestampFormat";

import { outlinePromptText } from "../chat/timelineOutlineStore";
import { DropdownMenuRadioItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Older history is paginated, so a turn whose prompt is not loaded has no entry. */
function turnPrompts(
  projection: ThreadStructure | undefined,
  turns: ReadonlyArray<ThreadCheckpointSummary>,
): ReadonlyMap<RunId, string> {
  const prompts = new Map<RunId, string>();
  if (!projection) return prompts;
  const runIds = new Set(turns.map((turn) => turn.runId));
  const messageIdByRun = new Map(
    projection.runs.flatMap((run) => (runIds.has(run.id) ? [[run.userMessageId, run.id]] : [])),
  );
  for (const message of projection.messages) {
    const runId = messageIdByRun.get(message.id);
    if (runId === undefined || message.workflowScript) continue;
    const prompt = isAttachmentOnlyBootstrapPrompt(message.text)
      ? message.attachments[0]?.name
      : outlinePromptText(message.text);
    if (prompt) prompts.set(runId, prompt);
  }
  return prompts;
}

/** Mounted only while the Turn submenu is open, so the panel does not follow the thread's messages. */
export function DiffTurnMenuItems({
  threadRef,
  turns,
  timestampFormat,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly turns: ReadonlyArray<ThreadCheckpointSummary>;
  readonly timestampFormat: TimestampFormat;
}) {
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const prompts = turnPrompts(projection, turns);
  return turns.map((turn) => {
    const turnLabel = t("Turn {number}", { number: turn.checkpointTurnCount });
    const prompt = prompts.get(turn.runId);
    const row = (
      <span className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate">
          {prompt === undefined ? (
            turnLabel
          ) : (
            <>
              <span className="sr-only">{`${turnLabel}: `}</span>
              {prompt}
            </>
          )}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatShortTimestamp(turn.completedAt, timestampFormat)}
        </span>
      </span>
    );
    const value = `turn:${turn.runId}`;
    if (prompt === undefined) {
      return (
        <DropdownMenuRadioItem key={turn.runId} value={value} closeOnClick>
          {row}
        </DropdownMenuRadioItem>
      );
    }
    return (
      <Tooltip key={turn.runId}>
        <TooltipTrigger render={<DropdownMenuRadioItem value={value} closeOnClick />}>
          {row}
        </TooltipTrigger>
        <TooltipPopup side="right" className="max-w-80">
          <span className="block font-medium">{turnLabel}</span>
          <span className="block">{prompt}</span>
        </TooltipPopup>
      </Tooltip>
    );
  });
}
