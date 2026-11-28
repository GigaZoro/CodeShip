import type { SidebarGrouping } from "@t3tools/contracts/settings";

/**
 * Priority order for sidebar thread row markers, highest first.
 * A sidebar row displays at most one marker from this table; the rest move to
 * the row hover card in the same order. Adding a new marker requires placing
 * it here and updating the exhaustive table test in `sidebarRowMarker.test.ts`.
 */
export const ROW_MARKER_PRIORITY = [
  "needsYou",
  "failed",
  "pr",
  "machineOffline",
  "draft",
  "queued",
  "terminal",
  "scheduled",
  "pinned",
  "machine",
  "project",
  "tags",
  "color",
  "notifications",
  "provider",
] as const;

export type RowMarkerKind = (typeof ROW_MARKER_PRIORITY)[number];

/** Presence flags for every marker type a sidebar thread row can carry. */
export type RowMarkerInput = {
  readonly [K in RowMarkerKind]?: boolean | undefined;
};

export interface RowMarkerSelection {
  /** The single highest-priority marker for the row, or null when none applies. */
  readonly primary: RowMarkerKind | null;
  /** Remaining present markers in priority order, for the row hover card. */
  readonly overflow: ReadonlyArray<RowMarkerKind>;
}

/**
 * Picks at most one marker for a sidebar thread row by priority, omitting
 * badges already named by the row's enclosing machine or project folder.
 */
export function pickRowMarker(row: RowMarkerInput, grouping: SidebarGrouping): RowMarkerSelection {
  let primary: RowMarkerKind | null = null;
  const overflow: RowMarkerKind[] = [];
  for (const kind of ROW_MARKER_PRIORITY) {
    if (row[kind] !== true) continue;
    if (kind === "machine" && grouping.machine) continue;
    if (kind === "project" && grouping.project) continue;
    if (primary === null) {
      primary = kind;
    } else {
      overflow.push(kind);
    }
  }
  return { primary, overflow };
}
