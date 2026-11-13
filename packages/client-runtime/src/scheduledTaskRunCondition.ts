import {
  DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS,
  MAX_RUN_CONDITION_COMMAND_LENGTH,
  MAX_RUN_CONDITION_TIMEOUT_SECONDS,
  MAX_SCHEDULED_TASK_MAX_LIVE_RUNS,
  type ScheduledTask,
  type ScheduledTaskNoWorkSkip,
  type ScheduledTaskRunCheck,
  type ScheduledTaskRunConditionInput,
  type ScheduledTaskRunFailover,
  type ScheduledTaskRunUsageLimit,
} from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";

import { providerDriverDisplayName } from "./state/providerInstanceDisplay.ts";

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

/** Blank means `fallback`; undefined means the input is not a whole number from 1 to `max`, which blocks saving. */
function wholeNumberInput(value: string, fallback: number, max: number): number | undefined {
  if (value.trim() === "") return fallback;
  const number = Number(value.trim());
  return Number.isInteger(number) && number >= 1 && number <= max ? number : undefined;
}

function parseRunConditionTimeout(value: string): number | undefined {
  return wholeNumberInput(
    value,
    DEFAULT_RUN_CONDITION_TIMEOUT_SECONDS,
    MAX_RUN_CONDITION_TIMEOUT_SECONDS,
  );
}

/** A task form's text for the task's live-run limit. */
export function liveRunLimitDraft(task: Pick<ScheduledTask, "maxLiveRuns"> | null): string {
  return String(task?.maxLiveRuns ?? DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS);
}

/** What a save sends for the limit; undefined means the text is not a valid limit, which blocks saving. */
export function liveRunLimitInput(value: string): number | undefined {
  return wholeNumberInput(
    value,
    DEFAULT_SCHEDULED_TASK_MAX_LIVE_RUNS,
    MAX_SCHEDULED_TASK_MAX_LIVE_RUNS,
  );
}

/** The live-run limit applies to tasks that start a new chat on a repeating schedule. */
export function offersLiveRunLimit(input: {
  readonly supported: boolean;
  readonly startsNewChat: boolean;
  readonly repeats: boolean;
}): boolean {
  return input.supported && input.startsNewChat && input.repeats;
}

export function liveRunLimitHelpText(): string {
  return t(
    "A scheduled time is skipped while this many of the task's runs are still working, including tasks they delegated.",
  );
}

export function liveRunLimitInvalidText(): string {
  return t("Enter a whole number from 1 to {max}.", { max: MAX_SCHEDULED_TASK_MAX_LIVE_RUNS });
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

/** A task row's line for a skipped occurrence; `when` is a time, such as "5m ago" or "Nov 12, 3:00 PM". */
export function noWorkSkipText(skip: ScheduledTaskNoWorkSkip, when: string): string {
  const reason = skip.reason?.trim() ?? "";
  return reason === ""
    ? t("Skipped {when}", { when })
    : t("Skipped {when}: {reason}", { when, reason });
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

/** Run history's line for an occurrence skipped because every account it needs was out of usage. */
export function usageLimitSkipText(
  usageLimit: ScheduledTaskRunUsageLimit | null | undefined,
  formatTime: (iso: string) => string,
): string {
  if (usageLimit == null) return t("Every account this task can use was out of usage.");
  return t("Every {provider} account this task can use was out of usage until {time}.", {
    provider: providerDriverDisplayName(usageLimit.driver),
    time: formatTime(usageLimit.until),
  });
}

/** Run history's line for a run that started on another account than its task named, and why. */
export function failoverText(
  failover: ScheduledTaskRunFailover,
  accountName: (instanceId: string) => string,
): string {
  const to = accountName(failover.to);
  const from = accountName(failover.from);
  switch (failover.reason) {
    case "usageLimit":
      return t("Started on {to} because {from} was out of usage.", { to, from });
    case "signedOut":
      return t("Started on {to} because {from} was signed out.", { to, from });
    case "mcpSignIn": {
      const servers = failover.mcpServers?.join(", ") ?? "";
      return servers === ""
        ? t("Started on {to} because {from} needs to sign in to an MCP server again.", {
            to,
            from,
          })
        : t("Started on {to} because {from} needs to sign in to {servers} again.", {
            to,
            from,
            servers,
          });
    }
    default:
      return t("Started on {to} instead of {from}.", { to, from });
  }
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
