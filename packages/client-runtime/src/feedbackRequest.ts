import { tn } from "@t3tools/shared/i18n";
import { msg, t, type Message } from "@t3tools/shared/i18n";

import type { AgentFeedbackPreview, OrchestrationV2TurnItem } from "@t3tools/contracts";

export type FeedbackRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "feedback_request" }
>;

export type FeedbackRequestDisplay =
  | { readonly kind: "pending" }
  /** Inherited by a fork: only the thread that asked can answer it. */
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | { readonly kind: "answered"; readonly outcome: "sent" | "not-sent"; readonly label: string };

export function feedbackRequestDisplay(
  item: Pick<FeedbackRequestItem, "feedbackStatus">,
  visibility: "local" | "inherited" | "synthetic",
  resolve: typeof t = t,
): FeedbackRequestDisplay {
  switch (item.feedbackStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: resolve(msg("Waiting in the original thread")) };
    case "sent":
      return { kind: "answered", outcome: "sent", label: resolve(msg("Sent")) };
    case "declined":
      return { kind: "answered", outcome: "not-sent", label: resolve(msg("Not sent")) };
    case "cancelled":
      return {
        kind: "answered",
        outcome: "not-sent",
        label: resolve(msg("Closed without sending")),
      };
  }
}

/** Exactly what Send sends: the outline, or with the conversation included, its text too. */
export function feedbackCardPreview(
  item: Pick<FeedbackRequestItem, "preview" | "conversationTrace">,
  includeConversation: boolean,
): AgentFeedbackPreview {
  return includeConversation && item.conversationTrace !== undefined
    ? { ...item.preview, trace: item.conversationTrace }
    : item.preview;
}

const KIND_LABELS: Record<AgentFeedbackPreview["kind"], Message> = {
  bug: msg("Bug"),
  confusing: msg("Confusing"),
  missing_capability: msg("Missing capability"),
  wrong_docs: msg("Wrong docs"),
  other: msg("Other"),
};

/** The report's fields in reading order, the empty workaround left out. */
export function feedbackPreviewFields(
  preview: AgentFeedbackPreview,
  resolve: typeof t = t,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: resolve(msg("Kind")), value: resolve(KIND_LABELS[preview.kind]) },
    { label: resolve(msg("About")), value: preview.subject },
    { label: resolve(msg("Expected")), value: preview.expected },
    { label: resolve(msg("Happened")), value: preview.actual },
    { label: resolve(msg("Did instead")), value: preview.workaround },
  ].filter((field) => field.value !== "");
}

const seconds = (ms: number) => `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/** One line per outline entry, plus the message text that goes with it. */
export function feedbackTraceLines(
  trace: NonNullable<AgentFeedbackPreview["trace"]>,
  resolve: typeof t = t,
): ReadonlyArray<{ readonly key: string; readonly line: string; readonly text?: string }> {
  return trace.entries.map((entry, index) => {
    const what =
      entry.type === "tool"
        ? [
            entry.tool ?? "tool",
            entry.outcome,
            entry.durationMs === undefined ? undefined : seconds(entry.durationMs),
          ]
            .filter((part) => part !== undefined)
            .join(" · ")
        : tn(entry.length ?? 0, "{speaker} · {count} character", "{speaker} · {count} characters", {
            speaker: resolve(entry.type === "user" ? msg("You") : msg("Agent")),
          });
    return {
      key: `${index}`,
      line: resolve(msg("Turn {turn} · {what}"), { turn: entry.turn, what }),
      ...(entry.text === undefined ? {} : { text: entry.text }),
    };
  });
}

type Trace = NonNullable<AgentFeedbackPreview["trace"]>;

// Counted back to the oldest turn with text, so a newer turn without any is still inside it.
const textSpan = (trace: Trace) => {
  const withText = trace.entries.filter((entry) => entry.text !== undefined);
  return withText.length === 0
    ? 0
    : trace.turns - Math.min(...withText.map((entry) => entry.turn)) + 1;
};

/** What the outline holds, in one line. */
export function feedbackTraceSummary(trace: Trace, resolve: typeof t = t): string {
  const turns = tn(trace.turns, "{count} recent turn", "{count} recent turns");
  const span = textSpan(trace);
  const text =
    span === 0
      ? resolve(msg("no message text"))
      : tn(span, "message text of the last turn", "message text of the last {count} turns");
  return trace.truncated
    ? resolve(msg("Outline of {turns}, {text}, shortened to fit"), { turns, text })
    : resolve(msg("Outline of {turns}, {text}"), { turns, text });
}

/** What the conversation switch adds: the text of the turns the agent said the problem spans. */
export function feedbackConversationHint(trace: Trace): string {
  return tn(
    textSpan(trace),
    "Adds the text of your messages and the agent's replies in the last turn.",
    "Adds the text of your messages and the agent's replies in the last {count} turns.",
  );
}

/** The server's own message for a failed answer, else a generic one. */
export function feedbackRequestFailureMessage(failure: unknown, resolve: typeof t = t): string {
  return typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "AgentFeedbackRequestError" &&
    "message" in failure &&
    typeof failure.message === "string"
    ? failure.message
    : resolve(msg("Could not send your answer. Try again."));
}
