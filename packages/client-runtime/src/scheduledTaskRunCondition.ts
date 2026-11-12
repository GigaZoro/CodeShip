import {
  DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
  MAX_RUN_CONDITION_COMMAND_LENGTH,
  MAX_RUN_CONDITION_TIMEOUT_SECONDS,
  type ScheduledTask,
  type ScheduledTaskNoWorkSkip,
  type ScheduledTaskRunCheck,
  type ScheduledTaskRunConditionInput,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

/** The run condition as a task form edits it. An empty command means the task has none. */
export interface RunConditionDraft {
  readonly command: string;
  readonly timeoutSeconds: string;
}

export function runConditionDraft(
  task: Pick<ScheduledTask, "runCondition"> | null | undefined,
): RunConditionDraft {
  return {
    command: task?.runCondition?.command ?? "",
    timeoutSeconds: String(
      task?.runCondition?.timeoutSeconds ?? DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
    ),
  };
}

/** Blank means the default; undefined means the input is not a valid timeout, which blocks saving. */
function parseRunConditionTimeout(value: string): number | undefined {
  if (value.trim() === "") return DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS;
  const seconds = Number(value.trim());
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_RUN_CONDITION_TIMEOUT_SECONDS
    ? seconds
    : undefined;
}

/** What a save sends: null clears the condition; undefined means the draft is invalid, which blocks saving. */
export function runConditionInput(
  draft: RunConditionDraft,
): ScheduledTaskRunConditionInput | null | undefined {
  const command = draft.command.trim();
  if (command === "") return null;
  if (command.length > MAX_RUN_CONDITION_COMMAND_LENGTH) return undefined;
  const timeoutSeconds = parseRunConditionTimeout(draft.timeoutSeconds);
  return timeoutSeconds === undefined ? undefined : { command, timeoutSeconds };
}

/** The skip a task's row shows: its latest one, until a run starts after it. */
export function shownNoWorkSkip(
  task: Pick<ScheduledTask, "lastNoWorkSkip" | "lastRunAt">,
): ScheduledTaskNoWorkSkip | null {
  const skip = task.lastNoWorkSkip ?? null;
  if (skip === null) return null;
  return task.lastRunAt !== null && Date.parse(task.lastRunAt) >= Date.parse(skip.at) ? null : skip;
}

/** A task row's line for a skipped occurrence; `when` is the row's own relative time, such as "5m ago". */
export function noWorkSkipText(skip: ScheduledTaskNoWorkSkip, when: string): string {
  const reason = skip.reason?.trim() ?? "";
  return reason === ""
    ? t("Skipped {when}", { when })
    : t("Skipped {when}: {reason}", { when, reason });
}

/** A row's screen-reader words for a skipped occurrence. It names no time, so the label never goes stale. */
export function noWorkSkipLabel(skip: ScheduledTaskNoWorkSkip): string {
  const reason = skip.reason?.trim() ?? "";
  return reason === "" ? t("Last run skipped") : t("Last run skipped: {reason}", { reason });
}

/** Run history's line for a one-machine occurrence that another machine's check skipped. */
export function peerNoWorkText(machine: string | null, detail: string | null): string {
  const reason = detail?.trim() ?? "";
  if (machine === null) {
    return reason === ""
      ? t("Another machine found no work.")
      : t("Another machine found no work: {detail}", { detail: reason });
  }
  return reason === ""
    ? t("{machine} found no work.", { machine })
    : t("{machine} found no work: {detail}", { machine, detail: reason });
}

/** What the task editor says under the check's fields. */
export function runConditionHelpText(): string {
  return t(
    "Runs before each scheduled run, in the project folder, as one program with its arguments (no shell; ~/ is your home folder). Exit code 0 starts the chat, 10 skips the run, anything else starts the chat anyway. Run now skips the check.",
  );
}

/** Why a draft that `runConditionInput` refuses cannot be saved. */
export function runConditionInvalidText(): string {
  return t(
    "Enter a command up to {max} characters and a time limit of 1 to {maxSeconds} seconds.",
    {
      max: String(MAX_RUN_CONDITION_COMMAND_LENGTH),
      maxSeconds: String(MAX_RUN_CONDITION_TIMEOUT_SECONDS),
    },
  );
}

/** One line saying what a run's check did; null when there is nothing worth saying. */
export function runCheckText(check: ScheduledTaskRunCheck | null | undefined): string | null {
  if (check == null) return null;
  const detail = check.detail?.trim() ?? "";
  if (check.outcome === "skip") {
    return detail === ""
      ? t("The check found no work.")
      : t("The check found no work: {detail}", { detail });
  }
  if (check.outcome === "run") {
    return detail === "" ? null : t("The check found work: {detail}", { detail });
  }
  const failed =
    check.failure === "exit_code"
      ? t("The check failed with exit code {code}, so the chat started anyway.", {
          code: String(check.exitCode ?? "?"),
        })
      : check.failure === "timeout"
        ? t("The check did not answer in time, so the chat started anyway.")
        : check.failure === "not_started"
          ? t("The check could not start, so the chat started anyway.")
          : check.failure === "invalid_command"
            ? t("The check command could not be read, so the chat started anyway.")
            : check.failure === "policy"
              ? t("Your organization's policy blocked the check, so the chat started anyway.")
              : t("The check failed, so the chat started anyway.");
  return detail === "" ? failed : `${failed} ${detail}`;
}
