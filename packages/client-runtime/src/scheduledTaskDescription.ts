import type { ScheduledTask, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export function scheduledTaskPreview(task: Pick<ScheduledTask, "description" | "prompt">): string {
  return task.description?.trim() || task.prompt;
}

/**
 * The description change to send, or `null` when the target cannot store it. `supported` is `null`
 * until the target's config arrives: a missing config says nothing about its version, so the
 * change is kept until the target is known.
 */
export function scheduledTaskDescriptionField(input: {
  readonly supported: boolean | null;
  readonly description: string;
  readonly savedDescription: string;
}): Pick<ScheduledTaskUpsertInput, "description"> | null {
  const description = input.description.trim();
  if (description === input.savedDescription.trim()) return {};
  return input.supported === false ? null : { description: description || null };
}

export function scheduledTaskDescriptionUnsupported(machine: string): string {
  return t("{machine} cannot save descriptions. Clear the description or pick another machine.", {
    machine,
  });
}
