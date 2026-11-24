import type { ThreadNotificationLevel } from "@t3tools/contracts";
import { shouldNotifyThread } from "@t3tools/shared/threadNotifications";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

function isFreshTerminalNotification(occurredAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(occurredAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

export function rowPhasesChanged(
  previousAggregate: RelayAgentActivityAggregateState,
  nextAggregate: RelayAgentActivityAggregateState,
): boolean {
  if (previousAggregate.activities.length !== nextAggregate.activities.length) return true;
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.some((row) => previousPhases.get(rowKey(row)) !== row.phase);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

function globalAllowsPhase(preferences: RelayAgentAwarenessPreferences, phase: string): boolean {
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  row: { readonly phase: string; readonly notificationLevel?: ThreadNotificationLevel },
): boolean {
  if (preferences?.notificationsEnabled !== true) return false;
  const kind =
    row.phase === "completed"
      ? "completion"
      : isAttentionPhase(row.phase) || row.phase === "failed"
        ? "input"
        : "other";
  return shouldNotifyThread(globalAllowsPhase(preferences, row.phase), row.notificationLevel, kind);
}

function isTerminalPhase(phase: string): boolean {
  return phase === "completed" || phase === "failed";
}

function phaseClass(phase: string): "attention" | "terminal" | null {
  return isAttentionPhase(phase) ? "attention" : isTerminalPhase(phase) ? "terminal" : null;
}

/**
 * Whether a publish starts a new alertable occurrence, given the row it replaced. A stored
 * alert that was never queued still counts. Without occurrence times on both sides only a
 * change of phase class counts, and a terminal state with no stored row is a replay.
 */
export function isAlertTrigger(
  previous: {
    readonly phase: string;
    readonly occurredAt: string | null;
    readonly alertUnsent?: boolean;
  } | null,
  next: { readonly phase: string; readonly occurredAt?: string | undefined },
): boolean {
  const nextClass = phaseClass(next.phase);
  if (nextClass === null) return false;
  if (previous === null) return nextClass === "attention" || next.occurredAt !== undefined;
  if (previous.alertUnsent === true) return true;
  if (next.occurredAt !== undefined && previous.occurredAt !== null) {
    return previous.phase !== next.phase || previous.occurredAt !== next.occurredAt;
  }
  return phaseClass(previous.phase) !== nextClass;
}

/** Whether a re-read state is still the occurrence a job was queued for. */
export function isSameOccurrence(
  current: {
    readonly phase: string;
    readonly occurredAt?: string | undefined;
    readonly updatedAt: string;
  },
  queued: {
    readonly phase?: string | undefined;
    readonly occurredAt?: string | undefined;
    readonly updatedAt?: string | undefined;
  },
): boolean {
  if (queued.phase !== undefined && current.phase !== queued.phase) return false;
  if (queued.occurredAt !== undefined) return current.occurredAt === queued.occurredAt;
  return queued.updatedAt === undefined || current.updatedAt === queued.updatedAt;
}

/** The time an alert is about: its occurrence, or the publish time from older servers. */
export function alertOccurrence(state: {
  readonly occurredAt?: string | undefined;
  readonly updatedAt: string;
}): string {
  return state.occurredAt ?? state.updatedAt;
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly notificationLevel?: ThreadNotificationLevel;
  readonly occurredAt?: string | undefined;
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    alertAllowedForPhase(input.preferences, input) &&
    (!isTerminalPhase(input.phase) ||
      isFreshTerminalNotification(alertOccurrence(input), input.nowMs))
  );
}
