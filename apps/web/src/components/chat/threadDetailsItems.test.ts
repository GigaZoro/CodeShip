import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
  threadDetailsVisibilityFor,
} from "./threadDetailsItems";

const item = (id: string) => THREAD_DETAILS_ITEMS.find((candidate) => candidate.id === id)!;

describe("thread details items", () => {
  it.each([
    { items: {}, status: true, usage: true, context: true, gitActions: false, agentActions: false },
    {
      items: { usage: false, gitActions: true },
      status: true,
      usage: false,
      context: true,
      gitActions: true,
      agentActions: false,
    },
    {
      items: { agentActions: true, retired: false },
      status: true,
      usage: true,
      context: true,
      gitActions: false,
      agentActions: true,
    },
  ])("resolves defaults and overrides: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({ threadDetailsItems: row.items });
    expect(visibility.status).toBe(row.status);
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.gitActions).toBe(row.gitActions);
    expect(visibility.agentActions).toBe(row.agentActions);
    expect(visibility.machineLoad).toBe(true);
  });

  it("shows a draft only the chosen controls for where it runs", () => {
    const everything = resolveThreadDetailsVisibility({
      threadDetailsItems: Object.fromEntries(THREAD_DETAILS_ITEMS.map((entry) => [entry.id, true])),
    });
    const shown = (visibility: Record<string, boolean>) =>
      Object.keys(visibility).filter((id) => visibility[id]);

    expect(shown(threadDetailsVisibilityFor(everything, true))).toEqual(["environment", "branch"]);
    expect(shown(threadDetailsVisibilityFor({ ...everything, branch: false }, true))).toEqual([
      "environment",
    ]);
    expect(threadDetailsVisibilityFor(everything, false)).toBe(everything);
  });

  it.each([
    { current: {}, id: "usage", visible: false, stored: { usage: false } },
    { current: {}, id: "usage", visible: true, stored: {} },
    { current: {}, id: "gitActions", visible: true, stored: { gitActions: true } },
    { current: { gitActions: true }, id: "gitActions", visible: false, stored: {} },
    { current: { servers: false }, id: "servers", visible: true, stored: {} },
  ])("stores only choices that differ from the default: %o", (row) => {
    expect(
      setThreadDetailsItem({ threadDetailsItems: row.current }, item(row.id), row.visible),
    ).toEqual(row.stored);
  });
});
