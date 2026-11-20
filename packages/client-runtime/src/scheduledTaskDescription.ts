import type { ScheduledTask, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

export function scheduledTaskPreview(task: Pick<ScheduledTask, "description" | "prompt">): string {
  return task.description?.trim() || task.prompt;
}

export function scheduledTaskDescriptionField(input: {
  readonly supported: boolean;
  readonly description: string;
  readonly savedDescription: string;
}): Pick<ScheduledTaskUpsertInput, "description"> | null {
  const description = input.description.trim();
  if (description === input.savedDescription.trim()) return {};
  return input.supported ? { description: description || null } : null;
}

export function scheduledTaskDescriptionUnsupported(machine: string): string {
  return t("{machine} cannot save descriptions. Clear the description or pick another machine.", {
    machine,
  });
}
