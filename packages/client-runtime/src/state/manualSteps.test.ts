import type { ManualStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { combineManualSteps } from "./manualSteps.ts";

const step = (
  threadId: string,
  machine: string,
  fields: Partial<Pick<ManualStep, "kind" | "updatedAt" | "title">> = {},
): ManualStep => ({
  threadId,
  title: fields.title ?? threadId,
  step: `Do ${threadId}`,
  kind: fields.kind ?? "hands-on",
  machine,
  updatedAt: fields.updatedAt ?? "2026-11-07T20:00:00.000Z",
  url: `https://thread.page/app/threads/${threadId}`,
});

describe("combineManualSteps", () => {
  it("merges every machine's list by thread, money first, then the newest", () => {
    const view = combineManualSteps([
      {
        status: "listed",
        steps: [
          step("xcode", "Mac", { updatedAt: "2026-11-07T21:00:00.000Z" }),
          step("minions", "Mac", { updatedAt: "2026-11-07T22:00:00.000Z" }),
          step("tray", "Zoro-PC"),
        ],
      },
      // A second machine reads the same ThreadPage lists, one step updated since.
      {
        status: "listed",
        steps: [
          step("tray", "Zoro-PC", { updatedAt: "2026-11-07T23:00:00.000Z" }),
          step("contabo", "Zoro-VPS", { kind: "needs-you" }),
          step("apt", "Zoro-VPS", { updatedAt: "2026-11-07T23:30:00.000Z" }),
        ],
      },
      { status: "failed", reason: "offline" },
    ]);
    expect(view.status === "listed" ? view.count : null).toBe(5);
    expect(
      view.status === "listed"
        ? view.groups.map((group) => [group.machine, group.steps.map((entry) => entry.threadId)])
        : view,
    ).toEqual([
      ["Zoro-VPS", ["contabo", "apt"]],
      ["Mac", ["minions", "xcode"]],
      ["Zoro-PC", ["tray"]],
    ]);
    expect(view.status === "listed" ? view.groups[2]?.steps[0]?.updatedAt : null).toBe(
      "2026-11-07T23:00:00.000Z",
    );
  });

  it.each([
    [[], { status: "not-connected" }],
    [[{ status: "not-connected" }, { status: "not-connected" }], { status: "not-connected" }],
    [[{ status: "not-connected" }, { status: "loading" }], { status: "loading" }],
    [
      [
        { status: "failed", reason: "offline" },
        { status: "failed", reason: "token-rejected" },
      ],
      { status: "failed", reason: "token-rejected" },
    ],
    [
      [
        { status: "failed", reason: "offline" },
        { status: "listed", steps: [] },
      ],
      { status: "listed", groups: [], count: 0 },
    ],
  ] as const)("shows %j as %j", (sources, view) => {
    expect(combineManualSteps(sources)).toEqual(view);
  });
});
