import { describe, expect, it } from "vite-plus/test";

import {
  matchingThreadDetailsPreset,
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_PRESETS,
  threadDetailsItemsForPreset,
  threadDetailsVisibilityFor,
} from "./threadDetailsItems";

const item = (id: string) => THREAD_DETAILS_ITEMS.find((candidate) => candidate.id === id)!;
const preset = (id: string) => THREAD_DETAILS_PRESETS.find((candidate) => candidate.id === id)!;
const shown = (visibility: Record<string, boolean>) =>
  Object.keys(visibility).filter((id) => visibility[id]);

describe("thread details items", () => {
  it("shows only the essentials to someone who never chose", () => {
    expect(shown(resolveThreadDetailsVisibility({ threadDetailsItems: {} }))).toEqual([
      "environment",
      "branch",
      "changes",
      "status",
      "context",
      "tasks",
      "lineage",
    ]);
  });

  it.each<{ items: Record<string, boolean>; on: string[]; off: string[] }>([
    // Turned on under the old defaults: stays on.
    {
      items: { gitActions: true, agentActions: true },
      on: ["gitActions", "agentActions"],
      off: [],
    },
    // Turned off under the old defaults: stays off, whether or not the new default hides it.
    { items: { status: false, usage: false }, on: [], off: ["status", "usage"] },
    // Ids from an older or newer client are ignored.
    { items: { retired: true }, on: [], off: [] },
  ])("keeps a stored choice made under the old defaults: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({ threadDetailsItems: row.items });
    const untouched = resolveThreadDetailsVisibility({ threadDetailsItems: {} });
    for (const entry of THREAD_DETAILS_ITEMS) {
      const expected = row.on.includes(entry.id)
        ? true
        : row.off.includes(entry.id)
          ? false
          : untouched[entry.id];
      expect([entry.id, visibility[entry.id]]).toEqual([entry.id, expected]);
    }
  });

  it("shows a draft only the chosen controls for where it runs", () => {
    const everything = resolveThreadDetailsVisibility({
      threadDetailsItems: Object.fromEntries(THREAD_DETAILS_ITEMS.map((entry) => [entry.id, true])),
    });

    expect(shown(threadDetailsVisibilityFor(everything, true))).toEqual(["environment", "branch"]);
    expect(shown(threadDetailsVisibilityFor({ ...everything, branch: false }, true))).toEqual([
      "environment",
    ]);
    expect(threadDetailsVisibilityFor(everything, false)).toBe(everything);
  });

  it.each([
    { current: {}, id: "status", visible: false, stored: { status: false } },
    { current: {}, id: "status", visible: true, stored: {} },
    { current: {}, id: "outline", visible: true, stored: { outline: true } },
    { current: { gitActions: true }, id: "gitActions", visible: false, stored: {} },
    { current: { servers: true }, id: "servers", visible: false, stored: {} },
  ])("stores only choices that differ from the default: %o", (row) => {
    expect(
      setThreadDetailsItem({ threadDetailsItems: row.current }, item(row.id), row.visible),
    ).toEqual(row.stored);
  });

  it.each([
    { id: "essentials", items: {} },
    {
      id: "review",
      items: {
        environment: false,
        status: false,
        context: false,
        tasks: false,
        lineage: false,
        gitActions: true,
      },
    },
  ])("stores a preset as differences from the defaults: $id", (row) => {
    expect(threadDetailsItemsForPreset(preset(row.id))).toEqual(row.items);
  });

  it.each(["essentials", "review", "debug"])("recognizes the %s preset once applied", (id) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: threadDetailsItemsForPreset(preset(id)),
    });
    expect(matchingThreadDetailsPreset(visibility)?.id).toBe(id);
    expect(
      matchingThreadDetailsPreset(resolveThreadDetailsVisibility({ threadDetailsItems: {} }))?.id,
    ).toBe("essentials");
    expect(matchingThreadDetailsPreset({ ...visibility, outline: !visibility.outline })).toBeNull();
  });
});
