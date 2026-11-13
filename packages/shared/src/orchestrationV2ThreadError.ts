import {
  ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ErrorTurnItem = Extract<OrchestrationV2TurnItem, { type: "error" }>;
/** Only error items are read, so callers may pass items stripped of other fields. */
type FailureScanTurnItem =
  | ErrorTurnItem
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "error"> };

export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: ErrorTurnItem | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

/** The run failed before its agent received the message, so the run goes again instead. */
export function isUndeliveredFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "code"> | null,
): boolean {
  return (
    failure?.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE ||
    failure?.code === ORCHESTRATION_V2_PROMPT_NOT_SENT_FAILURE_CODE
  );
}

/** Whether a failed run's turn can be continued: it hit a usage limit or lost its connection. */
export function isContinuableFailure(failure: OrchestrationV2ProviderFailure | null): boolean {
  return (
    (failure?.class === "usage_limit" || failure?.class === "transport_error") &&
    !isUndeliveredFailure(failure)
  );
}

/**
 * Whether a Stop or the person's choice turned off auto-resume for this run's usage-limit stop,
 * which keeps the thread until they continue it. An arm that left it off by default declines nothing.
 */
export function limitRecoveryDeclined(
  recovery: OrchestrationV2LimitRecovery | null | undefined,
  runId: string,
): boolean {
  return recovery?.runId === runId && !recovery.autoResume && recovery.autoResumeUnset !== true;
}

/**
 * Whether the person's snooze keeps this run's stop waiting, so nothing moves it to another
 * account or spends a reset credit on it until it wakes. Hiding limit stops until their reset
 * is a setting, not such a choice: continuing the thread sooner wakes it.
 */
export function snoozeHoldsStop(
  thread: {
    readonly snoozedUntil?: DateTime.Utc | null | undefined;
    readonly limitRecovery?: OrchestrationV2LimitRecovery | null | undefined;
  },
  runId: string,
  nowMs: number,
): boolean {
  if (thread.snoozedUntil == null) return false;
  const until = DateTime.toEpochMillis(thread.snoozedUntil);
  const recovery = thread.limitRecovery;
  return (
    until > nowMs &&
    !(
      recovery?.runId === runId &&
      recovery.snoozeBySettings === true &&
      recovery.snooze === true &&
      until === Date.parse(recovery.resetAt)
    )
  );
}

export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass: currentFailure?.class ?? null,
    lastErrorCode: currentFailure?.code ?? null,
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/** Held queues can execute out of ordinal order; unfinished runs count as latest. */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/** Retains a limited run's outcome when higher-ordinal runs never started. */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<FailureScanTurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}
