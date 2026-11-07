import { msg, type Message } from "@t3tools/shared/i18n";

import type { EnvironmentThreadShell } from "./models.ts";

/** What a thread is doing, as every client's thread list classifies it. */
export type ThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveThreadStatus(thread: ThreadStatusInput): ThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/**
 * The colour role of a status. Each client maps it to its own classes, so a status
 * keeps one meaning everywhere while each platform keeps its palette.
 */
export type ThreadStatusTone =
  | "attention"
  | "question"
  | "guest"
  | "active"
  | "muted"
  | "error"
  | "success"
  | "plan";

interface ThreadStatusDisplay {
  /** The short word rows, pills, and task lists show. */
  readonly label: Message;
  /** The sentence notifications and screen readers say, for statuses they announce. */
  readonly summary?: Message;
  readonly tone: ThreadStatusTone;
}

/** Every client names a status with these words, so a thread reads the same on each. */
export const THREAD_STATUS_DISPLAY = {
  approval: { label: msg("Approval"), summary: msg("Approval needed"), tone: "attention" },
  input: { label: msg("Question"), summary: msg("Input needed"), tone: "question" },
  request: { label: msg("Request"), summary: msg("Guest request"), tone: "guest" },
  failed: { label: msg("Failed"), summary: msg("Thread failed"), tone: "error" },
  limited: { label: msg("Limited"), summary: msg("Usage limit reached"), tone: "attention" },
  starting: { label: msg("Starting"), tone: "active" },
  working: { label: msg("Working"), summary: msg("Working"), tone: "active" },
  goal: { label: msg("Goal"), tone: "active" },
  waiting: { label: msg("Waiting"), tone: "muted" },
  paused: { label: msg("Paused"), tone: "muted" },
  plan: { label: msg("Plan ready"), tone: "plan" },
  woke: { label: msg("Woke"), tone: "attention" },
  done: { label: msg("Done"), summary: msg("Thread completed"), tone: "success" },
} as const satisfies Record<string, ThreadStatusDisplay>;

export type ThreadStatusDisplayKey = keyof typeof THREAD_STATUS_DISPLAY;
