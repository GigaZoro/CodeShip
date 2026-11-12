import {
  MAX_PROMPT_FILE_PATH_LENGTH,
  promptFilePathProblem,
  type PromptFilePathProblem,
  type ScheduledTask,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export type PromptSource = "text" | "file";

export type PromptFileLastRead = NonNullable<NonNullable<ScheduledTask["promptFile"]>["lastRead"]>;

/** The prompt source as a task form edits it; `prompt` stays the text the form shows. */
export interface PromptFileDraft {
  readonly promptSource: PromptSource;
  /** The repository path being edited. */
  readonly promptFile: string;
  /** The path the stored task reads, so a read found for it is not shown for an edited path. */
  readonly savedPromptFile: string | null;
  readonly promptLastRead: PromptFileLastRead | null;
}

export function promptFileDraft(
  task: Pick<ScheduledTask, "promptFile"> | null | undefined,
): PromptFileDraft {
  return {
    promptSource: task?.promptFile ? "file" : "text",
    promptFile: task?.promptFile?.path ?? "",
    savedPromptFile: task?.promptFile?.path ?? null,
    promptLastRead: task?.promptFile?.lastRead ?? null,
  };
}

/** The prompt source in effect: a server without prompt files only holds text. */
export function effectivePromptSource(input: {
  readonly supportsPromptFiles: boolean;
  readonly draft: Pick<PromptFileDraft, "promptSource">;
}): PromptSource {
  return input.supportsPromptFiles ? input.draft.promptSource : "text";
}

/** The target cannot read prompt files, so saving there would silently turn the task into text. */
export function promptFileLostOnTarget(input: {
  readonly supportsPromptFiles: boolean;
  readonly isWebhook: boolean;
  readonly draft: Pick<PromptFileDraft, "promptSource">;
}): boolean {
  return !input.supportsPromptFiles && !input.isWebhook && input.draft.promptSource === "file";
}

/** The saved read applies only while the path is the one the task stores. */
export function promptFileReadFor(
  draft: Pick<PromptFileDraft, "promptFile" | "savedPromptFile" | "promptLastRead">,
): PromptFileLastRead | null {
  return draft.savedPromptFile !== null && draft.promptFile.trim() === draft.savedPromptFile
    ? draft.promptLastRead
    : null;
}

function promptFilePathProblemText(problem: PromptFilePathProblem): string {
  switch (problem) {
    case "too_long":
      return t("The prompt file path is longer than {max} characters.", {
        max: MAX_PROMPT_FILE_PATH_LENGTH,
      });
    case "backslash":
      return t("Write the prompt file path with forward slashes.");
    case "absolute":
      return t("The prompt file path starts at the repository's root, so it cannot be absolute.");
    case "control_character":
      return t("The prompt file path cannot hold control characters.");
    case "empty_or_dot_part":
      return t("The prompt file path cannot have empty, . or .. parts.");
  }
}

/** Why a file-backed draft cannot be saved, or undefined. */
export function promptFileDraftProblem(input: {
  readonly promptFile: string;
  readonly isWebhook: boolean;
}): string | undefined {
  if (input.isWebhook) return t("A webhook task fills its prompt from each request.");
  const problem = promptFilePathProblem(input.promptFile.trim());
  return problem === undefined ? undefined : promptFilePathProblemText(problem);
}

/** The prompt fields of an upsert: the file path, or the text, which also clears a stored file. */
export function promptUpsertFields(input: {
  readonly supportsPromptFiles: boolean;
  readonly draft: Pick<PromptFileDraft, "promptSource" | "promptFile"> & {
    readonly prompt: string;
  };
}):
  | { readonly prompt: string }
  | { readonly promptFile: string }
  | { readonly prompt: string; readonly promptFile: null } {
  if (!input.supportsPromptFiles) return { prompt: input.draft.prompt.trim() };
  return input.draft.promptSource === "file"
    ? { promptFile: input.draft.promptFile.trim() }
    : { prompt: input.draft.prompt.trim(), promptFile: null };
}
