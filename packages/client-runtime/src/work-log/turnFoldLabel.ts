import { t, tn } from "@t3tools/shared/i18n";

import {
  workEntryDisplayIndicatesToolFailure,
  workLogEntryIsToolLike,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

/** What a folded turn did, counted from its work entries. */
export interface TurnFoldTally {
  readonly tools: number;
  readonly files: number;
  readonly failed: number;
}

export type TurnFoldOutcome = "worked" | "continued" | "stopped";

export interface TurnFoldLabel {
  /** Duration and counts, in the fold's usual tone. */
  readonly text: string;
  /** Failed tool calls, shown apart in the alarm tone; null when none failed. */
  readonly failed: string | null;
}

interface EntryContribution {
  readonly tool: boolean;
  readonly failed: boolean;
}

// The failure check scans tool output, and folds are derived again on every
// timeline update, so each settled entry is classified once.
const contributions = new WeakMap<WorkLogPresentationEntry, EntryContribution>();

function entryContribution(entry: WorkLogPresentationEntry): EntryContribution {
  const cached = contributions.get(entry);
  if (cached) return cached;
  const tool =
    workLogEntryIsToolLike(entry) && entry.tone !== "thinking" && entry.itemType !== "reasoning";
  const contribution = {
    tool,
    // A declined approval is the user's choice, not a failure.
    failed:
      tool &&
      entry.toolLifecycleStatus !== "declined" &&
      workEntryDisplayIndicatesToolFailure(entry),
  };
  contributions.set(entry, contribution);
  return contribution;
}

export function tallyTurnFoldWork(entries: Iterable<WorkLogPresentationEntry>): TurnFoldTally {
  let tools = 0;
  let failed = 0;
  const files = new Set<string>();
  for (const entry of entries) {
    const contribution = entryContribution(entry);
    if (contribution.tool) tools += 1;
    if (contribution.failed) failed += 1;
    for (const path of entry.changedFiles ?? []) files.add(path);
  }
  return { tools, files: files.size, failed };
}

/** "Worked for 8m · 14 tools · 6 files", with "2 failed" kept apart for its own tone. */
export function turnFoldLabel(
  outcome: TurnFoldOutcome,
  duration: string | null,
  tally: TurnFoldTally,
): TurnFoldLabel {
  const lead =
    outcome === "stopped"
      ? duration
        ? t("You stopped after {duration}", { duration })
        : t("You stopped this response")
      : outcome === "continued"
        ? duration
          ? t("Continued for {duration}", { duration })
          : t("Continued")
        : duration
          ? t("Worked for {duration}", { duration })
          : t("Worked");
  const parts = [lead];
  if (tally.tools > 0) parts.push(tn(tally.tools, "{count} tool", "{count} tools"));
  if (tally.files > 0) parts.push(tn(tally.files, "{count} file", "{count} files"));
  return {
    text: parts.join(" · "),
    failed: tally.failed > 0 ? t("{count} failed", { count: tally.failed }) : null,
  };
}
