import { describe, expect, it } from "vite-plus/test";
import type { SidebarGrouping } from "@t3tools/contracts/settings";

import {
  pickRowMarker,
  ROW_MARKER_PRIORITY,
  type RowMarkerInput,
  type RowMarkerKind,
} from "./sidebarRowMarker.ts";

const UNGROUPED: SidebarGrouping = { machine: false, project: false };

/**
 * Exhaustive marker table keyed by `RowMarkerKind`. Adding a marker to
 * `ROW_MARKER_PRIORITY` requires adding it here (enforced by `satisfies`) and
 * placing it in the expected order below so every new marker gets a deliberate
 * priority and grouping decision.
 */
const EXPECTED_MARKERS = {
  needsYou: { suppressedBy: null },
  failed: { suppressedBy: null },
  pr: { suppressedBy: null },
  machineOffline: { suppressedBy: null },
  draft: { suppressedBy: null },
  queued: { suppressedBy: null },
  terminal: { suppressedBy: null },
  scheduled: { suppressedBy: null },
  pinned: { suppressedBy: null },
  machine: { suppressedBy: "machine" },
  project: { suppressedBy: "project" },
  tags: { suppressedBy: null },
  color: { suppressedBy: null },
  notifications: { suppressedBy: null },
  provider: { suppressedBy: null },
} as const satisfies Record<RowMarkerKind, { readonly suppressedBy: "machine" | "project" | null }>;

const ALL_PRESENT = Object.fromEntries(
  ROW_MARKER_PRIORITY.map((kind) => [kind, true] as const),
) as Record<RowMarkerKind, true>;

describe("pickRowMarker", () => {
  it("lists every marker type in its declared priority order without duplicates", () => {
    expect(ROW_MARKER_PRIORITY).toEqual(Object.keys(EXPECTED_MARKERS));
    expect(new Set(ROW_MARKER_PRIORITY).size).toBe(ROW_MARKER_PRIORITY.length);
  });

  it("returns no primary marker and empty overflow when nothing is present", () => {
    expect(pickRowMarker({}, UNGROUPED)).toEqual({ primary: null, overflow: [] });
  });

  it.each(ROW_MARKER_PRIORITY)("picks %s when it is the only marker present", (kind) => {
    expect(pickRowMarker({ [kind]: true }, UNGROUPED)).toEqual({
      primary: kind,
      overflow: [],
    });
  });

  it.each(
    ROW_MARKER_PRIORITY.slice(0, -1).map(
      (higher, index) => [higher, ROW_MARKER_PRIORITY[index + 1]!] as const,
    ),
  )("ranks %s ahead of %s and moves the lower marker to overflow", (higher, lower) => {
    expect(pickRowMarker({ [higher]: true, [lower]: true }, UNGROUPED)).toEqual({
      primary: higher,
      overflow: [lower],
    });
  });

  it("picks the single highest marker and preserves priority order in overflow when all are present", () => {
    expect(pickRowMarker(ALL_PRESENT, UNGROUPED)).toEqual({
      primary: "needsYou",
      overflow: ROW_MARKER_PRIORITY.slice(1),
    });
  });

  it("suppresses the machine badge when grouped by machine", () => {
    const groupedByMachine: SidebarGrouping = { machine: true, project: false };
    expect(pickRowMarker({ machine: true }, groupedByMachine)).toEqual({
      primary: null,
      overflow: [],
    });
    expect(pickRowMarker({ machine: true, project: true }, groupedByMachine)).toEqual({
      primary: "project",
      overflow: [],
    });
    const allResult = pickRowMarker(ALL_PRESENT, groupedByMachine);
    expect(allResult.primary).toBe("needsYou");
    expect(allResult.overflow).not.toContain("machine");
    expect(allResult.overflow).toContain("machineOffline");
    expect(allResult.overflow).toContain("project");
  });

  it("suppresses the project badge when grouped by project", () => {
    const groupedByProject: SidebarGrouping = { machine: false, project: true };
    expect(pickRowMarker({ project: true }, groupedByProject)).toEqual({
      primary: null,
      overflow: [],
    });
    expect(pickRowMarker({ project: true, tags: true }, groupedByProject)).toEqual({
      primary: "tags",
      overflow: [],
    });
    const allResult = pickRowMarker(ALL_PRESENT, groupedByProject);
    expect(allResult.primary).toBe("needsYou");
    expect(allResult.overflow).not.toContain("project");
    expect(allResult.overflow).toContain("machine");
  });

  it("suppresses both machine and project badges when grouped by both", () => {
    const groupedByBoth: SidebarGrouping = { machine: true, project: true };
    expect(pickRowMarker({ machine: true, project: true }, groupedByBoth)).toEqual({
      primary: null,
      overflow: [],
    });
    const input: RowMarkerInput = {
      pr: true,
      machineOffline: true,
      machine: true,
      project: true,
      pinned: true,
    };
    expect(pickRowMarker(input, groupedByBoth)).toEqual({
      primary: "pr",
      overflow: ["machineOffline", "pinned"],
    });
  });

  it.each(
    (
      Object.entries(EXPECTED_MARKERS) as Array<
        [RowMarkerKind, { suppressedBy: "machine" | "project" | null }]
      >
    ).map(([kind, meta]) => [kind, meta.suppressedBy] as const),
  )("applies grouping suppression rule for %s (%s)", (kind, suppressedBy) => {
    const groupedByBoth: SidebarGrouping = { machine: true, project: true };
    const result = pickRowMarker({ [kind]: true }, groupedByBoth);
    if (suppressedBy === null) {
      expect(result).toEqual({ primary: kind, overflow: [] });
    } else {
      expect(result).toEqual({ primary: null, overflow: [] });
    }
  });
});
