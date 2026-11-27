import type { UiCapture } from "./captureStore";
import type { UsageCounters } from "./usageCounters";
import { USAGE_AREAS, type UsageArea } from "./usageTarget";

const AREA_TITLES: Readonly<Record<UsageArea, string>> = {
  nav: "Nav rail",
  details: "Thread details",
  composer: "Composer",
};

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function list(values: ReadonlyArray<string>): string {
  return values.length > 0 ? values.join("; ") : "none";
}

function captureSection(capture: UiCapture): string {
  const lines = [
    `### ${capture.createdAt}${capture.note ? `: ${capture.note.replaceAll("\n", " ")}` : ""}`,
    "",
    `- Route: ${code(capture.route)}`,
    `- Under the pointer: ${capture.componentIds.length > 0 ? capture.componentIds.map(code).join(" < ") : "nothing marked"}`,
    `- Notices: ${list(capture.notices)}`,
    `- Panels: ${list(capture.panels)}`,
    `- Viewport: ${capture.viewport.width}×${capture.viewport.height}, theme ${capture.theme}, density ${capture.density}`,
    `- Screenshot: ${capture.hasScreenshot ? "yes (kept in the app, Settings > Diagnostics > UI feedback)" : "no"}`,
  ];
  return lines.join("\n");
}

function countersSection(counters: UsageCounters): string {
  const lines = [`## Usage counters (since ${counters.since})`, ""];
  const entries = Object.entries(counters.counts);
  if (entries.length === 0) return [...lines, "No clicks counted yet."].join("\n");
  for (const prefix of USAGE_AREAS) {
    const title = AREA_TITLES[prefix];
    const rows = entries
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .toSorted(
        ([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey),
      );
    if (rows.length === 0) continue;
    lines.push(`### ${title}`, "", "| Control | Clicks |", "| --- | ---: |");
    for (const [key, count] of rows) {
      lines.push(`| ${escapeCell(key.slice(prefix.length + 1))} | ${count} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function uiFeedbackMarkdown(input: {
  readonly captures: ReadonlyArray<UiCapture>;
  readonly counters: UsageCounters;
  readonly exportedAt: string;
}): string {
  const captures = input.captures.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return [
    "# CodeShip UI feedback",
    "",
    `Exported ${input.exportedAt}. ${captures.length} capture${captures.length === 1 ? "" : "s"}.`,
    "Controls that never got a click are missing from the counters; compare with the nav rail, thread details and composer.",
    "",
    "## Captures",
    "",
    captures.length > 0 ? captures.map(captureSection).join("\n\n") : "No captures yet.",
    "",
    countersSection(input.counters),
    "",
  ].join("\n");
}
