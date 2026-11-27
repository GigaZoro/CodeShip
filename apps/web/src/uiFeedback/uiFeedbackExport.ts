import { loadUiCaptures } from "./captureStore";
import { uiFeedbackMarkdown } from "./exportMarkdown";
import { syncUsageCounters } from "./usageCounters";

export function hasDesktopUiFeedbackBridge(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.uiFeedback !== undefined;
}

export async function buildUiFeedbackMarkdown(now = new Date()): Promise<string> {
  return uiFeedbackMarkdown({
    captures: await loadUiCaptures(),
    counters: syncUsageCounters(),
    exportedAt: now.toISOString(),
  });
}

/**
 * Desktop keeps a copy in the T3 home for the weekly triage task, which cannot read browser storage.
 * Returns the file's path, or null on the web.
 */
export async function writeDesktopUiFeedbackExport(markdown?: string): Promise<string | null> {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.uiFeedback;
  if (bridge === undefined) return null;
  return bridge.writeExport(markdown ?? (await buildUiFeedbackMarkdown()));
}

/** Best effort: the file only feeds the weekly triage, so a failure is logged and skipped. */
export function refreshDesktopUiFeedbackExport(): void {
  writeDesktopUiFeedbackExport().catch((cause: unknown) => {
    console.warn("Could not write the UI feedback export file.", cause);
  });
}

export function uiFeedbackExportFilename(now = new Date()): string {
  return `codeship-ui-feedback-${now.toISOString().slice(0, 10)}.md`;
}
