import type { ThreadId } from "@t3tools/contracts";
import { msg, t } from "~/i18n";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

export interface TerminalContextReferenceSource {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}

export function formatTerminalContextReference(context: TerminalContextReferenceSource): string {
  return formatComposerContextReference({
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  });
}

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

function formatTerminalContextRange(selection: { lineStart: number; lineEnd: number }): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

export function terminalContextDisplayLabel(
  {
    terminalLabel,
    lineStart,
    lineEnd,
  }: Pick<TerminalContextSelection, "terminalLabel" | "lineStart" | "lineEnd">,
  resolve: typeof t = t,
): string {
  return lineStart === lineEnd
    ? resolve(msg("{terminalLabel} line {lineStart}"), { terminalLabel, lineStart })
    : resolve(msg("{terminalLabel} lines {lineStart}-{lineEnd}"), {
        terminalLabel,
        lineStart,
        lineEnd,
      });
}

export function terminalContextDisplayLabels(
  contexts: ReadonlyArray<TerminalContextReferenceSource>,
  resolve: typeof t = t,
): ReadonlyMap<string, string> {
  return new Map(
    contexts.map((context) => [
      toKindScopedComposerContextId("terminal", context.id),
      terminalContextDisplayLabel(context, resolve),
    ]),
  );
}

export function migrateLegacyTerminalContextPlaceholders(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextReferenceSource>,
): string {
  if (!prompt.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER)) return prompt;
  let index = 0;
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, () => {
    const context = contexts[index];
    index += 1;
    return context ? formatTerminalContextReference(context) : "";
  });
}
