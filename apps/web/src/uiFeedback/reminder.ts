import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

export const UiFeedbackReminderMode = Schema.Literals(["auto", "on", "off"]);
export type UiFeedbackReminderMode = typeof UiFeedbackReminderMode.Type;

const ReminderDocument = Schema.Struct({
  mode: UiFeedbackReminderMode,
  /** Local calendar day (YYYY-MM-DD) the reminder last showed. */
  lastShownDay: Schema.NullOr(Schema.String),
  /** When this browser profile started collecting, so "auto" waits two days before its first nudge. */
  startedAt: Schema.String,
});
export type UiFeedbackReminderState = typeof ReminderDocument.Type;

const STORAGE_KEY = "t3code:ui-feedback:reminder:v1";
export const REMINDER_HOUR = 18;
const QUIET_DAYS_BEFORE_AUTO_REMINDER = 2;
const DAY_MS = 86_400_000;

function localDayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Once a day, in the evening. "auto" nudges only after two days without a capture, so a person who
 * uses the key is left alone and one who forgot it is reminded.
 */
export function shouldShowReminder(input: {
  readonly now: Date;
  readonly state: UiFeedbackReminderState;
  readonly latestCaptureAt: string | null;
}): boolean {
  const { now, state } = input;
  if (state.mode === "off") return false;
  if (state.lastShownDay === localDayKey(now)) return false;
  if (now.getHours() < REMINDER_HOUR) return false;
  if (state.mode === "on") return true;
  const quietSince = Math.max(
    Date.parse(state.startedAt) || 0,
    input.latestCaptureAt === null ? 0 : Date.parse(input.latestCaptureAt) || 0,
  );
  return now.getTime() - quietSince >= QUIET_DAYS_BEFORE_AUTO_REMINDER * DAY_MS;
}

/** Milliseconds from `now` until the next evening check. */
export function msUntilNextReminderCheck(now: Date): number {
  const next = new Date(now);
  next.setHours(REMINDER_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function readReminderState(now = new Date()): UiFeedbackReminderState {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, ReminderDocument);
    if (stored !== null) return stored;
  } catch (cause) {
    console.warn("Could not read the UI feedback reminder setting; using the default.", cause);
  }
  const initial: UiFeedbackReminderState = {
    mode: "auto",
    lastShownDay: null,
    startedAt: now.toISOString(),
  };
  writeReminderState(initial);
  return initial;
}

export function writeReminderState(state: UiFeedbackReminderState): void {
  try {
    setLocalStorageItem(STORAGE_KEY, state, ReminderDocument);
  } catch (cause) {
    console.warn("Could not save the UI feedback reminder setting.", cause);
  }
}

/** Decides whether to show tonight's reminder and records it as shown; true at most once a day. */
export async function claimEveningReminder(
  now: Date,
  loadLatestCaptureAt: () => Promise<string | null>,
): Promise<boolean> {
  if (!shouldShowReminder({ now, state: readReminderState(now), latestCaptureAt: null })) {
    return false;
  }
  const latestCaptureAt = await loadLatestCaptureAt();
  // Read again after the wait: another check, tab or window may have shown it meanwhile.
  const state = readReminderState(now);
  if (!shouldShowReminder({ now, state, latestCaptureAt })) return false;
  writeReminderState({ ...state, lastShownDay: localDayKey(now) });
  return true;
}
