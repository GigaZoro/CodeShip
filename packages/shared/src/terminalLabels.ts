import type { TerminalSummary } from "@t3tools/contracts";

import { t } from "./i18n.ts";

export function terminalNumber(terminalId: string): string | undefined {
  return /^term(?:inal)?-(\d+)(?:-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})?$/i.exec(
    terminalId,
  )?.[1];
}

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = terminalNumber(terminalId);
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

/** Uses labels from running commands and localizes the terminal's idle default. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary:
    | (Pick<TerminalSummary, "label"> &
        Partial<Pick<TerminalSummary, "hasRunningSubprocess" | "agentInput">>)
    | null
    | undefined,
  resolve: typeof t = t,
): string {
  const trimmed = summary?.label.trim();
  const numericSuffix = terminalNumber(terminalId);
  const isIdleDefault = !summary?.hasRunningSubprocess && trimmed === getTerminalLabel(terminalId);
  const label =
    trimmed && !isIdleDefault
      ? trimmed
      : numericSuffix
        ? resolve("Terminal {number}", { number: numericSuffix })
        : terminalId;
  return summary?.agentInput === true ? resolve("{label} · agent", { label }) : label;
}

/** Append a UUID when metadata is unavailable to avoid reusing unseen host sessions. */
export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
  uniqueSuffix?: string,
): string {
  const usedNumbers = new Set(existingTerminalIds.map(terminalNumber));
  let nextIndex = 1;
  while (usedNumbers.has(String(nextIndex))) {
    nextIndex += 1;
  }

  return `term-${nextIndex}${uniqueSuffix === undefined ? "" : `-${uniqueSuffix}`}`;
}
